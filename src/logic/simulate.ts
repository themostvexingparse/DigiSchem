/**
 * A four-valued logic simulator over the stripped circuit (see circuit.ts).
 *
 * Every bit node holds 0, 1, X (unknown) or Z (nothing drives it). Each part drives its output
 * bits strongly (gates, constants, inputs), conditionally (tri-state outputs, which drive Z when
 * disabled) or weakly (pull-up and pull-down resistors), and a node resolves as:
 *
 *  - strong drivers that agree give their value; strong drivers that disagree give X and a
 *    CONTENTION report (a short between outputs);
 *  - with no strong driver, a pull resistor sets the value;
 *  - with no driver at all the node is Z, and an input that reads it is FLOATING (it reads X).
 *
 * Settling runs in waves: in each wave every part whose inputs changed is evaluated against the
 * node values of the previous wave, then all their outputs are applied together. One wave is one
 * gate delay, so flip-flops on the same clock all sample their inputs before any of them
 * changes, as in hardware. A circuit that has not settled after many waves is OSCILLATING (a
 * ring of inverters, or a latch released from S = R = 1); the nodes still changing are set to X.
 *
 * Flip-flops, latches, registers and counters keep state between settles. It starts as X (or 0,
 * with `initial: "zero"`): a design without a reset reads X until something sets it.
 */
import type { Circuit, CircuitPart, CircuitPin } from "./circuit";
import { MODELS, type Drive, type Model, type PartIO } from "./models";
import { stronglyConnected } from "./graph";

export const B0 = 0, B1 = 1, BX = 2, BZ = 3;
export type Bit = 0 | 1 | 2 | 3;

export function bitChar(b: Bit): string {
  return "01XZ"[b];
}

/** Bits (LSB first) as a number, or null when any bit is X or Z. */
export function bitsToNumber(bits: readonly Bit[]): number | null {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) {
    if (bits[i] > 1) return null;
    v = v * 2 + bits[i];
  }
  return v;
}

export function numberToBits(v: number | bigint, width: number): Bit[] {
  let x = BigInt.asUintN(width, BigInt(v));
  const out: Bit[] = [];
  for (let i = 0; i < width; i++) {
    out.push(Number(x & 1n) as Bit);
    x >>= 1n;
  }
  return out;
}

export type Strength = "strong" | "tristate" | "weak";

export interface SimIssue {
  kind: "contention" | "floating" | "oscillation" | "unmodelled";
  /** the bit nodes involved */
  nodes: number[];
  /** the pins involved, as `part name.pin` */
  pins: string[];
  message: string;
}

export interface SettleResult {
  /** waves it took to settle (one wave is one gate delay) */
  waves: number;
  stable: boolean;
  issues: SimIssue[];
}

export interface SimOptions {
  /** starting state of flip-flops, latches and registers (default X) */
  initial?: "x" | "zero";
  /** waves before the circuit counts as oscillating (default 200 + 4 per part) */
  maxWaves?: number;
}

interface DriverRef {
  part: number;
  pin: number;
  bit: number;
  strength: Strength;
  /** a supply or an input: a switch that may or may not conduct cannot change its net */
  supply: boolean;
}

/** Parts whose outputs are ideal sources for switch-level purposes (rails, constants, inputs). */
export const SUPPLIES = new Set(["vcc", "ground", "constant", "input-pin", "clock", "push-button", "dip-switch", "keypad"]);

/** Part types whose outputs are switched off (Z) rather than driven when disabled. */
const TRISTATE = new Set(["tristate", "bus-transceiver"]);
const WEAK = new Set(["pull-up", "pull-down"]);
/** Parts set from outside (by `set`), with the pins they drive. */
export const STIMULI = new Set(["input-pin", "clock", "push-button", "dip-switch", "keypad"]);
/** Parts that remember something: a loop through one of these is not a combinational loop. */
export const STATEFUL = new Set([
  "sr-latch", "d-latch", "gated-sr-latch", "d-ff", "jk-ff", "t-ff", "sr-ff",
  "register", "shift-register", "counter", "register-file", "ring-counter", "lfsr",
  "clock-divider", "synchronizer", "edge-detector", "decade-counter", "debouncer",
  "ram", "fifo", "dual-port-ram", "stack",
]);

/**
 * Switches: while a transistor conducts, the nets on its two channel pins are one net (values
 * pass both ways). Each entry is a channel and the pin that controls it; the control pin's
 * polarity (the bubble on a pMOS gate, on EN') says when it conducts. A transmission gate is two
 * channels in parallel, one per enable.
 */
export const SWITCHES: Record<string, { ends: [string, string]; gate: string }[]> = {
  nmos: [{ ends: ["d", "s"], gate: "g" }],
  pmos: [{ ends: ["s", "d"], gate: "g" }],
  "transmission-gate": [
    { ends: ["a", "b"], gate: "en" },
    { ends: ["a", "b"], gate: "enb" },
  ],
};

interface Switch {
  part: number;
  gate: number;
  inverted: boolean;
  a: number;
  b: number;
  on: Bit;
}

/** Up to how many unknown input bits a part without state is evaluated exactly (2^n tries). */
const EXACT_UNKNOWNS = 4;

/** Parts that only join bits (their slices are already one node with the bus): no behaviour. */
export const PASSIVE = new Set(["splitter"]);

export class Simulator {
  readonly circuit: Circuit;
  private values: Bit[];
  /** current output of every part pin (by part, pin) */
  private drives: Bit[][][];
  private drivers: DriverRef[][];
  private readers: number[][];
  private models: (Model | null)[];
  private state: Record<string, unknown>[];
  private stimulus: Bit[][][];
  private forcedX = new Set<number>();
  /** a node held at 0 while probing a loop (see probeLoop), or -1 */
  private probeHold = -1;
  /** while one wave's values are being resolved: what each unknown-switch component can bring */
  private compCache: Map<number, { strong: Set<Bit>; weak: Set<Bit> }> | null = null;
  private switches: Switch[] = [];
  private switchesOf = new Map<number, Switch[]>();
  /** group root of every node (nodes joined by conducting switches), and the members of each larger group */
  private root: Int32Array;
  private members = new Map<number, number[]>();
  /** switches whose conduction is unknown, by the nodes they touch */
  private unsure = new Map<number, Switch[]>();
  /** nodes a supply or an input drives: ideal sources, never merged into a group of joined nets */
  private supplyNode: Uint8Array;
  /** the switches on each node */
  private swAt: Switch[][];
  /** combinational parts waiting to be evaluated, by rank (see `ranks`) */
  private buckets: Set<number>[] = [];
  /** ranks with pending parts, as a min-heap (and whether each rank is in it) */
  private heap: number[] = [];
  private queued: Uint8Array = new Uint8Array(0);
  /** waves a feedback loop may take before it counts as oscillating, by rank */
  private loopCap: number[] = [];
  private readonly maxWavesOpt?: number;
  /** nodes with readers and nothing driving them (value Z): the floating candidates */
  private zSet = new Set<number>();
  private byId = new Map<string, number>();
  /** pin index by id, per part (built on first evaluation) */
  private pinIndex: Map<string, number>[] = [];
  private byName = new Map<string, number>();
  /** for diagnostics: the pins on each node, and the parts not simulated */
  private pinsAt?: string[][];
  private unmodelledParts?: number[];
  /** rank of each part (its loop's position in signal order), or -1 for a part with state */
  private rank: Int32Array;
  /** whether a rank is a feedback loop (evaluated in waves) rather than a single part */
  private loop: boolean[] = [];
  /** the parts of each feedback loop, by rank */
  private loopParts: number[][] = [];
  /** parts with state waiting to be evaluated (all together, after the logic before them settles) */
  private seqPending = new Set<number>();
  /** for diagnostics: the net of each node, and the nodes with more than one driver */
  private nodeNet?: Map<number, number>;
  private multi?: number[];
  private readonly maxWaves: number;
  readonly initial: "x" | "zero";

  constructor(circuit: Circuit, opts: SimOptions = {}) {
    this.circuit = circuit;
    this.initial = opts.initial ?? "x";
    this.maxWaves = opts.maxWaves ?? 200 + 4 * circuit.parts.length;
    this.maxWavesOpt = opts.maxWaves;
    circuit.parts.forEach((p, i) => {
      this.byId.set(p.id, i);
      if (!this.byName.has(p.name)) this.byName.set(p.name, i);
    });
    const n = circuit.nodes;
    this.values = new Array<Bit>(n).fill(BZ);
    this.drivers = Array.from({ length: n }, () => []);
    this.readers = Array.from({ length: n }, () => []);
    this.models = circuit.parts.map((p) => MODELS[p.type] ?? null);
    this.state = circuit.parts.map(() => ({}));
    this.drives = circuit.parts.map((p) => p.pins.map((pin) => new Array<Bit>(pin.width).fill(BZ)));
    // inputs start at 0, and push buttons unpressed (1 for an active-low one)
    this.stimulus = circuit.parts.map((p) => p.pins.map((pin) => new Array<Bit>(pin.width).fill(p.type === "push-button" && p.props.activeLow ? B1 : B0)));
    this.root = new Int32Array(n).map((_, i) => i);
    circuit.parts.forEach((p, pi) => {
      const sw = SWITCHES[p.type];
      if (!sw) return;
      const list: Switch[] = [];
      for (const c of sw) {
        const a = p.pins.find((x) => x.id === c.ends[0]), b = p.pins.find((x) => x.id === c.ends[1]);
        const g = p.pins.findIndex((x) => x.id === c.gate);
        if (!a || !b || g < 0) continue;
        for (let i = 0; i < Math.min(a.bits.length, b.bits.length); i++)
          list.push({ part: pi, gate: g, inverted: p.pins[g].inverted, a: a.bits[i], b: b.bits[i], on: BX });
      }
      this.switchesOf.set(pi, list);
      this.switches.push(...list);
    });
    circuit.parts.forEach((p, pi) =>
      p.pins.forEach((pin, k) => {
        if (PASSIVE.has(p.type)) return;
        // a switch's channel pins neither drive nor read: they join nets (see SWITCHES)
        if (SWITCHES[p.type] && pin.dir === "inout") return;
        const strength: Strength = TRISTATE.has(p.type) ? "tristate" : WEAK.has(p.type) ? "weak" : "strong";
        const drives = pin.dir === "out" || pin.dir === "inout";
        // (a ground's pin is bidirectional, but a ground only drives)
        const reads = (pin.dir === "in" || pin.dir === "inout") && p.type !== "ground";
        pin.bits.forEach((node, b) => {
          if (drives) this.drivers[node].push({ part: pi, pin: k, bit: b, strength, supply: SUPPLIES.has(p.type) });
          const rl = this.readers[node];
          if (reads && rl[rl.length - 1] !== pi) rl.push(pi);
        });
      }),
    );
    for (let node = 0; node < n; node++) if (this.readers[node].length) this.zSet.add(node);
    this.supplyNode = new Uint8Array(n);
    for (let node = 0; node < n; node++) if (this.drivers[node].some((d) => d.supply)) this.supplyNode[node] = 1;
    this.swAt = Array.from({ length: n }, () => []);
    for (const sw of this.switches) {
      this.swAt[sw.a].push(sw);
      if (sw.b !== sw.a) this.swAt[sw.b].push(sw);
    }
    if (this.switches.length) this.regroup();
    this.rank = new Int32Array(circuit.parts.length);
    this.ranks();
    for (let i = 0; i < circuit.parts.length; i++) this.enqueue(i);
  }

  /**
   * Order the parts without state the way signals flow: each feedback loop (strongly connected
   * parts) and each other part gets a rank, and a part only feeds parts of a higher rank or its
   * own loop. Nets joined by transistors count as one net here, whatever the transistors do.
   */
  private ranks(): void {
    const parts = this.circuit.parts;
    const n = this.circuit.nodes;
    const ccc = new Int32Array(n).map((_, i) => i);
    const find = (x: number): number => {
      while (ccc[x] !== x) x = ccc[x] = ccc[ccc[x]];
      return x;
    };
    for (const sw of this.switches) {
      if (this.supplyNode[sw.a] || this.supplyNode[sw.b]) continue; // a rail does not join what hangs off it
      const a = find(sw.a), b = find(sw.b);
      if (a !== b) ccc[a] = b;
    }
    const seq = parts.map((p) => STATEFUL.has(p.type));
    // The graph has a vertex per part and one per cluster of nets (nets that transistors can join):
    // a part feeds the clusters it drives, a cluster feeds the parts that read it and the
    // transistors on it. (Edges through a cluster vertex keep a bus with many drivers and readers,
    // or a long chain of transistors, linear in size.)
    const P = parts.length;
    const clusterId = new Map<number, number>();
    const vertex = (node: number) => {
      const r = find(node);
      let v = clusterId.get(r);
      if (v === undefined) clusterId.set(r, (v = P + clusterId.size));
      return v;
    };
    const succ: number[][] = parts.map(() => []);
    const clusterSucc = new Map<number, Set<number>>();
    const feed = (v: number, pi: number) => {
      let l = clusterSucc.get(v);
      if (!l) clusterSucc.set(v, (l = new Set()));
      l.add(pi);
    };
    parts.forEach((p, pi) => {
      const sw = this.switchesOf.get(pi);
      for (const pin of p.pins) {
        if (sw && pin.dir === "inout") continue; // channels are handled below
        for (const node of pin.bits) {
          if (pin.dir !== "out" && p.type !== "ground" && !PASSIVE.has(p.type) && !seq[pi]) feed(vertex(node), pi);
          if (pin.dir !== "in" && !seq[pi]) succ[pi].push(vertex(node));
        }
      }
      for (const x of sw ?? [])
        for (const node of [x.a, x.b]) {
          feed(vertex(node), pi); // what is on either side can pass through
          if (!this.supplyNode[node]) succ[pi].push(vertex(node));
        }
    });
    const V = P + clusterId.size;
    const all: number[][] = new Array(V);
    for (let i = 0; i < P; i++) all[i] = [...new Set(succ[i])];
    for (let v = P; v < V; v++) all[v] = [...(clusterSucc.get(v) ?? [])];
    // a part reading its own output (not a transistor beside its own channel) is a loop by itself
    const selfLoop = (pi: number) => {
      if (this.switchesOf.has(pi)) return false;
      const outs = new Set<number>();
      for (const pin of parts[pi].pins) if (pin.dir !== "in") for (const node of pin.bits) outs.add(vertex(node));
      if (parts[pi].type === "ground" || PASSIVE.has(parts[pi].type)) return false;
      for (const pin of parts[pi].pins) if (pin.dir !== "out") for (const node of pin.bits) if (outs.has(vertex(node))) return true;
      return false;
    };
    const sccs = stronglyConnected(all)
      .map((comp) => comp.filter((v) => v < P))
      .filter((comp) => comp.length > 0);
    const total = sccs.length;
    sccs.forEach((comp, k) => {
      const r = total - 1 - k; // Tarjan lists the components that are fed first
      for (const pi of comp) this.rank[pi] = seq[pi] ? -1 : r;
      this.loop[r] = comp.length > 1 || selfLoop(comp[0]);
      if (this.loop[r]) this.loopParts[r] = comp;
    });
    this.buckets = Array.from({ length: total }, () => new Set<number>());
    this.queued = new Uint8Array(total);
    // a loop may take a few waves per part before it counts as oscillating
    sccs.forEach((comp, k) => (this.loopCap[total - 1 - k] = this.maxWavesOpt ?? 64 + 8 * comp.length));
  }

  private enqueue(pi: number): void {
    const r = this.rank[pi];
    if (r < 0) this.seqPending.add(pi);
    else {
      this.buckets[r].add(pi);
      if (!this.queued[r]) {
        this.queued[r] = 1;
        heapPush(this.heap, r);
      }
    }
  }

  // ---- stimuli ----------------------------------------------------------------------------------

  /** Find a part by id or name. */
  part(ref: string): CircuitPart | undefined {
    const i = this.partIndex(ref);
    return i < 0 ? undefined : this.circuit.parts[i];
  }

  private partIndex(ref: string): number {
    return this.byId.get(ref) ?? this.byName.get(ref) ?? -1;
  }

  /**
   * Set an input (input pin, clock, push button, DIP switch, keypad) by part id or name. A number
   * sets the bits of its output (for a DIP switch, bit k is switch k; for a keypad, the key code
   * with VALID = 1, or -1 for no key).
   */
  set(ref: string, value: number | boolean | readonly Bit[]): void {
    const pi = this.partIndex(ref);
    if (pi < 0) throw new Error(`no part ${ref}`);
    const part = this.circuit.parts[pi];
    if (!STIMULI.has(part.type)) throw new Error(`${part.name} (${part.type}) is not an input`);
    const total = part.pins.reduce((s, p) => s + (p.dir === "out" ? p.width : 0), 0);
    let bits: Bit[];
    if (Array.isArray(value)) bits = [...(value as Bit[])];
    else if (part.type === "keypad") {
      const v = Number(value);
      const k = part.pins.filter((p) => p.id !== "valid").reduce((s, p) => s + p.width, 0);
      bits = v < 0 ? [...numberToBits(0, k), B0] : [...numberToBits(v, k), B1];
    } else bits = numberToBits(typeof value === "boolean" ? (value ? 1 : 0) : (value as number), total);
    // a push button is set by whether it is pressed; an active-low one outputs 0 while pressed
    if (part.type === "push-button" && part.props.activeLow && !Array.isArray(value)) bits = bits.map((b) => (b > 1 ? b : ((1 - b) as Bit)));
    let at = 0;
    part.pins.forEach((pin, k) => {
      if (pin.dir !== "out") return;
      for (let b = 0; b < pin.width; b++) this.stimulus[pi][k][b] = bits[at++] ?? B0;
    });
    this.enqueue(pi);
  }

  /**
   * One clock cycle: the clock (by id or name; every clock part when omitted) goes to 1, the
   * circuit settles, the clock goes back to 0, and it settles again. Returns the two results.
   */
  tick(ref?: string): [SettleResult, SettleResult] {
    const clocks = ref ? [ref] : this.circuit.parts.filter((p) => p.type === "clock").map((p) => p.id);
    if (!clocks.length) throw new Error("no clock to tick");
    for (const k of clocks) this.set(k, 1);
    const up = this.settle();
    for (const k of clocks) this.set(k, 0);
    return [up, this.settle()];
  }

  // ---- reading ----------------------------------------------------------------------------------

  /** The bits on a pin (`part`, `pin` by id), as the net resolves them. */
  pinBits(ref: string, pinId: string): Bit[] {
    const part = this.part(ref);
    const pin = part?.pins.find((p) => p.id === pinId);
    if (!pin) throw new Error(`no pin ${ref}.${pinId}`);
    return pin.bits.map((n) => this.values[n]);
  }

  /** The value an output pin (or probe, or any part with one input) sees: a number, or null when X or Z. */
  read(ref: string): number | null {
    const part = this.part(ref);
    if (!part) throw new Error(`no part ${ref}`);
    const pin = part.pins.find((p) => p.dir === "in") ?? part.pins[0];
    if (!pin) return null;
    return bitsToNumber(pin.bits.map((n) => this.values[n]));
  }

  node(n: number): Bit {
    return this.values[n];
  }

  private setValue(n: number, v: Bit): void {
    this.values[n] = v;
    if (v === BZ && this.readers[n].length) this.zSet.add(n);
    else this.zSet.delete(n);
  }

  // ---- settling ---------------------------------------------------------------------------------

  /**
   * Propagate until nothing changes (or the circuit is found to oscillate). The logic is
   * evaluated in signal order, so a part is evaluated once its inputs are final; a feedback loop
   * runs in waves (every part of it reads the values of the wave before) until it settles; then
   * all parts with state that saw a change are evaluated together, and so on.
   */
  settle(): SettleResult {
    // nodes held at X by the last settle get their real value back (and their drivers another look)
    for (const n of this.forcedX) {
      for (const d of this.drivers[n]) this.enqueue(d.part);
      for (const r of this.readers[n]) this.enqueue(r);
      for (const sw of this.switches) if (sw.a === n || sw.b === n) this.enqueue(sw.part);
    }
    const wasForced = [...this.forcedX];
    this.forcedX.clear();
    for (const n of wasForced) this.setValue(n, this.resolve(n).value);
    let rounds = 0;
    const oscillating = new Set<number>();
    const hold = (nodes: Iterable<number>) => {
      for (const n of nodes) {
        if (this.forcedX.has(n)) continue;
        this.forcedX.add(n);
        oscillating.add(n);
        if (this.values[n] !== BX) {
          this.setValue(n, BX);
          for (const r of this.readers[n]) this.enqueue(r);
        }
      }
    };
    let phases = 0;
    for (;;) {
      while (this.heap.length) {
        const r = this.heap[0];
        const bucket = this.buckets[r];
        if (!bucket.size) {
          heapPop(this.heap);
          this.queued[r] = 0;
          continue;
        }
        if (!this.loop[r]) {
          const parts = [...bucket];
          bucket.clear();
          this.wave(parts);
          rounds++;
          continue;
        }
        let waves = 0;
        let held = false;
        while (bucket.size) {
          const parts = [...bucket];
          bucket.clear();
          this.wave(parts);
          rounds++;
          if (++waves < this.loopCap[r] || held) continue;
          // still changing: watch a while longer to see which nodes keep changing, then hold them at X
          const changing = new Set<number>();
          for (let i = 0; i < 64 && bucket.size; i++, rounds++) {
            const ps = [...bucket];
            bucket.clear();
            for (const node of this.wave(ps)) changing.add(node);
          }
          if (bucket.size) {
            hold(changing);
            held = true;
          }
        }
        if (!held) hold(this.probeLoop(r));
      }
      if (!this.seqPending.size) break;
      const parts = [...this.seqPending];
      this.seqPending.clear();
      const changed = this.wave(parts);
      rounds++;
      if (++phases > this.maxWaves) {
        // a part with state that keeps re-triggering itself (an output feeding its own clock)
        hold(changed);
        this.seqPending.clear();
      }
    }
    const issues = this.issues();
    if (oscillating.size) {
      const nodes = [...oscillating].sort((a, b) => a - b);
      const pins = this.pinsOn(nodes);
      issues.unshift({
        kind: "oscillation",
        nodes,
        pins,
        message: `the circuit does not settle: ${pins.slice(0, 6).join(", ")}${pins.length > 6 ? ", ..." : ""} keep changing`,
      });
    }
    return { waves: rounds, stable: oscillating.size === 0, issues };
  }

  /**
   * A feedback loop that settled with unknown values although everything feeding it is known
   * either holds a state nothing has set yet (a latch never set: X is right) or has no stable
   * state at all (a ring of inverters). Tell them apart by trying: set one of its unknown nodes
   * to 0 and run the loop. Everything is put back afterwards; returns the nodes that kept
   * changing (none for a latch).
   */
  private probeLoop(r: number): number[] {
    const members = this.loopParts[r];
    if (!members) return [];
    const parts = this.circuit.parts;
    const inLoop = new Set(members);
    const inner: number[] = [];
    const driven = new Set<number>();
    for (const pi of members) for (const pin of parts[pi].pins) if (pin.dir !== "in") for (const n of pin.bits) driven.add(n);
    for (const pi of members) for (const sw of this.switchesOf.get(pi) ?? []) driven.add(sw.a), driven.add(sw.b);
    for (const n of [...driven]) for (const m of this.members.get(this.root[n]) ?? []) driven.add(m);
    for (const n of driven) if (this.readers[n].some((x) => inLoop.has(x))) inner.push(n);
    const start = inner.find((n) => this.values[n] === BX && !this.forcedX.has(n));
    if (start === undefined) return [];
    for (const pi of members)
      for (const pin of parts[pi].pins)
        if (pin.dir === "in") for (const n of pin.bits) if (!driven.has(n) && this.values[n] > 1) return []; // unknown inputs: X is expected
    // save
    const values = this.values.slice();
    const drives = members.map((pi) => this.drives[pi].map((a) => a.slice()));
    const sws = members.flatMap((pi) => (this.switchesOf.get(pi) ?? []).map((sw) => [sw, sw.on] as const));
    const bucket = this.buckets[r];
    // try: hold the node at 0 until the loop settles, then let go and see whether it stays
    const run = (waves: number, record?: Set<number>) => {
      for (let w = 0; bucket.size && w < waves; w++) {
        const ps = [...bucket];
        bucket.clear();
        for (const n of this.wave(ps)) if (record && driven.has(n)) record.add(n);
      }
    };
    const cap = 4 * members.length + 32;
    this.probeHold = start;
    const zSaved = new Set(this.zSet);
    this.setValue(start, B0);
    for (const x of this.readers[start]) if (inLoop.has(x)) bucket.add(x);
    run(cap);
    this.probeHold = -1;
    const released = this.resolve(start).value;
    if (released !== this.values[start]) {
      this.setValue(start, released);
      for (const x of this.readers[start]) if (inLoop.has(x)) bucket.add(x);
    }
    run(cap);
    const changing = new Set<number>();
    run(16, changing);
    const oscillates = bucket.size > 0;
    // put everything back
    bucket.clear();
    this.values = values;
    this.zSet = zSaved;
    members.forEach((pi, i) => (this.drives[pi] = drives[i]));
    if (sws.length) {
      for (const [sw, on] of sws) sw.on = on;
      this.regroup();
    }
    return oscillates ? [...changing] : [];
  }

  /** Evaluate parts against the current values, then apply all their outputs; returns the nodes that changed. */
  private wave(parts: readonly number[]): number[] {
    // the common case, one ordinary part in a circuit without transistors: no bookkeeping
    if (parts.length === 1 && !this.switches.length && this.probeHold < 0) {
      const pi = parts[0];
      const next = this.evaluate(pi);
      const cur = this.drives[pi];
      const pins = this.circuit.parts[pi].pins;
      const changed: number[] = [];
      for (let k = 0; k < next.length; k++) {
        const nb = next[k], cb = cur[k];
        for (let b = 0; b < nb.length; b++) {
          if (cb[b] === nb[b]) continue;
          cb[b] = nb[b];
          const n = pins[k].bits[b];
          const v = this.forcedX.has(n) ? BX : this.resolveGroup(n).value;
          if (v !== this.values[n]) {
            this.setValue(n, v);
            changed.push(n);
            for (const r of this.readers[n]) this.enqueue(r);
          }
        }
      }
      return changed;
    }
    const touched = new Set<number>();
    const switched: Switch[] = [];
    for (const pi of parts) {
      const sws = this.switchesOf.get(pi);
      if (sws) {
        for (const sw of sws) {
          const g = this.values[this.circuit.parts[pi].pins[sw.gate].bits[0]];
          const on: Bit = g > 1 ? BX : ((sw.inverted ? 1 - g : g) as Bit);
          if (on !== sw.on) {
            sw.on = on;
            switched.push(sw);
            // (a rail keeps its value whatever is switched onto it)
            if (!this.supplyNode[sw.a]) touched.add(sw.a);
            if (!this.supplyNode[sw.b]) touched.add(sw.b);
          }
        }
        continue;
      }
      const next = this.evaluate(pi);
      const cur = this.drives[pi];
      next.forEach((bits, k) => {
        bits.forEach((v, b) => {
          if (cur[k][b] !== v) {
            cur[k][b] = v;
            touched.add(this.circuit.parts[pi].pins[k].bits[b]);
          }
        });
      });
    }
    if (switched.length) this.regroupAround(switched);
    // a change anywhere in a group of joined nets is a change to all of it, and to the groups an
    // unsure switch might join it to; a rail that changes value changes every net switched onto it
    if (this.switches.length) {
      const more = new Set<number>();
      const stack: number[] = [];
      const addGroup = (n: number) => {
        if (more.has(n)) return;
        if (this.supplyNode[n]) {
          more.add(n);
          return;
        }
        for (const m of this.members.get(this.root[n]) ?? [n]) {
          if (more.has(m)) continue;
          more.add(m);
          stack.push(m);
        }
      };
      for (const n of touched) {
        addGroup(n);
        if (this.supplyNode[n]) for (const sw of this.swAt[n]) if (sw.on !== B0) addGroup(sw.a === n ? sw.b : sw.a);
      }
      while (stack.length) {
        const m = stack.pop()!;
        for (const sw of this.unsure.get(m) ?? []) {
          addGroup(sw.a);
          addGroup(sw.b);
        }
      }
      for (const n of more) touched.add(n);
    }
    const changed: number[] = [];
    // every node of a group of joined nets has the group's value: resolve each group once
    const memo = this.switches.length ? new Map<number, Bit>() : null;
    if (this.unsure.size) this.compCache = new Map();
    for (const n of touched) {
      let v: Bit;
      if (n === this.probeHold) v = B0;
      else if (this.forcedX.has(n)) v = BX;
      else if (memo) {
        const r = this.root[n];
        let m = memo.get(r);
        if (m === undefined) memo.set(r, (m = this.resolve(n).value));
        v = m;
      } else v = this.resolve(n).value;
      if (v !== this.values[n]) {
        this.setValue(n, v);
        changed.push(n);
        for (const r of this.readers[n]) this.enqueue(r);
      }
    }
    this.compCache = null;
    return changed;
  }

  /** Recompute which nodes conducting switches join. */
  private regroup(): void {
    const parent = this.root.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    this.unsure.clear();
    for (const sw of this.switches) {
      if (sw.on === B1) {
        if (this.supplyNode[sw.a] || this.supplyNode[sw.b]) continue; // a rail feeds the group (see resolveGroup)
        const x = find(sw.a), y = find(sw.b);
        if (x !== y) parent[x] = y;
      } else if (sw.on === BX) {
        for (const n of new Set([sw.a, sw.b])) this.unsure.set(n, [...(this.unsure.get(n) ?? []), sw]);
      }
    }
    this.members.clear();
    for (let i = 0; i < parent.length; i++) {
      const r = find(i);
      this.root[i] = r;
    }
    for (let i = 0; i < parent.length; i++) {
      const r = this.root[i];
      if (r === i) continue;
      const l = this.members.get(r);
      if (l) l.push(i);
      else this.members.set(r, [r, i]);
    }
  }

  /**
   * Regroup after some switches changed: only the groups at their ends are rebuilt, by following
   * conducting switches (never through a rail), and the unknown-switch lists are updated.
   */
  private regroupAround(changed: readonly Switch[]): void {
    for (const sw of changed)
      for (const end of new Set([sw.a, sw.b])) {
        const l = (this.unsure.get(end) ?? []).filter((x) => x !== sw);
        if (sw.on === BX) l.push(sw);
        if (l.length) this.unsure.set(end, l);
        else this.unsure.delete(end);
      }
    const seeds: number[] = [];
    const seen = new Set<number>();
    for (const sw of changed)
      for (const end of [sw.a, sw.b]) {
        if (this.supplyNode[end]) continue;
        for (const m of this.members.get(this.root[end]) ?? [end])
          if (!seen.has(m)) {
            seen.add(m);
            seeds.push(m);
          }
      }
    for (const m of seeds) this.members.delete(this.root[m]);
    const done = new Set<number>();
    const isSeed = new Set(seeds);
    for (const start of seeds) {
      if (done.has(start)) continue;
      const comp = [start];
      done.add(start);
      for (let i = 0; i < comp.length; i++)
        for (const sw of this.swAt[comp[i]]) {
          if (sw.on !== B1) continue;
          const o = sw.a === comp[i] ? sw.b : sw.a;
          if (this.supplyNode[o] || done.has(o)) continue;
          // a node of a group outside the seeds joins this one: that group is rebuilt here too
          // (a seed not reached yet still carries its old root, which may be a new group's id)
          if (!isSeed.has(o)) this.members.delete(this.root[o]);
          done.add(o);
          comp.push(o);
        }
      for (const m of comp) this.root[m] = start;
      if (comp.length > 1) this.members.set(start, comp);
    }
  }

  private resolve(n: number): { value: Bit; strong: number; distinct: boolean; supply: boolean } {
    const r = this.resolveGroup(this.root[n]);
    // Switches that may or may not conduct: every group they might join this one to (through any
    // number of them) could bring its value. The value is unknown if one could change it: a
    // strong value different from ours, or any value when ours is only weak or nothing.
    // (a supply rail or an input keeps its value: at worst the switch is a short, reported as such)
    // (only the rail itself: a net switched onto a rail can still be shorted elsewhere)
    if (!this.unsure.size || r.value === BX || this.supplyNode[n]) return r;
    const own = this.root[n];
    // Every group reachable from this one through unknown switches shares the same set of
    // reachable groups (a rail is reached but not passed through), so it is worked out once per
    // such component and shared while the values do not change (one wave's resolution).
    let info = this.compCache?.get(own);
    if (!info) {
      info = { strong: new Set<Bit>(), weak: new Set<Bit>() };
      const seen = new Set<number>([own]);
      const queue = [own];
      const note = (g: number) => {
        const o = this.resolveGroup(g);
        if (o.value === BZ) return;
        (o.strong > 0 ? info!.strong : info!.weak).add(o.value);
      };
      note(own);
      while (queue.length) {
        const g = queue.pop()!;
        this.compCache?.set(g, info);
        for (const m of this.members.get(g) ?? [g])
          for (const sw of this.unsure.get(m) ?? [])
            for (const end of [sw.a, sw.b]) {
              const og = this.root[end];
              if (seen.has(og)) continue;
              seen.add(og);
              note(og);
              if (!this.supplyNode[end]) queue.push(og);
            }
      }
    }
    // unknown if another group could bring a different strong value, or any different value
    // when ours is only weak or nothing (a pull cannot override a driven net)
    for (const v of info.strong) if (v !== r.value) return { ...r, value: BX };
    if (r.strong === 0) for (const v of info.weak) if (v !== r.value) return { ...r, value: BX };
    return r;
  }

  private resolveGroup(root: number): { value: Bit; strong: number; distinct: boolean; supply: boolean } {
    let strongV: Bit | -1 = -1;
    let weakV: Bit | -1 = -1;
    let strong = 0;
    let distinct = false;
    let supply = false;
    const nodes = this.members.get(root) ?? [root];
    const sources: number[] = [];
    if (this.switches.length && !this.supplyNode[root])
      for (const m of nodes) for (const sw of this.swAt[m]) if (sw.on === B1) {
        const o = sw.a === m ? sw.b : sw.a;
        if (this.supplyNode[o] && !sources.includes(o)) sources.push(o);
      }
    for (const m of sources.length ? [...nodes, ...sources] : nodes)
    for (const d of this.drivers[m]) {
      const v = this.drives[d.part][d.pin][d.bit];
      if (v === BZ) continue;
      if (d.strength === "weak") {
        weakV = weakV === -1 || weakV === v ? v : BX;
        continue;
      }
      strong++;
      if (d.supply) supply = true;
      if (strongV === -1) strongV = v;
      else if (strongV !== v) {
        // two outputs that differ, or an unknown one beside another: a short, or a possible one
        distinct = true;
        strongV = BX;
      }
    }
    if (strongV !== -1) return { value: strongV, strong, distinct, supply };
    if (weakV !== -1) return { value: weakV, strong, distinct, supply };
    return { value: BZ, strong, distinct, supply };
  }

  private evaluate(pi: number): Bit[][] {
    const part = this.circuit.parts[pi];
    const out: Bit[][] = part.pins.map((pin) => new Array<Bit>(pin.width).fill(BZ));
    if (STIMULI.has(part.type)) {
      part.pins.forEach((pin, k) => {
        if (pin.dir === "out") out[k] = [...this.stimulus[pi][k]];
      });
      return out;
    }
    const model = this.models[pi];
    if (!model) {
      // not modelled: whatever it outputs is unknown; it never drives a bidirectional pin
      part.pins.forEach((pin, k) => {
        if (pin.dir === "out") out[k].fill(BX);
      });
      return out;
    }
    const index = (this.pinIndex[pi] ??= new Map(part.pins.map((x, k) => [x.id, k])));
    model(new IO(part, this.values, out, this.initial, index), this.state[pi]);
    if (this.rank[pi] < 0 || !out.some((bits) => bits.includes(BX))) return out;
    // A part without state whose output came out unknown: if only a few input bits are unknown,
    // try every way of filling them in and keep what all the tries agree on. This makes every
    // such model exact (an AND with an unknown input and a 0 is 0 whatever the model does).
    const unknown: number[] = [];
    for (const pin of part.pins) {
      if (pin.dir === "out") continue;
      for (const n of pin.bits) if (this.values[n] > 1 && !unknown.includes(n)) unknown.push(n);
    }
    if (!unknown.length || unknown.length > EXACT_UNKNOWNS) return out;
    let merged: Bit[][] | null = null;
    const override = new Map<number, Bit>();
    for (let m = 0; m < 1 << unknown.length; m++) {
      unknown.forEach((n, i) => override.set(n, ((m >> i) & 1) as Bit));
      const o: Bit[][] = part.pins.map((pin) => new Array<Bit>(pin.width).fill(BZ));
      model(new IO(part, this.values, o, this.initial, index, override), {});
      merged = merged ? merged.map((bits, k) => bits.map((b, j) => (b === o[k][j] ? b : BX))) : o;
    }
    // (only unknown bits are refined: the model's known bits stand)
    return out.map((bits, k) => bits.map((b, j) => (b === BX ? merged![k][j] : b)));
  }

  // ---- diagnostics ------------------------------------------------------------------------------

  private pinsOn(nodes: readonly number[]): string[] {
    if (!this.pinsAt) {
      this.pinsAt = Array.from({ length: this.values.length }, () => [] as string[]);
      for (const part of this.circuit.parts)
        for (const pin of part.pins) {
          const name = `${part.name}.${pin.id}`;
          for (const b of new Set(pin.bits)) this.pinsAt[b].push(name);
        }
    }
    const out = new Set<string>();
    for (const n of nodes) for (const name of this.pinsAt[n] ?? []) out.add(name);
    return [...out];
  }

  /** Contention and floating inputs in the current state, grouped by net. */
  issues(): SimIssue[] {
    const issues: SimIssue[] = [];
    if (!this.nodeNet) {
      this.nodeNet = new Map<number, number>();
      for (const part of this.circuit.parts) for (const pin of part.pins) if (pin.net >= 0) pin.bits.forEach((b) => this.nodeNet!.set(b, pin.net));
      this.multi = [];
      for (let n = 0; n < this.drivers.length; n++) if (this.drivers[n].length > 1) this.multi.push(n);
    }
    const nodeNet = this.nodeNet;
    const group = (nodes: number[]) => {
      const by = new Map<string, number[]>();
      for (const n of nodes) {
        const net = nodeNet.get(n);
        // (rails shorted by one switch are one problem: key them by the switch's first end)
        const rail = this.supplyNode[n] ? this.swAt[n].find((sw) => sw.on === B1 && this.supplyNode[sw.a] && this.supplyNode[sw.b]) : undefined;
        const key = rail ? `rail${rail.a}` : this.members.has(this.root[n]) || this.swAt[n]?.length ? `grp${this.root[n]}` : net === undefined ? `node${n}` : `net${net}`;
        const l = by.get(key);
        if (l) l.push(n);
        else by.set(key, [n]);
      }
      return [...by.values()];
    };
    const contended: number[] = [];
    const floating: number[] = [];
    // only nodes with several drivers (or joined by switches) can have a short
    const seen = new Set<number>();
    for (const n of this.multi!) if (this.resolve(n).distinct) contended.push(n), seen.add(n);
    // a conducting switch straight between two rails at different values is a short
    for (const sw of this.switches)
      if (sw.on === B1 && this.supplyNode[sw.a] && this.supplyNode[sw.b] && this.values[sw.a] !== this.values[sw.b])
        for (const n of [sw.a, sw.b]) if (!seen.has(n)) contended.push(n), seen.add(n);
    // groups joined by switches (and single nets switched onto rails)
    const roots = new Set<number>(this.members.keys());
    for (const sw of this.switches) if (sw.on === B1) for (const e of [sw.a, sw.b]) if (!this.supplyNode[e]) roots.add(this.root[e]);
    for (const root of roots)
      if (this.resolveGroup(root).distinct) for (const m of this.members.get(root) ?? [root]) if (!seen.has(m)) contended.push(m), seen.add(m);
    for (const n of this.zSet) floating.push(n);
    floating.sort((a, b) => a - b);
    // Switches that may be conducting (their control is unknown) between nets driven to different
    // values may be a short: nets joined through any chain of such switches form a cluster, and a
    // cluster holding two different driven values is reported once, with the switches and drivers.
    if (this.unsure.size) {
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
        return x;
      };
      const unsureSw = this.switches.filter((sw) => sw.on === BX && this.root[sw.a] !== this.root[sw.b]);
      for (const sw of unsureSw) {
        const x = find(this.root[sw.a]), y = find(this.root[sw.b]);
        if (!parent.has(x)) parent.set(x, x);
        if (!parent.has(y)) parent.set(y, y);
        if (x !== y) parent.set(x, y);
      }
      const clusters = new Map<number, { groups: Set<number>; sws: Switch[] }>();
      for (const sw of unsureSw) {
        const c = find(this.root[sw.a]);
        const e = clusters.get(c) ?? { groups: new Set<number>(), sws: [] };
        e.groups.add(this.root[sw.a]);
        e.groups.add(this.root[sw.b]);
        e.sws.push(sw);
        clusters.set(c, e);
      }
      for (const { groups, sws } of clusters.values()) {
        const vals = new Set<Bit>();
        for (const g of groups) {
          const r = this.resolveGroup(g);
          if (r.strong > 0 && r.value !== BZ) vals.add(r.value);
        }
        if (vals.size < 2) continue;
        const nodes = [...new Set(sws.flatMap((sw) => [sw.a, sw.b]))];
        const drv = new Set<string>();
        for (const g of groups)
          for (const m of this.members.get(g) ?? [g])
            for (const d of this.drivers[m]) {
              const v = this.drives[d.part][d.pin][d.bit];
              if (v !== BZ && d.strength !== "weak") drv.add(`${this.circuit.parts[d.part].name}.${this.circuit.parts[d.part].pins[d.pin].id}=${bitChar(v)}`);
            }
        const names = [...new Set(sws.map((sw) => this.circuit.parts[sw.part].name))];
        issues.push({
          kind: "contention",
          nodes,
          pins: this.pinsOn(nodes),
          message: `${names.join(", ")} may be conducting (control unknown) between nets driven to different values (${[...drv].join(", ")})`,
        });
      }
    }
    for (const nodes of group(contended)) {
      const drv = new Set<string>();
      const from = new Set(nodes);
      // and the rails switched onto them
      for (const n of nodes) for (const sw of this.swAt[n] ?? []) if (sw.on === B1) for (const e of [sw.a, sw.b]) if (this.supplyNode[e]) from.add(e);
      for (const n of from)
        for (const d of this.drivers[n]) {
          const v = this.drives[d.part][d.pin][d.bit];
          if (v !== BZ && d.strength !== "weak") drv.add(`${this.circuit.parts[d.part].name}.${this.circuit.parts[d.part].pins[d.pin].id}=${bitChar(v)}`);
        }
      issues.push({
        kind: "contention",
        nodes,
        pins: this.pinsOn(nodes),
        message: `outputs drive different values onto one net (${[...drv].join(", ")})`,
      });
    }
    for (const nodes of group(floating)) {
      const readers = this.pinsOn(nodes).filter((s) => {
        const [pn, pid] = [s.slice(0, s.lastIndexOf(".")), s.slice(s.lastIndexOf(".") + 1)];
        const pin = this.circuit.parts.find((p) => p.name === pn)?.pins.find((p) => p.id === pid);
        return pin && pin.dir !== "out";
      });
      issues.push({
        kind: "floating",
        nodes,
        pins: readers,
        message: `nothing drives ${readers.join(", ")} (it reads X)`,
      });
    }
    this.unmodelledParts ??= this.circuit.parts.map((_, i) => i).filter((i) => {
      const p = this.circuit.parts[i];
      return !this.models[i] && !STIMULI.has(p.type) && !PASSIVE.has(p.type) && !SWITCHES[p.type] && p.pins.some((pin) => pin.dir !== "in");
    });
    for (const i of this.unmodelledParts) {
      const p = this.circuit.parts[i];
      issues.push({ kind: "unmodelled", nodes: [], pins: [p.name], message: `${p.name} (${p.type}) is not simulated; its outputs read X` });
    }
    return issues;
  }
}

/** What a model sees: its input values and where to put its outputs. */
class IO implements PartIO {
  constructor(
    readonly part: CircuitPart,
    private values: Bit[],
    private out: Bit[][],
    readonly initial: "x" | "zero",
    private index: Map<string, number>,
    /** values to read instead of the circuit's, for some nodes (see evaluate) */
    private override?: Map<number, Bit>,
  ) {}

  private pin(id: string): number {
    return this.index.get(id) ?? -1;
  }

  has(id: string): boolean {
    return this.pin(id) >= 0;
  }

  prop(key: string): string | number | boolean | undefined {
    return this.part.props[key];
  }

  pinInfo(id: string): CircuitPin | undefined {
    return this.part.pins[this.pin(id)];
  }

  bits(id: string): Bit[] {
    const k = this.pin(id);
    if (k < 0) return [];
    return this.part.pins[k].bits.map((n) => {
      const v = this.override?.get(n) ?? this.values[n];
      return v === BZ ? BX : v;
    });
  }

  bit(id: string): Bit {
    return this.bits(id)[0] ?? BX;
  }

  active(id: string, absent: Bit = B1): Bit {
    if (!this.has(id)) return absent;
    const v = this.bit(id);
    if (v === BX) return BX;
    return (this.part.pins[this.pin(id)].inverted ? 1 - v : v) as Bit;
  }

  bus(prefix: string, sep = ""): Bit[] {
    if (this.has(prefix)) return this.bits(prefix);
    const out: Bit[] = [];
    for (let i = 0; this.has(`${prefix}${sep}${i}`); i++) out.push(...this.bits(`${prefix}${sep}${i}`));
    return out;
  }

  busWidth(prefix: string, sep = ""): number {
    const k = this.pin(prefix);
    if (k >= 0) return this.part.pins[k].width;
    let w = 0;
    for (let i = 0; this.has(`${prefix}${sep}${i}`); i++) w += this.part.pins[this.pin(`${prefix}${sep}${i}`)].width;
    return w;
  }

  drive(id: string, v: Drive): void {
    const k = this.pin(id);
    if (k < 0) return;
    const w = this.part.pins[k].width;
    this.out[k] = toBits(v, w);
  }

  driveBus(prefix: string, v: Drive, sep = ""): void {
    if (this.has(prefix)) return this.drive(prefix, v);
    const w = this.busWidth(prefix, sep);
    const bits = toBits(v, w);
    let at = 0;
    for (let i = 0; this.has(`${prefix}${sep}${i}`); i++) {
      const k = this.pin(`${prefix}${sep}${i}`);
      const pw = this.part.pins[k].width;
      this.out[k] = bits.slice(at, at + pw);
      at += pw;
    }
  }
}

function toBits(v: Drive, w: number): Bit[] {
  if (v === "X") return new Array<Bit>(w).fill(BX);
  if (v === "Z") return new Array<Bit>(w).fill(BZ);
  if (Array.isArray(v)) {
    const out = (v as Bit[]).slice(0, w);
    while (out.length < w) out.push(B0);
    return out;
  }
  if (typeof v === "boolean") return numberToBits(v ? 1 : 0, w);
  return numberToBits(v as number | bigint, w);
}

function heapPush(h: number[], v: number): void {
  h.push(v);
  for (let i = h.length - 1; i > 0; ) {
    const p = (i - 1) >> 1;
    if (h[p] <= h[i]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function heapPop(h: number[]): number | undefined {
  const top = h[0];
  const last = h.pop();
  if (h.length && last !== undefined) {
    h[0] = last;
    for (let i = 0; ; ) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l] < h[m]) m = l;
      if (r < h.length && h[r] < h[m]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

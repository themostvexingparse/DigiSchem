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
}

/** Part types whose outputs are switched off (Z) rather than driven when disabled. */
const TRISTATE = new Set(["tristate", "bus-transceiver"]);
const WEAK = new Set(["pull-up", "pull-down"]);
/** Parts set from outside (by `set`), with the pins they drive. */
export const STIMULI = new Set(["input-pin", "clock", "push-button", "dip-switch", "keypad"]);
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
  private pending = new Set<number>();
  private readonly maxWaves: number;
  readonly initial: "x" | "zero";

  constructor(circuit: Circuit, opts: SimOptions = {}) {
    this.circuit = circuit;
    this.initial = opts.initial ?? "x";
    this.maxWaves = opts.maxWaves ?? 200 + 4 * circuit.parts.length;
    const n = circuit.nodes;
    this.values = new Array<Bit>(n).fill(BZ);
    this.drivers = Array.from({ length: n }, () => []);
    this.readers = Array.from({ length: n }, () => []);
    this.models = circuit.parts.map((p) => MODELS[p.type] ?? null);
    this.state = circuit.parts.map(() => ({}));
    this.drives = circuit.parts.map((p) => p.pins.map((pin) => new Array<Bit>(pin.width).fill(BZ)));
    this.stimulus = circuit.parts.map((p) => p.pins.map((pin) => new Array<Bit>(pin.width).fill(B0)));
    circuit.parts.forEach((p, pi) =>
      p.pins.forEach((pin, k) => {
        if (PASSIVE.has(p.type)) return;
        const strength: Strength = TRISTATE.has(p.type) ? "tristate" : WEAK.has(p.type) ? "weak" : "strong";
        const drives = pin.dir === "out" || pin.dir === "inout";
        const reads = pin.dir === "in" || pin.dir === "inout";
        pin.bits.forEach((node, b) => {
          if (drives) this.drivers[node].push({ part: pi, pin: k, bit: b, strength });
          if (reads && !this.readers[node].includes(pi)) this.readers[node].push(pi);
        });
      }),
    );
    for (let i = 0; i < circuit.parts.length; i++) this.pending.add(i);
  }

  // ---- stimuli ----------------------------------------------------------------------------------

  /** Find a part by id or name. */
  part(ref: string): CircuitPart | undefined {
    return this.circuit.parts.find((p) => p.id === ref) ?? this.circuit.parts.find((p) => p.name === ref);
  }

  private partIndex(ref: string): number {
    const i = this.circuit.parts.findIndex((p) => p.id === ref);
    return i >= 0 ? i : this.circuit.parts.findIndex((p) => p.name === ref);
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
    let at = 0;
    part.pins.forEach((pin, k) => {
      if (pin.dir !== "out") return;
      for (let b = 0; b < pin.width; b++) this.stimulus[pi][k][b] = bits[at++] ?? B0;
    });
    this.pending.add(pi);
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
    return bitsToNumber(pin.bits.map((n) => this.values[n]));
  }

  node(n: number): Bit {
    return this.values[n];
  }

  // ---- settling ---------------------------------------------------------------------------------

  /** Propagate until nothing changes (or the circuit is found to oscillate). */
  settle(): SettleResult {
    // nodes held at X by the last settle get their real value back (and their drivers another look)
    for (const n of this.forcedX) {
      for (const d of this.drivers[n]) this.pending.add(d.part);
      for (const r of this.readers[n]) this.pending.add(r);
    }
    const wasForced = [...this.forcedX];
    this.forcedX.clear();
    for (const n of wasForced) this.values[n] = this.resolve(n).value;
    let waves = 0;
    while (this.pending.size && waves < this.maxWaves) {
      this.wave();
      waves++;
    }
    const oscillating = new Set<number>();
    if (this.pending.size) {
      // Still changing: watch a while longer to see which nodes keep changing, then hold them at X.
      for (let i = 0; i < 64 && this.pending.size; i++, waves++) for (const n of this.wave()) oscillating.add(n);
      if (this.pending.size) {
        for (const n of oscillating) {
          this.forcedX.add(n);
          this.values[n] = BX;
          for (const r of this.readers[n]) this.pending.add(r);
        }
        for (let i = 0; this.pending.size && i < this.maxWaves; i++, waves++) this.wave();
      } else oscillating.clear();
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
    return { waves, stable: oscillating.size === 0, issues };
  }

  /** Evaluate the pending parts against the current values; returns the nodes that changed. */
  private wave(): number[] {
    const parts = [...this.pending];
    this.pending.clear();
    const touched = new Set<number>();
    for (const pi of parts) {
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
    const changed: number[] = [];
    for (const n of touched) {
      const v = this.forcedX.has(n) ? BX : this.resolve(n).value;
      if (v !== this.values[n]) {
        this.values[n] = v;
        changed.push(n);
        for (const r of this.readers[n]) this.pending.add(r);
      }
    }
    return changed;
  }

  private resolve(n: number): { value: Bit; strong: number; distinct: boolean } {
    let strongV: Bit | -1 = -1;
    let weakV: Bit | -1 = -1;
    let strong = 0;
    let distinct = false;
    for (const d of this.drivers[n]) {
      const v = this.drives[d.part][d.pin][d.bit];
      if (v === BZ) continue;
      if (d.strength === "weak") {
        weakV = weakV === -1 || weakV === v ? v : BX;
        continue;
      }
      strong++;
      if (strongV === -1) strongV = v;
      else if (strongV !== v) {
        distinct = true;
        strongV = BX;
      }
    }
    if (strongV !== -1) return { value: strongV, strong, distinct };
    if (weakV !== -1) return { value: weakV, strong, distinct };
    return { value: BZ, strong, distinct };
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
    const io = new IO(part, this.values, out, this.initial);
    model(io, this.state[pi]);
    return out;
  }

  // ---- diagnostics ------------------------------------------------------------------------------

  private pinsOn(nodes: readonly number[]): string[] {
    const set = new Set(nodes);
    const out: string[] = [];
    for (const part of this.circuit.parts)
      for (const pin of part.pins) if (pin.bits.some((b) => set.has(b))) out.push(`${part.name}.${pin.id}`);
    return out;
  }

  /** Contention and floating inputs in the current state, grouped by net. */
  issues(): SimIssue[] {
    const issues: SimIssue[] = [];
    const nodeNet = new Map<number, number>();
    for (const part of this.circuit.parts) for (const pin of part.pins) if (pin.net >= 0) pin.bits.forEach((b) => nodeNet.set(b, pin.net));
    const group = (nodes: number[]) => {
      const by = new Map<string, number[]>();
      for (const n of nodes) {
        const net = nodeNet.get(n);
        const key = net === undefined ? `node${n}` : `net${net}`;
        const l = by.get(key);
        if (l) l.push(n);
        else by.set(key, [n]);
      }
      return [...by.values()];
    };
    const contended: number[] = [];
    const floating: number[] = [];
    for (let n = 0; n < this.values.length; n++) {
      const r = this.resolve(n);
      if (r.distinct) contended.push(n);
      if (r.value === BZ && this.readers[n].length) floating.push(n);
    }
    for (const nodes of group(contended)) {
      const drv = new Set<string>();
      for (const n of nodes)
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
    this.circuit.parts.forEach((p, i) => {
      if (!this.models[i] && !STIMULI.has(p.type) && !PASSIVE.has(p.type) && p.pins.some((pin) => pin.dir !== "in"))
        issues.push({ kind: "unmodelled", nodes: [], pins: [p.name], message: `${p.name} (${p.type}) is not simulated; its outputs read X` });
    });
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
  ) {}

  private pin(id: string): number {
    return this.part.pins.findIndex((p) => p.id === id);
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
      const v = this.values[n];
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

  bus(prefix: string): Bit[] {
    if (this.has(prefix)) return this.bits(prefix);
    const out: Bit[] = [];
    for (let i = 0; this.has(`${prefix}${i}`); i++) out.push(...this.bits(`${prefix}${i}`));
    return out;
  }

  busWidth(prefix: string): number {
    const k = this.pin(prefix);
    if (k >= 0) return this.part.pins[k].width;
    let w = 0;
    for (let i = 0; this.has(`${prefix}${i}`); i++) w += this.part.pins[this.pin(`${prefix}${i}`)].width;
    return w;
  }

  drive(id: string, v: Drive): void {
    const k = this.pin(id);
    if (k < 0) return;
    const w = this.part.pins[k].width;
    this.out[k] = toBits(v, w);
  }

  driveBus(prefix: string, v: Drive): void {
    if (this.has(prefix)) return this.drive(prefix, v);
    const w = this.busWidth(prefix);
    const bits = toBits(v, w);
    let at = 0;
    for (let i = 0; this.has(`${prefix}${i}`); i++) {
      const k = this.pin(`${prefix}${i}`);
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

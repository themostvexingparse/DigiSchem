/**
 * Independent, deliberately simple reference simulator for cross-checking `src/logic/simulate.ts`.
 *
 * Works directly on the stripped `Circuit` (bit nodes and pins) from `extractCircuit`, and shares
 * NO runtime code with `src/logic/simulate.ts` or `src/logic/models.ts`.
 *
 * Supported component types:
 *   input-pin, output-pin, constant, vcc, ground, pull-up, pull-down,
 *   and, or, nand, nor, xor, xnor, not, buf,
 *   tristate (activeLowEnable, invertedOut),
 *   nmos, pmos, transmission-gate, splitter (passive).
 *
 * Semantics:
 * - 4 values: 0, 1, X (2), Z (3).
 * - Strong drivers that agree give that value; strong drivers that disagree give X and contention.
 * - With no strong driver, weak drivers (pull-up / pull-down) determine the value (opposing pulls
 *   give X without contention).
 * - With no drivers at all, the node is Z; an input reading Z sees X and is reported as floating.
 * - Supplies and inputs (vcc, ground, constant, input-pin) are ideal sources: switches never change
 *   the value of a net they drive, and a rail never merges the nets on its two sides.
 * - Conducting switches (nMOS gate=1, pMOS gate=0, transmission-gate en=1 or enb=0) merge the
 *   non-supply nets on their two sides; a non-supply group attached to a rail via a conducting
 *   switch receives the rail's drivers.
 * - Unknown switches (gate X or Z) may or may not conduct: for each connected island of non-supply
 *   nodes with at most `maxUnknownSwitches` (default 10) unknown switch edges, we brute-force all
 *   2^k switch assignments; a node's value is X if two assignments yield different values, and it
 *   has contention if any assignment produces conflicting strong drivers. Islands exceeding the
 *   limit are flagged in `skippedNodes`.
 */
import type { Circuit, CircuitPart, CircuitPin } from "../../src/logic/circuit";

export const R0 = 0 as const;
export const R1 = 1 as const;
export const RX = 2 as const;
export const RZ = 3 as const;
export type RefBit = 0 | 1 | 2 | 3;

export interface RefSimOptions {
  /** Maximum fixed-point iterations before reporting non-convergence (default 200). */
  maxIterations?: number;
  /** Maximum unknown switch edges per independent island for exact brute-force (default 10). */
  maxUnknownSwitches?: number;
}

export interface RefSettleResult {
  converged: boolean;
  iterations: number;
  /** Resolved 4-valued bit for each bit node. */
  values: RefBit[];
  /** Bit nodes with strong-driver contention in at least one assignment of unknown switches. */
  contentionNodes: Set<number>;
  /** Bit nodes with strong-driver contention in EVERY assignment of unknown switches. */
  definiteContentionNodes: Set<number>;
  /** Bit nodes whose resolved value is Z and that have at least one reader pin. */
  floatingNodes: Set<number>;
  /** Bit nodes affected by an island with > maxUnknownSwitches unknown switches (skipped). */
  skippedNodes: Set<number>;
}

const SUPPORTED_TYPES = new Set([
  "input-pin",
  "output-pin",
  "constant",
  "vcc",
  "ground",
  "pull-up",
  "pull-down",
  "and",
  "or",
  "nand",
  "nor",
  "xor",
  "xnor",
  "not",
  "buf",
  "tristate",
  "nmos",
  "pmos",
  "transmission-gate",
  "splitter",
]);

const SUPPLY_TYPES = new Set(["vcc", "ground", "constant", "input-pin"]);
const WEAK_TYPES = new Set(["pull-up", "pull-down"]);
const SWITCH_TYPES = new Set(["nmos", "pmos", "transmission-gate"]);

interface RefDriver {
  part: number;
  pin: number;
  bit: number;
  weak: boolean;
  supply: boolean;
}

interface RefSwitchChannel {
  part: number;
  a: number;
  b: number;
  /** Gate bit nodes and whether each gate is active-low (inverted). */
  gates: { node: number; inverted: boolean }[];
}

function refNot(a: RefBit): RefBit {
  if (a === R0) return R1;
  if (a === R1) return R0;
  return RX;
}

function refAnd(xs: readonly RefBit[]): RefBit {
  if (xs.includes(R0)) return R0;
  if (xs.every((x) => x === R1)) return R1;
  return RX;
}

function refOr(xs: readonly RefBit[]): RefBit {
  if (xs.includes(R1)) return R1;
  if (xs.every((x) => x === R0)) return R0;
  return RX;
}

function refXor(xs: readonly RefBit[]): RefBit {
  let parity = 0;
  for (const x of xs) {
    if (x !== R0 && x !== R1) return RX;
    parity ^= x;
  }
  return parity as RefBit;
}

function numToRefBits(v: number | bigint, width: number): RefBit[] {
  let x = BigInt.asUintN(width, BigInt(v));
  const out: RefBit[] = [];
  for (let i = 0; i < width; i++) {
    out.push(Number(x & 1n) as RefBit);
    x >>= 1n;
  }
  return out;
}

function parseConstantBits(rawProp: unknown, width: number): RefBit[] {
  const raw = String(rawProp ?? "1").trim();
  let v: bigint | null = null;
  try {
    if (/^-?\d+$/.test(raw) || /^0[xXbBoO][0-9a-fA-F]+$/.test(raw)) {
      v = BigInt(raw);
    }
  } catch {
    v = null;
  }
  if (v === null) return new Array<RefBit>(width).fill(RX);
  return numToRefBits(v, width);
}

/** Resolve a pool of (value, weak) drives into { value, contention }. */
function resolveDriveList(drives: readonly { v: RefBit; weak: boolean }[]): { value: RefBit; contention: boolean } {
  let strongVal: RefBit | -1 = -1;
  let contention = false;
  let weakVal: RefBit | -1 = -1;

  for (const d of drives) {
    if (d.v === RZ) continue;
    if (d.weak) {
      if (weakVal === -1) weakVal = d.v;
      else if (weakVal !== d.v) weakVal = RX;
    } else {
      if (strongVal === -1) strongVal = d.v;
      else if (strongVal !== d.v) {
        contention = true;
        strongVal = RX;
      }
    }
  }

  if (strongVal !== -1) return { value: strongVal, contention };
  if (weakVal !== -1) return { value: weakVal, contention: false };
  return { value: RZ, contention: false };
}

export class RefSimulator {
  readonly circuit: Circuit;
  private readonly maxIterations: number;
  private readonly maxUnknownSwitches: number;

  private readonly byId = new Map<string, number>();
  private readonly byName = new Map<string, number>();
  private readonly pinMap: Map<string, number>[];

  /** Stimulus bit values for input-pin parts: [part][pin][bit]. */
  private readonly stimulus: RefBit[][][];
  /** Direct drivers on each bit node. */
  private readonly drivers: RefDriver[][];
  /** Whether each bit node has at least one reader pin. */
  private readonly hasReader: boolean[];
  /** Whether each bit node is driven by an ideal supply/input source. */
  private readonly isSupply: boolean[];
  /** Switch channels (one per nmos/pmos/transmission-gate bit). */
  private readonly channels: RefSwitchChannel[] = [];

  /** Most recently settled node values. */
  private values: RefBit[];

  constructor(circuit: Circuit, opts: RefSimOptions = {}) {
    this.circuit = circuit;
    this.maxIterations = opts.maxIterations ?? 200;
    this.maxUnknownSwitches = opts.maxUnknownSwitches ?? 10;

    for (let i = 0; i < circuit.parts.length; i++) {
      const p = circuit.parts[i];
      if (!SUPPORTED_TYPES.has(p.type)) {
        throw new Error(`RefSimulator does not support part type "${p.type}" (${p.name})`);
      }
      this.byId.set(p.id, i);
      if (!this.byName.has(p.name)) this.byName.set(p.name, i);
    }

    this.pinMap = circuit.parts.map((p) => {
      const m = new Map<string, number>();
      p.pins.forEach((pin, idx) => m.set(pin.id, idx));
      return m;
    });

    const n = circuit.nodes;
    this.values = new Array<RefBit>(n).fill(RZ);
    this.drivers = Array.from({ length: n }, () => []);
    this.hasReader = new Array<boolean>(n).fill(false);
    this.isSupply = new Array<boolean>(n).fill(false);

    this.stimulus = circuit.parts.map((p) =>
      p.pins.map((pin) => new Array<RefBit>(pin.width).fill(R0)),
    );

    // Register drivers, readers, and switch channels
    circuit.parts.forEach((p, pi) => {
      if (p.type === "splitter") return;

      if (SWITCH_TYPES.has(p.type)) {
        if (p.type === "nmos" || p.type === "pmos") {
          const dPin = p.pins.find((x) => x.id === "d");
          const sPin = p.pins.find((x) => x.id === "s");
          const gPin = p.pins.find((x) => x.id === "g");
          if (gPin) {
            for (const b of gPin.bits) this.hasReader[b] = true;
          }
          if (dPin && sPin && gPin) {
            const w = Math.min(dPin.bits.length, sPin.bits.length);
            for (let i = 0; i < w; i++) {
              this.channels.push({
                part: pi,
                a: dPin.bits[i],
                b: sPin.bits[i],
                gates: [{ node: gPin.bits[0], inverted: gPin.inverted }],
              });
            }
          }
        } else if (p.type === "transmission-gate") {
          const aPin = p.pins.find((x) => x.id === "a");
          const bPin = p.pins.find((x) => x.id === "b");
          const enPin = p.pins.find((x) => x.id === "en");
          const enbPin = p.pins.find((x) => x.id === "enb");
          if (enPin) for (const b of enPin.bits) this.hasReader[b] = true;
          if (enbPin) for (const b of enbPin.bits) this.hasReader[b] = true;
          if (aPin && bPin && enPin && enbPin) {
            const w = Math.min(aPin.bits.length, bPin.bits.length);
            for (let i = 0; i < w; i++) {
              this.channels.push({
                part: pi,
                a: aPin.bits[i],
                b: bPin.bits[i],
                gates: [
                  { node: enPin.bits[0], inverted: enPin.inverted },
                  { node: enbPin.bits[0], inverted: enbPin.inverted },
                ],
              });
            }
          }
        }
        return;
      }

      const weak = WEAK_TYPES.has(p.type);
      const supply = SUPPLY_TYPES.has(p.type);
      p.pins.forEach((pin, k) => {
        const drives = pin.dir === "out" || pin.dir === "inout";
        const reads = (pin.dir === "in" || pin.dir === "inout") && p.type !== "ground";
        pin.bits.forEach((node, b) => {
          if (drives) {
            this.drivers[node].push({ part: pi, pin: k, bit: b, weak, supply });
            if (supply) this.isSupply[node] = true;
          }
          if (reads) {
            this.hasReader[node] = true;
          }
        });
      });
    });
  }

  private partIndex(ref: string): number {
    return this.byId.get(ref) ?? this.byName.get(ref) ?? -1;
  }

  set(ref: string, value: number | boolean | readonly RefBit[]): void {
    const pi = this.partIndex(ref);
    if (pi < 0) throw new Error(`RefSimulator: no part "${ref}"`);
    const part = this.circuit.parts[pi];
    if (part.type !== "input-pin") {
      throw new Error(`RefSimulator: "${part.name}" (${part.type}) is not an input-pin`);
    }
    const pinIdx = this.pinMap[pi].get("out");
    if (pinIdx === undefined) return;
    const width = part.pins[pinIdx].width;
    let bits: RefBit[];
    if (Array.isArray(value)) {
      bits = Array.from({ length: width }, (_, i) => (value[i] ?? R0) as RefBit);
    } else {
      const n = typeof value === "boolean" ? (value ? 1 : 0) : (value as number);
      bits = numToRefBits(n, width);
    }
    this.stimulus[pi][pinIdx] = bits;
  }

  node(n: number): RefBit {
    return this.values[n];
  }

  pinBits(ref: string, pinId: string): RefBit[] {
    const pi = this.partIndex(ref);
    if (pi < 0) throw new Error(`RefSimulator: no part "${ref}"`);
    const k = this.pinMap[pi].get(pinId);
    if (k === undefined) throw new Error(`RefSimulator: no pin "${ref}.${pinId}"`);
    return this.circuit.parts[pi].pins[k].bits.map((n) => this.values[n]);
  }

  read(ref: string): number | null {
    const pi = this.partIndex(ref);
    if (pi < 0) throw new Error(`RefSimulator: no part "${ref}"`);
    const part = this.circuit.parts[pi];
    const pin = part.pins.find((p) => p.dir === "in") ?? part.pins[0];
    if (!pin) return null;
    let acc = 0;
    for (let i = pin.bits.length - 1; i >= 0; i--) {
      const b = this.values[pin.bits[i]];
      if (b !== R0 && b !== R1) return null;
      acc = acc * 2 + b;
    }
    return acc;
  }

  /** Evaluate one non-switch part against the given node values. */
  private evalPart(
    part: CircuitPart,
    pi: number,
    nodeVals: readonly RefBit[],
    skippedIn: ReadonlySet<number>,
    skippedOutNodes: Set<number>,
  ): RefBit[][] {
    const out: RefBit[][] = part.pins.map((pin) => new Array<RefBit>(pin.width).fill(RZ));
    const pmap = this.pinMap[pi];

    const readBit = (pinId: string): { v: RefBit; skipped: boolean } => {
      const k = pmap.get(pinId);
      if (k === undefined) return { v: RX, skipped: false };
      const node = part.pins[k].bits[0];
      const raw = nodeVals[node];
      return { v: raw === RZ ? RX : raw, skipped: skippedIn.has(node) };
    };

    const readBits = (pinId: string): { vs: RefBit[]; skipped: boolean[] } => {
      const k = pmap.get(pinId);
      if (k === undefined) return { vs: [], skipped: [] };
      const bits = part.pins[k].bits;
      return {
        vs: bits.map((n) => (nodeVals[n] === RZ ? RX : nodeVals[n])),
        skipped: bits.map((n) => skippedIn.has(n)),
      };
    };

    const drivePin = (pinId: string, bits: RefBit[], skippedBits?: boolean[]) => {
      const k = pmap.get(pinId);
      if (k === undefined) return;
      const pin: CircuitPin = part.pins[k];
      for (let i = 0; i < pin.width; i++) {
        out[k][i] = bits[i] ?? R0;
        if (skippedBits?.[i]) skippedOutNodes.add(pin.bits[i]);
      }
    };

    switch (part.type) {
      case "input-pin": {
        const k = pmap.get("out");
        if (k !== undefined) out[k] = this.stimulus[pi][k].slice();
        break;
      }
      case "constant": {
        const k = pmap.get("out");
        if (k !== undefined) out[k] = parseConstantBits(part.props.value, part.pins[k].width);
        break;
      }
      case "vcc":
        drivePin("vcc", [R1]);
        break;
      case "ground":
        drivePin("gnd", [R0]);
        break;
      case "pull-up":
        drivePin("out", [R1]);
        break;
      case "pull-down":
        drivePin("out", [R0]);
        break;
      case "output-pin":
      case "splitter":
        break;
      case "buf": {
        const a = readBit("in0");
        drivePin("out", [a.v], [a.skipped]);
        break;
      }
      case "not": {
        const a = readBit("in0");
        drivePin("out", [refNot(a.v)], [a.skipped]);
        break;
      }
      case "and":
      case "nand":
      case "or":
      case "nor":
      case "xor":
      case "xnor": {
        const xs: RefBit[] = [];
        let anySkipped = false;
        for (let i = 0; pmap.has(`in${i}`); i++) {
          const r = readBit(`in${i}`);
          xs.push(r.v);
          if (r.skipped) anySkipped = true;
        }
        let y: RefBit;
        let dominated = false;
        if (part.type === "and" || part.type === "nand") {
          y = refAnd(xs);
          // A known 0 on a non-skipped input dominates regardless of skipped inputs
          if (y === R0) {
            let cleanZero = false;
            for (let i = 0; i < xs.length; i++) {
              const r = readBit(`in${i}`);
              if (r.v === R0 && !r.skipped) cleanZero = true;
            }
            dominated = cleanZero;
          }
          if (part.type === "nand") y = refNot(y);
        } else if (part.type === "or" || part.type === "nor") {
          y = refOr(xs);
          if (y === R1) {
            let cleanOne = false;
            for (let i = 0; i < xs.length; i++) {
              const r = readBit(`in${i}`);
              if (r.v === R1 && !r.skipped) cleanOne = true;
            }
            dominated = cleanOne;
          }
          if (part.type === "nor") y = refNot(y);
        } else {
          y = refXor(xs);
          if (part.type === "xnor") y = refNot(y);
        }
        drivePin("out", [y], [anySkipped && !dominated]);
        break;
      }
      case "tristate": {
        const enPinIdx = pmap.get("en");
        const enPin = enPinIdx !== undefined ? part.pins[enPinIdx] : undefined;
        const enRaw = readBit("en");
        let en: RefBit;
        if (enRaw.v === RX) en = RX;
        else en = enPin?.inverted ? refNot(enRaw.v) : enRaw.v;

        const a = readBits("in");
        const invOut = !!part.props.invertedOut;
        const y = invOut ? a.vs.map(refNot) : a.vs;
        const kOut = pmap.get("out");
        const w = kOut !== undefined ? part.pins[kOut].width : y.length;

        if (en === R1) {
          drivePin("out", y, a.skipped.map((s) => s || enRaw.skipped));
        } else if (en === R0) {
          drivePin("out", new Array<RefBit>(w).fill(RZ), new Array<boolean>(w).fill(enRaw.skipped));
        } else {
          drivePin("out", new Array<RefBit>(w).fill(RX), new Array<boolean>(w).fill(enRaw.skipped));
        }
        break;
      }
      default:
        break;
    }

    return out;
  }

  /**
   * Evaluate switch channel states against `nodeVals`:
   * returns collapsed undirected edges between distinct node pairs (a < b):
   * - state === R1: definitely ON
   * - state === RX: UNKNOWN (may or may not conduct)
   * OFF edges and self-loops (a === b) are omitted.
   */
  private evalSwitchEdges(
    nodeVals: readonly RefBit[],
    skippedIn: ReadonlySet<number>,
  ): { a: number; b: number; state: 1 | 2; skipped: boolean }[] {
    const edgeMap = new Map<string, { a: number; b: number; state: 1 | 2; skipped: boolean }>();

    for (const ch of this.channels) {
      if (ch.a === ch.b) continue;
      let anyOn = false;
      let anyUnknown = false;
      let anyGateSkipped = false;

      for (const g of ch.gates) {
        const raw = nodeVals[g.node];
        if (skippedIn.has(g.node)) anyGateSkipped = true;
        if (raw === R0 || raw === R1) {
          const eff = g.inverted ? 1 - raw : raw;
          if (eff === 1) anyOn = true;
        } else {
          anyUnknown = true;
        }
      }

      if (!anyOn && !anyUnknown) continue; // definitely OFF
      const state: 1 | 2 = anyOn ? R1 : RX;
      const a = Math.min(ch.a, ch.b);
      const b = Math.max(ch.a, ch.b);
      const key = `${a}:${b}`;
      const existing = edgeMap.get(key);
      if (!existing) {
        edgeMap.set(key, { a, b, state, skipped: anyGateSkipped });
      } else {
        // Parallel channels: ON dominates UNKNOWN
        if (state === R1) existing.state = R1;
        if (anyGateSkipped) existing.skipped = true;
      }
    }

    return [...edgeMap.values()];
  }

  /**
   * Resolve all bit nodes given current part output drives and switch edges.
   * Uses exact brute-force over unknown switch edges per independent non-supply island (when <= cap).
   */
  private resolveAll(
    drives: readonly (readonly (readonly RefBit[])[])[],
    edges: readonly { a: number; b: number; state: 1 | 2; skipped: boolean }[],
    skippedFromGates: ReadonlySet<number>,
  ): {
    values: RefBit[];
    contentionNodes: Set<number>;
    definiteContentionNodes: Set<number>;
    skippedNodes: Set<number>;
  } {
    const N = this.circuit.nodes;
    const values = new Array<RefBit>(N).fill(RZ);
    const contentionNodes = new Set<number>();
    const definiteContentionNodes = new Set<number>();
    const skippedNodes = new Set<number>(skippedFromGates);

    // Helper: direct drives on a single node
    const nodeDrives = (node: number): { v: RefBit; weak: boolean }[] =>
      this.drivers[node].map((d) => ({
        v: drives[d.part][d.pin][d.bit],
        weak: d.weak,
      }));

    // 1. Resolve every supply node strictly from its own direct drivers (ideal sources).
    const supplyDirectRes = new Map<number, { value: RefBit; contention: boolean; strongVals: RefBit[] }>();
    for (let n = 0; n < N; n++) {
      if (!this.isSupply[n]) continue;
      const ds = nodeDrives(n);
      const r = resolveDriveList(ds);
      values[n] = r.value;
      if (r.contention) {
        contentionNodes.add(n);
        definiteContentionNodes.add(n);
      }
      const strongVals = ds.filter((d) => !d.weak && d.v !== RZ).map((d) => d.v);
      supplyDirectRes.set(n, { value: r.value, contention: r.contention, strongVals });
    }

    // 2. Check direct supply-to-supply switch edges (cannot change supply values, but can short!).
    for (const e of edges) {
      if (this.isSupply[e.a] && this.isSupply[e.b]) {
        const sa = supplyDirectRes.get(e.a)!;
        const sb = supplyDirectRes.get(e.b)!;
        const combined = [...sa.strongVals, ...sb.strongVals];
        const distinct = new Set(combined).size > 1;
        if (distinct) {
          contentionNodes.add(e.a);
          contentionNodes.add(e.b);
          if (e.state === R1) {
            definiteContentionNodes.add(e.a);
            definiteContentionNodes.add(e.b);
          }
        }
        if (e.skipped) {
          skippedNodes.add(e.a);
          skippedNodes.add(e.b);
        }
      }
    }

    // 3. Partition non-supply nodes into connected islands over all non-OFF switch edges
    //    between non-supply nodes (rails do NOT connect their two sides).
    const adjNonSupply: number[][] = Array.from({ length: N }, () => []);
    const nodeEdges: { a: number; b: number; state: 1 | 2; skipped: boolean }[][] = Array.from(
      { length: N },
      () => [],
    );

    for (const e of edges) {
      if (this.isSupply[e.a] && this.isSupply[e.b]) continue;
      if (!this.isSupply[e.a] && !this.isSupply[e.b]) {
        adjNonSupply[e.a].push(e.b);
        adjNonSupply[e.b].push(e.a);
        nodeEdges[e.a].push(e);
        nodeEdges[e.b].push(e);
      } else {
        const nonSup = this.isSupply[e.a] ? e.b : e.a;
        nodeEdges[nonSup].push(e);
      }
    }

    const visited = new Uint8Array(N);
    for (let start = 0; start < N; start++) {
      if (this.isSupply[start] || visited[start]) continue;

      // BFS to collect this non-supply island
      const island: number[] = [start];
      visited[start] = 1;
      for (let i = 0; i < island.length; i++) {
        for (const nxt of adjNonSupply[island[i]]) {
          if (!visited[nxt]) {
            visited[nxt] = 1;
            island.push(nxt);
          }
        }
      }

      // Collect unique edges touching this island
      const islandEdgeSet = new Set<{ a: number; b: number; state: 1 | 2; skipped: boolean }>();
      let islandSkipped = false;
      for (const m of island) {
        if (skippedFromGates.has(m)) islandSkipped = true;
        for (const e of nodeEdges[m]) {
          islandEdgeSet.add(e);
          if (e.skipped) islandSkipped = true;
        }
      }

      const fixedOn: { a: number; b: number }[] = [];
      const unknown: { a: number; b: number }[] = [];
      for (const e of islandEdgeSet) {
        if (e.state === R1) fixedOn.push(e);
        else unknown.push(e);
      }

      if (unknown.length > this.maxUnknownSwitches) {
        // Too many unknown switches for exact brute-force: mark all island nodes skipped
        // and fall back to a conservative approximation for iteration stability.
        for (const m of island) skippedNodes.add(m);
        const allDrives: { v: RefBit; weak: boolean }[] = [];
        for (const m of island) allDrives.push(...nodeDrives(m));
        for (const e of islandEdgeSet) {
          if (this.isSupply[e.a]) allDrives.push(...nodeDrives(e.a));
          if (this.isSupply[e.b]) allDrives.push(...nodeDrives(e.b));
        }
        const approx = resolveDriveList(allDrives);
        for (const m of island) {
          values[m] = unknown.length > 0 ? RX : approx.value;
          if (approx.contention) contentionNodes.add(m);
        }
        continue;
      }

      if (islandSkipped) {
        for (const m of island) skippedNodes.add(m);
      }

      // Local index mapping for island nodes
      const localIdx = new Map<number, number>();
      island.forEach((m, idx) => localIdx.set(m, idx));
      const K = island.length;

      // Track value set and contention counts across all 2^U assignments
      const seenVal: (RefBit | -1)[] = new Array(K).fill(-1);
      const valDiffers = new Uint8Array(K);
      const anyCont = new Uint8Array(K);
      const allCont = new Uint8Array(K).fill(1);

      const U = unknown.length;
      const totalConfigs = 1 << U;
      const parent = new Int32Array(K);

      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const union = (x: number, y: number) => {
        const rx = find(x);
        const ry = find(y);
        if (rx !== ry) parent[rx] = ry;
      };

      for (let mask = 0; mask < totalConfigs; mask++) {
        for (let i = 0; i < K; i++) parent[i] = i;

        // Gather supply attachments per non-supply local node for this config
        const attachedSupplies: number[][] = Array.from({ length: K }, () => []);

        const applyEdge = (a: number, b: number) => {
          const sa = this.isSupply[a];
          const sb = this.isSupply[b];
          if (!sa && !sb) {
            union(localIdx.get(a)!, localIdx.get(b)!);
          } else if (sa && !sb) {
            attachedSupplies[localIdx.get(b)!].push(a);
          } else if (!sa && sb) {
            attachedSupplies[localIdx.get(a)!].push(b);
          }
        };

        for (const e of fixedOn) applyEdge(e.a, e.b);
        for (let bit = 0; bit < U; bit++) {
          if ((mask >> bit) & 1) applyEdge(unknown[bit].a, unknown[bit].b);
        }

        // Group island nodes by union-find root
        const groups = new Map<number, number[]>();
        for (let i = 0; i < K; i++) {
          const r = find(i);
          let g = groups.get(r);
          if (!g) {
            g = [];
            groups.set(r, g);
          }
          g.push(i);
        }

        // Resolve each connected group
        for (const members of groups.values()) {
          const pool: { v: RefBit; weak: boolean }[] = [];
          const seenSup = new Set<number>();
          for (const idx of members) {
            pool.push(...nodeDrives(island[idx]));
            for (const sup of attachedSupplies[idx]) {
              if (!seenSup.has(sup)) {
                seenSup.add(sup);
                pool.push(...nodeDrives(sup));
              }
            }
          }
          const res = resolveDriveList(pool);
          for (const idx of members) {
            if (seenVal[idx] === -1) seenVal[idx] = res.value;
            else if (seenVal[idx] !== res.value) valDiffers[idx] = 1;
            if (res.contention) anyCont[idx] = 1;
            else allCont[idx] = 0;
          }
        }
      }

      for (let i = 0; i < K; i++) {
        const node = island[i];
        values[node] = valDiffers[i] ? RX : (seenVal[i] as RefBit);
        if (anyCont[i]) contentionNodes.add(node);
        if (allCont[i]) definiteContentionNodes.add(node);
      }
    }

    return { values, contentionNodes, definiteContentionNodes, skippedNodes };
  }

  /**
   * Run fixed-point evaluation: repeat "evaluate every gate, resolve every net" until nothing changes.
   */
  settle(): RefSettleResult {
    const N = this.circuit.nodes;
    let curVals = new Array<RefBit>(N).fill(RZ);
    let curSkipped = new Set<number>();
    let lastContention = new Set<number>();
    let lastDefContention = new Set<number>();

    let converged = false;
    let iterations = 0;

    for (let iter = 1; iter <= this.maxIterations; iter++) {
      iterations = iter;
      const nextSkippedFromGates = new Set<number>();
      const drives: RefBit[][][] = this.circuit.parts.map((part, pi) =>
        this.evalPart(part, pi, curVals, curSkipped, nextSkippedFromGates),
      );
      const edges = this.evalSwitchEdges(curVals, curSkipped);
      const res = this.resolveAll(drives, edges, nextSkippedFromGates);

      let same = true;
      for (let n = 0; n < N; n++) {
        if (res.values[n] !== curVals[n]) {
          same = false;
          break;
        }
      }
      if (same && res.skippedNodes.size === curSkipped.size) {
        for (const s of res.skippedNodes) {
          if (!curSkipped.has(s)) {
            same = false;
            break;
          }
        }
      } else if (same) {
        same = false;
      }

      curVals = res.values;
      curSkipped = res.skippedNodes;
      lastContention = res.contentionNodes;
      lastDefContention = res.definiteContentionNodes;

      if (same && iter >= 2) {
        converged = true;
        break;
      }
    }

    this.values = curVals;
    const floatingNodes = new Set<number>();
    for (let n = 0; n < N; n++) {
      if (curVals[n] === RZ && this.hasReader[n]) {
        floatingNodes.add(n);
      }
    }

    return {
      converged,
      iterations,
      values: curVals.slice(),
      contentionNodes: lastContention,
      definiteContentionNodes: lastDefContention,
      floatingNodes,
      skippedNodes: curSkipped,
    };
  }
}

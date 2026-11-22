/**
 * Seeded circuit generators and independent 3-valued / BigInt reference evaluators
 * for combinational and performance stress tests.
 *
 * Intentionally does NOT import any simulation/evaluation logic from `src/logic/`
 * so all expected values are computed independently.
 */
import type { PropValue, SchematicDocument } from "../../src/model/types";

/** 3-valued logic bit used by independent reference evaluators: 0, 1, or 2 (X). */
export type RefBit = 0 | 1 | 2;
export const R0: RefBit = 0;
export const R1: RefBit = 1;
export const RX: RefBit = 2;

export type PartSpec = [id: string, type: string, props?: Record<string, PropValue>];

/** Deterministic Mulberry32 PRNG (never uses Math.random). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next unsigned 32-bit integer. */
  u32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.u32() / 0x100000000;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + (this.u32() % (max - min + 1));
  }

  bool(prob = 0.5): boolean {
    return this.next() < prob;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.u32() % arr.length];
  }

  /** Random unsigned BigInt of `width` bits (1..64). */
  bigBits(width: number): bigint {
    let out = 0n;
    let rem = width;
    let shift = 0n;
    while (rem > 0) {
      const chunk = Math.min(rem, 32);
      const mask = (1n << BigInt(chunk)) - 1n;
      out |= (BigInt(this.u32()) & mask) << shift;
      rem -= chunk;
      shift += BigInt(chunk);
    }
    return out;
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.u32() % (i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}

/** Build a SchematicDocument with stored pin-to-pin links (same convention as `mk` in logic.sim.test.ts). */
export function mkDoc(parts: readonly PartSpec[], nets: readonly (readonly string[])[], name = "stress"): SchematicDocument {
  const links: [string, string][] = [];
  for (const net of nets) {
    if (net.length < 2) continue;
    const ts = net.map((r) => {
      const i = r.lastIndexOf(".");
      return `p:${r.slice(0, i)}|${r.slice(i + 1)}`;
    });
    for (let i = 1; i < ts.length; i++) links.push([ts[0], ts[i]]);
  }
  return {
    format: "digischem",
    version: 1,
    name,
    grid: 10,
    components: parts.map(([id, type, props], i) => ({
      id,
      type,
      x: (i % 16) * 200,
      y: Math.floor(i / 16) * 200,
      rotation: 0,
      props: props ?? {},
      label: "",
    })),
    wires: [],
    texts: [],
    links,
  };
}

/** Independent BigInt conversion from LSB-first bit array; null if any bit is X/Z (>1). */
export function bitsToBigInt(bits: readonly number[]): bigint | null {
  let v = 0n;
  for (let i = bits.length - 1; i >= 0; i--) {
    if (bits[i] !== 0 && bits[i] !== 1) return null;
    v = (v << 1n) | BigInt(bits[i]);
  }
  return v;
}

/** Independent LSB-first bit array of length `width` from a BigInt (unsigned modulo 2^width). */
export function bigIntToBits(v: bigint, width: number): (0 | 1)[] {
  let x = BigInt.asUintN(width, v);
  const out: (0 | 1)[] = [];
  for (let i = 0; i < width; i++) {
    out.push(Number(x & 1n) as 0 | 1);
    x >>= 1n;
  }
  return out;
}

/** Independent splitter slice rule matching `io.ts` computeSlices. */
export function refSplitterSlices(width: number, fanOut: number): { lo: number; width: number }[] {
  const n = Math.min(Math.max(2, Math.min(32, fanOut)), width);
  if (n >= width) {
    return Array.from({ length: width }, (_, i) => ({ lo: i, width: 1 }));
  }
  const base = Math.floor(width / n);
  const rem = width % n;
  const out: { lo: number; width: number }[] = [];
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const w = base + (i < rem ? 1 : 0);
    out.push({ lo, width: w });
    lo += w;
  }
  return out;
}

/** Boundary values for an N-bit integer (unsigned + two's complement sign boundaries). */
export function boundaryValues(width: number): bigint[] {
  const mask = (1n << BigInt(width)) - 1n;
  const signBit = 1n << BigInt(width - 1);
  const vals = new Set<bigint>([
    0n,
    1n & mask,
    mask,
    signBit & mask,
    (signBit - 1n) & mask,
    (signBit + 1n) & mask,
    (mask - 1n) & mask,
    0x55555555n & mask,
    0xaaaaaaaan & mask,
  ]);
  return [...vals];
}

// ---- Independent 3-valued logic primitives ----

export function refNot(a: RefBit): RefBit {
  return a === RX ? RX : ((1 - a) as RefBit);
}

export function refAnd(xs: readonly RefBit[]): RefBit {
  if (xs.includes(R0)) return R0;
  if (xs.every((x) => x === R1)) return R1;
  return RX;
}

export function refOr(xs: readonly RefBit[]): RefBit {
  if (xs.includes(R1)) return R1;
  if (xs.every((x) => x === R0)) return R0;
  return RX;
}

export function refXor(xs: readonly RefBit[]): RefBit {
  let acc = 0;
  for (const x of xs) {
    if (x === RX) return RX;
    acc ^= x;
  }
  return acc as RefBit;
}

export function refCandidates(sel: readonly RefBit[]): number[] {
  let cands = [0];
  for (let i = 0; i < sel.length; i++) {
    const b = sel[i];
    if (b === R1) cands = cands.map((v) => v | (1 << i));
    else if (b === RX) cands = cands.flatMap((v) => [v, v | (1 << i)]);
  }
  return cands;
}

export function refMerge(options: readonly (readonly RefBit[])[]): RefBit[] {
  const w = options[0]?.length ?? 0;
  const out: RefBit[] = [];
  for (let b = 0; b < w; b++) {
    const first = options[0][b];
    let same = true;
    for (let k = 1; k < options.length; k++) {
      if (options[k][b] !== first) {
        same = false;
        break;
      }
    }
    out.push(same ? first : RX);
  }
  return out;
}

// ---- Random Combinational DAG Generator ----

export interface CombDagOptions {
  seed: number;
  gateCount: number;
  inputCount?: number;
  outputCount?: number;
  /** When true, emit only compact 1-bit gates (for 5,000-gate performance DAGs). */
  fastGatesOnly?: boolean;
  /** Include `encoder` parts (default true; set false for 3-valued X-DAG stress tests to avoid BUG-COMB-1). */
  includeEncoder?: boolean;
}

export interface GeneratedCombDag {
  doc: SchematicDocument;
  inputIds: string[];
  outputIds: string[];
  partTypesUsed: Set<string>;
  /** Independent reference evaluator mapping 1-bit input values (0|1|2) to 1-bit output values (0|1|2). */
  evaluateRef: (inputs: Readonly<Record<string, RefBit>>) => Record<string, RefBit>;
}

type RefEvalOp = (vals: RefBit[]) => void;

export function generateRandomCombDag(opts: CombDagOptions): GeneratedCombDag {
  const rng = new Rng(opts.seed);
  const inputCount = opts.inputCount ?? Math.min(16, Math.max(6, Math.floor(opts.gateCount / 10)));
  const outputCount = opts.outputCount ?? Math.min(24, Math.max(6, Math.floor(opts.gateCount / 8)));
  const fastOnly = !!opts.fastGatesOnly;
  const includeEncoder = opts.includeEncoder !== false;

  const parts: PartSpec[] = [];
  const nets: string[][] = [];
  const ops: RefEvalOp[] = [];
  const partTypesUsed = new Set<string>();

  // Each 1-bit signal has a signal index -> net index in `nets`
  const bitNet: number[] = [];
  const newBitSig = (driverPin: string): number => {
    const netIdx = nets.length;
    nets.push([driverPin]);
    const sig = bitNet.length;
    bitNet.push(netIdx);
    return sig;
  };
  const tapBit = (sig: number, pinRef: string): void => {
    nets[bitNet[sig]].push(pinRef);
  };

  // Multi-bit bus pool: width -> list of { netIdx, sigs: number[] }
  const busPool = new Map<number, { netIdx: number; sigs: number[] }[]>();
  const registerBus = (width: number, netIdx: number, sigs: number[]): void => {
    let list = busPool.get(width);
    if (!list) {
      list = [];
      busPool.set(width, list);
    }
    list.push({ netIdx, sigs });
  };

  let splSeq = 0;
  const getBusInput = (width: number, pinRef: string, pickSig: () => number): number[] => {
    if (width === 1) {
      const s = pickSig();
      tapBit(s, pinRef);
      return [s];
    }
    const existing = busPool.get(width);
    if (existing && existing.length > 0 && rng.bool(0.35)) {
      const chosen = rng.pick(existing);
      nets[chosen.netIdx].push(pinRef);
      return chosen.sigs;
    }
    // Build a width-bit bus from width 1-bit signals via a splitter
    const spId = `SP_M${splSeq++}`;
    parts.push([spId, "splitter", { width, fanOut: width }]);
    partTypesUsed.add("splitter");
    const sigs: number[] = [];
    for (let b = 0; b < width; b++) {
      const s = pickSig();
      sigs.push(s);
      tapBit(s, `${spId}.b${b}`);
    }
    const busNetIdx = nets.length;
    nets.push([`${spId}.bus`, pinRef]);
    registerBus(width, busNetIdx, sigs);
    return sigs;
  };

  const splitBusOutput = (width: number, driverPin: string, evalBits: (vals: RefBit[], outSigs: number[]) => void): number[] => {
    if (width === 1) {
      const s = newBitSig(driverPin);
      ops.push((vals) => evalBits(vals, [s]));
      return [s];
    }
    const spId = `SP_S${splSeq++}`;
    parts.push([spId, "splitter", { width, fanOut: width }]);
    partTypesUsed.add("splitter");
    const busNetIdx = nets.length;
    nets.push([driverPin, `${spId}.bus`]);
    const outSigs: number[] = [];
    for (let b = 0; b < width; b++) {
      outSigs.push(newBitSig(`${spId}.b${b}`));
    }
    registerBus(width, busNetIdx, outSigs);
    ops.push((vals) => evalBits(vals, outSigs));
    return outSigs;
  };

  // Primary inputs
  const inputIds: string[] = [];
  const inputSigs: number[] = [];
  for (let i = 0; i < inputCount; i++) {
    const id = `IN${i}`;
    inputIds.push(id);
    parts.push([id, "input-pin", { name: id, width: 1 }]);
    inputSigs.push(newBitSig(`${id}.out`));
  }

  // Track which primary inputs haven't been consumed yet so none are unused
  let nextUnusedInput = 0;
  const pickSignal = (maxSig: number): number => {
    if (nextUnusedInput < inputCount) {
      return inputSigs[nextUnusedInput++];
    }
    // Bias slightly toward recent signals to create interesting depth while keeping depth bounded
    if (maxSig > 12 && rng.bool(0.5)) {
      const window = Math.min(maxSig, 64);
      return maxSig - 1 - rng.int(0, window - 1);
    }
    return rng.int(0, maxSig - 1);
  };

  // Build weighted component schedule
  const basicKinds = [
    "and", "nand", "or", "nor", "xor", "xnor",
    "not", "buf", "schmitt-buffer", "schmitt-inverter",
    "aoi21", "aoi22", "oai21", "oai22",
    "half-adder", "full-adder", "parity",
  ] as const;

  const fullKinds = [
    ...basicKinds,
    "mux", "demux", "decoder",
    ...(includeEncoder ? (["encoder"] as const) : []),
    "bit-selector",
    "constant", "vcc", "ground",
  ] as const;

  // For full DAGs with >= 30 gates, seed the first few slots with every family so small/medium DAGs get broad coverage
  const seededQueue: string[] = fastOnly
    ? []
    : rng.shuffle([
        "and", "nand", "or", "nor", "xor", "xnor",
        "not", "buf", "schmitt-buffer", "schmitt-inverter",
        "aoi21", "aoi22", "oai21", "oai22",
        "mux", "demux", "decoder",
        ...(includeEncoder ? ["encoder"] : []),
        "bit-selector", "half-adder", "full-adder", "parity",
        "constant", "vcc", "ground",
      ]);

  for (let g = 0; g < opts.gateCount; g++) {
    const curSigCount = bitNet.length;
    const pick = () => pickSignal(curSigCount);
    const id = `G${g}`;
    const kind = g < seededQueue.length ? seededQueue[g] : fastOnly ? rng.pick(basicKinds) : rng.pick(fullKinds);

    if (kind === "and" || kind === "nand" || kind === "or" || kind === "nor" || kind === "xor" || kind === "xnor") {
      const nIn = rng.int(2, 6);
      parts.push([id, kind, { inputs: nIn }]);
      partTypesUsed.add(kind);
      const inSigs: number[] = [];
      for (let i = 0; i < nIn; i++) {
        const s = pick();
        inSigs.push(s);
        tapBit(s, `${id}.in${i}`);
      }
      const outSig = newBitSig(`${id}.out`);
      ops.push((vals) => {
        const xs = inSigs.map((s) => vals[s]);
        if (kind === "and") vals[outSig] = refAnd(xs);
        else if (kind === "nand") vals[outSig] = refNot(refAnd(xs));
        else if (kind === "or") vals[outSig] = refOr(xs);
        else if (kind === "nor") vals[outSig] = refNot(refOr(xs));
        else if (kind === "xor") vals[outSig] = refXor(xs);
        else vals[outSig] = refNot(refXor(xs));
      });
    } else if (kind === "not" || kind === "buf" || kind === "schmitt-buffer" || kind === "schmitt-inverter") {
      parts.push([id, kind]);
      partTypesUsed.add(kind);
      const inSig = pick();
      tapBit(inSig, `${id}.in0`);
      const outSig = newBitSig(`${id}.out`);
      const inv = kind === "not" || kind === "schmitt-inverter";
      ops.push((vals) => {
        vals[outSig] = inv ? refNot(vals[inSig]) : vals[inSig];
      });
    } else if (kind === "aoi21" || kind === "aoi22" || kind === "oai21" || kind === "oai22") {
      parts.push([id, "aoi", { kind }]);
      partTypesUsed.add(`aoi:${kind}`);
      const hasD = kind === "aoi22" || kind === "oai22";
      const sa = pick(), sb = pick(), sc = pick();
      tapBit(sa, `${id}.a`);
      tapBit(sb, `${id}.b`);
      tapBit(sc, `${id}.c`);
      let sd = -1;
      if (hasD) {
        sd = pick();
        tapBit(sd, `${id}.d`);
      }
      const outSig = newBitSig(`${id}.y`);
      ops.push((vals) => {
        const a = vals[sa], b = vals[sb], c = vals[sc];
        if (kind === "aoi21") vals[outSig] = refNot(refOr([refAnd([a, b]), c]));
        else if (kind === "aoi22") vals[outSig] = refNot(refOr([refAnd([a, b]), refAnd([c, vals[sd]])]));
        else if (kind === "oai21") vals[outSig] = refNot(refAnd([refOr([a, b]), c]));
        else vals[outSig] = refNot(refAnd([refOr([a, b]), refOr([c, vals[sd]])]));
      });
    } else if (kind === "half-adder") {
      parts.push([id, "half-adder"]);
      partTypesUsed.add("half-adder");
      const sa = pick(), sb = pick();
      tapBit(sa, `${id}.a`);
      tapBit(sb, `${id}.b`);
      const sOut = newBitSig(`${id}.s`);
      const cOut = newBitSig(`${id}.cout`);
      ops.push((vals) => {
        const a = vals[sa], b = vals[sb];
        vals[sOut] = refXor([a, b]);
        vals[cOut] = refAnd([a, b]);
      });
    } else if (kind === "full-adder") {
      parts.push([id, "full-adder"]);
      partTypesUsed.add("full-adder");
      const sa = pick(), sb = pick(), sci = pick();
      tapBit(sa, `${id}.a`);
      tapBit(sb, `${id}.b`);
      tapBit(sci, `${id}.cin`);
      const sOut = newBitSig(`${id}.s`);
      const cOut = newBitSig(`${id}.cout`);
      ops.push((vals) => {
        const a = vals[sa], b = vals[sb], ci = vals[sci];
        vals[sOut] = refXor([a, b, ci]);
        vals[cOut] = refOr([refAnd([a, b]), refAnd([a, ci]), refAnd([b, ci])]);
      });
    } else if (kind === "parity") {
      const nIn = rng.int(2, 6);
      parts.push([id, "parity", { inputs: nIn }]);
      partTypesUsed.add("parity");
      const inSigs: number[] = [];
      for (let i = 0; i < nIn; i++) {
        const s = pick();
        inSigs.push(s);
        tapBit(s, `${id}.in${i}`);
      }
      const oddSig = newBitSig(`${id}.odd`);
      const evenSig = newBitSig(`${id}.even`);
      ops.push((vals) => {
        const odd = refXor(inSigs.map((s) => vals[s]));
        vals[oddSig] = odd;
        vals[evenSig] = refNot(odd);
      });
    } else if (kind === "mux") {
      const selectBits = rng.int(1, 3);
      const dataWidth = rng.pick([1, 1, 2, 4]);
      const enable = rng.bool(0.5);
      const selectMode = rng.bool(0.5) ? "bus" : "bits";
      parts.push([id, "mux", { selectBits, dataWidth, enable, selectMode }]);
      partTypesUsed.add(`mux:sb=${selectBits}:dw=${dataWidth > 1 ? "multi" : "1"}:en=${enable}:${selectMode}`);
      const numCh = 1 << selectBits;
      const dataSigs: number[][] = [];
      for (let ch = 0; ch < numCh; ch++) {
        dataSigs.push(getBusInput(dataWidth, `${id}.d${ch}`, pick));
      }
      let selSigs: number[];
      if (selectMode === "bus") {
        selSigs = getBusInput(selectBits, `${id}.s`, pick);
      } else {
        selSigs = [];
        for (let b = 0; b < selectBits; b++) {
          const s = pick();
          selSigs.push(s);
          tapBit(s, `${id}.s${b}`);
        }
      }
      let enSig = -1;
      if (enable) {
        enSig = pick();
        tapBit(enSig, `${id}.en`);
      }
      splitBusOutput(dataWidth, `${id}.y`, (vals, outSigs) => {
        const en: RefBit = enSig >= 0 ? vals[enSig] : R1;
        const cands = refCandidates(selSigs.map((s) => vals[s]));
        const optsBits = cands.map((ch) => dataSigs[ch].map((s) => vals[s]));
        const merged = refMerge(optsBits);
        for (let b = 0; b < dataWidth; b++) {
          if (en === R1) vals[outSigs[b]] = merged[b];
          else if (en === R0) vals[outSigs[b]] = R0;
          else vals[outSigs[b]] = merged[b] === R0 ? R0 : RX;
        }
      });
    } else if (kind === "demux") {
      const selectBits = rng.int(1, 3);
      const dataWidth = rng.pick([1, 1, 2, 4]);
      const enable = rng.bool(0.5);
      const selectMode = rng.bool(0.5) ? "bus" : "bits";
      parts.push([id, "demux", { selectBits, dataWidth, enable, selectMode }]);
      partTypesUsed.add(`demux:sb=${selectBits}:dw=${dataWidth > 1 ? "multi" : "1"}:en=${enable}:${selectMode}`);
      const dSigs = getBusInput(dataWidth, `${id}.d`, pick);
      let selSigs: number[];
      if (selectMode === "bus") {
        selSigs = getBusInput(selectBits, `${id}.s`, pick);
      } else {
        selSigs = [];
        for (let b = 0; b < selectBits; b++) {
          const s = pick();
          selSigs.push(s);
          tapBit(s, `${id}.s${b}`);
        }
      }
      let enSig = -1;
      if (enable) {
        enSig = pick();
        tapBit(enSig, `${id}.en`);
      }
      const numCh = 1 << selectBits;
      const chOutSigs: number[][] = [];
      for (let ch = 0; ch < numCh; ch++) {
        // Wire each output channel through a splitter if dataWidth > 1
        if (dataWidth === 1) {
          chOutSigs.push([newBitSig(`${id}.y${ch}`)]);
        } else {
          const spId = `SP_DM${splSeq++}`;
          parts.push([spId, "splitter", { width: dataWidth, fanOut: dataWidth }]);
          partTypesUsed.add("splitter");
          const busNetIdx = nets.length;
          nets.push([`${id}.y${ch}`, `${spId}.bus`]);
          const sigs: number[] = [];
          for (let b = 0; b < dataWidth; b++) sigs.push(newBitSig(`${spId}.b${b}`));
          registerBus(dataWidth, busNetIdx, sigs);
          chOutSigs.push(sigs);
        }
      }
      ops.push((vals) => {
        const en: RefBit = enSig >= 0 ? vals[enSig] : R1;
        const cands = refCandidates(selSigs.map((s) => vals[s]));
        const dBits = dSigs.map((s) => vals[s]);
        for (let ch = 0; ch < numCh; ch++) {
          const hit = cands.includes(ch);
          const selBit: RefBit = hit ? (cands.length === 1 ? R1 : RX) : R0;
          for (let b = 0; b < dataWidth; b++) {
            vals[chOutSigs[ch][b]] = refAnd([dBits[b], en, selBit]);
          }
        }
      });
    } else if (kind === "decoder") {
      const inputs = rng.int(1, 3);
      const enable = rng.bool(0.5);
      const activeLowOutputs = rng.bool(0.5);
      parts.push([id, "decoder", { inputs, enable, activeLowOutputs }]);
      partTypesUsed.add(`decoder:en=${enable}:low=${activeLowOutputs}`);
      const aSigs: number[] = [];
      for (let i = 0; i < inputs; i++) {
        const s = pick();
        aSigs.push(s);
        tapBit(s, `${id}.a${i}`);
      }
      let enSig = -1;
      if (enable) {
        enSig = pick();
        tapBit(enSig, `${id}.en`);
      }
      const numOut = 1 << inputs;
      const outSigs: number[] = [];
      for (let i = 0; i < numOut; i++) outSigs.push(newBitSig(`${id}.y${i}`));
      ops.push((vals) => {
        const en: RefBit = enSig >= 0 ? vals[enSig] : R1;
        const cands = refCandidates(aSigs.map((s) => vals[s]));
        for (let i = 0; i < numOut; i++) {
          const hit: RefBit = cands.includes(i) ? (cands.length === 1 ? R1 : RX) : R0;
          const v = refAnd([hit, en]);
          vals[outSigs[i]] = activeLowOutputs ? refNot(v) : v;
        }
      });
    } else if (kind === "encoder") {
      const outputBits = rng.int(1, 3);
      const priority = rng.bool(0.5);
      const validOut = rng.bool(0.5);
      const enable = rng.bool(0.5);
      parts.push([id, "encoder", { outputBits, priority, validOut, enable }]);
      partTypesUsed.add(`encoder:pri=${priority}:v=${validOut}:en=${enable}`);
      const numIn = 1 << outputBits;
      const dSigs: number[] = [];
      for (let i = 0; i < numIn; i++) {
        const s = pick();
        dSigs.push(s);
        tapBit(s, `${id}.d${i}`);
      }
      let enSig = -1;
      if (enable) {
        enSig = pick();
        tapBit(enSig, `${id}.en`);
      }
      const ySigs: number[] = [];
      for (let i = 0; i < outputBits; i++) ySigs.push(newBitSig(`${id}.y${i}`));
      const vSig = validOut ? newBitSig(`${id}.v`) : -1;
      ops.push((vals) => {
        const en: RefBit = enSig >= 0 ? vals[enSig] : R1;
        const dBits = dSigs.map((s) => vals[s]);
        if (en === R0) {
          for (const ys of ySigs) vals[ys] = R0;
          if (vSig >= 0) vals[vSig] = R0;
          return;
        }
        if (en === RX || dBits.includes(RX)) {
          for (const ys of ySigs) vals[ys] = RX;
          if (vSig >= 0) vals[vSig] = en === RX ? RX : refOr(dBits);
          return;
        }
        let code = 0;
        if (priority) {
          for (let i = numIn - 1; i >= 0; i--) {
            if (dBits[i] === R1) {
              code = i;
              break;
            }
          }
        } else {
          for (let i = 0; i < numIn; i++) {
            if (dBits[i] === R1) code |= i;
          }
        }
        for (let b = 0; b < outputBits; b++) vals[ySigs[b]] = ((code >> b) & 1) as RefBit;
        if (vSig >= 0) vals[vSig] = dBits.includes(R1) ? R1 : R0;
      });
    } else if (kind === "bit-selector") {
      const width = rng.pick([2, 4, 8]);
      const selW = width === 2 ? 1 : width === 4 ? 2 : 3;
      parts.push([id, "bit-selector", { width }]);
      partTypesUsed.add("bit-selector");
      const dSigs = getBusInput(width, `${id}.d`, pick);
      const sSigs = getBusInput(selW, `${id}.s`, pick);
      const outSig = newBitSig(`${id}.y`);
      ops.push((vals) => {
        const cands = refCandidates(sSigs.map((s) => vals[s]));
        const optsBits = cands.map((idx) => [idx < dSigs.length ? vals[dSigs[idx]] : RX]);
        vals[outSig] = refMerge(optsBits)[0];
      });
    } else if (kind === "constant") {
      const valBit: RefBit = rng.bool(0.5) ? R1 : R0;
      parts.push([id, "constant", { value: String(valBit), width: 1 }]);
      partTypesUsed.add("constant");
      const outSig = newBitSig(`${id}.out`);
      ops.push((vals) => {
        vals[outSig] = valBit;
      });
    } else if (kind === "vcc") {
      parts.push([id, "vcc"]);
      partTypesUsed.add("vcc");
      const outSig = newBitSig(`${id}.vcc`);
      ops.push((vals) => {
        vals[outSig] = R1;
      });
    } else {
      // ground
      parts.push([id, "ground"]);
      partTypesUsed.add("ground");
      const outSig = newBitSig(`${id}.gnd`);
      ops.push((vals) => {
        vals[outSig] = R0;
      });
    }
  }

  // Ensure any remaining unconsumed primary inputs are tapped by a buffer so no input is unused
  while (nextUnusedInput < inputCount) {
    const s = inputSigs[nextUnusedInput++];
    const id = `BUF_IN${s}`;
    parts.push([id, "buf"]);
    tapBit(s, `${id}.in0`);
    const outSig = newBitSig(`${id}.out`);
    ops.push((vals) => {
      vals[outSig] = vals[s];
    });
  }

  // Attach output-pins to distinct random internal signals (preferring later signals for deeper cones)
  const totalSigs = bitNet.length;
  const candidateSigs: number[] = [];
  for (let s = inputCount; s < totalSigs; s++) candidateSigs.push(s);
  const pickedOutSigs = rng.shuffle(candidateSigs).slice(0, Math.min(outputCount, candidateSigs.length));
  // Always include the very last signal so the deepest tail is observed
  if (candidateSigs.length > 0 && !pickedOutSigs.includes(totalSigs - 1)) {
    pickedOutSigs[0] = totalSigs - 1;
  }

  const outputIds: string[] = [];
  pickedOutSigs.forEach((sig, k) => {
    const oid = `OUT${k}`;
    outputIds.push(oid);
    parts.push([oid, "output-pin", { name: oid, width: 1 }]);
    tapBit(sig, `${oid}.in`);
  });

  const doc = mkDoc(parts, nets, `dag_${opts.seed}_${opts.gateCount}`);

  const evaluateRef = (inputs: Readonly<Record<string, RefBit>>): Record<string, RefBit> => {
    const vals = new Array<RefBit>(totalSigs).fill(R0);
    for (let i = 0; i < inputCount; i++) {
      const v = inputs[inputIds[i]];
      vals[inputSigs[i]] = v === undefined ? R0 : v;
    }
    for (const op of ops) op(vals);
    const res: Record<string, RefBit> = {};
    pickedOutSigs.forEach((sig, k) => {
      res[outputIds[k]] = vals[sig];
    });
    return res;
  };

  return { doc, inputIds, outputIds, partTypesUsed, evaluateRef };
}

// ---- Ripple-Carry Adder Builder ----

/** Build an N-bit ripple-carry adder from N `full-adder` parts, bus splitters, and bus I/O pins. */
export function buildRippleCarryAdder(bits: number): SchematicDocument {
  const parts: PartSpec[] = [
    ["A", "input-pin", { name: "A", width: bits }],
    ["B", "input-pin", { name: "B", width: bits }],
    ["CIN", "input-pin", { name: "CIN", width: 1 }],
    ["SPA", "splitter", { width: bits, fanOut: bits }],
    ["SPB", "splitter", { width: bits, fanOut: bits }],
    ["SPS", "splitter", { width: bits, fanOut: bits }],
    ["S", "output-pin", { name: "S", width: bits }],
    ["COUT", "output-pin", { name: "COUT", width: 1 }],
  ];
  const nets: string[][] = [
    ["A.out", "SPA.bus"],
    ["B.out", "SPB.bus"],
    ["SPS.bus", "S.in"],
  ];

  for (let i = 0; i < bits; i++) {
    parts.push([`FA${i}`, "full-adder"]);
    nets.push([`SPA.b${i}`, `FA${i}.a`]);
    nets.push([`SPB.b${i}`, `FA${i}.b`]);
    nets.push([`FA${i}.s`, `SPS.b${i}`]);
    if (i === 0) nets.push(["CIN.out", `FA0.cin`]);
    else nets.push([`FA${i - 1}.cout`, `FA${i}.cin`]);
  }
  nets.push([`FA${bits - 1}.cout`, "COUT.in"]);

  return mkDoc(parts, nets, `rca_${bits}`);
}

// ---- Bus Plumbing (Splitters + Tunnels) Generator ----

export interface BusPlumbingCircuit {
  doc: SchematicDocument;
  width: number;
  /** perm[outBit] = inBit index from the input bus */
  perm: number[];
  /** Independent reference mapping an input BigInt to the expected permuted output BigInt. */
  evalRef: (input: bigint) => bigint;
}

/**
 * Generates a seeded multi-stage splitter + tunnel permutation network for a `width`-bit bus:
 * Input bus -> recursive splitter tree down to 1-bit signals -> tunnel per bit ->
 * seeded bit permutation -> recursive merger tree -> bus tunnel -> output bus.
 */
export function generateBusPlumbingCircuit(seed: number, width: number): BusPlumbingCircuit {
  const rng = new Rng(seed);
  const parts: PartSpec[] = [
    ["IN", "input-pin", { name: "IN", width }],
    ["OUT", "output-pin", { name: "OUT", width }],
  ];
  const nets: string[][] = [];
  let seq = 0;

  // Tunnel bridge helper: connects `srcPin` to `dstPin` via two matching tunnels
  const tunnelConnect = (srcPin: string, dstPin: string, tWidth: number, label: string): void => {
    const t1 = `T_${label}_A_${seq++}`;
    const t2 = `T_${label}_B_${seq++}`;
    const name = `TN_${label}_${seq}`;
    parts.push([t1, "tunnel", { name, width: tWidth }]);
    parts.push([t2, "tunnel", { name, width: tWidth }]);
    nets.push([srcPin, `${t1}.net`]);
    nets.push([`${t2}.net`, dstPin]);
  };

  // Recursively split a bus pin down to individual 1-bit pin endpoints (in LSB..MSB order)
  const leafPins: string[] = new Array<string>(width);
  const splitRec = (srcPin: string, lo: number, w: number): void => {
    if (w === 1) {
      leafPins[lo] = srcPin;
      return;
    }
    const fanOut = rng.int(2, Math.min(w, 6));
    const spId = `SPD${seq++}`;
    parts.push([spId, "splitter", { width: w, fanOut }]);
    if (rng.bool(0.5)) tunnelConnect(srcPin, `${spId}.bus`, w, `sp${lo}`);
    else nets.push([srcPin, `${spId}.bus`]);
    const slices = refSplitterSlices(w, fanOut);
    slices.forEach((sl, idx) => {
      splitRec(`${spId}.b${idx}`, lo + sl.lo, sl.width);
    });
  };
  splitRec("IN.out", 0, width);

  // Permute the bit order deterministically
  const perm = rng.shuffle(Array.from({ length: width }, (_, i) => i));
  const permutedPins = perm.map((srcIdx) => leafPins[srcIdx]);

  // Recursively merge the permuted 1-bit pins back into a `width`-bit bus
  const mergeRec = (pins: readonly string[], tag: number): string => {
    const w = pins.length;
    if (w === 1) return pins[0];
    const fanOut = rng.int(2, Math.min(w, 6));
    const spId = `SPM${seq++}`;
    parts.push([spId, "splitter", { width: w, fanOut }]);
    const slices = refSplitterSlices(w, fanOut);
    slices.forEach((sl, idx) => {
      const subPins = pins.slice(sl.lo, sl.lo + sl.width);
      const subSrc = mergeRec(subPins, tag * 13 + idx);
      if (rng.bool(0.5)) tunnelConnect(subSrc, `${spId}.b${idx}`, sl.width, `mg${tag}_${idx}`);
      else nets.push([subSrc, `${spId}.b${idx}`]);
    });
    return `${spId}.bus`;
  };
  const mergedBusPin = mergeRec(permutedPins, 1);
  tunnelConnect(mergedBusPin, "OUT.in", width, "final");

  const doc = mkDoc(parts, nets, `plumb_${seed}_${width}`);
  const evalRef = (input: bigint): bigint => {
    let out = 0n;
    for (let b = 0; b < width; b++) {
      const bit = (input >> BigInt(perm[b])) & 1n;
      out |= bit << BigInt(b);
    }
    return out;
  };

  return { doc, width, perm, evalRef };
}

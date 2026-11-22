/**
 * Differential and end-to-end fuzzing of the DigiSchem logic simulator:
 *  1. Sequential differential fuzzing (seeded random synchronous circuits vs independent
 *     cycle-based reference simulator, across hundreds of seeds and 50..200 cycles).
 *  2. End-to-end fuzzing through DSpec (`compileSpec` -> `extractCircuit` -> `Simulator`,
 *     compared with an independent reference evaluator and `circuitText` re-compile round-trip).
 *  3. Timing semantics (pipelines, gated clocks, ripple stages, same-`settle()` input+clock changes).
 */
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import type { SchematicDocument } from "../src/model/types";
import { circuitText, extractCircuit, structuralKey } from "../src/logic/circuit";
import { Simulator } from "../src/logic/simulate";
import { compileSpec } from "../src/spec/compile";
import {
  Rng,
  mkDoc,
  type PartSpec,
} from "./helpers/sim-gen";

registerBuiltinComponents();

// ============================================================================
// Independent 2-valued bit helpers (no imports from src/logic/models*)
// ============================================================================

type Bin = 0 | 1;

const bNot = (a: Bin): Bin => (a === 1 ? 0 : 1);
const bAnd = (xs: readonly Bin[]): Bin => (xs.every((x) => x === 1) ? 1 : 0);
const bOr = (xs: readonly Bin[]): Bin => (xs.some((x) => x === 1) ? 1 : 0);
const bXor = (xs: readonly Bin[]): Bin => {
  let v = 0;
  for (const x of xs) v ^= x;
  return v as Bin;
};

function binBitsToNum(bits: readonly Bin[]): number {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) v = v * 2 + bits[i];
  return v;
}

function numToBinBits(v: number, width: number): Bin[] {
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  const u = (v & mask) >>> 0;
  const out: Bin[] = [];
  for (let i = 0; i < width; i++) out.push(((u >>> i) & 1) as Bin);
  return out;
}

// ============================================================================
// 1. Random Synchronous Circuit Generator + Independent Cycle-Based Reference
// ============================================================================

type SeqResetMode = "zero" | "hw-reset";

interface SyncGenOpts {
  seed: number;
  minComb: number;
  maxComb: number;
  minSeq: number;
  maxSeq: number;
  resetMode: SeqResetMode;
  allowFalling?: boolean;
}

interface SeqElemRef {
  kind: "d-ff" | "jk-ff" | "t-ff" | "register" | "counter";
  edge: "rising" | "falling";
  width: number;
  /** Signal indices of registered Q outputs (LSB first). */
  qSigs: number[];
  /** Signal index of Q' output (only for 1-bit flip-flops with showQBar). */
  qnSig: number;
  /** Signal index of counter RCO output, or -1. */
  rcoSig: number;
  /** Input signal indices (populated after combinational DAG is built). */
  dSigs: number[];
  jSig: number;
  kSig: number;
  tSig: number;
  enSig: number; // -1 if no enable pin (always enabled)
  rstSig: number; // -1 if no reset pin
  rstActiveLow: boolean;
  setSig: number; // -1 if no set pin
  setActiveLow: boolean;
  loadSig: number; // -1 if no load pin
  udSig: number; // -1 if no up/down pin (defaults to up=1)
  isAsyncRst: boolean;
  state: Bin[];
}

interface GeneratedSyncCircuit {
  doc: SchematicDocument;
  inputIds: string[];
  hasRstPin: boolean;
  outputSpecs: { id: string; width: number; sigs: number[] }[];
  seqCount: number;
  combCount: number;
  ref: SyncRefSim;
}

class SyncRefSim {
  private sigVals: Bin[];
  constructor(
    totalSigs: number,
    private inputSigs: number[],
    private rstPinSig: number,
    private rstInvSig: number,
    private seqs: SeqElemRef[],
    private combOps: ((vals: Bin[]) => void)[],
    private postRcoOps: ((vals: Bin[]) => void)[],
    private outputSpecs: { id: string; width: number; sigs: number[] }[],
  ) {
    this.sigVals = new Array<Bin>(totalSigs).fill(0);
  }

  private applyAsyncSR(): void {
    for (const s of this.seqs) {
      if (!s.isAsyncRst) continue;
      const r: Bin = s.rstSig >= 0 ? (s.rstActiveLow ? bNot(this.sigVals[s.rstSig]) : this.sigVals[s.rstSig]) : 0;
      const st: Bin = s.setSig >= 0 ? (s.setActiveLow ? bNot(this.sigVals[s.setSig]) : this.sigVals[s.setSig]) : 0;
      if (r === 1 && st === 0) s.state.fill(0);
      else if (st === 1 && r === 0) s.state.fill(1);
    }
  }

  private writeSeqOutputs(): void {
    for (const s of this.seqs) {
      for (let b = 0; b < s.width; b++) this.sigVals[s.qSigs[b]] = s.state[b];
      if (s.qnSig >= 0) this.sigVals[s.qnSig] = bNot(s.state[0]);
    }
  }

  private updateRcos(): void {
    for (const s of this.seqs) {
      if (s.kind !== "counter" || s.rcoSig < 0) continue;
      const en: Bin = s.enSig >= 0 ? this.sigVals[s.enSig] : 1;
      const up: Bin = s.udSig >= 0 ? this.sigVals[s.udSig] : 1;
      const q = binBitsToNum(s.state);
      const maxVal = (1 << s.width) - 1;
      const tc: Bin = (up === 1 ? q === maxVal : q === 0) ? 1 : 0;
      this.sigVals[s.rcoSig] = (tc & en) as Bin;
    }
  }

  /** Set primary inputs + RST pin, apply async resets, and evaluate all combinational logic. */
  evalComb(inputs: readonly Bin[], rstVal: Bin): Record<string, number> {
    for (let i = 0; i < this.inputSigs.length; i++) this.sigVals[this.inputSigs[i]] = inputs[i];
    if (this.rstPinSig >= 0) this.sigVals[this.rstPinSig] = rstVal;
    if (this.rstInvSig >= 0) this.sigVals[this.rstInvSig] = bNot(rstVal);
    // Apply async reset/set driven by primary RST before evaluating comb logic
    this.applyAsyncSR();
    this.writeSeqOutputs();
    for (const op of this.combOps) op(this.sigVals);
    this.updateRcos();
    for (const op of this.postRcoOps) op(this.sigVals);
    return this.readOutputs();
  }

  /** Step a clock edge ("rising" or "falling"): sample pre-edge values, update all matching seqs together, re-evaluate comb. */
  stepEdge(edgeKind: "rising" | "falling", inputs: readonly Bin[], rstVal: Bin): Record<string, number> {
    // Ensure comb values reflect current inputs & pre-edge state
    this.evalComb(inputs, rstVal);

    const nextStates: (Bin[] | null)[] = this.seqs.map((s) => {
      if (s.edge !== edgeKind) return null;
      const en: Bin = s.enSig >= 0 ? this.sigVals[s.enSig] : 1;
      const rst: Bin = s.rstSig >= 0 ? (s.rstActiveLow ? bNot(this.sigVals[s.rstSig]) : this.sigVals[s.rstSig]) : 0;
      const st: Bin = s.setSig >= 0 ? (s.setActiveLow ? bNot(this.sigVals[s.setSig]) : this.sigVals[s.setSig]) : 0;

      if (s.kind === "d-ff") {
        let q: Bin = en === 1 ? this.sigVals[s.dSigs[0]] : s.state[0];
        if (s.isAsyncRst && rst === 1 && st === 0) q = 0;
        else if (s.isAsyncRst && st === 1 && rst === 0) q = 1;
        return [q];
      }
      if (s.kind === "t-ff") {
        let q: Bin = en === 1 ? bXor([this.sigVals[s.tSig], s.state[0]]) : s.state[0];
        if (s.isAsyncRst && rst === 1 && st === 0) q = 0;
        else if (s.isAsyncRst && st === 1 && rst === 0) q = 1;
        return [q];
      }
      if (s.kind === "jk-ff") {
        const j = this.sigVals[s.jSig];
        const k = this.sigVals[s.kSig];
        const cur = s.state[0];
        let q: Bin = en === 1 ? bOr([bAnd([j, bNot(cur)]), bAnd([bNot(k), cur])]) : cur;
        if (s.isAsyncRst && rst === 1 && st === 0) q = 0;
        else if (s.isAsyncRst && st === 1 && rst === 0) q = 1;
        return [q];
      }
      if (s.kind === "register") {
        if (rst === 1) return new Array<Bin>(s.width).fill(0);
        if (en === 1) return s.dSigs.map((sig) => this.sigVals[sig]);
        return s.state.slice();
      }
      // counter
      if (rst === 1) return new Array<Bin>(s.width).fill(0);
      const load: Bin = s.loadSig >= 0 ? this.sigVals[s.loadSig] : 0;
      if (load === 1) return s.dSigs.map((sig) => this.sigVals[sig]);
      if (en === 0) return s.state.slice();
      const up: Bin = s.udSig >= 0 ? this.sigVals[s.udSig] : 1;
      const cur = binBitsToNum(s.state);
      const mod = 1 << s.width;
      const nxt = up === 1 ? (cur + 1) % mod : (cur + mod - 1) % mod;
      return numToBinBits(nxt, s.width);
    });

    for (let i = 0; i < this.seqs.length; i++) {
      if (nextStates[i] !== null) this.seqs[i].state = nextStates[i]!;
    }
    return this.evalComb(inputs, rstVal);
  }

  readOutputs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.outputSpecs) {
      out[o.id] = binBitsToNum(o.sigs.map((s) => this.sigVals[s]));
    }
    return out;
  }
}

function generateSyncCircuit(opts: SyncGenOpts): GeneratedSyncCircuit {
  const rng = new Rng(opts.seed);
  const combCount = rng.int(opts.minComb, opts.maxComb);
  const seqCount = rng.int(opts.minSeq, opts.maxSeq);
  const inputCount = rng.int(2, 6);
  const allowFalling = opts.allowFalling ?? false;

  const parts: PartSpec[] = [];
  const nets: string[][] = [];
  const combOps: ((vals: Bin[]) => void)[] = [];
  const postRcoOps: ((vals: Bin[]) => void)[] = [];

  const sigNet: number[] = [];
  const newSig = (driverPin: string): number => {
    const ni = nets.length;
    nets.push([driverPin]);
    const id = sigNet.length;
    sigNet.push(ni);
    return id;
  };
  const tapSig = (sig: number, pinRef: string): void => {
    nets[sigNet[sig]].push(pinRef);
  };

  let splSeq = 0;
  const mergeBus = (sigs: readonly number[], targetPin: string): void => {
    if (sigs.length === 1) {
      tapSig(sigs[0], targetPin);
      return;
    }
    const sp = `SPM${splSeq++}`;
    parts.push([sp, "splitter", { width: sigs.length, fanOut: sigs.length }]);
    for (let b = 0; b < sigs.length; b++) tapSig(sigs[b], `${sp}.b${b}`);
    nets.push([`${sp}.bus`, targetPin]);
  };
  const splitBus = (width: number, driverPin: string): number[] => {
    if (width === 1) return [newSig(driverPin)];
    const sp = `SPS${splSeq++}`;
    parts.push([sp, "splitter", { width, fanOut: width }]);
    nets.push([driverPin, `${sp}.bus`]);
    const out: number[] = [];
    for (let b = 0; b < width; b++) out.push(newSig(`${sp}.b${b}`));
    return out;
  };

  // Clock + primary inputs + optional shared RST
  parts.push(["CLK", "clock", { name: "CLK" }]);
  const clkNet: string[] = ["CLK.clk"];

  const inputIds: string[] = [];
  const inputSigs: number[] = [];
  for (let i = 0; i < inputCount; i++) {
    const id = `IN${i}`;
    inputIds.push(id);
    parts.push([id, "input-pin", { name: id, width: 1 }]);
    inputSigs.push(newSig(`${id}.out`));
  }

  const hasRstPin = opts.resetMode === "hw-reset" || rng.bool(0.75);
  let rstPinSig = -1;
  let rstInvSig = -1;
  if (hasRstPin) {
    parts.push(["RST", "input-pin", { name: "RST", width: 1 }]);
    rstPinSig = newSig("RST.out");
  }
  const getRstInvSig = (): number => {
    if (rstInvSig >= 0) return rstInvSig;
    parts.push(["RST_INV", "not"]);
    tapSig(rstPinSig, "RST_INV.in0");
    rstInvSig = newSig("RST_INV.out");
    combOps.push((vals) => {
      vals[rstInvSig] = bNot(vals[rstPinSig]);
    });
    return rstInvSig;
  };

  // Pool of available 1-bit signals (starts with primary inputs + all registered Q/Q' outputs)
  const avail: number[] = [...inputSigs];

  // Step 1: instantiate sequential parts and publish their registered Q / Q' outputs
  const seqs: SeqElemRef[] = [];
  const seqKinds = ["d-ff", "jk-ff", "t-ff", "register", "counter"] as const;
  // Ensure broad coverage by picking a shuffled prefix for first few slots
  const seqPrefix = rng.shuffle(seqKinds);

  for (let i = 0; i < seqCount; i++) {
    const kind = i < seqPrefix.length ? seqPrefix[i] : rng.pick(seqKinds);
    const id = `S${i}`;

    if (kind === "d-ff" || kind === "jk-ff" || kind === "t-ff") {
      const edge: "rising" | "falling" = allowFalling && rng.bool(0.3) ? "falling" : "rising";
      const enable = rng.bool(0.45);
      const showQBar = rng.bool(0.7);
      let asyncReset: "none" | "active-high" | "active-low" = "none";
      if (opts.resetMode === "hw-reset") {
        asyncReset = rng.bool(0.5) ? "active-high" : "active-low";
      } else if (hasRstPin && rng.bool(0.6)) {
        asyncReset = rng.bool(0.5) ? "active-high" : "active-low";
      }
      parts.push([id, kind, { edge, enable, asyncReset, asyncSet: "none", showQBar }]);
      clkNet.push(`${id}.clk`);
      const qSig = newSig(`${id}.q`);
      const qnSig = showQBar ? newSig(`${id}.qn`) : -1;
      avail.push(qSig);
      if (qnSig >= 0) avail.push(qnSig);

      let rstSig = -1;
      let rstActiveLow = false;
      if (asyncReset === "active-high") {
        rstSig = rstPinSig;
        tapSig(rstPinSig, `${id}.rst`);
      } else if (asyncReset === "active-low") {
        rstActiveLow = true;
        // Connect inverted RST so RST=1 asserts active-low reset (pin sees 0) and RST=0 deasserts (pin sees 1)
        const inv = getRstInvSig();
        rstSig = inv;
        tapSig(inv, `${id}.rst`);
      }

      seqs.push({
        kind,
        edge,
        width: 1,
        qSigs: [qSig],
        qnSig,
        rcoSig: -1,
        dSigs: [],
        jSig: -1,
        kSig: -1,
        tSig: -1,
        enSig: -1,
        rstSig,
        rstActiveLow,
        setSig: -1,
        setActiveLow: false,
        loadSig: -1,
        udSig: -1,
        isAsyncRst: true,
        state: [0],
      });
    } else if (kind === "register") {
      const width = rng.int(1, 4);
      const pinMode = width === 1 ? "bus" : rng.bool(0.5) ? "bus" : "bits";
      const enable = rng.bool(0.6);
      const reset = opts.resetMode === "hw-reset" ? true : hasRstPin && rng.bool(0.7);
      const edge: "rising" | "falling" = allowFalling && rng.bool(0.3) ? "falling" : "rising";
      parts.push([id, "register", { width, pinMode, enable, reset, edge }]);
      clkNet.push(`${id}.clk`);
      let qSigs: number[];
      if (pinMode === "bits") {
        qSigs = [];
        for (let b = 0; b < width; b++) qSigs.push(newSig(`${id}.q${b}`));
      } else {
        qSigs = splitBus(width, `${id}.q`);
      }
      avail.push(...qSigs);

      let rstSig = -1;
      if (reset) {
        rstSig = rstPinSig;
        tapSig(rstPinSig, `${id}.rst`);
      }

      seqs.push({
        kind: "register",
        edge,
        width,
        qSigs,
        qnSig: -1,
        rcoSig: -1,
        dSigs: [],
        jSig: -1,
        kSig: -1,
        tSig: -1,
        enSig: -1,
        rstSig,
        rstActiveLow: false,
        setSig: -1,
        setActiveLow: false,
        loadSig: -1,
        udSig: -1,
        isAsyncRst: false,
        state: new Array<Bin>(width).fill(0),
      });
    } else {
      // counter (always rising edge)
      const bits = rng.int(1, 4);
      const pinMode = bits === 1 ? "bus" : rng.bool(0.5) ? "bus" : "bits";
      const upDown = rng.bool(0.5);
      const load = rng.bool(0.5);
      const enable = rng.bool(0.6);
      const reset = opts.resetMode === "hw-reset" ? true : hasRstPin && rng.bool(0.75);
      const carryOut = rng.bool(0.65);
      parts.push([id, "counter", { bits, pinMode, upDown, load, enable, reset, carryOut }]);
      clkNet.push(`${id}.clk`);
      let qSigs: number[];
      if (pinMode === "bits") {
        qSigs = [];
        for (let b = 0; b < bits; b++) qSigs.push(newSig(`${id}.q${b}`));
      } else {
        qSigs = splitBus(bits, `${id}.q`);
      }
      avail.push(...qSigs);
      const rcoSig = carryOut ? newSig(`${id}.rco`) : -1;

      let rstSig = -1;
      if (reset) {
        rstSig = rstPinSig;
        tapSig(rstPinSig, `${id}.rst`);
      }

      seqs.push({
        kind: "counter",
        edge: "rising",
        width: bits,
        qSigs,
        qnSig: -1,
        rcoSig,
        dSigs: [],
        jSig: -1,
        kSig: -1,
        tSig: -1,
        enSig: -1,
        rstSig,
        rstActiveLow: false,
        setSig: -1,
        setActiveLow: false,
        loadSig: -1,
        udSig: -1,
        isAsyncRst: false,
        state: new Array<Bin>(bits).fill(0),
      });
    }
  }
  nets.push(clkNet);

  // Step 2: build combinational DAG in topological order (inputs from `avail`)
  const combKinds = [
    "and", "nand", "or", "nor", "xor", "xnor",
    "not", "buf", "schmitt-buffer", "schmitt-inverter",
    "aoi", "half-adder", "full-adder", "parity", "mux",
  ] as const;

  const pickSig = (): number => {
    // Mix primary inputs, state outputs, and recent comb gates for lively toggling
    if (avail.length > 8 && rng.bool(0.45)) {
      const start = Math.max(0, avail.length - 16);
      return avail[rng.int(start, avail.length - 1)];
    }
    return rng.pick(avail);
  };

  const combOutSigs: number[] = [];

  for (let g = 0; g < combCount; g++) {
    const id = `G${g}`;
    // Ensure at least one mux appears in almost every circuit
    const kind = g === 0 ? "mux" : rng.pick(combKinds);

    if (kind === "and" || kind === "nand" || kind === "or" || kind === "nor" || kind === "xor" || kind === "xnor") {
      const nIn = rng.int(2, 4);
      parts.push([id, kind, { inputs: nIn }]);
      const ins: number[] = [];
      for (let i = 0; i < nIn; i++) {
        const s = pickSig();
        ins.push(s);
        tapSig(s, `${id}.in${i}`);
      }
      const out = newSig(`${id}.out`);
      avail.push(out);
      combOutSigs.push(out);
      combOps.push((vals) => {
        const xs = ins.map((s) => vals[s]);
        if (kind === "and") vals[out] = bAnd(xs);
        else if (kind === "nand") vals[out] = bNot(bAnd(xs));
        else if (kind === "or") vals[out] = bOr(xs);
        else if (kind === "nor") vals[out] = bNot(bOr(xs));
        else if (kind === "xor") vals[out] = bXor(xs);
        else vals[out] = bNot(bXor(xs));
      });
    } else if (kind === "not" || kind === "buf" || kind === "schmitt-buffer" || kind === "schmitt-inverter") {
      parts.push([id, kind]);
      const s = pickSig();
      tapSig(s, `${id}.in0`);
      const out = newSig(`${id}.out`);
      avail.push(out);
      combOutSigs.push(out);
      const inv = kind === "not" || kind === "schmitt-inverter";
      combOps.push((vals) => {
        vals[out] = inv ? bNot(vals[s]) : vals[s];
      });
    } else if (kind === "aoi") {
      const sub = rng.pick(["aoi21", "aoi22", "oai21", "oai22"] as const);
      parts.push([id, "aoi", { kind: sub }]);
      const sa = pickSig(), sb = pickSig(), sc = pickSig();
      tapSig(sa, `${id}.a`);
      tapSig(sb, `${id}.b`);
      tapSig(sc, `${id}.c`);
      let sd = -1;
      if (sub === "aoi22" || sub === "oai22") {
        sd = pickSig();
        tapSig(sd, `${id}.d`);
      }
      const out = newSig(`${id}.y`);
      avail.push(out);
      combOutSigs.push(out);
      combOps.push((vals) => {
        const a = vals[sa], b = vals[sb], c = vals[sc];
        if (sub === "aoi21") vals[out] = bNot(bOr([bAnd([a, b]), c]));
        else if (sub === "aoi22") vals[out] = bNot(bOr([bAnd([a, b]), bAnd([c, vals[sd]])]));
        else if (sub === "oai21") vals[out] = bNot(bAnd([bOr([a, b]), c]));
        else vals[out] = bNot(bAnd([bOr([a, b]), bOr([c, vals[sd]])]));
      });
    } else if (kind === "half-adder") {
      parts.push([id, "half-adder"]);
      const sa = pickSig(), sb = pickSig();
      tapSig(sa, `${id}.a`);
      tapSig(sb, `${id}.b`);
      const sOut = newSig(`${id}.s`);
      const cOut = newSig(`${id}.cout`);
      avail.push(sOut, cOut);
      combOutSigs.push(sOut, cOut);
      combOps.push((vals) => {
        const a = vals[sa], b = vals[sb];
        vals[sOut] = bXor([a, b]);
        vals[cOut] = bAnd([a, b]);
      });
    } else if (kind === "full-adder") {
      parts.push([id, "full-adder"]);
      const sa = pickSig(), sb = pickSig(), sci = pickSig();
      tapSig(sa, `${id}.a`);
      tapSig(sb, `${id}.b`);
      tapSig(sci, `${id}.cin`);
      const sOut = newSig(`${id}.s`);
      const cOut = newSig(`${id}.cout`);
      avail.push(sOut, cOut);
      combOutSigs.push(sOut, cOut);
      combOps.push((vals) => {
        const a = vals[sa], b = vals[sb], ci = vals[sci];
        vals[sOut] = bXor([a, b, ci]);
        vals[cOut] = bOr([bAnd([a, b]), bAnd([a, ci]), bAnd([b, ci])]);
      });
    } else if (kind === "parity") {
      const nIn = rng.int(2, 4);
      parts.push([id, "parity", { inputs: nIn }]);
      const ins: number[] = [];
      for (let i = 0; i < nIn; i++) {
        const s = pickSig();
        ins.push(s);
        tapSig(s, `${id}.in${i}`);
      }
      const odd = newSig(`${id}.odd`);
      const even = newSig(`${id}.even`);
      avail.push(odd, even);
      combOutSigs.push(odd);
      combOps.push((vals) => {
        const o = bXor(ins.map((s) => vals[s]));
        vals[odd] = o;
        vals[even] = bNot(o);
      });
    } else {
      // mux
      const selectBits = rng.int(1, 2);
      const dataWidth = rng.pick([1, 1, 2, 3]);
      const enable = rng.bool(0.5);
      const selectMode = rng.bool(0.5) ? "bits" : "bus";
      parts.push([id, "mux", { selectBits, dataWidth, enable, selectMode }]);
      const numCh = 1 << selectBits;
      const chSigs: number[][] = [];
      for (let ch = 0; ch < numCh; ch++) {
        const ds: number[] = [];
        for (let b = 0; b < dataWidth; b++) ds.push(pickSig());
        mergeBus(ds, `${id}.d${ch}`);
        chSigs.push(ds);
      }
      const selSigs: number[] = [];
      if (selectMode === "bus") {
        for (let b = 0; b < selectBits; b++) selSigs.push(pickSig());
        mergeBus(selSigs, `${id}.s`);
      } else {
        for (let b = 0; b < selectBits; b++) {
          const s = pickSig();
          selSigs.push(s);
          tapSig(s, `${id}.s${b}`);
        }
      }
      let enSig = -1;
      if (enable) {
        enSig = pickSig();
        tapSig(enSig, `${id}.en`);
      }
      const outSigs = splitBus(dataWidth, `${id}.y`);
      avail.push(...outSigs);
      combOutSigs.push(...outSigs);
      combOps.push((vals) => {
        const en: Bin = enSig >= 0 ? vals[enSig] : 1;
        const sel = binBitsToNum(selSigs.map((s) => vals[s]));
        for (let b = 0; b < dataWidth; b++) {
          vals[outSigs[b]] = en === 1 ? vals[chSigs[sel][b]] : 0;
        }
      });
    }
  }

  // Step 3: wire sequential next-state inputs (feedback through flip-flops!)
  const pickNextIn = (): number => {
    if (combOutSigs.length > 0 && rng.bool(0.75)) return rng.pick(combOutSigs);
    return rng.pick(avail);
  };

  for (let i = 0; i < seqs.length; i++) {
    const s = seqs[i];
    const id = `S${i}`;
    const partSpec = parts.find((p) => p[0] === id)!;
    const p = partSpec[2] ?? {};

    if (s.kind === "d-ff") {
      const d = pickNextIn();
      s.dSigs = [d];
      tapSig(d, `${id}.d`);
      if (p.enable) {
        s.enSig = pickNextIn();
        tapSig(s.enSig, `${id}.en`);
      }
    } else if (s.kind === "t-ff") {
      s.tSig = pickNextIn();
      tapSig(s.tSig, `${id}.t`);
      if (p.enable) {
        s.enSig = pickNextIn();
        tapSig(s.enSig, `${id}.en`);
      }
    } else if (s.kind === "jk-ff") {
      s.jSig = pickNextIn();
      s.kSig = pickNextIn();
      tapSig(s.jSig, `${id}.j`);
      tapSig(s.kSig, `${id}.k`);
      if (p.enable) {
        s.enSig = pickNextIn();
        tapSig(s.enSig, `${id}.en`);
      }
    } else if (s.kind === "register") {
      const ds: number[] = [];
      for (let b = 0; b < s.width; b++) ds.push(pickNextIn());
      s.dSigs = ds;
      if (p.pinMode === "bits") {
        for (let b = 0; b < s.width; b++) tapSig(ds[b], `${id}.d${b}`);
      } else {
        mergeBus(ds, `${id}.d`);
      }
      if (p.enable) {
        s.enSig = pickNextIn();
        tapSig(s.enSig, `${id}.en`);
      }
    } else {
      // counter
      if (p.load) {
        const ds: number[] = [];
        for (let b = 0; b < s.width; b++) ds.push(pickNextIn());
        s.dSigs = ds;
        if (p.pinMode === "bits") {
          for (let b = 0; b < s.width; b++) tapSig(ds[b], `${id}.d${b}`);
        } else {
          mergeBus(ds, `${id}.d`);
        }
        s.loadSig = pickNextIn();
        tapSig(s.loadSig, `${id}.load`);
      }
      if (p.enable) {
        s.enSig = pickNextIn();
        tapSig(s.enSig, `${id}.en`);
      }
      if (p.upDown) {
        s.udSig = pickNextIn();
        tapSig(s.udSig, `${id}.ud`);
      }
    }
  }

  // Step 4: attach output pins to every sequential Q (and RCO) plus a sample of comb outputs
  const outputSpecs: { id: string; width: number; sigs: number[] }[] = [];
  seqs.forEach((s, i) => {
    const oid = `OQ${i}`;
    parts.push([oid, "output-pin", { name: oid, width: s.width }]);
    mergeBus(s.qSigs, `${oid}.in`);
    outputSpecs.push({ id: oid, width: s.width, sigs: s.qSigs });
    if (s.rcoSig >= 0) {
      const rid = `ORCO${i}`;
      parts.push([rid, "output-pin", { name: rid, width: 1 }]);
      tapSig(s.rcoSig, `${rid}.in`);
      outputSpecs.push({ id: rid, width: 1, sigs: [s.rcoSig] });
    }
  });

  const pickedComb = rng.shuffle(combOutSigs).slice(0, Math.min(4, combOutSigs.length));
  pickedComb.forEach((sig, k) => {
    const oid = `OC${k}`;
    parts.push([oid, "output-pin", { name: oid, width: 1 }]);
    tapSig(sig, `${oid}.in`);
    outputSpecs.push({ id: oid, width: 1, sigs: [sig] });
  });

  const doc = mkDoc(parts, nets, `sync_${opts.seed}`);
  const ref = new SyncRefSim(sigNet.length, inputSigs, rstPinSig, rstInvSig, seqs, combOps, postRcoOps, outputSpecs);

  return { doc, inputIds, hasRstPin, outputSpecs, seqCount, combCount, ref };
}

function runSyncDifferentialSeed(opts: SyncGenOpts, cycles: number): void {
  const gen = generateSyncCircuit(opts);
  const circuit = extractCircuit(gen.doc);
  const sim = new Simulator(circuit, { initial: opts.resetMode === "zero" ? "zero" : "x" });
  const rng = new Rng(opts.seed ^ 0x9e3779b9);

  const checkAll = (expected: Record<string, number>, phase: string, cycle: number) => {
    for (const o of gen.outputSpecs) {
      const actual = sim.read(o.id);
      if (actual !== expected[o.id]) {
        throw new Error(
          `seed=${opts.seed} resetMode=${opts.resetMode} cycle=${cycle} phase=${phase} out=${o.id}: expected=${expected[o.id]} actual=${actual}`,
        );
      }
    }
  };

  // Initial startup / reset
  const initInputs: Bin[] = gen.inputIds.map(() => 0);
  if (opts.resetMode === "hw-reset") {
    // Assert RST=1, settle (clears async-reset FFs), tick CLK (clears sync-reset registers/counters), then deassert RST=0
    sim.set("RST", 1);
    sim.set("CLK", 0);
    for (const id of gen.inputIds) sim.set(id, 0);
    expect(sim.settle().stable).toBe(true);
    sim.set("CLK", 1);
    expect(sim.settle().stable).toBe(true);
    sim.set("CLK", 0);
    expect(sim.settle().stable).toBe(true);
    sim.set("RST", 0);
    const r0 = sim.settle();
    expect(r0.stable).toBe(true);
    expect(r0.issues).toEqual([]);
    const exp0 = gen.ref.evalComb(initInputs, 0);
    checkAll(exp0, "post-hw-reset", -1);
  } else {
    sim.set("CLK", 0);
    if (gen.hasRstPin) sim.set("RST", 0);
    for (const id of gen.inputIds) sim.set(id, 0);
    const r0 = sim.settle();
    expect(r0.stable).toBe(true);
    expect(r0.issues).toEqual([]);
    const exp0 = gen.ref.evalComb(initInputs, 0);
    checkAll(exp0, "init", -1);
  }

  for (let c = 0; c < cycles; c++) {
    // 1. Change inputs while CLK=0 (occasionally pulse RST=1 with low prob to test resets mid-run)
    const inputs: Bin[] = gen.inputIds.map(() => (rng.bool(0.5) ? 1 : 0));
    const rstVal: Bin = gen.hasRstPin && rng.bool(0.05) ? 1 : 0;
    for (let i = 0; i < gen.inputIds.length; i++) sim.set(gen.inputIds[i], inputs[i]);
    if (gen.hasRstPin) sim.set("RST", rstVal);
    const rComb = sim.settle();
    expect(rComb.stable).toBe(true);
    expect(rComb.issues).toEqual([]);
    checkAll(gen.ref.evalComb(inputs, rstVal), "pre-rise", c);

    // 2. Rising edge: CLK 0 -> 1
    sim.set("CLK", 1);
    const rRise = sim.settle();
    expect(rRise.stable).toBe(true);
    expect(rRise.issues).toEqual([]);
    checkAll(gen.ref.stepEdge("rising", inputs, rstVal), "rise", c);

    // 3. Optionally change inputs while CLK=1 (before falling edge)
    let fallInputs = inputs;
    let fallRst = rstVal;
    if (rng.bool(0.5)) {
      fallInputs = gen.inputIds.map(() => (rng.bool(0.5) ? 1 : 0));
      fallRst = gen.hasRstPin && rng.bool(0.04) ? 1 : 0;
      for (let i = 0; i < gen.inputIds.length; i++) sim.set(gen.inputIds[i], fallInputs[i]);
      if (gen.hasRstPin) sim.set("RST", fallRst);
      const rMid = sim.settle();
      expect(rMid.stable).toBe(true);
      expect(rMid.issues).toEqual([]);
      checkAll(gen.ref.evalComb(fallInputs, fallRst), "mid-high", c);
    }

    // 4. Falling edge: CLK 1 -> 0
    sim.set("CLK", 0);
    const rFall = sim.settle();
    expect(rFall.stable).toBe(true);
    expect(rFall.issues).toEqual([]);
    checkAll(gen.ref.stepEdge("falling", fallInputs, fallRst), "fall", c);
  }
}

describe("1. sequential differential fuzzing", () => {
  it("matches independent cycle-based reference across 220 seeded synchronous circuits (initial=zero, 5..60 comb gates, 2..12 seq parts, 60..120 cycles)", () => {
    for (let seed = 1; seed <= 220; seed++) {
      const cycles = 60 + (seed % 61); // 60..120
      runSyncDifferentialSeed(
        {
          seed: 1000 + seed,
          minComb: 5,
          maxComb: 60,
          minSeq: 2,
          maxSeq: 12,
          resetMode: "zero",
          allowFalling: seed % 3 === 0,
        },
        cycles,
      );
    }
  });

  it("matches independent reference with initial=x and hardware reset sequence across 100 seeded circuits (50..100 cycles)", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const cycles = 50 + (seed % 51); // 50..100
      runSyncDifferentialSeed(
        {
          seed: 5000 + seed,
          minComb: 5,
          maxComb: 45,
          minSeq: 2,
          maxSeq: 10,
          resetMode: "hw-reset",
          allowFalling: seed % 4 === 0,
        },
        cycles,
      );
    }
  });

  it("matches independent reference on 30 larger synchronous circuits (40..60 comb gates, 8..12 seq parts, 200 cycles each)", () => {
    for (let seed = 1; seed <= 30; seed++) {
      runSyncDifferentialSeed(
        {
          seed: 9000 + seed,
          minComb: 40,
          maxComb: 60,
          minSeq: 8,
          maxSeq: 12,
          resetMode: seed % 2 === 0 ? "zero" : "hw-reset",
          allowFalling: seed % 3 === 0,
        },
        200,
      );
    }
  });
});

// ============================================================================
// 2. End-to-End Fuzzing Through DSpec (`compileSpec` + `circuitText` round-trip)
// ============================================================================

interface GeneratedDspecComb {
  source: string;
  inputNames: string[];
  outputNames: string[];
  evalRef: (inputs: Record<string, Bin>) => Record<string, Bin>;
}

/**
 * Generates random combinational DSpec source exercising:
 *  - ranges (`A0..A3`), multi-declarations, type aliases (`input`, `output`, `inv`, `buffer`, `gnd`, `power`)
 *  - groups (`group g0 { ... }`), comments, layout/rot/mirror/label attributes
 *  - `->`, `net NAME = ...`, anonymous `net ...`, bare part refs
 *  - gates, aoi, half-adder, full-adder, mux, decoder, parity, constant, vcc, ground, tunnels
 */
function generateRandomDspecComb(
  seed: number,
  compactMode: "never" | "end",
  routeMode: "clean" | "tunnel",
  maxGates = 14,
): GeneratedDspecComb {
  const rng = new Rng(seed);
  const nIn = rng.int(3, 5);
  const nGates = rng.int(5, maxGates);
  const layoutMode = rng.pick(["flow", "flow", "grid"] as const);

  const lines: string[] = [
    `# Auto-generated DSpec fuzz circuit seed=${seed}`,
    `@name "fuzz_${seed}"`,
    `@compact ${compactMode}`,
    `@budget ms=50`,
    `@layout ${layoutMode}`,
    `@route ${routeMode}`,
    "",
  ];

  // Signals: index -> { driverRef (explicit PART.PIN), bareRef (optional PART for `->`), sinks }
  interface SigInfo {
    driverRef: string;
    bareRef: string | null;
    sinks: string[];
    explicitNet: string | null;
    viaTunnel: boolean;
  }
  const sigs: SigInfo[] = [];
  const ops: ((vals: Bin[]) => void)[] = [];

  const addSig = (driverRef: string, bareRef: string | null = null, viaTunnel = false): number => {
    const idx = sigs.length;
    sigs.push({
      driverRef,
      bareRef,
      sinks: [],
      explicitNet: rng.bool(0.35) ? `N_${idx}` : null,
      viaTunnel,
    });
    return idx;
  };

  // Inputs (sometimes range syntax, sometimes comma syntax, sometimes aliases)
  const inputNames: string[] = [];
  for (let i = 0; i < nIn; i++) inputNames.push(`A${i}`);
  const inType = rng.pick(["input-pin", "input", "in"] as const);
  if (rng.bool(0.6)) {
    lines.push(`part A0..A${nIn - 1} ${inType}`);
  } else {
    lines.push(`part ${inputNames.join(", ")} ${inType}`);
  }
  for (let i = 0; i < nIn; i++) {
    // input-pin has only 1 pin so bare A{i} is always valid in both `net` and `->`
    addSig(rng.bool(0.5) ? `A${i}` : `A${i}.out`, `A${i}`, false);
  }

  const pick = (maxIdx: number): number => rng.int(0, maxIdx - 1);
  const maybeGeomAttrs = (): string => {
    const attrs: string[] = [];
    if (rng.bool(0.2)) attrs.push(`rot=${rng.pick([0, 90, 180, 270])}`);
    if (rng.bool(0.15)) attrs.push("mirror");
    if (rng.bool(0.15)) attrs.push(`label="L${rng.int(1, 99)}"`);
    return attrs.length ? " " + attrs.join(" ") : "";
  };

  const useGroup = rng.bool(0.5);
  const groupStart = useGroup ? rng.int(1, Math.max(1, nGates - 2)) : -1;
  const groupEnd = useGroup ? Math.min(nGates - 1, groupStart + rng.int(1, 3)) : -1;

  const kinds = [
    "and", "nand", "or", "nor", "xor", "xnor",
    "not", "inv", "buf", "buffer",
    "aoi", "half-adder", "full-adder", "mux", "decoder", "parity",
    "constant", "vcc", "ground",
  ] as const;

  let tunnelSeq = 0;

  for (let g = 0; g < nGates; g++) {
    if (g === groupStart) lines.push(`group blk${g} {`);
    const indent = g >= groupStart && g <= groupEnd ? "  " : "";
    const curAvail = sigs.length;
    const id = `U${g}`;
    const kind = rng.pick(kinds);
    const geom = maybeGeomAttrs();

    if (kind === "and" || kind === "nand" || kind === "or" || kind === "nor" || kind === "xor" || kind === "xnor") {
      const nInputs = rng.int(2, 3);
      const propStr = nInputs === 2 && rng.bool(0.5) ? "" : ` inputs=${nInputs}`;
      lines.push(`${indent}part ${id} ${kind}${propStr}${geom}`);
      const ins: number[] = [];
      for (let i = 0; i < nInputs; i++) {
        const s = pick(curAvail);
        ins.push(s);
        sigs[s].sinks.push(`${id}.in${i}`);
      }
      const out = addSig(`${id}.out`, id, rng.bool(0.12));
      ops.push((vals) => {
        const xs = ins.map((s) => vals[s]);
        if (kind === "and") vals[out] = bAnd(xs);
        else if (kind === "nand") vals[out] = bNot(bAnd(xs));
        else if (kind === "or") vals[out] = bOr(xs);
        else if (kind === "nor") vals[out] = bNot(bOr(xs));
        else if (kind === "xor") vals[out] = bXor(xs);
        else vals[out] = bNot(bXor(xs));
      });
    } else if (kind === "not" || kind === "inv" || kind === "buf" || kind === "buffer") {
      lines.push(`${indent}part ${id} ${kind}${geom}`);
      const s = pick(curAvail);
      sigs[s].sinks.push(`${id}.in0`);
      const out = addSig(`${id}.out`, id, rng.bool(0.12));
      const inv = kind === "not" || kind === "inv";
      ops.push((vals) => {
        vals[out] = inv ? bNot(vals[s]) : vals[s];
      });
    } else if (kind === "aoi") {
      const sub = rng.pick(["aoi21", "aoi22", "oai21", "oai22"] as const);
      lines.push(`${indent}part ${id} aoi kind=${sub}${geom}`);
      const sa = pick(curAvail), sb = pick(curAvail), sc = pick(curAvail);
      sigs[sa].sinks.push(`${id}.a`);
      sigs[sb].sinks.push(`${id}.b`);
      sigs[sc].sinks.push(`${id}.c`);
      let sd = -1;
      if (sub === "aoi22" || sub === "oai22") {
        sd = pick(curAvail);
        sigs[sd].sinks.push(`${id}.d`);
      }
      const out = addSig(`${id}.y`);
      ops.push((vals) => {
        const a = vals[sa], b = vals[sb], c = vals[sc];
        if (sub === "aoi21") vals[out] = bNot(bOr([bAnd([a, b]), c]));
        else if (sub === "aoi22") vals[out] = bNot(bOr([bAnd([a, b]), bAnd([c, vals[sd]])]));
        else if (sub === "oai21") vals[out] = bNot(bAnd([bOr([a, b]), c]));
        else vals[out] = bNot(bAnd([bOr([a, b]), bOr([c, vals[sd]])]));
      });
    } else if (kind === "half-adder") {
      lines.push(`${indent}part ${id} half-adder${geom}`);
      const sa = pick(curAvail), sb = pick(curAvail);
      sigs[sa].sinks.push(`${id}.a`);
      sigs[sb].sinks.push(`${id}.b`);
      const sOut = addSig(`${id}.s`);
      const cOut = addSig(`${id}.cout`);
      ops.push((vals) => {
        const a = vals[sa], b = vals[sb];
        vals[sOut] = bXor([a, b]);
        vals[cOut] = bAnd([a, b]);
      });
    } else if (kind === "full-adder") {
      lines.push(`${indent}part ${id} full-adder${geom}`);
      const sa = pick(curAvail), sb = pick(curAvail), sci = pick(curAvail);
      sigs[sa].sinks.push(`${id}.a`);
      sigs[sb].sinks.push(`${id}.b`);
      sigs[sci].sinks.push(`${id}.cin`);
      const sOut = addSig(`${id}.s`);
      const cOut = addSig(`${id}.cout`);
      ops.push((vals) => {
        const a = vals[sa], b = vals[sb], ci = vals[sci];
        vals[sOut] = bXor([a, b, ci]);
        vals[cOut] = bOr([bAnd([a, b]), bAnd([a, ci]), bAnd([b, ci])]);
      });
    } else if (kind === "mux") {
      const selectBits = rng.int(1, 2);
      const enable = rng.bool(0.5);
      lines.push(`${indent}part ${id} mux selectBits=${selectBits} dataWidth=1 enable=${enable} selectMode=bits${geom}`);
      const numCh = 1 << selectBits;
      const ds: number[] = [];
      for (let ch = 0; ch < numCh; ch++) {
        const s = pick(curAvail);
        ds.push(s);
        sigs[s].sinks.push(`${id}.d${ch}`);
      }
      const ss: number[] = [];
      for (let b = 0; b < selectBits; b++) {
        const s = pick(curAvail);
        ss.push(s);
        sigs[s].sinks.push(`${id}.s${b}`);
      }
      let en = -1;
      if (enable) {
        en = pick(curAvail);
        sigs[en].sinks.push(`${id}.en`);
      }
      const out = addSig(`${id}.y`);
      ops.push((vals) => {
        const e: Bin = en >= 0 ? vals[en] : 1;
        const idx = binBitsToNum(ss.map((s) => vals[s]));
        vals[out] = e === 1 ? vals[ds[idx]] : 0;
      });
    } else if (kind === "decoder") {
      const inputs = rng.int(1, 2);
      const enable = rng.bool(0.5);
      const activeLowOutputs = rng.bool(0.5);
      lines.push(`${indent}part ${id} decoder inputs=${inputs} enable=${enable} activeLowOutputs=${activeLowOutputs}${geom}`);
      const as: number[] = [];
      for (let i = 0; i < inputs; i++) {
        const s = pick(curAvail);
        as.push(s);
        sigs[s].sinks.push(`${id}.a${i}`);
      }
      let en = -1;
      if (enable) {
        en = pick(curAvail);
        sigs[en].sinks.push(`${id}.en`);
      }
      const nOut = 1 << inputs;
      const ys: number[] = [];
      for (let i = 0; i < nOut; i++) ys.push(addSig(`${id}.y${i}`));
      ops.push((vals) => {
        const e: Bin = en >= 0 ? vals[en] : 1;
        const idx = binBitsToNum(as.map((s) => vals[s]));
        for (let i = 0; i < nOut; i++) {
          const hit: Bin = e === 1 && idx === i ? 1 : 0;
          vals[ys[i]] = activeLowOutputs ? bNot(hit) : hit;
        }
      });
    } else if (kind === "parity") {
      const nInputs = rng.int(2, 4);
      lines.push(`${indent}part ${id} parity inputs=${nInputs}${geom}`);
      const ins: number[] = [];
      for (let i = 0; i < nInputs; i++) {
        const s = pick(curAvail);
        ins.push(s);
        sigs[s].sinks.push(`${id}.in${i}`);
      }
      const odd = addSig(`${id}.odd`);
      const even = addSig(`${id}.even`);
      ops.push((vals) => {
        const o = bXor(ins.map((s) => vals[s]));
        vals[odd] = o;
        vals[even] = bNot(o);
      });
    } else if (kind === "constant") {
      const v: Bin = rng.bool(0.5) ? 1 : 0;
      lines.push(`${indent}part ${id} constant value=${v} width=1`);
      const out = addSig(`${id}.out`);
      ops.push((vals) => {
        vals[out] = v;
      });
    } else if (kind === "vcc") {
      const alias = rng.bool(0.5) ? "vcc" : "power";
      lines.push(`${indent}part ${id} ${alias}`);
      const out = addSig(`${id}.vcc`);
      ops.push((vals) => {
        vals[out] = 1;
      });
    } else {
      const alias = rng.bool(0.5) ? "ground" : "gnd";
      lines.push(`${indent}part ${id} ${alias}`);
      const out = addSig(`${id}.gnd`);
      ops.push((vals) => {
        vals[out] = 0;
      });
    }

    if (g === groupEnd) lines.push("}");
  }

  // Outputs: observe 3..5 internal signals (always including the last one)
  const internalIdxs: number[] = [];
  for (let i = nIn; i < sigs.length; i++) internalIdxs.push(i);
  const chosenOuts = rng.shuffle(internalIdxs).slice(0, Math.min(4, internalIdxs.length));
  if (internalIdxs.length > 0 && !chosenOuts.includes(sigs.length - 1)) {
    chosenOuts[0] = sigs.length - 1;
  }

  const outType = rng.pick(["output-pin", "output", "out"] as const);
  const outputNames: string[] = [];
  chosenOuts.forEach((_, k) => outputNames.push(`Y${k}`));
  if (outputNames.length > 1 && rng.bool(0.5)) {
    lines.push(`part Y0..Y${outputNames.length - 1} ${outType}`);
  } else {
    lines.push(`part ${outputNames.join(", ")} ${outType}`);
  }
  chosenOuts.forEach((sigIdx, k) => {
    sigs[sigIdx].sinks.push(rng.bool(0.5) ? `Y${k}` : `Y${k}.in`);
  });

  // Emit nets (with optional explicit tunnel pair for signals marked viaTunnel)
  lines.push("");
  for (const s of sigs) {
    if (s.sinks.length === 0) continue;
    const arrowSrc = s.bareRef && rng.bool(0.4) ? s.bareRef : s.driverRef;
    if (s.viaTunnel && s.sinks.length >= 1) {
      const tName = `TUN_${tunnelSeq++}`;
      const td = `TD_${tunnelSeq}`;
      const tr = `TR_${tunnelSeq}`;
      lines.push(`part ${td} tunnel name=${tName}`);
      lines.push(`part ${tr} tunnel name=${tName}`);
      lines.push(`${arrowSrc} -> ${td}.net`);
      lines.push(`net ${tr}.net, ${s.sinks.join(", ")}`);
    } else if (s.explicitNet) {
      lines.push(`net ${s.explicitNet} = ${s.driverRef}, ${s.sinks.join(", ")}`);
    } else if (rng.bool(0.75)) {
      lines.push(`${arrowSrc} -> ${s.sinks.join(", ")}`);
    } else {
      lines.push(`net ${s.driverRef}, ${s.sinks.join(", ")}`);
    }
  }

  const totalSigs = sigs.length;
  const evalRef = (inputs: Record<string, Bin>): Record<string, Bin> => {
    const vals = new Array<Bin>(totalSigs).fill(0);
    for (let i = 0; i < nIn; i++) vals[i] = inputs[inputNames[i]] ?? 0;
    for (const op of ops) op(vals);
    const out: Record<string, Bin> = {};
    chosenOuts.forEach((sigIdx, k) => {
      out[outputNames[k]] = vals[sigIdx];
    });
    return out;
  };

  return { source: lines.join("\n") + "\n", inputNames, outputNames, evalRef };
}

interface GeneratedDspecSeq {
  source: string;
  inputNames: string[];
  outputNames: string[];
  stepAndEval: (inputs: Record<string, Bin>, edge: boolean) => Record<string, Bin>;
}

/**
 * Generates a small random synchronous DSpec source with clock, d-ff/jk-ff/t-ff (using aliases
 * and Q' pin aliases too), combinational gates, mux, and optional async reset.
 */
function generateRandomDspecSeq(
  seed: number,
  compactMode: "never" | "end",
  routeMode: "clean" | "tunnel",
  small = false,
): GeneratedDspecSeq {
  const rng = new Rng(seed);
  const nIn = small ? 2 : rng.int(2, 3);
  const nFF = small ? 2 : rng.int(2, 4);
  const nComb = small ? 4 : rng.int(4, 8);

  const lines: string[] = [
    `@name "seq_dspec_${seed}"`,
    `@compact ${compactMode}`,
    `@budget ms=50`,
    `@route ${routeMode}`,
    "",
    `part CLK clock`,
    `part A0..A${nIn - 1} input-pin`,
  ];

  const inputNames = Array.from({ length: nIn }, (_, i) => `A${i}`);

  interface Sig {
    driverRef: string;
    sinks: string[];
  }
  const sigs: Sig[] = [];
  const addSig = (driverRef: string): number => {
    const idx = sigs.length;
    sigs.push({ driverRef, sinks: [] });
    return idx;
  };

  const inSigs: number[] = [];
  for (let i = 0; i < nIn; i++) inSigs.push(addSig(`A${i}.out`));

  const useRst = rng.bool(0.5);
  let rstSig = -1;
  let rstInvSig = -1;
  if (useRst) {
    lines.push(`part RST input-pin`);
    inputNames.push("RST");
    rstSig = addSig("RST.out");
  }
  const getRstInv = (): number => {
    if (rstInvSig >= 0) return rstInvSig;
    lines.push(`part RSTN inv`);
    sigs[rstSig].sinks.push("RSTN.in0");
    rstInvSig = addSig("RSTN.out");
    return rstInvSig;
  };

  interface FfSpec {
    id: string;
    kind: "d-ff" | "jk-ff" | "t-ff";
    qSig: number;
    qnSig: number;
    in0: number;
    in1: number;
    enSig: number;
    hasAsyncRst: boolean;
    state: Bin;
  }
  const ffs: FfSpec[] = [];
  for (let i = 0; i < nFF; i++) {
    const kind = rng.pick(["d-ff", "jk-ff", "t-ff"] as const);
    const typeAlias = kind === "d-ff" && rng.bool(0.5) ? "dff" : kind === "jk-ff" && rng.bool(0.5) ? "jkff" : kind === "t-ff" && rng.bool(0.5) ? "tff" : kind;
    const enable = rng.bool(0.4);
    const asyncReset = useRst && rng.bool(0.6) ? rng.pick(["active-high", "active-low"] as const) : "none";
    const id = `F${i}`;
    const rstAttr = asyncReset === "none" ? "" : ` asyncReset=${asyncReset}`;
    lines.push(`part ${id} ${typeAlias} enable=${enable}${rstAttr}`);
    const qSig = addSig(`${id}.q`);
    const qnRef = rng.pick([`${id}.qn`, `${id}.Q'`, `${id}.nQ`] as const);
    const qnSig = addSig(qnRef);
    if (asyncReset === "active-high") {
      sigs[rstSig].sinks.push(`${id}.rst`);
    } else if (asyncReset === "active-low") {
      sigs[getRstInv()].sinks.push(`${id}.rst`);
    }
    ffs.push({ id, kind, qSig, qnSig, in0: -1, in1: -1, enSig: -1, hasAsyncRst: asyncReset !== "none", state: 0 });
  }

  const combOps: ((vals: Bin[]) => void)[] = [];
  const combSigs: number[] = [];
  for (let g = 0; g < nComb; g++) {
    const id = `G${g}`;
    const curAvail = sigs.length;
    const kind = g === 0 ? "mux" : rng.pick(["and", "nand", "or", "nor", "xor", "xnor", "not"] as const);
    if (kind === "not") {
      lines.push(`part ${id} ${rng.bool(0.5) ? "not" : "inv"}`);
      const s = rng.int(0, curAvail - 1);
      sigs[s].sinks.push(`${id}.in0`);
      const out = addSig(`${id}.out`);
      combSigs.push(out);
      combOps.push((vals) => {
        vals[out] = bNot(vals[s]);
      });
    } else if (kind === "mux") {
      lines.push(`part ${id} mux selectBits=1 dataWidth=1 selectMode=bits`);
      const d0 = rng.int(0, curAvail - 1);
      const d1 = rng.int(0, curAvail - 1);
      const s0 = rng.int(0, curAvail - 1);
      sigs[d0].sinks.push(`${id}.d0`);
      sigs[d1].sinks.push(`${id}.d1`);
      sigs[s0].sinks.push(`${id}.s0`);
      const out = addSig(`${id}.y`);
      combSigs.push(out);
      combOps.push((vals) => {
        vals[out] = vals[s0] === 1 ? vals[d1] : vals[d0];
      });
    } else {
      lines.push(`part ${id} ${kind}`);
      const s0 = rng.int(0, curAvail - 1);
      const s1 = rng.int(0, curAvail - 1);
      sigs[s0].sinks.push(`${id}.in0`);
      sigs[s1].sinks.push(`${id}.in1`);
      const out = addSig(`${id}.out`);
      combSigs.push(out);
      combOps.push((vals) => {
        const xs: Bin[] = [vals[s0], vals[s1]];
        if (kind === "and") vals[out] = bAnd(xs);
        else if (kind === "nand") vals[out] = bNot(bAnd(xs));
        else if (kind === "or") vals[out] = bOr(xs);
        else if (kind === "nor") vals[out] = bNot(bOr(xs));
        else if (kind === "xor") vals[out] = bXor(xs);
        else vals[out] = bNot(bXor(xs));
      });
    }
  }

  // Wire FF inputs from combSigs (feedback through FFs)
  for (const ff of ffs) {
    const pickIn = () => (rng.bool(0.75) ? rng.pick(combSigs) : rng.int(0, sigs.length - 1));
    if (ff.kind === "d-ff") {
      ff.in0 = pickIn();
      sigs[ff.in0].sinks.push(`${ff.id}.d`);
    } else if (ff.kind === "t-ff") {
      ff.in0 = pickIn();
      sigs[ff.in0].sinks.push(`${ff.id}.t`);
    } else {
      ff.in0 = pickIn();
      ff.in1 = pickIn();
      sigs[ff.in0].sinks.push(`${ff.id}.j`);
      sigs[ff.in1].sinks.push(`${ff.id}.k`);
    }
    const declLine = lines.find((l) => l.startsWith(`part ${ff.id} `))!;
    if (declLine.includes("enable=true")) {
      ff.enSig = pickIn();
      sigs[ff.enSig].sinks.push(`${ff.id}.en`);
    }
  }

  // Output pins for every FF Q + last comb gate
  const outSigs: { name: string; sig: number }[] = [];
  ffs.forEach((ff, i) => outSigs.push({ name: `Q${i}`, sig: ff.qSig }));
  outSigs.push({ name: "Y0", sig: combSigs[combSigs.length - 1] });
  lines.push(`part ${outSigs.map((o) => o.name).join(", ")} output-pin`);
  for (const o of outSigs) sigs[o.sig].sinks.push(`${o.name}.in`);

  // Clock net using range syntax `F0..Fn.clk`
  lines.push("");
  lines.push(`net CLK_NET = CLK.clk, F0..F${nFF - 1}.clk`);
  for (const s of sigs) {
    if (s.sinks.length === 0) continue;
    lines.push(`${s.driverRef} -> ${s.sinks.join(", ")}`);
  }

  const totalSigs = sigs.length;
  const vals = new Array<Bin>(totalSigs).fill(0);
  const evalComb = (inputs: Record<string, Bin>): Record<string, Bin> => {
    for (let i = 0; i < nIn; i++) vals[inSigs[i]] = inputs[inputNames[i]] ?? 0;
    const rstVal: Bin = useRst ? (inputs["RST"] ?? 0) : 0;
    if (rstSig >= 0) vals[rstSig] = rstVal;
    if (rstInvSig >= 0) vals[rstInvSig] = bNot(rstVal);
    if (rstVal === 1) {
      for (const ff of ffs) if (ff.hasAsyncRst) ff.state = 0;
    }
    for (const ff of ffs) {
      vals[ff.qSig] = ff.state;
      vals[ff.qnSig] = bNot(ff.state);
    }
    for (const op of combOps) op(vals);
    const out: Record<string, Bin> = {};
    for (const o of outSigs) out[o.name] = vals[o.sig];
    return out;
  };

  const stepAndEval = (inputs: Record<string, Bin>, edge: boolean): Record<string, Bin> => {
    const pre = evalComb(inputs);
    if (!edge) return pre;
    const rstVal: Bin = useRst ? (inputs["RST"] ?? 0) : 0;
    const nexts: Bin[] = ffs.map((ff) => {
      if (ff.hasAsyncRst && rstVal === 1) return 0;
      const en: Bin = ff.enSig >= 0 ? vals[ff.enSig] : 1;
      if (en === 0) return ff.state;
      if (ff.kind === "d-ff") return vals[ff.in0];
      if (ff.kind === "t-ff") return bXor([vals[ff.in0], ff.state]);
      const j = vals[ff.in0], k = vals[ff.in1];
      return bOr([bAnd([j, bNot(ff.state)]), bAnd([bNot(k), ff.state])]);
    });
    ffs.forEach((ff, i) => (ff.state = nexts[i]));
    return evalComb(inputs);
  };

  return {
    source: lines.join("\n") + "\n",
    inputNames,
    outputNames: outSigs.map((o) => o.name),
    stepAndEval,
  };
}

describe("2. end-to-end fuzzing through DSpec", () => {
  it("compiles random combinational DSpec sources, matches reference evaluation, and round-trips through circuitText()", { timeout: 15000 }, () => {
    let compiled = 0;
    let roundTripped = 0;
    const totalSeeds = 40;

    for (let seed = 1; seed <= totalSeeds; seed++) {
      // Mix clean routing + compaction on smaller circuits with fast tunnel routing on bulk fuzz seeds
      const routeMode = seed <= 6 ? "clean" : "tunnel";
      const compactMode = seed <= 2 ? "end" : "never";
      const maxGates = seed <= 6 ? 7 : 14;
      const gen = generateRandomDspecComb(2000 + seed, compactMode, routeMode, maxGates);
      const res = compileSpec(gen.source);
      if (!res.doc) continue;
      compiled++;

      const c1 = extractCircuit(res.doc);
      const sim1 = new Simulator(c1);

      // Round-trip through circuitText(extractCircuit(doc))
      const text2 = circuitText(c1);
      // Run unmodified circuitText() directly (default @compact end / @route clean) on first 2 seeds,
      // and fast tunnel recompile on the remaining seeds so the whole file stays under 20s.
      const res2 = compileSpec(seed <= 2 ? text2 : `@compact never\n@budget ms=50\n@route tunnel\n${text2}`);
      const errs2 = res2.diagnostics.filter((d) => d.severity === "error");
      expect(errs2, `circuitText recompile failed for seed=${seed}:\n${text2}`).toEqual([]);
      expect(res2.doc).not.toBeNull();
      roundTripped++;

      const c2 = extractCircuit(res2.doc!);
      const sim2 = new Simulator(c2);

      const rng = new Rng(7777 + seed);
      for (let t = 0; t < 16; t++) {
        const vec: Record<string, Bin> = {};
        for (const nm of gen.inputNames) {
          const b: Bin = rng.bool(0.5) ? 1 : 0;
          vec[nm] = b;
          sim1.set(nm, b);
          sim2.set(nm, b);
        }
        const r1 = sim1.settle();
        const r2 = sim2.settle();
        expect(r1.stable).toBe(true);
        expect(r2.stable).toBe(true);
        expect(r1.issues).toEqual([]);
        expect(r2.issues).toEqual([]);

        const refOut = gen.evalRef(vec);
        for (const outNm of gen.outputNames) {
          const v1 = sim1.read(outNm);
          const v2 = sim2.read(outNm);
          expect(v1, `seed=${seed} t=${t} out=${outNm} sim1 vs ref`).toBe(refOut[outNm]);
          expect(v2, `seed=${seed} t=${t} out=${outNm} circuitText sim2 vs sim1`).toBe(v1);
        }
      }
    }

    // Ensure the vast majority of random DSpec circuits compiled cleanly
    expect(compiled).toBeGreaterThanOrEqual(34);
    expect(roundTripped).toBe(compiled);
  });

  it("compiles random sequential DSpec sources, matches reference over 40 cycles, and round-trips through circuitText()", { timeout: 15000 }, () => {
    let compiled = 0;
    const totalSeeds = 25;

    for (let seed = 1; seed <= totalSeeds; seed++) {
      const routeMode = seed <= 4 ? "clean" : "tunnel";
      const compactMode = seed <= 2 ? "end" : "never";
      const gen = generateRandomDspecSeq(3000 + seed, compactMode, routeMode, seed <= 4);
      const res = compileSpec(gen.source);
      if (!res.doc) continue;
      compiled++;

      const c1 = extractCircuit(res.doc);
      const sim1 = new Simulator(c1, { initial: "zero" });

      const text2 = circuitText(c1);
      const res2 = compileSpec(seed <= 2 ? text2 : `@compact never\n@budget ms=50\n@route tunnel\n${text2}`);
      const errs2 = res2.diagnostics.filter((d) => d.severity === "error");
      expect(errs2, `seq circuitText recompile failed for seed=${seed}:\n${text2}`).toEqual([]);
      expect(res2.doc).not.toBeNull();

      const c2 = extractCircuit(res2.doc!);
      const sim2 = new Simulator(c2, { initial: "zero" });

      sim1.set("CLK", 0);
      sim2.set("CLK", 0);
      if (gen.inputNames.includes("RST")) {
        sim1.set("RST", 0);
        sim2.set("RST", 0);
      }
      sim1.settle();
      sim2.settle();

      const rng = new Rng(8888 + seed);
      for (let cyc = 0; cyc < 40; cyc++) {
        const vec: Record<string, Bin> = {};
        for (const nm of gen.inputNames) {
          const b: Bin = nm === "RST" ? (rng.bool(0.08) ? 1 : 0) : rng.bool(0.5) ? 1 : 0;
          vec[nm] = b;
          sim1.set(nm, b);
          sim2.set(nm, b);
        }
        sim1.settle();
        sim2.settle();
        const preRef = gen.stepAndEval(vec, false);
        for (const o of gen.outputNames) {
          expect(sim1.read(o), `seed=${seed} cyc=${cyc} pre ${o}`).toBe(preRef[o]);
          expect(sim2.read(o), `seed=${seed} cyc=${cyc} pre-rt ${o}`).toBe(preRef[o]);
        }

        sim1.set("CLK", 1);
        sim2.set("CLK", 1);
        const r1 = sim1.settle();
        const r2 = sim2.settle();
        expect(r1.stable).toBe(true);
        expect(r2.stable).toBe(true);
        expect(r1.issues).toEqual([]);
        expect(r2.issues).toEqual([]);

        const postRef = gen.stepAndEval(vec, true);
        for (const o of gen.outputNames) {
          expect(sim1.read(o), `seed=${seed} cyc=${cyc} post ${o}`).toBe(postRef[o]);
          expect(sim2.read(o), `seed=${seed} cyc=${cyc} post-rt ${o}`).toBe(postRef[o]);
        }

        sim1.set("CLK", 0);
        sim2.set("CLK", 0);
        sim1.settle();
        sim2.settle();
      }
    }

    expect(compiled).toBeGreaterThanOrEqual(20);
  });

  it("compiles a multi-bit bus + splitter + register + counter DSpec circuit and preserves simulation through circuitText() round-trip", () => {
    const source = [
      `@name "bus_seq_rt"`,
      `@compact never`,
      `@budget ms=50`,
      `part CLK clock`,
      `part EN, RST input-pin`,
      `part CNT counter bits=4 pinMode=bus enable=true reset=true carryOut=true`,
      `part REG register width=4 pinMode=bus enable=true reset=true`,
      `part ADD adder width=4 pinMode=bus carryIn=false carryOut=false`,
      `part K1 constant value=3 width=4`,
      `part QCNT, QREG, QSUM output-pin width=4`,
      `part RCO output-pin`,
      ``,
      `net CLK_N = CLK.clk, CNT.clk, REG.clk`,
      `net EN_N = EN.out, CNT.en, REG.en`,
      `net RST_N = RST.out, CNT.rst, REG.rst`,
      `CNT.q -> ADD.a, QCNT.in`,
      `K1.out -> ADD.b`,
      `ADD.s -> REG.d, QSUM.in`,
      `REG.q -> QREG.in`,
      `CNT.rco -> RCO.in`,
    ].join("\n");

    const res1 = compileSpec(source);
    expect(res1.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res1.doc).not.toBeNull();

    const c1 = extractCircuit(res1.doc!);
    const text2 = circuitText(c1);
    const res2 = compileSpec(text2);
    expect(res2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res2.doc).not.toBeNull();
    const c2 = extractCircuit(res2.doc!);

    const s1 = new Simulator(c1, { initial: "zero" });
    const s2 = new Simulator(c2, { initial: "zero" });

    // Independent reference state
    let cnt = 0;
    let reg = 0;
    const rng = new Rng(4242);

    for (const s of [s1, s2]) {
      s.set("CLK", 0);
      s.set("EN", 0);
      s.set("RST", 0);
      s.settle();
    }

    for (let cyc = 0; cyc < 50; cyc++) {
      const en = rng.bool(0.75) ? 1 : 0;
      const rst = rng.bool(0.1) ? 1 : 0;
      for (const s of [s1, s2]) {
        s.set("EN", en);
        s.set("RST", rst);
        s.settle();
      }
      const preSum = (cnt + 3) & 0xf;
      const preRco = cnt === 15 && en === 1 ? 1 : 0;
      for (const s of [s1, s2]) {
        expect(s.read("QCNT")).toBe(cnt);
        expect(s.read("QREG")).toBe(reg);
        expect(s.read("QSUM")).toBe(preSum);
        expect(s.read("RCO")).toBe(preRco);
      }

      // Clock edge
      const nextReg = rst ? 0 : en ? preSum : reg;
      const nextCnt = rst ? 0 : en ? (cnt + 1) & 0xf : cnt;
      cnt = nextCnt;
      reg = nextReg;

      for (const s of [s1, s2]) {
        s.set("CLK", 1);
        expect(s.settle().issues).toEqual([]);
        expect(s.read("QCNT")).toBe(cnt);
        expect(s.read("QREG")).toBe(reg);
        expect(s.read("QSUM")).toBe((cnt + 3) & 0xf);
        expect(s.read("RCO")).toBe(cnt === 15 && en === 1 ? 1 : 0);
        s.set("CLK", 0);
        s.settle();
      }
    }
  });

  it("preserves extracted circuit and simulation across DSpec layout/rotation/label variations and keeps structuralKey invariant to moves/rotations/labels", () => {
    const base = [
      `@compact never`,
      `part A, B input-pin`,
      `part G1 xor`,
      `part G2 and`,
      `part Y output-pin`,
      `A -> G1.in0, G2.in0`,
      `B -> G1.in1`,
      `G1 -> G2.in1`,
      `G2 -> Y`,
    ].join("\n");

    const variant = [
      `@compact never`,
      `@layout grid`,
      `part A input-pin rot=0`,
      `part B input-pin rot=0`,
      `part G1 xor rot=90 label="my_xor"`,
      `part G2 and rot=180 mirror label="my_and"`,
      `part Y output-pin`,
      `A -> G1.in0, G2.in0`,
      `B -> G1.in1`,
      `G1 -> G2.in1`,
      `G2 -> Y`,
    ].join("\n");

    const d1 = compileSpec(base).doc!;
    const d2 = compileSpec(variant).doc!;
    expect(d1).not.toBeNull();
    expect(d2).not.toBeNull();

    // Moving, rotating, and relabeling parts in place never changes structuralKey
    const mutated = structuredClone(d1);
    for (const c of mutated.components) {
      c.x += 50;
      c.y -= 30;
      c.rotation = 90;
      if (c.type !== "tunnel") c.label = `lbl_${c.id}`;
    }
    expect(structuralKey(mutated)).toBe(structuralKey(d1));

    // Even when DSpec falls back to tunnels under grid/rotation, extracted circuit simulates identically
    const s1 = new Simulator(extractCircuit(d1));
    const s2 = new Simulator(extractCircuit(d2));
    for (let m = 0; m < 4; m++) {
      const a = m & 1, b = (m >> 1) & 1;
      s1.set("A", a); s1.set("B", b); s1.settle();
      s2.set("A", a); s2.set("B", b); s2.settle();
      expect(s2.read("Y")).toBe(s1.read("Y"));
      expect(s1.read("Y")).toBe(a & (a ^ b));
    }
  });
});

// ============================================================================
// 3. Timing Semantics
// ============================================================================

describe("3. timing semantics", () => {
  it("pipeline: flip-flops on the same clock sample pre-edge combinational values together (exactly 1 cycle per stage, independent of cone depth or part order)", () => {
    // Stage 1: F1 captures A, F2 captures B
    // Comb cone between stage 1 and stage 2: XOR -> 6-inverter chain (identity) -> F3
    // Stage 3: F3 -> NOT -> F4
    const buildPipeline = (reverseParts: boolean): SchematicDocument => {
      const parts: PartSpec[] = [
        ["CLK", "clock"],
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["F1", "d-ff"],
        ["F2", "d-ff"],
        ["X", "xor"],
        ["N0", "not"],
        ["N1", "not"],
        ["N2", "not"],
        ["N3", "not"],
        ["N4", "not"],
        ["N5", "not"],
        ["F3", "d-ff"],
        ["INV", "not"],
        ["F4", "d-ff"],
        ["Q1", "output-pin"],
        ["Q2", "output-pin"],
        ["Q3", "output-pin"],
        ["Q4", "output-pin"],
      ];
      const ordered = reverseParts ? parts.slice().reverse() : parts;
      return mkDoc(ordered, [
        ["CLK.clk", "F1.clk", "F2.clk", "F3.clk", "F4.clk"],
        ["A.out", "F1.d"],
        ["B.out", "F2.d"],
        ["F1.q", "X.in0", "Q1.in"],
        ["F2.q", "X.in1", "Q2.in"],
        ["X.out", "N0.in0"],
        ["N0.out", "N1.in0"],
        ["N1.out", "N2.in0"],
        ["N2.out", "N3.in0"],
        ["N3.out", "N4.in0"],
        ["N4.out", "N5.in0"],
        ["N5.out", "F3.d"],
        ["F3.q", "INV.in0", "Q3.in"],
        ["INV.out", "F4.d"],
        ["F4.q", "Q4.in"],
      ]);
    };

    const sFwd = new Simulator(extractCircuit(buildPipeline(false)), { initial: "zero" });
    const sRev = new Simulator(extractCircuit(buildPipeline(true)), { initial: "zero" });

    for (const s of [sFwd, sRev]) {
      s.set("CLK", 0);
      s.set("A", 0);
      s.set("B", 0);
      expect(s.settle().issues).toEqual([]);
    }

    let q1 = 0, q2 = 0, q3 = 0, q4 = 0;
    const rng = new Rng(31415);

    for (let cyc = 0; cyc < 50; cyc++) {
      const a = rng.bool(0.5) ? 1 : 0;
      const b = rng.bool(0.5) ? 1 : 0;
      for (const s of [sFwd, sRev]) {
        s.set("A", a);
        s.set("B", b);
        s.settle();
        s.set("CLK", 1);
        expect(s.settle().issues).toEqual([]);
        s.set("CLK", 0);
        s.settle();
      }
      // All stages sample pre-edge values simultaneously
      const nextQ4 = 1 - q3;
      const nextQ3 = q1 ^ q2;
      const nextQ1 = a;
      const nextQ2 = b;
      q1 = nextQ1;
      q2 = nextQ2;
      q3 = nextQ3;
      q4 = nextQ4;

      expect([sFwd.read("Q1"), sFwd.read("Q2"), sFwd.read("Q3"), sFwd.read("Q4")]).toEqual([q1, q2, q3, q4]);
      expect([sRev.read("Q1"), sRev.read("Q2"), sRev.read("Q3"), sRev.read("Q4")]).toEqual([q1, q2, q3, q4]);
    }
  });

  it("gated clock (CLK AND EN): blocks edges when EN=0, samples in the same wave as ungated FFs when EN=1 before CLK rise, and clocks on EN 0->1 while CLK=1", () => {
    // F1 is directly on CLK; F2 is on GCLK = CLK AND EN and samples F1.q.
    // Because the combinational AND gate settles before stateful parts run:
    //  - When EN=1 before CLK rises, F1 and F2 sample in the SAME wave (F2 captures OLD F1.q).
    //  - When EN=0, CLK edges do not clock F2.
    //  - When CLK=1 and EN rises 0->1, GCLK rises 0->1 and clocks F2 (capturing CURRENT F1.q).
    const doc = mkDoc(
      [
        ["CLK", "clock"],
        ["D", "input-pin"],
        ["EN", "input-pin"],
        ["G", "and"],
        ["F1", "d-ff"],
        ["F2", "d-ff"],
        ["Q1", "output-pin"],
        ["Q2", "output-pin"],
      ],
      [
        ["CLK.clk", "F1.clk", "G.in0"],
        ["EN.out", "G.in1"],
        ["G.out", "F2.clk"],
        ["D.out", "F1.d"],
        ["F1.q", "F2.d", "Q1.in"],
        ["F2.q", "Q2.in"],
      ],
    );

    const runTrace = () => {
      const s = new Simulator(extractCircuit(doc), { initial: "zero" });
      const trace: [number | null, number | null][] = [];
      s.set("CLK", 0);
      s.set("D", 0);
      s.set("EN", 0);
      s.settle();

      // Cycle 1: D=1, EN=0 -> F1 captures 1, F2 stays 0 (clock gated off)
      s.set("D", 1);
      s.settle();
      s.set("CLK", 1);
      expect(s.settle().issues).toEqual([]);
      expect([s.read("Q1"), s.read("Q2")]).toEqual([1, 0]);
      trace.push([s.read("Q1"), s.read("Q2")]);

      // Mid-cycle while CLK=1: EN rises 0->1 -> GCLK rises 0->1 -> F2 clocks immediately and captures F1.q=1
      s.set("EN", 1);
      expect(s.settle().issues).toEqual([]);
      expect([s.read("Q1"), s.read("Q2")]).toEqual([1, 1]);
      trace.push([s.read("Q1"), s.read("Q2")]);

      // CLK falls 1->0 (GCLK falls 1->0, no rising edge)
      s.set("CLK", 0);
      s.settle();
      expect([s.read("Q1"), s.read("Q2")]).toEqual([1, 1]);

      // Cycle 2: D=0, EN=1 (stable before CLK rise) -> BOTH F1 and F2 sample in same wave:
      // F1 captures 0, F2 captures OLD F1.q (1), NOT the new 0!
      s.set("D", 0);
      s.settle();
      s.set("CLK", 1);
      expect(s.settle().issues).toEqual([]);
      expect([s.read("Q1"), s.read("Q2")]).toEqual([0, 1]);
      trace.push([s.read("Q1"), s.read("Q2")]);
      s.set("CLK", 0);
      s.settle();

      // Cycle 3: D=1, EN=1 -> F1 captures 1, F2 captures OLD F1.q (0)
      s.set("D", 1);
      s.settle();
      s.set("CLK", 1);
      expect(s.settle().issues).toEqual([]);
      expect([s.read("Q1"), s.read("Q2")]).toEqual([1, 0]);
      trace.push([s.read("Q1"), s.read("Q2")]);
      s.set("CLK", 0);
      s.settle();

      // Toggling EN while CLK=0 never clocks F2
      s.set("EN", 0);
      s.settle();
      s.set("EN", 1);
      s.settle();
      s.set("EN", 0);
      s.settle();
      expect([s.read("Q1"), s.read("Q2")]).toEqual([1, 0]);
      trace.push([s.read("Q1"), s.read("Q2")]);

      return trace;
    };

    // Deterministic across repeated runs
    const t1 = runTrace();
    const t2 = runTrace();
    expect(t2).toEqual(t1);

    // Also test a FF-driven clock gate (GCLK = CLK AND F1.q): when F1.q rises 0->1 on CLK edge
    // while CLK stays 1, GCLK rises 0->1 in the follow-up comb wave and clocks F2 in the same settle().
    const docFfGate = mkDoc(
      [
        ["CLK", "clock"],
        ["D1", "input-pin"],
        ["D2", "input-pin"],
        ["G", "and"],
        ["F1", "d-ff"],
        ["F2", "d-ff"],
        ["Q1", "output-pin"],
        ["Q2", "output-pin"],
      ],
      [
        ["CLK.clk", "F1.clk", "G.in0"],
        ["D1.out", "F1.d"],
        ["F1.q", "G.in1", "Q1.in"],
        ["G.out", "F2.clk"],
        ["D2.out", "F2.d"],
        ["F2.q", "Q2.in"],
      ],
    );
    const sg = new Simulator(extractCircuit(docFfGate), { initial: "zero" });
    sg.set("CLK", 0);
    sg.set("D1", 1);
    sg.set("D2", 1);
    sg.settle();
    expect([sg.read("Q1"), sg.read("Q2")]).toEqual([0, 0]);
    sg.set("CLK", 1);
    expect(sg.settle().issues).toEqual([]);
    // F1.q transitions 0->1 while CLK=1 -> GCLK transitions 0->1 -> F2 clocks in same settle()
    expect([sg.read("Q1"), sg.read("Q2")]).toEqual([1, 1]);
  });

  it("ripple stage (FF clocked by another FF's Q/Q'): cascades within the same settle(), and downstream FF samples post-edge upstream outputs", () => {
    // 4-bit ripple counter: T0..T3 (T=1), T0 clocked by CLK, T{k} clocked by T{k-1}.qn
    // Every carry ripples through subsequent sequential phases in the SAME settle().
    const docRippleCounter = mkDoc(
      [
        ["CLK", "clock"],
        ["ONE", "vcc"],
        ["T0", "t-ff"],
        ["T1", "t-ff"],
        ["T2", "t-ff"],
        ["T3", "t-ff"],
        ["Q0", "output-pin"],
        ["Q1", "output-pin"],
        ["Q2", "output-pin"],
        ["Q3", "output-pin"],
      ],
      [
        ["CLK.clk", "T0.clk"],
        ["ONE.vcc", "T0.t", "T1.t", "T2.t", "T3.t"],
        ["T0.qn", "T1.clk"],
        ["T1.qn", "T2.clk"],
        ["T2.qn", "T3.clk"],
        ["T0.q", "Q0.in"],
        ["T1.q", "Q1.in"],
        ["T2.q", "Q2.in"],
        ["T3.q", "Q3.in"],
      ],
    );

    const s1 = new Simulator(extractCircuit(docRippleCounter), { initial: "zero" });
    const s2 = new Simulator(extractCircuit(docRippleCounter), { initial: "zero" });
    for (const s of [s1, s2]) {
      s.set("CLK", 0);
      expect(s.settle().issues).toEqual([]);
    }

    for (let step = 1; step <= 32; step++) {
      for (const s of [s1, s2]) {
        s.set("CLK", 1);
        const r = s.settle();
        expect(r.stable).toBe(true);
        expect(r.issues).toEqual([]);
        const count =
          (s.read("Q0")! << 0) |
          (s.read("Q1")! << 1) |
          (s.read("Q2")! << 2) |
          (s.read("Q3")! << 3);
        expect(count).toBe(step % 16);
        s.set("CLK", 0);
        s.settle();
      }
    }

    // Also verify direct Q-clocked ripple stage: F2 clocked by F1.q, with F2.d = NOT(F1.q) XOR X.
    // When F1.q rises 0->1 on CLK edge, F1 updates in seq wave 1, comb logic settles with F1.q=1,
    // and F2 triggers in seq wave 2 of the SAME settle(), sampling the post-edge value (0 XOR X = X).
    const docDirect = mkDoc(
      [
        ["CLK", "clock"],
        ["D", "input-pin"],
        ["X", "input-pin"],
        ["F1", "d-ff"],
        ["INV", "not"],
        ["G", "xor"],
        ["F2", "d-ff"],
        ["Q1", "output-pin"],
        ["Q2", "output-pin"],
      ],
      [
        ["CLK.clk", "F1.clk"],
        ["D.out", "F1.d"],
        ["F1.q", "F2.clk", "INV.in0", "Q1.in"],
        ["INV.out", "G.in0"],
        ["X.out", "G.in1"],
        ["G.out", "F2.d"],
        ["F2.q", "Q2.in"],
      ],
    );

    const sd = new Simulator(extractCircuit(docDirect), { initial: "zero" });
    sd.set("CLK", 0);
    sd.set("D", 0);
    sd.set("X", 1);
    sd.settle();

    // D=1, X=1 -> CLK rises -> F1.q goes 0->1 -> INV=0 -> G=0^1=1 -> F2 clocks in same settle and captures 1
    sd.set("D", 1);
    sd.settle();
    sd.set("CLK", 1);
    expect(sd.settle().issues).toEqual([]);
    expect([sd.read("Q1"), sd.read("Q2")]).toEqual([1, 1]);
    sd.set("CLK", 0);
    sd.settle();

    // D=0, X=0 -> CLK rises -> F1.q goes 1->0 (falling edge on F2.clk -> F2 holds 1)
    sd.set("D", 0);
    sd.set("X", 0);
    sd.settle();
    sd.set("CLK", 1);
    sd.settle();
    expect([sd.read("Q1"), sd.read("Q2")]).toEqual([0, 1]);
    sd.set("CLK", 0);
    sd.settle();

    // D=1, X=0 -> CLK rises -> F1.q goes 0->1 -> INV=0 -> G=0^0=0 -> F2 clocks in same settle and captures 0
    sd.set("D", 1);
    sd.settle();
    sd.set("CLK", 1);
    sd.settle();
    expect([sd.read("Q1"), sd.read("Q2")]).toEqual([1, 0]);
  });

  it("input changed in the same settle() as clock edge: combinational inputs settle before stateful parts evaluate, so the new input is captured on that edge regardless of set() call order", () => {
    // Test both direct input -> F1.d and multi-gate combinational cone (4 gates deep) -> F2.d
    const doc = mkDoc(
      [
        ["CLK", "clock"],
        ["D", "input-pin"],
        ["B0", "not"],
        ["B1", "not"],
        ["B2", "not"],
        ["B3", "not"],
        ["F1", "d-ff"],
        ["F2", "d-ff"],
        ["Q1", "output-pin"],
        ["Q2", "output-pin"],
      ],
      [
        ["CLK.clk", "F1.clk", "F2.clk"],
        ["D.out", "F1.d", "B0.in0"],
        ["B0.out", "B1.in0"],
        ["B1.out", "B2.in0"],
        ["B2.out", "B3.in0"],
        ["B3.out", "F2.d"],
        ["F1.q", "Q1.in"],
        ["F2.q", "Q2.in"],
      ],
    );

    const sOrderA = new Simulator(extractCircuit(doc), { initial: "zero" });
    const sOrderB = new Simulator(extractCircuit(doc), { initial: "zero" });
    for (const s of [sOrderA, sOrderB]) {
      s.set("CLK", 0);
      s.set("D", 0);
      s.settle();
    }

    const rng = new Rng(27182);
    for (let cyc = 0; cyc < 50; cyc++) {
      const nextD = rng.bool(0.5) ? 1 : 0;

      // Order A: set D then set CLK=1 in the same settle()
      sOrderA.set("D", nextD);
      sOrderA.set("CLK", 1);
      const rA = sOrderA.settle();
      expect(rA.stable).toBe(true);
      expect(rA.issues).toEqual([]);

      // Order B: set CLK=1 then set D in the same settle()
      sOrderB.set("CLK", 1);
      sOrderB.set("D", nextD);
      const rB = sOrderB.settle();
      expect(rB.stable).toBe(true);
      expect(rB.issues).toEqual([]);

      // Both capture the NEW value of D on this edge, even through the 4-gate chain
      expect(sOrderA.read("Q1")).toBe(nextD);
      expect(sOrderA.read("Q2")).toBe(nextD);
      expect(sOrderB.read("Q1")).toBe(nextD);
      expect(sOrderB.read("Q2")).toBe(nextD);

      // Return clock low
      sOrderA.set("CLK", 0);
      sOrderB.set("CLK", 0);
      sOrderA.settle();
      sOrderB.settle();
    }
  });
});

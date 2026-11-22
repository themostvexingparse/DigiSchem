/**
 * Soundness of unknown values, for every combinational model: when some inputs are X and an
 * output bit is still known, every way of replacing the X inputs with 0 or 1 must give that same
 * bit. (A model may be pessimistic, giving X where the value is actually known, but it must never
 * claim a value that some input could contradict.)
 */
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { getDef } from "../src/model/registry";
import type { PropValue } from "../src/model/types";
import { bench } from "./helpers/sim-harness";
import { Rng } from "./helpers/sim-gen";
import type { Bit } from "../src/logic/simulate";

registerBuiltinComponents();

const CASES: [string, Record<string, PropValue>][] = [
  ["and", { inputs: 3 }], ["nand", { inputs: 4 }], ["or", { inputs: 3 }], ["nor", { inputs: 2 }], ["xor", { inputs: 3 }], ["xnor", { inputs: 2 }],
  ["not", {}], ["buf", {}], ["schmitt-buffer", {}], ["schmitt-inverter", {}],
  ["aoi", { kind: "aoi21" }], ["aoi", { kind: "aoi22" }], ["aoi", { kind: "oai21" }], ["aoi", { kind: "oai22" }],
  ["mux", { selectBits: 2, dataWidth: 2, enable: true }], ["mux", { selectBits: 1, dataWidth: 3, selectMode: "bus" }],
  ["demux", { selectBits: 2, dataWidth: 1, enable: true }], ["decoder", { inputs: 2, enable: true, activeLowOutputs: true }], ["decoder", { inputs: 3, enable: false }],
  ["encoder", { outputBits: 2, priority: true, validOut: true, enable: true }], ["encoder", { outputBits: 2, priority: false, validOut: true }],
  ["tristate", { width: 2, activeLowEnable: true, invertedOut: true }], ["bcd-7seg", { pinMode: "bits", controls: true, activeLow: false }], ["bcd-7seg", { pinMode: "bus", activeLow: true }],
  ["bit-selector", { width: 4 }], ["gray-converter", { width: 4, direction: "toGray" }], ["gray-converter", { width: 4, direction: "toBinary", pinMode: "bus" }],
  ["half-adder", {}], ["full-adder", {}], ["adder", { width: 3, pinMode: "bits" }], ["subtractor", { width: 3, pinMode: "bits", borrowIn: true }],
  ["comparator", { width: 3, pinMode: "bits", signed: true }], ["alu", { width: 3, opBits: 3, opPinMode: "bits" }], ["shifter", { width: 4, shiftBits: 2, pinMode: "bits", mode: "universal" }],
  ["multiplier", { width: 2, pinMode: "bits" }], ["incrementer", { width: 3, pinMode: "bits" }], ["decrementer", { width: 3, pinMode: "bits" }], ["negator", { width: 3, pinMode: "bits" }],
  ["divider", { width: 2, pinMode: "bits" }], ["bit-extender", { inWidth: 3, outWidth: 5, mode: "sign" }], ["parity", { inputs: 4 }], ["bit-counter", { width: 4, pinMode: "bits" }],
  ["carry-lookahead", {}], ["rom", { addressBits: 2, dataWidth: 2, pinMode: "bits", chipSelect: true, contents: "0 1 2 3" }],
];

describe("unknown inputs never give a wrong known output", () => {
  for (const [type, props] of CASES) {
    it(`${type} ${JSON.stringify(props)}`, () => {
      const def = getDef(type)!;
      const pins = def.geometry({ ...def.defaultProps, ...props }).pins;
      const ins = pins.filter((p) => p.dir === "in");
      const outs = pins.filter((p) => p.dir === "out");
      const b = bench(type, props);
      const rng = new Rng(type.length * 977 + JSON.stringify(props).length);
      const bad: string[] = [];
      const apply = (vals: Bit[][]) => ins.forEach((p, i) => b.sim.set(`T_${p.id}`, vals[i]));
      const read = () => outs.map((p) => b.sim.pinBits(`T_${p.id}`, "in"));
      for (let t = 0; t < 120 && bad.length < 3; t++) {
        // a random input with a few unknown bits
        const vals: Bit[][] = ins.map((p) => Array.from({ length: p.width ?? 1 }, () => (rng.bool(0.3) ? 2 : rng.int(0, 1)) as Bit));
        apply(vals);
        b.settle();
        const withX = read();
        // every refinement (up to 64 of them, else a random 64)
        const unknown: [number, number][] = [];
        vals.forEach((v, i) => v.forEach((x, j) => x === 2 && unknown.push([i, j])));
        const total = 2 ** unknown.length;
        for (let k = 0; k < Math.min(total, 64) && bad.length < 3; k++) {
          const m = total <= 64 ? k : rng.int(0, total - 1);
          const r = vals.map((v) => [...v]);
          unknown.forEach(([i, j], q) => (r[i][j] = ((m >> q) & 1) as Bit));
          apply(r);
          b.settle();
          const got = read();
          withX.forEach((bits, o) =>
            bits.forEach((x, j) => {
              if (x > 1) return; // X or Z with unknown inputs: nothing claimed
              if (got[o][j] !== x) bad.push(`${outs[o].id}[${j}] is ${"01XZ"[x]} with inputs ${JSON.stringify(vals)} but ${"01XZ"[got[o][j]]} with ${JSON.stringify(r)}`);
            }),
          );
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

const SEQ_CASES: [string, Record<string, PropValue>][] = [
  ["d-ff", { asyncReset: "active-low", enable: true }], ["jk-ff", { asyncSet: "active-high" }], ["t-ff", { enable: true, edge: "falling" }], ["sr-ff", {}],
  ["d-latch", { width: 2 }], ["sr-latch", { activeLow: true }], ["gated-sr-latch", {}],
  ["register", { width: 3, pinMode: "bits" }], ["counter", { bits: 3, pinMode: "bits", upDown: true, load: true }], ["shift-register", { width: 3, direction: "bidirectional", parallelLoad: true }],
  ["ring-counter", { bits: 3, mode: "johnson", enable: true }], ["lfsr", { bits: 3, pinMode: "bits", enable: true }], ["decade-counter", { pinMode: "bits", load: true }],
  ["synchronizer", { stages: 2 }], ["edge-detector", { detect: "both" }], ["clock-divider", { divisor: 3 }],
  ["fifo", { depth: 2, width: 2 }], ["stack", { depth: 2, width: 2 }], ["ram", { addressBits: 2, dataWidth: 2 }], ["register-file", { addressBits: 1, dataWidth: 2, readPorts: 1, writePorts: 1 }],
];

describe("unknown inputs on a clock step never give a wrong known output", () => {
  for (const [type, props] of SEQ_CASES) {
    it(`${type} ${JSON.stringify(props)}`, { timeout: 30000 }, () => {
      const def = getDef(type)!;
      const pins = def.geometry({ ...def.defaultProps, ...props }).pins;
      const ins = pins.filter((p) => p.dir === "in" && !p.clock);
      const outs = pins.filter((p) => p.dir === "out");
      const rng = new Rng(type.length * 131 + 5);
      const bad: string[] = [];
      for (let t = 0; t < 25 && bad.length < 3; t++) {
        // a history of known steps, then one step with unknown bits
        const history: Bit[][][] = Array.from({ length: rng.int(1, 5) }, () => ins.map((p) => Array.from({ length: p.width ?? 1 }, () => rng.int(0, 1) as Bit)));
        const last: Bit[][] = ins.map((p) => Array.from({ length: p.width ?? 1 }, () => (rng.bool(0.3) ? 2 : rng.int(0, 1)) as Bit));
        const run = (final: Bit[][]) => {
          const b = bench(type, props, { initial: "zero" });
          for (const step of [...history, final]) {
            ins.forEach((p, i) => b.sim.set(`T_${p.id}`, step[i]));
            if (pins.some((p) => p.clock)) b.tick();
            else b.settle(); // a latch has no clock: each step is a settle
          }
          return outs.map((p) => b.sim.pinBits(`T_${p.id}`, "in"));
        };
        const withX = run(last);
        const unknown: [number, number][] = [];
        last.forEach((v, i) => v.forEach((x, j) => x === 2 && unknown.push([i, j])));
        for (let m = 0; m < Math.min(2 ** unknown.length, 16) && bad.length < 3; m++) {
          const r = last.map((v) => [...v]);
          unknown.forEach(([i, j], q) => (r[i][j] = ((m >> q) & 1) as Bit));
          const got = run(r);
          withX.forEach((bits, o) =>
            bits.forEach((x, j) => {
              if (x <= 1 && got[o][j] !== x) bad.push(`${outs[o].id}[${j}] is ${"01XZ"[x]} after ${JSON.stringify(last)} but ${"01XZ"[got[o][j]]} after ${JSON.stringify(r)} (history ${JSON.stringify(history)})`);
            }),
          );
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("with a few unknown inputs, a part without state is exact", () => {
  for (const [type, props] of CASES) {
    it(`${type} ${JSON.stringify(props)}`, () => {
      const def = getDef(type)!;
      const pins = def.geometry({ ...def.defaultProps, ...props }).pins;
      const ins = pins.filter((p) => p.dir === "in");
      const outs = pins.filter((p) => p.dir === "out");
      const b = bench(type, props);
      const rng = new Rng(type.length * 313 + JSON.stringify(props).length);
      const bad: string[] = [];
      const apply = (vals: Bit[][]) => ins.forEach((p, i) => b.sim.set(`T_${p.id}`, vals[i]));
      const read = () => outs.map((p) => b.sim.pinBits(`T_${p.id}`, "in"));
      for (let t = 0; t < 80 && bad.length < 3; t++) {
        const vals: Bit[][] = ins.map((p) => Array.from({ length: p.width ?? 1 }, () => rng.int(0, 1) as Bit));
        // one to four unknown bits
        const unknown: [number, number][] = [];
        for (let k = rng.int(1, 4); k > 0; k--) {
          const i = rng.int(0, ins.length - 1), j = rng.int(0, (ins[i].width ?? 1) - 1);
          if (vals[i][j] !== 2) unknown.push([i, j]);
          vals[i][j] = 2;
        }
        apply(vals);
        b.settle();
        const withX = read();
        let agree: Bit[][] | null = null;
        for (let m = 0; m < 2 ** unknown.length; m++) {
          const r = vals.map((v) => [...v]);
          unknown.forEach(([i, j], q) => (r[i][j] = ((m >> q) & 1) as Bit));
          apply(r);
          b.settle();
          const got = read();
          agree = agree ? agree.map((bits, o) => bits.map((x, j) => (x === got[o][j] ? x : 2))) as Bit[][] : got;
        }
        withX.forEach((bits, o) =>
          bits.forEach((x, j) => {
            const a = agree![o][j];
            if (a <= 1 && x !== a) bad.push(`${outs[o].id}[${j}] is ${"01XZ"[x]} with ${JSON.stringify(vals)}, though every way of filling the X's gives ${a}`);
          }),
        );
      }
      expect(bad).toEqual([]);
    });
  }
});

import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { extractCircuit, structuralKey } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { B0, B1, BX, Simulator, type Bit } from "../src/logic/simulate";
import { outputFunctions, truthTable, truthTableText } from "../src/logic/analyze";
import { evaluateCombinational } from "../src/logic/evaluate";
import { minimize } from "../src/logic/minimize";
import { sopsToSchematic } from "../src/logic/sop-schematic";
import {
  R0,
  R1,
  RX,
  Rng,
  bitsToBigInt,
  boundaryValues,
  buildRippleCarryAdder,
  generateBusPlumbingCircuit,
  generateRandomCombDag,
  mkDoc,
  refAnd,
  refNot,
  refOr,
  refSplitterSlices,
  refXor,
  type PartSpec,
  type RefBit,
} from "./helpers/sim-gen";

registerBuiltinComponents();

type PinMode = "bus" | "bits";

const ALL_WIDTHS = [1, 7, 8, 16, 31, 32] as const;
/** Components whose ComponentDef clamps `width` to min 2 (multiplier, bit-counter, gray-converter). */
const MIN2_WIDTHS = [2, 7, 8, 16, 31, 32] as const;
const PIN_MODES: readonly PinMode[] = ["bus", "bits"];

function wireIn(
  parts: PartSpec[],
  nets: string[][],
  prefix: string,
  compId: string,
  pinPrefix: string,
  width: number,
  mode: PinMode,
): void {
  if (mode === "bus") {
    parts.push([prefix, "input-pin", { name: prefix, width }]);
    nets.push([`${prefix}.out`, `${compId}.${pinPrefix}`]);
  } else {
    for (let i = 0; i < width; i++) {
      const id = `${prefix}_${i}`;
      parts.push([id, "input-pin", { name: id, width: 1 }]);
      nets.push([`${id}.out`, `${compId}.${pinPrefix}${i}`]);
    }
  }
}

function setBus(sim: Simulator, prefix: string, width: number, mode: PinMode, value: bigint): void {
  const u = BigInt.asUintN(width, value);
  if (mode === "bus") {
    sim.set(prefix, Number(u));
  } else {
    for (let i = 0; i < width; i++) {
      sim.set(`${prefix}_${i}`, Number((u >> BigInt(i)) & 1n));
    }
  }
}

function wireOut(
  parts: PartSpec[],
  nets: string[][],
  prefix: string,
  compId: string,
  pinPrefix: string,
  width: number,
  mode: PinMode,
): void {
  if (mode === "bus") {
    // output-pin clamps width to max 32; wider buses (e.g. 64-bit multiplier product) are read directly via pinBits.
    if (width <= 32) {
      parts.push([prefix, "output-pin", { name: prefix, width }]);
      nets.push([`${compId}.${pinPrefix}`, `${prefix}.in`]);
    }
  } else {
    for (let i = 0; i < width; i++) {
      const id = `${prefix}_${i}`;
      parts.push([id, "output-pin", { name: id, width: 1 }]);
      nets.push([`${compId}.${pinPrefix}${i}`, `${id}.in`]);
    }
  }
}

function readBusBits(
  sim: Simulator,
  prefix: string,
  compId: string,
  pinPrefix: string,
  width: number,
  mode: PinMode,
): Bit[] {
  if (mode === "bus") {
    return width <= 32 ? sim.pinBits(prefix, "in") : sim.pinBits(compId, pinPrefix);
  }
  const bits: Bit[] = [];
  for (let i = 0; i < width; i++) {
    bits.push(sim.pinBits(`${prefix}_${i}`, "in")[0]);
  }
  return bits;
}

function readBus(
  sim: Simulator,
  prefix: string,
  compId: string,
  pinPrefix: string,
  width: number,
  mode: PinMode,
): bigint | null {
  return bitsToBigInt(readBusBits(sim, prefix, compId, pinPrefix, width, mode));
}

function makeTestValues(width: number, rng: Rng, randomCount: number): bigint[] {
  const vals = boundaryValues(width);
  for (let i = 0; i < randomCount; i++) vals.push(rng.bigBits(width));
  return vals;
}

// =================================================================================================
// 1. Random combinational DAGs
// =================================================================================================

describe("1. random combinational DAGs", () => {
  it("matches an independent reference evaluator across 20 to 300 gates with zero errors or sim issues", () => {
    const configs = [
      { seed: 101, gateCount: 20, vectors: 32 },
      { seed: 202, gateCount: 50, vectors: 32 },
      { seed: 303, gateCount: 100, vectors: 32 },
      { seed: 404, gateCount: 200, vectors: 32 },
      { seed: 505, gateCount: 300, vectors: 40 },
    ];
    const allSeenTypes = new Set<string>();

    for (const cfg of configs) {
      const dag = generateRandomCombDag({ seed: cfg.seed, gateCount: cfg.gateCount });
      for (const t of dag.partTypesUsed) allSeenTypes.add(t);

      const circuit = extractCircuit(dag.doc);
      const errors = checkCircuit(circuit).filter((i) => i.severity === "error");
      expect(errors, `seed=${cfg.seed} gates=${cfg.gateCount}`).toEqual([]);

      const sim = new Simulator(circuit);
      const vecRng = new Rng(cfg.seed * 7919 + 17);

      for (let v = 0; v < cfg.vectors; v++) {
        const vec: Record<string, RefBit> = {};
        for (const id of dag.inputIds) {
          const bit: RefBit = v === 0 ? R0 : v === 1 ? R1 : vecRng.bool() ? R1 : R0;
          vec[id] = bit;
          sim.set(id, bit);
        }
        const settled = sim.settle();
        expect(settled.stable, `seed=${cfg.seed} vec=${v}`).toBe(true);
        expect(settled.issues, `seed=${cfg.seed} vec=${v}`).toEqual([]);

        const expected = dag.evaluateRef(vec);
        for (const oid of dag.outputIds) {
          expect(sim.read(oid), `seed=${cfg.seed} gates=${cfg.gateCount} vec=${v} out=${oid}`).toBe(expected[oid]);
        }
      }
    }

    // Confirm broad coverage of every required combinational family
    for (const required of [
      "and", "nand", "or", "nor", "xor", "xnor",
      "not", "buf", "schmitt-buffer", "schmitt-inverter",
      "aoi:aoi21", "aoi:aoi22", "aoi:oai21", "aoi:oai22",
      "half-adder", "full-adder", "parity", "bit-selector",
      "constant", "vcc", "ground",
    ]) {
      expect(allSeenTypes.has(required), `missing coverage for ${required}`).toBe(true);
    }
    const typesArr = [...allSeenTypes];
    expect(typesArr.some((t) => t.startsWith("mux:") && t.includes("dw=multi"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("mux:") && t.includes(":bus"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("mux:") && t.includes(":bits"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("mux:") && t.includes("en=true"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("demux:"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("decoder:") && t.includes("low=true"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("decoder:") && t.includes("low=false"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("encoder:") && t.includes("pri=true"))).toBe(true);
    expect(typesArr.some((t) => t.startsWith("encoder:") && t.includes("pri=false"))).toBe(true);
  });
});

// =================================================================================================
// 2. Wide arithmetic (widths 1, 7, 8, 16, 31, 32; bus & bits; BigInt reference)
// =================================================================================================

describe("2. wide arithmetic against BigInt reference", () => {
  it("adder (carryIn on/off, widths 1..32, bus & bits)", () => {
    const rng = new Rng(2001);
    for (const width of ALL_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        for (const carryIn of [true, false]) {
          const parts: PartSpec[] = [["U", "adder", { width, pinMode, carryIn, carryOut: true }]];
          const nets: string[][] = [];
          wireIn(parts, nets, "A", "U", "a", width, pinMode);
          wireIn(parts, nets, "B", "U", "b", width, pinMode);
          if (carryIn) {
            parts.push(["CIN", "input-pin", { name: "CIN", width: 1 }]);
            nets.push(["CIN.out", "U.cin"]);
          }
          wireOut(parts, nets, "S", "U", "s", width, pinMode);
          parts.push(["COUT", "output-pin", { name: "COUT", width: 1 }]);
          nets.push(["U.cout", "COUT.in"]);

          const c = extractCircuit(mkDoc(parts, nets));
          expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
          const sim = new Simulator(c);

          const vals = makeTestValues(width, rng, 6);
          for (let t = 0; t < vals.length; t++) {
            const a = vals[t];
            const b = vals[(t * 3 + 1) % vals.length];
            const cinVals = carryIn ? [0n, 1n] : [0n];
            for (const cin of cinVals) {
              setBus(sim, "A", width, pinMode, a);
              setBus(sim, "B", width, pinMode, b);
              if (carryIn) sim.set("CIN", Number(cin));
              const r = sim.settle();
              expect(r.stable).toBe(true);
              expect(r.issues).toEqual([]);

              const sum = a + b + cin;
              expect(readBus(sim, "S", "U", "s", width, pinMode)).toBe(BigInt.asUintN(width, sum));
              expect(sim.read("COUT")).toBe(sum >> BigInt(width) > 0n ? 1 : 0);
            }
          }
        }
      }
    }
  });

  it("subtractor (borrowIn on/off, widths 1..32, bus & bits)", () => {
    const rng = new Rng(2002);
    for (const width of ALL_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        for (const borrowIn of [false, true]) {
          const parts: PartSpec[] = [["U", "subtractor", { width, pinMode, borrowIn, borrowOut: true }]];
          const nets: string[][] = [];
          wireIn(parts, nets, "A", "U", "a", width, pinMode);
          wireIn(parts, nets, "B", "U", "b", width, pinMode);
          if (borrowIn) {
            parts.push(["BIN", "input-pin", { name: "BIN", width: 1 }]);
            nets.push(["BIN.out", "U.bin"]);
          }
          wireOut(parts, nets, "D", "U", "d", width, pinMode);
          parts.push(["BOUT", "output-pin", { name: "BOUT", width: 1 }]);
          nets.push(["U.bout", "BOUT.in"]);

          const c = extractCircuit(mkDoc(parts, nets));
          expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
          const sim = new Simulator(c);

          const vals = makeTestValues(width, rng, 6);
          for (let t = 0; t < vals.length; t++) {
            const a = vals[t];
            const b = vals[(t * 5 + 2) % vals.length];
            const binVals = borrowIn ? [0n, 1n] : [0n];
            for (const bin of binVals) {
              setBus(sim, "A", width, pinMode, a);
              setBus(sim, "B", width, pinMode, b);
              if (borrowIn) sim.set("BIN", Number(bin));
              const r = sim.settle();
              expect(r.stable).toBe(true);
              expect(r.issues).toEqual([]);

              const diff = a - b - bin;
              expect(readBus(sim, "D", "U", "d", width, pinMode)).toBe(BigInt.asUintN(width, diff));
              expect(sim.read("BOUT")).toBe(diff < 0n ? 1 : 0);
            }
          }
        }
      }
    }
  });

  it("comparator (signed & unsigned, widths 1..32, bus & bits)", () => {
    const rng = new Rng(2003);
    for (const width of ALL_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        for (const signed of [false, true]) {
          const parts: PartSpec[] = [
            ["U", "comparator", { width, pinMode, signed, showGt: true, showEq: true, showLt: true }],
            ["GT", "output-pin", { name: "GT", width: 1 }],
            ["EQ", "output-pin", { name: "EQ", width: 1 }],
            ["LT", "output-pin", { name: "LT", width: 1 }],
          ];
          const nets: string[][] = [
            ["U.gt", "GT.in"],
            ["U.eq", "EQ.in"],
            ["U.lt", "LT.in"],
          ];
          wireIn(parts, nets, "A", "U", "a", width, pinMode);
          wireIn(parts, nets, "B", "U", "b", width, pinMode);

          const c = extractCircuit(mkDoc(parts, nets));
          expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
          const sim = new Simulator(c);

          const vals = makeTestValues(width, rng, 6);
          const pairs: [bigint, bigint][] = [];
          for (let i = 0; i < vals.length; i++) {
            pairs.push([vals[i], vals[i]]); // equality check
            pairs.push([vals[i], vals[(i + 1) % vals.length]]);
            pairs.push([vals[(i + 1) % vals.length], vals[i]]);
          }

          for (const [a, b] of pairs) {
            setBus(sim, "A", width, pinMode, a);
            setBus(sim, "B", width, pinMode, b);
            const r = sim.settle();
            expect(r.stable).toBe(true);
            expect(r.issues).toEqual([]);

            const va = signed ? BigInt.asIntN(width, a) : a;
            const vb = signed ? BigInt.asIntN(width, b) : b;
            expect(sim.read("GT")).toBe(va > vb ? 1 : 0);
            expect(sim.read("EQ")).toBe(va === vb ? 1 : 0);
            expect(sim.read("LT")).toBe(va < vb ? 1 : 0);
          }
        }
      }
    }
  });

  it("incrementer, decrementer, and negator (widths 1..32, bus & bits)", () => {
    const rng = new Rng(2004);
    for (const width of ALL_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        const parts: PartSpec[] = [
          ["INC", "incrementer", { width, pinMode, carryOut: true }],
          ["DEC", "decrementer", { width, pinMode, borrowOut: true }],
          ["NEG", "negator", { width, pinMode }],
          ["COUT", "output-pin", { name: "COUT", width: 1 }],
          ["BOUT", "output-pin", { name: "BOUT", width: 1 }],
        ];
        const nets: string[][] = [
          ["INC.cout", "COUT.in"],
          ["DEC.bout", "BOUT.in"],
        ];
        wireIn(parts, nets, "AI", "INC", "a", width, pinMode);
        wireIn(parts, nets, "AD", "DEC", "a", width, pinMode);
        wireIn(parts, nets, "AN", "NEG", "a", width, pinMode);
        wireOut(parts, nets, "YI", "INC", "y", width, pinMode);
        wireOut(parts, nets, "YD", "DEC", "y", width, pinMode);
        wireOut(parts, nets, "YN", "NEG", "y", width, pinMode);

        const c = extractCircuit(mkDoc(parts, nets));
        expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
        const sim = new Simulator(c);

        for (const a of makeTestValues(width, rng, 8)) {
          setBus(sim, "AI", width, pinMode, a);
          setBus(sim, "AD", width, pinMode, a);
          setBus(sim, "AN", width, pinMode, a);
          const r = sim.settle();
          expect(r.stable).toBe(true);
          expect(r.issues).toEqual([]);

          const inc = a + 1n;
          expect(readBus(sim, "YI", "INC", "y", width, pinMode)).toBe(BigInt.asUintN(width, inc));
          expect(sim.read("COUT")).toBe(inc >> BigInt(width) > 0n ? 1 : 0);

          expect(readBus(sim, "YD", "DEC", "y", width, pinMode)).toBe(BigInt.asUintN(width, a - 1n));
          expect(sim.read("BOUT")).toBe(a === 0n ? 1 : 0);

          expect(readBus(sim, "YN", "NEG", "y", width, pinMode)).toBe(BigInt.asUintN(width, -a));
        }
      }
    }
  });

  it("multiplier (signed & unsigned, fullProduct on/off, widths 2..32, bus & bits)", () => {
    const rng = new Rng(2005);
    for (const width of MIN2_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        for (const signed of [false, true]) {
          for (const fullProduct of [true, false]) {
            const prodW = fullProduct ? 2 * width : width;
            const parts: PartSpec[] = [["U", "multiplier", { width, pinMode, signed, fullProduct }]];
            const nets: string[][] = [];
            wireIn(parts, nets, "A", "U", "a", width, pinMode);
            wireIn(parts, nets, "B", "U", "b", width, pinMode);
            wireOut(parts, nets, "P", "U", "p", prodW, pinMode);

            const c = extractCircuit(mkDoc(parts, nets));
            expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
            const sim = new Simulator(c);

            const vals = makeTestValues(width, rng, 6);
            for (let t = 0; t < vals.length; t++) {
              const a = vals[t];
              const b = vals[(t * 3 + 2) % vals.length];
              setBus(sim, "A", width, pinMode, a);
              setBus(sim, "B", width, pinMode, b);
              const r = sim.settle();
              expect(r.stable).toBe(true);
              expect(r.issues).toEqual([]);

              const raw = signed ? BigInt.asIntN(width, a) * BigInt.asIntN(width, b) : a * b;
              const expected = BigInt.asUintN(prodW, raw);
              expect(readBus(sim, "P", "U", "p", prodW, pinMode)).toBe(expected);
            }
          }
        }
      }
    }
  });

  it("divider (widths 1..32, bus & bits, including division by zero -> X)", () => {
    const rng = new Rng(2006);
    for (const width of ALL_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        const parts: PartSpec[] = [["U", "divider", { width, pinMode }]];
        const nets: string[][] = [];
        wireIn(parts, nets, "A", "U", "a", width, pinMode);
        wireIn(parts, nets, "B", "U", "b", width, pinMode);
        wireOut(parts, nets, "Q", "U", "q", width, pinMode);
        wireOut(parts, nets, "R", "U", "r", width, pinMode);

        const c = extractCircuit(mkDoc(parts, nets));
        expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
        const sim = new Simulator(c);

        const vals = makeTestValues(width, rng, 8);
        // Division by zero yields all-X on Q and R
        setBus(sim, "A", width, pinMode, vals[vals.length - 1]);
        setBus(sim, "B", width, pinMode, 0n);
        const rZero = sim.settle();
        expect(rZero.stable).toBe(true);
        expect(rZero.issues).toEqual([]);
        expect(readBusBits(sim, "Q", "U", "q", width, pinMode).every((b) => b === BX)).toBe(true);
        expect(readBusBits(sim, "R", "U", "r", width, pinMode).every((b) => b === BX)).toBe(true);

        // Non-zero divisors
        for (let t = 0; t < vals.length; t++) {
          const a = vals[t];
          const b = vals[(t * 3 + 1) % vals.length] || 1n;
          setBus(sim, "A", width, pinMode, a);
          setBus(sim, "B", width, pinMode, b);
          const r = sim.settle();
          expect(r.stable).toBe(true);
          expect(r.issues).toEqual([]);
          expect(readBus(sim, "Q", "U", "q", width, pinMode)).toBe(a / b);
          expect(readBus(sim, "R", "U", "r", width, pinMode)).toBe(a % b);
        }
      }
    }
  });

  it("bit-extender (sign, zero, one modes; widening, same-width, and truncation)", () => {
    const rng = new Rng(2007);
    const widthPairs: [number, number][] = [
      [1, 7], [1, 32], [7, 8], [7, 31], [8, 16], [16, 32], [31, 32],
      [8, 8], [32, 32],
      [32, 16], [16, 7], [8, 1],
    ];
    for (const [inWidth, outWidth] of widthPairs) {
      for (const mode of ["sign", "zero", "one"] as const) {
        const doc = mkDoc(
          [
            ["IN", "input-pin", { name: "IN", width: inWidth }],
            ["EXT", "bit-extender", { inWidth, outWidth, mode }],
            ["OUT", "output-pin", { name: "OUT", width: outWidth }],
          ],
          [["IN.out", "EXT.in"], ["EXT.out", "OUT.in"]],
        );
        const c = extractCircuit(doc);
        expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
        const sim = new Simulator(c);

        for (const x of makeTestValues(inWidth, rng, 6)) {
          sim.set("IN", Number(x));
          const r = sim.settle();
          expect(r.stable).toBe(true);
          expect(r.issues).toEqual([]);

          let expected: bigint;
          if (outWidth <= inWidth || mode === "zero") {
            expected = BigInt.asUintN(outWidth, x);
          } else if (mode === "sign") {
            expected = BigInt.asUintN(outWidth, BigInt.asIntN(inWidth, x));
          } else {
            const onesFill = ((1n << BigInt(outWidth - inWidth)) - 1n) << BigInt(inWidth);
            expected = x | onesFill;
          }
          expect(bitsToBigInt(sim.pinBits("OUT", "in"))).toBe(expected);
        }
      }
    }
  });

  it("bit-counter (popcount, widths 2..32, bus & bits)", () => {
    const rng = new Rng(2008);
    const refPopcount = (x: bigint): bigint => {
      let c = 0n;
      for (let v = x; v > 0n; v &= v - 1n) c++;
      return c;
    };

    for (const width of MIN2_WIDTHS) {
      const countW = Math.max(1, Math.ceil(Math.log2(width + 1)));
      for (const pinMode of PIN_MODES) {
        const parts: PartSpec[] = [["POP", "bit-counter", { width, pinMode }]];
        const nets: string[][] = [];
        wireIn(parts, nets, "A", "POP", "a", width, pinMode);
        // bit-counter's `count` pin is always a bus pin
        wireOut(parts, nets, "CNT", "POP", "count", countW, "bus");

        const c = extractCircuit(mkDoc(parts, nets));
        expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
        const sim = new Simulator(c);

        for (const a of makeTestValues(width, rng, 10)) {
          setBus(sim, "A", width, pinMode, a);
          const r = sim.settle();
          expect(r.stable).toBe(true);
          expect(r.issues).toEqual([]);
          expect(readBus(sim, "CNT", "POP", "count", countW, "bus")).toBe(refPopcount(a));
        }
      }
    }
  });

  it("gray-converter (toGray, toBinary, and roundtrip identity, widths 2..32, bus & bits)", () => {
    const rng = new Rng(2009);
    const refToGray = (x: bigint): bigint => x ^ (x >> 1n);
    const refToBinary = (g: bigint): bigint => {
      let b = 0n;
      for (let v = g; v > 0n; v >>= 1n) b ^= v;
      return b;
    };

    for (const width of MIN2_WIDTHS) {
      for (const pinMode of PIN_MODES) {
        const parts: PartSpec[] = [
          ["G2", "gray-converter", { width, pinMode, direction: "toGray" }],
          ["B2", "gray-converter", { width, pinMode, direction: "toBinary" }],
        ];
        const nets: string[][] = [];
        wireIn(parts, nets, "IN", "G2", "in", width, pinMode);
        if (pinMode === "bus") {
          parts.push(["GRAY", "output-pin", { name: "GRAY", width }]);
          nets.push(["G2.out", "B2.in", "GRAY.in"]);
        } else {
          for (let i = 0; i < width; i++) {
            parts.push([`GRAY_${i}`, "output-pin", { name: `GRAY_${i}`, width: 1 }]);
            nets.push([`G2.out${i}`, `B2.in${i}`, `GRAY_${i}.in`]);
          }
        }
        wireOut(parts, nets, "BIN", "B2", "out", width, pinMode);

        const c = extractCircuit(mkDoc(parts, nets));
        expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
        const sim = new Simulator(c);

        for (const x of makeTestValues(width, rng, 10)) {
          setBus(sim, "IN", width, pinMode, x);
          const r = sim.settle();
          expect(r.stable).toBe(true);
          expect(r.issues).toEqual([]);

          const expectedGray = refToGray(x);
          expect(readBus(sim, "GRAY", "G2", "out", width, pinMode)).toBe(expectedGray);
          expect(readBus(sim, "BIN", "B2", "out", width, pinMode)).toBe(refToBinary(expectedGray));
          expect(readBus(sim, "BIN", "B2", "out", width, pinMode)).toBe(x);
        }
      }
    }
  });
});

// =================================================================================================
// 3. X propagation (hardware-correct dominance rules)
// =================================================================================================

describe("3. X propagation and dominance rules", () => {
  it("enforces dominance for AND/NAND/OR/NOR/XOR/XNOR with floating inputs and shorted X nets", () => {
    // Source X via a floating net (F_IN unconnected) AND via a contention short (S0=0, S1=1)
    const doc = mkDoc(
      [
        ["A", "input-pin"],
        ["S0", "input-pin"],
        ["S1", "input-pin"],
        ["B0", "buf"],
        ["B1", "buf"],
        ["G_AND_F", "and", { inputs: 2 }],
        ["G_NAND_F", "nand", { inputs: 2 }],
        ["G_OR_F", "or", { inputs: 2 }],
        ["G_NOR_F", "nor", { inputs: 2 }],
        ["G_XOR_F", "xor", { inputs: 2 }],
        ["G_XNOR_F", "xnor", { inputs: 2 }],
        ["G_AND_S", "and", { inputs: 3 }],
        ["G_OR_S", "or", { inputs: 3 }],
        ["G_XOR_S", "xor", { inputs: 2 }],
        ["Y_AND_F", "output-pin"],
        ["Y_NAND_F", "output-pin"],
        ["Y_OR_F", "output-pin"],
        ["Y_NOR_F", "output-pin"],
        ["Y_XOR_F", "output-pin"],
        ["Y_XNOR_F", "output-pin"],
        ["Y_AND_S", "output-pin"],
        ["Y_OR_S", "output-pin"],
        ["Y_XOR_S", "output-pin"],
      ],
      [
        ["A.out", "G_AND_F.in0", "G_NAND_F.in0", "G_OR_F.in0", "G_NOR_F.in0", "G_XOR_F.in0", "G_XNOR_F.in0", "G_AND_S.in0", "G_OR_S.in0", "G_XOR_S.in0"],
        ["S0.out", "B0.in0"],
        ["S1.out", "B1.in0"],
        // Short B0.out and B1.out to create a contention-driven X when S0 != S1
        ["B0.out", "B1.out", "G_AND_S.in1", "G_OR_S.in1", "G_XOR_S.in1"],
        // G_*_F.in1, G_AND_S.in2, G_OR_S.in2 left floating intentionally
        ["G_AND_F.out", "Y_AND_F.in"],
        ["G_NAND_F.out", "Y_NAND_F.in"],
        ["G_OR_F.out", "Y_OR_F.in"],
        ["G_NOR_F.out", "Y_NOR_F.in"],
        ["G_XOR_F.out", "Y_XOR_F.in"],
        ["G_XNOR_F.out", "Y_XNOR_F.in"],
        ["G_AND_S.out", "Y_AND_S.in"],
        ["G_OR_S.out", "Y_OR_S.in"],
        ["G_XOR_S.out", "Y_XOR_S.in"],
      ],
    );

    const sim = new Simulator(extractCircuit(doc));
    sim.set("S0", 0);
    sim.set("S1", 1);

    // A = 0: dominates AND/NAND, does not dominate OR/NOR/XOR/XNOR
    sim.set("A", 0);
    const r0 = sim.settle();
    expect(r0.issues.some((i) => i.kind === "floating")).toBe(true);
    expect(r0.issues.some((i) => i.kind === "contention")).toBe(true);
    expect(sim.read("Y_AND_F")).toBe(0);
    expect(sim.read("Y_NAND_F")).toBe(1);
    expect(sim.read("Y_OR_F")).toBeNull();
    expect(sim.read("Y_NOR_F")).toBeNull();
    expect(sim.read("Y_XOR_F")).toBeNull();
    expect(sim.read("Y_XNOR_F")).toBeNull();
    expect(sim.read("Y_AND_S")).toBe(0);
    expect(sim.read("Y_OR_S")).toBeNull();
    expect(sim.read("Y_XOR_S")).toBeNull();

    // A = 1: dominates OR/NOR, does not dominate AND/NAND/XOR/XNOR
    sim.set("A", 1);
    sim.settle();
    expect(sim.read("Y_AND_F")).toBeNull();
    expect(sim.read("Y_NAND_F")).toBeNull();
    expect(sim.read("Y_OR_F")).toBe(1);
    expect(sim.read("Y_NOR_F")).toBe(0);
    expect(sim.read("Y_XOR_F")).toBeNull();
    expect(sim.read("Y_XNOR_F")).toBeNull();
    expect(sim.read("Y_AND_S")).toBeNull();
    expect(sim.read("Y_OR_S")).toBe(1);
    expect(sim.read("Y_XOR_S")).toBeNull();
  });

  it("handles unknown and partially unknown select on mux, demux, decoder, and bit-selector", () => {
    // 4-to-1 4-bit MUX with enable
    const muxDoc = mkDoc(
      [
        ["D0", "input-pin", { width: 4 }],
        ["D1", "input-pin", { width: 4 }],
        ["D2", "input-pin", { width: 4 }],
        ["D3", "input-pin", { width: 4 }],
        ["S0", "input-pin"],
        ["S1", "input-pin"],
        ["EN", "input-pin"],
        ["M", "mux", { selectBits: 2, dataWidth: 4, enable: true, selectMode: "bits" }],
        ["Y", "output-pin", { width: 4 }],
      ],
      [
        ["D0.out", "M.d0"], ["D1.out", "M.d1"], ["D2.out", "M.d2"], ["D3.out", "M.d3"],
        ["S0.out", "M.s0"], ["S1.out", "M.s1"], ["EN.out", "M.en"], ["M.y", "Y.in"],
      ],
    );
    const ms = new Simulator(extractCircuit(muxDoc));
    ms.set("EN", 1);
    // Equal data across all channels with completely unknown select -> outputs the data
    for (const d of ["D0", "D1", "D2", "D3"]) ms.set(d, 0b1010);
    ms.set("S0", [BX]);
    ms.set("S1", [BX]);
    ms.settle();
    expect(ms.read("Y")).toBe(0b1010);

    // Partially unknown select S1=0, S0=X -> only {D0, D1} matter; D2/D3 ignored even if X!
    ms.set("D0", 0b1010);
    ms.set("D1", 0b1100);
    ms.set("D2", [BX, BX, BX, BX]);
    ms.set("D3", [BX, BX, BX, BX]);
    ms.set("S1", 0);
    ms.set("S0", [BX]);
    ms.settle();
    // Bit 0: 0 & 0 -> 0; Bit 1: 1 & 0 -> X; Bit 2: 0 & 1 -> X; Bit 3: 1 & 1 -> 1
    expect(ms.pinBits("Y", "in")).toEqual([B0, BX, BX, B1]);

    // EN = 0 forces 0 even when everything else is X
    ms.set("EN", 0);
    ms.set("S1", [BX]);
    ms.settle();
    expect(ms.read("Y")).toBe(0);

    // EN = X with Y = [0, X, X, 1] keeps known-0 bit as 0 and others X
    ms.set("EN", [BX]);
    ms.set("S1", 0);
    ms.settle();
    expect(ms.pinBits("Y", "in")).toEqual([B0, BX, BX, BX]);

    // DEMUX & Decoder & Bit-Selector partial-X checks
    const plexDoc = mkDoc(
      [
        ["D", "input-pin"],
        ["S0", "input-pin"],
        ["S1", "input-pin"],
        ["EN", "input-pin"],
        ["DM", "demux", { selectBits: 2, dataWidth: 1, enable: true, selectMode: "bits" }],
        ["DC", "decoder", { inputs: 2, enable: true, activeLowOutputs: true }],
        ["BD", "input-pin", { width: 4 }],
        ["BS", "bit-selector", { width: 4 }],
        ["BS_S", "input-pin", { width: 2 }],
        ["BY", "output-pin"],
      ],
      [
        ["D.out", "DM.d"],
        ["S0.out", "DM.s0", "DC.a0"],
        ["S1.out", "DM.s1", "DC.a1"],
        ["EN.out", "DM.en", "DC.en"],
        ["BD.out", "BS.d"],
        ["BS_S.out", "BS.s"],
        ["BS.y", "BY.in"],
      ],
    );
    const ps = new Simulator(extractCircuit(plexDoc));
    ps.set("D", 1);
    ps.set("EN", 1);
    ps.set("S0", [BX]);
    ps.set("S1", 0); // candidates {0, 1}; channels 2 & 3 guaranteed inactive
    ps.set("BD", 0b0011);
    ps.set("BS_S", [BX, B0]); // selects bit 0 or 1, both are 1
    ps.settle();

    expect(ps.pinBits("DM", "y0")).toEqual([BX]);
    expect(ps.pinBits("DM", "y1")).toEqual([BX]);
    expect(ps.pinBits("DM", "y2")).toEqual([B0]);
    expect(ps.pinBits("DM", "y3")).toEqual([B0]);
    // Active-low decoder: inactive outputs 2 & 3 are 1, candidate outputs 0 & 1 are X
    expect(ps.pinBits("DC", "y0")).toEqual([BX]);
    expect(ps.pinBits("DC", "y1")).toEqual([BX]);
    expect(ps.pinBits("DC", "y2")).toEqual([B1]);
    expect(ps.pinBits("DC", "y3")).toEqual([B1]);
    expect(ps.read("BY")).toBe(1);

    // D = 0 dominates unknown select and unknown enable on DEMUX
    ps.set("D", 0);
    ps.set("EN", [BX]);
    ps.set("S1", [BX]);
    ps.settle();
    for (let i = 0; i < 4; i++) expect(ps.pinBits("DM", `y${i}`)).toEqual([B0]);
  });

  it("matches exhaustive 3-valued truth tables for AOI (all 4 kinds), half-adder, and full-adder", () => {
    const trit: RefBit[] = [R0, R1, RX];

    for (const kind of ["aoi21", "aoi22", "oai21", "oai22"] as const) {
      const hasD = kind === "aoi22" || kind === "oai22";
      const parts: PartSpec[] = [
        ["A", "input-pin"], ["B", "input-pin"], ["C", "input-pin"],
        ...(hasD ? ([["D", "input-pin"]] as PartSpec[]) : []),
        ["G", "aoi", { kind }],
        ["Y", "output-pin"],
      ];
      const nets: string[][] = [
        ["A.out", "G.a"], ["B.out", "G.b"], ["C.out", "G.c"],
        ...(hasD ? [["D.out", "G.d"]] : []),
        ["G.y", "Y.in"],
      ];
      const sim = new Simulator(extractCircuit(mkDoc(parts, nets)));
      const dVals: RefBit[] = hasD ? trit : [R0];
      for (const a of trit) {
        for (const b of trit) {
          for (const c of trit) {
            for (const d of dVals) {
              sim.set("A", [a]);
              sim.set("B", [b]);
              sim.set("C", [c]);
              if (hasD) sim.set("D", [d]);
              sim.settle();
              const exp =
                kind === "aoi21" ? refNot(refOr([refAnd([a, b]), c]))
                : kind === "aoi22" ? refNot(refOr([refAnd([a, b]), refAnd([c, d])]))
                : kind === "oai21" ? refNot(refAnd([refOr([a, b]), c]))
                : refNot(refAnd([refOr([a, b]), refOr([c, d])]));
              expect(sim.pinBits("Y", "in")[0], `${kind}(${a},${b},${c},${d})`).toBe(exp);
            }
          }
        }
      }
    }

    // Half-adder & full-adder exhaustive 3-valued check
    const addDoc = mkDoc(
      [
        ["A", "input-pin"], ["B", "input-pin"], ["CI", "input-pin"],
        ["HA", "half-adder"], ["FA", "full-adder"],
        ["HS", "output-pin"], ["HC", "output-pin"],
        ["FS", "output-pin"], ["FC", "output-pin"],
      ],
      [
        ["A.out", "HA.a", "FA.a"],
        ["B.out", "HA.b", "FA.b"],
        ["CI.out", "FA.cin"],
        ["HA.s", "HS.in"], ["HA.cout", "HC.in"],
        ["FA.s", "FS.in"], ["FA.cout", "FC.in"],
      ],
    );
    const asim = new Simulator(extractCircuit(addDoc));
    for (const a of trit) {
      for (const b of trit) {
        for (const ci of trit) {
          asim.set("A", [a]);
          asim.set("B", [b]);
          asim.set("CI", [ci]);
          asim.settle();
          expect(asim.pinBits("HS", "in")[0]).toBe(refXor([a, b]));
          expect(asim.pinBits("HC", "in")[0]).toBe(refAnd([a, b]));
          expect(asim.pinBits("FS", "in")[0]).toBe(refXor([a, b, ci]));
          expect(asim.pinBits("FC", "in")[0]).toBe(refOr([refAnd([a, b]), refAnd([a, ci]), refAnd([b, ci])]));
        }
      }
    }
  });

  it("matches independent 3-valued reference evaluator on random DAGs with partly unknown inputs", () => {
    for (const [seed, gateCount] of [[301, 40], [302, 120]] as const) {
      // Exclude encoder here; priority encoder X-dominance is tracked separately as BUG-COMB-1.
      const dag = generateRandomCombDag({ seed, gateCount, includeEncoder: false });
      const sim = new Simulator(extractCircuit(dag.doc));
      const rng = new Rng(seed * 997 + 3);

      for (let v = 0; v < 30; v++) {
        const vec: Record<string, RefBit> = {};
        for (const id of dag.inputIds) {
          const r = rng.next();
          const bit: RefBit = r < 0.3 ? RX : r < 0.65 ? R0 : R1;
          vec[id] = bit;
          sim.set(id, [bit]);
        }
        const settled = sim.settle();
        expect(settled.stable).toBe(true);
        const expected = dag.evaluateRef(vec);
        // The reference is plain three-valued logic, gate by gate; the simulator is exact over a
        // few unknown inputs of each part, so it may know more. Where the reference knows, they
        // must agree; where only the simulator knows, every way of filling in the unknown inputs
        // must give its value.
        const unknown = dag.inputIds.filter((id) => vec[id] === RX);
        for (const oid of dag.outputIds) {
          const got = sim.pinBits(oid, "in")[0];
          if (expected[oid] !== RX) expect(got, `seed=${seed} vec=${v} out=${oid}`).toBe(expected[oid]);
          else if (got !== RX && unknown.length <= 12)
            for (let m = 0; m < 1 << unknown.length; m++) {
              const r = { ...vec };
              unknown.forEach((id, i) => (r[id] = ((m >> i) & 1) as RefBit));
              expect(dag.evaluateRef(r)[oid], `seed=${seed} vec=${v} out=${oid}: the simulator says ${got}`).toBe(got);
            }
        }
      }
    }
  });
});

// =================================================================================================
// 4. Equivalence: truthTable + outputFunctions + sopsToSchematic + evaluateCombinational
// =================================================================================================

describe("4. equivalence (truthTable, outputFunctions, sopsToSchematic, evaluateCombinational)", () => {
  it("recovers original minterms via truthTable + outputFunctions on random sopsToSchematic circuits", () => {
    const rng = new Rng(4001);
    const trials: { n: number; numOutputs: number; forceEdge?: boolean }[] = [
      { n: 2, numOutputs: 3, forceEdge: true }, // includes constant 0 and constant 1
      { n: 3, numOutputs: 3 },
      { n: 3, numOutputs: 4 },
      { n: 4, numOutputs: 3 },
      { n: 4, numOutputs: 4 },
      { n: 4, numOutputs: 2 },
      { n: 5, numOutputs: 2 },
    ];
    for (let extra = 0; extra < 8; extra++) {
      trials.push({ n: 2 + (extra % 3), numOutputs: 1 + (extra % 4) });
    }

    for (let t = 0; t < trials.length; t++) {
      const { n, numOutputs, forceEdge } = trials[t];
      const rows = 1 << n;
      const names = Array.from({ length: n }, (_, i) => `v${i}`);
      const origMinterms: number[][] = [];
      for (let k = 0; k < numOutputs; k++) {
        if (forceEdge && k === 0) origMinterms.push([]); // constant 0
        else if (forceEdge && k === 1) origMinterms.push(Array.from({ length: rows }, (_, m) => m)); // constant 1
        else origMinterms.push(Array.from({ length: rows }, (_, m) => m).filter(() => rng.bool(0.45)));
      }

      const doc = sopsToSchematic(
        origMinterms.map((ms, k) => ({ name: `f${k}`, terms: minimize(n, ms).terms })),
        names,
      );
      const circuit = extractCircuit(doc);
      expect(checkCircuit(circuit).filter((i) => i.severity === "error")).toEqual([]);

      const tt = truthTable(circuit);
      expect(tt.vars).toEqual(names);
      expect(truthTableText(tt).split("\n")).toHaveLength(2 + rows);

      const fns = outputFunctions(tt);
      expect(fns).toHaveLength(numOutputs);
      fns.forEach((fn, k) => {
        expect(fn.unknown).toEqual([]);
        expect(fn.minterms).toEqual(origMinterms[k]);
      });

      // Verify evaluateCombinational agrees with Simulator on every row (all rows for n<=4, sampled for n=5)
      const sim = new Simulator(circuit);
      const step = n <= 4 ? 1 : 3;
      for (let m = 0; m < rows; m += step) {
        const inMap: Record<string, boolean> = {};
        for (let i = 0; i < n; i++) {
          const bit = ((m >> i) & 1) === 1;
          inMap[names[i]] = bit;
          sim.set(names[i], bit);
        }
        sim.settle();
        const evalRes = evaluateCombinational(doc, inMap);
        for (let k = 0; k < numOutputs; k++) {
          const outName = `f${k}`;
          const simVal = sim.read(outName);
          expect(evalRes[outName]).toBe(simVal === null ? undefined : simVal !== 0);
          expect(evalRes[outName]).toBe(origMinterms[k].includes(m));
        }
      }
    }
  });

  it("evaluateCombinational agrees with Simulator on random DAGs and returns undefined for X outputs", () => {
    const dag = generateRandomCombDag({ seed: 4444, gateCount: 60, inputCount: 8, outputCount: 10 });
    const sim = new Simulator(extractCircuit(dag.doc));
    const rng = new Rng(4445);

    for (let v = 0; v < 15; v++) {
      const inMap: Record<string, boolean> = {};
      for (const id of dag.inputIds) {
        const bit = rng.bool();
        inMap[id] = bit;
        sim.set(id, bit);
      }
      sim.settle();
      const evalRes = evaluateCombinational(dag.doc, inMap);
      for (const oid of dag.outputIds) {
        const sv = sim.read(oid);
        expect(evalRes[oid]).toBe(sv === null ? undefined : sv !== 0);
      }
    }

    // Floating input causing X output -> undefined
    const floatingDoc = mkDoc(
      [["A", "input-pin"], ["G", "and"], ["Y", "output-pin"]],
      [["A.out", "G.in0"], ["G.out", "Y.in"]],
    );
    expect(evaluateCombinational(floatingDoc, { A: false })).toEqual({ Y: false });
    expect(evaluateCombinational(floatingDoc, { A: true })).toEqual({ Y: undefined });
  });
});

// =================================================================================================
// 5. Performance benchmarks
// =================================================================================================

describe("5. performance benchmarks", () => {
  it("extracts, settles, and runs 100 input changes on a 5,000-gate random DAG within bounds", () => {
    const dag = generateRandomCombDag({
      seed: 5000,
      gateCount: 5000,
      inputCount: 32,
      outputCount: 32,
      fastGatesOnly: true,
    });
    const vec: Record<string, RefBit> = {};
    for (const id of dag.inputIds) vec[id] = R0;

    const t0 = performance.now();
    const circuit = extractCircuit(dag.doc);
    const sim = new Simulator(circuit);
    const initRes = sim.settle();
    const extractAndSettleMs = performance.now() - t0;

    expect(initRes.stable).toBe(true);
    expect(initRes.issues).toEqual([]);
    expect(extractAndSettleMs).toBeLessThan(2000);

    const initExpected = dag.evaluateRef(vec);
    for (const oid of dag.outputIds) {
      expect(sim.read(oid)).toBe(initExpected[oid]);
    }

    const rng = new Rng(5001);
    const t1 = performance.now();
    for (let step = 0; step < 100; step++) {
      const id = dag.inputIds[rng.int(0, dag.inputIds.length - 1)];
      const nextBit: RefBit = vec[id] === R0 ? R1 : R0;
      vec[id] = nextBit;
      sim.set(id, nextBit);
      const r = sim.settle();
      expect(r.stable).toBe(true);
    }
    const changesMs = performance.now() - t1;
    expect(changesMs).toBeLessThan(2000);

    const finalExpected = dag.evaluateRef(vec);
    for (const oid of dag.outputIds) {
      expect(sim.read(oid)).toBe(finalExpected[oid]);
    }
  });

  it("extracts, settles, and evaluates 100 vectors on a 32-bit ripple-carry adder within bounds", () => {
    const doc = buildRippleCarryAdder(32);

    const t0 = performance.now();
    const circuit = extractCircuit(doc);
    const sim = new Simulator(circuit);
    const initRes = sim.settle();
    const extractAndSettleMs = performance.now() - t0;

    expect(checkCircuit(circuit).filter((i) => i.severity === "error")).toEqual([]);
    expect(initRes.stable).toBe(true);
    expect(initRes.issues).toEqual([]);
    expect(extractAndSettleMs).toBeLessThan(2000);

    const rng = new Rng(5032);
    const vectors: [bigint, bigint, bigint][] = [
      // Worst-case 32-bit full carry-chain ripples
      [0xffffffffn, 0n, 1n],
      [0xffffffffn, 1n, 0n],
      [0xffffffffn, 0xffffffffn, 1n],
      [0x7fffffffn, 1n, 0n],
      [0x80000000n, 0x80000000n, 0n],
      [0n, 0n, 0n],
    ];
    while (vectors.length < 100) {
      vectors.push([rng.bigBits(32), rng.bigBits(32), rng.bool() ? 1n : 0n]);
    }

    const t1 = performance.now();
    for (const [a, b, cin] of vectors) {
      sim.set("A", Number(a));
      sim.set("B", Number(b));
      sim.set("CIN", Number(cin));
      const r = sim.settle();
      expect(r.stable).toBe(true);
      expect(r.issues).toEqual([]);

      const sum = a + b + cin;
      expect(bitsToBigInt(sim.pinBits("S", "in"))).toBe(BigInt.asUintN(32, sum));
      expect(sim.read("COUT")).toBe(sum >> 32n > 0n ? 1 : 0);
    }
    const changesMs = performance.now() - t1;
    expect(changesMs).toBeLessThan(2000);
  });

  it("computes structuralKey of a 2,000-part document in under 200 ms and preserves invariance", () => {
    const dag = generateRandomCombDag({
      seed: 2000,
      gateCount: 1960,
      inputCount: 20,
      outputCount: 20,
      fastGatesOnly: true,
    });
    expect(dag.doc.components.length).toBeGreaterThanOrEqual(2000);

    const t0 = performance.now();
    const k1 = structuralKey(dag.doc);
    const keyMs = performance.now() - t0;
    expect(keyMs).toBeLessThan(200);

    // Moving, rotating, and relabeling all 2,000 parts must leave structuralKey unchanged
    const moved = structuredClone(dag.doc);
    moved.components.forEach((comp, idx) => {
      comp.x += 130;
      comp.y -= 70;
      comp.rotation = (((idx % 4) * 90) as 0 | 90 | 180 | 270);
      comp.label = `L${idx}`;
    });
    const t1 = performance.now();
    const k2 = structuralKey(moved);
    expect(performance.now() - t1).toBeLessThan(200);
    expect(k2).toBe(k1);

    // Structural edit (changing one gate type or dropping one link) must change structuralKey
    const edited = structuredClone(dag.doc);
    const firstGate = edited.components.find((comp) => comp.id === "G0")!;
    firstGate.type = firstGate.type === "and" ? "or" : "and";
    expect(structuralKey(edited)).not.toBe(k1);
  });
});

// =================================================================================================
// 6. Bus plumbing: splitters & tunnels
// =================================================================================================

describe("6. bus plumbing (splitters and tunnels)", () => {
  it("splits and re-merges buses bit-exact across diverse (width, fanOut) configurations", () => {
    const rng = new Rng(6001);
    const configs: [number, number][] = [
      [2, 2], [3, 2], [3, 5], [4, 2], [4, 3], [4, 4], [4, 8],
      [5, 2], [5, 3], [7, 3], [7, 4], [8, 3], [8, 5], [8, 8],
      [12, 5], [16, 3], [16, 4], [16, 16], [31, 5], [32, 2], [32, 5], [32, 7], [32, 32],
    ];

    for (const [width, fanOut] of configs) {
      const slices = refSplitterSlices(width, fanOut);
      const parts: PartSpec[] = [
        ["IN", "input-pin", { name: "IN", width }],
        ["SP1", "splitter", { width, fanOut }],
        ["SP2", "splitter", { width, fanOut }],
        ["OUT", "output-pin", { name: "OUT", width }],
      ];
      const nets: string[][] = [
        ["IN.out", "SP1.bus"],
        ["SP2.bus", "OUT.in"],
      ];
      slices.forEach((s, i) => {
        parts.push([`SL${i}`, "output-pin", { name: `SL${i}`, width: s.width }]);
        nets.push([`SP1.b${i}`, `SP2.b${i}`, `SL${i}.in`]);
      });

      const c = extractCircuit(mkDoc(parts, nets));
      expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
      const sim = new Simulator(c);

      for (const val of makeTestValues(width, rng, 5)) {
        sim.set("IN", Number(val));
        const r = sim.settle();
        expect(r.stable).toBe(true);
        expect(r.issues).toEqual([]);
        expect(bitsToBigInt(sim.pinBits("OUT", "in"))).toBe(val);
        slices.forEach((s, i) => {
          const mask = (1n << BigInt(s.width)) - 1n;
          const expectedSlice = (val >> BigInt(s.lo)) & mask;
          expect(bitsToBigInt(sim.pinBits(`SL${i}`, "in"))).toBe(expectedSlice);
        });
      }
    }
  });

  it("delivers bit-exact values through random multi-stage splitter + tunnel permutation networks", () => {
    const rng = new Rng(6002);
    for (const [seed, width] of [
      [61, 4], [62, 7], [63, 8], [64, 12], [65, 16], [66, 31], [67, 32],
    ] as const) {
      const net = generateBusPlumbingCircuit(seed, width);
      const c = extractCircuit(net.doc);
      // Tunnels must be completely dissolved out of Circuit.parts
      expect(c.parts.some((p) => p.type === "tunnel")).toBe(false);
      expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);

      const sim = new Simulator(c);
      for (const val of makeTestValues(width, rng, 8)) {
        sim.set("IN", Number(val));
        const r = sim.settle();
        expect(r.stable).toBe(true);
        expect(r.issues).toEqual([]);
        expect(bitsToBigInt(sim.pinBits("OUT", "in"))).toBe(net.evalRef(val));
      }
    }
  });

  it("supports tunnel fan-out on multi-bit buses and isolates X bits across splitter slices", () => {
    // 1 driver -> 5 receivers via matching 32-bit tunnels
    const fanParts: PartSpec[] = [
      ["SRC", "input-pin", { name: "SRC", width: 32 }],
      ["TS", "tunnel", { name: "DATA32", width: 32 }],
    ];
    const fanNets: string[][] = [["SRC.out", "TS.net"]];
    for (let k = 0; k < 5; k++) {
      fanParts.push([`TR${k}`, "tunnel", { name: "DATA32", width: 32 }]);
      fanParts.push([`DST${k}`, "output-pin", { name: `DST${k}`, width: 32 }]);
      fanNets.push([`TR${k}.net`, `DST${k}.in`]);
    }
    const fc = extractCircuit(mkDoc(fanParts, fanNets));
    expect(checkCircuit(fc).filter((i) => i.severity === "error")).toEqual([]);
    const fsim = new Simulator(fc);
    for (const v of [0n, 1n, 0x80000000n, 0xdeadbeefn, 0xffffffffn]) {
      fsim.set("SRC", Number(v));
      expect(fsim.settle().issues).toEqual([]);
      for (let k = 0; k < 5; k++) {
        expect(bitsToBigInt(fsim.pinBits(`DST${k}`, "in"))).toBe(v);
      }
    }

    // X bit isolation through splitter -> tunnel -> splitter
    const xDoc = mkDoc(
      [
        ["I0", "input-pin"], ["I1", "input-pin"], ["I2", "input-pin"], ["I3", "input-pin"],
        ["SPM", "splitter", { width: 4, fanOut: 4 }],
        ["TA", "tunnel", { name: "MIX", width: 4 }],
        ["TB", "tunnel", { name: "MIX", width: 4 }],
        ["SPD", "splitter", { width: 4, fanOut: 2 }],
        ["LO", "output-pin", { width: 2 }],
        ["HI", "output-pin", { width: 2 }],
      ],
      [
        ["I0.out", "SPM.b0"], ["I1.out", "SPM.b1"], ["I2.out", "SPM.b2"], ["I3.out", "SPM.b3"],
        ["SPM.bus", "TA.net"], ["TB.net", "SPD.bus"],
        ["SPD.b0", "LO.in"], ["SPD.b1", "HI.in"],
      ],
    );
    const xsim = new Simulator(extractCircuit(xDoc));
    xsim.set("I0", 1);
    xsim.set("I1", [BX]);
    xsim.set("I2", 0);
    xsim.set("I3", 1);
    xsim.settle();
    expect(xsim.pinBits("LO", "in")).toEqual([B1, BX]);
    expect(xsim.pinBits("HI", "in")).toEqual([B0, B1]);
    expect(xsim.read("HI")).toBe(0b10);
  });
});

// =================================================================================================
// 7. Simulator bugs exposed by combinational stress tests (it.fails)
// =================================================================================================

describe("7. simulator bug reproductions", () => {
  it("BUG-COMB-1: priority encoder drives X on y when highest-priority input is 1 and a lower-priority input is X", () => {
    const doc = mkDoc(
      [
        ["D1", "input-pin"],
        ["D2", "input-pin"],
        ["D3", "input-pin"],
        ["ENC", "encoder", { outputBits: 2, priority: true, validOut: true, enable: false }],
        ["Y0", "output-pin"],
        ["Y1", "output-pin"],
        ["V", "output-pin"],
      ],
      [
        ["D1.out", "ENC.d1"],
        ["D2.out", "ENC.d2"],
        ["D3.out", "ENC.d3"],
        // ENC.d0 intentionally left floating (X)
        ["ENC.y0", "Y0.in"],
        ["ENC.y1", "Y1.in"],
        ["ENC.v", "V.in"],
      ],
    );
    const sim = new Simulator(extractCircuit(doc));
    sim.set("D3", 1);
    sim.set("D2", 0);
    sim.set("D1", 0);
    sim.settle();
    expect(sim.read("V")).toBe(1);
    expect(sim.read("Y0")).toBe(1);
    expect(sim.read("Y1")).toBe(1);
  });

  it("BUG-COMB-2: checkCircuit misses multiple-drivers when two output pins of the same part are shorted", () => {
    const doc = mkDoc(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["PAR", "parity", { inputs: 2 }],
        ["Y", "output-pin"],
      ],
      [
        ["A.out", "PAR.in0"],
        ["B.out", "PAR.in1"],
        ["PAR.odd", "PAR.even", "Y.in"],
      ],
    );
    const c = extractCircuit(doc);
    // Runtime simulation confirms contention on every input
    const sim = new Simulator(c);
    expect(sim.settle().issues.map((i) => i.kind)).toContain("contention");
    // Static check should also report multiple-drivers
    expect(checkCircuit(c).map((i) => i.kind)).toContain("multiple-drivers");
  });

  it("BUG-COMB-3: checkCircuit misses a single-gate combinational feedback self-loop", () => {
    const doc = mkDoc(
      [
        ["EN", "input-pin"],
        ["G", "nand"],
        ["Y", "output-pin"],
      ],
      [
        ["EN.out", "G.in1"],
        ["G.out", "G.in0", "Y.in"],
      ],
    );
    const c = extractCircuit(doc);
    // Confirm live oscillation when EN goes 0 -> 1
    const sim = new Simulator(c);
    sim.set("EN", 0);
    expect(sim.settle().stable).toBe(true);
    sim.set("EN", 1);
    const r = sim.settle();
    expect(r.stable).toBe(false);
    expect(r.issues[0].kind).toBe("oscillation");
    // Static check should flag the self-loop as feedback
    expect(checkCircuit(c).map((i) => i.kind)).toContain("feedback");
  });

  it("BUG-COMB-4: checkCircuit falsely reports a combinational feedback loop when two ground symbols share a net", () => {
    const doc = mkDoc(
      [
        ["G1", "ground"],
        ["G2", "ground"],
        ["Y", "output-pin"],
      ],
      [["G1.gnd", "G2.gnd", "Y.in"]],
    );
    const c = extractCircuit(doc);
    const sim = new Simulator(c);
    expect(sim.settle().issues).toEqual([]);
    expect(sim.read("Y")).toBe(0);
    expect(checkCircuit(c).map((i) => i.kind)).not.toContain("feedback");
  });
});

/**
 * End-to-end tests of classic introductory digital design circuits written in DSpec.
 *
 * Each circuit is compiled with `compileSpec`, extracted with `extractCircuit`, checked statically
 * with `checkCircuit`, simulated against an independent behavioural reference with `Simulator`,
 * analyzed with `truthTable` / `outputFunctions` (combinational) or `stateTable` (sequential/FSM),
 * and checked for equivalence and counterexample generation with `compareCircuits`.
 */
import { describe, expect, it, vi } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";

// compiling the larger circuits from DSpec takes a few seconds under a loaded test run
vi.setConfig({ testTimeout: 60000 });
import { compileSpec } from "../src/spec/compile";
import { extractCircuit, type Circuit } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { Simulator } from "../src/logic/simulate";
import { compareCircuits, outputFunctions, stateTable, truthTable, truthTableText } from "../src/logic/analyze";
import { minimize, sopToString } from "../src/logic/minimize";
import { mkDoc } from "./helpers/sim-gen";

registerBuiltinComponents();

/** Compile DSpec source and assert it succeeds with no error diagnostics. */
function compileClean(source: string): Circuit {
  const res = compileSpec(source);
  const errors = res.diagnostics.filter((d) => d.severity === "error");
  expect(errors, `DSpec compile errors:\n${errors.map((e) => `${e.line}:${e.col} ${e.message}`).join("\n")}`).toEqual([]);
  expect(res.doc).not.toBeNull();
  return extractCircuit(res.doc!);
}

/** Assert `checkCircuit` reports zero errors (and optionally zero warnings). */
function expectCheckClean(c: Circuit, allowWarnings = false) {
  const issues = checkCircuit(c);
  const bad = issues.filter((i) => i.severity === "error" || (!allowWarnings && i.severity === "warning"));
  expect(bad, `Unexpected checkCircuit issues:\n${bad.map((i) => `[${i.severity}] ${i.kind}: ${i.message}`).join("\n")}`).toEqual([]);
  return issues;
}

/** Helper to map outputFunctions(t) by output bit name -> minimal SOP string. */
function sopMap(t: ReturnType<typeof truthTable>): Record<string, string> {
  return Object.fromEntries(outputFunctions(t).map((f) => [f.name, f.sop]));
}

// =================================================================================================
// 1. 4-to-1 Multiplexer from gates
// =================================================================================================
describe("1. 4-to-1 multiplexer from gates", () => {
  const mux4Gates = `
@name "4-to-1 MUX (gates)"
@compact never
part S1, S0, D0, D1, D2, D3 input-pin
part Y output-pin

part NS1, NS0 not
part A0, A1, A2, A3 and inputs=3
part OR_Y or inputs=4

S1 -> NS1, A2.in0, A3.in0
NS1 -> A0.in0, A1.in0
S0 -> NS0, A1.in1, A3.in1
NS0 -> A0.in1, A2.in1
D0 -> A0.in2
D1 -> A1.in2
D2 -> A2.in2
D3 -> A3.in2
A0 -> OR_Y.in0
A1 -> OR_Y.in1
A2 -> OR_Y.in2
A3 -> OR_Y.in3
OR_Y -> Y
`;

  const mux4Builtin = `
@name "4-to-1 MUX (builtin)"
@compact never
part S1, S0, D0, D1, D2, D3 input-pin
part Y output-pin
part M mux selectBits=2 dataWidth=1 selectMode=bits

D0 -> M.d0
D1 -> M.d1
D2 -> M.d2
D3 -> M.d3
S0 -> M.s0
S1 -> M.s1
M.y -> Y
`;

  const mux4Buggy = mux4Gates.replace("D2 -> A2.in2", "D1 -> A2.in2");

  it("compiles, passes static checks, matches reference & textbook SOP, and compares correctly", () => {
    const c = compileClean(mux4Gates);
    expectCheckClean(c);

    // Exhaustive simulation vs independent reference
    const sim = new Simulator(c);
    const ref = (s1: number, s0: number, d: number[]) => d[(s1 << 1) | s0];
    for (let m = 0; m < 64; m++) {
      const s1 = (m >> 5) & 1, s0 = (m >> 4) & 1;
      const d = [(m >> 3) & 1, (m >> 2) & 1, (m >> 1) & 1, m & 1];
      sim.set("S1", s1);
      sim.set("S0", s0);
      d.forEach((v, i) => sim.set(`D${i}`, v));
      const r = sim.settle();
      expect(r.stable).toBe(true);
      expect(r.issues).toEqual([]);
      expect(sim.read("Y")).toBe(ref(s1, s0, d));
    }

    // Truth table and minimal SOP (textbook: S1'S0'D0 + S1'S0D1 + S1S0'D2 + S1S0D3)
    const tt = truthTable(c);
    expect(tt.rows).toHaveLength(64);
    const [f] = outputFunctions(tt);
    expect(f.unknown).toEqual([]);
    const expectedMinterms: number[] = [];
    for (let m = 0; m < 64; m++) {
      const s1 = (m >> 5) & 1, s0 = (m >> 4) & 1;
      const d = [(m >> 3) & 1, (m >> 2) & 1, (m >> 1) & 1, m & 1];
      if (ref(s1, s0, d) === 1) expectedMinterms.push(m);
    }
    expect(f.minterms).toEqual(expectedMinterms);
    expect(f.sop).toBe(sopToString(minimize(6, expectedMinterms).terms, tt.vars));
    expect(f.result.terms).toHaveLength(4);

    // Equivalence against built-in mux & counterexample against buggy variant
    const eq = compareCircuits(c, compileClean(mux4Builtin));
    expect(eq).toMatchObject({ equal: true, mode: "exhaustive", tried: 64, mismatches: [] });

    const diff = compareCircuits(c, compileClean(mux4Buggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
    const mm = diff.mismatches[0];
    expect(mm.output).toBe("Y");
    expect(mm.inputs.S1).toBe(1);
    expect(mm.inputs.S0).toBe(0);
    expect(mm.inputs.D2).not.toBe(mm.inputs.D1);
  });
});

// =================================================================================================
// 2. 2-to-4 Decoder with enable from gates
// =================================================================================================
describe("2. 2-to-4 decoder with enable from gates", () => {
  const decGates = `
@name "2-to-4 Decoder (gates)"
@compact never
part EN, A1, A0 input-pin
part Y0, Y1, Y2, Y3 output-pin

part NA1, NA0 not
part G0, G1, G2, G3 and inputs=3

A1 -> NA1, G2.in1, G3.in1
NA1 -> G0.in1, G1.in1
A0 -> NA0, G1.in2, G3.in2
NA0 -> G0.in2, G2.in2
EN -> G0.in0, G1.in0, G2.in0, G3.in0
G0 -> Y0
G1 -> Y1
G2 -> Y2
G3 -> Y3
`;

  const decBuiltin = `
@name "2-to-4 Decoder (builtin)"
@compact never
part EN, A1, A0 input-pin
part Y0, Y1, Y2, Y3 output-pin
part D decoder inputs=2 enable=true

EN -> D.en
A0 -> D.a0
A1 -> D.a1
D.y0 -> Y0
D.y1 -> Y1
D.y2 -> Y2
D.y3 -> Y3
`;

  const decBuggy = `
@name "2-to-4 Decoder (buggy: Y3 ignores EN)"
@compact never
part EN, A1, A0 input-pin
part Y0, Y1, Y2, Y3 output-pin

part NA1, NA0 not
part G0, G1, G2 and inputs=3
part G3 and inputs=2

A1 -> NA1, G2.in1, G3.in0
NA1 -> G0.in1, G1.in1
A0 -> NA0, G1.in2, G3.in1
NA0 -> G0.in2, G2.in2
EN -> G0.in0, G1.in0, G2.in0
G0 -> Y0
G1 -> Y1
G2 -> Y2
G3 -> Y3
`;

  it("matches reference, produces textbook SOP & K-maps, and compares correctly", () => {
    const c = compileClean(decGates);
    expectCheckClean(c);

    const sim = new Simulator(c);
    for (let en = 0; en <= 1; en++) {
      for (let a = 0; a < 4; a++) {
        sim.set("EN", en);
        sim.set("A1", (a >> 1) & 1);
        sim.set("A0", a & 1);
        const r = sim.settle();
        expect(r.issues).toEqual([]);
        for (let y = 0; y < 4; y++) {
          expect(sim.read(`Y${y}`)).toBe(en && a === y ? 1 : 0);
        }
      }
    }

    const tt = truthTable(c);
    const fns = outputFunctions(tt);
    expect(fns.every((f) => typeof f.kmap === "string")).toBe(true);
    expect(sopMap(tt)).toEqual({
      Y0: "ENA1'A0'",
      Y1: "ENA1'A0",
      Y2: "ENA1A0'",
      Y3: "ENA1A0",
    });
    expect(truthTableText(tt).split("\n")).toHaveLength(2 + 8);

    expect(compareCircuits(c, compileClean(decBuiltin))).toMatchObject({ equal: true, mode: "exhaustive", tried: 8 });
    const diff = compareCircuits(c, compileClean(decBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches[0]).toMatchObject({ output: "Y3", inputs: { EN: 0, A1: 1, A0: 1 }, a: 0, b: 1 });
  });
});

// =================================================================================================
// 3. 4-to-2 Priority Encoder from gates
// =================================================================================================
describe("3. 4-to-2 priority encoder from gates", () => {
  const encGates = `
@name "4-to-2 Priority Encoder (gates)"
@compact never
part D3, D2, D1, D0 input-pin
part Y1, Y0, V output-pin

part ND2 not
part A0 and
part O_Y1, O_Y0 or
part O_V or inputs=4

D2 -> ND2, O_Y1.in1, O_V.in1
D3 -> O_Y1.in0, O_Y0.in0, O_V.in0
ND2 -> A0.in0
D1 -> A0.in1, O_V.in2
D0 -> O_V.in3
A0 -> O_Y0.in1
O_Y1 -> Y1
O_Y0 -> Y0
O_V -> V
`;

  const encBuiltin = `
@name "4-to-2 Priority Encoder (builtin)"
@compact never
part D3, D2, D1, D0 input-pin
part Y1, Y0, V output-pin
part E encoder outputBits=2 priority=true validOut=true enable=false

D0 -> E.d0
D1 -> E.d1
D2 -> E.d2
D3 -> E.d3
E.y0 -> Y0
E.y1 -> Y1
E.v -> V
`;

  const encBuggy = `
@name "4-to-2 Priority Encoder (buggy: Y0 missing D2' mask)"
@compact never
part D3, D2, D1, D0 input-pin
part Y1, Y0, V output-pin
part O_Y1, O_Y0 or
part O_V or inputs=4

D3 -> O_Y1.in0, O_Y0.in0, O_V.in0
D2 -> O_Y1.in1, O_V.in1
D1 -> O_Y0.in1, O_V.in2
D0 -> O_V.in3
O_Y1 -> Y1
O_Y0 -> Y0
O_V -> V
`;

  it("matches priority reference, textbook SOPs, and compares against builtin encoder", () => {
    const c = compileClean(encGates);
    expectCheckClean(c);

    const ref = (d3: number, d2: number, d1: number, d0: number) => {
      if (d3) return { y1: 1, y0: 1, v: 1 };
      if (d2) return { y1: 1, y0: 0, v: 1 };
      if (d1) return { y1: 0, y0: 1, v: 1 };
      if (d0) return { y1: 0, y0: 0, v: 1 };
      return { y1: 0, y0: 0, v: 0 };
    };

    const sim = new Simulator(c);
    for (let m = 0; m < 16; m++) {
      const d3 = (m >> 3) & 1, d2 = (m >> 2) & 1, d1 = (m >> 1) & 1, d0 = m & 1;
      sim.set("D3", d3);
      sim.set("D2", d2);
      sim.set("D1", d1);
      sim.set("D0", d0);
      expect(sim.settle().issues).toEqual([]);
      const e = ref(d3, d2, d1, d0);
      expect({ y1: sim.read("Y1"), y0: sim.read("Y0"), v: sim.read("V") }).toEqual(e);
    }

    const tt = truthTable(c);
    expect(sopMap(tt)).toEqual({
      Y1: "D2 + D3",
      Y0: "D3 + D2'D1",
      V: "D0 + D1 + D2 + D3",
    });

    expect(compareCircuits(c, compileClean(encBuiltin))).toMatchObject({ equal: true, mode: "exhaustive", tried: 16 });
    const diff = compareCircuits(c, compileClean(encBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches[0]).toMatchObject({ output: "Y0", inputs: { D3: 0, D2: 1, D1: 1 }, a: 0, b: 1 });
  });
});

// =================================================================================================
// 4. 4-bit Ripple-Carry Adder from Full Adders
// =================================================================================================
describe("4. 4-bit ripple-carry adder from full adders", () => {
  const rca4 = `
@name "4-bit Ripple-Carry Adder"
@compact never
part A, B input-pin width=4
part CIN input-pin
part S output-pin width=4
part COUT output-pin

part SPA, SPB, SPS splitter width=4 fanOut=4
part FA0..FA3 full-adder

A -> SPA.bus
B -> SPB.bus
SPS.bus -> S

SPA.b0 -> FA0.a
SPB.b0 -> FA0.b
CIN -> FA0.cin
FA0.s -> SPS.b0

SPA.b1 -> FA1.a
SPB.b1 -> FA1.b
FA0.cout -> FA1.cin
FA1.s -> SPS.b1

SPA.b2 -> FA2.a
SPB.b2 -> FA2.b
FA1.cout -> FA2.cin
FA2.s -> SPS.b2

SPA.b3 -> FA3.a
SPB.b3 -> FA3.b
FA2.cout -> FA3.cin
FA3.s -> SPS.b3
FA3.cout -> COUT
`;

  const adderBuiltin = `
@name "4-bit Adder (builtin)"
@compact never
part A, B input-pin width=4
part CIN input-pin
part S output-pin width=4
part COUT output-pin
part ADD adder width=4 carryIn=true carryOut=true

A -> ADD.a
B -> ADD.b
CIN -> ADD.cin
ADD.s -> S
ADD.cout -> COUT
`;

  const rcaBuggy = rca4.replace("FA1.cout -> FA2.cin", "CIN -> FA2.cin");

  it("matches arithmetic reference over all 512 input combinations, extracts S0 SOP, and compares correctly", () => {
    const c = compileClean(rca4);
    expectCheckClean(c);

    // Exhaustive truthTable (512 rows)
    const tt = truthTable(c);
    expect(tt.rows).toHaveLength(512);
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        for (let cin = 0; cin <= 1; cin++) {
          const m = (a << 5) | (b << 1) | cin;
          const row = tt.rows[m];
          const sum = a + b + cin;
          const s = row[0] | (row[1] << 1) | (row[2] << 2) | (row[3] << 3);
          const cout = row[4];
          expect(s).toBe(sum & 0xf);
          expect(cout).toBe((sum >> 4) & 1);
        }
      }
    }

    // Check minimal SOP of LSB sum (S[0] = A[0] ^ B[0] ^ CIN)
    const sim = new Simulator(c);
    for (const [a, b, cin] of [[0, 0, 0], [15, 1, 0], [7, 8, 1], [15, 15, 1], [9, 6, 0]]) {
      sim.set("A", a);
      sim.set("B", b);
      sim.set("CIN", cin);
      expect(sim.settle().issues).toEqual([]);
      expect(sim.read("S")).toBe((a + b + cin) & 0xf);
      expect(sim.read("COUT")).toBe(((a + b + cin) >> 4) & 1);
    }

    // Verify S[0] SOP via outputFunctions on a 1-bit slice
    const fa1 = compileClean(`
@name "1-bit Full Adder"
@compact never
part A, B, CIN input-pin
part S, COUT output-pin
part FA full-adder
A -> FA.a
B -> FA.b
CIN -> FA.cin
FA.s -> S
FA.cout -> COUT
`);
    expect(sopMap(truthTable(fa1))).toEqual({
      S: "A'B'CIN + A'BCIN' + AB'CIN' + ABCIN",
      COUT: "BCIN + ACIN + AB",
    });

    // Compare against built-in 4-bit adder & buggy carry chain
    expect(compareCircuits(c, compileClean(adderBuiltin))).toMatchObject({ equal: true, mode: "exhaustive", tried: 512 });
    const diff = compareCircuits(c, compileClean(rcaBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 5. 4-bit Adder/Subtractor with an XOR row
// =================================================================================================
describe("5. 4-bit adder/subtractor with XOR row", () => {
  const addSub = `
@name "4-bit Adder/Subtractor"
@compact never
part A, B input-pin width=4
part SUB input-pin
part S output-pin width=4
part COUT output-pin

part SPA, SPB, SPS splitter width=4 fanOut=4
part X0..X3 xor
part FA0..FA3 full-adder

A -> SPA.bus
B -> SPB.bus
SPS.bus -> S

SUB -> X0.in1, X1.in1, X2.in1, X3.in1, FA0.cin

SPB.b0 -> X0.in0
SPB.b1 -> X1.in0
SPB.b2 -> X2.in0
SPB.b3 -> X3.in0

SPA.b0 -> FA0.a
X0 -> FA0.b
FA0.s -> SPS.b0

SPA.b1 -> FA1.a
X1 -> FA1.b
FA0.cout -> FA1.cin
FA1.s -> SPS.b1

SPA.b2 -> FA2.a
X2 -> FA2.b
FA1.cout -> FA2.cin
FA2.s -> SPS.b2

SPA.b3 -> FA3.a
X3 -> FA3.b
FA2.cout -> FA3.cin
FA3.s -> SPS.b3
FA3.cout -> COUT
`;

  const addSubAlt = `
@name "4-bit Adder/Subtractor (adder + subtractor + mux)"
@compact never
part A, B input-pin width=4
part SUB input-pin
part S output-pin width=4
part COUT output-pin

part ZERO constant value=0
part ADD adder width=4 carryIn=true carryOut=true
part SUBU subtractor width=4 borrowIn=false borrowOut=true
part NBOUT not
part MS mux selectBits=1 dataWidth=4 selectMode=bits
part MC mux selectBits=1 dataWidth=1 selectMode=bits

A -> ADD.a, SUBU.a
B -> ADD.b, SUBU.b
ZERO -> ADD.cin
ADD.s -> MS.d0
SUBU.d -> MS.d1
SUB -> MS.s0, MC.s0
MS.y -> S
ADD.cout -> MC.d0
SUBU.bout -> NBOUT
NBOUT -> MC.d1
MC.y -> COUT
`;

  const addSubBuggy = `
@name "4-bit Adder/Subtractor (buggy: missing +1 cin on subtract)"
@compact never
part A, B input-pin width=4
part SUB input-pin
part S output-pin width=4
part COUT output-pin
part GND ground
part SPA, SPB, SPS splitter width=4 fanOut=4
part X0..X3 xor
part FA0..FA3 full-adder

A -> SPA.bus
B -> SPB.bus
SPS.bus -> S
SUB -> X0.in1, X1.in1, X2.in1, X3.in1
GND -> FA0.cin

SPB.b0 -> X0.in0
SPB.b1 -> X1.in0
SPB.b2 -> X2.in0
SPB.b3 -> X3.in0

SPA.b0 -> FA0.a
X0 -> FA0.b
FA0.s -> SPS.b0
SPA.b1 -> FA1.a
X1 -> FA1.b
FA0.cout -> FA1.cin
FA1.s -> SPS.b1
SPA.b2 -> FA2.a
X2 -> FA2.b
FA1.cout -> FA2.cin
FA2.s -> SPS.b2
SPA.b3 -> FA3.a
X3 -> FA3.b
FA2.cout -> FA3.cin
FA3.s -> SPS.b3
FA3.cout -> COUT
`;

  it("matches add/sub reference across all 512 combinations and compares against adder+subtractor+mux", () => {
    const c = compileClean(addSub);
    expectCheckClean(c);

    const tt = truthTable(c);
    expect(tt.rows).toHaveLength(512);
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        for (let sub = 0; sub <= 1; sub++) {
          const m = (a << 5) | (b << 1) | sub;
          const row = tt.rows[m];
          const raw = sub ? a + (~b & 0xf) + 1 : a + b;
          const s = row[0] | (row[1] << 1) | (row[2] << 2) | (row[3] << 3);
          expect(s).toBe(raw & 0xf);
          expect(row[4]).toBe((raw >> 4) & 1);
        }
      }
    }

    expect(compareCircuits(c, compileClean(addSubAlt))).toMatchObject({ equal: true, mode: "exhaustive", tried: 512 });
    const diff = compareCircuits(c, compileClean(addSubBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches[0].inputs.SUB).toBe(1);
  });
});

// =================================================================================================
// 6. 2-bit Magnitude Comparator from gates
// =================================================================================================
describe("6. 2-bit magnitude comparator from gates", () => {
  const cmpGates = `
@name "2-bit Magnitude Comparator (gates)"
@compact never
part A1, A0, B1, B0 input-pin
part GT, EQ, LT output-pin

part NA1, NA0, NB1, NB0 not
part E1, E0 xnor
part G_EQ and
part GT_HI and
part GT_LO and inputs=3
part G_GT or
part LT_HI and
part LT_LO and inputs=3
part G_LT or

A1 -> NA1, E1.in0, GT_HI.in0
B1 -> NB1, E1.in1, LT_HI.in1
A0 -> NA0, E0.in0, GT_LO.in1
B0 -> NB0, E0.in1, LT_LO.in2

NA1 -> LT_HI.in0
NB1 -> GT_HI.in1
NA0 -> LT_LO.in1
NB0 -> GT_LO.in2

E1 -> G_EQ.in0, GT_LO.in0, LT_LO.in0
E0 -> G_EQ.in1
G_EQ -> EQ

GT_HI -> G_GT.in0
GT_LO -> G_GT.in1
G_GT -> GT

LT_HI -> G_LT.in0
LT_LO -> G_LT.in1
G_LT -> LT
`;

  const cmpBuiltin = `
@name "2-bit Magnitude Comparator (builtin)"
@compact never
part A1, A0, B1, B0 input-pin
part GT, EQ, LT output-pin
part CMP comparator width=2 pinMode=bits

A0 -> CMP.a0
A1 -> CMP.a1
B0 -> CMP.b0
B1 -> CMP.b1
CMP.gt -> GT
CMP.eq -> EQ
CMP.lt -> LT
`;

  const cmpBuggy = `
@name "2-bit Magnitude Comparator (buggy: GT_LO ignores E1)"
@compact never
part A1, A0, B1, B0 input-pin
part GT, EQ, LT output-pin

part NA1, NA0, NB1, NB0 not
part E1, E0 xnor
part G_EQ, GT_HI, GT_LO, LT_HI and
part LT_LO and inputs=3
part G_GT, G_LT or

A1 -> NA1, E1.in0, GT_HI.in0
B1 -> NB1, E1.in1, LT_HI.in1
A0 -> NA0, E0.in0, GT_LO.in0
B0 -> NB0, E0.in1, LT_LO.in2
NA1 -> LT_HI.in0
NB1 -> GT_HI.in1
NA0 -> LT_LO.in1
NB0 -> GT_LO.in1
E1 -> G_EQ.in0, LT_LO.in0
E0 -> G_EQ.in1
G_EQ -> EQ
GT_HI -> G_GT.in0
GT_LO -> G_GT.in1
G_GT -> GT
LT_HI -> G_LT.in0
LT_LO -> G_LT.in1
G_LT -> LT
`;

  it("matches reference, recovers textbook SOPs, and compares against builtin comparator", () => {
    const c = compileClean(cmpGates);
    expectCheckClean(c);

    const sim = new Simulator(c);
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        sim.set("A1", (a >> 1) & 1);
        sim.set("A0", a & 1);
        sim.set("B1", (b >> 1) & 1);
        sim.set("B0", b & 1);
        expect(sim.settle().issues).toEqual([]);
        expect(sim.read("GT")).toBe(a > b ? 1 : 0);
        expect(sim.read("EQ")).toBe(a === b ? 1 : 0);
        expect(sim.read("LT")).toBe(a < b ? 1 : 0);
      }
    }

    const tt = truthTable(c);
    expect(sopMap(tt)).toEqual({
      GT: "A1B1' + A0B1'B0' + A1A0B0'",
      EQ: "A1'A0'B1'B0' + A1'A0B1'B0 + A1A0'B1B0' + A1A0B1B0",
      LT: "A1'B1 + A0'B1B0 + A1'A0'B0",
    });

    expect(compareCircuits(c, compileClean(cmpBuiltin))).toMatchObject({ equal: true, mode: "exhaustive", tried: 16 });
    const diff = compareCircuits(c, compileClean(cmpBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches[0]).toMatchObject({ output: "GT", inputs: { A1: 0, A0: 1, B1: 1, B0: 0 }, a: 0, b: 1 });
  });
});

// =================================================================================================
// 7. BCD to 7-Segment Decoder from gates
// =================================================================================================
describe("7. BCD to 7-segment decoder from gates", () => {
  // Exact 0..9 segments (blank for 10..15), matching textbook 7-segment truth table & builtin bcd-7seg:
  // a: 0,2,3,5,6,7,8,9   b: 0,1,2,3,4,7,8,9   c: 0,1,3,4,5,6,7,8,9   d: 0,2,3,5,6,8,9
  // e: 0,2,6,8           f: 0,4,5,6,8,9       g: 2,3,4,5,6,8,9
  const bcdGates = `
@name "BCD to 7-Segment Decoder (gates)"
@compact never
part D3, D2, D1, D0 input-pin
part a, b, c, d, e, f, g output-pin

part N3, N2, N1, N0 not
part M0, M1, M2, M3, M4, M5, M6, M7, M8, M9 and inputs=4
part OA or inputs=8
part OB or inputs=8
part OC or inputs=9
part OD or inputs=7
part OE or inputs=4
part OF or inputs=6
part OG or inputs=7

D3 -> N3, M8.in0, M9.in0
N3 -> M0.in0, M1.in0, M2.in0, M3.in0, M4.in0, M5.in0, M6.in0, M7.in0
D2 -> N2, M4.in1, M5.in1, M6.in1, M7.in1
N2 -> M0.in1, M1.in1, M2.in1, M3.in1, M8.in1, M9.in1
D1 -> N1, M2.in2, M3.in2, M6.in2, M7.in2
N1 -> M0.in2, M1.in2, M4.in2, M5.in2, M8.in2, M9.in2
D0 -> N0, M1.in3, M3.in3, M5.in3, M7.in3, M9.in3
N0 -> M0.in3, M2.in3, M4.in3, M6.in3, M8.in3

M0 -> OA.in0, OB.in0, OC.in0, OD.in0, OE.in0, OF.in0
M1 -> OB.in1, OC.in1
M2 -> OA.in1, OB.in2, OD.in1, OE.in1, OG.in0
M3 -> OA.in2, OB.in3, OC.in2, OD.in2, OG.in1
M4 -> OB.in4, OC.in3, OF.in1, OG.in2
M5 -> OA.in3, OC.in4, OD.in3, OF.in2, OG.in3
M6 -> OA.in4, OC.in5, OD.in4, OE.in2, OF.in3, OG.in4
M7 -> OA.in5, OB.in5, OC.in6
M8 -> OA.in6, OB.in6, OC.in7, OD.in5, OE.in3, OF.in4, OG.in5
M9 -> OA.in7, OB.in7, OC.in8, OD.in6, OF.in5, OG.in6

OA -> a
OB -> b
OC -> c
OD -> d
OE -> e
OF -> f
OG -> g
`;

  const bcdBuiltin = `
@name "BCD to 7-Segment Decoder (builtin)"
@compact never
part D3, D2, D1, D0 input-pin
part a, b, c, d, e, f, g output-pin
part DEC bcd-7seg pinMode=bits activeLow=false controls=false

D0 -> DEC.bcd0
D1 -> DEC.bcd1
D2 -> DEC.bcd2
D3 -> DEC.bcd3
DEC.a -> a
DEC.b -> b
DEC.c -> c
DEC.d -> d
DEC.e -> e
DEC.f -> f
DEC.g -> g
`;

  // Buggy: digit 6 missing segment a (common variant mismatch)
  const bcdBuggy = bcdGates
    .replace("part OA or inputs=8", "part OA or inputs=7")
    .replace("M6 -> OA.in4, OC.in5, OD.in4, OE.in2, OF.in3, OG.in4", "M6 -> OC.in5, OD.in4, OE.in2, OF.in3, OG.in4")
    .replace("M7 -> OA.in5, OB.in5, OC.in6", "M7 -> OA.in4, OB.in5, OC.in6")
    .replace("M8 -> OA.in6,", "M8 -> OA.in5,")
    .replace("M9 -> OA.in7,", "M9 -> OA.in6,");

  it("matches 7-segment table for digits 0..9 and blanks 10..15, minimizes SOPs, and compares with builtin", { timeout: 60000 }, () => {
    const c = compileClean(bcdGates);
    expectCheckClean(c);

    // Independent reference bitmasks (a=bit6 .. g=bit0)
    const refSegs = [0b1111110, 0b0110000, 0b1101101, 0b1111001, 0b0110011, 0b1011011, 0b1011111, 0b1110000, 0b1111111, 0b1111011];
    const segNames = ["a", "b", "c", "d", "e", "f", "g"];

    const sim = new Simulator(c);
    for (let d = 0; d < 16; d++) {
      sim.set("D3", (d >> 3) & 1);
      sim.set("D2", (d >> 2) & 1);
      sim.set("D1", (d >> 1) & 1);
      sim.set("D0", d & 1);
      expect(sim.settle().issues).toEqual([]);
      const mask = d < 10 ? refSegs[d] : 0;
      segNames.forEach((s, i) => expect(sim.read(s)).toBe((mask >> (6 - i)) & 1));
    }

    const tt = truthTable(c);
    const fns = outputFunctions(tt);
    expect(fns).toHaveLength(7);
    // Segment e lights only for 0, 2, 6, 8 -> minimal SOP is D3'D1D0' + D2'D1'D0'
    const fe = fns.find((x) => x.name === "e")!;
    expect(fe.minterms).toEqual([0, 2, 6, 8]);
    expect(fe.sop).toBe("D2'D1'D0' + D3'D1D0'");

    expect(compareCircuits(c, compileClean(bcdBuiltin))).toMatchObject({ equal: true, mode: "exhaustive", tried: 16 });
    const diff = compareCircuits(c, compileClean(bcdBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches[0]).toMatchObject({ output: "a", inputs: { D3: 0, D2: 1, D1: 1, D0: 0 }, a: 1, b: 0 });
  });
});

// =================================================================================================
// 8. SR Latch from NAND gates
// =================================================================================================
describe("8. SR latch from NAND gates", () => {
  const srNand = `
@name "SR Latch (NAND gates, active-low S_N/R_N)"
@compact never
part S_N, R_N input-pin
part Q, QN output-pin
part G1, G2 nand

S_N -> G1.in0
G2 -> G1.in1, QN
R_N -> G2.in0
G1 -> G2.in1, Q
`;

  // Active-high SR latch wrapped around NAND latch for comparison with builtin sr-latch
  const srActiveHighFromNand = `
@name "Active-High SR Latch from NANDs"
@compact never
part S, R input-pin
part Q, QN output-pin
part NS, NR not
part G1, G2 nand

S -> NS
R -> NR
NS -> G1.in0
NR -> G2.in0
G2 -> G1.in1, QN
G1 -> G2.in1, Q
`;

  const srActiveHighBuiltin = `
@name "Active-High SR Latch (via activeLow sr-latch + inverters)"
@compact never
part S, R input-pin
part Q, QN output-pin
part NS, NR not
part L sr-latch activeLow=true

S -> NS
R -> NR
NS -> L.s
NR -> L.r
L.q -> Q
L.qn -> QN
`;

  const srActiveHighBuggy = srActiveHighFromNand.replace("G1 -> G2.in1, Q", "G1 -> G2.in1, QN").replace("G2 -> G1.in1, QN", "G2 -> G1.in1, Q");

  it("holds state, sets/resets, detects forbidden oscillation, and passes static check with feedback info", () => {
    const c = compileClean(srNand);
    const issues = expectCheckClean(c);
    expect(issues.some((i) => i.kind === "feedback" && i.severity === "info")).toBe(true);

    const sim = new Simulator(c);
    // Start in hold (S_N=1, R_N=1): uninitialized -> X, stable
    sim.set("S_N", 1);
    sim.set("R_N", 1);
    let r = sim.settle();
    expect(r.stable).toBe(true);
    expect(sim.read("Q")).toBeNull();
    expect(sim.read("QN")).toBeNull();

    // Set (S_N=0, R_N=1) -> Q=1, QN=0
    sim.set("S_N", 0);
    r = sim.settle();
    expect(r.stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);

    // Hold (S_N=1, R_N=1) -> retains Q=1, QN=0
    sim.set("S_N", 1);
    r = sim.settle();
    expect(r.stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);

    // Reset (S_N=1, R_N=0) -> Q=0, QN=1
    sim.set("R_N", 0);
    r = sim.settle();
    expect(r.stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);

    // Hold (S_N=1, R_N=1) -> retains Q=0, QN=1
    sim.set("R_N", 1);
    r = sim.settle();
    expect(r.stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);

    // Forbidden (S_N=0, R_N=0) -> both Q=1, QN=1
    sim.set("S_N", 0);
    sim.set("R_N", 0);
    r = sim.settle();
    expect(r.stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 1]);

    // Simultaneous release from forbidden -> oscillation!
    sim.set("S_N", 1);
    sim.set("R_N", 1);
    r = sim.settle();
    expect(r.stable).toBe(false);
    expect(r.issues.some((i) => i.kind === "oscillation")).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([null, null]);

    // Buggy swapped Q/QN is caught by compareCircuits
    const cGood = compileClean(srActiveHighFromNand);
    const cBad = compileClean(srActiveHighBuggy);
    const diff = compareCircuits(cGood, cBad);
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);

    // Equivalent comparison against builtin active-low sr-latch + inverters (reset on first 2 cycles)
    const cBuiltin = compileClean(srActiveHighBuiltin);
    const eq = compareCircuits(cGood, cBuiltin, { cycles: 100, resets: ["R"] });
    expect(eq.equal).toBe(true);
  });
});

// =================================================================================================
// 9. Gated D Latch from gates
// =================================================================================================
describe("9. gated D latch from gates", () => {
  const dLatchGates = `
@name "Gated D Latch (gates)"
@compact never
part D, EN input-pin
part Q, QN output-pin

part ND not
part N1, N2, N3, N4 nand

D -> ND, N1.in0
ND -> N2.in0
EN -> N1.in1, N2.in1
N1 -> N3.in0
N2 -> N4.in0
N4 -> N3.in1, QN
N3 -> N4.in1, Q
`;

  const dLatchBuiltin = `
@name "Gated D Latch (builtin)"
@compact never
part D, EN input-pin
part Q, QN output-pin
part L d-latch

D -> L.d
EN -> L.en
L.q -> Q
L.qn -> QN
`;

  const dLatchBuggy = dLatchGates.replace("ND -> N2.in0", "D -> N2.in0").replace("D -> ND, N1.in0", "D -> N1.in0").replace("part ND not\n", "");

  it("tracks D when transparent, holds when disabled, and compares equal to builtin d-latch", () => {
    const c = compileClean(dLatchGates);
    const issues = expectCheckClean(c);
    expect(issues.some((i) => i.kind === "feedback")).toBe(true);

    const sim = new Simulator(c);
    let qRef: number | null = null;
    const seq: [number, number][] = [
      [0, 0], // disabled before init -> X
      [1, 1], // transparent -> 1
      [1, 0], // transparent -> 0
      [0, 1], // hold -> 0
      [0, 0], // hold -> 0
      [1, 1], // transparent -> 1
      [0, 0], // hold -> 1
      [0, 1], // hold -> 1
      [1, 0], // transparent -> 0
      [0, 1], // hold -> 0
    ];
    for (const [en, d] of seq) {
      sim.set("EN", en);
      sim.set("D", d);
      const r = sim.settle();
      expect(r.stable).toBe(true);
      expect(r.issues).toEqual([]);
      if (en === 1) qRef = d;
      expect(sim.read("Q")).toBe(qRef);
      expect(sim.read("QN")).toBe(qRef === null ? null : 1 - qRef);
    }

    // Holding EN=1 for first 2 cycles initializes both latches to D, then random cycles match
    const eq = compareCircuits(c, compileClean(dLatchBuiltin), { cycles: 200, resets: ["EN"] });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 200 });

    const diff = compareCircuits(c, compileClean(dLatchBuggy), { cycles: 100, resets: ["EN"] });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 10. Master-Slave D Flip-Flop from two latches
// =================================================================================================
describe("10. master-slave D flip-flop from two latches", () => {
  const msDff = `
@name "Master-Slave D Flip-Flop (two D latches)"
@compact never
part D input-pin
part CLK clock
part Q, QN output-pin

part NCLK not
part MASTER, SLAVE d-latch

CLK -> NCLK, SLAVE.en
NCLK -> MASTER.en
D -> MASTER.d
MASTER.q -> SLAVE.d
SLAVE.q -> Q
SLAVE.qn -> QN
`;

  const dffBuiltin = `
@name "D Flip-Flop (builtin)"
@compact never
part D input-pin
part CLK clock
part Q, QN output-pin
part FF d-ff edge=rising

D -> FF.d
CLK -> FF.clk
FF.q -> Q
FF.qn -> QN
`;

  const msDffFallingBuggy = `
@name "Master-Slave DFF (buggy: inverted clock phase / falling edge)"
@compact never
part D input-pin
part CLK clock
part Q, QN output-pin

part NCLK not
part MASTER, SLAVE d-latch

CLK -> NCLK, MASTER.en
NCLK -> SLAVE.en
D -> MASTER.d
MASTER.q -> SLAVE.d
SLAVE.q -> Q
SLAVE.qn -> QN
`;

  it("samples only on rising clock edge, supports stateTable, and equals builtin rising d-ff", () => {
    const c = compileClean(msDff);
    expectCheckClean(c);

    const sim = new Simulator(c, { initial: "zero" });
    sim.set("D", 0);
    sim.settle();
    expect(sim.read("Q")).toBe(0);

    // Changing D while CLK=0 must NOT change Q
    sim.set("D", 1);
    sim.settle();
    expect(sim.read("Q")).toBe(0);

    // Rising edge captures D=1
    sim.set("CLK", 1);
    sim.settle();
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);

    // Changing D while CLK=1 must NOT change Q (master is closed)
    sim.set("D", 0);
    sim.settle();
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);

    // Falling edge holds Q=1 (master captures D=0, slave closes)
    sim.set("CLK", 0);
    sim.settle();
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);

    // Next tick captures D=0
    sim.tick();
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);

    // stateTable cuts both latches open
    const st = stateTable(c);
    expect(st.state.map((s) => s.name)).toEqual(["MASTER_q", "SLAVE_q"]);
    const eqs = sopMap(st);
    expect(eqs.MASTER_d).toBe("D");
    expect(eqs.SLAVE_d).toBe("MASTER_q");
    expect(eqs.Q).toBe("SLAVE_q");

    // compareCircuits against builtin rising-edge d-ff
    const eq = compareCircuits(c, compileClean(dffBuiltin), { cycles: 200 });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 200 });

    const diff = compareCircuits(c, compileClean(msDffFallingBuggy), { cycles: 100 });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 11. 4-bit Synchronous Counter from T Flip-Flops
// =================================================================================================
describe("11. 4-bit synchronous counter from T flip-flops", () => {
  const tffCounter = `
@name "4-bit Synchronous Counter (T-FFs)"
@compact never
part EN, RST input-pin
part CLK clock
part Q output-pin width=4

part F0..F3 t-ff asyncReset=active-high
part A1, A2, A3 and
part SPQ splitter width=4 fanOut=4

CLK -> F0..F3.clk
RST -> F0..F3.rst

EN -> F0.t, A1.in0
F0.q -> A1.in1, SPQ.b0
A1 -> F1.t, A2.in0
F1.q -> A2.in1, SPQ.b1
A2 -> F2.t, A3.in0
F2.q -> A3.in1, SPQ.b2
A3 -> F3.t
F3.q -> SPQ.b3
SPQ.bus -> Q
`;

  const counterBuiltin = `
@name "4-bit Counter (builtin)"
@compact never
part EN, RST input-pin
part CLK clock
part Q output-pin width=4
part C counter bits=4 enable=true reset=true carryOut=false

EN -> C.en
RST -> C.rst
CLK -> C.clk
C.q -> Q
`;

  const tffCounterBuggy = tffCounter.replace("A1 -> F1.t, A2.in0", "A1 -> F1.t\nEN -> A2.in0");

  it("counts 0..15 with enable/reset, gives exact T-FF excitation equations, and equals builtin counter", () => {
    const c = compileClean(tffCounter);
    expectCheckClean(c);

    // Simulation with default X start, then async reset, then counting & pausing
    const sim = new Simulator(c);
    sim.set("RST", 1);
    sim.set("EN", 0);
    sim.settle();
    expect(sim.read("Q")).toBe(0);

    sim.set("RST", 0);
    sim.settle();
    let expected = 0;
    const enSeq = [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
    for (const en of enSeq) {
      sim.set("EN", en);
      sim.settle();
      const [up, dn] = sim.tick();
      expect(up.issues).toEqual([]);
      expect(dn.issues).toEqual([]);
      if (en) expected = (expected + 1) & 0xf;
      expect(sim.read("Q")).toBe(expected);
    }

    // stateTable excitation equations
    const st = stateTable(c);
    const eqs = sopMap(st);
    expect(eqs.F0_t).toBe("EN");
    expect(eqs.F1_t).toBe("F0_qEN");
    expect(eqs.F2_t).toBe("F0_qF1_qEN");
    expect(eqs.F3_t).toBe("F0_qF1_qF2_qEN");

    // compareCircuits against built-in counter
    const eq = compareCircuits(c, compileClean(counterBuiltin), { cycles: 200, resets: ["RST"] });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 200 });

    const diff = compareCircuits(c, compileClean(tffCounterBuggy), { cycles: 100, resets: ["RST"] });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 12. 4-bit Shift Register with Parallel Load from D Flip-Flops and Muxes
// =================================================================================================
describe("12. 4-bit shift register with parallel load from D-FFs and muxes", () => {
  const shiftReg = `
@name "4-bit Parallel-Load Shift Register (D-FFs + MUXes)"
@compact never
part SI, LOAD, RST input-pin
part D input-pin width=4
part CLK clock
part Q output-pin width=4
part SO output-pin

part SPD, SPQ splitter width=4 fanOut=4
part M0..M3 mux selectBits=1 dataWidth=1 selectMode=bits
part F0..F3 d-ff asyncReset=active-high

D -> SPD.bus
SPQ.bus -> Q
CLK -> F0..F3.clk
RST -> F0..F3.rst
LOAD -> M0..M3.s0

SI -> M3.d0
SPD.b3 -> M3.d1
M3.y -> F3.d
F3.q -> M2.d0, SPQ.b3

SPD.b2 -> M2.d1
M2.y -> F2.d
F2.q -> M1.d0, SPQ.b2

SPD.b1 -> M1.d1
M1.y -> F1.d
F1.q -> M0.d0, SPQ.b1

SPD.b0 -> M0.d1
M0.y -> F0.d
F0.q -> SPQ.b0, SO
`;

  const shiftRegBuiltin = `
@name "4-bit Shift Register (builtin)"
@compact never
part SI, LOAD, RST input-pin
part D input-pin width=4
part CLK clock
part Q output-pin width=4
part SO output-pin
part SR shift-register width=4 direction=right parallelLoad=true parallelOut=true reset=true

SI -> SR.sin
LOAD -> SR.load
RST -> SR.rst
D -> SR.d
CLK -> SR.clk
SR.q -> Q
SR.sout -> SO
`;

  const shiftRegBuggy = shiftReg.replace("F2.q -> M1.d0, SPQ.b2", "F3.q -> M1.d0\nF2.q -> SPQ.b2");

  it("loads and shifts right accurately, gives stateTable equations, and equals builtin shift-register", () => {
    const c = compileClean(shiftReg);
    expectCheckClean(c);

    const sim = new Simulator(c);
    sim.set("RST", 1);
    sim.settle();
    expect(sim.read("Q")).toBe(0);
    expect(sim.read("SO")).toBe(0);

    sim.set("RST", 0);
    // Parallel load 0b1011
    sim.set("LOAD", 1);
    sim.set("D", 0b1011);
    sim.set("SI", 0);
    sim.tick();
    expect(sim.read("Q")).toBe(0b1011);
    expect(sim.read("SO")).toBe(1);

    // Shift right with SI = 1, 0, 1, 0
    sim.set("LOAD", 0);
    let qRef = 0b1011;
    for (const si of [1, 0, 1, 0, 1]) {
      sim.set("SI", si);
      sim.tick();
      qRef = (qRef >> 1) | (si << 3);
      expect(sim.read("Q")).toBe(qRef);
      expect(sim.read("SO")).toBe(qRef & 1);
    }

    // stateTable excitation equations (cut open F0..F3)
    const st = stateTable(c);
    expect(st.state.map((s) => s.name)).toEqual(["F0_q", "F1_q", "F2_q", "F3_q"]);
    const eqs = sopMap(st);
    expect(eqs.SO).toBe("F0_q");
    // F3_d = LOAD' SI + LOAD D[3]
    expect(eqs.F3_d).toContain("LOADD[3]");
    // (literal order inside a term follows the variable order)
    expect(eqs.F3_d.split(" + ").some((t) => t === "LOAD'SI" || t === "SILOAD'")).toBe(true);

    // compareCircuits against built-in shift-register
    const eq = compareCircuits(c, compileClean(shiftRegBuiltin), { cycles: 200, resets: ["RST"] });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 200 });

    const diff = compareCircuits(c, compileClean(shiftRegBuggy), { cycles: 100, resets: ["RST"] });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 13. Moore Sequence Detector ("101", overlapping) from D Flip-Flops and gates
// =================================================================================================
describe("13. Moore sequence detector (101) from D-FFs and gates", () => {
  // States: S0=00, S1=01 (saw 1), S2=10 (saw 10), S3=11 (saw 101 -> Y=1)
  // D0 = X, D1 = Q0 X' + Q1 Q0' X, Y = Q1 Q0
  const moore101 = `
@name "Moore 101 Detector (binary encoding)"
@compact never
part X, RST input-pin
part CLK clock
part Y output-pin

part F1, F0 d-ff asyncReset=active-high
part NX not
part A1 and
part A2 and inputs=3
part OD1 or
part GY and

CLK -> F1.clk, F0.clk
RST -> F1.rst, F0.rst

X -> NX, F0.d, A2.in2
F0.q -> A1.in0, GY.in1
NX -> A1.in1
F1.q -> A2.in0, GY.in0
F0.qn -> A2.in1
A1 -> OD1.in0
A2 -> OD1.in1
OD1 -> F1.d
GY -> Y
`;

  // Equivalent one-hot implementation (4 D-FFs: S0 asyncSet, S1..S3 asyncReset)
  const moore101OneHot = `
@name "Moore 101 Detector (one-hot encoding)"
@compact never
part X, RST input-pin
part CLK clock
part Y output-pin

part S0 d-ff asyncSet=active-high
part S1, S2, S3 d-ff asyncReset=active-high
part NX not
part OS0, OS1, OS2 or
part A_S0, A_S1, A_S2, A_S3 and

CLK -> S0.clk, S1.clk, S2.clk, S3.clk
RST -> S0.set, S1.rst, S2.rst, S3.rst

X -> NX, A_S1.in1, A_S3.in1
NX -> A_S0.in1, A_S2.in1

# Next S0 = (S0 + S2) X'
S0.q -> OS0.in0, OS1.in0
S2.q -> OS0.in1, A_S3.in0
OS0 -> A_S0.in0
A_S0 -> S0.d

# Next S1 = (S0 + S1 + S3) X
S1.q -> OS1.in1, OS2.in0
S3.q -> OS2.in1, Y
part OS1b or
OS1 -> OS1b.in0
S3.q -> OS1b.in1
OS1b -> A_S1.in0
A_S1 -> S1.d

# Next S2 = (S1 + S3) X'
OS2 -> A_S2.in0
A_S2 -> S2.d

# Next S3 = S2 X
A_S3 -> S3.d
`;

  // Buggy: non-overlapping (S3 with X=0 goes to S0 instead of S2 -> D1 = Q1' Q0 X' + Q1 Q0' X)
  const moore101Buggy = `
@name "Moore 101 Detector (buggy: non-overlapping)"
@compact never
part X, RST input-pin
part CLK clock
part Y output-pin

part F1, F0 d-ff asyncReset=active-high
part NX not
part A1, A2 and inputs=3
part OD1 or
part GY and

CLK -> F1.clk, F0.clk
RST -> F1.rst, F0.rst
X -> NX, F0.d, A2.in2
F1.qn -> A1.in0
F0.q -> A1.in1, GY.in1
NX -> A1.in2
F1.q -> A2.in0, GY.in0
F0.qn -> A2.in1
A1 -> OD1.in0
A2 -> OD1.in1
OD1 -> F1.d
GY -> Y
`;

  it("detects overlapping 101 sequences, matches stateTable equations, and equals one-hot encoding", () => {
    const c = compileClean(moore101);
    expectCheckClean(c);

    // Independent behavioural reference (overlapping Moore 101)
    let state = 0; // 0:S0, 1:S1, 2:S2, 3:S3
    const nextRef = (s: number, x: number) => {
      if (s === 0) return x ? 1 : 0;
      if (s === 1) return x ? 1 : 2;
      if (s === 2) return x ? 3 : 0;
      return x ? 1 : 2;
    };

    const sim = new Simulator(c);
    sim.set("RST", 1);
    sim.settle();
    expect(sim.read("Y")).toBe(0);
    sim.set("RST", 0);

    const stream = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1];
    for (const x of stream) {
      sim.set("X", x);
      sim.settle();
      // Moore output must NOT change before the clock edge
      expect(sim.read("Y")).toBe(state === 3 ? 1 : 0);
      sim.tick();
      state = nextRef(state, x);
      expect(sim.read("Y")).toBe(state === 3 ? 1 : 0);
    }

    // stateTable next-state & output equations
    const st = stateTable(c);
    expect(st.state.map((s) => s.name)).toEqual(["F1_q", "F0_q"]);
    const eqs = sopMap(st);
    expect(eqs.F0_d).toBe("X");
    expect(eqs.F1_d).toBe("F0_qX' + F1_qF0_q'X");
    expect(eqs.Y).toBe("F1_qF0_q");

    // compareCircuits against one-hot encoding & non-overlapping buggy version
    const eq = compareCircuits(c, compileClean(moore101OneHot), { cycles: 250, resets: ["RST"] });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 250 });

    const diff = compareCircuits(c, compileClean(moore101Buggy), { cycles: 250, resets: ["RST"] });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 14. Mealy Sequence Detector ("101", overlapping) from D Flip-Flops and gates
// =================================================================================================
describe("14. Mealy sequence detector (101) from D-FFs and gates", () => {
  // States: S0=00, S1=01 (saw 1), S2=10 (saw 10). D0 = X, D1 = Q0 X', Y = Q1 X
  const mealy101 = `
@name "Mealy 101 Detector (gates + D-FFs)"
@compact never
part X, RST input-pin
part CLK clock
part Y output-pin

part F1, F0 d-ff asyncReset=active-high
part NX not
part AD1, GY and

CLK -> F1.clk, F0.clk
RST -> F1.rst, F0.rst

X -> NX, F0.d, GY.in1
F0.q -> AD1.in0
NX -> AD1.in1
AD1 -> F1.d
F1.q -> GY.in0
GY -> Y
`;

  // Equivalent shift-register Mealy implementation: A=prev X, B=prev-prev X, Y = B & A' & X
  const mealy101Shift = `
@name "Mealy 101 Detector (2-bit shift register)"
@compact never
part X, RST input-pin
part CLK clock
part Y output-pin

part FA, FB d-ff asyncReset=active-high
part GY and inputs=3

CLK -> FA.clk, FB.clk
RST -> FA.rst, FB.rst

X -> FA.d, GY.in2
FA.q -> FB.d
FA.qn -> GY.in1
FB.q -> GY.in0
GY -> Y
`;

  const mealy101Buggy = mealy101.replace("F1.q -> GY.in0", "F0.q -> GY.in0");

  it("asserts Y combinationally on matching input, matches stateTable, and equals shift-register version", () => {
    const c = compileClean(mealy101);
    expectCheckClean(c);

    // Independent behavioural reference
    let state = 0; // 0:S0, 1:S1, 2:S2
    const sim = new Simulator(c);
    sim.set("RST", 1);
    sim.set("X", 0);
    sim.settle();
    sim.set("RST", 0);

    const stream = [1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1];
    for (const x of stream) {
      sim.set("X", x);
      sim.settle();
      // Mealy output responds immediately before the clock edge
      const expectedY = state === 2 && x === 1 ? 1 : 0;
      expect(sim.read("Y")).toBe(expectedY);
      sim.tick();
      state = x === 1 ? 1 : state === 1 ? 2 : 0;
    }

    // stateTable equations
    const st = stateTable(c);
    const eqs = sopMap(st);
    expect(eqs.F0_d).toBe("X");
    expect(eqs.F1_d).toBe("F0_qX'");
    expect(eqs.Y).toBe("F1_qX");

    // compareCircuits against shift-register equivalent & buggy variant
    const eq = compareCircuits(c, compileClean(mealy101Shift), { cycles: 250, resets: ["RST"] });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 250 });

    const diff = compareCircuits(c, compileClean(mealy101Buggy), { cycles: 100, resets: ["RST"] });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 15. Traffic-Light Controller FSM (Harris & Harris Ch. 3)
// =================================================================================================
describe("15. traffic-light controller FSM", () => {
  // Binary encoding: S0=00 (GA,RB), S1=01 (YA,RB), S2=10 (RA,GB), S3=11 (RA,YB)
  // D1 = Q1 ^ Q0, D0 = Q1'Q0'TA' + Q1Q0'TB'
  const trafficBinary = `
@name "Traffic Light Controller (binary encoding)"
@compact never
part TA, TB, RST input-pin
part CLK clock
part GA, YA, RA, GB, YB, RB output-pin

part F1, F0 d-ff asyncReset=active-high
part NTA, NTB not
part XD1 xor
part AD0a, AD0b and inputs=3
part OD0 or
part G_GA, G_YA, G_GB, G_YB and

CLK -> F1.clk, F0.clk
RST -> F1.rst, F0.rst

TA -> NTA
TB -> NTB

F1.q -> XD1.in0, AD0b.in0, RA, G_GB.in0, G_YB.in0
F1.qn -> AD0a.in0, G_GA.in0, G_YA.in0, RB
F0.q -> XD1.in1, G_YA.in1, G_YB.in1
F0.qn -> AD0a.in1, AD0b.in1, G_GA.in1, G_GB.in1

NTA -> AD0a.in2
NTB -> AD0b.in2
XD1 -> F1.d
AD0a -> OD0.in0
AD0b -> OD0.in1
OD0 -> F0.d

G_GA -> GA
G_YA -> YA
G_GB -> GB
G_YB -> YB
`;

  // Equivalent Gray-code encoding: S0=00, S1=01, S2=11, S3=10
  // D1 = Q0, D0 = Q1'Q0'TA' + Q1'Q0 + Q1Q0TB
  const trafficGray = `
@name "Traffic Light Controller (Gray encoding)"
@compact never
part TA, TB, RST input-pin
part CLK clock
part GA, YA, RA, GB, YB, RB output-pin

part F1, F0 d-ff asyncReset=active-high
part NTA not
part T0 and inputs=3
part T1 and
part T2 and inputs=3
part OD0 or inputs=3
part G_GA, G_YA, G_GB, G_YB and

CLK -> F1.clk, F0.clk
RST -> F1.rst, F0.rst

TA -> NTA
F0.q -> F1.d, T1.in1, T2.in1, G_YA.in1, G_GB.in1
F0.qn -> T0.in1, G_GA.in1, G_YB.in1
F1.q -> T2.in0, RA, G_GB.in0, G_YB.in0
F1.qn -> T0.in0, T1.in0, G_GA.in0, G_YA.in0, RB
NTA -> T0.in2
TB -> T2.in2

T0 -> OD0.in0
T1 -> OD0.in1
T2 -> OD0.in2
OD0 -> F0.d

G_GA -> GA
G_YA -> YA
G_GB -> GB
G_YB -> YB
`;

  const trafficBuggy = trafficBinary.replace("NTA -> AD0a.in2\nNTB -> AD0b.in2", "NTB -> AD0a.in2\nNTA -> AD0b.in2");

  it("cycles lights safely (never both green/yellow), matches stateTable, and equals Gray encoding", () => {
    const c = compileClean(trafficBinary);
    expectCheckClean(c);

    // Independent behavioural reference
    type State = 0 | 1 | 2 | 3;
    const lights = (s: State) => ({
      GA: s === 0 ? 1 : 0,
      YA: s === 1 ? 1 : 0,
      RA: s === 2 || s === 3 ? 1 : 0,
      GB: s === 2 ? 1 : 0,
      YB: s === 3 ? 1 : 0,
      RB: s === 0 || s === 1 ? 1 : 0,
    });
    const nextState = (s: State, ta: number, tb: number): State => {
      if (s === 0) return ta ? 0 : 1;
      if (s === 1) return 2;
      if (s === 2) return tb ? 2 : 3;
      return 0;
    };

    const sim = new Simulator(c);
    sim.set("RST", 1);
    sim.settle();
    sim.set("RST", 0);

    let stRef: State = 0;
    const inputs: [number, number][] = [
      [1, 0], [1, 1], [0, 1], [1, 1], [1, 1], [0, 0], [0, 0], [1, 0], [0, 0], [0, 1], [1, 0],
    ];
    for (const [ta, tb] of inputs) {
      sim.set("TA", ta);
      sim.set("TB", tb);
      sim.settle();
      const got = {
        GA: sim.read("GA"), YA: sim.read("YA"), RA: sim.read("RA"),
        GB: sim.read("GB"), YB: sim.read("YB"), RB: sim.read("RB"),
      };
      expect(got).toEqual(lights(stRef));
      // Safety invariant: never both non-red
      expect(got.RA === 1 || got.RB === 1).toBe(true);
      sim.tick();
      stRef = nextState(stRef, ta, tb);
    }

    // stateTable next-state & output equations
    const st = stateTable(c);
    const eqs = sopMap(st);
    expect(eqs.F1_d).toBe("F1_q'F0_q + F1_qF0_q'");
    // (term order is the minimizer's)
    expect(eqs.F0_d.split(" + ").sort()).toEqual(["F1_q'F0_q'TA'", "F1_qF0_q'TB'"].sort());
    expect(eqs.GA).toBe("F1_q'F0_q'");
    expect(eqs.YA).toBe("F1_q'F0_q");
    expect(eqs.RA).toBe("F1_q");
    expect(eqs.GB).toBe("F1_qF0_q'");
    expect(eqs.YB).toBe("F1_qF0_q");
    expect(eqs.RB).toBe("F1_q'");

    // compareCircuits against Gray-encoded FSM & buggy sensor swap
    const eq = compareCircuits(c, compileClean(trafficGray), { cycles: 250, resets: ["RST"] });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 250 });

    const diff = compareCircuits(c, compileClean(trafficBuggy), { cycles: 100, resets: ["RST"] });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 16. 4-bit Register File (4x4, R0 hardwired to 0) from registers, decoder, and muxes
// =================================================================================================
describe("16. 4-bit register file from registers, decoder, and muxes", () => {
  const regFileStructural = `
@name "4x4 Register File (registers + decoder + muxes)"
@compact never
part WE input-pin
part WA, RA1, RA2 input-pin width=2
part WD input-pin width=4
part CLK clock
part RD1, RD2 output-pin width=4

part ZERO constant value=0 width=4
part SPWA splitter width=2 fanOut=2
part DEC decoder inputs=2 enable=true
part R1, R2, R3 register width=4 enable=true reset=false
part M1, M2 mux selectBits=2 dataWidth=4 selectMode=bus

WA -> SPWA.bus
SPWA.b0 -> DEC.a0
SPWA.b1 -> DEC.a1
WE -> DEC.en

CLK -> R1.clk, R2.clk, R3.clk
WD -> R1.d, R2.d, R3.d
DEC.y1 -> R1.en
DEC.y2 -> R2.en
DEC.y3 -> R3.en

ZERO -> M1.d0, M2.d0
R1.q -> M1.d1, M2.d1
R2.q -> M1.d2, M2.d2
R3.q -> M1.d3, M2.d3

RA1 -> M1.s
RA2 -> M2.s
M1.y -> RD1
M2.y -> RD2
`;

  const regFileBuiltin = `
@name "4x4 Register File (builtin)"
@compact never
part WE input-pin
part WA, RA1, RA2 input-pin width=2
part WD input-pin width=4
part CLK clock
part RD1, RD2 output-pin width=4
part RF register-file addressBits=2 dataWidth=4 readPorts=2 writePorts=1

WE -> RF.we1
WA -> RF.wa1
WD -> RF.wd1
RA1 -> RF.ra1
RA2 -> RF.ra2
CLK -> RF.clk
RF.rd1 -> RD1
RF.rd2 -> RD2
`;

  const regFileBuggy = regFileStructural.replace("R2.q -> M1.d2, M2.d2", "R2.q -> M1.d2\nR1.q -> M2.d2").replace("R1.q -> M1.d1, M2.d1", "R1.q -> M1.d1");

  it("writes/reads registers, keeps R0=0, supports stateTable, and equals builtin register-file", () => {
    const c = compileClean(regFileStructural);
    expectCheckClean(c);

    // Independent behavioural reference (R0 always 0, R1..R3 start unknown)
    const refRegs: (number | null)[] = [0, null, null, null];
    const sim = new Simulator(c);
    sim.set("WE", 0);
    sim.set("RA1", 0);
    sim.set("RA2", 1);
    sim.settle();
    expect(sim.read("RD1")).toBe(0);
    expect(sim.read("RD2")).toBeNull();

    const ops: { we: number; wa: number; wd: number; ra1: number; ra2: number }[] = [
      { we: 1, wa: 0, wd: 0xf, ra1: 0, ra2: 1 }, // write R0 ignored
      { we: 1, wa: 1, wd: 0xa, ra1: 0, ra2: 1 },
      { we: 1, wa: 2, wd: 0x5, ra1: 1, ra2: 2 },
      { we: 1, wa: 3, wd: 0xc, ra1: 2, ra2: 3 },
      { we: 0, wa: 1, wd: 0x0, ra1: 1, ra2: 3 }, // WE=0 holds
      { we: 1, wa: 2, wd: 0x9, ra1: 2, ra2: 0 },
    ];
    for (const op of ops) {
      sim.set("WE", op.we);
      sim.set("WA", op.wa);
      sim.set("WD", op.wd);
      sim.set("RA1", op.ra1);
      sim.set("RA2", op.ra2);
      sim.settle();
      // Combinational read before edge
      expect(sim.read("RD1")).toBe(refRegs[op.ra1]);
      expect(sim.read("RD2")).toBe(refRegs[op.ra2]);
      sim.tick();
      if (op.we && op.wa !== 0) refRegs[op.wa] = op.wd;
      expect(sim.read("RD1")).toBe(refRegs[op.ra1]);
      expect(sim.read("RD2")).toBe(refRegs[op.ra2]);
    }

    // stateTable on register-based file (cutting R1..R3 open; limit to small input set)
    const st = stateTable(c, { inputs: ["WE", "WA"], outputs: [], maxInputBits: 16 });
    expect(st.state.map((s) => s.name)).toEqual(["R1_q", "R2_q", "R3_q"]);

    // compareCircuits against builtin register-file
    const eq = compareCircuits(c, compileClean(regFileBuiltin), { cycles: 250 });
    expect(eq).toMatchObject({ equal: true, mode: "random", tried: 250 });

    const diff = compareCircuits(c, compileClean(regFileBuggy), { cycles: 150 });
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 17. CMOS NAND Gate from transistors
// =================================================================================================
describe("17. CMOS NAND gate from transistors", () => {
  const cmosNand = `
@name "CMOS NAND Gate"
@compact never
part A, B input-pin
part Y output-pin
part VDD vcc
part GND ground
part PA, PB pmos
part NA, NB nmos

A -> PA.g, NA.g
B -> PB.g, NB.g
VDD -> PA.s, PB.s
net YNET = PA.d, PB.d, NA.d, Y.in
net MID = NA.s, NB.d
net GNDNET = NB.s, GND.gnd
`;

  const nandGate = `
@name "NAND Gate (builtin)"
@compact never
part A, B input-pin
part Y output-pin
part G nand
A -> G.in0
B -> G.in1
G -> Y
`;

  // Buggy: pMOS in series, nMOS in parallel (actually computes NOR)
  const cmosNorBuggy = `
@name "CMOS NOR (buggy NAND)"
@compact never
part A, B input-pin
part Y output-pin
part VDD vcc
part GND ground
part PA, PB pmos
part NA, NB nmos

A -> PA.g, NA.g
B -> PB.g, NB.g
VDD -> PA.s
net PMID = PA.d, PB.s
net YNET = PB.d, NA.d, NB.d, Y.in
net GNDNET = NA.s, NB.s, GND.gnd
`;

  it("matches NAND truth table with zero contention, gives textbook SOP, and compares against nand gate", () => {
    const c = compileClean(cmosNand);
    expectCheckClean(c);

    const sim = new Simulator(c);
    for (let a = 0; a <= 1; a++) {
      for (let b = 0; b <= 1; b++) {
        sim.set("A", a);
        sim.set("B", b);
        const r = sim.settle();
        expect(r.stable).toBe(true);
        expect(r.issues).toEqual([]);
        expect(sim.read("Y")).toBe(a & b ? 0 : 1);
      }
    }

    const tt = truthTable(c);
    expect(sopMap(tt)).toEqual({ Y: "B' + A'" });

    expect(compareCircuits(c, compileClean(nandGate))).toMatchObject({ equal: true, mode: "exhaustive", tried: 4 });
    const diff = compareCircuits(c, compileClean(cmosNorBuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches[0]).toMatchObject({ output: "Y", a: 1, b: 0 });
  });
});

// =================================================================================================
// 18. CMOS Full Adder Mirror Circuit (28 transistors)
// =================================================================================================
describe("18. CMOS full adder mirror circuit from transistors", () => {
  const cmosMirrorFA = `
@name "28T CMOS Mirror Full Adder"
@compact never
part A, B, CIN input-pin
part S, COUT output-pin
part VDD vcc
part GND ground

# Stage 1: CN = ~(A B + CIN (A + B))
part PC1, PC2, PC3, PC4, PC5 pmos
part NC1, NC2, NC3, NC4, NC5 nmos
# Inverter for COUT = ~CN
part PIC pmos
part NIC nmos

# Stage 2: SN = ~(A B CIN + (A + B + CIN) CN)
part PS1, PS2, PS3, PS4, PS5, PS6, PS7 pmos
part NS1, NS2, NS3, NS4, NS5, NS6, NS7 nmos
# Inverter for S = ~SN
part PIS pmos
part NIS nmos

# Primary input fanout
A -> PC1.g, PC3.g, NC1.g, NC3.g, PS1.g, PS4.g, NS1.g, NS4.g
B -> PC2.g, PC4.g, NC2.g, NC4.g, PS2.g, PS5.g, NS2.g, NS5.g
CIN -> PC5.g, NC5.g, PS3.g, PS6.g, NS3.g, NS6.g

# Rails
net RAIL_VDD = VDD.vcc, PC1.s, PC3.s, PC4.s, PIC.s, PS1.s, PS4.s, PS5.s, PS6.s, PIS.s
net RAIL_GND = GND.gnd, NC2.s, NC3.s, NC4.s, NIC.s, NS3.s, NS4.s, NS5.s, NS6.s, NIS.s

# Carry' mirror network
net P_AB = PC1.d, PC2.s
net P_ORB = PC3.d, PC4.d, PC5.s
net N_AB = NC1.s, NC2.d
net N_ORB = NC5.s, NC3.d, NC4.d
net CN = PC2.d, PC5.d, NC1.d, NC5.d, PIC.g, NIC.g, PS7.g, NS7.g
net COUT_NET = PIC.d, NIC.d, COUT.in

# Sum' mirror network
net P_S1 = PS1.d, PS2.s
net P_S2 = PS2.d, PS3.s
net P_S3 = PS4.d, PS5.d, PS6.d, PS7.s
net N_S1 = NS1.s, NS2.d
net N_S2 = NS2.s, NS3.d
net N_S3 = NS7.s, NS4.d, NS5.d, NS6.d
net SN = PS3.d, PS7.d, NS1.d, NS7.d, PIS.g, NIS.g
net S_NET = PIS.d, NIS.d, S.in
`;

  const faBuiltin = `
@name "Full Adder (builtin)"
@compact never
part A, B, CIN input-pin
part S, COUT output-pin
part FA full-adder
A -> FA.a
B -> FA.b
CIN -> FA.cin
FA.s -> S
FA.cout -> COUT
`;

  // Buggy: NS7 gate connected to COUT instead of CN
  const cmosMirrorFABuggy = cmosMirrorFA
    .replace("net CN = PC2.d, PC5.d, NC1.d, NC5.d, PIC.g, NIC.g, PS7.g, NS7.g", "net CN = PC2.d, PC5.d, NC1.d, NC5.d, PIC.g, NIC.g, PS7.g")
    .replace("net COUT_NET = PIC.d, NIC.d, COUT.in", "net COUT_NET = PIC.d, NIC.d, COUT.in, NS7.g");

  it("matches full-adder truth table with zero contention/floating, recovers textbook SOP, and equals builtin full-adder", { timeout: 60000 }, () => {
    const c = compileClean(cmosMirrorFA);
    expectCheckClean(c);

    const sim = new Simulator(c);
    for (let a = 0; a <= 1; a++) {
      for (let b = 0; b <= 1; b++) {
        for (let cin = 0; cin <= 1; cin++) {
          sim.set("A", a);
          sim.set("B", b);
          sim.set("CIN", cin);
          const r = sim.settle();
          expect(r.stable).toBe(true);
          expect(r.issues).toEqual([]);
          expect(sim.read("S")).toBe(a ^ b ^ cin);
          expect(sim.read("COUT")).toBe((a & b) | (a & cin) | (b & cin));
        }
      }
    }

    const tt = truthTable(c);
    expect(sopMap(tt)).toEqual({
      S: "A'B'CIN + A'BCIN' + AB'CIN' + ABCIN",
      COUT: "BCIN + ACIN + AB",
    });

    expect(compareCircuits(c, compileClean(faBuiltin))).toMatchObject({ equal: true, mode: "exhaustive", tried: 8 });
    const diff = compareCircuits(c, compileClean(cmosMirrorFABuggy));
    expect(diff.equal).toBe(false);
    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});

// =================================================================================================
// 19. Default compaction smoke check on a DSpec circuit
// =================================================================================================
describe("DSpec default compaction mode end-to-end", () => {
  it("compiles with default @compact end and produces an equivalent circuit", () => {
    const src = `
@name "2-to-4 Decoder compacted"
part EN, A1, A0 input-pin
part Y0, Y1, Y2, Y3 output-pin
part NA1, NA0 not
part G0, G1, G2, G3 and inputs=3
A1 -> NA1, G2.in1, G3.in1
NA1 -> G0.in1, G1.in1
A0 -> NA0, G1.in2, G3.in2
NA0 -> G0.in2, G2.in2
EN -> G0.in0, G1.in0, G2.in0, G3.in0
G0 -> Y0
G1 -> Y1
G2 -> Y2
G3 -> Y3
`;
    const c = compileClean(src);
    expectCheckClean(c);
    expect(sopMap(truthTable(c))).toEqual({
      Y0: "ENA1'A0'",
      Y1: "ENA1'A0",
      Y2: "ENA1A0'",
      Y3: "ENA1A0",
    });
  });
});

// =================================================================================================
// 20. Student mistakes detected by checkCircuit
// =================================================================================================
describe("student mistakes checked by checkCircuit", () => {
  it("detects an unconnected gate input (floating-input)", () => {
    const c = compileClean(`
@compact never
part A input-pin
part G and
part Y output-pin
A -> G.in0
G -> Y
`);
    const issues = checkCircuit(c);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "floating-input", severity: "error", pins: ["G.in1"] }),
    );
  });

  it("detects two outputs wired together (multiple-drivers)", () => {
    const c = compileClean(`
@compact never
part A, B input-pin
part G1, G2 not
part Y output-pin
A -> G1
B -> G2
net SHORT = G1.out, G2.out, Y.in
`);
    const issues = checkCircuit(c);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "multiple-drivers", severity: "error" }),
    );
    const md = issues.find((i) => i.kind === "multiple-drivers")!;
    expect(md.pins.sort()).toEqual(["G1.out", "G2.out"]);
  });

  it("detects a latch feedback loop (feedback)", () => {
    const c = compileClean(`
@compact never
part S, R input-pin
part G1, G2 nor
part Q output-pin
R -> G1.in0
S -> G2.in0
G2 -> G1.in1
G1 -> G2.in1, Q
`);
    const issues = checkCircuit(c);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "feedback", severity: "info" }),
    );
    const fb = issues.find((i) => i.kind === "feedback")!;
    expect(fb.pins.sort()).toEqual(["G1", "G2"]);
  });

  it("detects a floating reset pin when reset is enabled on a counter", () => {
    const c = compileClean(`
@compact never
part CLK clock
part EN input-pin
part CNT counter bits=4 enable=true reset=true carryOut=false
part Q output-pin width=4
CLK -> CNT.clk
EN -> CNT.en
CNT.q -> Q
`);
    const issues = checkCircuit(c);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "floating-input", severity: "error", pins: ["CNT.rst"] }),
    );
  });

  it("detects a wrong bus width (width-mismatch)", () => {
    const c = compileClean(`
@compact never
part A input-pin width=4
part Y output-pin width=2
A -> Y
`);
    const issues = checkCircuit(c);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: "width-mismatch", severity: "error" }),
    );
  });
});

// =================================================================================================
// 21. Probing suspected simulator / analyzer / checker bugs
// =================================================================================================
describe("probing suspected bugs", () => {
  it("BUG-APPS-1 probe: stateTable on register with pinMode=bits", () => {
    const c = extractCircuit(
      mkDoc(
        [
          ["D0", "input-pin"], ["D1", "input-pin"],
          ["EN", "input-pin"], ["RST", "input-pin"], ["CLK", "clock"],
          ["R", "register", { width: 2, pinMode: "bits", enable: true, reset: true }],
          ["Q0", "output-pin"], ["Q1", "output-pin"],
        ],
        [
          ["D0.out", "R.d0"], ["D1.out", "R.d1"],
          ["EN.out", "R.en"], ["RST.out", "R.rst"], ["CLK.clk", "R.clk"],
          ["R.q0", "Q0.in"], ["R.q1", "Q1.in"],
        ],
      ),
    );
    const st = stateTable(c);
    // Expected: R's bit state pins cut open so Q0/Q1 are known (not X) and R's d0/d1 are in outBits
    expect(st.state.length).toBeGreaterThan(0);
    expect(st.outBits).toContain("R_d0");
    expect(outputFunctions(st).every((f) => f.unknown.length === 0)).toBe(true);
  });

  it("BUG-APPS-2 probe: truthTable rejects gate-level SR latch (combinational feedback loop)", () => {
    const c = compileClean(`
@compact never
part S_N, R_N input-pin
part Q, QN output-pin
part G1, G2 nand
S_N -> G1.in0
G2 -> G1.in1, QN
R_N -> G2.in0
G1 -> G2.in1, Q
`);
    expect(() => truthTable(c)).toThrow();
  });

  it("BUG-APPS-3 probe: checkCircuit warns about a stateful counter/FSM with no reset at all", () => {
    // Student builds a 2-bit counter from T-FFs without asyncReset (stays X forever!)
    const c = compileClean(`
@compact never
part EN input-pin
part CLK clock
part F0, F1 t-ff
part A and
part Q0, Q1 output-pin
CLK -> F0.clk, F1.clk
EN -> F0.t, A.in0
F0.q -> A.in1, Q0
A -> F1.t
F1.q -> Q1
`);
    const sim = new Simulator(c);
    sim.set("EN", 1);
    sim.settle();
    sim.tick();
    sim.tick();
    expect(sim.read("Q0")).toBeNull(); // stuck at X forever!
    const issues = checkCircuit(c);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("BUG-APPS-4 probe: checkCircuit width-mismatch populates pins array", () => {
    const c = compileClean(`
@compact never
part A input-pin width=4
part Y output-pin width=2
A -> Y
`);
    const wm = checkCircuit(c).find((i) => i.kind === "width-mismatch")!;
    expect(wm).toBeDefined();
    expect(wm.pins.sort()).toEqual(["A.out", "Y.in"]);
  });
});

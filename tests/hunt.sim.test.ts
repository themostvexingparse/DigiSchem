import { describe, expect, it } from "vitest";
import { ALL_DEFS, registerBuiltinComponents } from "../src/components/library";
import type { PropValue, SchematicDocument } from "../src/model/types";
import { DocumentStore } from "../src/model/store";
import { circuitText, extractCircuit, structuralKey } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { B0, B1, BX, BZ, Simulator } from "../src/logic/simulate";
import { outputFunctions, stateInCone, truthTable, truthTableText } from "../src/logic/analyze";
import { watchCircuit } from "../src/logic/watch";
import { compileSpec } from "../src/spec/compile";

registerBuiltinComponents();

type PartSpec = [id: string, type: string, props?: Record<string, PropValue>];

function mk(parts: PartSpec[], nets: string[][]): SchematicDocument {
  const links: [string, string][] = [];
  for (const net of nets) {
    const ts = net.map((r) => {
      const i = r.lastIndexOf(".");
      return `p:${r.slice(0, i)}|${r.slice(i + 1)}`;
    });
    for (let i = 1; i < ts.length; i++) links.push([ts[0], ts[i]]);
  }
  return {
    format: "digischem",
    version: 1,
    name: "hunt",
    grid: 10,
    components: parts.map(([id, type, props], i) => ({
      id,
      type,
      x: (i % 6) * 200,
      y: Math.floor(i / 6) * 200,
      rotation: 0,
      props: props ?? {},
      label: "",
    })),
    wires: [],
    texts: [],
    links,
  };
}

const sim = (doc: SchematicDocument, initial: "x" | "zero" = "x") =>
  new Simulator(extractCircuit(doc), { initial });

const kinds = (issues: { kind: string }[]) => issues.map((i) => i.kind);

function tick(s: Simulator, clk = "CLK", highFirst = true): void {
  s.set(clk, highFirst ? 1 : 0);
  s.settle();
  s.set(clk, highFirst ? 0 : 1);
  s.settle();
}

describe("library inventory sanity", () => {
  it("registers all 80 built-in component definitions", () => {
    expect(ALL_DEFS.length).toBe(80);
  });
});

describe("sources & stimuli", () => {
  it("simulates constant (dec, hex, bin, oct, negative, invalid), vcc, ground, pull-up, pull-down", () => {
    const doc = mk(
      [
        ["K1", "constant", { value: "0xA5", width: 8 }],
        ["K2", "constant", { value: "0b1011", width: 4 }],
        ["K3", "constant", { value: "-1", width: 4 }],
        ["K4", "constant", { value: "0o17", width: 4 }],
        ["KBAD", "constant", { value: "notanumber", width: 4 }],
        ["V", "vcc"],
        ["G", "ground"],
        ["PU", "pull-up"],
        ["PD", "pull-down"],
        ["Y1", "output-pin", { width: 8 }],
        ["Y2", "output-pin", { width: 4 }],
        ["Y3", "output-pin", { width: 4 }],
        ["Y4", "output-pin", { width: 4 }],
        ["YBAD", "output-pin", { width: 4 }],
        ["YV", "output-pin"],
        ["YG", "output-pin"],
        ["YPU", "output-pin"],
        ["YPD", "output-pin"],
      ],
      [
        ["K1.out", "Y1.in"],
        ["K2.out", "Y2.in"],
        ["K3.out", "Y3.in"],
        ["K4.out", "Y4.in"],
        ["KBAD.out", "YBAD.in"],
        ["V.vcc", "YV.in"],
        ["G.gnd", "YG.in"],
        ["PU.out", "YPU.in"],
        ["PD.out", "YPD.in"],
      ],
    );
    const s = sim(doc);
    s.settle();
    expect(s.read("Y1")).toBe(0xa5);
    expect(s.read("Y2")).toBe(0b1011);
    expect(s.read("Y3")).toBe(0b1111);
    expect(s.read("Y4")).toBe(0o17);
    expect(s.read("YBAD")).toBeNull();
    expect(s.read("YV")).toBe(1);
    expect(s.read("YG")).toBe(0);
    expect(s.read("YPU")).toBe(1);
    expect(s.read("YPD")).toBe(0);
  });

  it("simulates dip-switch and keypad (bus & bits mode)", () => {
    const doc = mk(
      [
        ["SW", "dip-switch", { count: 4 }],
        ["KP", "keypad", { pinMode: "bus" }],
        ["KPB", "keypad", { pinMode: "bits" }],
        ["S0", "output-pin"],
        ["S3", "output-pin"],
        ["KK", "output-pin", { width: 4 }],
        ["KV", "output-pin"],
        ["KB2", "output-pin"],
        ["KBV", "output-pin"],
      ],
      [
        ["SW.out0", "S0.in"],
        ["SW.out3", "S3.in"],
        ["KP.k", "KK.in"],
        ["KP.valid", "KV.in"],
        ["KPB.k2", "KB2.in"],
        ["KPB.valid", "KBV.in"],
      ],
    );
    const s = sim(doc);
    s.set("SW", 0b1001);
    s.set("KP", 0xc);
    s.set("KPB", 0b0100);
    s.settle();
    expect(s.read("S0")).toBe(1);
    expect(s.read("S3")).toBe(1);
    expect(s.read("KK")).toBe(0xc);
    expect(s.read("KV")).toBe(1);
    expect(s.read("KB2")).toBe(1);
    expect(s.read("KBV")).toBe(1);
    s.set("KP", -1);
    s.settle();
    expect(s.read("KK")).toBe(0);
    expect(s.read("KV")).toBe(0);
  });

  it("simulates push-button (activeHigh default)", () => {
    const doc = mk([["B", "push-button"], ["Y", "output-pin"]], [["B.out", "Y.in"]]);
    const s = sim(doc);
    s.settle();
    expect(s.read("Y")).toBe(0);
    s.set("B", true);
    s.settle();
    expect(s.read("Y")).toBe(1);
  });
});

describe("gates, aoi, parity", () => {
  it("evaluates all 10 basic gates + X dominance", () => {
    const doc = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["G_AND", "and"],
        ["G_NAND", "nand"],
        ["G_OR", "or"],
        ["G_NOR", "nor"],
        ["G_XOR", "xor"],
        ["G_XNOR", "xnor"],
        ["G_BUF", "buf"],
        ["G_NOT", "not"],
        ["G_SB", "schmitt-buffer"],
        ["G_SI", "schmitt-inverter"],
        ["Y_AND", "output-pin"],
        ["Y_NAND", "output-pin"],
        ["Y_OR", "output-pin"],
        ["Y_NOR", "output-pin"],
        ["Y_XOR", "output-pin"],
        ["Y_XNOR", "output-pin"],
        ["Y_BUF", "output-pin"],
        ["Y_NOT", "output-pin"],
        ["Y_SB", "output-pin"],
        ["Y_SI", "output-pin"],
      ],
      [
        ["A.out", "G_AND.in0", "G_NAND.in0", "G_OR.in0", "G_NOR.in0", "G_XOR.in0", "G_XNOR.in0", "G_BUF.in0", "G_NOT.in0", "G_SB.in0", "G_SI.in0"],
        ["B.out", "G_AND.in1", "G_NAND.in1", "G_OR.in1", "G_NOR.in1", "G_XOR.in1", "G_XNOR.in1"],
        ["G_AND.out", "Y_AND.in"],
        ["G_NAND.out", "Y_NAND.in"],
        ["G_OR.out", "Y_OR.in"],
        ["G_NOR.out", "Y_NOR.in"],
        ["G_XOR.out", "Y_XOR.in"],
        ["G_XNOR.out", "Y_XNOR.in"],
        ["G_BUF.out", "Y_BUF.in"],
        ["G_NOT.out", "Y_NOT.in"],
        ["G_SB.out", "Y_SB.in"],
        ["G_SI.out", "Y_SI.in"],
      ],
    );
    const s = sim(doc);
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      s.set("A", a);
      s.set("B", b);
      s.settle();
      expect(s.read("Y_AND")).toBe(a & b);
      expect(s.read("Y_NAND")).toBe((a & b) ^ 1);
      expect(s.read("Y_OR")).toBe(a | b);
      expect(s.read("Y_NOR")).toBe((a | b) ^ 1);
      expect(s.read("Y_XOR")).toBe(a ^ b);
      expect(s.read("Y_XNOR")).toBe((a ^ b) ^ 1);
      expect(s.read("Y_BUF")).toBe(a);
      expect(s.read("Y_NOT")).toBe(a ^ 1);
      expect(s.read("Y_SB")).toBe(a);
      expect(s.read("Y_SI")).toBe(a ^ 1);
    }
    s.set("A", 0);
    s.set("B", [BX]);
    s.settle();
    expect(s.read("Y_AND")).toBe(0);
    expect(s.read("Y_NAND")).toBe(1);
    expect(s.read("Y_OR")).toBeNull();
    expect(s.read("Y_XOR")).toBeNull();
    s.set("A", 1);
    s.settle();
    expect(s.read("Y_OR")).toBe(1);
    expect(s.read("Y_NOR")).toBe(0);
    expect(s.read("Y_AND")).toBeNull();
  });

  it("evaluates all 4 AOI/OAI kinds and parity", () => {
    const doc = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["C", "input-pin"],
        ["D", "input-pin"],
        ["U1", "aoi", { kind: "aoi21" }],
        ["U2", "aoi", { kind: "aoi22" }],
        ["U3", "aoi", { kind: "oai21" }],
        ["U4", "aoi", { kind: "oai22" }],
        ["P", "parity", { inputs: 4 }],
        ["Y1", "output-pin"],
        ["Y2", "output-pin"],
        ["Y3", "output-pin"],
        ["Y4", "output-pin"],
        ["YO", "output-pin"],
        ["YE", "output-pin"],
      ],
      [
        ["A.out", "U1.a", "U2.a", "U3.a", "U4.a", "P.in0"],
        ["B.out", "U1.b", "U2.b", "U3.b", "U4.b", "P.in1"],
        ["C.out", "U1.c", "U2.c", "U3.c", "U4.c", "P.in2"],
        ["D.out", "U2.d", "U4.d", "P.in3"],
        ["U1.y", "Y1.in"],
        ["U2.y", "Y2.in"],
        ["U3.y", "Y3.in"],
        ["U4.y", "Y4.in"],
        ["P.odd", "YO.in"],
        ["P.even", "YE.in"],
      ],
    );
    const s = sim(doc);
    for (let m = 0; m < 16; m++) {
      const a = m & 1, b = (m >> 1) & 1, c = (m >> 2) & 1, d = (m >> 3) & 1;
      s.set("A", a);
      s.set("B", b);
      s.set("C", c);
      s.set("D", d);
      s.settle();
      expect(s.read("Y1")).toBe(((a & b) | c) ^ 1);
      expect(s.read("Y2")).toBe(((a & b) | (c & d)) ^ 1);
      expect(s.read("Y3")).toBe(((a | b) & c) ^ 1);
      expect(s.read("Y4")).toBe(((a | b) & (c | d)) ^ 1);
      expect(s.read("YO")).toBe(a ^ b ^ c ^ d);
      expect(s.read("YE")).toBe((a ^ b ^ c ^ d) ^ 1);
    }
  });
});

describe("plexers", () => {
  it("evaluates mux & demux with bus selectMode, multi-bit data, enable, and X-merge", () => {
    const doc = mk(
      [
        ["D0", "input-pin", { width: 4 }],
        ["D1", "input-pin", { width: 4 }],
        ["D2", "input-pin", { width: 4 }],
        ["D3", "input-pin", { width: 4 }],
        ["S", "input-pin", { width: 2 }],
        ["EN", "input-pin"],
        ["M", "mux", { selectBits: 2, dataWidth: 4, enable: true, selectMode: "bus" }],
        ["DM", "demux", { selectBits: 2, dataWidth: 4, enable: true, selectMode: "bus" }],
        ["YM", "output-pin", { width: 4 }],
        ["Y0", "output-pin", { width: 4 }],
        ["Y1", "output-pin", { width: 4 }],
        ["Y2", "output-pin", { width: 4 }],
        ["Y3", "output-pin", { width: 4 }],
      ],
      [
        ["D0.out", "M.d0"],
        ["D1.out", "M.d1"],
        ["D2.out", "M.d2"],
        ["D3.out", "M.d3"],
        ["S.out", "M.s", "DM.s"],
        ["EN.out", "M.en", "DM.en"],
        ["M.y", "YM.in", "DM.d"],
        ["DM.y0", "Y0.in"],
        ["DM.y1", "Y1.in"],
        ["DM.y2", "Y2.in"],
        ["DM.y3", "Y3.in"],
      ],
    );
    const s = sim(doc);
    s.set("D0", 0b0101);
    s.set("D1", 0b0111);
    s.set("D2", 0b1010);
    s.set("D3", 0b1111);
    s.set("EN", 1);
    s.set("S", 2);
    s.settle();
    expect(s.read("YM")).toBe(0b1010);
    expect([s.read("Y0"), s.read("Y1"), s.read("Y2"), s.read("Y3")]).toEqual([0, 0, 0b1010, 0]);
    // Partial X on select: S = [X, 0] -> candidates 0 (0101) and 1 (0111) agree on bits 0,2,3
    s.set("S", [BX, B0]);
    s.settle();
    expect(s.pinBits("YM", "in")).toEqual([B1, BX, B1, B0]);
    expect(s.read("Y2")).toBe(0);
    expect(s.read("Y3")).toBe(0);
    // Disabled
    s.set("EN", 0);
    s.settle();
    expect(s.read("YM")).toBe(0);
    expect([s.read("Y0"), s.read("Y1"), s.read("Y2"), s.read("Y3")]).toEqual([0, 0, 0, 0]);
  });

  it("evaluates decoder (active-high and active-low) and encoder (priority & non-priority)", () => {
    const doc = mk(
      [
        ["A0", "input-pin"],
        ["A1", "input-pin"],
        ["EN", "input-pin"],
        ["DEC", "decoder", { inputs: 2, enable: true, activeLowOutputs: true }],
        ["ENC", "encoder", { outputBits: 2, priority: true, enable: true }],
        ["Y0", "output-pin"],
        ["Y1", "output-pin"],
        ["Y2", "output-pin"],
        ["Y3", "output-pin"],
        ["D0", "input-pin"],
        ["D1", "input-pin"],
        ["D2", "input-pin"],
        ["D3", "input-pin"],
        ["EY0", "output-pin"],
        ["EY1", "output-pin"],
        ["EV", "output-pin"],
      ],
      [
        ["A0.out", "DEC.a0"],
        ["A1.out", "DEC.a1"],
        ["EN.out", "DEC.en", "ENC.en"],
        ["DEC.y0", "Y0.in"],
        ["DEC.y1", "Y1.in"],
        ["DEC.y2", "Y2.in"],
        ["DEC.y3", "Y3.in"],
        ["D0.out", "ENC.d0"],
        ["D1.out", "ENC.d1"],
        ["D2.out", "ENC.d2"],
        ["D3.out", "ENC.d3"],
        ["ENC.y0", "EY0.in"],
        ["ENC.y1", "EY1.in"],
        ["ENC.v", "EV.in"],
      ],
    );
    const s = sim(doc);
    s.set("EN", 0);
    s.settle();
    expect([s.read("Y0"), s.read("Y1"), s.read("Y2"), s.read("Y3")]).toEqual([1, 1, 1, 1]);
    expect([s.read("EY0"), s.read("EY1"), s.read("EV")]).toEqual([0, 0, 0]);
    s.set("EN", 1);
    s.set("A0", 0);
    s.set("A1", 1);
    s.set("D1", 1);
    s.set("D2", 1);
    s.settle();
    expect([s.read("Y0"), s.read("Y1"), s.read("Y2"), s.read("Y3")]).toEqual([1, 1, 0, 1]);
    expect([s.read("EY0"), s.read("EY1"), s.read("EV")]).toEqual([0, 1, 1]); // 2 (priority)
  });

  it("evaluates tristate (activeLowEnable + invertedOut), bus-transceiver, bit-selector, gray-converter, bcd-7seg", () => {
    const doc = mk(
      [
        ["A", "input-pin", { width: 4 }],
        ["EN", "input-pin"],
        ["T", "tristate", { width: 4, activeLowEnable: true, invertedOut: true }],
        ["YT", "output-pin", { width: 4 }],
        ["S", "input-pin", { width: 2 }],
        ["BS", "bit-selector", { width: 4 }],
        ["YBS", "output-pin"],
        ["G1", "gray-converter", { width: 4, pinMode: "bus", direction: "toGray" }],
        ["G2", "gray-converter", { width: 4, pinMode: "bus", direction: "toBinary" }],
        ["YG", "output-pin", { width: 4 }],
        ["YB", "output-pin", { width: 4 }],
        ["BCD", "bcd-7seg", { pinMode: "bus", activeLow: false, controls: true }],
        ["LT", "input-pin"],
        ["BI", "input-pin"],
        ["SA", "output-pin"],
        ["SG", "output-pin"],
      ],
      [
        ["A.out", "T.in", "BS.d", "G1.in", "BCD.bcd"],
        ["EN.out", "T.en"],
        ["T.out", "YT.in"],
        ["S.out", "BS.s"],
        ["BS.y", "YBS.in"],
        ["G1.out", "YG.in", "G2.in"],
        ["G2.out", "YB.in"],
        ["LT.out", "BCD.lt"],
        ["BI.out", "BCD.bi"],
        ["BCD.a", "SA.in"],
        ["BCD.g", "SG.in"],
      ],
    );
    const s = sim(doc);
    s.set("A", 0b0101); // 5
    s.set("EN", 0); // active-low enabled
    s.set("S", 2);
    s.set("LT", 1); // inactive
    s.set("BI", 1); // inactive
    s.settle();
    expect(s.read("YT")).toBe(0b1010); // inverted
    expect(s.read("YBS")).toBe(1);
    expect(s.read("YG")).toBe(0b0101 ^ (0b0101 >> 1));
    expect(s.read("YB")).toBe(0b0101);
    expect(s.read("SA")).toBe(1); // digit 5 lights a and g
    expect(s.read("SG")).toBe(1);
    // Blank via BI' = 0 overrides LT' = 0
    s.set("LT", 0);
    s.set("BI", 0);
    s.settle();
    expect(s.read("SA")).toBe(0);
    expect(s.read("SG")).toBe(0);
    // Digit > 9 blanks
    s.set("A", 12);
    s.set("LT", 1);
    s.set("BI", 1);
    s.settle();
    expect(s.read("SA")).toBe(0);
    expect(s.read("SG")).toBe(0);
  });

  it("evaluates bus-transceiver in both directions and Hi-Z", () => {
    const doc = mk(
      [
        ["VA", "input-pin", { width: 4 }],
        ["EA", "input-pin"],
        ["TA", "tristate", { width: 4 }],
        ["VB", "input-pin", { width: 4 }],
        ["EB", "input-pin"],
        ["TB", "tristate", { width: 4 }],
        ["DIR", "input-pin"],
        ["OE", "input-pin"],
        ["X", "bus-transceiver", { width: 4 }],
        ["OA", "output-pin", { width: 4 }],
        ["OB", "output-pin", { width: 4 }],
      ],
      [
        ["VA.out", "TA.in"],
        ["EA.out", "TA.en"],
        ["VB.out", "TB.in"],
        ["EB.out", "TB.en"],
        ["TA.out", "X.a", "OA.in"],
        ["TB.out", "X.b", "OB.in"],
        ["DIR.out", "X.dir"],
        ["OE.out", "X.oe"],
      ],
    );
    const s = sim(doc);
    s.set("VA", 9);
    s.set("EA", 1);
    s.set("EB", 0);
    s.set("DIR", 1);
    s.set("OE", 0); // active-low OE'
    s.settle();
    expect(s.read("OB")).toBe(9);
    // Reverse direction B -> A
    s.set("EA", 0);
    s.set("VB", 6);
    s.set("EB", 1);
    s.set("DIR", 0);
    s.settle();
    expect(s.read("OA")).toBe(6);
    // Disable OE' = 1
    s.set("OE", 1);
    s.settle();
    expect(s.pinBits("OA", "in")).toEqual([BZ, BZ, BZ, BZ]);
  });
});

describe("arithmetic", () => {
  it("evaluates half-adder and full-adder", () => {
    const doc = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["CI", "input-pin"],
        ["HA", "half-adder"],
        ["FA", "full-adder"],
        ["HS", "output-pin"],
        ["HC", "output-pin"],
        ["FS", "output-pin"],
        ["FC", "output-pin"],
      ],
      [
        ["A.out", "HA.a", "FA.a"],
        ["B.out", "HA.b", "FA.b"],
        ["CI.out", "FA.cin"],
        ["HA.s", "HS.in"],
        ["HA.cout", "HC.in"],
        ["FA.s", "FS.in"],
        ["FA.cout", "FC.in"],
      ],
    );
    const s = sim(doc);
    for (let m = 0; m < 8; m++) {
      const a = m & 1, b = (m >> 1) & 1, ci = (m >> 2) & 1;
      s.set("A", a);
      s.set("B", b);
      s.set("CI", ci);
      s.settle();
      expect(s.read("HS")).toBe(a ^ b);
      expect(s.read("HC")).toBe(a & b);
      expect(s.read("FS")).toBe(a ^ b ^ ci);
      expect(s.read("FC")).toBe((a & b) | (a & ci) | (b & ci));
    }
    // Full-adder carry is 1 when a=1, b=1 even if cin=X
    s.set("A", 1);
    s.set("B", 1);
    s.set("CI", [BX]);
    s.settle();
    expect(s.read("FS")).toBeNull();
    expect(s.read("FC")).toBe(1);
  });

  it("evaluates adder, subtractor, comparator, inc, dec, neg, mul, div, ext, popcount", () => {
    const doc = mk(
      [
        ["A", "input-pin", { width: 4 }],
        ["B", "input-pin", { width: 4 }],
        ["CI", "input-pin"],
        ["ADD", "adder", { width: 4, carryIn: true, carryOut: true }],
        ["SUB", "subtractor", { width: 4, borrowIn: true, borrowOut: true }],
        ["CMP", "comparator", { width: 4, signed: true }],
        ["INC", "incrementer", { width: 4 }],
        ["DEC", "decrementer", { width: 4 }],
        ["NEG", "negator", { width: 4 }],
        ["MUL", "multiplier", { width: 4, signed: true, fullProduct: true }],
        ["DIV", "divider", { width: 4 }],
        ["EXT", "bit-extender", { inWidth: 4, outWidth: 8, mode: "sign" }],
        ["POP", "bit-counter", { width: 4, pinMode: "bus" }],
        ["YS", "output-pin", { width: 4 }],
        ["YCO", "output-pin"],
        ["YD", "output-pin", { width: 4 }],
        ["YBO", "output-pin"],
        ["YGT", "output-pin"],
        ["YEQ", "output-pin"],
        ["YLT", "output-pin"],
        ["YINC", "output-pin", { width: 4 }],
        ["YINCC", "output-pin"],
        ["YDEC", "output-pin", { width: 4 }],
        ["YDECB", "output-pin"],
        ["YNEG", "output-pin", { width: 4 }],
        ["YMUL", "output-pin", { width: 8 }],
        ["YQ", "output-pin", { width: 4 }],
        ["YR", "output-pin", { width: 4 }],
        ["YEXT", "output-pin", { width: 8 }],
        ["YPOP", "output-pin", { width: 3 }],
      ],
      [
        ["A.out", "ADD.a", "SUB.a", "CMP.a", "INC.a", "DEC.a", "NEG.a", "MUL.a", "DIV.a", "EXT.in", "POP.a"],
        ["B.out", "ADD.b", "SUB.b", "CMP.b", "MUL.b", "DIV.b"],
        ["CI.out", "ADD.cin", "SUB.bin"],
        ["ADD.s", "YS.in"],
        ["ADD.cout", "YCO.in"],
        ["SUB.d", "YD.in"],
        ["SUB.bout", "YBO.in"],
        ["CMP.gt", "YGT.in"],
        ["CMP.eq", "YEQ.in"],
        ["CMP.lt", "YLT.in"],
        ["INC.y", "YINC.in"],
        ["INC.cout", "YINCC.in"],
        ["DEC.y", "YDEC.in"],
        ["DEC.bout", "YDECB.in"],
        ["NEG.y", "YNEG.in"],
        ["MUL.p", "YMUL.in"],
        ["DIV.q", "YQ.in"],
        ["DIV.r", "YR.in"],
        ["EXT.out", "YEXT.in"],
        ["POP.count", "YPOP.in"],
      ],
    );
    const s = sim(doc);
    s.set("A", 0b1110); // 14 unsigned, -2 signed
    s.set("B", 0b0011); // 3 unsigned, +3 signed
    s.set("CI", 1);
    s.settle();
    expect(s.read("YS")).toBe(2); // 14 + 3 + 1 = 18 -> 2, carry 1
    expect(s.read("YCO")).toBe(1);
    expect(s.read("YD")).toBe(10); // 14 - 3 - 1 = 10, borrow 0
    expect(s.read("YBO")).toBe(0);
    expect([s.read("YGT"), s.read("YEQ"), s.read("YLT")]).toEqual([0, 0, 1]); // -2 < +3
    expect(s.read("YINC")).toBe(15);
    expect(s.read("YINCC")).toBe(0);
    expect(s.read("YDEC")).toBe(13);
    expect(s.read("YDECB")).toBe(0);
    expect(s.read("YNEG")).toBe(2); // -(-2) = 2
    expect(s.read("YMUL")).toBe(0b11111010); // -6 in 8-bit two's complement
    expect(s.read("YQ")).toBe(4); // 14 / 3 = 4
    expect(s.read("YR")).toBe(2); // 14 % 3 = 2
    expect(s.read("YEXT")).toBe(0b11111110); // sign-extended -2
    expect(s.read("YPOP")).toBe(3); // popcount(1110) = 3

    // Division by zero -> X; decrement 0 -> borrow 1; increment 15 -> carry 1
    s.set("A", 0);
    s.set("B", 0);
    s.settle();
    expect(s.read("YQ")).toBeNull();
    expect(s.read("YR")).toBeNull();
    expect(s.read("YDEC")).toBe(15);
    expect(s.read("YDECB")).toBe(1);
    s.set("A", 15);
    s.settle();
    expect(s.read("YINC")).toBe(0);
    expect(s.read("YINCC")).toBe(1);
  });
});

describe("latches, flip-flops, registers, counters", () => {
  it("evaluates sr-latch (active-high and active-low), gated-sr-latch, and d-latch", () => {
    const doc = mk(
      [
        ["S", "input-pin"],
        ["R", "input-pin"],
        ["EN", "input-pin"],
        ["D", "input-pin", { width: 4 }],
        ["L1", "sr-latch", { activeLow: false }],
        ["L2", "sr-latch", { activeLow: true }],
        ["L3", "gated-sr-latch", { activeLowEnable: true }],
        ["DL", "d-latch", { width: 4 }],
        ["Q1", "output-pin"],
        ["Q1N", "output-pin"],
        ["Q2", "output-pin"],
        ["Q2N", "output-pin"],
        ["Q3", "output-pin"],
        ["QD", "output-pin", { width: 4 }],
      ],
      [
        ["S.out", "L1.s", "L2.s", "L3.s"],
        ["R.out", "L1.r", "L2.r", "L3.r"],
        ["EN.out", "L3.en", "DL.en"],
        ["D.out", "DL.d"],
        ["L1.q", "Q1.in"],
        ["L1.qn", "Q1N.in"],
        ["L2.q", "Q2.in"],
        ["L2.qn", "Q2N.in"],
        ["L3.q", "Q3.in"],
        ["DL.q", "QD.in"],
      ],
    );
    const s = sim(doc);
    s.set("S", 1);
    s.set("R", 0);
    s.set("EN", 1);
    s.set("D", 0b1010);
    s.settle();
    expect([s.read("Q1"), s.read("Q1N")]).toEqual([1, 0]);
    expect([s.read("Q2"), s.read("Q2N")]).toEqual([0, 1]); // activeLow: S'=1, R'=0 -> reset
    expect(s.read("QD")).toBe(0b1010);
    // Forbidden state on L1 (S=R=1 -> both 0); hold on L2 (S'=R'=1)
    s.set("R", 1);
    s.set("EN", 0);
    s.set("D", 0b0101);
    s.settle();
    expect([s.read("Q1"), s.read("Q1N")]).toEqual([0, 0]);
    expect([s.read("Q2"), s.read("Q2N")]).toEqual([0, 1]);
    expect(s.read("QD")).toBe(0b1010); // latched!
    // Forbidden state on L2 (S'=R'=0 -> both 1)
    s.set("S", 0);
    s.set("R", 0);
    s.settle();
    expect([s.read("Q2"), s.read("Q2N")]).toEqual([1, 1]);
    // Gated SR latch with activeLowEnable: EN=0 enables, EN=1 holds
    s.set("S", 1);
    s.set("R", 0);
    s.set("EN", 0);
    s.settle();
    expect(s.read("Q3")).toBe(1);
    s.set("EN", 1);
    s.set("S", 0);
    s.set("R", 1);
    s.settle();
    expect(s.read("Q3")).toBe(1);
  });

  it("evaluates d-ff, t-ff, sr-ff, and jk-ff (from zero initial state)", () => {
    const doc = mk(
      [
        ["CLK", "clock"],
        ["D", "input-pin"],
        ["T", "input-pin"],
        ["S", "input-pin"],
        ["R", "input-pin"],
        ["EN", "input-pin"],
        ["DF", "d-ff", { enable: true }],
        ["TF", "t-ff"],
        ["SF", "sr-ff"],
        ["JF", "jk-ff"],
        ["QD", "output-pin"],
        ["QT", "output-pin"],
        ["QS", "output-pin"],
        ["QJ", "output-pin"],
      ],
      [
        ["CLK.clk", "DF.clk", "TF.clk", "SF.clk", "JF.clk"],
        ["D.out", "DF.d"],
        ["EN.out", "DF.en"],
        ["T.out", "TF.t"],
        ["S.out", "SF.s", "JF.j"],
        ["R.out", "SF.r", "JF.k"],
        ["DF.q", "QD.in"],
        ["TF.q", "QT.in"],
        ["SF.q", "QS.in"],
        ["JF.q", "QJ.in"],
      ],
    );
    const s = sim(doc, "zero");
    s.settle();
    s.set("D", 1);
    s.set("EN", 1);
    s.set("T", 1);
    s.set("S", 1);
    s.set("R", 0);
    tick(s);
    expect([s.read("QD"), s.read("QT"), s.read("QS"), s.read("QJ")]).toEqual([1, 1, 1, 1]);
    // Disable DF, toggle TF & JF (J=K=1), reset SF (S=0, R=1) -> wait: test J=K=1 toggle separately
    s.set("D", 0);
    s.set("EN", 0);
    s.set("T", 1);
    s.set("S", 1);
    s.set("R", 1);
    tick(s);
    expect([s.read("QD"), s.read("QT"), s.read("QS"), s.read("QJ")]).toEqual([1, 0, null, 0]);
  });

  it("evaluates register (sync reset overrides enable) and counter (up/down, load, rco)", () => {
    const doc = mk(
      [
        ["CLK", "clock"],
        ["RST", "input-pin"],
        ["EN", "input-pin"],
        ["LD", "input-pin"],
        ["UD", "input-pin"],
        ["D", "input-pin", { width: 4 }],
        ["REG", "register", { width: 4, enable: true, reset: true }],
        ["CNT", "counter", { bits: 4, upDown: true, load: true, enable: true, reset: true, carryOut: true }],
        ["QR", "output-pin", { width: 4 }],
        ["QC", "output-pin", { width: 4 }],
        ["RCO", "output-pin"],
      ],
      [
        ["CLK.clk", "REG.clk", "CNT.clk"],
        ["RST.out", "REG.rst", "CNT.rst"],
        ["EN.out", "REG.en", "CNT.en"],
        ["LD.out", "CNT.load"],
        ["UD.out", "CNT.ud"],
        ["D.out", "REG.d", "CNT.d"],
        ["REG.q", "QR.in"],
        ["CNT.q", "QC.in"],
        ["CNT.rco", "RCO.in"],
      ],
    );
    const s = sim(doc, "zero");
    s.settle();
    // Load D=14 into REG & CNT
    s.set("D", 14);
    s.set("EN", 1);
    s.set("LD", 1);
    s.set("UD", 1);
    tick(s);
    expect(s.read("QR")).toBe(14);
    expect(s.read("QC")).toBe(14);
    expect(s.read("RCO")).toBe(0);
    // Count up to 15 -> RCO = 1
    s.set("LD", 0);
    tick(s);
    expect(s.read("QC")).toBe(15);
    expect(s.read("RCO")).toBe(1);
    // Count down when UD = 0 -> RCO = 0 at 15, RCO = 1 at 0
    s.set("UD", 0);
    s.settle();
    expect(s.read("RCO")).toBe(0);
    // Sync reset overrides EN = 0
    s.set("EN", 0);
    s.set("RST", 1);
    tick(s);
    expect(s.read("QR")).toBe(0);
    expect(s.read("QC")).toBe(0);
    expect(s.read("RCO")).toBe(0); // EN = 0 gates RCO
    s.set("EN", 1);
    s.settle();
    expect(s.read("RCO")).toBe(1); // Q=0, UD=0, EN=1 -> RCO=1
  });
});

describe("unmodelled components reporting", () => {
  // (a generic block has no behaviour)
  const UNMODELLED = ["generic-block"];

  it("reports every unmodelled component type and drives X on out / Z on inout", () => {
    for (const type of UNMODELLED) {
      const doc = mk([["U", type]], []);
      const c = extractCircuit(doc);
      const staticKinds = kinds(checkCircuit(c));
      expect(staticKinds, type).toContain("unmodelled");
      const s = new Simulator(c);
      const r = s.settle();
      expect(kinds(r.issues), type).toContain("unmodelled");
      for (const pin of c.parts[0].pins) {
        if (pin.dir === "out") expect(s.pinBits("U", pin.id).every((b) => b === BX), `${type}.${pin.id}`).toBe(true);
        if (pin.dir === "inout") expect(s.pinBits("U", pin.id).every((b) => b === BZ), `${type}.${pin.id}`).toBe(true);
      }
    }
  });
});

describe("tunnels, structuralKey, circuitText", () => {
  it("ignores empty-name tunnels for joining and updates structuralKey when tunnel name changes", () => {
    const doc = mk(
      [["A", "input-pin"], ["T1", "tunnel", { name: "" }], ["T2", "tunnel", { name: "" }], ["Y", "output-pin"]],
      [["A.out", "T1.net"], ["T2.net", "Y.in"]],
    );
    const c = extractCircuit(doc);
    expect(c.parts[0].pins[0].net).toBe(-1);
    expect(c.parts[1].pins[0].net).toBe(-1);

    const named = mk(
      [["A", "input-pin"], ["T1", "tunnel", { name: "SIG" }], ["T2", "tunnel", { name: "SIG" }], ["Y", "output-pin"]],
      [["A.out", "T1.net"], ["T2.net", "Y.in"]],
    );
    const renamed = structuredClone(named);
    renamed.components[1].props.name = "OTHER";
    expect(structuralKey(renamed)).not.toBe(structuralKey(named));
  });

  it("round-trips multi-bit circuitText through compileSpec", () => {
    const doc = mk(
      [["A", "input-pin", { width: 4 }], ["B", "input-pin", { width: 4 }], ["ADD", "adder", { width: 4, carryIn: false, carryOut: false }], ["S", "output-pin", { width: 4 }]],
      [["A.out", "ADD.a"], ["B.out", "ADD.b"], ["ADD.s", "S.in"]],
    );
    const text = circuitText(extractCircuit(doc));
    const built = compileSpec(text);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const s = new Simulator(extractCircuit(built.doc!));
    s.set("A", 5);
    s.set("B", 7);
    s.settle();
    expect(s.read("S")).toBe(12);
  });
});

// =================================================================================================
// CONFIRMED SIMULATOR BUGS (each reproduces a bug verified against src/components/library & specs)
// =================================================================================================

describe("confirmed simulator bugs", () => {
  it("BUG-HUNT-1: push-button ignores activeLow=true (unpressed outputs 0, pressed outputs 1)", () => {
    const doc = mk(
      [["BTN", "push-button", { activeLow: true }], ["Y", "output-pin"]],
      [["BTN.out", "Y.in"]],
    );
    const s = sim(doc);
    s.settle();
    // Active-low momentary push button must output 1 while unpressed, 0 while pressed.
    expect(s.read("Y")).toBe(1);
    s.set("BTN", true);
    s.settle();
    expect(s.read("Y")).toBe(0);
  });

  it("BUG-HUNT-2: bcd-7seg drives definite 1s when LT' is asserted and BI' is unknown (X/Z)", () => {
    const doc = mk(
      [
        ["BCD", "input-pin", { width: 4 }],
        ["LT", "input-pin"],
        ["DEC", "bcd-7seg", { pinMode: "bus", controls: true, activeLow: false }],
        ["SA", "output-pin"],
      ],
      [
        ["BCD.out", "DEC.bcd"],
        ["LT.out", "DEC.lt"],
        // DEC.bi intentionally left floating (Z -> X)
        ["DEC.a", "SA.in"],
      ],
    );
    const s = sim(doc);
    s.set("BCD", 0);
    s.set("LT", 0); // LT' asserted
    s.settle();
    // BI' has priority over LT' (0 blanks all segments, 1 lets LT' light all segments),
    // so with BI' = X and LT' = 0 the segment outputs must be X (null), not definite 1.
    expect(s.read("SA")).toBeNull();
  });

  it("BUG-HUNT-3: jk-ff stays X on J=1, K=0 from initial X state (missing consensus term)", () => {
    const doc = mk(
      [
        ["J", "input-pin"],
        ["K", "input-pin"],
        ["CLK", "clock"],
        ["FF", "jk-ff"],
        ["Q", "output-pin"],
      ],
      [["J.out", "FF.j"], ["K.out", "FF.k"], ["CLK.clk", "FF.clk"], ["FF.q", "Q.in"]],
    );
    const s = sim(doc, "x");
    s.set("J", 1);
    s.set("K", 0);
    s.settle();
    tick(s);
    // J=1, K=0 unconditionally sets Q+ = 1 regardless of prior Q.
    expect(s.read("Q")).toBe(1);
  });

  it("BUG-HUNT-4: Wave-1 BZ evaluation corrupts initial='zero' to X on async-reset FF and latches", () => {
    const doc = mk(
      [
        ["D", "input-pin"],
        ["CLK", "clock"],
        ["RST", "input-pin"],
        ["EN", "input-pin"],
        ["FF", "d-ff", { asyncReset: "active-high" }],
        ["DL", "d-latch"],
        ["QF", "output-pin"],
        ["QL", "output-pin"],
      ],
      [
        ["D.out", "FF.d", "DL.d"],
        ["CLK.clk", "FF.clk"],
        ["RST.out", "FF.rst"],
        ["EN.out", "DL.en"],
        ["FF.q", "QF.in"],
        ["DL.q", "QL.in"],
      ],
    );
    const s = sim(doc, "zero");
    s.settle();
    // With RST=0, EN=0, CLK=0 and initial="zero", both must start at 0, not X.
    expect(s.read("QF")).toBe(0);
    expect(s.read("QL")).toBe(0);
  });

  it("BUG-HUNT-5: falling-edge flip-flop/register triggers spurious unknown clock edge on startup", () => {
    const doc = mk(
      [
        ["D", "constant", { value: "1" }],
        ["CLK", "clock"],
        ["FF", "d-ff", { edge: "falling" }],
        ["Q", "output-pin"],
      ],
      [["D.out", "FF.d"], ["CLK.clk", "FF.clk"], ["FF.q", "Q.in"]],
    );
    const s = sim(doc, "zero");
    s.settle();
    // CLK starts at 0 and never had a falling (1->0) edge; Q must stay 0, not become X.
    expect(s.read("Q")).toBe(0);
  });

  it("BUG-HUNT-6: priority encoder drives Y=X when highest-priority input is 1 and lower input is X/Z", () => {
    const doc = mk(
      [
        ["D3", "constant", { value: "1" }],
        ["D2", "constant", { value: "0" }],
        ["D1", "constant", { value: "0" }],
        ["ENC", "encoder", { outputBits: 2, priority: true }],
        ["Y0", "output-pin"],
        ["Y1", "output-pin"],
        ["V", "output-pin"],
      ],
      [
        ["D3.out", "ENC.d3"],
        ["D2.out", "ENC.d2"],
        ["D1.out", "ENC.d1"],
        // ENC.d0 intentionally left floating (Z -> X)
        ["ENC.y0", "Y0.in"],
        ["ENC.y1", "Y1.in"],
        ["ENC.v", "V.in"],
      ],
    );
    const s = sim(doc);
    s.settle();
    // D3=1 has highest priority, so D0 is don't-care and Y must be 11 (Y1=1, Y0=1).
    expect(s.read("V")).toBe(1);
    expect([s.read("Y0"), s.read("Y1")]).toEqual([1, 1]);
  });

  it("BUG-HUNT-7: splitterSlices does not clamp/round fanOut like splitterGeometry", () => {
    const doc = mk(
      [
        ["BUS", "input-pin", { width: 4 }],
        ["SP", "splitter", { width: 4, fanOut: 1 }],
        ["LO", "output-pin", { width: 2 }],
        ["HI", "output-pin", { width: 2 }],
      ],
      [["BUS.out", "SP.bus"], ["SP.b0", "LO.in"], ["SP.b1", "HI.in"]],
    );
    const s = sim(doc);
    s.set("BUS", 0b1001);
    s.settle();
    // splitterGeometry clamps fanOut=1 to 2, creating b0[1:0] and b1[3:2], so HI must read 0b10.
    expect(s.read("LO")).toBe(0b01);
    expect(s.read("HI")).toBe(0b10);
  });

  it("BUG-HUNT-8: Simulator.read() throws TypeError on zero-pin generic-block", () => {
    const doc = mk([["B", "generic-block", { inputs: 0, outputs: 0 }]], []);
    const s = sim(doc);
    s.settle();
    expect(() => s.read("B")).not.toThrow(TypeError);
  });

  it("BUG-HUNT-9: checkCircuit misses multiple-drivers when two outputs of the same part are shorted", () => {
    const doc = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["HA", "half-adder"],
        ["Y", "output-pin"],
      ],
      [["A.out", "HA.a"], ["B.out", "HA.b"], ["HA.s", "HA.cout", "Y.in"]],
    );
    expect(kinds(checkCircuit(extractCircuit(doc)))).toContain("multiple-drivers");
  });

  it("BUG-HUNT-10: checkCircuit misses single-part combinational feedback loop (N1.out -> N1.in0)", () => {
    const doc = mk([["N1", "not"], ["Y", "output-pin"]], [["N1.out", "N1.in0", "Y.in"]]);
    expect(kinds(checkCircuit(extractCircuit(doc)))).toContain("feedback");
  });

  it("BUG-HUNT-11: checkCircuit reports false positive feedback loop when ground connects to an inout pin", () => {
    const doc = mk(
      [
        ["G", "ground"],
        ["X", "bus-transceiver", { width: 1 }],
        ["DIR", "input-pin"],
        ["OE", "input-pin"],
        ["Y", "output-pin"],
      ],
      [["G.gnd", "X.a"], ["X.b", "Y.in"], ["DIR.out", "X.dir"], ["OE.out", "X.oe"]],
    );
    expect(kinds(checkCircuit(extractCircuit(doc)))).not.toContain("feedback");
  });

  it("BUG-HUNT-12: truthTable with keypad input never exercises VALID=0", () => {
    const doc = mk([["KP", "keypad"], ["Y", "output-pin"]], [["KP.valid", "Y.in"]]);
    const t = truthTable(extractCircuit(doc), { inputs: ["KP"] });
    // vars has 5 bits (KP[0]..KP[4]); row 0 has KP[4]=0 so VALID (Y) must be 0, not 1.
    expect(t.rows[0]).toEqual([B0]);
  });

  it("BUG-HUNT-13: truthTable only reads the first input pin of a multi-input-pin output part", () => {
    const doc = mk(
      [["A", "input-pin"], ["B", "input-pin"], ["G", "and"], ["Y", "output-pin"]],
      [["A.out", "G.in0"], ["B.out", "G.in1"], ["G.out", "Y.in"]],
    );
    const t = truthTable(extractCircuit(doc), { outputs: ["G"] });
    expect(t.outBits).toEqual(["G[0]", "G[1]"]);
    expect(t.rows.every((r) => r.length === t.outBits.length)).toBe(true);
    expect(outputFunctions(t)[1].minterms).toEqual([1, 3]);
    expect(truthTableText(t)).toContain("G[1]");
  });

  it("BUG-HUNT-14: stateInCone/truthTable rejects pure display sinks (led-bar, seven-segment, hex-display)", () => {
    const doc = mk(
      [["A", "input-pin"], ["B", "input-pin"], ["BAR", "led-bar", { count: 2 }]],
      [["A.out", "BAR.in0"], ["B.out", "BAR.in1"]],
    );
    const c = extractCircuit(doc);
    expect(stateInCone(c, [c.parts[2]])).toEqual([]);
  });

  it("BUG-HUNT-15: structuralKey changes on non-structural props.name / generic-block pin-name renames", () => {
    const doc = mk(
      [["A", "input-pin", { name: "A" }], ["N", "not"], ["Y", "output-pin", { name: "Y" }]],
      [["A.out", "N.in0"], ["N.out", "Y.in"]],
    );
    const store = new DocumentStore(doc);
    const calls: number[] = [];
    const w = watchCircuit(store, () => calls.push(1));
    const k0 = structuralKey(store.doc);
    store.update("rename input", (d) => {
      d.components[0].props.name = "IN_X";
    });
    expect(structuralKey(store.doc)).toBe(k0);
    expect(calls).toEqual([]);
    expect(w.builds).toBe(0);
    w.dispose();
  });

  it("BUG-HUNT-16: watchCircuit leaves namesStale=true after lazy initial build, causing redundant rebuild on next current()", () => {
    const doc = mk(
      [["A", "input-pin"], ["N", "not"], ["Y", "output-pin"]],
      [["A.out", "N.in0"], ["N.out", "Y.in"]],
    );
    const store = new DocumentStore(doc);
    const w = watchCircuit(store);
    store.update("rename label", (d) => {
      d.components[1].label = "INV1";
    });
    const first = w.current();
    const second = w.current();
    // No edit happened between first and second current() calls, so cached snapshot must be reused.
    expect(second).toBe(first);
    w.dispose();
  });
});

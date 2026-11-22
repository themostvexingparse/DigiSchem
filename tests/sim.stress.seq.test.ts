import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import type { PropValue, SchematicDocument } from "../src/model/types";
import { extractCircuit } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { B0, B1, BX, BZ, Simulator, type Bit } from "../src/logic/simulate";

registerBuiltinComponents();

type PartSpec = [id: string, type: string, props?: Record<string, PropValue>];

/** Build a schematic document with explicit pin-to-pin nets. */
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
    name: "seq-stress",
    grid: 10,
    components: parts.map(([id, type, props], i) => ({
      id,
      type,
      x: (i % 8) * 200,
      y: Math.floor(i / 8) * 200,
      rotation: 0,
      props: props ?? {},
      label: "",
    })),
    wires: [],
    texts: [],
    links,
  };
}

/** Deterministic seeded LCG PRNG (never Math.random). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randBit(rng: () => number): 0 | 1 {
  return rng() < 0.5 ? 0 : 1;
}

const rNot = (b: Bit): Bit => (b === B0 ? B1 : b === B1 ? B0 : BX);

function numToRefBits(val: number, width: number): Bit[] {
  const out: Bit[] = [];
  for (let i = 0; i < width; i++) out.push(((val >>> i) & 1) as Bit);
  return out;
}

function refBitsToNum(bits: readonly Bit[]): number | null {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) {
    if (bits[i] !== B0 && bits[i] !== B1) return null;
    v = v * 2 + bits[i];
  }
  return v;
}

const issueKinds = (issues: readonly { kind: string }[]) => issues.map((i) => i.kind);

// =================================================================================================
// 1. Flip-flops (d-ff, jk-ff, t-ff, sr-ff) — exhaustive prop matrix vs independent reference
// =================================================================================================

describe("1. flip-flops (d-ff, jk-ff, t-ff, sr-ff)", () => {
  type FfType = "d-ff" | "jk-ff" | "t-ff" | "sr-ff";
  type EdgeMode = "rising" | "falling";
  type AsyncMode = "none" | "active-high" | "active-low";

  const FF_TYPES: FfType[] = ["d-ff", "jk-ff", "t-ff", "sr-ff"];
  const EDGES: EdgeMode[] = ["rising", "falling"];
  const ASYNC_MODES: AsyncMode[] = ["none", "active-high", "active-low"];

  function buildFfDoc(
    ffType: FfType,
    edge: EdgeMode,
    asyncReset: AsyncMode,
    asyncSet: AsyncMode,
    enable: boolean,
    clockType: "clock" | "input-pin",
  ): SchematicDocument {
    const clkOutPin = clockType === "clock" ? "CLK.clk" : "CLK.out";
    const parts: PartSpec[] = [
      ["CLK", clockType],
      ["FF", ffType, { edge, asyncReset, asyncSet, enable, showQBar: true }],
      ["Q", "output-pin"],
      ["QN", "output-pin"],
    ];
    const nets: string[][] = [
      [clkOutPin, "FF.clk"],
      ["FF.q", "Q.in"],
      ["FF.qn", "QN.in"],
    ];
    if (ffType === "d-ff") {
      parts.push(["D", "input-pin"]);
      nets.push(["D.out", "FF.d"]);
    } else if (ffType === "t-ff") {
      parts.push(["T", "input-pin"]);
      nets.push(["T.out", "FF.t"]);
    } else if (ffType === "jk-ff") {
      parts.push(["J", "input-pin"], ["K", "input-pin"]);
      nets.push(["J.out", "FF.j"], ["K.out", "FF.k"]);
    } else {
      parts.push(["S", "input-pin"], ["R", "input-pin"]);
      nets.push(["S.out", "FF.s"], ["R.out", "FF.r"]);
    }
    if (enable) {
      parts.push(["EN", "input-pin"]);
      nets.push(["EN.out", "FF.en"]);
    }
    if (asyncReset !== "none") {
      parts.push(["RST", "input-pin"]);
      nets.push(["RST.out", "FF.rst"]);
    }
    if (asyncSet !== "none") {
      parts.push(["SET", "input-pin"]);
      nets.push(["SET.out", "FF.set"]);
    }
    return mk(parts, nets);
  }

  function refFfNext(ffType: FfType, d0: 0 | 1, d1: 0 | 1, q: Bit): Bit {
    if (ffType === "d-ff") return d0;
    if (ffType === "t-ff") {
      if (q === BX) return BX;
      return (d0 ^ q) as Bit;
    }
    if (ffType === "jk-ff") {
      const j = d0;
      const k = d1;
      if (j === 0 && k === 0) return q;
      if (j === 0 && k === 1) return B0;
      if (j === 1 && k === 0) return B1;
      return q === BX ? BX : ((1 - q) as Bit);
    }
    // sr-ff
    const s = d0;
    const r = d1;
    if (s === 0 && r === 0) return q;
    if (s === 1 && r === 0) return B1;
    if (s === 0 && r === 1) return B0;
    return BX;
  }

  function inactiveLevel(mode: AsyncMode): 0 | 1 {
    return mode === "active-low" ? 1 : 0;
  }

  function isAsserted(mode: AsyncMode, raw: 0 | 1): boolean {
    if (mode === "none") return false;
    return mode === "active-low" ? raw === 0 : raw === 1;
  }

  it("matches reference across all 144 prop combinations with initial:'x' (using clock and input-pin)", () => {
    const rng = makeRng(0x11a2b3c4);
    let comboIndex = 0;

    for (const ffType of FF_TYPES) {
      for (const edge of EDGES) {
        for (const asyncReset of ASYNC_MODES) {
          for (const asyncSet of ASYNC_MODES) {
            for (const enable of [false, true]) {
              const clockType: "clock" | "input-pin" = comboIndex % 2 === 0 ? "clock" : "input-pin";
              comboIndex++;
              const doc = buildFfDoc(ffType, edge, asyncReset, asyncSet, enable, clockType);
              const sim = new Simulator(extractCircuit(doc), { initial: "x" });

              const idleClk: 0 | 1 = edge === "rising" ? 0 : 1;
              let clk: 0 | 1 = idleClk;
              let en: 0 | 1 = 1;
              let rst: 0 | 1 = inactiveLevel(asyncReset);
              let set: 0 | 1 = inactiveLevel(asyncSet);
              let d0: 0 | 1 = 0;
              let d1: 0 | 1 = 0;

              sim.set("CLK", clk);
              if (enable) sim.set("EN", en);
              if (asyncReset !== "none") sim.set("RST", rst);
              if (asyncSet !== "none") sim.set("SET", set);
              if (ffType === "d-ff") sim.set("D", d0);
              else if (ffType === "t-ff") sim.set("T", d0);
              else if (ffType === "jk-ff") {
                sim.set("J", d0);
                sim.set("K", d1);
              } else {
                sim.set("S", d0);
                sim.set("R", d1);
              }

              // Initial settle: outputs must be unknown (X) until set/reset or clocked.
              const initRes = sim.settle();
              expect(initRes.stable).toBe(true);
              expect(initRes.issues).toEqual([]);
              expect(sim.read("Q")).toBe(null);
              expect(sim.read("QN")).toBe(null);
              expect(sim.pinBits("FF", "q")).toEqual([BX]);
              expect(sim.pinBits("FF", "qn")).toEqual([BX]);

              let refQ: Bit = BX;
              let prevClkAct: 0 | 1 = edge === "falling" ? ((1 - clk) as 0 | 1) : clk;

              for (let step = 0; step < 28; step++) {
                // Randomize inputs, keeping async resets/sets relatively infrequent so clocking is exercised heavily.
                if (rng() < 0.7) d0 = randBit(rng);
                if (rng() < 0.7) d1 = randBit(rng);
                if (enable && rng() < 0.35) en = randBit(rng);
                if (asyncReset !== "none") rst = rng() < 0.14 ? ((1 - inactiveLevel(asyncReset)) as 0 | 1) : inactiveLevel(asyncReset);
                if (asyncSet !== "none") set = rng() < 0.14 ? ((1 - inactiveLevel(asyncSet)) as 0 | 1) : inactiveLevel(asyncSet);
                if (rng() < 0.65) clk = (1 - clk) as 0 | 1;

                // Avoid BUG-SEQ-3 (jk-ff J=1,K=0 from Q=X) here; BUG-SEQ-3 is isolated in its own it.fails test.
                if (ffType === "jk-ff" && refQ === BX && d0 === 1 && d1 === 0) {
                  d0 = 0;
                  d1 = 1;
                }

                sim.set("CLK", clk);
                if (enable) sim.set("EN", en);
                if (asyncReset !== "none") sim.set("RST", rst);
                if (asyncSet !== "none") sim.set("SET", set);
                if (ffType === "d-ff") sim.set("D", d0);
                else if (ffType === "t-ff") sim.set("T", d0);
                else if (ffType === "jk-ff") {
                  sim.set("J", d0);
                  sim.set("K", d1);
                } else {
                  sim.set("S", d0);
                  sim.set("R", d1);
                }

                const res = sim.settle();
                expect(res.stable).toBe(true);
                expect(res.issues).toEqual([]);

                // Reference update
                const clkAct: 0 | 1 = edge === "falling" ? ((1 - clk) as 0 | 1) : clk;
                const activeEdge = prevClkAct === 0 && clkAct === 1;
                prevClkAct = clkAct;
                if (activeEdge && (!enable || en === 1)) {
                  refQ = refFfNext(ffType, d0, d1, refQ);
                }
                const rAct = isAsserted(asyncReset, rst);
                const sAct = isAsserted(asyncSet, set);
                if (rAct && !sAct) refQ = B0;
                else if (sAct && !rAct) refQ = B1;
                else if (rAct && sAct) refQ = BX;

                const refQN = rNot(refQ);
                const label = `${ffType} edge=${edge} rst=${asyncReset} set=${asyncSet} en=${enable} clk=${clockType} step=${step}`;
                expect(sim.pinBits("FF", "q"), label).toEqual([refQ]);
                expect(sim.pinBits("FF", "qn"), label).toEqual([refQN]);
                expect(sim.read("Q"), label).toBe(refQ === BX ? null : refQ);
                expect(sim.read("QN"), label).toBe(refQN === BX ? null : refQN);
              }
            }
          }
        }
      }
    }
  });

  it("matches reference with initial:'zero' for flip-flops without async pins (starting clock idle)", () => {
    const rng = makeRng(0x55aa1234);
    for (const ffType of FF_TYPES) {
      for (const edge of EDGES) {
        for (const enable of [false, true]) {
          for (const clockType of ["clock", "input-pin"] as const) {
            const doc = buildFfDoc(ffType, edge, "none", "none", enable, clockType);
            const sim = new Simulator(extractCircuit(doc), { initial: "zero" });

            let clk: 0 | 1 = edge === "rising" ? 0 : 1;
            let en: 0 | 1 = 1;
            let d0: 0 | 1 = 0;
            let d1: 0 | 1 = 0;

            sim.set("CLK", clk);
            if (enable) sim.set("EN", en);
            if (ffType === "d-ff") sim.set("D", d0);
            else if (ffType === "t-ff") sim.set("T", d0);
            else if (ffType === "jk-ff") {
              sim.set("J", d0);
              sim.set("K", d1);
            } else {
              sim.set("S", d0);
              sim.set("R", d1);
            }

            const r0 = sim.settle();
            expect(r0.stable).toBe(true);
            expect(r0.issues).toEqual([]);
            expect(sim.read("Q")).toBe(0);
            expect(sim.read("QN")).toBe(1);

            let refQ: Bit = B0;
            let prevClkAct: 0 | 1 = 0;

            for (let step = 0; step < 40; step++) {
              d0 = randBit(rng);
              d1 = randBit(rng);
              if (enable) en = randBit(rng);
              if (rng() < 0.7) clk = (1 - clk) as 0 | 1;

              // For sr-ff, keep S=R=1 occasional and allow recovery
              if (ffType === "sr-ff" && d0 === 1 && d1 === 1 && rng() < 0.7) d1 = 0;

              sim.set("CLK", clk);
              if (enable) sim.set("EN", en);
              if (ffType === "d-ff") sim.set("D", d0);
              else if (ffType === "t-ff") sim.set("T", d0);
              else if (ffType === "jk-ff") {
                sim.set("J", d0);
                sim.set("K", d1);
              } else {
                sim.set("S", d0);
                sim.set("R", d1);
              }

              const r = sim.settle();
              expect(r.stable).toBe(true);
              expect(r.issues).toEqual([]);

              const clkAct: 0 | 1 = edge === "falling" ? ((1 - clk) as 0 | 1) : clk;
              const activeEdge = prevClkAct === 0 && clkAct === 1;
              prevClkAct = clkAct;
              if (activeEdge && (!enable || en === 1)) {
                refQ = refFfNext(ffType, d0, d1, refQ);
              }
              const refQN = rNot(refQ);
              const tag = `zero ${ffType} edge=${edge} en=${enable} clk=${clockType} step=${step}`;
              expect(sim.read("Q"), tag).toBe(refQ === BX ? null : refQ);
              expect(sim.read("QN"), tag).toBe(refQN === BX ? null : refQN);
            }
          }
        }
      }
    }
  });

  it("behaves identically whether clocked by a clock part or an input-pin", () => {
    const rng = makeRng(0x98765432);
    const docClk = buildFfDoc("d-ff", "rising", "active-low", "active-high", true, "clock");
    const docPin = buildFfDoc("d-ff", "rising", "active-low", "active-high", true, "input-pin");
    const sClk = new Simulator(extractCircuit(docClk), { initial: "x" });
    const sPin = new Simulator(extractCircuit(docPin), { initial: "x" });

    for (let step = 0; step < 60; step++) {
      const clk = randBit(rng);
      const d = randBit(rng);
      const en = randBit(rng);
      const rst = rng() < 0.15 ? 0 : 1;
      const set = rng() < 0.15 ? 1 : 0;
      for (const s of [sClk, sPin]) {
        s.set("CLK", clk);
        s.set("D", d);
        s.set("EN", en);
        s.set("RST", rst);
        s.set("SET", set);
        s.settle();
      }
      expect(sClk.pinBits("FF", "q")).toEqual(sPin.pinBits("FF", "q"));
      expect(sClk.pinBits("FF", "qn")).toEqual(sPin.pinBits("FF", "qn"));
    }
  });

  it("BUG-SEQ-1: flip-flop with asyncReset/asyncSet ignores initial:'zero' on first settle", () => {
    const doc = buildFfDoc("d-ff", "rising", "active-high", "none", false, "clock");
    const sim = new Simulator(extractCircuit(doc), { initial: "zero" });
    sim.set("D", 0);
    sim.set("CLK", 0);
    sim.set("RST", 0); // inactive
    sim.settle();
    expect(sim.read("Q")).toBe(0);
    expect(sim.read("QN")).toBe(1);
  });

  it("BUG-SEQ-2: falling-edge flip-flop with initial:'zero' and default CLK=0 corrupts Q to X on first settle", () => {
    const doc = buildFfDoc("d-ff", "falling", "none", "none", false, "clock");
    const sim = new Simulator(extractCircuit(doc), { initial: "zero" });
    sim.set("D", 1);
    // CLK stays at its default 0 — no clock transition occurred.
    sim.settle();
    expect(sim.read("Q")).toBe(0);
    expect(sim.read("QN")).toBe(1);
  });

  it("BUG-SEQ-3: jk-ff with J=1, K=0 fails to set Q=1 when starting from initial:'x'", () => {
    const doc = buildFfDoc("jk-ff", "rising", "none", "none", false, "clock");
    const sim = new Simulator(extractCircuit(doc), { initial: "x" });
    sim.set("J", 1);
    sim.set("K", 0);
    sim.set("CLK", 0);
    sim.settle();
    sim.set("CLK", 1);
    sim.settle();
    expect(sim.read("Q")).toBe(1);
    expect(sim.read("QN")).toBe(0);
  });
});

// =================================================================================================
// 2. Latches (sr-latch, d-latch, gated-sr-latch, and cross-coupled NOR/NAND latches)
// =================================================================================================

describe("2. latches (sr-latch, d-latch, gated-sr-latch, cross-coupled nand/nor)", () => {
  it("matches reference for sr-latch (activeLow false and true)", () => {
    const rng = makeRng(0x202601);
    for (const activeLow of [false, true]) {
      const doc = mk(
        [
          ["S", "input-pin"],
          ["R", "input-pin"],
          ["L", "sr-latch", { activeLow, showQBar: true }],
          ["Q", "output-pin"],
          ["QN", "output-pin"],
        ],
        [
          ["S.out", "L.s"],
          ["R.out", "L.r"],
          ["L.q", "Q.in"],
          ["L.qn", "QN.in"],
        ],
      );
      const sim = new Simulator(extractCircuit(doc), { initial: "x" });
      const holdLevel: 0 | 1 = activeLow ? 1 : 0;
      const assertLevel: 0 | 1 = activeLow ? 0 : 1;

      // Start in hold -> outputs remain unknown
      sim.set("S", holdLevel);
      sim.set("R", holdLevel);
      sim.settle();
      expect(sim.read("Q")).toBe(null);
      expect(sim.read("QN")).toBe(null);

      // Explicit forbidden -> release to hold -> outputs become X
      sim.set("S", assertLevel);
      sim.set("R", assertLevel);
      sim.settle();
      const bothVal = activeLow ? 1 : 0;
      expect(sim.read("Q")).toBe(bothVal);
      expect(sim.read("QN")).toBe(bothVal);
      sim.set("S", holdLevel);
      sim.set("R", holdLevel);
      sim.settle();
      expect(sim.read("Q")).toBe(null);
      expect(sim.read("QN")).toBe(null);

      let refQ: Bit = BX;
      for (let step = 0; step < 80; step++) {
        const s = randBit(rng);
        const r = randBit(rng);
        sim.set("S", s);
        sim.set("R", r);
        const res = sim.settle();
        expect(res.stable).toBe(true);
        expect(res.issues).toEqual([]);

        const sAct = activeLow ? 1 - s : s;
        const rAct = activeLow ? 1 - r : r;
        let expQ: Bit;
        let expQN: Bit;
        if (sAct === 1 && rAct === 1) {
          refQ = BX;
          expQ = activeLow ? B1 : B0;
          expQN = activeLow ? B1 : B0;
        } else if (sAct === 1 && rAct === 0) {
          refQ = B1;
          expQ = B1;
          expQN = B0;
        } else if (sAct === 0 && rAct === 1) {
          refQ = B0;
          expQ = B0;
          expQN = B1;
        } else {
          expQ = refQ;
          expQN = rNot(refQ);
        }
        expect(sim.pinBits("L", "q"), `sr-latch activeLow=${activeLow} step=${step}`).toEqual([expQ]);
        expect(sim.pinBits("L", "qn"), `sr-latch activeLow=${activeLow} step=${step}`).toEqual([expQN]);
      }
    }
  });

  it("matches reference for d-latch (width 1 and 4, activeLowEnable false and true)", () => {
    const rng = makeRng(0x202602);
    for (const width of [1, 4]) {
      const mask = (1 << width) - 1;
      for (const activeLowEnable of [false, true]) {
        const doc = mk(
          [
            ["D", "input-pin", { width }],
            ["EN", "input-pin"],
            ["L", "d-latch", { width, activeLowEnable, showQBar: true }],
            ["Q", "output-pin", { width }],
            ["QN", "output-pin", { width }],
          ],
          [
            ["D.out", "L.d"],
            ["EN.out", "L.en"],
            ["L.q", "Q.in"],
            ["L.qn", "QN.in"],
          ],
        );
        const sim = new Simulator(extractCircuit(doc), { initial: "x" });
        const disVal: 0 | 1 = activeLowEnable ? 1 : 0;

        // Start disabled -> X
        sim.set("D", 0);
        sim.set("EN", disVal);
        sim.settle();
        expect(sim.read("Q")).toBe(null);
        expect(sim.read("QN")).toBe(null);

        let refQ: Bit[] = new Array<Bit>(width).fill(BX);
        for (let step = 0; step < 80; step++) {
          const d = randInt(rng, 1 << width);
          const en = randBit(rng);
          sim.set("D", d);
          sim.set("EN", en);
          const res = sim.settle();
          expect(res.stable).toBe(true);
          expect(res.issues).toEqual([]);

          const enAct = activeLowEnable ? 1 - en : en;
          if (enAct === 1) refQ = numToRefBits(d, width);
          const refQN = refQ.map(rNot);
          const tag = `d-latch w=${width} lowEn=${activeLowEnable} step=${step}`;
          expect(sim.pinBits("L", "q"), tag).toEqual(refQ);
          expect(sim.pinBits("L", "qn"), tag).toEqual(refQN);
          const numQ = refBitsToNum(refQ);
          expect(sim.read("Q"), tag).toBe(numQ);
          expect(sim.read("QN"), tag).toBe(numQ === null ? null : (~numQ) & mask);
        }
      }
    }
  });

  it("matches reference for gated-sr-latch (activeLowEnable false and true)", () => {
    const rng = makeRng(0x202603);
    for (const activeLowEnable of [false, true]) {
      const doc = mk(
        [
          ["S", "input-pin"],
          ["R", "input-pin"],
          ["EN", "input-pin"],
          ["L", "gated-sr-latch", { activeLowEnable, showQBar: true }],
          ["Q", "output-pin"],
          ["QN", "output-pin"],
        ],
        [
          ["S.out", "L.s"],
          ["R.out", "L.r"],
          ["EN.out", "L.en"],
          ["L.q", "Q.in"],
          ["L.qn", "QN.in"],
        ],
      );
      const sim = new Simulator(extractCircuit(doc), { initial: "x" });
      let refQ: Bit = BX;

      for (let step = 0; step < 80; step++) {
        const s = randBit(rng);
        const r = randBit(rng);
        const en = randBit(rng);
        sim.set("S", s);
        sim.set("R", r);
        sim.set("EN", en);
        const res = sim.settle();
        expect(res.stable).toBe(true);
        expect(res.issues).toEqual([]);

        const enAct = activeLowEnable ? 1 - en : en;
        const sAct = s & enAct;
        const rAct = r & enAct;
        let expQ: Bit;
        let expQN: Bit;
        if (sAct === 1 && rAct === 1) {
          refQ = BX;
          expQ = B0;
          expQN = B0;
        } else if (sAct === 1 && rAct === 0) {
          refQ = B1;
          expQ = B1;
          expQN = B0;
        } else if (sAct === 0 && rAct === 1) {
          refQ = B0;
          expQ = B0;
          expQN = B1;
        } else {
          expQ = refQ;
          expQN = rNot(refQ);
        }
        const tag = `gated-sr-latch lowEn=${activeLowEnable} step=${step}`;
        expect(sim.pinBits("L", "q"), tag).toEqual([expQ]);
        expect(sim.pinBits("L", "qn"), tag).toEqual([expQN]);
      }
    }
  });

  it("handles cross-coupled NOR latch: hold, set, reset, forbidden release -> oscillation/X, and recovery", () => {
    const doc = mk(
      [
        ["S", "input-pin"],
        ["R", "input-pin"],
        ["G1", "nor"],
        ["G2", "nor"],
        ["Q", "output-pin"],
        ["QN", "output-pin"],
      ],
      [
        ["R.out", "G1.in0"],
        ["G2.out", "G1.in1"],
        ["S.out", "G2.in0"],
        ["G1.out", "G2.in1", "Q.in"],
        ["G2.out", "QN.in"],
      ],
    );
    const sim = new Simulator(extractCircuit(doc));
    // Initial hold (S=0, R=0) -> unknown
    sim.set("S", 0);
    sim.set("R", 0);
    expect(sim.settle().stable).toBe(true);
    expect(sim.read("Q")).toBe(null);
    expect(sim.read("QN")).toBe(null);

    // Set
    sim.set("S", 1);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);
    // Hold 1
    sim.set("S", 0);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);
    // Reset
    sim.set("R", 1);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);
    // Hold 0
    sim.set("R", 0);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);

    // Forbidden S=R=1 -> both outputs 0
    sim.set("S", 1);
    sim.set("R", 1);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 0]);

    // Simultaneous release from S=R=1 -> must report oscillation and X (never a definite 0/1)
    sim.set("S", 0);
    sim.set("R", 0);
    const rel = sim.settle();
    expect(rel.stable).toBe(false);
    expect(issueKinds(rel.issues)).toContain("oscillation");
    expect(sim.read("Q")).toBe(null);
    expect(sim.read("QN")).toBe(null);

    // Recovery by setting S=1, R=0
    sim.set("S", 1);
    const rec = sim.settle();
    expect(rec.stable).toBe(true);
    expect(rec.issues).toEqual([]);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);
  });

  it("handles cross-coupled NAND latch: hold, set, reset, forbidden release -> oscillation/X, and recovery", () => {
    const doc = mk(
      [
        ["SN", "input-pin"],
        ["RN", "input-pin"],
        ["G1", "nand"],
        ["G2", "nand"],
        ["Q", "output-pin"],
        ["QN", "output-pin"],
      ],
      [
        ["SN.out", "G1.in0"],
        ["G2.out", "G1.in1"],
        ["RN.out", "G2.in0"],
        ["G1.out", "G2.in1", "Q.in"],
        ["G2.out", "QN.in"],
      ],
    );
    const sim = new Simulator(extractCircuit(doc));
    // Initial hold (S'=1, R'=1) -> unknown
    sim.set("SN", 1);
    sim.set("RN", 1);
    expect(sim.settle().stable).toBe(true);
    expect(sim.read("Q")).toBe(null);
    expect(sim.read("QN")).toBe(null);

    // Set (S'=0, R'=1)
    sim.set("SN", 0);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);
    // Hold
    sim.set("SN", 1);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 0]);
    // Reset (S'=1, R'=0)
    sim.set("RN", 0);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);
    // Hold
    sim.set("RN", 1);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);

    // Forbidden (S'=0, R'=0) -> both outputs 1
    sim.set("SN", 0);
    sim.set("RN", 0);
    expect(sim.settle().stable).toBe(true);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([1, 1]);

    // Simultaneous release to S'=1, R'=1 -> must report oscillation and X
    sim.set("SN", 1);
    sim.set("RN", 1);
    const rel = sim.settle();
    expect(rel.stable).toBe(false);
    expect(issueKinds(rel.issues)).toContain("oscillation");
    expect(sim.read("Q")).toBe(null);
    expect(sim.read("QN")).toBe(null);

    // Recovery by resetting (S'=1, R'=0)
    sim.set("RN", 0);
    const rec = sim.settle();
    expect(rec.stable).toBe(true);
    expect(rec.issues).toEqual([]);
    expect([sim.read("Q"), sim.read("QN")]).toEqual([0, 1]);
  });

  it("BUG-SEQ-1: d-latch and sr-latch with initial:'zero' lose zero state when starting in hold mode", () => {
    const doc = mk(
      [
        ["D", "input-pin"],
        ["EN", "input-pin"],
        ["L", "d-latch"],
        ["Q", "output-pin"],
      ],
      [
        ["D.out", "L.d"],
        ["EN.out", "L.en"],
        ["L.q", "Q.in"],
      ],
    );
    const sim = new Simulator(extractCircuit(doc), { initial: "zero" });
    sim.set("D", 0);
    sim.set("EN", 0); // disabled (hold)
    sim.settle();
    expect(sim.read("Q")).toBe(0);
  });
});

// =================================================================================================
// 3. Register and Counter — long seeded random sequences vs reference
// =================================================================================================

describe("3. register and counter", () => {
  interface RegCfg {
    width: number;
    pinMode: "bus" | "bits";
    enable: boolean;
    reset: boolean;
    edge: "rising" | "falling";
    initial: "x" | "zero";
  }

  function buildRegDoc(cfg: RegCfg): SchematicDocument {
    const parts: PartSpec[] = [
      ["CLK", "clock"],
      [
        "REG",
        "register",
        { width: cfg.width, pinMode: cfg.pinMode, enable: cfg.enable, reset: cfg.reset, edge: cfg.edge },
      ],
    ];
    const nets: string[][] = [["CLK.clk", "REG.clk"]];
    if (cfg.pinMode === "bus") {
      parts.push(["D", "input-pin", { width: cfg.width }], ["Q", "output-pin", { width: cfg.width }]);
      nets.push(["D.out", "REG.d"], ["REG.q", "Q.in"]);
    } else {
      for (let i = 0; i < cfg.width; i++) {
        parts.push([`D${i}`, "input-pin"], [`Q${i}`, "output-pin"]);
        nets.push([`D${i}.out`, `REG.d${i}`], [`REG.q${i}`, `Q${i}.in`]);
      }
    }
    if (cfg.enable) {
      parts.push(["EN", "input-pin"]);
      nets.push(["EN.out", "REG.en"]);
    }
    if (cfg.reset) {
      parts.push(["RST", "input-pin"]);
      nets.push(["RST.out", "REG.rst"]);
    }
    return mk(parts, nets);
  }

  it("matches reference on long random sequences across register prop combinations", () => {
    const rng = makeRng(0x303030);
    const configs: RegCfg[] = [
      { width: 1, pinMode: "bus", enable: true, reset: true, edge: "rising", initial: "x" },
      { width: 4, pinMode: "bus", enable: true, reset: true, edge: "rising", initial: "zero" },
      { width: 4, pinMode: "bits", enable: true, reset: true, edge: "falling", initial: "x" },
      { width: 4, pinMode: "bits", enable: false, reset: true, edge: "rising", initial: "zero" },
      { width: 8, pinMode: "bus", enable: true, reset: false, edge: "falling", initial: "zero" },
      { width: 8, pinMode: "bits", enable: false, reset: false, edge: "rising", initial: "x" },
      { width: 8, pinMode: "bus", enable: true, reset: true, edge: "falling", initial: "zero" },
      { width: 12, pinMode: "bus", enable: false, reset: true, edge: "falling", initial: "x" },
    ];

    for (const cfg of configs) {
      const doc = buildRegDoc(cfg);
      const sim = new Simulator(extractCircuit(doc), { initial: cfg.initial });
      let clk: 0 | 1 = cfg.edge === "rising" ? 0 : 1;
      sim.set("CLK", clk);
      if (cfg.enable) sim.set("EN", 0);
      if (cfg.reset) sim.set("RST", 0);
      if (cfg.pinMode === "bus") sim.set("D", 0);
      else for (let i = 0; i < cfg.width; i++) sim.set(`D${i}`, 0);

      const r0 = sim.settle();
      expect(r0.stable).toBe(true);
      expect(r0.issues).toEqual([]);

      let refQ: number | null = cfg.initial === "zero" ? 0 : null;
      let prevClkAct: 0 | 1 = 0;

      const readReg = (): number | null => {
        if (cfg.pinMode === "bus") return sim.read("Q");
        const bits: Bit[] = [];
        for (let i = 0; i < cfg.width; i++) bits.push(sim.pinBits(`Q${i}`, "in")[0]);
        return refBitsToNum(bits);
      };

      expect(readReg()).toBe(refQ);

      for (let step = 0; step < 100; step++) {
        const d = randInt(rng, 1 << cfg.width);
        const en: 0 | 1 = cfg.enable ? randBit(rng) : 1;
        const rst: 0 | 1 = cfg.reset ? (rng() < 0.15 ? 1 : 0) : 0;
        if (rng() < 0.65) clk = (1 - clk) as 0 | 1;

        sim.set("CLK", clk);
        if (cfg.enable) sim.set("EN", en);
        if (cfg.reset) sim.set("RST", rst);
        if (cfg.pinMode === "bus") sim.set("D", d);
        else for (let i = 0; i < cfg.width; i++) sim.set(`D${i}`, (d >>> i) & 1);

        const res = sim.settle();
        expect(res.stable).toBe(true);
        expect(res.issues).toEqual([]);

        const clkAct: 0 | 1 = cfg.edge === "falling" ? ((1 - clk) as 0 | 1) : clk;
        const activeEdge = prevClkAct === 0 && clkAct === 1;
        prevClkAct = clkAct;
        if (activeEdge) {
          if (rst === 1) refQ = 0;
          else if (en === 1) refQ = d;
        }
        expect(readReg(), `reg ${JSON.stringify(cfg)} step=${step}`).toBe(refQ);
      }
    }
  });

  it("BUG-SEQ-2: falling-edge register with initial:'zero' and default CLK=0 corrupts Q to X on first settle", () => {
    const doc = buildRegDoc({
      width: 4,
      pinMode: "bus",
      enable: false,
      reset: false,
      edge: "falling",
      initial: "zero",
    });
    const sim = new Simulator(extractCircuit(doc), { initial: "zero" });
    sim.set("D", 0b1010);
    // CLK remains at default 0 — no falling edge occurred.
    sim.settle();
    expect(sim.read("Q")).toBe(0);
  });

  interface CntCfg {
    bits: number;
    pinMode: "bus" | "bits";
    upDown: boolean;
    load: boolean;
    enable: boolean;
    reset: boolean;
    carryOut: boolean;
    initial: "x" | "zero";
  }

  function buildCounterDoc(cfg: CntCfg): SchematicDocument {
    const parts: PartSpec[] = [
      ["CLK", "clock"],
      [
        "CNT",
        "counter",
        {
          bits: cfg.bits,
          pinMode: cfg.pinMode,
          upDown: cfg.upDown,
          load: cfg.load,
          enable: cfg.enable,
          reset: cfg.reset,
          carryOut: cfg.carryOut,
        },
      ],
    ];
    const nets: string[][] = [["CLK.clk", "CNT.clk"]];
    if (cfg.pinMode === "bus") {
      parts.push(["Q", "output-pin", { width: cfg.bits }]);
      nets.push(["CNT.q", "Q.in"]);
      if (cfg.load) {
        parts.push(["D", "input-pin", { width: cfg.bits }]);
        nets.push(["D.out", "CNT.d"]);
      }
    } else {
      for (let i = 0; i < cfg.bits; i++) {
        parts.push([`Q${i}`, "output-pin"]);
        nets.push([`CNT.q${i}`, `Q${i}.in`]);
        if (cfg.load) {
          parts.push([`D${i}`, "input-pin"]);
          nets.push([`D${i}.out`, `CNT.d${i}`]);
        }
      }
    }
    if (cfg.load) {
      parts.push(["LD", "input-pin"]);
      nets.push(["LD.out", "CNT.load"]);
    }
    if (cfg.enable) {
      parts.push(["EN", "input-pin"]);
      nets.push(["EN.out", "CNT.en"]);
    }
    if (cfg.upDown) {
      parts.push(["UD", "input-pin"]);
      nets.push(["UD.out", "CNT.ud"]);
    }
    if (cfg.reset) {
      parts.push(["RST", "input-pin"]);
      nets.push(["RST.out", "CNT.rst"]);
    }
    if (cfg.carryOut) {
      parts.push(["RCO", "output-pin"]);
      nets.push(["CNT.rco", "RCO.in"]);
    }
    return mk(parts, nets);
  }

  it("matches reference on long random sequences across counter prop combinations (Q and RCO)", () => {
    const rng = makeRng(0x404040);
    const configs: CntCfg[] = [
      { bits: 1, pinMode: "bus", upDown: true, load: true, enable: true, reset: true, carryOut: true, initial: "zero" },
      { bits: 3, pinMode: "bus", upDown: false, load: false, enable: true, reset: true, carryOut: true, initial: "x" },
      { bits: 4, pinMode: "bus", upDown: true, load: true, enable: true, reset: true, carryOut: true, initial: "x" },
      { bits: 4, pinMode: "bits", upDown: true, load: true, enable: true, reset: true, carryOut: true, initial: "zero" },
      { bits: 4, pinMode: "bits", upDown: false, load: true, enable: false, reset: false, carryOut: true, initial: "x" },
      { bits: 4, pinMode: "bus", upDown: true, load: false, enable: false, reset: true, carryOut: false, initial: "zero" },
      { bits: 8, pinMode: "bus", upDown: true, load: true, enable: true, reset: true, carryOut: true, initial: "zero" },
    ];

    for (const cfg of configs) {
      const mod = 1 << cfg.bits;
      const doc = buildCounterDoc(cfg);
      const sim = new Simulator(extractCircuit(doc), { initial: cfg.initial });
      let clk: 0 | 1 = 0;
      sim.set("CLK", 0);
      if (cfg.enable) sim.set("EN", 0);
      if (cfg.reset) sim.set("RST", 0);
      if (cfg.load) {
        sim.set("LD", 0);
        if (cfg.pinMode === "bus") sim.set("D", 0);
        else for (let i = 0; i < cfg.bits; i++) sim.set(`D${i}`, 0);
      }
      if (cfg.upDown) sim.set("UD", 1);

      const r0 = sim.settle();
      expect(r0.stable).toBe(true);
      expect(r0.issues).toEqual([]);

      let refQ: number | null = cfg.initial === "zero" ? 0 : null;
      let prevClk: 0 | 1 = 0;

      const readCnt = (): number | null => {
        if (cfg.pinMode === "bus") return sim.read("Q");
        const bits: Bit[] = [];
        for (let i = 0; i < cfg.bits; i++) bits.push(sim.pinBits(`Q${i}`, "in")[0]);
        return refBitsToNum(bits);
      };

      expect(readCnt()).toBe(refQ);

      for (let step = 0; step < 150; step++) {
        const d = randInt(rng, mod);
        const en: 0 | 1 = cfg.enable ? (rng() < 0.75 ? 1 : 0) : 1;
        const ud: 0 | 1 = cfg.upDown ? (rng() < 0.6 ? 1 : 0) : 1;
        const ld: 0 | 1 = cfg.load ? (rng() < 0.14 ? 1 : 0) : 0;
        const rst: 0 | 1 = cfg.reset ? (rng() < 0.1 ? 1 : 0) : 0;
        if (rng() < 0.7) clk = (1 - clk) as 0 | 1;

        sim.set("CLK", clk);
        if (cfg.enable) sim.set("EN", en);
        if (cfg.upDown) sim.set("UD", ud);
        if (cfg.load) {
          sim.set("LD", ld);
          if (cfg.pinMode === "bus") sim.set("D", d);
          else for (let i = 0; i < cfg.bits; i++) sim.set(`D${i}`, (d >>> i) & 1);
        }
        if (cfg.reset) sim.set("RST", rst);

        const res = sim.settle();
        expect(res.stable).toBe(true);
        expect(res.issues).toEqual([]);

        const rising = prevClk === 0 && clk === 1;
        prevClk = clk;
        if (rising) {
          if (rst === 1) refQ = 0;
          else if (ld === 1) refQ = d;
          else if (en === 1 && refQ !== null) {
            refQ = ud === 1 ? (refQ + 1) % mod : (refQ - 1 + mod) % mod;
          }
        }

        const tag = `cnt ${JSON.stringify(cfg)} step=${step}`;
        expect(readCnt(), tag).toBe(refQ);
        if (cfg.carryOut) {
          let expRco: number | null;
          if (en === 0) expRco = 0;
          else if (refQ === null) expRco = null;
          else expRco = (ud === 1 ? refQ === mod - 1 : refQ === 0) ? 1 : 0;
          expect(sim.read("RCO"), `${tag} rco`).toBe(expRco);
        }
      }
    }
  });
});

// =================================================================================================
// 4. Shift structures built from d-ffs (8-stage shift register, ring, Johnson ring, ripple counter)
// =================================================================================================

describe("4. shift structures built from d-ffs", () => {
  it("8-stage shift register on one clock samples all flip-flops together (initial:'zero' and initial:'x')", () => {
    const parts: PartSpec[] = [
      ["DIN", "input-pin"],
      ["CLK", "clock"],
    ];
    const clkNet = ["CLK.clk"];
    const nets: string[][] = [];
    for (let i = 0; i < 8; i++) {
      parts.push([`F${i}`, "d-ff"], [`Q${i}`, "output-pin"]);
      clkNet.push(`F${i}.clk`);
    }
    nets.push(clkNet);
    nets.push(["DIN.out", "F0.d"]);
    for (let i = 0; i < 7; i++) nets.push([`F${i}.q`, `F${i + 1}.d`, `Q${i}.in`]);
    nets.push(["F7.q", "Q7.in"]);

    const circuit = extractCircuit(mk(parts, nets));

    for (const initial of ["zero", "x"] as const) {
      const rng = makeRng(initial === "zero" ? 0x8001 : 0x8002);
      const sim = new Simulator(circuit, { initial });
      sim.set("CLK", 0);
      sim.set("DIN", 0);
      sim.settle();

      const pipe: (number | null)[] = new Array<number | null>(8).fill(initial === "zero" ? 0 : null);
      expect(Array.from({ length: 8 }, (_, i) => sim.read(`Q${i}`))).toEqual(pipe);

      for (let cycle = 0; cycle < 40; cycle++) {
        const bit = randBit(rng);
        sim.set("DIN", bit);
        sim.settle();
        // Rising edge: all 8 stages sample simultaneously
        sim.set("CLK", 1);
        const r = sim.settle();
        expect(r.stable).toBe(true);
        expect(r.issues).toEqual([]);

        pipe.pop();
        pipe.unshift(bit);
        expect(Array.from({ length: 8 }, (_, i) => sim.read(`Q${i}`)), `init=${initial} cycle=${cycle}`).toEqual(pipe);

        // Falling edge must not shift
        sim.set("CLK", 0);
        sim.settle();
        expect(Array.from({ length: 8 }, (_, i) => sim.read(`Q${i}`)), `fall init=${initial} cycle=${cycle}`).toEqual(pipe);
      }
    }
  });

  it("8-stage one-hot ring of d-ffs rotates a single 1 cleanly on a shared clock", () => {
    const parts: PartSpec[] = [
      ["CLK", "clock"],
      ["INIT", "input-pin"],
      ["F0", "d-ff", { asyncSet: "active-high" }],
      ["Q0", "output-pin"],
    ];
    const clkNet = ["CLK.clk", "F0.clk"];
    const initNet = ["INIT.out", "F0.set"];
    for (let i = 1; i < 8; i++) {
      parts.push([`F${i}`, "d-ff", { asyncReset: "active-high" }], [`Q${i}`, "output-pin"]);
      clkNet.push(`F${i}.clk`);
      initNet.push(`F${i}.rst`);
    }
    const nets: string[][] = [clkNet, initNet];
    for (let i = 0; i < 8; i++) {
      nets.push([`F${i}.q`, `F${(i + 1) % 8}.d`, `Q${i}.in`]);
    }

    const sim = new Simulator(extractCircuit(mk(parts, nets)));
    sim.set("CLK", 0);
    sim.set("INIT", 1);
    sim.settle();
    sim.set("INIT", 0);
    sim.settle();

    const readRing = () => Array.from({ length: 8 }, (_, i) => sim.read(`Q${i}`));
    expect(readRing()).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);

    for (let step = 1; step <= 24; step++) {
      sim.set("CLK", 1);
      expect(sim.settle().stable).toBe(true);
      sim.set("CLK", 0);
      expect(sim.settle().stable).toBe(true);
      const expected = Array.from({ length: 8 }, (_, i) => (i === step % 8 ? 1 : 0));
      expect(readRing(), `ring step=${step}`).toEqual(expected);
    }
  });

  it("4-stage Johnson ring (F3.qn -> F0.d) cycles through all 8 twisted-ring states", () => {
    const parts: PartSpec[] = [["CLK", "clock"]];
    const clkNet = ["CLK.clk"];
    for (let i = 0; i < 4; i++) {
      parts.push([`F${i}`, "d-ff"], [`Q${i}`, "output-pin"]);
      clkNet.push(`F${i}.clk`);
    }
    const nets: string[][] = [
      clkNet,
      ["F3.qn", "F0.d"],
      ["F0.q", "F1.d", "Q0.in"],
      ["F1.q", "F2.d", "Q1.in"],
      ["F2.q", "F3.d", "Q2.in"],
      ["F3.q", "Q3.in"],
    ];

    const sim = new Simulator(extractCircuit(mk(parts, nets)), { initial: "zero" });
    sim.set("CLK", 0);
    sim.settle();

    const expectedSeq = [
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 1, 0, 0],
      [1, 1, 1, 0],
      [1, 1, 1, 1],
      [0, 1, 1, 1],
      [0, 0, 1, 1],
      [0, 0, 0, 1],
    ];
    const readState = () => [sim.read("Q0"), sim.read("Q1"), sim.read("Q2"), sim.read("Q3")];
    expect(readState()).toEqual(expectedSeq[0]);

    for (let step = 1; step <= 24; step++) {
      sim.set("CLK", 1);
      sim.settle();
      sim.set("CLK", 0);
      sim.settle();
      expect(readState(), `johnson step=${step}`).toEqual(expectedSeq[step % 8]);
    }
  });

  it("4-bit ripple counter (rising-edge via Qn -> next CLK, and falling-edge via Q -> next CLK) counts 0..15..0", () => {
    for (const mode of ["rising-qn", "falling-q"] as const) {
      const edge = mode === "rising-qn" ? "rising" : "falling";
      const parts: PartSpec[] = [
        ["CLK", "clock"],
        ["RST", "input-pin"],
      ];
      const rstNet = ["RST.out"];
      const nets: string[][] = [];
      for (let i = 0; i < 4; i++) {
        parts.push([`F${i}`, "d-ff", { edge, asyncReset: "active-high" }], [`Q${i}`, "output-pin"]);
        rstNet.push(`F${i}.rst`);
      }
      nets.push(rstNet);
      nets.push(["CLK.clk", "F0.clk"]);
      for (let i = 0; i < 4; i++) {
        if (mode === "rising-qn") {
          const qnNet = [`F${i}.qn`, `F${i}.d`];
          if (i < 3) qnNet.push(`F${i + 1}.clk`);
          nets.push(qnNet);
          nets.push([`F${i}.q`, `Q${i}.in`]);
        } else {
          nets.push([`F${i}.qn`, `F${i}.d`]);
          const qNet = [`F${i}.q`, `Q${i}.in`];
          if (i < 3) qNet.push(`F${i + 1}.clk`);
          nets.push(qNet);
        }
      }

      const sim = new Simulator(extractCircuit(mk(parts, nets)));
      const idleClk: 0 | 1 = edge === "rising" ? 0 : 1;
      const activeClk: 0 | 1 = (1 - idleClk) as 0 | 1;

      sim.set("CLK", idleClk);
      sim.set("RST", 1);
      sim.settle();
      sim.set("RST", 0);
      sim.settle();

      const readVal = () => {
        let v = 0;
        for (let i = 0; i < 4; i++) {
          const b = sim.read(`Q${i}`);
          expect(b).not.toBe(null);
          v |= (b as number) << i;
        }
        return v;
      };
      expect(readVal(), `${mode} init`).toBe(0);

      for (let count = 1; count <= 32; count++) {
        sim.set("CLK", activeClk);
        const r1 = sim.settle();
        expect(r1.stable).toBe(true);
        expect(r1.issues).toEqual([]);
        expect(readVal(), `${mode} count=${count}`).toBe(count % 16);

        sim.set("CLK", idleClk);
        const r2 = sim.settle();
        expect(r2.stable).toBe(true);
        expect(readVal(), `${mode} idle count=${count}`).toBe(count % 16);
      }
    }
  });

  it("BUG-SEQ-2: rising-edge ripple counter with initial:'zero' corrupts downstream stages to X on first settle", () => {
    const parts: PartSpec[] = [["CLK", "clock"]];
    const nets: string[][] = [["CLK.clk", "F0.clk"]];
    for (let i = 0; i < 4; i++) {
      parts.push([`F${i}`, "d-ff"], [`Q${i}`, "output-pin"]);
      const qnNet = [`F${i}.qn`, `F${i}.d`];
      if (i < 3) qnNet.push(`F${i + 1}.clk`);
      nets.push(qnNet);
      nets.push([`F${i}.q`, `Q${i}.in`]);
    }
    const sim = new Simulator(extractCircuit(mk(parts, nets)), { initial: "zero" });
    sim.set("CLK", 0);
    sim.settle();
    expect([sim.read("Q0"), sim.read("Q1"), sim.read("Q2"), sim.read("Q3")]).toEqual([0, 0, 0, 0]);
  });
});

// =================================================================================================
// 5. Tri-state buses (tristate buffers, pull-up/pull-down, bus-transceiver)
// =================================================================================================

describe("5. tri-state buses (tristate, pull-up/pull-down, bus-transceiver)", () => {
  interface BusResolution {
    bits: Bit[];
    contention: boolean;
    floating: boolean;
  }

  /** Reference per-bit bus resolver matching hardware/tri-state rules. */
  function resolveBus(
    width: number,
    strongDrives: readonly (readonly Bit[])[],
    weakPulls: readonly (readonly Bit[])[],
    isRead: boolean,
  ): BusResolution {
    const bits: Bit[] = [];
    let contention = false;
    let floating = false;
    for (let b = 0; b < width; b++) {
      let sv: Bit | -1 = -1;
      for (const drv of strongDrives) {
        const v = drv[b];
        if (v === BZ) continue;
        if (sv === -1) sv = v;
        else if (sv !== v) {
          contention = true;
          sv = BX;
        }
      }
      if (sv !== -1) {
        bits.push(sv);
        continue;
      }
      let wv: Bit | -1 = -1;
      for (const pull of weakPulls) {
        const v = pull[b];
        if (v === BZ) continue;
        if (wv === -1) wv = v;
        else if (wv !== v) wv = BX;
      }
      if (wv !== -1) {
        bits.push(wv);
        continue;
      }
      bits.push(BZ);
      if (isRead) floating = true;
    }
    return { bits, contention, floating };
  }

  it("resolves 1-bit bus with 4 tristate buffers (all activeLowEnable x invertedOut combos) and pull options", () => {
    const rng = makeRng(0x505001);
    const triSpecs = [
      { activeLowEnable: false, invertedOut: false },
      { activeLowEnable: true, invertedOut: false },
      { activeLowEnable: false, invertedOut: true },
      { activeLowEnable: true, invertedOut: true },
    ];

    for (const pullMode of ["none", "up", "down", "both"] as const) {
      const parts: PartSpec[] = [["Y", "output-pin"]];
      const busNet = ["Y.in"];
      const nets: string[][] = [];
      triSpecs.forEach((sp, i) => {
        parts.push([`D${i}`, "input-pin"], [`E${i}`, "input-pin"], [`T${i}`, "tristate", sp]);
        nets.push([`D${i}.out`, `T${i}.in`], [`E${i}.out`, `T${i}.en`]);
        busNet.push(`T${i}.out`);
      });
      if (pullMode === "up" || pullMode === "both") {
        parts.push(["PU", "pull-up"]);
        busNet.push("PU.out");
      }
      if (pullMode === "down" || pullMode === "both") {
        parts.push(["PD", "pull-down"]);
        busNet.push("PD.out");
      }
      nets.push(busNet);

      const sim = new Simulator(extractCircuit(mk(parts, nets)));
      const weakPulls: Bit[][] = [];
      if (pullMode === "up" || pullMode === "both") weakPulls.push([B1]);
      if (pullMode === "down" || pullMode === "both") weakPulls.push([B0]);

      for (let step = 0; step < 80; step++) {
        const strongDrives: Bit[][] = [];
        triSpecs.forEach((sp, i) => {
          const d = randBit(rng);
          // Bias enables off often enough to test 0, 1, and >=2 active drivers
          const wantOn = rng() < 0.35;
          const e: 0 | 1 = sp.activeLowEnable ? (wantOn ? 0 : 1) : wantOn ? 1 : 0;
          sim.set(`D${i}`, d);
          sim.set(`E${i}`, e);
          if (wantOn) strongDrives.push([(sp.invertedOut ? 1 - d : d) as Bit]);
        });

        const res = sim.settle();
        expect(res.stable).toBe(true);
        const ref = resolveBus(1, strongDrives, weakPulls, true);
        const tag = `1-bit tri pull=${pullMode} step=${step}`;
        expect(sim.pinBits("Y", "in"), tag).toEqual(ref.bits);
        expect(sim.read("Y"), tag).toBe(refBitsToNum(ref.bits));
        expect(issueKinds(res.issues).includes("contention"), `${tag} contention`).toBe(ref.contention);
        expect(issueKinds(res.issues).includes("floating"), `${tag} floating`).toBe(ref.floating);
      }
    }
  });

  it("resolves 4-bit bus with 3 tristate buffers (mixed polarity/inversion) and optional per-bit pulls via splitter", () => {
    const rng = makeRng(0x505002);
    const width = 4;
    const triSpecs = [
      { width, activeLowEnable: false, invertedOut: false },
      { width, activeLowEnable: true, invertedOut: false },
      { width, activeLowEnable: false, invertedOut: true },
    ];

    for (const pullMode of ["none", "up", "down"] as const) {
      const parts: PartSpec[] = [["Y", "output-pin", { width }]];
      const busNet = ["Y.in"];
      const nets: string[][] = [];
      triSpecs.forEach((sp, i) => {
        parts.push([`D${i}`, "input-pin", { width }], [`E${i}`, "input-pin"], [`T${i}`, "tristate", sp]);
        nets.push([`D${i}.out`, `T${i}.in`], [`E${i}.out`, `T${i}.en`]);
        busNet.push(`T${i}.out`);
      });
      if (pullMode !== "none") {
        parts.push(["SP", "splitter", { width, fanOut: width }]);
        busNet.push("SP.bus");
        for (let b = 0; b < width; b++) {
          const pt = pullMode === "up" ? "pull-up" : "pull-down";
          parts.push([`P${b}`, pt]);
          nets.push([`P${b}.out`, `SP.b${b}`]);
        }
      }
      nets.push(busNet);

      const sim = new Simulator(extractCircuit(mk(parts, nets)));
      const weakPulls: Bit[][] =
        pullMode === "up"
          ? [new Array<Bit>(width).fill(B1)]
          : pullMode === "down"
            ? [new Array<Bit>(width).fill(B0)]
            : [];

      for (let step = 0; step < 80; step++) {
        const strongDrives: Bit[][] = [];
        triSpecs.forEach((sp, i) => {
          const d = randInt(rng, 1 << width);
          const wantOn = rng() < 0.4;
          const e: 0 | 1 = sp.activeLowEnable ? (wantOn ? 0 : 1) : wantOn ? 1 : 0;
          sim.set(`D${i}`, d);
          sim.set(`E${i}`, e);
          if (wantOn) {
            const outVal = sp.invertedOut ? (~d) & ((1 << width) - 1) : d;
            strongDrives.push(numToRefBits(outVal, width));
          }
        });

        const res = sim.settle();
        expect(res.stable).toBe(true);
        const ref = resolveBus(width, strongDrives, weakPulls, true);
        const tag = `4-bit tri pull=${pullMode} step=${step}`;
        expect(sim.pinBits("Y", "in"), tag).toEqual(ref.bits);
        expect(sim.read("Y"), tag).toBe(refBitsToNum(ref.bits));
        expect(issueKinds(res.issues).includes("contention"), `${tag} contention`).toBe(ref.contention);
        expect(issueKinds(res.issues).includes("floating"), `${tag} floating`).toBe(ref.floating);
      }
    }
  });

  it("resolves two 4-bit buses bridged by a bus-transceiver under random enable/dir/oe patterns", () => {
    const rng = makeRng(0x505003);
    const width = 4;

    for (const withPulls of [false, true]) {
      const parts: PartSpec[] = [
        ["DA0", "input-pin", { width }],
        ["EA0", "input-pin"],
        ["TA0", "tristate", { width }],
        ["DA1", "input-pin", { width }],
        ["EA1", "input-pin"],
        ["TA1", "tristate", { width, activeLowEnable: true }],
        ["DB0", "input-pin", { width }],
        ["EB0", "input-pin"],
        ["TB0", "tristate", { width }],
        ["DB1", "input-pin", { width }],
        ["EB1", "input-pin"],
        ["TB1", "tristate", { width, invertedOut: true }],
        ["OE", "input-pin"],
        ["DIR", "input-pin"],
        ["XCVR", "bus-transceiver", { width }],
        ["YA", "output-pin", { width }],
        ["YB", "output-pin", { width }],
      ];
      const busA = ["TA0.out", "TA1.out", "XCVR.a", "YA.in"];
      const busB = ["TB0.out", "TB1.out", "XCVR.b", "YB.in"];
      const nets: string[][] = [
        ["DA0.out", "TA0.in"],
        ["EA0.out", "TA0.en"],
        ["DA1.out", "TA1.in"],
        ["EA1.out", "TA1.en"],
        ["DB0.out", "TB0.in"],
        ["EB0.out", "TB0.en"],
        ["DB1.out", "TB1.in"],
        ["EB1.out", "TB1.en"],
        ["OE.out", "XCVR.oe"],
        ["DIR.out", "XCVR.dir"],
      ];
      if (withPulls) {
        parts.push(["SPA", "splitter", { width, fanOut: width }], ["SPB", "splitter", { width, fanOut: width }]);
        busA.push("SPA.bus");
        busB.push("SPB.bus");
        for (let b = 0; b < width; b++) {
          parts.push([`PUA${b}`, "pull-up"], [`PDB${b}`, "pull-down"]);
          nets.push([`PUA${b}.out`, `SPA.b${b}`], [`PDB${b}.out`, `SPB.b${b}`]);
        }
      }
      nets.push(busA, busB);

      const sim = new Simulator(extractCircuit(mk(parts, nets)));
      const pullsA: Bit[][] = withPulls ? [new Array<Bit>(width).fill(B1)] : [];
      const pullsB: Bit[][] = withPulls ? [new Array<Bit>(width).fill(B0)] : [];

      for (let step = 0; step < 100; step++) {
        const da0 = randInt(rng, 1 << width);
        const da1 = randInt(rng, 1 << width);
        const db0 = randInt(rng, 1 << width);
        const db1 = randInt(rng, 1 << width);
        const onA0 = rng() < 0.35;
        const onA1 = rng() < 0.35;
        const onB0 = rng() < 0.35;
        const onB1 = rng() < 0.35;
        const oeActive = rng() < 0.65;
        const oePin: 0 | 1 = oeActive ? 0 : 1; // OE is active-low
        const dir: 0 | 1 = randBit(rng);

        sim.set("DA0", da0);
        sim.set("EA0", onA0 ? 1 : 0);
        sim.set("DA1", da1);
        sim.set("EA1", onA1 ? 0 : 1); // activeLowEnable
        sim.set("DB0", db0);
        sim.set("EB0", onB0 ? 1 : 0);
        sim.set("DB1", db1);
        sim.set("EB1", onB1 ? 1 : 0);
        sim.set("OE", oePin);
        sim.set("DIR", dir);

        const res = sim.settle();
        expect(res.stable).toBe(true);

        const drivesA: Bit[][] = [];
        if (onA0) drivesA.push(numToRefBits(da0, width));
        if (onA1) drivesA.push(numToRefBits(da1, width));
        const drivesB: Bit[][] = [];
        if (onB0) drivesB.push(numToRefBits(db0, width));
        if (onB1) drivesB.push(numToRefBits((~db1) & 0xf, width));

        let refA: BusResolution;
        let refB: BusResolution;
        if (!oeActive) {
          refA = resolveBus(width, drivesA, pullsA, true);
          refB = resolveBus(width, drivesB, pullsB, true);
        } else if (dir === 1) {
          // A -> B
          refA = resolveBus(width, drivesA, pullsA, true);
          const xcvrDrive = refA.bits.map((b) => (b === BZ ? BX : b));
          refB = resolveBus(width, [...drivesB, xcvrDrive], pullsB, true);
        } else {
          // B -> A
          refB = resolveBus(width, drivesB, pullsB, true);
          const xcvrDrive = refB.bits.map((b) => (b === BZ ? BX : b));
          refA = resolveBus(width, [...drivesA, xcvrDrive], pullsA, true);
        }

        const tag = `xcvr pulls=${withPulls} oe=${oePin} dir=${dir} step=${step}`;
        expect(sim.pinBits("YA", "in"), `${tag} busA`).toEqual(refA.bits);
        expect(sim.pinBits("YB", "in"), `${tag} busB`).toEqual(refB.bits);
        expect(sim.read("YA"), `${tag} readA`).toBe(refBitsToNum(refA.bits));
        expect(sim.read("YB"), `${tag} readB`).toBe(refBitsToNum(refB.bits));
        expect(issueKinds(res.issues).includes("contention"), `${tag} contention`).toBe(refA.contention || refB.contention);
        expect(issueKinds(res.issues).includes("floating"), `${tag} floating`).toBe(refA.floating || refB.floating);
      }
    }
  });
});

// =================================================================================================
// 6. Oscillators (rings of 1, 3, 5, 101 inverters, gating & recovery)
// =================================================================================================

describe("6. oscillators (rings of 1, 3, 5, 101 inverters)", () => {
  function buildGatedRing(stages: number): SchematicDocument {
    // Stage 0 is a 2-input NAND (gated by EN); stages 1..stages-1 are NOT gates.
    const parts: PartSpec[] = [
      ["EN", "input-pin"],
      ["G0", "nand"],
      ["Y", "output-pin"],
    ];
    for (let i = 1; i < stages; i++) parts.push([`G${i}`, "not"]);
    const nets: string[][] = [["EN.out", "G0.in1"]];
    if (stages === 1) {
      nets.push(["G0.out", "G0.in0", "Y.in"]);
    } else {
      nets.push(["G0.out", "G1.in0", "Y.in"]);
      for (let i = 1; i < stages; i++) {
        nets.push([`G${i}.out`, `G${(i + 1) % stages}.in0`]);
      }
    }
    return mk(parts, nets);
  }

  function buildUngatedRing(stages: number): SchematicDocument {
    const parts: PartSpec[] = [["Y", "output-pin"]];
    for (let i = 0; i < stages; i++) parts.push([`N${i}`, "not"]);
    const nets: string[][] = [];
    for (let i = 0; i < stages; i++) {
      const net = [`N${i}.out`, `N${(i + 1) % stages}.in0`];
      if (i === 0) net.push("Y.in");
      nets.push(net);
    }
    return mk(parts, nets);
  }

  for (const stages of [1, 3, 5, 101]) {
    it(`detects oscillation quickly and recovers cleanly in a gated ${stages}-stage inverter ring`, () => {
      const sim = new Simulator(extractCircuit(buildGatedRing(stages)));
      const t0 = performance.now();

      for (let cycle = 0; cycle < 2; cycle++) {
        // Gate off: ring is broken, output settles to 1
        sim.set("EN", 0);
        const off = sim.settle();
        expect(off.stable, `stages=${stages} cycle=${cycle} off`).toBe(true);
        expect(off.issues, `stages=${stages} cycle=${cycle} off`).toEqual([]);
        expect(sim.read("Y"), `stages=${stages} cycle=${cycle} off`).toBe(1);

        // Gate on: odd ring oscillates
        sim.set("EN", 1);
        const osc = sim.settle();
        expect(osc.stable, `stages=${stages} cycle=${cycle} on`).toBe(false);
        expect(issueKinds(osc.issues), `stages=${stages} cycle=${cycle} on`).toContain("oscillation");
        expect(sim.read("Y"), `stages=${stages} cycle=${cycle} on`).toBe(null);

        // Break the ring again: must recover cleanly
        sim.set("EN", 0);
        const rec = sim.settle();
        expect(rec.stable, `stages=${stages} cycle=${cycle} rec`).toBe(true);
        expect(rec.issues, `stages=${stages} cycle=${cycle} rec`).toEqual([]);
        expect(sim.read("Y"), `stages=${stages} cycle=${cycle} rec`).toBe(1);
      }

      expect(performance.now() - t0).toBeLessThan(2000);
    });
  }

  for (const stages of [1, 3, 5, 101]) {
    it(`BUG-SEQ-4: ungated ring of ${stages} inverter(s) must report stable:false and oscillation`, () => {
      const sim = new Simulator(extractCircuit(buildUngatedRing(stages)));
      const res = sim.settle();
      expect(res.stable).toBe(false);
      expect(issueKinds(res.issues)).toContain("oscillation");
    });
  }

  it("BUG-SEQ-5: checkCircuit misses combinational feedback loop on a 1-inverter self-loop", () => {
    const c = extractCircuit(buildUngatedRing(1));
    const issues = checkCircuit(c);
    expect(issueKinds(issues)).toContain("feedback");
  });
});

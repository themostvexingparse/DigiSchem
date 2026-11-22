import { describe, expect, it } from "vitest";
import { bench } from "./helpers/sim-harness";
import { DEBOUNCE_SAMPLES } from "../src/logic/models-seq";
import { extractCircuit } from "../src/logic/circuit";
import { Simulator } from "../src/logic/simulate";

let seed = 12345;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const mask = (w: number) => (w >= 32 ? 0xffffffff : (1 << w) - 1);

describe("shift registers and counters", () => {
  it("shift register: right, left, load, reset", () => {
    const b = bench("shift-register", { width: 4, direction: "right", parallelLoad: true, reset: true });
    b.set("rst", 1);
    b.tick();
    expect(b.get("q")).toBe(0);
    b.set("rst", 0);
    b.set("sin", 1);
    b.tick();
    expect(b.get("q")).toBe(0b1000); // enters at the top, moves toward bit 0
    b.set("sin", 0);
    b.tick();
    expect(b.get("q")).toBe(0b0100);
    b.set("d", 0b1011);
    b.set("load", 1);
    b.tick();
    expect(b.get("q")).toBe(0b1011);
    expect(b.get("sout")).toBe(1);
    const l = bench("shift-register", { width: 4, direction: "left", reset: false });
    l.set("sin", 1);
    l.tick();
    l.tick();
    expect(l.get("q")).toBe(null); // never reset: the top bits are still unknown
    l.tick();
    l.tick();
    expect(l.get("q")).toBe(0b1111);
  });

  it("shift register: bidirectional", () => {
    const b = bench("shift-register", { width: 4, direction: "bidirectional" });
    b.set("rst", 1);
    b.tick();
    b.set("rst", 0);
    b.set("dir", 0);
    b.set("sir", 1);
    b.tick();
    expect(b.get("q")).toBe(0b0001);
    b.set("dir", 1);
    b.set("sil", 1);
    b.tick();
    expect(b.get("q")).toBe(0b1000);
  });

  it("ring and Johnson counters", () => {
    const r = bench("ring-counter", { bits: 4 });
    r.set("rst", 1);
    r.tick();
    r.set("rst", 0);
    const q = () => [0, 1, 2, 3].reduce((s, i) => s | ((r.get(`q${i}`) ?? 9) << i), 0);
    const seen = [q()];
    for (let i = 0; i < 4; i++) {
      r.tick();
      seen.push(q());
    }
    expect(seen).toEqual([1, 2, 4, 8, 1]);
    const j = bench("ring-counter", { bits: 3, mode: "johnson" });
    j.set("rst", 1);
    j.tick();
    j.set("rst", 0);
    const jq = () => [0, 1, 2].reduce((s, i) => s | ((j.get(`q${i}`) ?? 9) << i), 0);
    const js = [jq()];
    for (let i = 0; i < 6; i++) {
      j.tick();
      js.push(jq());
    }
    expect(js).toEqual([0, 1, 3, 7, 6, 4, 0]);
  });

  it("LFSR runs through every nonzero state (maximal length)", () => {
    for (const w of [2, 3, 4, 5, 8, 10, 12]) {
      const b = bench("lfsr", { bits: w, pinMode: "bus" });
      b.set("rst", 1);
      b.tick();
      b.set("rst", 0);
      const seen = new Set<number>();
      for (let i = 0; i < (1 << w) - 1; i++) {
        const v = b.get("q")!;
        expect(v).not.toBe(0);
        seen.add(v);
        b.tick();
      }
      expect(seen.size).toBe((1 << w) - 1);
      expect(b.get("q")).toBe(1); // back to the start
    }
  });

  it("decade counter counts 0 to 9 and TC marks 9", () => {
    const b = bench("decade-counter", { pinMode: "bus" });
    b.set("en", 1);
    b.set("rst", 1);
    b.tick();
    b.set("rst", 0);
    const out: [number | null, number | null][] = [];
    for (let i = 0; i < 12; i++) {
      out.push([b.get("q"), b.get("tc")]);
      b.tick();
    }
    expect(out.map((x) => x[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
    expect(out.map((x) => x[1])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it("clock divider: period N, high for the later half", () => {
    for (const n of [2, 3, 5, 8]) {
      const b = bench("clock-divider", { divisor: n });
      b.set("rst", 1);
      b.tick();
      b.set("rst", 0);
      const outs: number[] = [];
      for (let i = 0; i < 2 * n; i++) {
        outs.push(b.get("out")!);
        b.tick();
      }
      const highs = outs.slice(0, n).filter((x) => x === 1).length;
      expect(highs).toBe(Math.floor(n / 2));
      expect(outs.slice(n)).toEqual(outs.slice(0, n));
    }
  });
});

describe("clocked helpers", () => {
  it("synchronizer delays by its stages", () => {
    const b = bench("synchronizer", { stages: 3 }, { initial: "zero" });
    b.set("d", 1);
    b.tick();
    b.tick();
    expect(b.get("q")).toBe(0);
    b.tick();
    expect(b.get("q")).toBe(1);
  });

  it("edge detector pulses for one clock", () => {
    const b = bench("edge-detector", { detect: "both" }, { initial: "zero" });
    const ps: number[] = [];
    for (const d of [0, 1, 1, 1, 0, 0]) {
      b.set("d", d);
      b.tick();
      ps.push(b.get("p")!);
    }
    expect(ps).toEqual([0, 1, 0, 0, 1, 0]);
  });

  it("debouncer ignores bounces shorter than its window", () => {
    const b = bench("debouncer", {}, { initial: "zero" });
    for (const d of [1, 0, 1, 0, 1]) {
      b.set("in", d);
      b.tick();
    }
    expect(b.get("out")).toBe(0);
    for (let i = 0; i < DEBOUNCE_SAMPLES; i++) b.tick();
    expect(b.get("out")).toBe(1);
  });
});

describe("memories", () => {
  it("RAM reads what was written, X before", () => {
    const b = bench("ram", { addressBits: 4, dataWidth: 8 });
    b.set("a", 3);
    b.settle();
    expect(b.get("rd")).toBe(null);
    b.set("wd", 0xa5);
    b.set("we", 1);
    b.tick();
    b.set("we", 0);
    b.set("a", 4);
    b.settle();
    expect(b.get("rd")).toBe(null);
    b.set("a", 3);
    b.settle();
    expect(b.get("rd")).toBe(0xa5);
  });

  it("RAM with a shared data port drives it only when reading", () => {
    const b = bench("ram", { addressBits: 2, dataWidth: 4, dataPortMode: "shared" }, { initial: "zero" });
    b.set("oe", 1);
    b.set("a", 1);
    b.set("dq", 5); // the RAM drives 0 (initial: zero) while the bench drives 5
    const r = b.settle();
    // the test bench's input pin also drives the shared bus: reading makes them fight
    expect(r.issues.map((i) => i.kind)).toContain("contention");
    b.set("oe", 0);
    expect(b.settle().issues).toEqual([]);
  });

  it("register file: register 0 reads 0, two read ports", () => {
    const b = bench("register-file", { addressBits: 3, dataWidth: 8, readPorts: 2, writePorts: 1 });
    b.set("we1", 1);
    for (const [a, v] of [[0, 99], [2, 22], [5, 55]]) {
      b.set("wa1", a);
      b.set("wd1", v);
      b.tick();
    }
    b.set("we1", 0);
    b.set("ra1", 0);
    b.set("ra2", 5);
    b.settle();
    expect([b.get("rd1"), b.get("rd2")]).toEqual([0, 55]);
    b.set("ra1", 2);
    b.settle();
    expect(b.get("rd1")).toBe(22);
  });

  it("register file with bit pins", () => {
    const b = bench("register-file", { addressBits: 2, dataWidth: 2, readPorts: 1, writePorts: 1, pinMode: "bits" });
    const setBus = (p: string, v: number, w: number) => {
      for (let i = 0; i < w; i++) b.set(`${p}_${i}`, (v >> i) & 1);
    };
    b.set("we1", 1);
    setBus("wa1", 3, 2);
    setBus("wd1", 2, 2);
    b.tick();
    setBus("ra1", 3, 2);
    b.settle();
    expect([b.get("rd1_0"), b.get("rd1_1")]).toEqual([0, 1]);
  });

  it("FIFO keeps order and flags", () => {
    const b = bench("fifo", { depth: 3, width: 8 });
    b.set("rst", 1);
    b.tick();
    b.set("rst", 0);
    expect([b.get("empty"), b.get("full")]).toEqual([1, 0]);
    b.set("wr", 1);
    for (const v of [10, 20, 30, 40]) {
      b.set("din", v);
      b.tick();
    }
    b.set("wr", 0);
    expect(b.get("full")).toBe(1);
    const got: (number | null)[] = [];
    b.set("rd", 1);
    for (let i = 0; i < 4; i++) {
      got.push(b.get("dout"));
      b.tick();
    }
    expect(got).toEqual([10, 20, 30, null]); // 40 was dropped (full); empty reads X
    expect(b.get("empty")).toBe(1);
  });

  it("stack is last in, first out", () => {
    const b = bench("stack", { depth: 4, width: 8 });
    b.set("rst", 1);
    b.tick();
    b.set("rst", 0);
    b.set("push", 1);
    for (const v of [1, 2, 3]) {
      b.set("din", v);
      b.tick();
    }
    b.set("push", 0);
    b.set("pop", 1);
    const got: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      got.push(b.get("top"));
      b.tick();
    }
    expect(got).toEqual([3, 2, 1, null]);
  });
});

describe("ALU, shifter, carry-lookahead", () => {
  it("ALU matches the textbook operation table", () => {
    for (const w of [4, 8, 32]) {
      const b = bench("alu", { width: w, opBits: 3, opPinMode: "bus" });
      const M = BigInt(mask(w));
      const s = (x: bigint) => BigInt.asIntN(w, x);
      for (let t = 0; t < 200; t++) {
        const a = BigInt(rnd(0x7fffffff)) & M, c = BigInt(rnd(0x7fffffff)) & M;
        const f = [0, 1, 2, 4, 5, 6, 7][rnd(7)];
        b.set("a", Number(a));
        b.set("b", Number(c));
        b.set("f", f);
        b.settle();
        const ref = [a & c, a | c, (a + c) & M, -1n, a & ~c & M, (a | ~c) & M, (a - c) & M, s(a) < s(c) ? 1n : 0n][f];
        expect(BigInt(b.get("y")!), `w${w} f${f} a${a} b${c}`).toBe(ref);
        expect(b.get("z")).toBe(ref === 0n ? 1 : 0);
        expect(b.get("n")).toBe(Number((ref >> BigInt(w - 1)) & 1n));
        if (f === 2) {
          expect(b.get("c")).toBe(a + c > M ? 1 : 0);
          const sum = s(a) + s(c);
          expect(b.get("v")).toBe(sum !== s(sum) ? 1 : 0);
        }
      }
    }
  });

  it("shifter modes", () => {
    const w = 8;
    for (const mode of ["lsl", "lsr", "asr", "ror", "universal"]) {
      const b = bench("shifter", { width: w, shiftBits: 3, mode });
      for (let t = 0; t < 100; t++) {
        const a = rnd(256), k = rnd(8), dir = rnd(2), ar = rnd(2);
        b.set("a", a);
        for (let i = 0; i < 3; i++) b.set(`sh${i}`, (k >> i) & 1);
        if (mode === "universal") {
          b.set("dir", dir);
          b.set("arith", ar);
        }
        b.settle();
        const signed = a >= 128 ? a - 256 : a;
        const m = mode === "universal" ? (dir === 0 ? "lsl" : ar ? "asr" : "lsr") : mode;
        const ref = m === "lsl" ? (a << k) & 255 : m === "lsr" ? a >> k : m === "asr" ? (signed >> k) & 255 : ((a >> k) | (a << (8 - k))) & 255;
        expect(b.get("y"), `${mode} a=${a} k=${k} dir=${dir} ar=${ar}`).toBe(ref);
      }
    }
  });

  it("carry-lookahead agrees with ripple carries", () => {
    const b = bench("carry-lookahead");
    for (let m = 0; m < 512; m++) {
      const p = [0, 1, 2, 3].map((i) => (m >> i) & 1), g = [0, 1, 2, 3].map((i) => (m >> (4 + i)) & 1), c0 = (m >> 8) & 1;
      p.forEach((v, i) => b.set(`p${i}`, v));
      g.forEach((v, i) => b.set(`g${i}`, v));
      b.set("c0", c0);
      b.settle();
      const c = [c0];
      for (let i = 0; i < 4; i++) c.push(g[i] | (p[i] & c[i]));
      expect([b.get("c1"), b.get("c2"), b.get("c3")]).toEqual([c[1], c[2], c[3]]);
      expect(b.get("p")).toBe(p.every(Boolean) ? 1 : 0);
      // block generate: a carry out of the block that does not depend on c0
      expect(b.get("g")).toBe(g[3] | (p[3] & (g[2] | (p[2] & (g[1] | (p[1] & g[0]))))));
    }
  });
});

describe("transistors (switch level)", () => {
  const cmos = (extra: [string, string, Record<string, unknown>?][], nets: string[][]) => {
    const parts: [string, string, Record<string, unknown>?][] = [["VDD", "vcc"], ["GND", "ground"], ...extra];
    const doc = {
      format: "digischem" as const, version: 1 as const, name: "cmos", grid: 10, wires: [], texts: [],
      components: parts.map(([id, type, props], i) => ({ id, type, x: i * 200, y: 0, rotation: 0 as const, props: (props ?? {}) as Record<string, string | number | boolean>, label: "" })),
      links: nets.flatMap((net) => net.slice(1).map((r) => [`p:${net[0].replace(".", "|")}`, `p:${r.replace(".", "|")}`] as [string, string])),
    };
    return new Simulator(extractCircuit(doc));
  };

  it("a CMOS inverter inverts", () => {
    const s = cmos(
      [["A", "input-pin"], ["P", "pmos"], ["N", "nmos"], ["Y", "output-pin"]],
      [["VDD.vcc", "P.s"], ["GND.gnd", "N.s"], ["A.out", "P.g", "N.g"], ["P.d", "N.d", "Y.in"]],
    );
    for (const a of [0, 1, 0]) {
      s.set("A", a);
      expect(s.settle().issues).toEqual([]);
      expect(s.read("Y")).toBe(1 - a);
    }
  });

  it("a CMOS NAND gate, and a short when both networks conduct", () => {
    // pull-up: two pMOS in parallel; pull-down: two nMOS in series
    const s = cmos(
      [["A", "input-pin"], ["B", "input-pin"], ["P1", "pmos"], ["P2", "pmos"], ["N1", "nmos"], ["N2", "nmos"], ["Y", "output-pin"]],
      [["VDD.vcc", "P1.s", "P2.s"], ["A.out", "P1.g", "N1.g"], ["B.out", "P2.g", "N2.g"], ["P1.d", "P2.d", "N1.d", "Y.in"], ["N1.s", "N2.d"], ["N2.s", "GND.gnd"]],
    );
    for (let m = 0; m < 4; m++) {
      s.set("A", m & 1);
      s.set("B", m >> 1);
      expect(s.settle().issues).toEqual([]);
      expect(s.read("Y")).toBe(m === 3 ? 0 : 1);
    }
    const bad = cmos(
      [["A", "input-pin"], ["P", "pmos"], ["N", "nmos"], ["Y", "output-pin"]],
      [["VDD.vcc", "P.s"], ["GND.gnd", "N.s"], ["A.out", "N.g"], ["GND.gnd", "P.g"], ["P.d", "N.d", "Y.in"]],
    );
    bad.set("A", 1); // both conduct: VDD shorted to ground
    expect(bad.settle().issues.map((i) => i.kind)).toContain("contention");
    expect(bad.read("Y")).toBe(null);
  });

  it("a transmission gate passes both ways and floats when off", () => {
    const s = cmos(
      [["D", "input-pin"], ["EN", "input-pin"], ["ENB", "input-pin"], ["T", "transmission-gate"], ["Y", "output-pin"]],
      [["D.out", "T.a"], ["EN.out", "T.en"], ["ENB.out", "T.enb"], ["T.b", "Y.in"]],
    );
    s.set("EN", 1);
    s.set("D", 1);
    s.settle();
    expect(s.read("Y")).toBe(1);
    s.set("EN", 0);
    s.set("ENB", 1);
    expect(s.settle().issues.map((i) => i.kind)).toEqual(["floating"]);
    expect(s.read("Y")).toBe(null);
  });

  it("an unknown gate on a switch makes the far side unknown", () => {
    const s = cmos([["N", "nmos"], ["Y", "output-pin"]], [["GND.gnd", "N.s"], ["N.d", "Y.in"]]);
    const r = s.settle(); // the gate is not connected: it may or may not conduct
    expect(s.read("Y")).toBe(null);
    expect(r.issues.map((i) => i.kind)).toContain("floating");
  });
});

describe("transistor circuits in the checks and truth tables", () => {
  it("a CMOS NOR gate gives its truth table and no unmodelled warning", async () => {
    const { truthTable, outputFunctions } = await import("../src/logic/analyze");
    const { checkCircuit } = await import("../src/logic/check");
    const parts: [string, string][] = [["VDD", "vcc"], ["GND", "ground"], ["A", "input-pin"], ["B", "input-pin"], ["P1", "pmos"], ["P2", "pmos"], ["N1", "nmos"], ["N2", "nmos"], ["Y", "output-pin"]];
    // pull-up: pMOS in series; pull-down: nMOS in parallel
    const nets = [["VDD.vcc", "P1.s"], ["P1.d", "P2.s"], ["P2.d", "N1.d", "N2.d", "Y.in"], ["N1.s", "N2.s", "GND.gnd"], ["A.out", "P1.g", "N1.g"], ["B.out", "P2.g", "N2.g"]];
    const doc = {
      format: "digischem" as const, version: 1 as const, name: "nor", grid: 10, wires: [], texts: [],
      components: parts.map(([id, type], i) => ({ id, type, x: i * 200, y: 0, rotation: 0 as const, props: {}, label: "" })),
      links: nets.flatMap((net) => net.slice(1).map((r) => [`p:${net[0].replace(".", "|")}`, `p:${r.replace(".", "|")}`] as [string, string])),
    };
    const c = extractCircuit(doc);
    expect(checkCircuit(c).filter((i) => i.kind === "unmodelled" || i.severity === "error")).toEqual([]);
    const [f] = outputFunctions(truthTable(c));
    expect(f.minterms).toEqual([0]);
  });
});

describe("ROM", () => {
  it("reads its contents list, with repeats, and 0 past the end", () => {
    const b = bench("rom", { addressBits: 4, dataWidth: 8, contents: "12 0x34, 0b101 0d200 3*AB" });
    const got: (number | null)[] = [];
    for (let a = 0; a < 9; a++) {
      b.set("a", a);
      b.settle();
      got.push(b.get("d"));
    }
    expect(got).toEqual([0x12, 0x34, 5, 200, 0xab, 0xab, 0xab, 0, 0]);
    const bad = bench("rom", { addressBits: 2, dataWidth: 4, contents: "zz" });
    bad.settle();
    expect(bad.get("d")).toBe(null);
  });

  it("a ROM used as a truth table gives that function", async () => {
    const { truthTable, outputFunctions } = await import("../src/logic/analyze");
    // 2-input XOR in a 4 x 1 ROM
    const b = bench("rom", { addressBits: 2, dataWidth: 1, pinMode: "bits", contents: "0 1 1 0" });
    const t = truthTable(b.sim.circuit, { inputs: ["T_a1", "T_a0"], outputs: ["T_d0"] });
    expect(outputFunctions(t)[0].minterms).toEqual([1, 2]);
  });
});

describe("transistor circuits with state", () => {
  const build = (parts: [string, string][], nets: string[][]) =>
    new Simulator(
      extractCircuit({
        format: "digischem", version: 1, name: "t", grid: 10, wires: [], texts: [],
        components: parts.map(([id, type], i) => ({ id, type, x: i * 200, y: 0, rotation: 0 as const, props: {}, label: "" })),
        links: nets.flatMap((net) => net.slice(1).map((r) => [`p:${net[0].replace(".", "|")}`, `p:${r.replace(".", "|")}`] as [string, string])),
      }),
    );
  // CMOS inverter helper nets: P(s=VDD, d=out, g=in), N(s=GND, d=out, g=in)
  const inv = (p: string, n: string, input: string, output: string) => [[`${p}.g`, `${n}.g`, input], [`${p}.d`, `${n}.d`, output]];

  it("a transmission-gate D latch: transparent while CLK = 1, holds while CLK = 0", () => {
    // D -TG1(CLK)- X ; X -> INV1 -> QN -> INV2 -> Q ; Q -TG2(CLK')- X (the feedback closes while CLK = 0)
    const parts: [string, string][] = [["VDD", "vcc"], ["GND", "ground"], ["D", "input-pin"], ["CLK", "input-pin"], ["TG1", "transmission-gate"], ["TG2", "transmission-gate"],
      ["PC", "pmos"], ["NC", "nmos"], ["P1", "pmos"], ["N1", "nmos"], ["P2", "pmos"], ["N2", "nmos"], ["Q", "output-pin"]];
    const nets = [
      ["VDD.vcc", "PC.s", "P1.s", "P2.s"], ["GND.gnd", "NC.s", "N1.s", "N2.s"],
      ["CLK.out", "PC.g", "NC.g", "TG1.en", "TG2.enb"], ["PC.d", "NC.d", "TG1.enb", "TG2.en"], // CLK' from an inverter
      ["D.out", "TG1.a"], ["TG1.b", "TG2.b", "P1.g", "N1.g"], ["P1.d", "N1.d", "P2.g", "N2.g"], ["P2.d", "N2.d", "TG2.a", "Q.in"],
    ];
    void inv;
    const s = build(parts, nets);
    s.set("CLK", 1);
    s.set("D", 1);
    s.settle();
    expect(s.read("Q")).toBe(1);
    s.set("D", 0);
    s.settle();
    expect(s.read("Q")).toBe(0); // transparent
    s.set("CLK", 0);
    s.settle();
    s.set("D", 1);
    const r = s.settle();
    expect(r.issues).toEqual([]);
    expect(s.read("Q")).toBe(0); // holds
    s.set("CLK", 1);
    s.settle();
    expect(s.read("Q")).toBe(1);
  });

  it("an SR latch from two CMOS NAND gates holds, sets and resets", () => {
    // NAND(a, b) -> y: P(a), P(b) in parallel from VDD; N(a) - N(b) in series to GND
    const nand = (k: string, a: string, b: string, y: string) => [
      [`${k}PA.g`, `${k}NA.g`, a], [`${k}PB.g`, `${k}NB.g`, b], [`${k}PA.d`, `${k}PB.d`, `${k}NA.d`, y], [`${k}NA.s`, `${k}NB.d`],
    ];
    const parts: [string, string][] = [["VDD", "vcc"], ["GND", "ground"], ["S", "input-pin"], ["R", "input-pin"], ["Q", "output-pin"], ["QN", "output-pin"]];
    for (const k of ["X", "Y"]) parts.push([`${k}PA`, "pmos"], [`${k}PB`, "pmos"], [`${k}NA`, "nmos"], [`${k}NB`, "nmos"]);
    const nets = [
      ["VDD.vcc", "XPA.s", "XPB.s", "YPA.s", "YPB.s"], ["GND.gnd", "XNB.s", "YNB.s"],
      // active-low inputs: Q = NAND(S', QN), QN = NAND(R', Q)
      ...nand("X", "S.out", "QN.in", "Q.in"), ...nand("Y", "R.out", "Q.in", "QN.in"),
    ];
    const s = build(parts, nets);
    s.set("S", 1);
    s.set("R", 1);
    s.settle();
    expect(s.read("Q")).toBe(null); // never set
    s.set("S", 0); // set (active low)
    s.settle();
    expect([s.read("Q"), s.read("QN")]).toEqual([1, 0]);
    s.set("S", 1);
    expect(s.settle().stable).toBe(true);
    expect([s.read("Q"), s.read("QN")]).toEqual([1, 0]); // holds
    s.set("R", 0);
    s.settle();
    expect([s.read("Q"), s.read("QN")]).toEqual([0, 1]);
    s.set("R", 1);
    s.settle();
    expect([s.read("Q"), s.read("QN")]).toEqual([0, 1]);
  });
});

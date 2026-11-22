import { describe, expect, it } from "vitest";
import { bench } from "./helpers/sim-harness";
import { DEBOUNCE_SAMPLES } from "../src/logic/models-seq";

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

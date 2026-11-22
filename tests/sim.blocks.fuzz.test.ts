/** Randomized tests of the larger blocks against plain JavaScript models of the documented behaviour. */
import { describe, expect, it } from "vitest";
import { bench } from "./helpers/sim-harness";
import { Rng } from "./helpers/sim-gen";

const M = (w: number) => (1n << BigInt(w)) - 1n;
const sgn = (x: bigint, w: number) => BigInt.asIntN(w, x);

/** Set a bus (one pin, or bit pins prefix0..) of the bench to a value. */
function setBus(b: ReturnType<typeof bench>, prefix: string, v: bigint, w: number, bits: boolean) {
  if (!bits) return b.set(prefix, Number(v));
  for (let i = 0; i < w; i++) b.set(`${prefix}${i}`, Number((v >> BigInt(i)) & 1n));
}
function getBus(b: ReturnType<typeof bench>, prefix: string, w: number, bits: boolean): bigint | null {
  if (!bits) {
    const x = b.get(prefix);
    return x === null ? null : BigInt(x >>> 0);
  }
  let v = 0n;
  for (let i = 0; i < w; i++) {
    const x = b.get(`${prefix}${i}`);
    if (x === null) return null;
    v |= BigInt(x) << BigInt(i);
  }
  return v;
}

describe("ALU and shifter, random widths and operations", () => {
  it("ALU (3 op bits) against BigInt arithmetic, flags included", { timeout: 60000 }, () => {
    const rng = new Rng(11);
    for (const w of [1, 3, 8, 13, 16, 31, 32]) {
      const b = bench("alu", { width: w, opBits: 3, opPinMode: "bits" });
      for (let t = 0; t < 60; t++) {
        const a = BigInt(rng.int(0, 0x7fffffff)) * BigInt(rng.int(1, 3)) & M(w);
        const c = BigInt(rng.int(0, 0x7fffffff)) * BigInt(rng.int(1, 3)) & M(w);
        const f = [0, 1, 2, 4, 5, 6, 7][rng.int(0, 6)];
        setBus(b, "a", a, w, false);
        setBus(b, "b", c, w, false);
        for (let i = 0; i < 3; i++) b.set(`f${i}`, (f >> i) & 1);
        b.settle();
        const sub = f === 6;
        const bb = sub ? ~c & M(w) : c;
        const sum = a + bb + (sub ? 1n : 0n);
        const y = [a & c, a | c, sum & M(w), -1n, a & ~c & M(w), (a | ~c) & M(w), sum & M(w), sgn(a, w) < sgn(c, w) ? 1n : 0n][f];
        const ctx = `w=${w} f=${f} a=${a} b=${c}`;
        expect(getBus(b, "y", w, false), ctx).toBe(y);
        expect(b.get("z"), ctx).toBe(y === 0n ? 1 : 0);
        expect(b.get("n"), ctx).toBe(Number((y >> BigInt(w - 1)) & 1n));
        if (f === 2 || f === 6) {
          expect(b.get("c"), ctx).toBe(Number((sum >> BigInt(w)) & 1n));
          const ov = (sgn(a, w) >= 0n) === (sgn(bb, w) >= 0n) && (sgn(y, w) >= 0n) !== (sgn(a, w) >= 0n);
          expect(b.get("v"), ctx).toBe(ov ? 1 : 0);
        } else expect([b.get("c"), b.get("v")], ctx).toEqual([0, 0]);
      }
    }
  });

  it("shifter in every mode, bus and bit pins", { timeout: 60000 }, () => {
    const rng = new Rng(12);
    for (const w of [2, 5, 8, 16, 32])
      for (const bits of [false, true])
        for (const mode of ["universal", "lsl", "lsr", "asr", "ror"]) {
          const sb = Math.max(1, Math.ceil(Math.log2(w)));
          const b = bench("shifter", { width: w, shiftBits: sb, pinMode: bits ? "bits" : "bus", mode });
          for (let t = 0; t < 25; t++) {
            const a = (BigInt(rng.int(0, 0x7fffffff)) << 1n | BigInt(rng.int(0, 1))) & M(w);
            const k = rng.int(0, 2 ** sb - 1), dir = rng.int(0, 1), ar = rng.int(0, 1);
            setBus(b, "a", a, w, bits);
            for (let i = 0; i < sb; i++) b.set(`sh${i}`, (k >> i) & 1);
            if (mode === "universal") {
              b.set("dir", dir);
              b.set("arith", ar);
            }
            b.settle();
            const m = mode === "universal" ? (dir === 0 ? "lsl" : ar ? "asr" : "lsr") : mode;
            const K = BigInt(k);
            const ref =
              m === "lsl" ? (k >= w ? 0n : (a << K) & M(w))
              : m === "lsr" ? (k >= w ? 0n : a >> K)
              : m === "asr" ? BigInt.asUintN(w, sgn(a, w) >> BigInt(Math.min(k, w - 1)))
              : ((a >> BigInt(k % w)) | (a << BigInt((w - (k % w)) % w))) & M(w);
            expect(getBus(b, "y", w, bits), `${mode} w=${w} bits=${bits} a=${a} k=${k} dir=${dir} ar=${ar}`).toBe(ref);
          }
        }
  });
});

describe("memories over random operation sequences", () => {
  it("FIFO against an array", { timeout: 60000 }, () => {
    const rng = new Rng(21);
    for (const depth of [2, 3, 5, 16]) {
      const b = bench("fifo", { depth, width: 8 });
      b.set("rst", 1);
      b.tick();
      b.set("rst", 0);
      const q: number[] = [];
      for (let t = 0; t < 300; t++) {
        const wr = rng.int(0, 1), rd = rng.int(0, 1), din = rng.int(0, 255), rst = rng.bool(0.02) ? 1 : 0;
        b.set("wr", wr);
        b.set("rd", rd);
        b.set("din", din);
        b.set("rst", rst);
        b.tick();
        if (rst) q.length = 0;
        else {
          const full = q.length >= depth, empty = q.length === 0;
          if (rd && !empty) q.shift();
          if (wr && !full) q.push(din);
        }
        const ctx = `depth=${depth} t=${t}`;
        expect(b.get("dout"), ctx).toBe(q.length ? q[0] : null);
        expect([b.get("empty"), b.get("full")], ctx).toEqual([q.length === 0 ? 1 : 0, q.length >= depth ? 1 : 0]);
      }
    }
  });

  it("stack against an array", { timeout: 60000 }, () => {
    const rng = new Rng(22);
    for (const depth of [2, 4, 9]) {
      const b = bench("stack", { depth, width: 8 });
      b.set("rst", 1);
      b.tick();
      b.set("rst", 0);
      const st: number[] = [];
      for (let t = 0; t < 300; t++) {
        const push = rng.int(0, 1), pop = rng.int(0, 1), din = rng.int(0, 255);
        b.set("push", push);
        b.set("pop", pop);
        b.set("din", din);
        b.tick();
        if (pop && st.length) st.pop();
        if (push && st.length < depth) st.push(din);
        expect(b.get("top"), `depth=${depth} t=${t}`).toBe(st.length ? st[st.length - 1] : null);
      }
    }
  });

  it("RAM, dual-port RAM and register file against a Map", { timeout: 60000 }, () => {
    const rng = new Rng(23);
    const ram = bench("ram", { addressBits: 5, dataWidth: 8 }, { initial: "zero" });
    const dp = bench("dual-port-ram", { addressBits: 5, dataWidth: 8 }, { initial: "zero" });
    const rf = bench("register-file", { addressBits: 3, dataWidth: 8, readPorts: 2, writePorts: 1 }, { initial: "zero" });
    const m1 = new Map<number, number>(), m2 = new Map<number, number>(), m3 = new Map<number, number>();
    for (let t = 0; t < 300; t++) {
      const a = rng.int(0, 31), d = rng.int(0, 255), we = rng.int(0, 1), ab = rng.int(0, 31);
      ram.set("a", a);
      ram.set("wd", d);
      ram.set("we", we);
      ram.tick();
      if (we) m1.set(a, d);
      expect(ram.get("rd"), `ram t=${t}`).toBe(m1.get(a) ?? 0);
      dp.set("addra", a);
      dp.set("dina", d);
      dp.set("wea", we);
      dp.set("addrb", ab);
      dp.tick();
      if (we) m2.set(a, d);
      expect([dp.get("douta"), dp.get("doutb")], `dual t=${t}`).toEqual([m2.get(a) ?? 0, m2.get(ab) ?? 0]);
      const wa = rng.int(0, 7), r1 = rng.int(0, 7), r2 = rng.int(0, 7);
      rf.set("wa1", wa);
      rf.set("wd1", d);
      rf.set("we1", we);
      rf.set("ra1", r1);
      rf.set("ra2", r2);
      rf.tick();
      if (we && wa !== 0) m3.set(wa, d);
      expect([rf.get("rd1"), rf.get("rd2")], `regfile t=${t}`).toEqual([r1 === 0 ? 0 : m3.get(r1) ?? 0, r2 === 0 ? 0 : m3.get(r2) ?? 0]);
    }
  });

  it("shift register against a list, all directions", { timeout: 60000 }, () => {
    const rng = new Rng(24);
    for (const direction of ["right", "left", "bidirectional"]) {
      const w = 6;
      const b = bench("shift-register", { width: w, direction, parallelLoad: true, reset: true });
      b.set("rst", 1);
      b.tick();
      b.set("rst", 0);
      let q = 0;
      for (let t = 0; t < 200; t++) {
        const load = rng.bool(0.1) ? 1 : 0, d = rng.int(0, 63), si = rng.int(0, 1), dir = rng.int(0, 1);
        b.set("load", load);
        b.set("d", d);
        if (direction === "bidirectional") {
          b.set("dir", dir);
          b.set("sil", si);
          b.set("sir", si);
        } else b.set("sin", si);
        b.tick();
        const right = direction === "right" || (direction === "bidirectional" && dir === 1);
        q = load ? d : right ? (q >> 1) | (si << (w - 1)) : ((q << 1) | si) & 63;
        expect(b.get("q"), `${direction} t=${t}`).toBe(q);
        expect(b.get("sout"), `${direction} t=${t}`).toBe(right ? q & 1 : (q >> (w - 1)) & 1);
      }
    }
  });
});

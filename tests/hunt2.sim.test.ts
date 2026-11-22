import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { extractCircuit } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { B0, B1, BX, BZ, Simulator, type Bit, type SimOptions } from "../src/logic/simulate";
import { outputFunctions, stateInCone, truthTable } from "../src/logic/analyze";
import { DEBOUNCE_SAMPLES } from "../src/logic/models-seq";
import { mkDoc, Rng, type PartSpec } from "./helpers/sim-gen";
import { bench } from "./helpers/sim-harness";

registerBuiltinComponents();

const mk = (parts: PartSpec[], nets: string[][]) => mkDoc(parts, nets, "hunt2");
const simOf = (parts: PartSpec[], nets: string[][], opts?: SimOptions) =>
  new Simulator(extractCircuit(mk(parts, nets)), opts);
const kinds = (issues: { kind: string }[]) => issues.map((i) => i.kind);

function tickPin(s: Simulator, clk = "CLK", falling = false): void {
  s.set(clk, falling ? 1 : 0);
  s.settle();
  s.set(clk, falling ? 0 : 1);
  s.settle();
  s.set(clk, falling ? 1 : 0);
  s.settle();
}

// =================================================================================================
// 1. Models in src/logic/models-seq.ts (pin ids, props, polarity, X handling, widths)
// =================================================================================================

describe("models-seq: shift-register, counters, clocked helpers", () => {
  it("shift-register: right, left, bidirectional, parallelLoad, parallelOut=false, pinMode=bits", () => {
    // Shift right without parallel output or parallel load (4-bit serial delay line)
    const sr = bench("shift-register", { width: 4, direction: "right", parallelOut: false, parallelLoad: false, reset: true });
    sr.set("rst", 1);
    sr.set("sin", 0);
    sr.tick();
    expect(sr.get("sout")).toBe(0);
    sr.set("rst", 0);
    sr.set("sin", 1);
    sr.tick(); // q = [0,0,0,1]
    expect(sr.get("sout")).toBe(0);
    sr.set("sin", 0);
    sr.tick(); // q = [0,0,1,0]
    sr.tick(); // q = [0,1,0,0]
    expect(sr.get("sout")).toBe(0);
    sr.tick(); // q = [1,0,0,0]
    expect(sr.get("sout")).toBe(1);
    sr.tick(); // q = [0,0,0,0]
    expect(sr.get("sout")).toBe(0);

    // Shift left with pinMode=bits and parallelLoad
    const sl = bench("shift-register", { width: 4, direction: "left", parallelLoad: true, parallelOut: true, pinMode: "bits", reset: false });
    sl.set("load", 1);
    sl.set("d0", 1);
    sl.set("d1", 0);
    sl.set("d2", 1);
    sl.set("d3", 0);
    sl.tick();
    expect([sl.get("q0"), sl.get("q1"), sl.get("q2"), sl.get("q3")]).toEqual([1, 0, 1, 0]);
    expect(sl.get("sout")).toBe(0); // top bit q3
    sl.set("load", 0);
    sl.set("sin", 1);
    sl.tick(); // shift left: [1, 1, 0, 1]
    expect([sl.get("q0"), sl.get("q1"), sl.get("q2"), sl.get("q3")]).toEqual([1, 1, 0, 1]);
    expect(sl.get("sout")).toBe(1);

    // Bidirectional: DIR=1 shifts right (SIL -> top), DIR=0 shifts left (SIR -> bit 0)
    const bi = bench("shift-register", { width: 4, direction: "bidirectional", parallelLoad: true, parallelOut: true, pinMode: "bus" });
    bi.set("rst", 0);
    bi.set("load", 1);
    bi.set("d", 0b0110);
    bi.tick();
    expect(bi.get("q")).toBe(0b0110);
    bi.set("load", 0);
    bi.set("dir", 1);
    bi.set("sil", 1);
    bi.set("sir", 0);
    bi.tick(); // right: 0b1011, sout = bit 0 = 1
    expect(bi.get("q")).toBe(0b1011);
    expect(bi.get("sout")).toBe(1);
    bi.set("dir", 0);
    bi.set("sir", 0);
    bi.tick(); // left: 0b0110, sout = bit 3 = 0
    expect(bi.get("q")).toBe(0b0110);
    expect(bi.get("sout")).toBe(0);

    // Unknown DIR when q[0] !== q[3] gives X on sout, but RST=1 overrides X on DIR/LOAD
    bi.sim.set("T_dir", [BX]);
    bi.sim.set("T_load", [BX]);
    bi.settle();
    expect(bi.get("sout")).toBe(0); // q[0]=0 === q[3]=0 agrees!
    bi.set("rst", 1);
    bi.tick();
    expect(bi.get("q")).toBe(0);
  });

  it("ring-counter (ring and johnson modes) and lfsr (bus/bits, falling edge, 32-bit)", () => {
    const ring = bench("ring-counter", { bits: 4, mode: "ring", enable: true });
    ring.set("rst", 1);
    ring.set("en", 0);
    ring.tick();
    expect([ring.get("q0"), ring.get("q1"), ring.get("q2"), ring.get("q3")]).toEqual([1, 0, 0, 0]);
    ring.set("rst", 0);
    ring.tick(); // disabled: holds
    expect([ring.get("q0"), ring.get("q1"), ring.get("q2"), ring.get("q3")]).toEqual([1, 0, 0, 0]);
    ring.set("en", 1);
    ring.tick();
    expect([ring.get("q0"), ring.get("q1"), ring.get("q2"), ring.get("q3")]).toEqual([0, 1, 0, 0]);
    ring.tick();
    ring.tick();
    expect([ring.get("q0"), ring.get("q1"), ring.get("q2"), ring.get("q3")]).toEqual([0, 0, 0, 1]);
    ring.tick();
    expect([ring.get("q0"), ring.get("q1"), ring.get("q2"), ring.get("q3")]).toEqual([1, 0, 0, 0]);

    const john = bench("ring-counter", { bits: 3, mode: "johnson", enable: false });
    john.set("rst", 1);
    john.tick();
    john.set("rst", 0);
    const seq: number[] = [];
    for (let i = 0; i < 6; i++) {
      seq.push((john.get("q0")! << 0) | (john.get("q1")! << 1) | (john.get("q2")! << 2));
      john.tick();
    }
    expect(seq).toEqual([0b000, 0b001, 0b011, 0b111, 0b110, 0b100]);

    // 4-bit LFSR maximal period 15 on falling edge, pinMode=bits
    const lf = bench("lfsr", { bits: 4, pinMode: "bits", enable: true, edge: "falling" });
    lf.set("rst", 1);
    lf.set("en", 1);
    lf.tick();
    lf.set("rst", 0);
    const seen = new Set<number>();
    for (let i = 0; i < 15; i++) {
      const v = lf.get("q0")! | (lf.get("q1")! << 1) | (lf.get("q2")! << 2) | (lf.get("q3")! << 3);
      seen.add(v);
      lf.tick();
    }
    expect(seen.size).toBe(15);
    expect(seen.has(0)).toBe(false);
    // Back to 1 after 15 clocks
    expect(lf.get("q0")! | (lf.get("q1")! << 1) | (lf.get("q2")! << 2) | (lf.get("q3")! << 3)).toBe(1);

    // 32-bit LFSR bus mode works without 32-bit signed overflow
    const lf32 = bench("lfsr", { bits: 32, pinMode: "bus", enable: false });
    lf32.set("rst", 1);
    lf32.tick();
    expect(lf32.get("q")).toBe(1);
    lf32.set("rst", 0);
    lf32.tick();
    expect(lf32.get("q")).toBe(3); // taps [32,22,2,1], bit0=1 => fb=1, shifted => 0b11 = 3
  });

  it("clock-divider, synchronizer, edge-detector, debouncer, decade-counter", () => {
    // Clock divider N=5: low for 3 clocks (0,1,2), high for 2 clocks (3,4)
    const div = bench("clock-divider", { divisor: 5, reset: true }, { initial: "zero" });
    div.set("rst", 0);
    div.settle();
    const out5: (number | null)[] = [div.get("out")];
    for (let i = 0; i < 6; i++) {
      div.tick();
      out5.push(div.get("out"));
    }
    expect(out5).toEqual([0, 0, 0, 1, 1, 0, 0]);

    // Synchronizer 3 stages, falling edge
    const sync = bench("synchronizer", { stages: 3, edge: "falling" }, { initial: "zero" });
    sync.set("d", 1);
    sync.tick();
    expect(sync.get("q")).toBe(0);
    sync.tick();
    expect(sync.get("q")).toBe(0);
    sync.tick();
    expect(sync.get("q")).toBe(1);

    // Edge detector: rising, falling, both
    const ed = bench("edge-detector", { detect: "both" }, { initial: "zero" });
    ed.set("d", 0);
    ed.tick();
    expect(ed.get("p")).toBe(0);
    ed.set("d", 1);
    ed.tick();
    expect(ed.get("p")).toBe(1);
    ed.tick();
    expect(ed.get("p")).toBe(0);
    ed.set("d", 0);
    ed.tick();
    expect(ed.get("p")).toBe(1);
    ed.tick();
    expect(ed.get("p")).toBe(0);

    // Debouncer: rejects bounces, accepts DEBOUNCE_SAMPLES steady samples
    const db = bench("debouncer", { edge: "falling" }, { initial: "zero" });
    db.set("in", 1);
    for (let i = 0; i < DEBOUNCE_SAMPLES - 1; i++) {
      db.tick();
      expect(db.get("out")).toBe(0);
    }
    db.set("in", 0); // bounce resets run
    db.tick();
    expect(db.get("out")).toBe(0);
    db.set("in", 1);
    for (let i = 0; i < DEBOUNCE_SAMPLES - 1; i++) {
      db.tick();
      expect(db.get("out")).toBe(0);
    }
    db.tick();
    expect(db.get("out")).toBe(1);

    // Decade counter: ld pin, pinMode=bus, falling edge, wrap 9->0, TC = (Q==9) & EN
    const dc = bench("decade-counter", { pinMode: "bus", enable: true, load: true, edge: "falling" });
    dc.set("rst", 0);
    dc.set("en", 1);
    dc.set("ld", 1);
    dc.set("d", 8);
    dc.tick();
    expect(dc.get("q")).toBe(8);
    expect(dc.get("tc")).toBe(0);
    dc.set("ld", 0);
    dc.tick();
    expect(dc.get("q")).toBe(9);
    expect(dc.get("tc")).toBe(1);
    dc.set("en", 0);
    dc.settle();
    expect(dc.get("tc")).toBe(0); // TC gated by EN
    dc.set("en", 1);
    dc.tick();
    expect(dc.get("q")).toBe(0);
    expect(dc.get("tc")).toBe(0);
  });
});

describe("models-seq: memories, register-file, fifo, stack", () => {
  it("ram separate port (16-bit address, 32-bit data, chipSelect) and shared port with tristate driver", () => {
    // 16-bit address, 32-bit data, chipSelect
    const r = bench("ram", { addressBits: 16, dataWidth: 32, dataPortMode: "separate", pinMode: "bus", chipSelect: true });
    r.set("cs", 1);
    r.set("we", 1);
    r.set("a", 0xffff);
    r.set("wd", 0xdeadbeef);
    r.tick();
    r.set("we", 0);
    r.settle();
    expect(r.get("rd")).toBe(0xdeadbeef);
    r.set("a", 0x1234);
    r.settle();
    expect(r.get("rd")).toBe(null); // unwritten reads X
    r.set("a", 0xffff);
    r.set("cs", 0);
    r.settle();
    expect(r.sim.pinBits("DUT", "rd")).toEqual(new Array(32).fill(BZ));

    // Shared bidirectional port with external tristate buffer
    const s = simOf(
      [
        ["A", "input-pin", { width: 4 }],
        ["DIN", "input-pin", { width: 4 }],
        ["DRV", "input-pin"],
        ["WE", "input-pin"],
        ["OE", "input-pin"],
        ["CS", "input-pin"],
        ["CLK", "clock"],
        ["TRI", "tristate", { width: 4 }],
        ["RAM", "ram", { addressBits: 4, dataWidth: 4, dataPortMode: "shared", pinMode: "bus", chipSelect: true }],
        ["OUT", "output-pin", { width: 4 }],
      ],
      [
        ["A.out", "RAM.a"],
        ["DIN.out", "TRI.in"],
        ["DRV.out", "TRI.en"],
        ["WE.out", "RAM.we"],
        ["OE.out", "RAM.oe"],
        ["CS.out", "RAM.cs"],
        ["CLK.clk", "RAM.clk"],
        ["TRI.out", "RAM.dq", "OUT.in"],
      ],
    );
    s.set("CS", 1);
    s.set("A", 5);
    s.set("DIN", 0b1010);
    s.set("DRV", 1);
    s.set("WE", 1);
    s.set("OE", 0);
    s.settle();
    tickPin(s);
    // Switch to read
    s.set("DRV", 0);
    s.set("WE", 0);
    s.set("OE", 1);
    expect(s.settle().issues).toEqual([]);
    expect(s.read("OUT")).toBe(0b1010);
    // Chip select low -> Z (floating)
    s.set("CS", 0);
    expect(kinds(s.settle().issues)).toContain("floating");
    expect(s.pinBits("RAM", "dq")).toEqual([BZ, BZ, BZ, BZ]);
  });

  it("dual-port-ram and register-file (bus and bits pinMode, reg 0 always 0)", () => {
    const dp = bench("dual-port-ram", { addressBits: 16, dataWidth: 32, edge: "falling" });
    dp.set("addra", 0xabcd);
    dp.set("dina", 0xcafebabe);
    dp.set("wea", 1);
    dp.tick();
    dp.set("wea", 0);
    dp.set("addrb", 0xabcd);
    dp.settle();
    expect(dp.get("douta")).toBe(0xcafebabe);
    expect(dp.get("doutb")).toBe(0xcafebabe);

    // Register file in bits mode (ra1_0 naming, 2 read ports, 2 write ports)
    const rf = bench("register-file", { addressBits: 2, dataWidth: 2, readPorts: 2, writePorts: 2, pinMode: "bits" });
    // Write reg 0 = 3 (should still read 0) and reg 2 = 3
    rf.set("we1", 1);
    rf.set("wa1_0", 0);
    rf.set("wa1_1", 0);
    rf.set("wd1_0", 1);
    rf.set("wd1_1", 1);
    rf.set("we2", 1);
    rf.set("wa2_0", 0);
    rf.set("wa2_1", 1);
    rf.set("wd2_0", 1);
    rf.set("wd2_1", 1);
    rf.tick();
    rf.set("we1", 0);
    rf.set("we2", 0);
    rf.set("ra1_0", 0);
    rf.set("ra1_1", 0); // reg 0
    rf.set("ra2_0", 0);
    rf.set("ra2_1", 1); // reg 2
    rf.settle();
    expect([rf.get("rd1_0"), rf.get("rd1_1")]).toEqual([0, 0]);
    expect([rf.get("rd2_0"), rf.get("rd2_1")]).toEqual([1, 1]);
  });

  it("fifo and stack normal operation (empty/full, simultaneous ops, falling edge)", () => {
    const f = bench("fifo", { depth: 2, width: 8, edge: "falling" });
    f.settle();
    expect(f.get("empty")).toBe(1);
    expect(f.get("full")).toBe(0);
    expect(f.get("dout")).toBe(null);
    f.set("wr", 1);
    f.set("din", 0x11);
    f.tick();
    expect(f.get("empty")).toBe(0);
    expect(f.get("dout")).toBe(0x11);
    f.set("din", 0x22);
    f.tick();
    expect(f.get("full")).toBe(1);
    // Read and write while full: rd pops oldest, wr blocked because wasFull
    f.set("rd", 1);
    f.set("din", 0x33);
    f.tick();
    expect(f.get("full")).toBe(0);
    expect(f.get("dout")).toBe(0x22);

    const stk = bench("stack", { depth: 2, width: 8 });
    stk.settle();
    expect(stk.get("empty")).toBe(1);
    stk.set("push", 1);
    stk.set("din", 0xaa);
    stk.tick();
    stk.set("din", 0xbb);
    stk.tick();
    expect(stk.get("full")).toBe(1);
    expect(stk.get("top")).toBe(0xbb);
    // Simultaneous push+pop when full replaces top
    stk.set("pop", 1);
    stk.set("din", 0xcc);
    stk.tick();
    expect(stk.get("full")).toBe(1);
    expect(stk.get("top")).toBe(0xcc);
  });

  it("BUG-HUNT2-1: fifo and stack synchronous RST=1 fails to clear when WR/RD or PUSH/POP is X", () => {
    // FIFO: assert RST=1 on a clock edge while WR is X (e.g. uninitialized FSM output)
    const f = bench("fifo", { depth: 4, width: 8 });
    f.set("wr", 1);
    f.set("din", 0x42);
    f.tick();
    expect(f.get("empty")).toBe(0);

    f.set("rst", 1);
    f.sim.set("T_wr", [BX]);
    f.set("rd", 0);
    f.tick();
    // Reset has highest priority: FIFO must be empty and known, not unsure/X
    expect(f.get("empty")).toBe(1);
    expect(f.get("full")).toBe(0);

    // Same bug in stack when PUSH is X during RST=1
    const stk = bench("stack", { depth: 4, width: 8 });
    stk.set("push", 1);
    stk.set("din", 0x99);
    stk.tick();
    stk.set("rst", 1);
    stk.sim.set("T_push", [BX]);
    stk.set("pop", 0);
    stk.tick();
    expect(stk.get("empty")).toBe(1);
    expect(stk.get("full")).toBe(0);
  });

  it("BUG-HUNT2-2: memWrite with initial='zero' corrupts unwritten 0 word to X when WE=X and WD=0", () => {
    const r = bench("ram", { addressBits: 4, dataWidth: 4, dataPortMode: "separate" }, { initial: "zero" });
    r.set("a", 3);
    r.set("wd", 0);
    r.sim.set("T_we", [BX]);
    r.tick();
    // Word 3 started at 0 (initial: "zero"); whether WE=0 (keep 0) or WE=1 (write 0), word 3 is 0
    expect(r.get("rd")).toBe(0);
  });
});

describe("models-seq: alu, shifter, carry-lookahead", () => {
  it("alu: 1-bit, 4-bit, 32-bit, opBits=1/2/3/4, bus/bits opPinMode, flags N/Z/C/V", () => {
    // 4-bit ALU, opBits=3, opPinMode=bus: test all 8 ops and signed overflow boundaries
    const alu = bench("alu", { width: 4, opBits: 3, opPinMode: "bus" });
    // 000 AND
    alu.set("a", 0b1100);
    alu.set("b", 0b1010);
    alu.set("f", 0b000);
    alu.settle();
    expect([alu.get("y"), alu.get("n"), alu.get("z"), alu.get("c"), alu.get("v")]).toEqual([0b1000, 1, 0, 0, 0]);
    // 010 ADD: 7 + 1 = 8 (-8 signed overflow, no carry)
    alu.set("a", 7);
    alu.set("b", 1);
    alu.set("f", 0b010);
    alu.settle();
    expect([alu.get("y"), alu.get("n"), alu.get("z"), alu.get("c"), alu.get("v")]).toEqual([8, 1, 0, 0, 1]);
    // 110 SUB: 0 - (-8) = 8 -> signed overflow V=1
    alu.set("a", 0);
    alu.set("b", 8);
    alu.set("f", 0b110);
    alu.settle();
    expect([alu.get("y"), alu.get("v")]).toEqual([8, 1]);
    // 110 SUB: (-8) - (-8) = 0 -> Z=1, C=1, V=0
    alu.set("a", 8);
    alu.set("b", 8);
    alu.set("f", 0b110);
    alu.settle();
    expect([alu.get("y"), alu.get("z"), alu.get("c"), alu.get("v")]).toEqual([0, 1, 1, 0]);
    // 111 SLT: -8 < 7 is 1
    alu.set("a", 8);
    alu.set("b", 7);
    alu.set("f", 0b111);
    alu.settle();
    expect(alu.get("y")).toBe(1);
    // 011 unused -> X
    alu.set("f", 0b011);
    alu.settle();
    expect(alu.get("y")).toBe(null);

    // 32-bit ALU with opBits=4 (high bit nonzero -> X)
    const alu32 = bench("alu", { width: 32, opBits: 4, opPinMode: "bus" });
    alu32.set("a", 0x80000000);
    alu32.set("b", 0x80000000);
    alu32.set("f", 0b0010); // ADD -> 0, C=1, V=1, Z=1, N=0
    alu32.settle();
    expect([alu32.get("y"), alu32.get("n"), alu32.get("z"), alu32.get("c"), alu32.get("v")]).toEqual([0, 0, 1, 1, 1]);
    alu32.set("f", 0b1010); // high bit set -> X
    alu32.settle();
    expect(alu32.get("y")).toBe(null);

    // 1-bit ALU, opBits=1
    const alu1 = bench("alu", { width: 1, opBits: 1, opPinMode: "bits" });
    alu1.set("a", 1);
    alu1.set("b", 1);
    alu1.set("f0", 0); // ADD: (-1)+(-1) = 0, C=1, V=1
    alu1.settle();
    expect([alu1.get("y"), alu1.get("c"), alu1.get("v")]).toEqual([0, 1, 1]);
  });

  it("shifter (all modes, pinMode=bits, shift >= width) and carry-lookahead (exhaustive)", () => {
    const sh = bench("shifter", { width: 8, shiftBits: 4, pinMode: "bus", mode: "universal" });
    sh.set("a", 0b10010110);
    // LSL by 2
    sh.set("dir", 0);
    sh.sim.set("T_arith", [BX]); // ignored for left shift
    sh.set("sh0", 0);
    sh.set("sh1", 1);
    sh.set("sh2", 0);
    sh.set("sh3", 0);
    sh.settle();
    expect(sh.get("y")).toBe(0b01011000);
    // ASR by 2
    sh.set("dir", 1);
    sh.set("arith", 1);
    sh.settle();
    expect(sh.get("y")).toBe(0b11100101);
    // Shift >= width (sh = 8): ASR gives all sign bits (0xff), LSR gives 0
    sh.set("sh1", 0);
    sh.set("sh3", 1);
    sh.settle();
    expect(sh.get("y")).toBe(0xff);
    sh.set("arith", 0);
    sh.settle();
    expect(sh.get("y")).toBe(0);

    const ror = bench("shifter", { width: 4, shiftBits: 2, pinMode: "bits", mode: "ror" });
    ror.set("a0", 1);
    ror.set("a1", 0);
    ror.set("a2", 1);
    ror.set("a3", 1); // 0b1101
    ror.set("sh0", 1);
    ror.set("sh1", 0); // rotate right by 1 -> 0b1110
    ror.settle();
    expect([ror.get("y0"), ror.get("y1"), ror.get("y2"), ror.get("y3")]).toEqual([0, 1, 1, 1]);

    // Carry-lookahead exhaustive over all 512 (p0..3, g0..3, c0) combinations
    const cla = bench("carry-lookahead");
    for (let m = 0; m < 512; m++) {
      const c0 = m & 1;
      cla.set("c0", c0);
      let c = c0;
      let pAll = 1;
      let gBlk = 0;
      const expC: number[] = [];
      for (let i = 0; i < 4; i++) {
        const pi = (m >> (1 + i)) & 1;
        const gi = (m >> (5 + i)) & 1;
        cla.set(`p${i}`, pi);
        cla.set(`g${i}`, gi);
        c = gi | (pi & c);
        expC.push(c);
        gBlk = gi | (pi & gBlk);
        pAll &= pi;
      }
      cla.settle();
      expect([cla.get("c1"), cla.get("c2"), cla.get("c3"), cla.get("p"), cla.get("g")]).toEqual([
        expC[0],
        expC[1],
        expC[2],
        pAll,
        gBlk,
      ]);
    }
  });
});

// =================================================================================================
// 2. Switch-level transistors in src/logic/simulate.ts
// =================================================================================================

describe("switch-level transistors", () => {
  it("CMOS NAND, CMOS NOR, CMOS AOI21, and transmission-gate 2:1 mux match truth tables", () => {
    // 2-input CMOS NAND
    const nand = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["PA", "pmos"],
        ["PB", "pmos"],
        ["NA", "nmos"],
        ["NB", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["A.out", "PA.g", "NA.g"],
        ["B.out", "PB.g", "NB.g"],
        ["VDD.vcc", "PA.s", "PB.s"],
        ["PA.d", "PB.d", "NA.d", "Y.in"],
        ["NA.s", "NB.d"],
        ["NB.s", "GND.gnd"],
      ],
    );
    const tNand = truthTable(extractCircuit(nand));
    expect(tNand.rows.map((r) => r[0])).toEqual([B1, B1, B1, B0]);

    // 2-input CMOS NOR
    const nor = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["PA", "pmos"],
        ["PB", "pmos"],
        ["NA", "nmos"],
        ["NB", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["A.out", "PA.g", "NA.g"],
        ["B.out", "PB.g", "NB.g"],
        ["VDD.vcc", "PA.s"],
        ["PA.d", "PB.s"],
        ["PB.d", "NA.d", "NB.d", "Y.in"],
        ["NA.s", "NB.s", "GND.gnd"],
      ],
    );
    const tNor = truthTable(extractCircuit(nor));
    expect(tNor.rows.map((r) => r[0])).toEqual([B1, B0, B0, B0]);

    // CMOS AOI21: Y = (A*B + C)'
    const aoi = mk(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["C", "input-pin"],
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["PA", "pmos"],
        ["PB", "pmos"],
        ["PC", "pmos"],
        ["NA", "nmos"],
        ["NB", "nmos"],
        ["NC", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["A.out", "PA.g", "NA.g"],
        ["B.out", "PB.g", "NB.g"],
        ["C.out", "PC.g", "NC.g"],
        ["VDD.vcc", "PA.s", "PB.s"],
        ["PA.d", "PB.d", "PC.s"],
        ["PC.d", "NA.d", "NC.d", "Y.in"],
        ["NA.s", "NB.d"],
        ["NB.s", "NC.s", "GND.gnd"],
      ],
    );
    const tAoi = truthTable(extractCircuit(aoi));
    for (let m = 0; m < 8; m++) {
      const c = m & 1, b = (m >> 1) & 1, a = (m >> 2) & 1;
      expect(tAoi.rows[m][0]).toBe((a & b) | c ? B0 : B1);
    }

    // Transmission-gate 2:1 mux
    const mux = mk(
      [
        ["S", "input-pin"],
        ["D0", "input-pin"],
        ["D1", "input-pin"],
        ["INV", "not"],
        ["TG0", "transmission-gate"],
        ["TG1", "transmission-gate"],
        ["Y", "output-pin"],
      ],
      [
        ["S.out", "INV.in0", "TG0.enb", "TG1.en"],
        ["INV.out", "TG0.en", "TG1.enb"],
        ["D0.out", "TG0.a"],
        ["D1.out", "TG1.a"],
        ["TG0.b", "TG1.b", "Y.in"],
      ],
    );
    const tMux = truthTable(extractCircuit(mux));
    for (let m = 0; m < 8; m++) {
      const d1 = m & 1, d0 = (m >> 1) & 1, s = (m >> 2) & 1;
      expect(tMux.rows[m][0]).toBe((s ? d1 : d0) as Bit);
    }
  });

  it("switch chains, switch loops (ring of conducting switches), pull-ups, and floating switched outputs", () => {
    // Chain of 4 nMOS pass transistors + a loop back, with pull-up on Y
    const s = simOf(
      [
        ["IN", "input-pin"],
        ["EN", "input-pin"],
        ["M1", "nmos"],
        ["M2", "nmos"],
        ["M3", "nmos"],
        ["M4", "nmos"],
        ["PU", "pull-up"],
        ["Y", "output-pin"],
      ],
      [
        ["EN.out", "M1.g", "M2.g", "M3.g", "M4.g"],
        ["IN.out", "M1.d", "M4.s"],
        ["M1.s", "M2.d"],
        ["M2.s", "M3.d"],
        ["M3.s", "M4.d", "PU.out", "Y.in"],
      ],
    );
    s.set("IN", 0);
    s.set("EN", 0);
    expect(s.settle().issues).toEqual([]);
    expect(s.read("Y")).toBe(1); // pull-up wins when switches are off
    s.set("EN", 1);
    expect(s.settle().issues).toEqual([]);
    expect(s.read("Y")).toBe(0); // strong 0 through switch ring beats pull-up
    s.set("IN", 1);
    expect(s.settle().issues).toEqual([]);
    expect(s.read("Y")).toBe(1);

    // Floating output when switch is off and no pull resistor
    const fl = simOf(
      [["IN", "input-pin"], ["EN", "input-pin"], ["M", "nmos"], ["Y", "output-pin"]],
      [["IN.out", "M.d"], ["EN.out", "M.g"], ["M.s", "Y.in"]],
    );
    fl.set("IN", 1);
    fl.set("EN", 0);
    expect(kinds(fl.settle().issues)).toEqual(["floating"]);
    expect(fl.pinBits("Y", "in")).toEqual([BZ]);
    fl.set("EN", 1);
    expect(fl.settle().issues).toEqual([]);
    expect(fl.read("Y")).toBe(1);
  });

  it("transmission-gate D-latch holds state when CLK goes 1->0", () => {
    const s = simOf(
      [
        ["D", "input-pin"],
        ["CLK", "input-pin"],
        ["CINV", "not"],
        ["TG1", "transmission-gate"],
        ["TG2", "transmission-gate"],
        ["I1", "not"],
        ["I2", "not"],
        ["Q", "output-pin"],
      ],
      [
        ["CLK.out", "CINV.in0", "TG1.en", "TG2.enb"],
        ["CINV.out", "TG1.enb", "TG2.en"],
        ["D.out", "TG1.a"],
        ["TG1.b", "TG2.b", "I1.in0"],
        ["I1.out", "I2.in0"],
        ["I2.out", "TG2.a", "Q.in"],
      ],
    );
    s.set("CLK", 1);
    s.set("D", 1);
    expect(s.settle().stable).toBe(true);
    expect(s.read("Q")).toBe(1);
    s.set("CLK", 0);
    expect(s.settle().stable).toBe(true);
    s.set("D", 0);
    expect(s.settle().stable).toBe(true);
    expect(s.read("Q")).toBe(1); // held!
    s.set("CLK", 1);
    s.settle();
    expect(s.read("Q")).toBe(0);
  });

  it("BUG-HUNT2-3: resolve() misses multi-hop unsure switches (2 series nMOS with X gates)", () => {
    // Open-drain 2-input NAND: pull-up on Y, two series nMOS to GND
    // A=1, B=1 => Y=0; A=0, B=0 => Y=1; therefore A=X, B=X => Y must be X, NOT 1!
    const s = simOf(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["PU", "pull-up"],
        ["NA", "nmos"],
        ["NB", "nmos"],
        ["GND", "ground"],
        ["Y", "output-pin"],
      ],
      [
        ["A.out", "NA.g"],
        ["B.out", "NB.g"],
        ["PU.out", "NA.d", "Y.in"],
        ["NA.s", "NB.d"],
        ["NB.s", "GND.gnd"],
      ],
    );
    // First settle with known 0,0 so switches transition B0 -> BX (independent of BUG-HUNT2-6)
    s.set("A", 0);
    s.set("B", 0);
    s.settle();
    expect(s.read("Y")).toBe(1);
    s.set("A", 1);
    s.set("B", 1);
    s.settle();
    expect(s.read("Y")).toBe(0);

    // Now set both gates to X: both switches are in this.unsure, yet resolve() only checks 1 hop
    s.set("A", [BX]);
    s.set("B", [BX]);
    s.settle();
    expect(s.pinBits("Y", "in")).toEqual([BX]);
  });

  it("BUG-HUNT2-4: unsure switch between GND and pull-up corrupts GND to X and falsely reports contention", () => {
    // Textbook open-drain nMOS inverter with pull-up resistor:
    // For G=0: GND=0, Y=1 (no contention). For G=1: GND=0, Y=0 (no contention).
    // For G=X: GND MUST remain 0, and there MUST be NO contention!
    const s = simOf(
      [
        ["G", "input-pin"],
        ["PU", "pull-up"],
        ["M", "nmos"],
        ["GND", "ground"],
        ["Y", "output-pin"],
        ["GMON", "output-pin"],
      ],
      [
        ["G.out", "M.g"],
        ["PU.out", "M.d", "Y.in"],
        ["M.s", "GND.gnd", "GMON.in"],
      ],
    );
    // First settle with known G=0 and G=1 (both clean, independent of BUG-HUNT2-6)
    s.set("G", 0);
    expect(s.settle().issues).toEqual([]);
    expect([s.read("GMON"), s.read("Y")]).toEqual([0, 1]);
    s.set("G", 1);
    expect(s.settle().issues).toEqual([]);
    expect([s.read("GMON"), s.read("Y")]).toEqual([0, 0]);

    // Now transition G -> X (triggers regroup() so M is in this.unsure)
    s.set("G", [BX]);
    const res = s.settle();
    expect(s.read("GMON")).toBe(0);
    expect(kinds(res.issues)).not.toContain("contention");
  });

  it("BUG-HUNT2-5: contention through conducting switches emits duplicate issues with missing/empty driver lists", () => {
    // VCC -- M1(nmos, G=1) -- mid -- M2(nmos, G=1) -- GND
    const s = simOf(
      [
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["M1", "nmos"],
        ["M2", "nmos"],
      ],
      [
        ["VDD.vcc", "M1.g", "M2.g", "M1.d"],
        ["M1.s", "M2.d"],
        ["M2.s", "GND.gnd"],
      ],
    );
    const res = s.settle();
    const cont = res.issues.filter((i) => i.kind === "contention");
    // Should be 1 contention issue for the single shorted switch group, listing both drivers (never empty "()")
    expect(cont).toHaveLength(1);
    expect(cont[0].message).toContain("VDD.vcc=1");
    expect(cont[0].message).toContain("GND.gnd=0");
  });
});

// =================================================================================================
// 3. Ranked settle, feedback loops, probeLoop, oscillation, forcedX recovery
// =================================================================================================

describe("ranked settle, loops, probeLoop, and sequential interactions", () => {
  it("gate-level SR latch feeding a flip-flop clock settles cleanly and clocks on 0->1", () => {
    const s = simOf(
      [
        ["S", "input-pin"],
        ["R", "input-pin"],
        ["D", "input-pin"],
        ["G1", "nor"],
        ["G2", "nor"],
        ["F", "d-ff"],
        ["Q", "output-pin"],
        ["FQ", "output-pin"],
      ],
      [
        ["R.out", "G1.in0"],
        ["G2.out", "G1.in1"],
        ["S.out", "G2.in0"],
        ["G1.out", "G2.in1", "F.clk", "Q.in"],
        ["D.out", "F.d"],
        ["F.q", "FQ.in"],
      ],
      { initial: "zero" },
    );
    // Power-up with S=0, R=0: latch is X (not oscillating), FF does not falsely clock
    s.set("D", 1);
    const r0 = s.settle();
    expect(r0.stable).toBe(true);
    expect(s.read("Q")).toBe(null);
    expect(s.read("FQ")).toBe(0);

    // Reset latch -> Q=0 (FF sees clk=0, no edge)
    s.set("R", 1);
    s.settle();
    expect(s.read("Q")).toBe(0);
    expect(s.read("FQ")).toBe(0);
    s.set("R", 0);
    s.settle();
    expect(s.read("Q")).toBe(0);

    // Set latch -> Q rises 0->1 -> FF samples D=1
    s.set("S", 1);
    s.settle();
    expect(s.read("Q")).toBe(1);
    expect(s.read("FQ")).toBe(1);
  });

  it("CMOS gated ring oscillator detects oscillation and recovers cleanly when disabled", () => {
    const s = simOf(
      [
        ["EN", "input-pin"],
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["P1", "pmos"], ["N1", "nmos"],
        ["P2", "pmos"], ["N2", "nmos"],
        ["P3A", "pmos"], ["P3B", "pmos"], ["N3A", "nmos"], ["N3B", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["VDD.vcc", "P1.s", "P2.s", "P3A.s", "P3B.s"],
        ["GND.gnd", "N1.s", "N2.s", "N3B.s"],
        ["EN.out", "P3B.g", "N3B.g"],
        // Stage 1: n3 -> n1
        ["P3A.d", "P3B.d", "N3A.d", "P1.g", "N1.g", "Y.in"],
        // Stage 2: n1 -> n2
        ["P1.d", "N1.d", "P2.g", "N2.g"],
        // Stage 3 (NAND): n2, EN -> n3
        ["P2.d", "N2.d", "P3A.g", "N3A.g"],
        ["N3A.s", "N3B.d"],
      ],
    );
    // Start disabled: stable Y=1
    s.set("EN", 0);
    expect(s.settle().stable).toBe(true);
    expect(s.read("Y")).toBe(1);

    // Enable ring: oscillates
    s.set("EN", 1);
    const rOsc = s.settle();
    expect(rOsc.stable).toBe(false);
    expect(kinds(rOsc.issues)).toContain("oscillation");
    expect(s.read("Y")).toBe(null);

    // Disable again: forcedX restored, settles cleanly back to Y=1
    s.set("EN", 0);
    const rRec = s.settle();
    expect(rRec.stable).toBe(true);
    expect(rRec.issues).toEqual([]);
    expect(s.read("Y")).toBe(1);
  });

  it("oscillation detected by probeLoop at power-up repeats on re-settle and recovers when stopped", () => {
    const s = simOf(
      [
        ["EN", "input-pin"],
        ["N1", "not"],
        ["N2", "not"],
        ["N3", "nand"],
        ["Y", "output-pin"],
      ],
      [
        ["N1.out", "N2.in0"],
        ["N2.out", "N3.in0"],
        ["EN.out", "N3.in1"],
        ["N3.out", "N1.in0", "Y.in"],
      ],
    );
    s.set("EN", 1);
    expect(s.settle().stable).toBe(false);
    // Re-settling while still oscillating must still report unstable
    expect(s.settle().stable).toBe(false);
    // Stopping it recovers cleanly
    s.set("EN", 0);
    const r = s.settle();
    expect(r.stable).toBe(true);
    expect(s.read("Y")).toBe(1);
  });

  it("BUG-HUNT2-6: switches start with on=BX without regroup(), so unknown-gate switches at power-up output Z and CMOS ring oscillators miss oscillation", () => {
    // 1) A single CMOS inverter whose input starts at X outputs Z (floating) instead of X
    const inv = simOf(
      [
        ["A", "input-pin"],
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["P", "pmos"],
        ["N", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["A.out", "P.g", "N.g"],
        ["VDD.vcc", "P.s"],
        ["P.d", "N.d", "Y.in"],
        ["N.s", "GND.gnd"],
      ],
    );
    inv.set("A", [BX]);
    const rInv = inv.settle();
    expect(inv.pinBits("Y", "in")).toEqual([BX]);
    expect(kinds(rInv.issues)).not.toContain("floating");

    // 2) A free-running 3-stage CMOS ring oscillator at power-up returns stable=true + floating instead of oscillation
    const ring = simOf(
      [
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["P1", "pmos"], ["N1", "nmos"],
        ["P2", "pmos"], ["N2", "nmos"],
        ["P3", "pmos"], ["N3", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["VDD.vcc", "P1.s", "P2.s", "P3.s"],
        ["GND.gnd", "N1.s", "N2.s", "N3.s"],
        ["P1.d", "N1.d", "P2.g", "N2.g"],
        ["P2.d", "N2.d", "P3.g", "N3.g"],
        ["P3.d", "N3.d", "P1.g", "N1.g", "Y.in"],
      ],
    );
    const rRing = ring.settle();
    expect(rRing.stable).toBe(false);
    expect(kinds(rRing.issues)).toContain("oscillation");
  });

  it("BUG-HUNT2-12: probeLoop falsely reports a bistable 2-inverter CMOS latch (SRAM cell) as oscillating", () => {
    // Two cross-coupled CMOS inverters (bistable SRAM cell) plus an unrelated switch EN->M0 so
    // regroup() runs and populates this.unsure (otherwise BUG-HUNT2-6 masks this bug by leaving
    // Q at Z so probeLoop never runs).
    const s = simOf(
      [
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["EN", "input-pin"],
        ["M0", "nmos"],
        ["P1", "pmos"], ["N1", "nmos"],
        ["P2", "pmos"], ["N2", "nmos"],
        ["Q", "output-pin"],
      ],
      [
        ["EN.out", "M0.g"],
        ["VDD.vcc", "P1.s", "P2.s", "M0.d"],
        ["GND.gnd", "N1.s", "N2.s"],
        ["P1.d", "N1.d", "P2.g", "N2.g", "Q.in"],
        ["P2.d", "N2.d", "P1.g", "N1.g"],
      ],
    );
    const r = s.settle();
    // Q is X (confirming regroup() ran and probeLoop ran), yet probeLoop falsely flags oscillation
    expect(s.pinBits("Q", "in")).toEqual([BX]);
    expect(r.stable).toBe(true);
    expect(kinds(r.issues)).not.toContain("oscillation");
  });

  it("BUG-HUNT2-13: debouncer keeps its run counter across an unknown clock edge (e=X)", () => {
    const db = bench("debouncer", {}, { initial: "zero" });
    // Feed 3 steady 1s (one short of DEBOUNCE_SAMPLES = 4)
    db.set("in", 1);
    for (let i = 0; i < DEBOUNCE_SAMPLES - 1; i++) db.tick();
    expect(db.get("out")).toBe(0);

    // Unknown clock glitch while IN=0: output becomes X and steady run must be invalidated
    db.set("in", 0);
    db.sim.set("T_clk", [BX]);
    db.settle();
    expect(db.get("out")).toBe(null);
    db.set("clk", 0);
    db.settle();

    // Only 1 clock with IN=1 after the unknown edge must NOT reach DEBOUNCE_SAMPLES=4
    db.set("in", 1);
    db.tick();
    expect(db.get("out")).toBe(null);
  });

  it("BUG-HUNT2-7: probeLoop misses oscillation in a ring closed by an externally-enabled conducting switch", () => {
    // 3-inverter ring closed by a conducting nMOS switch (G tied to VDD)
    const s = simOf(
      [
        ["VDD", "vcc"],
        ["N1", "not"],
        ["N2", "not"],
        ["N3", "not"],
        ["SW", "nmos"],
        ["Y", "output-pin"],
      ],
      [
        ["VDD.vcc", "SW.g"],
        ["N1.out", "N2.in0"],
        ["N2.out", "N3.in0"],
        ["N3.out", "SW.d", "Y.in"],
        ["SW.s", "N1.in0"],
      ],
    );
    const r = s.settle();
    expect(r.stable).toBe(false);
    expect(kinds(r.issues)).toContain("oscillation");
  });
});

// =================================================================================================
// 4. Static checks (src/logic/check.ts) and truth tables (src/logic/analyze.ts)
// =================================================================================================

describe("checkCircuit and truthTable on realistic student circuits", () => {
  it("no false positives on a gate-level 2:4 decoder, gate-level 2:1 mux, and chained decade counters", () => {
    // 2:4 decoder built from NOT + AND gates
    const dec = extractCircuit(
      mk(
        [
          ["A0", "input-pin"], ["A1", "input-pin"],
          ["NA0", "not"], ["NA1", "not"],
          ["G0", "and"], ["G1", "and"], ["G2", "and"], ["G3", "and"],
          ["Y0", "output-pin"], ["Y1", "output-pin"], ["Y2", "output-pin"], ["Y3", "output-pin"],
        ],
        [
          ["A0.out", "NA0.in0", "G1.in0", "G3.in0"],
          ["A1.out", "NA1.in0", "G2.in1", "G3.in1"],
          ["NA0.out", "G0.in0", "G2.in0"],
          ["NA1.out", "G0.in1", "G1.in1"],
          ["G0.out", "Y0.in"], ["G1.out", "Y1.in"], ["G2.out", "Y2.in"], ["G3.out", "Y3.in"],
        ],
      ),
    );
    expect(checkCircuit(dec)).toEqual([]);
    const tDec = truthTable(dec);
    expect(outputFunctions(tDec).map((f) => f.minterms)).toEqual([[0], [2], [1], [3]]);

    // 2:1 mux built from NOT + AND + OR gates
    const mux = extractCircuit(
      mk(
        [
          ["S", "input-pin"], ["D0", "input-pin"], ["D1", "input-pin"],
          ["NS", "not"], ["A0", "and"], ["A1", "and"], ["O", "or"],
          ["Y", "output-pin"],
        ],
        [
          ["S.out", "NS.in0", "A1.in0"],
          ["NS.out", "A0.in0"],
          ["D0.out", "A0.in1"],
          ["D1.out", "A1.in1"],
          ["A0.out", "O.in0"],
          ["A1.out", "O.in1"],
          ["O.out", "Y.in"],
        ],
      ),
    );
    expect(checkCircuit(mux)).toEqual([]);
    expect(outputFunctions(truthTable(mux))[0].minterms).toEqual([2, 3, 5, 7]);

    // 2-digit chained BCD decade counter (00..99)
    const cntDoc = mk(
      [
        ["CLK", "clock"],
        ["RST", "input-pin"],
        ["EN", "input-pin"],
        ["D0", "decade-counter", { pinMode: "bus", enable: true, load: false }],
        ["D1", "decade-counter", { pinMode: "bus", enable: true, load: false }],
        ["ONES", "output-pin", { width: 4 }],
        ["TENS", "output-pin", { width: 4 }],
      ],
      [
        ["CLK.clk", "D0.clk", "D1.clk"],
        ["RST.out", "D0.rst", "D1.rst"],
        ["EN.out", "D0.en"],
        ["D0.tc", "D1.en"],
        ["D0.q", "ONES.in"],
        ["D1.q", "TENS.in"],
      ],
    );
    const cntC = extractCircuit(cntDoc);
    expect(checkCircuit(cntC)).toEqual([]);
    const cs = new Simulator(cntC);
    cs.set("RST", 1);
    cs.set("EN", 1);
    tickPin(cs);
    cs.set("RST", 0);
    for (let n = 0; n < 25; n++) {
      expect(cs.read("TENS")! * 10 + cs.read("ONES")!).toBe(n);
      tickPin(cs);
    }
  });

  it("BUG-HUNT2-8: checkCircuit falsely reports possible-contention and feedback on a combinational CMOS inverter", () => {
    const c = extractCircuit(
      mk(
        [
          ["A", "input-pin"],
          ["VDD", "vcc"],
          ["GND", "ground"],
          ["P", "pmos"],
          ["N", "nmos"],
          ["Y", "output-pin"],
        ],
        [
          ["A.out", "P.g", "N.g"],
          ["VDD.vcc", "P.s"],
          ["P.d", "N.d", "Y.in"],
          ["N.s", "GND.gnd"],
        ],
      ),
    );
    // A valid textbook CMOS inverter has no contention and no feedback loop
    expect(checkCircuit(c)).toEqual([]);
  });

  it("BUG-HUNT2-9: checkCircuit misses floating-input through an undriven transistor channel", () => {
    // M.d is unconnected; nothing drives M.d or M.s, so Y.in is floating even when M conducts
    const c = extractCircuit(
      mk(
        [
          ["VDD", "vcc"],
          ["M", "nmos"],
          ["Y", "output-pin"],
        ],
        [
          ["VDD.vcc", "M.g"],
          ["M.s", "Y.in"],
        ],
      ),
    );
    expect(kinds(checkCircuit(c))).toContain("floating-input");
  });

  it("BUG-HUNT2-10: checkCircuit falsely reports multiple-drivers when two RAMs with chipSelect share an RD bus", () => {
    // Standard 2-bank memory: RAM0 and RAM1 have chipSelect=true, so RD is tri-state (Z when CS=0)
    const c = extractCircuit(
      mk(
        [
          ["A", "input-pin", { width: 4 }],
          ["WD", "input-pin", { width: 8 }],
          ["WE", "input-pin"],
          ["SEL", "input-pin"],
          ["NSEL", "not"],
          ["CLK", "clock"],
          ["RAM0", "ram", { addressBits: 4, dataWidth: 8, dataPortMode: "separate", chipSelect: true }],
          ["RAM1", "ram", { addressBits: 4, dataWidth: 8, dataPortMode: "separate", chipSelect: true }],
          ["RD", "output-pin", { width: 8 }],
        ],
        [
          ["A.out", "RAM0.a", "RAM1.a"],
          ["WD.out", "RAM0.wd", "RAM1.wd"],
          ["WE.out", "RAM0.we", "RAM1.we"],
          ["CLK.clk", "RAM0.clk", "RAM1.clk"],
          ["SEL.out", "NSEL.in0", "RAM1.cs"],
          ["NSEL.out", "RAM0.cs"],
          ["RAM0.rd", "RAM1.rd", "RD.in"],
        ],
      ),
    );
    expect(kinds(checkCircuit(c))).not.toContain("multiple-drivers");
  });

  it("BUG-HUNT2-11: stateInCone/truthTable leaks through shared GND rail via transistor inout pins", () => {
    // Subcircuit 1 (purely combinational): A -> CMOS inverter -> Y (uses VDD, GND)
    // Subcircuit 2 (unrelated stateful LED driver): CLK, D -> d-ff -> nMOS to shared GND
    const c = extractCircuit(
      mk(
        [
          ["A", "input-pin"],
          ["VDD", "vcc"],
          ["GND", "ground"],
          ["P", "pmos"],
          ["N", "nmos"],
          ["Y", "output-pin"],
          ["CLK", "clock"],
          ["D", "input-pin"],
          ["F", "d-ff"],
          ["MLED", "nmos"],
          ["PU", "pull-up"],
          ["LED", "output-pin"],
        ],
        [
          ["A.out", "P.g", "N.g"],
          ["VDD.vcc", "P.s"],
          ["P.d", "N.d", "Y.in"],
          ["N.s", "GND.gnd", "MLED.s"],
          ["CLK.clk", "F.clk"],
          ["D.out", "F.d"],
          ["F.q", "MLED.g"],
          ["MLED.d", "PU.out", "LED.in"],
        ],
      ),
    );
    const yPart = c.parts.find((p) => p.id === "Y")!;
    expect(stateInCone(c, [yPart])).toEqual([]);
    const t = truthTable(c, { inputs: ["A"], outputs: ["Y"] });
    expect(t.rows).toEqual([[B1], [B0]]);
  });

  it("seeded differential check: random 8-bit ALU and shifter vectors match independent BigInt reference", () => {
    const rng = new Rng(0x51a72026);
    const alu = bench("alu", { width: 8, opBits: 3, opPinMode: "bus" });
    const ops = [0, 1, 2, 4, 5, 6, 7];
    for (let i = 0; i < 60; i++) {
      const a = rng.int(0, 255);
      const b = rng.int(0, 255);
      const f = rng.pick(ops);
      alu.set("a", a);
      alu.set("b", b);
      alu.set("f", f);
      alu.settle();
      const sa = a >= 128 ? a - 256 : a;
      const sb = b >= 128 ? b - 256 : b;
      const expected =
        f === 0 ? a & b
        : f === 1 ? a | b
        : f === 2 ? (a + b) & 0xff
        : f === 4 ? a & (~b & 0xff)
        : f === 5 ? (a | ~b) & 0xff
        : f === 6 ? (a - b) & 0xff
        : sa < sb ? 1 : 0;
      expect(alu.get("y")).toBe(expected);
      expect(alu.get("z")).toBe(expected === 0 ? 1 : 0);
      expect(alu.get("n")).toBe((expected >> 7) & 1);
    }
  });
});

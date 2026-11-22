import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { extractCircuit, structuralKey } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { Simulator } from "../src/logic/simulate";
import { truthTable } from "../src/logic/analyze";
import { minimize } from "../src/logic/minimize";
import { sopsToSchematic } from "../src/logic/sop-schematic";
import type { SchematicDocument } from "../src/model/types";
import { generateRandomCombDag, mkDoc, Rng, type PartSpec } from "./helpers/sim-gen";
import { sprawled } from "./helpers/sprawl";

registerBuiltinComponents();

function measure<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

function buildInverterChain(n: number): SchematicDocument {
  const parts: PartSpec[] = [["IN", "input-pin", { name: "IN", width: 1 }]];
  const nets: string[][] = [];
  let prev = "IN.out";
  for (let i = 0; i < n; i++) {
    const id = `N${i}`;
    parts.push([id, "not"]);
    nets.push([prev, `${id}.in0`]);
    prev = `${id}.out`;
  }
  parts.push(["OUT", "output-pin", { name: "OUT", width: 1 }]);
  nets.push([prev, "OUT.in"]);
  return mkDoc(parts, nets, `inv_chain_${n}`);
}

function build64BitRca(): SchematicDocument {
  const parts: PartSpec[] = [
    ["A_LO", "input-pin", { name: "A_LO", width: 32 }],
    ["A_HI", "input-pin", { name: "A_HI", width: 32 }],
    ["B_LO", "input-pin", { name: "B_LO", width: 32 }],
    ["B_HI", "input-pin", { name: "B_HI", width: 32 }],
    ["CIN", "input-pin", { name: "CIN", width: 1 }],
    ["SPA_LO", "splitter", { width: 32, fanOut: 32 }],
    ["SPA_HI", "splitter", { width: 32, fanOut: 32 }],
    ["SPB_LO", "splitter", { width: 32, fanOut: 32 }],
    ["SPB_HI", "splitter", { width: 32, fanOut: 32 }],
    ["SPS_LO", "splitter", { width: 32, fanOut: 32 }],
    ["SPS_HI", "splitter", { width: 32, fanOut: 32 }],
    ["S_LO", "output-pin", { name: "S_LO", width: 32 }],
    ["S_HI", "output-pin", { name: "S_HI", width: 32 }],
    ["COUT", "output-pin", { name: "COUT", width: 1 }],
  ];
  const nets: string[][] = [
    ["A_LO.out", "SPA_LO.bus"],
    ["A_HI.out", "SPA_HI.bus"],
    ["B_LO.out", "SPB_LO.bus"],
    ["B_HI.out", "SPB_HI.bus"],
    ["SPS_LO.bus", "S_LO.in"],
    ["SPS_HI.bus", "S_HI.in"],
  ];
  for (let i = 0; i < 64; i++) {
    parts.push([`FA${i}`, "full-adder"]);
    const aPin = i < 32 ? `SPA_LO.b${i}` : `SPA_HI.b${i - 32}`;
    const bPin = i < 32 ? `SPB_LO.b${i}` : `SPB_HI.b${i - 32}`;
    const sPin = i < 32 ? `SPS_LO.b${i}` : `SPS_HI.b${i - 32}`;
    nets.push([aPin, `FA${i}.a`]);
    nets.push([bPin, `FA${i}.b`]);
    nets.push([`FA${i}.s`, sPin]);
    if (i === 0) nets.push(["CIN.out", "FA0.cin"]);
    else nets.push([`FA${i - 1}.cout`, `FA${i}.cin`]);
  }
  nets.push(["FA63.cout", "COUT.in"]);
  return mkDoc(parts, nets, "rca_64");
}

function buildHighFanout(fanout: number): SchematicDocument {
  const parts: PartSpec[] = [["IN", "input-pin", { name: "IN", width: 1 }]];
  const inNet: string[] = ["IN.out"];
  const nets: string[][] = [inNet];
  for (let i = 0; i < fanout; i++) {
    const id = `G${i}`;
    parts.push([id, "not"]);
    inNet.push(`${id}.in0`);
  }
  parts.push(["OUT", "output-pin", { name: "OUT", width: 1 }]);
  nets.push([`G${fanout - 1}.out`, "OUT.in"]);
  return mkDoc(parts, nets, `fanout_${fanout}`);
}

function buildSplitterChain(count: number, width = 32, fanOut = 4): SchematicDocument {
  const pairs = Math.floor(count / 2);
  const parts: PartSpec[] = [["IN", "input-pin", { name: "IN", width }]];
  const nets: string[][] = [];
  let prevBus = "IN.out";
  for (let i = 0; i < pairs; i++) {
    const s = `SP_S${i}`;
    const m = `SP_M${i}`;
    parts.push([s, "splitter", { width, fanOut }]);
    parts.push([m, "splitter", { width, fanOut }]);
    nets.push([prevBus, `${s}.bus`]);
    for (let k = 0; k < fanOut; k++) {
      nets.push([`${s}.b${k}`, `${m}.b${k}`]);
    }
    prevBus = `${m}.bus`;
  }
  parts.push(["OUT", "output-pin", { name: "OUT", width }]);
  nets.push([prevBus, "OUT.in"]);
  return mkDoc(parts, nets, `splitter_chain_${pairs * 2}`);
}

function buildShiftRegisterFFs(stages: number): SchematicDocument {
  const parts: PartSpec[] = [
    ["D", "input-pin", { name: "D", width: 1 }],
    ["CLK", "clock", { name: "CLK" }],
  ];
  const clkNet = ["CLK.clk"];
  const nets: string[][] = [clkNet];
  let prev = "D.out";
  for (let i = 0; i < stages; i++) {
    const id = `FF${i}`;
    parts.push([id, "d-ff", { showQBar: false }]);
    clkNet.push(`${id}.clk`);
    nets.push([prev, `${id}.d`]);
    prev = `${id}.q`;
  }
  parts.push(["Q_MID", "output-pin", { name: "Q_MID", width: 1 }]);
  parts.push(["Q_END", "output-pin", { name: "Q_END", width: 1 }]);
  nets.push([`FF${Math.min(499, stages - 1)}.q`, "Q_MID.in"]);
  nets.push([prev, "Q_END.in"]);
  return mkDoc(parts, nets, `sr_ff_${stages}`);
}

function buildCmosInverterChain(n: number, sharedRails: boolean): SchematicDocument {
  const parts: PartSpec[] = [["IN", "input-pin", { name: "IN", width: 1 }]];
  const nets: string[][] = [];
  const vddNet: string[] = [];
  const gndNet: string[] = [];
  if (sharedRails) {
    parts.push(["VDD", "vcc"], ["GND", "ground"]);
    vddNet.push("VDD.vcc");
    gndNet.push("GND.gnd");
    nets.push(vddNet, gndNet);
  }
  let prev = "IN.out";
  for (let i = 0; i < n; i++) {
    const p = `P${i}`;
    const m = `N${i}`;
    parts.push([p, "pmos"], [m, "nmos"]);
    nets.push([prev, `${p}.g`, `${m}.g`]);
    if (sharedRails) {
      vddNet.push(`${p}.s`);
      gndNet.push(`${m}.s`);
    } else {
      parts.push([`V${i}`, "vcc"], [`G${i}`, "ground"]);
      nets.push([`V${i}.vcc`, `${p}.s`]);
      nets.push([`G${i}.gnd`, `${m}.s`]);
    }
    nets.push([`${p}.d`, `${m}.d`]);
    prev = `${p}.d`;
  }
  parts.push(["OUT", "output-pin", { name: "OUT", width: 1 }]);
  nets[nets.length - 1].push("OUT.in");
  return mkDoc(parts, nets, `cmos_inv_${n}_${sharedRails ? "shared" : "split"}`);
}

function buildPassTransistorChain(n: number, kind: "nmos" | "transmission-gate" = "nmos"): SchematicDocument {
  const parts: PartSpec[] = [
    ["IN", "input-pin", { name: "IN", width: 1 }],
    ["EN", "input-pin", { name: "EN", width: 1 }],
  ];
  const enNet = ["EN.out"];
  const enbNet = ["ENB.out"];
  const nets: string[][] = [enNet];
  if (kind === "transmission-gate") {
    parts.push(["ENB", "not"]);
    enNet.push("ENB.in0");
    nets.push(enbNet);
  }
  let prev = "IN.out";
  for (let i = 0; i < n; i++) {
    const id = `M${i}`;
    parts.push([id, kind]);
    if (kind === "nmos") {
      enNet.push(`${id}.g`);
      nets.push([prev, `${id}.d`]);
      prev = `${id}.s`;
    } else {
      enNet.push(`${id}.en`);
      enbNet.push(`${id}.enb`);
      nets.push([prev, `${id}.a`]);
      prev = `${id}.b`;
    }
  }
  parts.push(["OUT", "output-pin", { name: "OUT", width: 1 }]);
  nets.push([prev, "OUT.in"]);
  return mkDoc(parts, nets, `pass_${kind}_${n}`);
}

function buildRingOscillators(count: number, gated: boolean): SchematicDocument {
  const parts: PartSpec[] = [];
  const nets: string[][] = [];
  const enNet = ["EN.out"];
  if (gated) {
    parts.push(["EN", "input-pin", { name: "EN", width: 1 }]);
    nets.push(enNet);
  }
  for (let i = 0; i < count; i++) {
    const a = `R${i}_0`, b = `R${i}_1`, c = `R${i}_2`;
    parts.push([a, "not"], [b, "not"], [c, gated ? "nand" : "not"]);
    nets.push([`${a}.out`, `${b}.in0`]);
    nets.push([`${b}.out`, `${c}.in0`]);
    nets.push([`${c}.out`, `${a}.in0`]);
    if (gated) enNet.push(`${c}.in1`);
  }
  return mkDoc(parts, nets, `rings_${count}_${gated ? "gated" : "ungated"}`);
}

function buildFeedbackLoop(length: number, gated: boolean): SchematicDocument {
  const parts: PartSpec[] = [];
  const nets: string[][] = [];
  if (gated) parts.push(["EN", "input-pin", { name: "EN", width: 1 }]);
  for (let i = 0; i < length; i++) {
    parts.push([`L${i}`, i === length - 1 && gated ? "nand" : "not"]);
  }
  for (let i = 0; i < length; i++) {
    const next = (i + 1) % length;
    nets.push([`L${i}.out`, `L${next}.in0`]);
  }
  if (gated) nets.push(["EN.out", `L${length - 1}.in1`]);
  parts.push(["OUT", "output-pin", { name: "OUT", width: 1 }]);
  nets[0].push("OUT.in");
  return mkDoc(parts, nets, `loop_${length}_${gated ? "gated" : "ungated"}`);
}

function buildManyLinksDoc(linkCount: number): SchematicDocument {
  const parts: PartSpec[] = [
    ["A", "input-pin", { name: "A", width: 1 }],
    ["Y", "output-pin", { name: "Y", width: 1 }],
  ];
  const doc = mkDoc(parts, [], `links_${linkCount}`);
  const links: [string, string][] = [];
  let prev = "p:A|out";
  for (let i = 0; i < linkCount - 1; i++) {
    const w = `w:W${i}`;
    doc.wires.push({ id: `W${i}`, points: [{ x: i * 10, y: 0 }, { x: (i + 1) * 10, y: 0 }] });
    links.push([prev, w]);
    prev = w;
  }
  links.push([prev, "p:Y|in"]);
  doc.links = links;
  return doc;
}

function build16BitDecoderLike(busInput: boolean): { doc: SchematicDocument; targetAddresses: number[] } {
  // 16 input bits -> four 4-to-16 decoders + 8 address-matching 4-input AND gates
  const parts: PartSpec[] = [];
  const nets: string[][] = [];
  if (busInput) {
    parts.push(["A", "input-pin", { name: "A", width: 16 }]);
    parts.push(["SP", "splitter", { width: 16, fanOut: 16 }]);
    nets.push(["A.out", "SP.bus"]);
  } else {
    for (let i = 0; i < 16; i++) {
      parts.push([`A${i}`, "input-pin", { name: `A${i}`, width: 1 }]);
    }
  }
  const bitPin = (i: number) => (busInput ? `SP.b${i}` : `A${i}.out`);
  for (let d = 0; d < 4; d++) {
    parts.push([`D${d}`, "decoder", { inputs: 4, enable: false }]);
    for (let b = 0; b < 4; b++) {
      nets.push([bitPin(d * 4 + b), `D${d}.a${b}`]);
    }
  }
  const targetAddresses: number[] = [];
  for (let k = 0; k < 8; k++) {
    parts.push([`M${k}`, "and", { inputs: 4 }]);
    parts.push([`Y${k}`, "output-pin", { name: `Y${k}`, width: 1 }]);
    let addr = 0;
    for (let d = 0; d < 4; d++) {
      const nib = (k + d * 3) & 15;
      addr |= nib << (d * 4);
      nets.push([`D${d}.y${nib}`, `M${k}.in${d}`]);
    }
    targetAddresses.push(addr);
    nets.push([`M${k}.out`, `Y${k}.in`]);
  }
  return { doc: mkDoc(parts, nets, `dec16_${busInput ? "bus" : "bits"}`), targetAddresses };
}

function addIsolatedProbeChain(doc: SchematicDocument): void {
  doc.components.push(
    { id: "P_IN", type: "input-pin", x: 0, y: 0, rotation: 0, props: { name: "P_IN", width: 1 }, label: "" },
    { id: "P_N1", type: "not", x: 0, y: 0, rotation: 0, props: {}, label: "" },
    { id: "P_N2", type: "not", x: 0, y: 0, rotation: 0, props: {}, label: "" },
    { id: "P_OUT", type: "output-pin", x: 0, y: 0, rotation: 0, props: { name: "P_OUT", width: 1 }, label: "" },
  );
  doc.links!.push(
    ["p:P_IN|out", "p:P_N1|in0"],
    ["p:P_N1|out", "p:P_N2|in0"],
    ["p:P_N2|out", "p:P_OUT|in"],
  );
}

describe("random DAGs scaling (1k, 10k, 50k gates)", () => {
  it("measures structuralKey, extractCircuit, checkCircuit, new Simulator, first settle, and input changes across 1k/10k/50k DAGs", { timeout: 30000 }, () => {
    const results: Record<string, number>[] = [];

    for (const n of [1000, 10000, 50000]) {
      const gen = generateRandomCombDag({ seed: 42 + n, gateCount: n, inputCount: 16, outputCount: 16, fastGatesOnly: true });
      const sk = measure(() => structuralKey(gen.doc));
      const ex = measure(() => extractCircuit(gen.doc));
      const ck = measure(() => checkCircuit(ex.value));
      const ns = measure(() => new Simulator(ex.value));
      const sim = ns.value;
      const fs = measure(() => sim.settle());

      expect(ck.value.filter((i) => i.severity === "error")).toEqual([]);
      expect(fs.value.stable).toBe(true);
      expect(fs.value.issues).toEqual([]);

      // Verify exact functional equivalence against independent reference on 1k DAG
      if (n === 1000) {
        const refRng = new Rng(1234);
        for (let t = 0; t < 10; t++) {
          const vals: Record<string, 0 | 1> = {};
          for (const id of gen.inputIds) {
            const bit = refRng.int(0, 1) as 0 | 1;
            vals[id] = bit;
            sim.set(id, bit);
          }
          sim.settle();
          const expected = gen.evaluateRef(vals);
          for (const oid of gen.outputIds) expect(sim.read(oid)).toBe(expected[oid]);
        }
      }

      // Run full 1,000 input changes on 1k and 10k; sample 25 changes on 50k (full 1,000 takes ~136s, see BUG-PERF-1)
      const rng = new Rng(100 + n);
      const steps = n === 50000 ? 25 : 1000;
      const ch = measure(() => {
        for (let i = 0; i < steps; i++) {
          const inp = gen.inputIds[i % gen.inputIds.length];
          sim.set(inp, rng.int(0, 1));
          sim.settle();
        }
      });

      results.push({
        n,
        structuralKeyMs: +sk.ms.toFixed(2),
        extractMs: +ex.ms.toFixed(2),
        checkMs: +ck.ms.toFixed(2),
        newSimMs: +ns.ms.toFixed(2),
        firstSettleMs: +fs.ms.toFixed(2),
        msPerChange: +(ch.ms / steps).toFixed(3),
        proj1000ChangesMs: +((ch.ms / steps) * 1000).toFixed(1),
      });

      // Generous bounds for the O(N)/O(N log N) build & initial-settle stages
      const scale = n / 1000;
      expect(sk.ms).toBeLessThan(200 * scale + 500);
      expect(ex.ms).toBeLessThan(500 * scale + 1000);
      expect(ck.ms).toBeLessThan(200 * scale + 500);
      expect(ns.ms).toBeLessThan(200 * scale + 500);
      expect(fs.ms).toBeLessThan(250 * scale + 500);
    }

    // 1k and 10k DAGs should finish 1,000 changes within generous bounds
    expect(results[0].proj1000ChangesMs).toBeLessThan(5000);
    expect(results[1].proj1000ChangesMs).toBeLessThan(25000);
  });

  // Benchmark only: each input of this DAG reaches about a third of its 50,000 gates, so every change
  // really re-evaluates ~16,700 gates (~40 ms per change after the BUG-PERF-1 fixes; ~136 s before).
  // The overhead itself is covered by the isolated-change test below.
  it.skip("BENCHMARK: 1,000 input changes on a 50,000-gate random DAG (large cones; about 40 s)", { timeout: 180000 }, () => {
    const gen = generateRandomCombDag({ seed: 50042, gateCount: 50000, inputCount: 16, outputCount: 16, fastGatesOnly: true });
    const sim = new Simulator(extractCircuit(gen.doc));
    sim.settle();
    const rng = new Rng(50100);
    const t = measure(() => {
      for (let i = 0; i < 1000; i++) {
        sim.set(gen.inputIds[i % gen.inputIds.length], rng.int(0, 1));
        sim.settle();
      }
    });
    expect(t.ms).toBeLessThan(15000);
  });

  it("BUG-PERF-1: settle() and set()/read() do O(N) whole-circuit work on a 2-gate change, and issues() is O(F*N) on floating inputs", { timeout: 20000, retry: 2 }, () => {
    const runSparse = (n: number) => {
      const gen = generateRandomCombDag({ seed: 7, gateCount: n, inputCount: 8, outputCount: 8, fastGatesOnly: true });
      addIsolatedProbeChain(gen.doc);
      const sim = new Simulator(extractCircuit(gen.doc));
      sim.settle();
      // Warmup
      for (let i = 0; i < 10; i++) {
        sim.set("P_IN", i & 1);
        sim.settle();
        sim.read("P_OUT");
      }
      const steps = 60;
      const t = measure(() => {
        for (let i = 0; i < steps; i++) {
          sim.set("P_IN", i & 1);
          sim.settle();
          expect(sim.read("P_OUT")).toBe(i & 1);
        }
      });
      return t.ms / steps;
    };

    const ms1k = runSparse(1000);
    const ms25k = runSparse(25000);
    // Changing an isolated 2-gate branch should be O(affected cone), not O(circuit size) (~25x slower at 25k vs 1k)
    // (per-step times are microseconds, so a small absolute floor keeps load noise out)
    expect(ms25k).toBeLessThan(Math.max(5 * ms1k, 0.5));

    // Floating-input diagnostic in issues() should be O(N), not O(F*N)
    const runFloating = (n: number) => {
      const parts: PartSpec[] = Array.from({ length: n }, (_, i) => [`G${i}`, "not"]);
      const sim = new Simulator(extractCircuit(mkDoc(parts, [], `float_${n}`)));
      return measure(() => sim.settle()).ms;
    };
    const f500 = runFloating(500);
    const f2500 = runFloating(2500);
    expect(f2500).toBeLessThan(Math.max(10 * f500, 20));
  });
});

describe("deep and wide circuits", () => {
  it("simulates a 20,000-gate inverter chain accurately and linearly", { timeout: 15000 }, () => {
    const doc = buildInverterChain(20000);
    const ex = measure(() => extractCircuit(doc));
    const ck = measure(() => checkCircuit(ex.value));
    const ns = measure(() => new Simulator(ex.value));
    const sim = ns.value;
    const fs = measure(() => sim.settle());

    expect(ck.value.filter((i) => i.severity === "error")).toEqual([]);
    expect(fs.value.stable).toBe(true);
    expect(sim.read("OUT")).toBe(0); // 20,000 is even

    const tog1 = measure(() => {
      sim.set("IN", 1);
      return sim.settle();
    });
    expect(sim.read("OUT")).toBe(1);

    const tog0 = measure(() => {
      sim.set("IN", 0);
      return sim.settle();
    });
    expect(sim.read("OUT")).toBe(0);

    expect(ex.ms).toBeLessThan(5000);
    expect(ck.ms).toBeLessThan(3000);
    expect(ns.ms).toBeLessThan(3000);
    expect(fs.ms).toBeLessThan(3000);
    expect(tog1.ms + tog0.ms).toBeLessThan(3000);
  });

  it("simulates a 64-bit ripple-carry adder built from 64 full-adder parts", { timeout: 10000 }, () => {
    const doc = build64BitRca();
    const c = extractCircuit(doc);
    expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
    const sim = new Simulator(c);
    const MASK32 = 0xffffffffn;
    const MASK64 = (1n << 64n) - 1n;

    const cases: [bigint, bigint, 0 | 1][] = [
      [0n, 0n, 0],
      [0n, 0n, 1],
      [MASK64, 0n, 1], // full 64-bit carry ripple
      [MASK64, MASK64, 1],
      [0x5555555555555555n, 0xaaaaaaaaaaaaaaaan, 1],
      [0x00000000ffffffffn, 0x0000000000000001n, 0],
    ];
    const rng = new Rng(6464);
    for (let i = 0; i < 50; i++) {
      cases.push([rng.bigBits(64), rng.bigBits(64), rng.int(0, 1) as 0 | 1]);
    }

    const t = measure(() => {
      for (const [a, b, cin] of cases) {
        sim.set("A_LO", Number(a & MASK32));
        sim.set("A_HI", Number((a >> 32n) & MASK32));
        sim.set("B_LO", Number(b & MASK32));
        sim.set("B_HI", Number((b >> 32n) & MASK32));
        sim.set("CIN", cin);
        const r = sim.settle();
        expect(r.stable).toBe(true);
        expect(r.issues).toEqual([]);
        const full = a + b + BigInt(cin);
        const expectedSum = full & MASK64;
        const expectedCout = Number(full >> 64n);
        const actualSum = (BigInt(sim.read("S_HI")!) << 32n) | BigInt(sim.read("S_LO")!);
        expect(actualSum).toBe(expectedSum);
        expect(sim.read("COUT")).toBe(expectedCout);
      }
    });
    expect(t.ms).toBeLessThan(3000);
  });

  it("handles one input feeding 10,000 gates", { timeout: 15000 }, () => {
    const doc = buildHighFanout(10000);
    const ex = measure(() => extractCircuit(doc));
    const ck = measure(() => checkCircuit(ex.value));
    const ns = measure(() => new Simulator(ex.value));
    const sim = ns.value;
    const fs = measure(() => sim.settle());
    expect(sim.read("OUT")).toBe(1);

    const tog = measure(() => {
      sim.set("IN", 1);
      return sim.settle();
    });
    expect(sim.read("OUT")).toBe(0);

    expect(ex.ms).toBeLessThan(5000);
    expect(ck.ms).toBeLessThan(3000);
    expect(ns.ms).toBeLessThan(3000);
    expect(fs.ms).toBeLessThan(3000);
    expect(tog.ms).toBeLessThan(3000);
  });

  it("BUG-PERF-4: Simulator constructor scales quadratically O(F^2) on high-fanout nets due to readers[node].includes(pi)", { timeout: 15000, retry: 2 }, () => {
    // Warmup
    new Simulator(extractCircuit(buildHighFanout(1000)));
    const c3k = extractCircuit(buildHighFanout(3000));
    const c24k = extractCircuit(buildHighFanout(24000));
    const t3k = measure(() => new Simulator(c3k)).ms;
    const t24k = measure(() => new Simulator(c24k)).ms;
    // 8x fanout should take ~8x time (linear), not ~35-50x (O(F^2) from readers[node].includes(pi))
    expect(t24k / Math.max(t3k, 0.1)).toBeLessThan(16);
  });

  it("propagates a 32-bit bus through 200 splitters cleanly", { timeout: 10000 }, () => {
    const doc = buildSplitterChain(200, 32, 4);
    const ex = measure(() => extractCircuit(doc));
    const c = ex.value;
    expect(c.nodes).toBe(32);
    expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
    const sim = new Simulator(c);
    const rng = new Rng(20032);
    const samples = [0, 0xffffffff, 0xdeadbeef, 0x55555555, 0xaaaaaaaa, ...Array.from({ length: 10 }, () => rng.u32())];
    const t = measure(() => {
      for (const v of samples) {
        sim.set("IN", v);
        const r = sim.settle();
        expect(r.stable).toBe(true);
        expect(sim.read("OUT")).toBe(v);
      }
    });
    expect(ex.ms).toBeLessThan(2000);
    expect(t.ms).toBeLessThan(1000);
  });
});

describe("sequential circuits", () => {
  it("clocks 2,000 flip-flops on one clock (shift register) for 500 cycles", { timeout: 20000 }, () => {
    const doc = buildShiftRegisterFFs(2000);
    const ex = measure(() => extractCircuit(doc));
    const ns = measure(() => new Simulator(ex.value, { initial: "zero" }));
    const sim = ns.value;
    sim.settle();

    // Inject a 1 at cycle 0, then a recognizable pattern at cycles 1..3
    const pattern = [1, 0, 1, 1];
    const run = measure(() => {
      for (let cycle = 0; cycle < 500; cycle++) {
        sim.set("D", cycle < pattern.length ? pattern[cycle] : 0);
        sim.set("CLK", 1);
        sim.settle();
        sim.set("CLK", 0);
        sim.settle();
      }
    });

    // After 500 rising edges, the cycle-0 bit (1) has arrived at FF499 (Q_MID); FF1999 (Q_END) is still 0
    expect(sim.read("Q_MID")).toBe(1);
    expect(sim.read("Q_END")).toBe(0);

    // Next 3 cycles should shift out pattern[1], pattern[2], pattern[3] at Q_MID
    for (let k = 1; k < pattern.length; k++) {
      sim.set("D", 0);
      sim.set("CLK", 1);
      sim.settle();
      sim.set("CLK", 0);
      sim.settle();
      expect(sim.read("Q_MID")).toBe(pattern[k]);
    }

    const cyclesPerSec = 500 / (run.ms / 1000);
    expect(cyclesPerSec).toBeGreaterThan(20);
    expect(run.ms).toBeLessThan(15000);
  });

  it("runs a 16-bit counter for 70,000 cycles and verifies wraparound and RCO", { timeout: 20000 }, () => {
    const doc = mkDoc(
      [
        ["CLK", "clock", { name: "CLK" }],
        ["EN", "constant", { value: "1" }],
        ["RST", "constant", { value: "0" }],
        ["C", "counter", { bits: 16, enable: true, reset: true, carryOut: true }],
        ["Q", "output-pin", { name: "Q", width: 16 }],
        ["RCO", "output-pin", { name: "RCO", width: 1 }],
      ],
      [
        ["CLK.clk", "C.clk"],
        ["EN.out", "C.en"],
        ["RST.out", "C.rst"],
        ["C.q", "Q.in"],
        ["C.rco", "RCO.in"],
      ],
      "cnt16_70k",
    );
    const sim = new Simulator(extractCircuit(doc), { initial: "zero" });
    sim.settle();

    let sawRcoAt65535 = false;
    let sawWrapAt65536 = false;
    const run = measure(() => {
      for (let cycle = 1; cycle <= 70000; cycle++) {
        sim.set("CLK", 1);
        sim.settle();
        sim.set("CLK", 0);
        sim.settle();
        if (cycle === 65535) {
          sawRcoAt65535 = sim.read("Q") === 65535 && sim.read("RCO") === 1;
        } else if (cycle === 65536) {
          sawWrapAt65536 = sim.read("Q") === 0 && sim.read("RCO") === 0;
        }
      }
    });

    expect(sawRcoAt65535).toBe(true);
    expect(sawWrapAt65536).toBe(true);
    expect(sim.read("Q")).toBe(70000 % 65536);
    const cyclesPerSec = 70000 / (run.ms / 1000);
    expect(cyclesPerSec).toBeGreaterThan(5000);
    expect(run.ms).toBeLessThan(12000);
  });

  it("writes and reads back a 16-bit address RAM at 5,000 random addresses", { timeout: 15000 }, () => {
    const doc = mkDoc(
      [
        ["A", "input-pin", { name: "A", width: 16 }],
        ["WD", "input-pin", { name: "WD", width: 8 }],
        ["WE", "input-pin", { name: "WE", width: 1 }],
        ["CLK", "clock", { name: "CLK" }],
        ["M", "ram", { addressBits: 16, dataWidth: 8, dataPortMode: "separate" }],
        ["RD", "output-pin", { name: "RD", width: 8 }],
      ],
      [
        ["A.out", "M.a"],
        ["WD.out", "M.wd"],
        ["WE.out", "M.we"],
        ["CLK.clk", "M.clk"],
        ["M.rd", "RD.in"],
      ],
      "ram16",
    );
    const sim = new Simulator(extractCircuit(doc));
    sim.settle();

    const rng = new Rng(777);
    const written = new Map<number, number>();
    const tWrite = measure(() => {
      sim.set("WE", 1);
      for (let i = 0; i < 5000; i++) {
        const addr = rng.int(0, 65535);
        const data = rng.int(0, 255);
        written.set(addr, data);
        sim.set("A", addr);
        sim.set("WD", data);
        sim.set("CLK", 1);
        sim.settle();
        sim.set("CLK", 0);
        sim.settle();
      }
    });

    const tRead = measure(() => {
      sim.set("WE", 0);
      for (const [addr, data] of written) {
        sim.set("A", addr);
        sim.settle();
        expect(sim.read("RD")).toBe(data);
      }
      // Spot-check untouched addresses read X (null)
      let unchecked = 0;
      for (let addr = 0; addr < 65536 && unchecked < 20; addr += 137) {
        if (written.has(addr)) continue;
        sim.set("A", addr);
        sim.settle();
        expect(sim.read("RD")).toBe(null);
        unchecked++;
      }
    });

    expect(tWrite.ms).toBeLessThan(5000);
    expect(tRead.ms).toBeLessThan(5000);
  });
});

describe("transistor switch-level circuits", () => {
  it("simulates CMOS inverter chains accurately at moderate sizes (shared and split rails)", { timeout: 15000 }, () => {
    for (const shared of [true, false]) {
      const n = shared ? 100 : 200;
      const sim = new Simulator(extractCircuit(buildCmosInverterChain(n, shared)));
      const fs = measure(() => sim.settle());
      expect(fs.value.stable).toBe(true);
      expect(sim.read("OUT")).toBe(0); // IN=0, even number of inverters -> 0
      sim.set("IN", 1);
      expect(sim.settle().stable).toBe(true);
      expect(sim.read("OUT")).toBe(1);
      sim.set("IN", 0);
      expect(sim.settle().stable).toBe(true);
      expect(sim.read("OUT")).toBe(0);
      expect(fs.ms).toBeLessThan(2000);
    }
  });

  it("BUG-PERF-2: CMOS inverter chains scale superlinearly (O(N^3) shared rails, O(N^2) split rails) in Simulator", { timeout: 20000, retry: 2 }, () => {
    // Warmup
    new Simulator(extractCircuit(buildCmosInverterChain(30, true))).settle();

    // Shared VDD/GND rails: N=50 vs N=300 (6x size -> actual ~35-50x due to O(N^2) ranks clique + O(N^3) regroup/resolve)
    const s50 = new Simulator(extractCircuit(buildCmosInverterChain(50, true)));
    const tShared50 = measure(() => s50.settle()).ms;
    const s300 = new Simulator(extractCircuit(buildCmosInverterChain(300, true)));
    const tShared300 = measure(() => s300.settle()).ms;
    expect(tShared300).toBeLessThan(Math.max(15 * tShared50, 60));

    // Split VDD/GND rails: N=100 vs N=600 (6x size -> actual ~25x due to O(N^2) full-circuit regroup per wave)
    const p100 = new Simulator(extractCircuit(buildCmosInverterChain(100, false)));
    const tSplit100 = measure(() => p100.settle()).ms;
    const p600 = new Simulator(extractCircuit(buildCmosInverterChain(600, false)));
    const tSplit600 = measure(() => p600.settle()).ms;
    expect(tSplit600).toBeLessThan(Math.max(15 * tSplit100, 60));
  });

  it.skip("BENCHMARK (BUG-PERF-2): 2,000 shared-rail CMOS inverters in a chain (~40s+ due to O(N^2) ranks clique and O(N^3) settle)", { timeout: 120000 }, () => {
    const c = extractCircuit(buildCmosInverterChain(2000, true));
    const sim = new Simulator(c);
    const fs = measure(() => sim.settle());
    expect(sim.read("OUT")).toBe(0);
    sim.set("IN", 1);
    const tog = measure(() => sim.settle());
    expect(sim.read("OUT")).toBe(1);
    expect(fs.ms + tog.ms).toBeLessThan(2000);
  });

  it("BUG-PERF-6: checkCircuit builds an O(N^2) clique across shared-rail CMOS transistors and falsely reports combinational feedback", { timeout: 10000 }, () => {
    const c = extractCircuit(buildCmosInverterChain(4, true));
    const feedback = checkCircuit(c).filter((i) => i.kind === "feedback");
    expect(feedback).toEqual([]);
  });

  it("simulates a 500-cell pass-transistor chain accurately", { timeout: 15000 }, () => {
    const doc = buildPassTransistorChain(500, "nmos");
    const c = extractCircuit(doc);
    const sim = new Simulator(c);
    const fs = measure(() => {
      sim.set("EN", 1);
      sim.set("IN", 1);
      return sim.settle();
    });
    expect(fs.value.stable).toBe(true);
    expect(sim.read("OUT")).toBe(1);

    const tog = measure(() => {
      sim.set("IN", 0);
      return sim.settle();
    });
    expect(sim.read("OUT")).toBe(0);

    // Turning EN off isolates OUT (floating -> null)
    sim.set("EN", 0);
    sim.set("IN", 1);
    sim.settle();
    expect(sim.read("OUT")).toBe(null);

    expect(fs.ms).toBeLessThan(5000);
    expect(tog.ms).toBeLessThan(1000);
  });

  it("BUG-PERF-3: pass-transistor chain scales O(N^3) on first settle (400 cells is ~200x slower than 50 cells)", { timeout: 15000, retry: 2 }, () => {
    const runPass = (n: number) => {
      const sim = new Simulator(extractCircuit(buildPassTransistorChain(n, "nmos")));
      return measure(() => {
        sim.set("EN", 1);
        sim.set("IN", 1);
        sim.settle();
      }).ms;
    };
    // Warmup
    runPass(50);
    const t50 = runPass(50);
    const t400 = runPass(400);
    // 8x chain length should take ~8x time (linear), not ~200x (O(N^3))
    expect(t400 / Math.max(t50, 0.1)).toBeLessThan(25);
  });
});

describe("pathological circuits", () => {
  it("detects oscillation on 100 independent ring oscillators (ungated and gated) and finishes quickly", { timeout: 15000 }, () => {
    const ungated = measure(() => {
      const sim = new Simulator(extractCircuit(buildRingOscillators(100, false)));
      return sim.settle();
    });
    expect(ungated.value.stable).toBe(false);
    expect(ungated.value.issues.some((i) => i.kind === "oscillation")).toBe(true);
    expect(ungated.ms).toBeLessThan(3000);

    const simGated = new Simulator(extractCircuit(buildRingOscillators(100, true)));
    simGated.set("EN", 0);
    expect(simGated.settle().stable).toBe(true);
    const gated = measure(() => {
      simGated.set("EN", 1);
      return simGated.settle();
    });
    expect(gated.value.stable).toBe(false);
    expect(gated.value.issues.some((i) => i.kind === "oscillation")).toBe(true);
    expect(gated.ms).toBeLessThan(5000);
  });

  it("BUG-PERF-5: K independent gated ring oscillators run O(K^2) total waves because maxWaves uses whole-circuit part count", { timeout: 15000, retry: 2 }, () => {
    const runGated = (k: number) => {
      const sim = new Simulator(extractCircuit(buildRingOscillators(k, true)));
      sim.set("EN", 0);
      sim.settle();
      sim.set("EN", 1);
      return sim.settle().waves;
    };
    const w10 = runGated(10); // 3,891 waves
    const w100 = runGated(100); // 146,901 waves (37.8x for 10x oscillators!)
    expect(w100).toBeLessThan(w10 * 15);

    // 20 tiny 3-gate ring oscillators inside a 5,000-gate DAG burn 410,821 waves
    const gen = generateRandomCombDag({ seed: 99, gateCount: 5000, inputCount: 4, outputCount: 4, fastGatesOnly: true });
    gen.doc.components.push({ id: "OSC_EN", type: "input-pin", x: 0, y: 0, rotation: 0, props: { name: "OSC_EN", width: 1 }, label: "" });
    for (let i = 0; i < 20; i++) {
      const a = `RO${i}_0`, b = `RO${i}_1`, c = `RO${i}_2`;
      gen.doc.components.push(
        { id: a, type: "not", x: 0, y: 0, rotation: 0, props: {}, label: "" },
        { id: b, type: "not", x: 0, y: 0, rotation: 0, props: {}, label: "" },
        { id: c, type: "nand", x: 0, y: 0, rotation: 0, props: {}, label: "" },
      );
      gen.doc.links!.push(
        [`p:${a}|out`, `p:${b}|in0`],
        [`p:${b}|out`, `p:${c}|in0`],
        [`p:${c}|out`, `p:${a}|in0`],
        ["p:OSC_EN|out", `p:${c}|in1`],
      );
    }
    const sim = new Simulator(extractCircuit(gen.doc));
    sim.set("OSC_EN", 0);
    sim.settle();
    sim.set("OSC_EN", 1);
    const r = sim.settle();
    expect(r.stable).toBe(false);
    expect(r.waves).toBeLessThan(20000);
  });

  it("handles 1,000-gate feedback loops (odd oscillating and even bistable)", { timeout: 15000 }, () => {
    const simOddUngated = new Simulator(extractCircuit(buildFeedbackLoop(1001, false)));
    const r1 = measure(() => simOddUngated.settle());
    expect(r1.value.stable).toBe(false);
    expect(r1.value.issues.some((i) => i.kind === "oscillation")).toBe(true);
    expect(simOddUngated.read("OUT")).toBe(null);
    expect(r1.ms).toBeLessThan(3000);

    const simOddGated = new Simulator(extractCircuit(buildFeedbackLoop(1001, true)));
    simOddGated.set("EN", 0);
    expect(simOddGated.settle().stable).toBe(true);
    const r2 = measure(() => {
      simOddGated.set("EN", 1);
      return simOddGated.settle();
    });
    expect(r2.value.stable).toBe(false);
    expect(r2.value.issues.some((i) => i.kind === "oscillation")).toBe(true);
    expect(simOddGated.read("OUT")).toBe(null);
    expect(r2.ms).toBeLessThan(3000);

    const simEven = new Simulator(extractCircuit(buildFeedbackLoop(1000, false)));
    const r3 = measure(() => simEven.settle());
    expect(r3.value.stable).toBe(true);
    expect(r3.value.issues.filter((i) => i.kind === "oscillation")).toEqual([]);
    expect(r3.ms).toBeLessThan(3000);
  });

  it("extracts and fingerprints documents with tens of thousands of links linearly", { timeout: 15000 }, () => {
    for (const linkCount of [10000, 30000, 50000]) {
      const doc = buildManyLinksDoc(linkCount);
      const sk = measure(() => structuralKey(doc));
      const ex = measure(() => extractCircuit(doc));
      const sim = new Simulator(ex.value);
      sim.set("A", 1);
      sim.settle();
      expect(sim.read("Y")).toBe(1);
      expect(sk.ms).toBeLessThan(2000);
      expect(ex.ms).toBeLessThan(3000);
    }
  });

  it("computes structuralKey quickly on documents with real wires (sopsToSchematic and sprawled)", { timeout: 15000 }, () => {
    const rng = new Rng(123);
    const sopVars = ["x0", "x1", "x2", "x3", "x4", "x5"];
    const sopOutputs = Array.from({ length: 6 }, (_, k) => {
      const ms = Array.from({ length: 64 }, (_, m) => m).filter(() => rng.bool(0.5));
      return { name: `f${k}`, terms: minimize(6, ms).terms };
    });
    const sopDoc = sopsToSchematic(sopOutputs, sopVars);
    expect(sopDoc.wires.length).toBeGreaterThan(200);
    const sopBase = structuralKey(sopDoc);
    const sopMoved = structuredClone(sopDoc);
    sopMoved.components[0].x += 50;
    sopMoved.components[0].label = "moved";
    expect(structuralKey(sopMoved)).toBe(sopBase);

    const sop100 = measure(() => {
      for (let i = 0; i < 100; i++) structuralKey(sopDoc);
    });
    expect(sop100.ms).toBeLessThan(2000);

    const sprawlDoc = sprawled(11, 6, 10);
    expect(sprawlDoc.wires.length).toBeGreaterThan(50);
    expect(sprawlDoc.links).toBeUndefined(); // exercises geometric fallback path
    const sprawlBase = structuralKey(sprawlDoc);
    const sprawl100 = measure(() => {
      for (let i = 0; i < 100; i++) expect(structuralKey(sprawlDoc)).toBe(sprawlBase);
    });
    expect(sprawl100.ms).toBeLessThan(3000);
  });
});

describe("truthTable 16 input bits (65,536 rows)", () => {
  it("computes a full 65,536-row truth table on a 16-input decoder-like circuit (bus and bit inputs)", { timeout: 20000 }, () => {
    for (const busInput of [true, false]) {
      const { doc, targetAddresses } = build16BitDecoderLike(busInput);
      const c = extractCircuit(doc);
      expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
      const tt = measure(() => truthTable(c));
      expect(tt.value.rows).toHaveLength(65536);
      expect(tt.value.vars).toHaveLength(16);
      expect(tt.value.outBits).toHaveLength(8);

      // Verify exact decoder behavior across all 65,536 rows
      const onesPerOut = new Array<number>(8).fill(0);
      for (let m = 0; m < 65536; m++) {
        // For 16 single-bit inputs A0..A15, truthTable lists A0 as MSB (vars are reversed: A15..A0)
        // Reconstruct the 16-bit integer matching bit i = A_i
        let addr = m;
        if (!busInput) {
          addr = 0;
          for (let b = 0; b < 16; b++) {
            if ((m >> (15 - b)) & 1) addr |= 1 << b;
          }
        }
        const row = tt.value.rows[m];
        for (let k = 0; k < 8; k++) {
          const expected = addr === targetAddresses[k] ? 1 : 0;
          if (row[k] !== expected) throw new Error(`Mismatch at row ${m} (addr=${addr}) out ${k}: got ${row[k]}, expected ${expected}`);
          onesPerOut[k] += row[k];
        }
      }
      expect(onesPerOut).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      expect(tt.ms).toBeLessThan(10000);
    }
  });
});

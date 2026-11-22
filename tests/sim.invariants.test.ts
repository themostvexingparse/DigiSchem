/**
 * Internal consistency of the simulator after every settle, on random circuits: the groups of
 * nets joined by switches (rebuilt locally as switches change) equal a grouping from scratch,
 * the unknown-switch lists match the switch states, the floating candidates match the values,
 * and every node holds the value it resolves to (a true fixed point). These catch bookkeeping
 * bugs that only show much later as a wrong value.
 */
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { extractCircuit } from "../src/logic/circuit";
import { BX, BZ, Simulator, type Bit } from "../src/logic/simulate";
import { generateRandomXrefCircuit } from "./helpers/xref-gen";
import { generateRandomCombDag, Rng } from "./helpers/sim-gen";

registerBuiltinComponents();

/** Every problem with the simulator's internal state, as text (empty when consistent). */
function invariants(sim: Simulator): string[] {
  const s = sim as any;
  const out: string[] = [];
  const n: number = s.values.length;
  // groups from scratch: conducting switches, never through a rail
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const sw of s.switches) if (sw.on === 1 && !s.supplyNode[sw.a] && !s.supplyNode[sw.b]) parent[find(sw.a)] = find(sw.b);
  const want = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    want.set(r, [...(want.get(r) ?? []), i]);
  }
  for (const members of want.values()) {
    const roots = new Set(members.map((m) => s.root[m]));
    if (roots.size !== 1) out.push(`nodes ${members.join(",")} should be one group but have roots ${[...roots].join(",")}`);
    const r = s.root[members[0]];
    if (members.length > 1) {
      const got: number[] = s.members.get(r) ?? [];
      if ([...got].sort((a, b) => a - b).join() !== [...members].sort((a, b) => a - b).join()) out.push(`group ${r} lists ${got.join(",")}, should be ${members.join(",")}`);
    } else if (s.members.has(r) && s.members.get(r).length > 1) out.push(`node ${members[0]} is alone but group ${r} lists ${s.members.get(r).join(",")}`);
  }
  for (const [r, l] of s.members as Map<number, number[]>) for (const m of l) if (s.root[m] !== r) out.push(`group ${r} lists ${m} whose root is ${s.root[m]}`);
  // unknown-switch lists
  for (let i = 0; i < n; i++) {
    const wantU = s.switches.filter((sw: any) => sw.on === BX && (sw.a === i || sw.b === i)).length;
    const gotU = (s.unsure.get(i) ?? []).length;
    if (wantU !== gotU) out.push(`node ${i} has ${gotU} unknown switches listed, should be ${wantU}`);
  }
  // floating candidates and fixed point
  for (let i = 0; i < n; i++) {
    const shouldZ = s.values[i] === BZ && s.readers[i].length > 0;
    if (shouldZ !== s.zSet.has(i)) out.push(`node ${i}: floating set says ${s.zSet.has(i)}, value ${s.values[i]}`);
    if (s.forcedX.has(i)) continue;
    const v: Bit = s.resolve(i).value;
    if (v !== s.values[i]) out.push(`node ${i} holds ${s.values[i]} but resolves to ${v}`);
  }
  return out;
}

describe("simulator invariants after every settle", () => {
  it("random transistor, tri-state, pull and gate networks", { timeout: 60000 }, () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 400 && bad.length < 5; seed++) {
      const gen = generateRandomXrefCircuit(seed);
      const sim = new Simulator(extractCircuit(gen.doc));
      const rng = new Rng(seed * 31 + 7);
      for (let v = 0; v < 10 && bad.length < 5; v++) {
        for (const id of gen.inputIds) sim.set(id, [rng.bool(0.1) ? BX : rng.bool(0.5) ? 1 : 0] as Bit[]);
        const r = sim.settle();
        void r; // (also after an oscillation: nodes held at X are skipped by the fixed-point check)
        const problems = invariants(sim);
        if (problems.length) bad.push(`seed ${seed} vector ${v}: ${problems.slice(0, 3).join("; ")}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("random gate networks (the fast path)", { timeout: 60000 }, () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const gen = generateRandomCombDag({ seed, gateCount: 60 + seed * 5, inputCount: 6, outputCount: 4 });
      const sim = new Simulator(extractCircuit(gen.doc));
      const rng = new Rng(seed);
      for (let v = 0; v < 8; v++) {
        for (const id of gen.inputIds) sim.set(id, rng.int(0, 1));
        sim.settle();
        const problems = invariants(sim);
        if (problems.length) bad.push(`seed ${seed}: ${problems.slice(0, 3).join("; ")}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("random gate networks with feedback (loops probed, oscillations held, then released)", { timeout: 60000 }, () => {
    const types = ["and", "or", "nand", "nor", "xor", "xnor", "not", "buf"];
    const bad: string[] = [];
    let unstable = 0;
    for (let seed = 1; seed <= 300 && bad.length < 5; seed++) {
      const rng = new Rng(seed * 101 + 3);
      const nIn = rng.int(1, 4), nG = rng.int(2, 14);
      const comps: { id: string; type: string; x: number; y: number; rotation: 0; props: Record<string, number>; label: string }[] = [];
      const links: [string, string][] = [];
      for (let i = 0; i < nIn; i++) comps.push({ id: `I${i}`, type: "input-pin", x: 0, y: i * 60, rotation: 0, props: {}, label: "" });
      const outs = [...Array.from({ length: nIn }, (_, i) => `p:I${i}|out`), ...Array.from({ length: nG }, (_, g) => `p:G${g}|out`)];
      for (let g = 0; g < nG; g++) {
        const t = types[rng.int(0, types.length - 1)];
        const k = t === "not" || t === "buf" ? 1 : rng.int(2, 3);
        comps.push({ id: `G${g}`, type: t, x: 200 + g * 120, y: 0, rotation: 0, props: k > 1 ? { inputs: k } : {}, label: "" });
        // any output, earlier or later: feedback loops are allowed
        for (let j = 0; j < k; j++) links.push([outs[rng.int(0, outs.length - 1)], `p:G${g}|in${j}`]);
      }
      comps.push({ id: "Y", type: "output-pin", x: 0, y: 900, rotation: 0, props: {}, label: "" });
      links.push([`p:G${nG - 1}|out`, "p:Y|in"]);
      const doc = { format: "digischem" as const, version: 1 as const, name: "loops", grid: 10, components: comps, wires: [], texts: [], links };
      const sim = new Simulator(extractCircuit(doc));
      for (let v = 0; v < 8 && bad.length < 5; v++) {
        for (let i = 0; i < nIn; i++) sim.set(`I${i}`, rng.int(0, 1));
        if (!sim.settle().stable) unstable++;
        const problems = invariants(sim);
        if (problems.length) bad.push(`seed ${seed} vector ${v}: ${problems.slice(0, 3).join("; ")}`);
      }
    }
    expect(bad).toEqual([]);
    expect(unstable).toBeGreaterThan(0); // the generator does make oscillators
  });

  it("the fast path and the general path agree (the same DAG with a stray transistor)", { timeout: 60000 }, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const gen = generateRandomCombDag({ seed: seed + 500, gateCount: 120, inputCount: 6, outputCount: 6 });
      const withSwitch = structuredClone(gen.doc);
      withSwitch.components.push({ id: "STRAY", type: "nmos", x: -500, y: -500, rotation: 0, props: {}, label: "" });
      const a = new Simulator(extractCircuit(gen.doc)), b = new Simulator(extractCircuit(withSwitch));
      const rng = new Rng(seed);
      for (let v = 0; v < 12; v++) {
        for (const id of gen.inputIds) {
          const x = rng.int(0, 1);
          a.set(id, x);
          b.set(id, x);
        }
        const ra = a.settle(), rb = b.settle();
        expect(ra.stable).toBe(rb.stable);
        for (const id of gen.outputIds) expect(b.read(id), `seed ${seed} ${id}`).toBe(a.read(id));
      }
    }
  });

  it("after an oscillation is held and released, and after probing a CMOS latch", () => {
    // a ring of three CMOS inverters gated by EN (NAND as the third stage)
    const parts: [string, string][] = [["EN", "input-pin"], ["VDD", "vcc"], ["GND", "ground"], ["P1", "pmos"], ["N1", "nmos"], ["P2", "pmos"], ["N2", "nmos"], ["P3A", "pmos"], ["P3B", "pmos"], ["N3A", "nmos"], ["N3B", "nmos"], ["Y", "output-pin"]];
    const nets = [["VDD.vcc", "P1.s", "P2.s", "P3A.s", "P3B.s"], ["GND.gnd", "N1.s", "N2.s", "N3B.s"], ["EN.out", "P3B.g", "N3B.g"], ["P3A.d", "P3B.d", "N3A.d", "P1.g", "N1.g", "Y.in"], ["P1.d", "N1.d", "P2.g", "N2.g"], ["P2.d", "N2.d", "P3A.g", "N3A.g"], ["N3A.s", "N3B.d"]];
    const doc = {
      format: "digischem" as const, version: 1 as const, name: "ring", grid: 10, wires: [], texts: [],
      components: parts.map(([id, type], i) => ({ id, type, x: i * 200, y: 0, rotation: 0 as const, props: {}, label: "" })),
      links: nets.flatMap((net) => net.slice(1).map((r) => [`p:${net[0].replace(".", "|")}`, `p:${r.replace(".", "|")}`] as [string, string])),
    };
    const sim = new Simulator(extractCircuit(doc));
    for (const en of [0, 1, 0, 1, 1, 0]) {
      sim.set("EN", en);
      const r = sim.settle();
      if (r.stable) expect(invariants(sim)).toEqual([]);
    }
    expect(sim.read("Y")).toBe(1);
  });
});

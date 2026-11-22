import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import type { PropValue, SchematicDocument } from "../src/model/types";
import { extractCircuit, type Circuit } from "../src/logic/circuit";
import { B0, B1, BX, BZ, Simulator, type Bit } from "../src/logic/simulate";
import { R0, R1, RX, RZ, RefSimulator, type RefBit } from "./helpers/ref-sim";
import { mkDoc, Rng, type PartSpec } from "./helpers/sim-gen";
import { generateRandomXrefCircuit } from "./helpers/xref-gen";

registerBuiltinComponents();

// ---- Comparison helpers ----

interface ComparisonDiff {
  kind: "non-converged" | "unstable" | "output-value" | "floating" | "contention";
  detail: string;
}

function compareState(
  circuit: Circuit,
  sim: Simulator,
  ref: RefSimulator,
  simRes: ReturnType<Simulator["settle"]>,
  refRes: ReturnType<RefSimulator["settle"]>,
): ComparisonDiff[] {
  const diffs: ComparisonDiff[] = [];

  // the reference's own limits: no answer to compare with
  if (!refRes.converged) return diffs;
  if (!simRes.stable) {
    diffs.push({
      kind: "unstable",
      detail: `Simulator reported unstable (waves=${simRes.waves}): ${simRes.issues.map((i) => i.message).join("; ")}`,
    });
    return diffs;
  }

  const skipped = refRes.skippedNodes;

  // 1. Compare every output-pin value (bit-for-bit)
  for (const part of circuit.parts) {
    if (part.type !== "output-pin") continue;
    const pin = part.pins[0];
    if (pin.bits.some((n) => skipped.has(n))) continue;
    const sBits = sim.pinBits(part.id, pin.id);
    const rBits = ref.pinBits(part.id, pin.id);
    for (let i = 0; i < pin.width; i++) {
      if (sBits[i] !== rBits[i]) {
        diffs.push({
          kind: "output-value",
          detail: `${part.name}[${i}] (node ${pin.bits[i]}): sim=${"01XZ"[sBits[i]]} ref=${"01XZ"[rBits[i]]}`,
        });
      }
    }
  }

  // 2. Compare floating nodes (ignoring skipped nodes)
  const simFloating = new Set<number>();
  for (const iss of simRes.issues) {
    if (iss.kind === "floating") {
      for (const n of iss.nodes) if (!skipped.has(n)) simFloating.add(n);
    }
  }
  const refFloating = new Set<number>();
  for (const n of refRes.floatingNodes) {
    if (!skipped.has(n)) refFloating.add(n);
  }
  for (const n of new Set([...simFloating, ...refFloating])) {
    if (simFloating.has(n) !== refFloating.has(n)) {
      diffs.push({
        kind: "floating",
        detail: `node ${n}: simFloating=${simFloating.has(n)} refFloating=${refFloating.has(n)} (simVal=${"01XZ"[sim.node(n)]}, refVal=${"01XZ"[ref.node(n)]})`,
      });
    }
  }

  // 3. Compare contention nodes (ignoring skipped nodes)
  const simCont = new Set<number>();
  for (const iss of simRes.issues) {
    if (iss.kind === "contention") {
      for (const n of iss.nodes) if (!skipped.has(n)) simCont.add(n);
    }
  }
  const refCont = new Set<number>();
  for (const n of refRes.contentionNodes) {
    if (!skipped.has(n)) refCont.add(n);
  }
  const simHasCont = simCont.size > 0;
  const refHasCont = refCont.size > 0;
  // (with an island too large for the reference's brute force, it cannot rule a short out)
  if (simHasCont !== refHasCont && !(simHasCont && refRes.skippedNodes.size > 0)) {
    diffs.push({
      kind: "contention",
      detail: `hasContention mismatch: sim=[${[...simCont].sort((a, b) => a - b)}] ref=[${[...refCont].sort((a, b) => a - b)}] (simIssues=${simRes.issues.filter((i) => i.kind === "contention").map((i) => i.message).join(" | ")})`,
    });
  } else if (simHasCont && process.env.XREF_NODES) {
    // Per-node differences are informational only: the reference lists every node of a shorted
    // island, the simulator the nets and switch ends involved (set XREF_NODES=1 to see them).
    const onlySim = [...simCont].filter((n) => !refCont.has(n)).sort((a, b) => a - b);
    const onlyRef = [...refCont].filter((n) => !simCont.has(n)).sort((a, b) => a - b);
    if (onlySim.length || onlyRef.length) {
      diffs.push({
        kind: "contention",
        detail: `contention nodes differ: onlySim=[${onlySim}] onlyRef=[${onlyRef}] sim=[${[...simCont].sort((a, b) => a - b)}] ref=[${[...refCont].sort((a, b) => a - b)}]`,
      });
    }
  }

  return diffs;
}

// ---- Seeded Acyclic Mixed Circuit Generator ----

describe("reference simulator sanity", () => {
  it("matches Simulator on CMOS inverter, NAND, NOR and TG mux", () => {
    // CMOS NAND + TG mux
    const doc = mkDoc(
      [
        ["A", "input-pin"],
        ["B", "input-pin"],
        ["S", "input-pin"],
        ["VDD", "vcc"],
        ["GND", "ground"],
        ["MP1", "pmos"],
        ["MP2", "pmos"],
        ["MN1", "nmos"],
        ["MN2", "nmos"],
        ["INV", "not"],
        ["TG1", "transmission-gate"],
        ["TG2", "transmission-gate"],
        ["YNAND", "output-pin"],
        ["YMUX", "output-pin"],
      ],
      [
        ["A.out", "MP1.g", "MN1.g"],
        ["B.out", "MP2.g", "MN2.g"],
        ["VDD.vcc", "MP1.s", "MP2.s"],
        ["GND.gnd", "MN2.s"],
        ["MN1.s", "MN2.d"],
        ["MP1.d", "MP2.d", "MN1.d", "YNAND.in", "TG1.a"],
        ["A.out", "TG2.a"],
        ["S.out", "INV.in0", "TG1.enb", "TG2.en"],
        ["INV.out", "TG1.en", "TG2.enb"],
        ["TG1.b", "TG2.b", "YMUX.in"],
      ],
    );
    const circuit = extractCircuit(doc);
    const sim = new Simulator(circuit);
    const ref = new RefSimulator(circuit);

    for (let m = 0; m < 8; m++) {
      const a = (m & 1) as Bit;
      const b = ((m >> 1) & 1) as Bit;
      const s = ((m >> 2) & 1) as Bit;
      sim.set("A", a);
      sim.set("B", b);
      sim.set("S", s);
      ref.set("A", a);
      ref.set("B", b);
      ref.set("S", s);
      const sr = sim.settle();
      const rr = ref.settle();
      expect(compareState(circuit, sim, ref, sr, rr)).toEqual([]);
      const nandVal = (a & b) ^ 1;
      expect(sim.read("YNAND")).toBe(nandVal);
      expect(sim.read("YMUX")).toBe(s ? a : nandVal);
    }
  });
});

describe("differential fuzzing: Simulator vs RefSimulator (diagnostic)", () => {
  it("runs seeded random mixed circuits: the simulator agrees with the reference", { timeout: 60000 }, () => {
    const byKind = new Map<string, { count: number; samples: string[] }>();
    let totalVectors = 0;
    let totalSkipped = 0;

    for (let seed = 1; seed <= 1000; seed++) {
      const gen = generateRandomXrefCircuit(seed);
      const circuit = extractCircuit(gen.doc);
      const sim = new Simulator(circuit);
      const ref = new RefSimulator(circuit);
      const vrng = new Rng(seed * 7919 + 17);

      const vectors = 8;
      for (let v = 0; v < vectors; v++) {
        totalVectors++;
        const vec: RefBit[] = [];
        for (const inp of gen.inputIds) {
          // 80% known 0/1, 20% X on later vectors
          const bit: RefBit = v < 4 ? (vrng.bool(0.5) ? R1 : R0) : vrng.bool(0.15) ? RX : vrng.bool(0.5) ? R1 : R0;
          vec.push(bit);
          sim.set(inp, [bit as Bit]);
          ref.set(inp, [bit]);
        }
        const sr = sim.settle();
        const rr = ref.settle();
        if (rr.skippedNodes.size > 0) totalSkipped++;
        const diffs = compareState(circuit, sim, ref, sr, rr);
        for (const d of diffs) {
          const entry = byKind.get(d.kind) ?? { count: 0, samples: [] };
          entry.count++;
          if (entry.samples.length < 8) {
            entry.samples.push(`seed=${seed}(${gen.kind}) vec=[${vec.map((x) => "01XZ"[x]).join("")}] ${d.detail}`);
          }
          byKind.set(d.kind, entry);
        }
      }
    }

    const report = [...byKind].map(([k, v]) => `${k}: ${v.count}; ${v.samples.join(" | ")}`).join(" || ");
    expect(totalVectors).toBeGreaterThan(0);
    expect(report, `Tested ${totalVectors} vectors (${totalSkipped} with some skipped island)`).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { componentBounds } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { centerOfMass, packSchematic } from "../src/layout/pack";
import { validatePacking } from "../src/layout/validate";
import { sprawled } from "./helpers/sprawl";

registerBuiltinComponents();
const nets = (d: Parameters<typeof buildNetlist>[0]) =>
  buildNetlist(d).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).sort();

describe("packer: beam search + centre of mass", () => {
  const doc = sprawled(1, 3, 4);

  it("beam result is valid and never worse than the greedy-only pipeline", () => {
    const greedy = packSchematic(doc, { beamWidth: 0, timeBudgetMs: 800 });
    const beam = packSchematic(doc, { beamWidth: 3, timeBudgetMs: 800 });
    expect(validatePacking(doc, beam.doc)).toEqual([]);
    expect(nets(beam.doc)).toEqual(nets(doc));
    expect(beam.qualityAfter.total).toBeLessThanOrEqual(greedy.qualityAfter.total + 1e-6);
    expect(beam.qualityAfter.total).toBeLessThan(beam.qualityBefore.total);
    expect(beam.beam.expanded).toBeGreaterThan(0);
  }, 20000);

  it("keeps the area-weighted centre of mass (whole document) within half a grid cell", () => {
    const res = packSchematic(doc, { beamWidth: 0, timeBudgetMs: 600 });
    const c0 = centerOfMass(doc)!;
    const c1 = centerOfMass(res.doc)!;
    expect(res.areaAfter).toBeLessThan(res.areaBefore); // it really compacted
    expect(Math.abs(c1.x - c0.x)).toBeLessThanOrEqual(doc.grid / 2 + 1e-6);
    expect(Math.abs(c1.y - c0.y)).toBeLessThanOrEqual(doc.grid / 2 + 1e-6);
    expect(res.centerAfter).toEqual(c1);
    expect(validatePacking(doc, res.doc)).toEqual([]);
    // without the option the packed layout drifts towards the top-left
    const drift = packSchematic(doc, { beamWidth: 0, timeBudgetMs: 600, preserveCenter: false });
    const c2 = centerOfMass(drift.doc)!;
    expect(Math.hypot(c2.x - c0.x, c2.y - c0.y)).toBeGreaterThan(doc.grid);
  }, 20000);

  it("selection packing keeps the selection's centre of mass when legal, and stays valid", () => {
    // pack one middle stage (gates + their wires); everything else is a fixed obstacle
    const ids = new Set<string>();
    for (const c of doc.components) if (c.id.startsWith("g1_")) ids.add(c.id);
    const res = packSchematic(doc, { ids, beamWidth: 0, timeBudgetMs: 600 });
    expect(validatePacking(doc, res.doc, { ids })).toEqual([]);
    for (const c of doc.components) {
      if (ids.has(c.id)) continue;
      const after = res.doc.components.find((x) => x.id === c.id)!;
      expect([after.x, after.y]).toEqual([c.x, c.y]); // fixed parts never move
    }
    const c0 = centerOfMass(doc, ids)!;
    const c1 = centerOfMass(res.doc, ids)!;
    const span = Math.max(...doc.components.filter((c) => ids.has(c.id)).map((c) => componentBounds(c).h));
    // the selection does not wander off: its centre stays within a part's height of where it was
    expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeLessThanOrEqual(span);
  }, 20000);
});

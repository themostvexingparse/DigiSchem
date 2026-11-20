import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { parseProject } from "../src/io/project";
import { componentBounds } from "../src/model/geometry";
import { nudgeSelectionInStore } from "../src/editor/doc-ops";
import { packSchematic, validateCompaction } from "../src/layout/pack";
import { netSignature } from "../src/layout/realign";

registerBuiltinComponents();
const bends = (d: { wires: { points: unknown[] }[] }) => d.wires.reduce((n, w) => n + w.points.length - 2, 0);
const load = (f: string) => parseProject(readFileSync(`samples/compaction/${f}.dschem`, "utf8"));

describe("compaction realigns a displaced part and re-routes its wires", () => {
  it("puts a dragged-out inverter back into its column slot with straight wires", () => {
    const tidy = packSchematic(load("01-scattered-inverters")).doc;
    const s = new DocumentStore(tidy);
    s.setSelection(["n2"]);
    nudgeSelectionInStore(s, 60, 20);
    expect(bends(s.doc)).toBeGreaterThan(bends(tidy)); // the drag bent its wires
    const r = packSchematic(s.doc);
    expect(validateCompaction(s.doc, r)).toEqual([]);
    expect(r.realignedParts).toContain("n2");
    const n2 = r.doc.components.find((c) => c.id === "n2")!;
    const t2 = tidy.components.find((c) => c.id === "n2")!;
    expect([n2.x, n2.y]).toEqual([t2.x, t2.y]);
    expect(bends(r.doc)).toBe(bends(tidy));
    expect(netSignature(r.doc)).toBe(netSignature(s.doc));
  }, 30000);

  it("on a large circuit, brings a part aligned with many peers back in line", () => {
    const tidy = packSchematic(load("07-large-sprawl"), { timeBudgetMs: 2500 }).doc;
    const cls = (c: (typeof tidy.components)[number]) => {
      const b = componentBounds(c);
      return `${c.type}|${b.w}x${b.h}`;
    };
    const peersInLine = (d: typeof tidy, id: string) => {
      const c = d.components.find((x) => x.id === id)!;
      return d.components.filter((q) => q.id !== id && cls(q) === cls(c) && (q.x === c.x || q.y === c.y)).length;
    };
    const pick = [...tidy.components].sort((a, b) => peersInLine(tidy, b.id) - peersInLine(tidy, a.id))[0];
    const before = peersInLine(tidy, pick.id);
    const s = new DocumentStore(tidy);
    s.setSelection([pick.id]);
    nudgeSelectionInStore(s, 40, 0);
    expect(peersInLine(s.doc, pick.id)).toBeLessThan(before);
    const r = packSchematic(s.doc, { timeBudgetMs: 2500 });
    expect(validateCompaction(s.doc, r)).toEqual([]);
    expect(peersInLine(r.doc, pick.id)).toBeGreaterThanOrEqual(before);
    expect(bends(r.doc)).toBeLessThanOrEqual(bends(s.doc));
  }, 60000);

  it("realign never changes connectivity, never adds bends, and leaves fixed parts alone", () => {
    const tidy = packSchematic(load("01-scattered-inverters")).doc;
    const s = new DocumentStore(tidy);
    s.setSelection(["n2"]);
    nudgeSelectionInStore(s, 60, 20);
    // only n1 may move: n2 must stay displaced
    const ids = new Set(["n1"]);
    const r = packSchematic(s.doc, { ids });
    expect(validateCompaction(s.doc, r, { ids })).toEqual([]);
    const n2 = r.doc.components.find((c) => c.id === "n2")!;
    const d2 = s.doc.components.find((c) => c.id === "n2")!;
    expect([n2.x, n2.y]).toEqual([d2.x, d2.y]);
  }, 30000);
});

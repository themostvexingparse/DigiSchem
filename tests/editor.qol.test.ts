import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument, type ComponentInstance } from "../src/model/types";
import { componentBounds, worldPins } from "../src/model/geometry";
import { computeGuides, guidePeers } from "../src/editor/guides";
import { deleteSelectionInStore, sweepOrphanWires } from "../src/editor/doc-ops";
import { DocumentStore } from "../src/model/store";

registerBuiltinComponents();
const pin = (c: ComponentInstance, id: string) => worldPins(c).find((p) => p.pin.id === id)!.pos;
const ff = (id: string, x: number, y: number): ComponentInstance => ({ id, type: "d-ff", x, y, rotation: 0, props: {} });

describe("smart guides", () => {
  it("only peers of the same type and size count", () => {
    const d = emptyDocument();
    const a = ff("a", 0, 0);
    d.components.push(a, ff("b", 200, 0), { id: "g", type: "and", x: 0, y: 200, rotation: 0, props: {} },
      { id: "big", type: "d-ff", x: 400, y: 0, rotation: 0, props: {}, size: { w: 200, h: 200 } });
    expect(guidePeers(d, a, new Set(["a"]))).toHaveLength(1);
  });

  it("snaps into alignment within the snap distance and reports a guide line", () => {
    const d = emptyDocument();
    const a = ff("a", 0, 0);
    d.components.push(a, ff("b", 200, 100));
    const peers = guidePeers(d, a, new Set(["a"]));
    const g = computeGuides(componentBounds(a), peers, { x: 0, y: 90 }, 20);
    expect(g.adjust).toEqual({ x: 0, y: 10 });
    expect(g.lines.length).toBeGreaterThan(0);
    const far = computeGuides(componentBounds(a), peers, { x: 0, y: 50 }, 20);
    expect(far.adjust).toEqual({ x: 0, y: 0 });
    expect(far.lines).toHaveLength(0);
  });

  it("snaps to an equal gap in a row and draws spacing bars on both gaps", () => {
    const d = emptyDocument();
    const w = componentBounds(ff("t", 0, 0)).w;
    const a = ff("a", 0, 300);
    d.components.push(a, ff("b", 0, 0), ff("c", w + 40, 0)); // gap 40 between b and c
    const peers = guidePeers(d, a, new Set(["a"]));
    // Drag a into the row (y = 0) to the right of c, ending 10 short of an equal 40 gap.
    const target = 2 * w + 80;
    const g = computeGuides(componentBounds(a), peers, { x: target - 10 - componentBounds(a).x + componentBounds(ff("q", 0, 0)).x, y: -300 }, 20);
    const finalX = componentBounds(a).x + g.adjust.x + (target - 10 - componentBounds(a).x + componentBounds(ff("q", 0, 0)).x);
    expect(finalX - (componentBounds(ff("c", w + 40, 0)).x + w)).toBe(40);
    expect(g.spacings).toHaveLength(2);
  });

  it("guides only (no snap) when snapping is disabled", () => {
    const d = emptyDocument();
    const a = ff("a", 0, 0);
    d.components.push(a, ff("b", 200, 100));
    const g = computeGuides(componentBounds(a), guidePeers(d, a, new Set(["a"])), { x: 0, y: 90 }, 0);
    expect(g.adjust).toEqual({ x: 0, y: 0 });
  });
});

describe("orphan wire sweep", () => {
  const build = () => {
    const d = emptyDocument();
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: {} };
    const g2: ComponentInstance = { id: "g2", type: "not", x: 300, y: 0, rotation: 0, props: {} };
    const g3: ComponentInstance = { id: "g3", type: "not", x: 300, y: 200, rotation: 0, props: {} };
    d.components.push(g1, g2, g3);
    const out = pin(g1, "out");
    // main: g1.out -> g2.in0 (with a bend);  chain: ends at main's free bend? no — keep it simple:
    d.wires.push({ id: "main", points: [out, { x: 200, y: out.y }, { x: 200, y: pin(g2, "in0").y }, pin(g2, "in0")] });
    // branch off main (T-junction at (200, out.y)) down to g3
    d.wires.push({ id: "branch", points: [{ x: 200, y: pin(g3, "in0").y }, pin(g3, "in0")] });
    d.wires.push({ id: "drop", points: [{ x: 200, y: 100 }, { x: 200, y: pin(g3, "in0").y }] });
    // dangling stub chain attached only to g1.in0
    const in0 = pin(g1, "in0");
    d.wires.push({ id: "stub1", points: [in0, { x: in0.x - 40, y: in0.y }] });
    d.wires.push({ id: "stub2", points: [{ x: in0.x - 40, y: in0.y }, { x: in0.x - 40, y: in0.y - 60 }] });
    // wire between g2 and g3 that never touched g1
    d.wires.push({ id: "other", points: [pin(g2, "out"), { x: pin(g2, "out").x + 40, y: pin(g2, "out").y }] });
    return d;
  };

  it("deleting a part removes its dangling wires, cascading through wire chains, keeping other nets", () => {
    const d = build();
    const seeds = worldPins(d.components[0]).map((p) => p.pos);
    d.components = d.components.filter((c) => c.id !== "g1");
    const removed = sweepOrphanWires(d, seeds);
    expect(removed).toEqual(expect.arrayContaining(["stub1", "stub2", "main"]));
    expect(d.wires.map((w) => w.id)).toContain("other");
    expect(d.wires.map((w) => w.id)).toContain("branch"); // still connects g3 to the drop wire
  });

  it("is recursive: orphans created by removing orphans are swept too (chains and T-branches)", () => {
    const d = emptyDocument();
    const g: ComponentInstance = { id: "g", type: "not", x: 0, y: 0, rotation: 0, props: {} };
    const keep: ComponentInstance = { id: "k", type: "not", x: 600, y: 300, rotation: 0, props: {} };
    d.components.push(g, keep);
    const o = pin(g, "out");
    // 4-wire chain from the deleted part, each wire only reachable through the previous one…
    d.wires.push({ id: "c1", points: [o, { x: o.x + 40, y: o.y }] });
    d.wires.push({ id: "c2", points: [{ x: o.x + 40, y: o.y }, { x: o.x + 40, y: o.y + 60 }] });
    d.wires.push({ id: "c3", points: [{ x: o.x + 40, y: o.y + 60 }, { x: o.x + 120, y: o.y + 60 }] });
    // …a branch T-junctioned onto the middle of c3 (orphaned only once c3 is gone)…
    d.wires.push({ id: "t1", points: [{ x: o.x + 80, y: o.y + 60 }, { x: o.x + 80, y: o.y + 140 }] });
    // …and a branch of that branch.
    d.wires.push({ id: "t2", points: [{ x: o.x + 80, y: o.y + 140 }, { x: o.x + 160, y: o.y + 140 }] });
    // An unrelated wire on the surviving part must stay.
    const ki = pin(keep, "in0");
    d.wires.push({ id: "safe", points: [{ x: ki.x - 60, y: ki.y }, ki] });
    const seeds = worldPins(g).map((p) => p.pos);
    d.components = d.components.filter((c) => c.id !== "g");
    const removed = sweepOrphanWires(d, seeds);
    expect(removed.sort()).toEqual(["c1", "c2", "c3", "t1", "t2"]);
    expect(d.wires.map((w) => w.id)).toEqual(["safe"]);
  });

  it("is controlled by the option (off keeps all wires)", () => {
    const store = new DocumentStore(build());
    store.setSelection(["g1"]);
    deleteSelectionInStore(store, { sweepOrphans: false });
    // no wire is deleted; the two end-to-end seams (drop+branch, stub1+stub2) merge into one wire each
    expect(store.doc.wires).toHaveLength(4);
    expect(store.doc.wires.map((w) => w.id).sort()).toEqual(["branch", "main", "other", "stub1"]);
    const store2 = new DocumentStore(build());
    store2.setSelection(["g1"]);
    deleteSelectionInStore(store2, { sweepOrphans: true });
    expect(store2.doc.wires.length).toBeLessThan(6);
    store2.undo();
    expect(store2.doc.wires).toHaveLength(6); // one undo restores part + wires
  });
});

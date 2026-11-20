import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { keepWiresAttached, nudgeSelectionInStore } from "../src/editor/doc-ops";
import { RouteObstacles } from "../src/editor/safe-route";

registerBuiltinComponents();
const pinOf = (d: SchematicDocument, id: string, p: string) =>
  worldPins(d.components.find((c) => c.id === id)!).find((q) => q.pin.id === p)!.pos;
const nets = (d: SchematicDocument) =>
  buildNetlist(d).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).sort();
const pts = (d: SchematicDocument, id: string) => JSON.stringify(d.wires.find((w) => w.id === id)?.points);

/**
 * One net, drawn by hand: a trunk wire from driver D to gate A, with branches T-junctioned onto
 * the trunk's interior, and a branch of a branch:
 *
 *   D ──●────────●──┐            trunk "wn" = D → A (several bends)
 *       │        │  │
 *       b2       b1 └──┐
 *       │        G1    └── A
 *       ●── w* → G3
 *       G2
 */
function chain(): DocumentStore {
  const s = new DocumentStore(emptyDocument());
  s.update("setup", (d) => {
    const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
    d.components.push(
      C("D", "input-pin", 0, 90),       // out (50,100)
      C("A", "and", 700, 390),          // in0 (700,400)
      C("G1", "and", 500, 190),         // in0 (500,200)
      C("G2", "and", 400, 590),         // in0 (400,600)
      C("G3", "and", 400, 490),         // in0 (400,500)
    );
    const D = pinOf(d, "D", "out"), A = pinOf(d, "A", "in0");
    d.wires.push({ id: "wn", points: [D, { x: 340, y: 100 }, { x: 340, y: 300 }, { x: 600, y: 300 }, { x: 600, y: 400 }, A] });
    d.wires.push({ id: "b1", points: [{ x: 340, y: 200 }, pinOf(d, "G1", "in0")] });                 // T onto wn (vertical)
    d.wires.push({ id: "b2", points: [{ x: 200, y: 100 }, { x: 200, y: 600 }, pinOf(d, "G2", "in0")] }); // T onto wn (first segment)
    d.wires.push({ id: "wstar", points: [{ x: 200, y: 500 }, pinOf(d, "G3", "in0")] });             // T onto b2
  });
  return s;
}

describe("re-routing a wire chain after its component moves", () => {
  it("never disconnects branches, and keeps every branch point where it was", () => {
    for (const [dx, dy] of [[0, -300], [0, -100], [0, 100], [-60, 0], [100, -200], [0, 200]]) {
      const s = chain();
      const before = nets(s.doc);
      const branches = ["b1", "b2", "wstar"].map((id) => pts(s.doc, id));
      s.setSelection(["A"]);
      nudgeSelectionInStore(s, dx, dy);
      expect(nets(s.doc), `move ${dx},${dy}`).toEqual(before);
      // the branches did not need to move: their shape is untouched
      expect(["b1", "b2", "wstar"].map((id) => pts(s.doc, id)), `move ${dx},${dy}`).toEqual(branches);
      const obs = new RouteObstacles(s.doc);
      for (const w of s.doc.wires) expect(obs.routeIsBad(w.points, new Set(s.doc.wires.map((x) => x.id))), `${w.id} after ${dx},${dy}`).toBe(false);
    }
  });

  it("same for moves done through keepWiresAttached (rotate / mirror / resize path)", () => {
    const s = chain();
    const before = nets(s.doc);
    s.update("move", (d) => {
      keepWiresAttached(d, new Set(["A"]), () => {
        const a = d.components.find((c) => c.id === "A")!;
        a.y -= 300;
      });
    });
    expect(nets(s.doc)).toEqual(before);
  });

  it("follows the chain when a branch point cannot survive: the part moved past it", () => {
    // A moves left past the trunk's last bends: the trunk would have to fold back over itself.
    const s = chain();
    const before = nets(s.doc);
    s.setSelection(["A"]);
    nudgeSelectionInStore(s, -320, -100); // in0 (380,300): left of the corner at x=600
    expect(nets(s.doc)).toEqual(before);
  });
});

describe("landing a dragged part back on its starting position", () => {
  it("leaves its wires exactly as they were (no free re-route that could drop a branch)", async () => {
    const { repairWires, sameNetWires } = await import("../src/editor/safe-route");
    const s = chain();
    const before = nets(s.doc);
    const shapes = JSON.stringify(s.doc.wires);
    // A drag frame whose delta is back to zero: the attached wire is "stretched" to its own
    // original shape and handed to the repair with improve — it must not be re-routed.
    s.update("drag back to start", (d) => {
      const wn = d.wires.find((w) => w.id === "wn")!;
      repairWires(d, ["wn"], undefined, {
        improve: true,
        nets: sameNetWires(d),
        before: new Map([["wn", wn.points.map((p) => ({ ...p }))]]),
      });
    });
    expect(nets(s.doc)).toEqual(before);
    expect(JSON.stringify(s.doc.wires)).toBe(shapes);
  });
});

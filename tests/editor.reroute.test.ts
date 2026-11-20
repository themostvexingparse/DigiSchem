import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { nudgeSelectionInStore } from "../src/editor/doc-ops";
import { RouteObstacles, safeRoute } from "../src/editor/safe-route";

registerBuiltinComponents();
const pin = (d: SchematicDocument, id: string, p: string) =>
  worldPins(d.components.find((c) => c.id === id)!).find((q) => q.pin.id === p)!.pos;
const nets = (d: SchematicDocument) =>
  buildNetlist(d).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).sort();

function circuit(): DocumentStore {
  const store = new DocumentStore(emptyDocument());
  store.update("setup", (d) => {
    const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
    d.components.push(C("a", "input-pin", 100, 100), C("b", "input-pin", 100, 200), C("g", "and", 300, 130),
      C("n", "not", 300, 300), C("o", "or", 500, 180), C("y", "output-pin", 700, 190));
    const add = (id: string, a: [string, string], b: [string, string]) => {
      const r = safeRoute(new RouteObstacles(d), pin(d, ...a), pin(d, ...b));
      if (r) d.wires.push({ id, points: r });
    };
    add("w1", ["a", "out"], ["g", "in0"]);
    add("w2", ["b", "out"], ["g", "in1"]);
    add("w3", ["g", "out"], ["o", "in0"]);
    add("w4", ["n", "out"], ["o", "in1"]);
    add("w5", ["o", "out"], ["y", "in"]);
  });
  return store;
}

function crossings(d: SchematicDocument): number {
  const obs = new RouteObstacles(d);
  return d.wires.reduce((n, w) => n + obs.crossings(w.points, new Set([w.id])), 0) / 2;
}

describe("re-routing wires after a component is displaced", () => {
  it("keeps every wire attached, never shorts nets, and adds no crossings", () => {
    const store = circuit();
    const before = nets(store.doc);
    store.setSelection(["g"]);
    // Moves never drop the gate on top of another part (coincident pins would connect by design).
    for (const [dx, dy] of [[0, 80], [-120, 0], [0, -200], [300, 100], [-120, -60]]) {
      nudgeSelectionInStore(store, dx, dy);
      const d = store.doc;
      expect(nets(d)).toEqual(before); // same connectivity: attached, and no accidental shorts
      const obs = new RouteObstacles(d);
      for (const w of d.wires) expect(obs.routeIsBad(w.points, new Set([w.id])), w.id).toBe(false);
      expect(crossings(d)).toBe(0);
    }
  });

  it("does not pile up bends: moving away and back restores a simple layout", () => {
    const store = circuit();
    const bends0 = store.doc.wires.reduce((n, w) => n + w.points.length - 2, 0);
    store.setSelection(["g"]);
    nudgeSelectionInStore(store, -140, 160);
    nudgeSelectionInStore(store, 140, -160);
    const bends1 = store.doc.wires.reduce((n, w) => n + w.points.length - 2, 0);
    expect(bends1).toBeLessThanOrEqual(bends0);
  });

  it("routes a second wire out of a pin that already has one (same net is not a short)", () => {
    const d = circuit().doc;
    // g.out already drives w3; y.in already has w5. Connecting them intentionally joins both nets.
    const r = safeRoute(new RouteObstacles(d), pin(d, "g", "out"), pin(d, "y", "in"), {
      sameNet: new Set(["w3", "w5"]),
    });
    expect(r).not.toBeNull();
    // Without declaring the nets, touching w3/w5 would count as a short and no route exists.
    expect(safeRoute(new RouteObstacles(d), pin(d, "g", "out"), pin(d, "y", "in"))).toBeNull();
  });

  it("re-routing a displaced part stays fast enough for live dragging", () => {
    const store = circuit();
    store.setSelection(["g"]);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) nudgeSelectionInStore(store, i % 2 ? 10 : -10, 10);
    expect((performance.now() - t0) / 10).toBeLessThan(60); // ms per drag step
  });
});

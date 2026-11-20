import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { nudgeSelectionInStore } from "../src/editor/doc-ops";
import { advancedSearchStats, RouteObstacles, safeRoute } from "../src/editor/safe-route";
import { getSettings, updateSettings } from "../src/model/settings";

registerBuiltinComponents();
const pin = (d: SchematicDocument, id: string, p: string) => worldPins(d.components.find((c) => c.id === id)!).find((q) => q.pin.id === p)!.pos;
const nets = (d: SchematicDocument) => buildNetlist(d).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).sort();
const crossings = (d: SchematicDocument) => { const o = new RouteObstacles(d); return d.wires.reduce((n, w) => n + o.crossings(w.points, new Set([w.id])), 0) / 2; };

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
    add("w1", ["a", "out"], ["g", "in0"]); add("w2", ["b", "out"], ["g", "in1"]); add("w3", ["g", "out"], ["o", "in0"]);
    add("w4", ["n", "out"], ["o", "in1"]); add("w5", ["o", "out"], ["y", "in"]);
  });
  return store;
}

describe("advanced (chess-engine style) re-routing search — opt-in setting", () => {
  const prev = getSettings().advancedRerouteSearch;
  beforeAll(() => updateSettings({ advancedRerouteSearch: true }));
  afterAll(() => updateSettings({ advancedRerouteSearch: prev }));

  it("is off by default", () => {
    expect(prev).toBe(false);
  });

  it("keeps every wire attached, never shorts, adds no crossings — and actually runs", () => {
    const store = circuit();
    const before = nets(store.doc);
    store.setSelection(["g"]);
    for (const [dx, dy] of [[0, 80], [-120, 0], [0, -200], [300, 100], [-120, -60]]) {
      nudgeSelectionInStore(store, dx, dy);
      const d = store.doc;
      expect(nets(d)).toEqual(before);
      const obs = new RouteObstacles(d);
      for (const w of d.wires) expect(obs.routeIsBad(w.points, new Set([w.id])), w.id).toBe(false);
      expect(crossings(d)).toBe(0);
    }
    const st = advancedSearchStats();
    expect(st).not.toBeNull();
    expect(st!.iterations).toBeGreaterThan(0);
  });

  it("stays within a drag-frame budget on a multi-wire move", () => {
    const store = circuit();
    store.setSelection(["g", "n"]);
    const t = performance.now();
    nudgeSelectionInStore(store, 0, 60);
    expect(performance.now() - t).toBeLessThan(150);
  });
});

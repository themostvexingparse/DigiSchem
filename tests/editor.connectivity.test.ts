import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { parseProject, serializeProject } from "../src/io/project";
import { mirrorSelectionInStore, nudgeSelectionInStore, rotateSelectionInStore } from "../src/editor/doc-ops";
import { RouteObstacles, safeRoute } from "../src/editor/safe-route";
import { connectionConflicts } from "../src/model/links";
import { packSchematic } from "../src/layout/pack";

registerBuiltinComponents();
const pin = (d: SchematicDocument, id: string, p: string) => worldPins(d.components.find((c) => c.id === id)!).find((q) => q.pin.id === p)!.pos;
const nets = (d: SchematicDocument, mode: "auto" | "geometric" = "auto") =>
  buildNetlist(d, mode).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).filter(Boolean).sort();

function twoGates(): DocumentStore {
  const s = new DocumentStore(emptyDocument());
  s.update("setup", (d) => {
    const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
    d.components.push(C("a", "input-pin", 0, 100), C("b", "input-pin", 0, 300), C("g1", "and", 300, 90), C("g2", "and", 300, 290),
      C("y1", "output-pin", 600, 100), C("y2", "output-pin", 600, 300));
    const add = (id: string, a: [string, string], b: [string, string]) => {
      const r = safeRoute(new RouteObstacles(d), pin(d, ...a), pin(d, ...b));
      if (r) d.wires.push({ id, points: r });
    };
    add("w1", ["a", "out"], ["g1", "in0"]); add("w2", ["b", "out"], ["g2", "in0"]);
    add("w3", ["g1", "out"], ["y1", "in"]); add("w4", ["g2", "out"], ["y2", "in"]);
  });
  return s;
}

describe("connections are preserved whatever the drawing does", () => {
  it("dropping a part onto another part's wires keeps both nets; moving it away restores the drawing", () => {
    const s = twoGates();
    const before = nets(s.doc);
    expect(connectionConflicts(s.doc)).toEqual([]);
    s.setSelection(["g2"]);
    nudgeSelectionInStore(s, 0, -200); // g2 lands right on top of g1 and its wires
    expect(nets(s.doc)).toEqual(before); // logical connectivity unchanged
    expect(nets(s.doc, "geometric")).not.toEqual(before); // the drawing now shorts things…
    expect(connectionConflicts(s.doc).length).toBeGreaterThan(0); // …which is reported
    nudgeSelectionInStore(s, 0, 200); // back where it was
    expect(nets(s.doc)).toEqual(before);
    expect(nets(s.doc, "geometric")).toEqual(before);
    expect(connectionConflicts(s.doc)).toEqual([]);
  });

  it("piling wires on top of each other and pulling them apart never joins or loses a connection", () => {
    const s = twoGates();
    const before = nets(s.doc);
    // move the whole lower row onto the upper row (all its wires overlap the upper ones)
    s.setSelection(["b", "g2", "y2", "w2", "w4"]);
    nudgeSelectionInStore(s, 0, -200);
    expect(nets(s.doc)).toEqual(before);
    expect(connectionConflicts(s.doc).length).toBeGreaterThan(0);
    nudgeSelectionInStore(s, 0, 200);
    expect(nets(s.doc)).toEqual(before);
    expect(connectionConflicts(s.doc)).toEqual([]);
  });

  it("a wire that collapses (pin moved onto its other end) survives and stretches back out", () => {
    const s = twoGates();
    const before = nets(s.doc);
    const g1in = pin(s.doc, "g1", "in0"), aout = pin(s.doc, "a", "out");
    s.setSelection(["g1", "w3", "y1"]);
    nudgeSelectionInStore(s, aout.x - g1in.x, aout.y - g1in.y); // g1.in0 lands exactly on a.out
    expect(s.doc.wires.some((w) => w.id === "w1")).toBe(true);
    expect(nets(s.doc)).toEqual(before);
    nudgeSelectionInStore(s, g1in.x - aout.x, g1in.y - aout.y);
    expect(nets(s.doc)).toEqual(before);
    expect(nets(s.doc, "geometric")).toEqual(before);
  });

  it("connections survive save / load and undo / redo", () => {
    const s = twoGates();
    const before = nets(s.doc);
    s.setSelection(["g2"]);
    nudgeSelectionInStore(s, 0, -200);
    const loaded = new DocumentStore(parseProject(serializeProject(s.doc)));
    expect(nets(loaded.doc)).toEqual(before); // the conflicting layout loads with its connections
    expect(connectionConflicts(loaded.doc).length).toBeGreaterThan(0);
    s.undo();
    expect(nets(s.doc)).toEqual(before);
    s.redo();
    expect(nets(s.doc)).toEqual(before);
  });

  it("new items still connect by touch (drawing a wire, placing a part)", () => {
    const s = twoGates();
    s.update("Add wire", (d) => {
      d.wires.push({ id: "w5", points: [pin(d, "a", "out"), { x: 80, y: 110 }, { x: 80, y: 320 }, pin(d, "g2", "in1")] });
    });
    const n = buildNetlist(s.doc).nets.find((x) => x.pins.some((p) => p.componentId === "a"))!;
    expect(n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort()).toEqual(["a.out", "g1.in0", "g2.in1"]);
  });

  it("randomized: hundreds of moves / rotations / mirrors on real circuits never change a connection", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const f of ["04-sync-counter", "05-datapath", "03-ripple-carry-adder"]) {
      const tidy = packSchematic(parseProject(readFileSync(`samples/compaction/${f}.dschem`, "utf8")), { timeBudgetMs: 600 }).doc;
      const s = new DocumentStore(tidy);
      const before = nets(s.doc);
      const ids = s.doc.components.map((c) => c.id);
      for (let i = 0; i < 120; i++) {
        const k = 1 + Math.floor(rnd() * 3);
        const sel = Array.from({ length: k }, () => ids[Math.floor(rnd() * ids.length)]);
        s.setSelection(sel);
        const op = rnd();
        if (op < 0.75) nudgeSelectionInStore(s, Math.round((rnd() - 0.5) * 30) * 10, Math.round((rnd() - 0.5) * 30) * 10);
        else if (op < 0.9) rotateSelectionInStore(s);
        else mirrorSelectionInStore(s);
        expect(nets(s.doc), `${f} step ${i}`).toEqual(before);
      }
    }
  }, 120000);
});

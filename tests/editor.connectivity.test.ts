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

describe("reading connections from a drawing, and moves that land on other wires", () => {
  it("an overlap that shorts two outputs in an old drawing is not taken as a connection", () => {
    const d = emptyDocument("old drawing");
    const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
    d.components.push(C("i1", "input-pin", 0, 90), C("i2", "input-pin", 0, 290), C("g1", "and", 400, 90), C("g2", "and", 400, 290));
    // both wires run vertically on x=200 and overlap between y=200 and 210 (as in the user's file)
    d.wires.push({ id: "a", points: [pin(d, "i1", "out"), { x: 200, y: 100 }, { x: 200, y: 210 }, { x: 380, y: 210 }, { x: 380, y: 100 }, pin(d, "g1", "in0")] });
    d.wires.push({ id: "b", points: [pin(d, "i2", "out"), { x: 200, y: 300 }, { x: 200, y: 200 }, { x: 360, y: 200 }, { x: 360, y: 320 }, pin(d, "g2", "in1")] });
    const geoNet = buildNetlist(d, "geometric").nets.find((n) => n.pins.some((p) => p.componentId === "i1"))!;
    expect(geoNet.pins.length).toBe(4); // the drawing shorts i1 and i2
    const s = new DocumentStore(d);
    const n1 = buildNetlist(s.doc).nets.find((n) => n.pins.some((p) => p.componentId === "i1"))!;
    expect(n1.pins.map((p) => `${p.componentId}.${p.pinId}`).sort()).toEqual(["g1.in0", "i1.out"]);
    expect(connectionConflicts(s.doc).some((c) => c.kind === "unintended")).toBe(true);
  });

  it("a passing wire that a moved part's pin lands on is re-routed around it", () => {
    const s = new DocumentStore(emptyDocument());
    s.update("setup", (d) => {
      const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
      d.components.push(C("i", "input-pin", 0, 290), C("o", "output-pin", 700, 290), C("g", "and", 300, 90), C("x", "input-pin", 0, 90));
      d.wires.push({ id: "pass", points: [pin(d, "i", "out"), pin(d, "o", "in")] }); // horizontal at y=300
      d.wires.push({ id: "gi", points: [pin(d, "x", "out"), pin(d, "g", "in0")] });
    });
    const before = nets(s.doc);
    s.setSelection(["g"]);
    nudgeSelectionInStore(s, 0, 200); // g's pins now sit right on the passing wire's line
    expect(nets(s.doc)).toEqual(before);
    expect(connectionConflicts(s.doc).filter((c) => c.kind === "unintended")).toEqual([]);
  });

  it("a junction between two wires of the same moved part survives the move", () => {
    const s = new DocumentStore(emptyDocument());
    s.update("setup", (d) => {
      const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
      d.components.push(C("src", "input-pin", 0, 90), C("g", "and", 300, 190));
      // both inputs of g on one net: w1 goes to in0 via a corner, w2 branches from w1's corner to in1
      d.wires.push({ id: "w1", points: [pin(d, "src", "out"), { x: 240, y: 100 }, { x: 240, y: 200 }, pin(d, "g", "in0")] });
      d.wires.push({ id: "w2", points: [pin(d, "g", "in1"), { x: 260, y: 220 }, { x: 260, y: 200 }] });
    });
    const before = nets(s.doc);
    s.setSelection(["g"]);
    nudgeSelectionInStore(s, 0, 10);
    expect(nets(s.doc)).toEqual(before);
    expect(nets(s.doc, "geometric")).toEqual(before);
  });
});

describe("compaction cleans up drawing conflicts first", () => {
  it("an overlap between two nets in an opened drawing is removed, connections unchanged", async () => {
    const { packSchematic, validateCompaction } = await import("../src/layout/pack");
    const d = emptyDocument("overlap");
    const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
    // like the user's MUX6.Y / D6 case: two different nets share the vertical lane x=430
    d.components.push(C("m", "and", 300, 90), C("src", "input-pin", 0, 290), C("g", "and", 500, 90), C("h", "and", 500, 290));
    d.wires.push({ id: "y", points: [pin(d, "m", "out"), { x: 430, y: 110 }, { x: 430, y: 40 }, { x: 480, y: 40 }, { x: 480, y: 100 }, pin(d, "g", "in0")] });
    d.wires.push({ id: "in", points: [pin(d, "src", "out"), { x: 430, y: 300 }, { x: 430, y: 100 }, { x: 460, y: 100 }, { x: 460, y: 300 }, pin(d, "h", "in0")] });
    const s = new DocumentStore(d);
    const before = nets(s.doc);
    expect(connectionConflicts(s.doc).some((c) => c.kind === "unintended")).toBe(true);
    const r = packSchematic(s.doc as SchematicDocument, { timeBudgetMs: 600 });
    expect(r.conflictsFixed).toBeGreaterThan(0);
    expect(Number.isFinite(r.qualityBefore.total)).toBe(true);
    expect(validateCompaction(s.doc as SchematicDocument, r)).toEqual([]);
    const after = { ...r.doc, links: s.doc.links };
    expect(connectionConflicts(after).filter((c) => c.kind === "unintended")).toEqual([]);
    expect(nets(after)).toEqual(before);
    expect(nets(after, "geometric")).toEqual(before);
  }, 30000);
});

describe("moves never visually break a stored connection", () => {
  it("random moves on real circuits leave no broken connections in the drawing", async () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const f of ["04-sync-counter", "05-datapath", "06-annotated-lab"]) {
      const tidy = packSchematic(parseProject(readFileSync(`samples/compaction/${f}.dschem`, "utf8")), { timeBudgetMs: 500 }).doc;
      const base = new DocumentStore(tidy).doc;
      const pre = connectionConflicts(base).filter((c) => c.kind === "broken").length;
      const ids = base.components.map((c) => c.id);
      for (let i = 0; i < 40; i++) {
        const s = new DocumentStore(structuredClone(base));
        s.setSelection([ids[Math.floor(rnd() * ids.length)]]);
        nudgeSelectionInStore(s, Math.round((rnd() - 0.5) * 16) * 10, Math.round((rnd() - 0.5) * 16) * 10);
        expect(connectionConflicts(s.doc).filter((c) => c.kind === "broken").length, `${f} move ${i}`).toBeLessThanOrEqual(pre);
      }
    }
  }, 120000);
});

// Regressions found by the randomized store fuzz (tests/fuzz.store.test.ts).
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { buildNetlist } from "../src/io/netlist";
import { parseProject, serializeProject } from "../src/io/project";
import { deleteSelectionInStore, duplicateSelectionInStore } from "../src/editor/doc-ops";
import { sprawled } from "./helpers/sprawl";
import { mergeWireSeams } from "../src/model/merge";
import { pathLoopCuts, pathOverlapsItself } from "../src/editor/wire-utils";
import { untangleWires } from "../src/editor/safe-route";

registerBuiltinComponents();
const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
const nets = (d: SchematicDocument) =>
  buildNetlist(d).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).filter((s) => s.includes(",")).sort();

describe("store fuzz regressions", () => {
  it("orphan sweep never removes a wire that still connects two surviving pins", () => {
    // g.out -> y.in is a stored connection whose drawing is broken (y moved away), and the wire
    // also ends on the pin of part `z` that gets deleted.
    const d = emptyDocument();
    d.components.push(C("g", "and", 0, 0), C("y", "output-pin", 400, 300), C("z", "output-pin", 300, 0));
    d.wires.push({ id: "w", points: [{ x: 90, y: 10 }, { x: 300, y: 10 }] });
    d.links = [["p:g|out", "w:w"], ["p:y|in", "w:w"], ["p:z|in", "w:w"]];
    const s = new DocumentStore(d);
    expect(nets(s.doc)).toEqual(["g.out,y.in,z.in"]);
    s.setSelection(["z"]);
    deleteSelectionInStore(s, { sweepOrphans: true });
    expect(s.doc.wires.map((w) => w.id)).toEqual(["w"]);
    expect(nets(s.doc)).toEqual(["g.out,y.in"]);
  });

  it("deleting a part keeps what was connected through its pins connected", () => {
    const d = emptyDocument();
    d.components.push(C("a", "and", 0, 0), C("b", "and", 300, 0), C("hub", "and", 0, 0));
    d.links = [["p:a|in0", "p:hub|in0"], ["p:b|in0", "p:hub|in0"]];
    const s = new DocumentStore(d);
    s.setSelection(["hub"]);
    deleteSelectionInStore(s);
    expect(nets(s.doc)).toEqual(["a.in0,b.in0"]);
  });

  it("a zero-length wire that carries connections survives save / load", () => {
    const d = emptyDocument();
    d.components.push(C("a", "input-pin", 0, 0), C("g", "and", 300, 0));
    d.wires.push({ id: "w", points: [{ x: 50, y: 10 }, { x: 50, y: 10 }] });
    d.links = [["p:a|out", "w:w"], ["p:g|in0", "w:w"]];
    const back = parseProject(serializeProject(d));
    expect(back.wires.map((w) => w.id)).toEqual(["w"]);
    expect(nets(back)).toEqual(nets(d));
  });

  it("two overlapping wires meeting end to end are not merged into one self-overlapping wire", () => {
    const d = emptyDocument();
    d.wires.push(
      { id: "a", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }] },
      { id: "b", points: [{ x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 0 }, { x: 80, y: 0 }] },
    );
    d.links = [["w:a", "w:b"]];
    expect(mergeWireSeams(d)).toBe(0);
    expect(d.wires.length).toBe(2);
  });

  it("a wire looping back over itself is cut short, unless something is attached to the loop", () => {
    const loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 0 }, { x: 40, y: 0 }];
    expect(pathOverlapsItself(loop)).toBe(true);
    expect(pathLoopCuts(loop)[0]).toEqual([{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    const d = emptyDocument();
    d.wires.push({ id: "w", points: loop.map((p) => ({ ...p })) });
    d.links = [];
    untangleWires(d, ["w"]);
    expect(d.wires[0].points).toEqual([{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    // a branch hanging off the loop keeps it
    const e = emptyDocument();
    e.wires.push({ id: "w", points: loop.map((p) => ({ ...p })) }, { id: "x", points: [{ x: 150, y: 30 }, { x: 150, y: 80 }] });
    e.links = [["w:w", "w:x"]];
    untangleWires(e, ["w"]);
    expect(e.wires[0].points).toEqual(loop);
  });

  it("a duplicate keeps its internal connections and never joins the circuit it lands on", () => {
    const s = new DocumentStore(sprawled(1, 3, 4));
    const g = "g1_0";
    const own = s.doc.wires.filter((w) => s.doc.links!.some(([a, b]) => [a, b].includes(`w:${w.id}`) && [a, b].some((t) => t.startsWith(`p:${g}|`))));
    s.setSelection([g, ...own.map((w) => w.id)]);
    const fresh = new Set(duplicateSelectionInStore(s));
    const nl = buildNetlist(s.doc as SchematicDocument);
    // no net mixes copied and original pins
    for (const n of nl.nets) {
      const kinds = new Set(n.pins.map((p) => fresh.has(p.componentId)));
      expect(kinds.size).toBeLessThanOrEqual(1);
    }
    // each copied wire is still connected to the copied gate
    const copyGate = [...fresh].find((id) => s.doc.components.some((c) => c.id === id))!;
    for (const w of s.doc.wires.filter((x) => fresh.has(x.id))) {
      expect(s.doc.links!.some(([a, b]) => [a, b].includes(`w:${w.id}`) && [a, b].some((t) => t.startsWith(`p:${copyGate}|`)))).toBe(true);
    }
  });

  it("a new wire running over an old wire's end does not short two outputs (its own end would)", () => {
    const d = emptyDocument();
    d.components.push(C("a", "input-pin", 0, 90), C("b", "input-pin", 0, 190)); // outs at (50,100), (50,200)
    d.wires.push({ id: "wa", points: [{ x: 50, y: 100 }, { x: 150, y: 100 }] });
    const s = new DocumentStore(d);
    // drawn from b.out, running up through the end of wa (150,100) — an accident of the route
    s.update("draw", (x) => x.wires.push({ id: "wb", points: [{ x: 50, y: 200 }, { x: 150, y: 200 }, { x: 150, y: 50 }] }));
    expect(nets(s.doc)).toEqual([]);
    // drawn ONTO wa (its own end lands there): that is what the user drew
    s.update("draw2", (x) => x.wires.push({ id: "wc", points: [{ x: 50, y: 200 }, { x: 100, y: 200 }, { x: 100, y: 100 }] }));
    expect(nets(s.doc)).toEqual(["a.out,b.out"]);
  });
});


import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { nudgeSelectionInStore } from "../src/editor/doc-ops";

registerBuiltinComponents();
const pin = (d: SchematicDocument, id: string, p: string) => worldPins(d.components.find((c) => c.id === id)!).find((q) => q.pin.id === p)!.pos;
const nets = (d: SchematicDocument) => buildNetlist(d).nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).filter(Boolean).sort();
const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });

function base(): DocumentStore {
  const s = new DocumentStore(emptyDocument());
  s.update("setup", (d) => {
    d.components.push(C("a", "input-pin", 0, 90), C("g", "and", 400, 190), C("h", "and", 400, 390));
  });
  return s;
}

describe("wires drawn end to end merge into one", () => {
  it("drawing a wire onward from the free end of another merges them, keeping connections", () => {
    const s = base();
    s.update("Add wire", (d) => d.wires.push({ id: "w1", points: [pin(d, "a", "out"), { x: 200, y: 100 }] }));
    s.update("Add wire", (d) => d.wires.push({ id: "w2", points: [{ x: 200, y: 100 }, { x: 200, y: 200 }, pin(d, "g", "in0")] }));
    expect(s.doc.wires.map((w) => w.id)).toEqual(["w1"]);
    expect(s.doc.wires[0].points).toEqual([pin(s.doc, "a", "out"), { x: 200, y: 100 }, { x: 200, y: 200 }, pin(s.doc, "g", "in0")]);
    expect(nets(s.doc)).toContain("a.out,g.in0");
    expect(s.doc.links!.some(([x, y]) => x === "w:w2" || y === "w:w2")).toBe(false);
    s.undo(); // one undo separates them again
    expect(s.doc.wires.map((w) => w.id)).toEqual(["w1"]);
    expect(s.doc.wires[0].points).toEqual([pin(s.doc, "a", "out"), { x: 200, y: 100 }]);
  });

  it("straight continuations collapse into a single segment", () => {
    const s = base();
    s.update("w", (d) => d.wires.push({ id: "w1", points: [pin(d, "a", "out"), { x: 150, y: 100 }] }));
    s.update("w", (d) => d.wires.push({ id: "w2", points: [{ x: 150, y: 100 }, { x: 300, y: 100 }] }));
    expect(s.doc.wires).toHaveLength(1);
    expect(s.doc.wires[0].points).toEqual([pin(s.doc, "a", "out"), { x: 300, y: 100 }]);
  });

  it("does NOT merge at a junction (third wire), at a pin, across different widths, or across a conflict", () => {
    const s = base();
    s.update("w", (d) => {
      d.wires.push({ id: "w1", points: [pin(d, "a", "out"), { x: 200, y: 100 }] });
      d.wires.push({ id: "w2", points: [{ x: 200, y: 100 }, { x: 200, y: 200 }, pin(d, "g", "in0")] });
      d.wires.push({ id: "w3", points: [{ x: 200, y: 100 }, { x: 200, y: 50 }] }); // a third wire at the joint
    });
    expect(s.doc.wires).toHaveLength(3);
    // two wires meeting on a pin stay separate
    const s2 = base();
    s2.update("w", (d) => {
      d.wires.push({ id: "p1", points: [pin(d, "a", "out"), { x: 50, y: 100 }].slice(0, 1).concat([{ x: 100, y: 100 }]) });
      d.wires.push({ id: "p2", points: [pin(d, "g", "in0"), { x: 300, y: 200 }] });
      d.wires.push({ id: "p3", points: [{ x: 300, y: 300 }, pin(d, "g", "in0")] });
    });
    expect(s2.doc.wires.map((w) => w.id).sort()).toEqual(["p1", "p2", "p3"]);
    // different bus widths
    const s3 = base();
    s3.update("w", (d) => {
      d.wires.push({ id: "b1", points: [{ x: 600, y: 100 }, { x: 700, y: 100 }], width: 8 });
      d.wires.push({ id: "b2", points: [{ x: 700, y: 100 }, { x: 800, y: 100 }], width: 1 });
    });
    expect(s3.doc.wires).toHaveLength(2);
  });

  it("dragging a part leaves seams alone mid-drag but merges once the gesture ends (one undo step)", () => {
    const s = base();
    s.update("w", (d) => {
      d.wires.push({ id: "w1", points: [pin(d, "a", "out"), { x: 200, y: 100 }] });
    });
    s.beginGesture();
    s.update("drag", (d) => d.wires.push({ id: "w2", points: [{ x: 200, y: 100 }, { x: 200, y: 200 }, pin(d, "g", "in0")] }));
    expect(s.doc.wires).toHaveLength(2); // mid-gesture: untouched
    s.endGesture();
    expect(s.doc.wires).toHaveLength(1);
    s.undo();
    expect(s.doc.wires).toHaveLength(1);
    expect(s.doc.wires[0].id).toBe("w1");
  });

  it("merged wires still follow their part when it moves", () => {
    const s = base();
    s.update("w", (d) => d.wires.push({ id: "w1", points: [pin(d, "a", "out"), { x: 200, y: 100 }] }));
    s.update("w", (d) => d.wires.push({ id: "w2", points: [{ x: 200, y: 100 }, { x: 200, y: 200 }, pin(d, "g", "in0")] }));
    const before = nets(s.doc);
    s.setSelection(["g"]);
    nudgeSelectionInStore(s, 60, 80);
    expect(nets(s.doc)).toEqual(before);
    expect(buildNetlist(s.doc, "geometric").nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(",")).filter(Boolean).sort()).toEqual(before);
  });
});

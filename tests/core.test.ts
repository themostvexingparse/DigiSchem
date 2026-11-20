import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument } from "../src/model/types";
import { worldPins, junctionPoints } from "../src/model/geometry";
import { renderDocumentSvg } from "../src/render/svg";
import { getDef } from "../src/model/registry";
import { DocumentStore } from "../src/model/store";

registerBuiltinComponents();

describe("core", () => {
  it("parametric pins follow props", () => {
    const def = getDef("and")!;
    expect(def.geometry({ inputs: 2 }).pins.filter((p) => p.dir === "in")).toHaveLength(2);
    expect(def.geometry({ inputs: 7 }).pins.filter((p) => p.dir === "in")).toHaveLength(7);
  });
  it("all pins on grid under rotation", () => {
    for (const rot of [0, 90, 180, 270] as const)
      for (const p of worldPins({ id: "a", type: "and", x: 100, y: 100, rotation: rot, props: { inputs: 3 } }))
        expect([p.pos.x % 10, p.pos.y % 10]).toEqual([0, 0]);
  });
  it("junction at T", () => {
    const d = emptyDocument();
    d.wires.push({ id: "w1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    d.wires.push({ id: "w2", points: [{ x: 50, y: 0 }, { x: 50, y: 50 }] });
    expect(junctionPoints(d)).toEqual([{ x: 50, y: 0 }]);
  });
  it("renders svg", () => {
    const d = emptyDocument();
    d.components.push({ id: "g1", type: "nand", x: 0, y: 0, rotation: 0, props: { inputs: 3 }, label: "U1" });
    const svg = renderDocumentSvg(d);
    expect(svg).toContain("<svg");
    expect(svg).toContain("U1");
  });
  it("undo/redo and gestures", () => {
    const s = new DocumentStore();
    s.beginGesture();
    s.update("a", (d) => d.texts.push({ id: "t", x: 0, y: 0, text: "a" }));
    s.update("b", (d) => (d.texts[0].x = 50));
    s.endGesture();
    s.undo();
    expect(s.doc.texts).toHaveLength(0);
    s.redo();
    expect(s.doc.texts[0].x).toBe(50);
  });
});

import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { routePinAware, pinExitVector } from "../src/editor/wire-utils";
import { keepWiresAttached, rotateSelectionInDoc } from "../src/editor/doc-ops";
import { emptyDocument, type Point } from "../src/model/types";
import { pointOnSegment, worldPins } from "../src/model/geometry";

registerBuiltinComponents();

const segs = (pts: Point[]) => pts.slice(1).map((p, i) => [pts[i], p] as const);

describe("pin-aware routing", () => {
  it("enters a left-facing input pin horizontally (no run along the gate's input edge)", () => {
    // Input pin out at (230,220) exits right; AND in1 at (410,330) exits left.
    const pts = routePinAware({ x: 230, y: 220 }, { x: 1, y: 0 }, { x: 410, y: 330 }, { x: -1, y: 0 });
    const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
    expect(a.y).toBe(b.y); // last segment horizontal
    expect(a.x).toBeLessThan(b.x); // arrives from the left
    // must not pass over the other input pin at (410,310)
    expect(segs(pts).some(([p, q]) => pointOnSegment({ x: 410, y: 310 }, p, q))).toBe(false);
  });

  it("adds an escape stub when the target lies behind the pin", () => {
    const pts = routePinAware({ x: 100, y: 100 }, { x: 1, y: 0 }, { x: 40, y: 160 }, null);
    expect(pts[1]).toEqual({ x: 120, y: 100 });
    for (const [p, q] of segs(pts)) expect(p.x === q.x || p.y === q.y).toBe(true);
  });

  it("pin exit vector follows rotation and mirror", () => {
    const base = { id: "a", type: "and", x: 0, y: 0, props: {} };
    expect(pinExitVector({ ...base, rotation: 0 }, "left")).toEqual({ x: -1, y: 0 });
    expect(pinExitVector({ ...base, rotation: 90 }, "left")).toEqual({ x: 0, y: -1 });
    expect(pinExitVector({ ...base, rotation: 0, mirror: true }, "left")).toEqual({ x: 1, y: 0 });
  });
});

describe("wires follow transformed components", () => {
  it("rotation keeps attached wire endpoints on their pins", () => {
    const d = emptyDocument();
    d.components.push({ id: "g", type: "and", x: 200, y: 200, rotation: 0, props: { inputs: 2 } });
    const pins = worldPins(d.components[0]);
    const in0 = pins.find((p) => p.pin.id === "in0")!.pos;
    d.wires.push({ id: "w", points: [{ x: 100, y: in0.y }, in0] });
    const sel = new Set(["g"]);
    keepWiresAttached(d, sel, () => rotateSelectionInDoc(d, sel), sel);
    const newIn0 = worldPins(d.components[0]).find((p) => p.pin.id === "in0")!.pos;
    const w = d.wires[0].points;
    expect(w[w.length - 1]).toEqual(newIn0);
    expect(w[0]).toEqual({ x: 100, y: in0.y });
    for (const [p, q] of segs(w)) expect(p.x === q.x || p.y === q.y).toBe(true);
  });

  it("rotating a wired gate never leaves a wire running over another pin", () => {
    const d = emptyDocument();
    d.components.push({ id: "g", type: "and", x: 410, y: 290, rotation: 0, props: { inputs: 2 } });
    d.wires.push({ id: "w1", points: [{ x: 230, y: 220 }, { x: 320, y: 220 }, { x: 320, y: 310 }, { x: 410, y: 310 }] });
    d.wires.push({ id: "w2", points: [{ x: 230, y: 440 }, { x: 320, y: 440 }, { x: 320, y: 330 }, { x: 410, y: 330 }] });
    const sel = new Set(["g"]);
    for (let turn = 0; turn < 4; turn++) {
      keepWiresAttached(d, sel, () => rotateSelectionInDoc(d, sel), sel);
      const pins = worldPins(d.components[0]);
      for (const w of d.wires) {
        const ends = [w.points[0], w.points[w.points.length - 1]];
        for (const wp of pins) {
          if (ends.some((e) => e.x === wp.pos.x && e.y === wp.pos.y)) continue;
          expect(segs(w.points).some(([p, q]) => pointOnSegment(wp.pos, p, q)), `turn ${turn} ${w.id} over ${wp.pin.id}`).toBe(false);
        }
        expect(pins.some((wp) => wp.pos.x === ends[1].x && wp.pos.y === ends[1].y)).toBe(true);
      }
    }
  });

  it("changing a count prop keeps wires on surviving pins", () => {
    const d = emptyDocument();
    d.components.push({ id: "g", type: "and", x: 200, y: 200, rotation: 0, props: { inputs: 2 } });
    const out = worldPins(d.components[0]).find((p) => p.pin.id === "out")!.pos;
    d.wires.push({ id: "w", points: [out, { x: out.x + 50, y: out.y }] });
    keepWiresAttached(d, new Set(["g"]), () => { d.components[0].props.inputs = 6; });
    const newOut = worldPins(d.components[0]).find((p) => p.pin.id === "out")!.pos;
    expect(d.wires[0].points[0]).toEqual(newOut);
  });
});

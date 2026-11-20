import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument, type ComponentInstance, type Point, type SchematicDocument } from "../src/model/types";
import { registerComponent, getDef } from "../src/model/registry";
import type { ComponentDef, PinDef } from "../src/model/component-def";
import { GRID, propNum } from "../src/model/component-def";
import { DocumentStore } from "../src/model/store";
import { junctionPoints, worldPins } from "../src/model/geometry";
import {
  buildWirePreview,
  captureAttachedWires,
  dragWireSegmentPoints,
  findPinAt,
  findSnapTarget,
  hitTestComponent,
  hitTestDocument,
  hitTestText,
  hitTestWire,
  isPointAnchored,
  itemsInRect,
  nextAutoLabel,
  nextCopyLabel,
  normalizeDocWires,
  normalizeWire,
  normalizeWirePoints,
  pinExitHorizontal,
  routeOrthogonal,
  segmentIntersectsRect,
  stretchWireForMove,
  stretchWireStart,
} from "../src/editor/wire-utils";
import {
  centeredOriginForPlacement,
  copySelectionFromDoc,
  deleteSelectionInStore,
  duplicateSelectionInStore,
  mirrorSelectionInDoc,
  nudgeSelectionInStore,
  pasteClipboardIntoStore,
  placeComponentInStore,
  rotatePointCW,
  rotateSelectionInDoc,
  setComponentRotationInDoc,
} from "../src/editor/doc-ops";

registerBuiltinComponents();

function assertOrthogonal(pts: Point[]): void {
  expect(pts.length).toBeGreaterThanOrEqual(2);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    expect(a.x === b.x || a.y === b.y).toBe(true);
    expect(a.x === b.x && a.y === b.y).toBe(false);
  }
}

describe("wire normalization", () => {
  it("drops zero-length consecutive duplicate points", () => {
    const pts = normalizeWirePoints([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 30 },
    ]);
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 30 },
    ]);
  });

  it("merges collinear horizontal and vertical consecutive points", () => {
    const pts = normalizeWirePoints([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 10 },
      { x: 60, y: 40 },
    ]);
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
    ]);
  });

  it("collapses fold-backs and cascading collinear segments", () => {
    const fold = normalizeWirePoints([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 40, y: 0 },
      { x: 80, y: 0 },
    ]);
    expect(fold).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);

    const collapsed = normalizeWire({
      id: "w1",
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 10, y: 10 },
      ],
    });
    expect(collapsed).toBeNull();
  });

  it("normalizeDocWires drops degenerate wires and normalizes valid ones", () => {
    const doc = emptyDocument();
    doc.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 }] },
      { id: "w2", points: [{ x: 20, y: 20 }, { x: 20, y: 20 }] },
    );
    normalizeDocWires(doc);
    expect(doc.wires).toHaveLength(1);
    expect(doc.wires[0].points).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
  });
});

describe("orthogonal routing", () => {
  it("routes straight axis-aligned segments without unnecessary bends", () => {
    expect(routeOrthogonal({ x: 0, y: 10 }, { x: 50, y: 10 }, true)).toEqual([
      { x: 0, y: 10 },
      { x: 50, y: 10 },
    ]);
    expect(routeOrthogonal({ x: 20, y: 0 }, { x: 20, y: 60 }, false)).toEqual([
      { x: 20, y: 0 },
      { x: 20, y: 60 },
    ]);
    expect(routeOrthogonal({ x: 10, y: 10 }, { x: 10, y: 10 }, true)).toEqual([{ x: 10, y: 10 }]);
  });

  it("routes L-shaped Manhattan paths in both H-first and V-first orientations", () => {
    const hFirst = routeOrthogonal({ x: 10, y: 20 }, { x: 70, y: 60 }, true);
    expect(hFirst).toEqual([
      { x: 10, y: 20 },
      { x: 70, y: 20 },
      { x: 70, y: 60 },
    ]);
    assertOrthogonal(hFirst);

    const vFirst = routeOrthogonal({ x: 10, y: 20 }, { x: 70, y: 60 }, false);
    expect(vFirst).toEqual([
      { x: 10, y: 20 },
      { x: 10, y: 60 },
      { x: 70, y: 60 },
    ]);
    assertOrthogonal(vFirst);
  });

  it("buildWirePreview extends and normalizes multi-bend drafts", () => {
    const preview = buildWirePreview(
      [{ x: 0, y: 0 }, { x: 40, y: 0 }],
      { x: 90, y: 30 },
      true,
    );
    expect(preview).toEqual([
      { x: 0, y: 0 },
      { x: 90, y: 0 },
      { x: 90, y: 30 },
    ]);
    assertOrthogonal(preview);
  });

  it("pinExitHorizontal accounts for component rotation", () => {
    const comp: ComponentInstance = { id: "c1", type: "and", x: 0, y: 0, rotation: 0, props: {} };
    expect(pinExitHorizontal(comp, "left")).toBe(true);
    expect(pinExitHorizontal(comp, "top")).toBe(false);
    comp.rotation = 90;
    expect(pinExitHorizontal(comp, "left")).toBe(false);
    expect(pinExitHorizontal(comp, "top")).toBe(true);
  });
});

describe("rubber-band wire stretching", () => {
  it("keeps 2-point horizontal wire straight when moving along X", () => {
    const pts = stretchWireForMove([{ x: 0, y: 20 }, { x: 100, y: 20 }], true, false, { x: 20, y: 0 });
    expect(pts).toEqual([{ x: 20, y: 20 }, { x: 100, y: 20 }]);
  });

  it("inserts an orthogonal bend vertex on a 2-point wire when moving perpendicular", () => {
    const pts = stretchWireForMove([{ x: 0, y: 20 }, { x: 100, y: 20 }], true, false, { x: 10, y: 30 });
    expect(pts).toEqual([
      { x: 10, y: 50 },
      { x: 100, y: 50 },
      { x: 100, y: 20 },
    ]);
    assertOrthogonal(pts);
    // Opposite fixed endpoint is preserved
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 20 });
  });

  it("adjusts interior bend vertex on a 3+ point wire without adding extra bends", () => {
    const orig: Point[] = [
      { x: 0, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 80 },
      { x: 120, y: 80 },
    ];
    const stretchedStart = stretchWireStart(orig, { x: 10, y: 40 });
    expect(stretchedStart).toEqual([
      { x: 10, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 80 },
      { x: 120, y: 80 },
    ]);
    assertOrthogonal(stretchedStart);

    // Stretching the end endpoint symmetrically adjusts the penultimate vertex
    const stretchedEnd = stretchWireForMove(orig, false, true, { x: 20, y: -30 });
    expect(stretchedEnd).toEqual([
      { x: 0, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 50 },
      { x: 140, y: 50 },
    ]);
    assertOrthogonal(stretchedEnd);
  });

  it("translates the whole wire when both endpoints are attached to moved components", () => {
    const orig: Point[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 50 }];
    const moved = stretchWireForMove(orig, true, true, { x: 30, y: -10 });
    expect(moved).toEqual([{ x: 30, y: -10 }, { x: 70, y: -10 }, { x: 70, y: 40 }]);
  });

  it("captureAttachedWires finds unselected wires connected to moved component pins", () => {
    const doc = emptyDocument();
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 } };
    const g2: ComponentInstance = { id: "g2", type: "and", x: 160, y: 0, rotation: 0, props: { inputs: 2 } };
    doc.components.push(g1, g2);
    const outPin = worldPins(g1).find((p) => p.pin.id === "out")!.pos;
    const inPin = worldPins(g2).find((p) => p.pin.id === "in0")!.pos;
    doc.wires.push({ id: "w1", points: [outPin, { x: inPin.x, y: outPin.y }, inPin] });
    doc.wires.push({ id: "w_free", points: [{ x: 300, y: 300 }, { x: 400, y: 300 }] });

    const attached = captureAttachedWires(doc, new Set(["g1"]), new Set());
    expect(attached).toHaveLength(1);
    expect(attached[0].wireId).toBe("w1");
    expect(attached[0].startAttached).toBe(true);
    expect(attached[0].endAttached).toBe(false);

    // If the wire itself is selected, it should NOT be in attachedWires
    const none = captureAttachedWires(doc, new Set(["g1"]), new Set(["w1"]));
    expect(none).toHaveLength(0);
  });
});

describe("wire segment dragging", () => {
  it("moves an interior vertical segment perpendicular along X and adjusts neighbors", () => {
    const orig: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 60 },
      { x: 100, y: 60 },
    ];
    const moved = dragWireSegmentPoints(orig, 1, { x: 20, y: 99 }, true, true);
    expect(moved).toEqual([
      { x: 0, y: 0 },
      { x: 70, y: 0 },
      { x: 70, y: 60 },
      { x: 100, y: 60 },
    ]);
    assertOrthogonal(moved);
  });

  it("preserves anchored endpoints on a 2-point wire by creating a U-bend", () => {
    const orig: Point[] = [{ x: 0, y: 20 }, { x: 100, y: 20 }];
    const moved = dragWireSegmentPoints(orig, 0, { x: 0, y: 30 }, true, true);
    expect(moved).toEqual([
      { x: 0, y: 20 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 100, y: 20 },
    ]);
    assertOrthogonal(moved);
  });

  it("moves an unanchored 2-point segment directly without adding stubs", () => {
    const orig: Point[] = [{ x: 0, y: 20 }, { x: 100, y: 20 }];
    const moved = dragWireSegmentPoints(orig, 0, { x: 0, y: 30 }, false, false);
    expect(moved).toEqual([{ x: 0, y: 50 }, { x: 100, y: 50 }]);
  });

  it("detects anchored points on pins and T-junctions", () => {
    const doc = emptyDocument();
    doc.components.push({ id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 } });
    const outPin = worldPins(doc.components[0]).find((p) => p.pin.id === "out")!.pos;
    doc.wires.push({ id: "w1", points: [{ x: 200, y: 0 }, { x: 200, y: 100 }] });
    doc.wires.push({ id: "w2", points: [outPin, { x: 200, y: outPin.y }] });

    expect(isPointAnchored(doc, outPin, "w2")).toBe(true);
    expect(isPointAnchored(doc, { x: 200, y: outPin.y }, "w2")).toBe(true);
    expect(isPointAnchored(doc, { x: 400, y: 400 }, "w2")).toBe(false);
    // T-junction verified by core junctionPoints
    expect(junctionPoints(doc)).toContainEqual({ x: 200, y: outPin.y });
  });
});

describe("label numbering", () => {
  it("assigns prefix + smallest unused positive integer", () => {
    const doc = emptyDocument();
    expect(nextAutoLabel(doc, "U")).toBe("U1");
    doc.components.push({ id: "c1", type: "and", x: 0, y: 0, rotation: 0, props: {}, label: "U1" });
    expect(nextAutoLabel(doc, "U")).toBe("U2");
    doc.components.push({ id: "c3", type: "and", x: 0, y: 60, rotation: 0, props: {}, label: "U3" });
    // Fills gap U2 first
    expect(nextAutoLabel(doc, "U")).toBe("U2");
    doc.components.push({ id: "c2", type: "and", x: 0, y: 120, rotation: 0, props: {}, label: "U2" });
    expect(nextAutoLabel(doc, "U")).toBe("U4");
    // Independent prefix
    expect(nextAutoLabel(doc, "MUX")).toBe("MUX1");
  });

  it("nextCopyLabel increments auto-numbered labels and preserves custom labels", () => {
    const doc = emptyDocument();
    const c1: ComponentInstance = { id: "c1", type: "and", x: 0, y: 0, rotation: 0, props: {}, label: "U1" };
    const c2: ComponentInstance = { id: "c2", type: "and", x: 0, y: 60, rotation: 0, props: {}, label: "ENABLE" };
    doc.components.push(c1, c2);
    expect(nextCopyLabel(doc, c1)).toBe("U2");
    expect(nextCopyLabel(doc, c2)).toBe("ENABLE");
  });
});

describe("hit testing & marquee selection", () => {
  function sampleDoc(): SchematicDocument {
    const doc = emptyDocument();
    doc.components.push({ id: "g1", type: "and", x: 100, y: 100, rotation: 0, props: { inputs: 2 } });
    doc.wires.push({ id: "w1", points: [{ x: 0, y: 200 }, { x: 100, y: 200 }, { x: 100, y: 260 }] });
    doc.texts.push({ id: "t1", x: 300, y: 100, text: "Hello World", fontSize: 14 });
    return doc;
  }

  it("finds closest pin within tolerance", () => {
    const doc = sampleDoc();
    const outPin = worldPins(doc.components[0]).find((p) => p.pin.id === "out")!;
    const hit = findPinAt(doc, { x: outPin.pos.x + 3, y: outPin.pos.y - 2 }, 8);
    expect(hit?.pin.id).toBe("out");
    expect(findPinAt(doc, { x: outPin.pos.x + 25, y: outPin.pos.y }, 8)).toBeNull();
  });

  it("hits components, wires (with segment index), and texts in stacking order", () => {
    const doc = sampleDoc();
    expect(hitTestComponent(doc, { x: 140, y: 120 })?.id).toBe("g1");
    expect(hitTestComponent(doc, { x: 10, y: 10 })).toBeNull();

    const wh0 = hitTestWire(doc, { x: 50, y: 203 }, 6);
    expect(wh0?.wire.id).toBe("w1");
    expect(wh0?.segmentIndex).toBe(0);
    const wh1 = hitTestWire(doc, { x: 98, y: 230 }, 6);
    expect(wh1?.segmentIndex).toBe(1);

    expect(hitTestText(doc, { x: 320, y: 95 })?.id).toBe("t1");

    expect(hitTestDocument(doc, { x: 320, y: 95 })?.kind).toBe("text");
    expect(hitTestDocument(doc, { x: 140, y: 120 })?.kind).toBe("component");
    expect(hitTestDocument(doc, { x: 50, y: 200 })?.kind).toBe("wire");
  });

  it("findSnapTarget prioritizes pins over wires and snaps onto wire segments on grid", () => {
    const doc = sampleDoc();
    const outPin = worldPins(doc.components[0]).find((p) => p.pin.id === "out")!;
    const pinSnap = findSnapTarget(doc, { x: outPin.pos.x + 2, y: outPin.pos.y + 1 }, 8);
    expect(pinSnap?.kind).toBe("pin");
    expect(pinSnap?.pos).toEqual(outPin.pos);

    const wireSnap = findSnapTarget(doc, { x: 43, y: 202 }, 8);
    expect(wireSnap?.kind).toBe("wire");
    expect(wireSnap?.pos).toEqual({ x: 40, y: 200 });
  });

  it("itemsInRect selects intersecting components, wires, and texts", () => {
    const doc = sampleDoc();
    expect(segmentIntersectsRect({ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 40, y: 40, w: 20, h: 20 })).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 10 }, { x: 100, y: 10 }, { x: 40, y: 40, w: 20, h: 20 })).toBe(false);

    const all = itemsInRect(doc, { x: -10, y: 50, w: 400, h: 250 });
    expect(new Set(all)).toEqual(new Set(["g1", "w1", "t1"]));

    const onlyWire = itemsInRect(doc, { x: 10, y: 190, w: 40, h: 30 });
    expect(onlyWire).toEqual(["w1"]);
  });
});

describe("selection transforms & store operations", () => {
  it("rotates multi-select 90° CW about grid-snapped center keeping internal wires connected", () => {
    const doc = emptyDocument();
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 } };
    const g2: ComponentInstance = { id: "g2", type: "and", x: 120, y: 0, rotation: 0, props: { inputs: 2 } };
    doc.components.push(g1, g2);
    const pOut = worldPins(g1).find((p) => p.pin.id === "out")!.pos;
    const pIn = worldPins(g2).find((p) => p.pin.id === "in0")!.pos;
    doc.wires.push({ id: "w1", points: [pOut, { x: pIn.x, y: pOut.y }, pIn] });

    const sel = new Set(["g1", "g2", "w1"]);
    rotateSelectionInDoc(doc, sel);

    expect(g1.rotation).toBe(90);
    expect(g2.rotation).toBe(90);
    // Wire endpoints still coincide with the rotated pins!
    const newOut = worldPins(g1).find((p) => p.pin.id === "out")!.pos;
    const newIn = worldPins(g2).find((p) => p.pin.id === "in0")!.pos;
    expect(doc.wires[0].points[0]).toEqual(newOut);
    expect(doc.wires[0].points[doc.wires[0].points.length - 1]).toEqual(newIn);
    // All pins stay on the 10-unit grid
    for (const c of doc.components) {
      for (const wp of worldPins(c)) {
        expect(Math.abs(wp.pos.x % GRID)).toBe(0);
        expect(Math.abs(wp.pos.y % GRID)).toBe(0);
      }
    }
  });

  it("4 consecutive rotations return components and wires to original coordinates", () => {
    const p = { x: 120, y: 70 };
    const r1 = rotatePointCW(p, 100, 100);
    const r2 = rotatePointCW(r1, 100, 100);
    const r3 = rotatePointCW(r2, 100, 100);
    const r4 = rotatePointCW(r3, 100, 100);
    expect(r4).toEqual(p);

    const doc = emptyDocument();
    doc.components.push({ id: "g1", type: "and", x: 100, y: 100, rotation: 0, props: { inputs: 2 } });
    const origPins = worldPins(doc.components[0]).map((w) => w.pos);
    for (let i = 0; i < 4; i++) rotateSelectionInDoc(doc, new Set(["g1"]));
    expect(doc.components[0].rotation).toBe(0);
    expect(worldPins(doc.components[0]).map((w) => w.pos)).toEqual(origPins);
  });

  it("setComponentRotationInDoc rotates directly to target rotation on grid", () => {
    const doc = emptyDocument();
    doc.components.push({ id: "g1", type: "and", x: 100, y: 100, rotation: 0, props: { inputs: 2 } });
    setComponentRotationInDoc(doc, "g1", 270);
    expect(doc.components[0].rotation).toBe(270);
    for (const wp of worldPins(doc.components[0])) {
      expect(Math.abs(wp.pos.x % GRID)).toBe(0);
      expect(Math.abs(wp.pos.y % GRID)).toBe(0);
    }
  });

  it("mirrors multi-select horizontally preserving internal wire connections", () => {
    const doc = emptyDocument();
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 } };
    const g2: ComponentInstance = { id: "g2", type: "or", x: 120, y: 0, rotation: 0, props: { inputs: 2 } };
    doc.components.push(g1, g2);
    const pOut = worldPins(g1).find((p) => p.pin.id === "out")!.pos;
    const pIn = worldPins(g2).find((p) => p.pin.id === "in0")!.pos;
    doc.wires.push({ id: "w1", points: [pOut, { x: pIn.x, y: pOut.y }, pIn] });

    mirrorSelectionInDoc(doc, new Set(["g1", "g2", "w1"]));
    expect(g1.mirror).toBe(true);
    expect(g2.mirror).toBe(true);
    const newOut = worldPins(g1).find((p) => p.pin.id === "out")!.pos;
    const newIn = worldPins(g2).find((p) => p.pin.id === "in0")!.pos;
    expect(doc.wires[0].points[0]).toEqual(newOut);
    expect(doc.wires[0].points[doc.wires[0].points.length - 1]).toEqual(newIn);
  });

  it("nudge moves selected component and stretches attached unselected wire in one undo step", () => {
    const store = new DocumentStore();
    const g1 = placeComponentInStore(store, "and", 0, 0)!;
    const g2 = placeComponentInStore(store, "and", 160, 0)!;
    const pOut = worldPins(g1).find((p) => p.pin.id === "out")!.pos;
    const pIn = worldPins(g2).find((p) => p.pin.id === "in0")!.pos;
    store.update("Add wire", (draft) => {
      draft.wires.push({ id: "w1", points: [pOut, { x: pIn.x, y: pOut.y }, pIn] });
    });

    store.setSelection([g1.id]);
    nudgeSelectionInStore(store, 0, 20);

    const movedG1 = store.doc.components.find((c) => c.id === g1.id)!;
    const newOut = worldPins(movedG1).find((p) => p.pin.id === "out")!.pos;
    expect(movedG1.y).toBe(20);
    expect(store.doc.wires[0].points[0]).toEqual(newOut);
    expect(store.doc.wires[0].points[store.doc.wires[0].points.length - 1]).toEqual(pIn);
    assertOrthogonal(store.doc.wires[0].points);

    store.undo();
    expect(store.doc.components.find((c) => c.id === g1.id)!.y).toBe(0);
    expect(store.doc.wires[0].points[0]).toEqual(pOut);
  });

  it("copy, paste at cursor, duplicate, and delete manage IDs and labels cleanly", () => {
    const store = new DocumentStore();
    const g1 = placeComponentInStore(store, "nand", 100, 100)!;
    expect(g1.label).toBe("U1");

    const clip = copySelectionFromDoc(store.doc, store.selection)!;
    const pastedIds = pasteClipboardIntoStore(store, clip, { x: 300, y: 200 });
    expect(pastedIds).toHaveLength(1);
    expect(pastedIds[0]).not.toBe(g1.id);
    const pasted = store.doc.components.find((c) => c.id === pastedIds[0])!;
    expect(pasted.label).toBe("U2");

    const dupIds = duplicateSelectionInStore(store);
    expect(dupIds).toHaveLength(1);
    const dup = store.doc.components.find((c) => c.id === dupIds[0])!;
    expect(dup.label).toBe("U3");

    store.setSelection([dup.id]);
    deleteSelectionInStore(store);
    expect(store.doc.components.map((c) => c.id)).toEqual([g1.id, pasted.id]);
  });

  it("centeredOriginForPlacement produces grid-aligned origins for all rotations", () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const origin = centeredOriginForPlacement("and", rot, false, { x: 153, y: 217 }, GRID);
      expect(Math.abs(origin.x % GRID)).toBe(0);
      expect(Math.abs(origin.y % GRID)).toBe(0);
    }
  });
});

describe("generic parametric ComponentDef support", () => {
  it("works generically with a custom parametric component whose pin count changes with props", () => {
    const testType = "__test_mux__";
    if (!getDef(testType)) {
      const muxDef: ComponentDef = {
        type: testType,
        name: "Test MUX",
        category: "Plexers",
        labelPrefix: "MUX",
        props: [
          { key: "selectBits", label: "Select Bits", kind: "int", min: 1, max: 4 },
          { key: "enable", label: "Enable Pin", kind: "bool" },
        ],
        defaultProps: { selectBits: 1, enable: false },
        geometry: (props) => {
          const sel = Math.max(1, propNum(props, "selectBits", 1));
          const nData = 1 << sel;
          const hasEn = Boolean(props.enable);
          const h = Math.max(40, (nData + 1) * GRID);
          const w = Math.max(60, (sel + 2) * GRID);
          const pins: PinDef[] = [];
          for (let i = 0; i < nData; i++) {
            pins.push({ id: `d${i}`, name: `D${i}`, x: 0, y: (i + 1) * GRID, dir: "in", side: "left" });
          }
          for (let i = 0; i < sel; i++) {
            pins.push({ id: `s${i}`, name: `S${i}`, x: (i + 1) * GRID, y: h, dir: "in", side: "bottom" });
          }
          if (hasEn) {
            pins.push({ id: "en", name: "EN", x: w / 2, y: 0, dir: "in", side: "top" });
          }
          pins.push({ id: "y", name: "Y", x: w, y: Math.round(h / 2 / GRID) * GRID, dir: "out", side: "right" });
          return { width: w, height: h, pins };
        },
        symbol: () => `<rect class="ds-body" x="10" y="0" width="40" height="40"/>`,
      };
      registerComponent(muxDef);
    }

    const store = new DocumentStore();
    const inst = placeComponentInStore(store, testType, 100, 100)!;
    expect(inst.label).toBe("MUX1");
    // 1 select bit -> 2 data + 1 select + 1 out = 4 pins
    expect(worldPins(store.doc.components[0])).toHaveLength(4);

    // Change selectBits to 3 and enable to true via store.update -> 8 data + 3 select + 1 en + 1 out = 13 pins
    store.update("Change MUX params", (draft) => {
      draft.components[0].props.selectBits = 3;
      draft.components[0].props.enable = true;
    });
    const pins = worldPins(store.doc.components[0]);
    expect(pins).toHaveLength(13);

    // Every generated pin is individually hit-testable on grid
    for (const wp of pins) {
      expect(Math.abs(wp.pos.x % GRID)).toBe(0);
      expect(Math.abs(wp.pos.y % GRID)).toBe(0);
      const found = findPinAt(store.doc, wp.pos, 4);
      expect(found?.pin.id).toBe(wp.pin.id);
    }
  });

  it("preserves bus wire width across normalization, copy/paste, and rotation", () => {
    const store = new DocumentStore();
    store.update("Add bus", (d) => {
      d.wires.push({
        id: "b1",
        width: 8,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 60, y: 0 }],
      });
      normalizeDocWires(d);
    });
    expect(store.doc.wires[0].width).toBe(8);
    expect(store.doc.wires[0].points).toEqual([{ x: 0, y: 0 }, { x: 60, y: 0 }]);

    store.setSelection(["b1"]);
    const clip = copySelectionFromDoc(store.doc, store.selection)!;
    const pasted = pasteClipboardIntoStore(store, clip, { x: 100, y: 100 });
    const busCopy = store.doc.wires.find((w) => w.id === pasted[0])!;
    expect(busCopy.width).toBe(8);
  });

  it("single component mirror keeps exact bounding box across all 4 rotations", () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const doc = emptyDocument();
      doc.components.push({ id: "g1", type: "and", x: 100, y: 100, rotation: rot, props: { inputs: 3 } });
      const pinsBefore = worldPins(doc.components[0]).map((p) => p.pos);
      const minX0 = Math.min(...pinsBefore.map((p) => p.x));
      const maxX0 = Math.max(...pinsBefore.map((p) => p.x));
      const minY0 = Math.min(...pinsBefore.map((p) => p.y));
      const maxY0 = Math.max(...pinsBefore.map((p) => p.y));

      mirrorSelectionInDoc(doc, new Set(["g1"]));
      const pinsAfter = worldPins(doc.components[0]).map((p) => p.pos);
      for (const p of pinsAfter) {
        expect(Math.abs(p.x % GRID)).toBe(0);
        expect(Math.abs(p.y % GRID)).toBe(0);
      }
      expect(Math.min(...pinsAfter.map((p) => p.x))).toBe(minX0);
      expect(Math.max(...pinsAfter.map((p) => p.x))).toBe(maxX0);
      expect(Math.min(...pinsAfter.map((p) => p.y))).toBe(minY0);
      expect(Math.max(...pinsAfter.map((p) => p.y))).toBe(maxY0);
    }
  });

  it("scales cleanly to 1000 components for hit testing and marquee selection", () => {
    const doc = emptyDocument();
    for (let i = 0; i < 1000; i++) {
      const col = i % 40;
      const row = Math.floor(i / 40);
      doc.components.push({
        id: `c_${i}`,
        type: "and",
        x: col * 120,
        y: row * 80,
        rotation: 0,
        props: { inputs: 2 },
        label: `U${i + 1}`,
      });
    }
    const cachedBounds = doc.components.map((comp) => ({
      comp,
      bounds: { x: comp.x, y: comp.y, w: 80, h: 40 },
    }));
    const t0 = performance.now();
    const hit = hitTestComponent(doc, { x: 120 * 20 + 40, y: 80 * 12 + 20 }, 2, cachedBounds);
    const boxed = itemsInRect(doc, { x: 0, y: 0, w: 500, h: 300 }, cachedBounds);
    const elapsed = performance.now() - t0;

    expect(hit?.id).toBe(`c_${12 * 40 + 20}`);
    expect(boxed.length).toBeGreaterThan(10);
    expect(elapsed).toBeLessThan(200);
  });
});

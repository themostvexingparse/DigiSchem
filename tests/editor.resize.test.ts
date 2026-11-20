import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import type { ComponentDef, PinDef } from "../src/model/component-def";
import { GRID, propNum, SIZE_H, SIZE_W } from "../src/model/component-def";
import { getDef, registerComponent } from "../src/model/registry";
import { DocumentStore } from "../src/model/store";
import {
  effectiveProps,
  geometryOf,
  localToWorld,
  pointOnSegment,
  snap,
  worldPins,
} from "../src/model/geometry";
import {
  emptyDocument,
  type ComponentInstance,
  type Point,
  type Rotation,
} from "../src/model/types";
import { keepWiresAttached } from "../src/editor/doc-ops";
import {
  allowedHandles,
  applyResizeDrag,
  handleCursor,
  hasSnappedResizeDelta,
  hitTestResizeHandle,
  resetComponentSizeInDoc,
  resizeHandles,
  setComponentSizeInDoc,
  worldDeltaToLocal,
  type ResizeHandleId,
} from "../src/editor/resize";

registerBuiltinComponents();

const TEST_BOTH = "__test_resize_both__";
const TEST_WIDTH = "__test_resize_width__";
const TEST_HEIGHT = "__test_resize_height__";
const TEST_EVEN = "__test_resize_even__";

function registerTestResizableDefs(): void {
  if (!getDef(TEST_BOTH)) {
    const def: ComponentDef = {
      type: TEST_BOTH,
      name: "Test Resizable Both",
      category: "Misc",
      resizable: "both",
      props: [],
      defaultProps: {},
      geometry: (props) => {
        const w = Math.max(60, snap(propNum(props, SIZE_W, 60), GRID));
        const h = Math.max(40, snap(propNum(props, SIZE_H, 40), GRID));
        const pins: PinDef[] = [
          { id: "in0", name: "A0", x: 0, y: GRID, dir: "in", side: "left" },
          { id: "in1", name: "A1", x: 0, y: h - GRID, dir: "in", side: "left" },
          { id: "out", name: "Y", x: w, y: snap(h / 2, GRID), dir: "out", side: "right" },
          { id: "sel", name: "S", x: snap(w / 2, GRID), y: h, dir: "in", side: "bottom" },
        ];
        return { width: w, height: h, pins };
      },
      symbol: (props) => {
        const w = Math.max(60, snap(propNum(props, SIZE_W, 60), GRID));
        const h = Math.max(40, snap(propNum(props, SIZE_H, 40), GRID));
        return `<rect class="ds-body" x="10" y="0" width="${w - 20}" height="${h}"/>`;
      },
    };
    registerComponent(def);
  }

  if (!getDef(TEST_WIDTH)) {
    const def: ComponentDef = {
      type: TEST_WIDTH,
      name: "Test Resizable Width",
      category: "Misc",
      resizable: "width",
      props: [],
      defaultProps: {},
      geometry: (props) => {
        const w = Math.max(60, snap(propNum(props, SIZE_W, 60), GRID));
        const h = 40;
        return {
          width: w,
          height: h,
          pins: [
            { id: "in", name: "A", x: 0, y: 20, dir: "in", side: "left" },
            { id: "out", name: "Y", x: w, y: 20, dir: "out", side: "right" },
          ],
        };
      },
      symbol: () => `<rect class="ds-body" x="10" y="0" width="40" height="40"/>`,
    };
    registerComponent(def);
  }

  if (!getDef(TEST_HEIGHT)) {
    const def: ComponentDef = {
      type: TEST_HEIGHT,
      name: "Test Resizable Height",
      category: "Misc",
      resizable: "height",
      props: [],
      defaultProps: {},
      geometry: (props) => {
        const w = 60;
        const h = Math.max(40, snap(propNum(props, SIZE_H, 40), GRID));
        return {
          width: w,
          height: h,
          pins: [
            { id: "in0", name: "A0", x: 0, y: GRID, dir: "in", side: "left" },
            { id: "in1", name: "A1", x: 0, y: h - GRID, dir: "in", side: "left" },
            { id: "out", name: "Y", x: w, y: snap(h / 2, GRID), dir: "out", side: "right" },
          ],
        };
      },
      symbol: () => `<rect class="ds-body" x="10" y="0" width="40" height="40"/>`,
    };
    registerComponent(def);
  }

  if (!getDef(TEST_EVEN)) {
    // Rounds effective width/height up to even multiples of GRID (20), min 60x40.
    const ceilEven = (v: number) => Math.ceil(v / (2 * GRID)) * (2 * GRID);
    const def: ComponentDef = {
      type: TEST_EVEN,
      name: "Test Resizable Even-Grid",
      category: "Misc",
      resizable: "both",
      props: [],
      defaultProps: {},
      geometry: (props) => {
        const w = Math.max(60, ceilEven(propNum(props, SIZE_W, 60)));
        const h = Math.max(40, ceilEven(propNum(props, SIZE_H, 40)));
        return {
          width: w,
          height: h,
          pins: [
            { id: "in", name: "A", x: 0, y: h / 2, dir: "in", side: "left" },
            { id: "out", name: "Y", x: w, y: h / 2, dir: "out", side: "right" },
          ],
        };
      },
      symbol: () => `<rect class="ds-body" x="10" y="0" width="40" height="40"/>`,
    };
    registerComponent(def);
  }
}

registerTestResizableDefs();

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const MIRRORS: readonly boolean[] = [false, true];
const ALL_HANDLES: readonly ResizeHandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Map a local vector (lx, ly) into world space using mirror + clockwise rotation. */
function localVecToWorld(v: Point, rotation: Rotation, mirror: boolean): Point {
  let x = mirror ? -v.x : v.x;
  let y = v.y;
  switch (rotation) {
    case 90:
      [x, y] = [-y, x];
      break;
    case 180:
      [x, y] = [-x, -y];
      break;
    case 270:
      [x, y] = [y, -x];
      break;
  }
  return { x: x + 0, y: y + 0 };
}

/** Local normalized (0 | 0.5 | 1) coordinates of each handle. */
const HANDLE_FRAC: Record<ResizeHandleId, { hx: number; hy: number }> = {
  nw: { hx: 0, hy: 0 },
  n:  { hx: 0.5, hy: 0 },
  ne: { hx: 1, hy: 0 },
  e:  { hx: 1, hy: 0.5 },
  se: { hx: 1, hy: 1 },
  s:  { hx: 0.5, hy: 1 },
  sw: { hx: 0, hy: 1 },
  w:  { hx: 0, hy: 0.5 },
};

/** Local opposite corner/edge anchor point(s) that must stay fixed when dragging `handle`. */
function oppositeAnchorPoints(handle: ResizeHandleId, w: number, h: number): Point[] {
  const { hx, hy } = HANDLE_FRAC[handle];
  if (hx === 0.5) {
    // Dragging top (hy=0) or bottom (hy=1): entire opposite horizontal edge (both corners) stays fixed.
    const oppY = hy === 0 ? h : 0;
    return [
      { x: 0, y: oppY },
      { x: w, y: oppY },
    ];
  }
  if (hy === 0.5) {
    // Dragging left (hx=0) or right (hx=1): entire opposite vertical edge (both corners) stays fixed.
    const oppX = hx === 0 ? w : 0;
    return [
      { x: oppX, y: 0 },
      { x: oppX, y: h },
    ];
  }
  // Corner handle: opposite corner stays fixed.
  return [{ x: hx === 0 ? w : 0, y: hy === 0 ? h : 0 }];
}

function assertOnGrid(n: number): void {
  expect(Math.abs(n % GRID)).toBe(0);
}

function assertOrthogonal(pts: Point[]): void {
  expect(pts.length).toBeGreaterThanOrEqual(2);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    expect(a.x === b.x || a.y === b.y).toBe(true);
    expect(a.x === b.x && a.y === b.y).toBe(false);
  }
}

describe("resize handles & cursors", () => {
  it("returns allowed handles matching def.resizable", () => {
    expect(allowedHandles(undefined)).toEqual([]);
    expect(allowedHandles("both")).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
    expect(allowedHandles("width")).toEqual(["w", "e"]);
    expect(allowedHandles("height")).toEqual(["n", "s"]);

    const nonResizable: ComponentInstance = { id: "g1", type: "not", x: 0, y: 0, rotation: 0, props: {} };
    expect(resizeHandles(nonResizable)).toEqual([]);

    const wComp: ComponentInstance = { id: "c1", type: TEST_WIDTH, x: 100, y: 100, rotation: 0, props: {} };
    expect(resizeHandles(wComp).map((h) => h.id)).toEqual(["w", "e"]);

    const hComp: ComponentInstance = { id: "c2", type: TEST_HEIGHT, x: 100, y: 100, rotation: 0, props: {} };
    expect(resizeHandles(hComp).map((h) => h.id)).toEqual(["n", "s"]);

    const bComp: ComponentInstance = { id: "c3", type: TEST_BOTH, x: 100, y: 100, rotation: 0, props: {} };
    expect(resizeHandles(bComp)).toHaveLength(8);
  });

  it("computes handle positions via localToWorld for all 4 rotations × mirror (using real geometry)", () => {
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        // Request below minimum (20, 20) — handles must sit on real effective geometry (60x40)
        const inst: ComponentInstance = {
          id: "c",
          type: TEST_BOTH,
          x: 120,
          y: 80,
          rotation,
          mirror: mirror || undefined,
          props: {},
          size: { w: 20, h: 20 },
        };
        const g = geometryOf(inst);
        expect(g.width).toBe(60);
        expect(g.height).toBe(40);
        const handles = resizeHandles(inst);
        expect(handles).toHaveLength(8);
        for (const h of handles) {
          const { hx, hy } = HANDLE_FRAC[h.id];
          const expected = localToWorld(inst, { x: hx * g.width, y: hy * g.height }, g);
          expect(h.pos).toEqual({ x: expected.x + 0, y: expected.y + 0 });
        }
      }
    }
  });

  it("rotates and mirrors cursor names accurately for all handles, rotations, and mirror states", () => {
    // Unrotated, unmirrored
    expect(handleCursor("nw", 0, false)).toBe("nwse-resize");
    expect(handleCursor("se", 0, false)).toBe("nwse-resize");
    expect(handleCursor("ne", 0, false)).toBe("nesw-resize");
    expect(handleCursor("sw", 0, false)).toBe("nesw-resize");
    expect(handleCursor("n", 0, false)).toBe("ns-resize");
    expect(handleCursor("s", 0, false)).toBe("ns-resize");
    expect(handleCursor("e", 0, false)).toBe("ew-resize");
    expect(handleCursor("w", 0, false)).toBe("ew-resize");

    // 90° CW: n/s become horizontal (ew), e/w become vertical (ns), diagonals flip
    expect(handleCursor("n", 90, false)).toBe("ew-resize");
    expect(handleCursor("s", 90, false)).toBe("ew-resize");
    expect(handleCursor("e", 90, false)).toBe("ns-resize");
    expect(handleCursor("w", 90, false)).toBe("ns-resize");
    expect(handleCursor("nw", 90, false)).toBe("nesw-resize");
    expect(handleCursor("ne", 90, false)).toBe("nwse-resize");

    // 180°: same axis cursors as 0°
    for (const h of ALL_HANDLES) {
      expect(handleCursor(h, 180, false)).toBe(handleCursor(h, 0, false));
      expect(handleCursor(h, 270, false)).toBe(handleCursor(h, 90, false));
    }

    // Mirror flips diagonals, keeps axis-aligned cursors identical at every rotation
    for (const rot of ROTATIONS) {
      expect(handleCursor("n", rot, true)).toBe(handleCursor("n", rot, false));
      expect(handleCursor("s", rot, true)).toBe(handleCursor("s", rot, false));
      expect(handleCursor("e", rot, true)).toBe(handleCursor("e", rot, false));
      expect(handleCursor("w", rot, true)).toBe(handleCursor("w", rot, false));
      expect(handleCursor("nw", rot, true)).not.toBe(handleCursor("nw", rot, false));
      expect(handleCursor("ne", rot, true)).not.toBe(handleCursor("ne", rot, false));
      expect(handleCursor("sw", rot, true)).not.toBe(handleCursor("sw", rot, false));
      expect(handleCursor("se", rot, true)).not.toBe(handleCursor("se", rot, false));
    }
  });

  it("hitTestResizeHandle hits closest handle within tolerance and misses outside", () => {
    const inst: ComponentInstance = { id: "c", type: TEST_BOTH, x: 100, y: 200, rotation: 90, props: {} };
    const handles = resizeHandles(inst);
    for (const h of handles) {
      const hit = hitTestResizeHandle(inst, { x: h.pos.x + 2, y: h.pos.y - 2 }, 8);
      expect(hit?.id).toBe(h.id);
    }
    expect(hitTestResizeHandle(inst, { x: 500, y: 500 }, 8)).toBeNull();
  });

  it("worldDeltaToLocal is the exact inverse of local-to-world direction across all rotations × mirror", () => {
    const samples: Point[] = [
      { x: 30, y: -20 },
      { x: -10, y: 40 },
      { x: 0, y: -50 },
    ];
    for (const rot of ROTATIONS) {
      for (const mirror of MIRRORS) {
        for (const v of samples) {
          const w = localVecToWorld(v, rot, mirror);
          const back = worldDeltaToLocal(w, rot, mirror);
          expect(back).toEqual(v);
        }
      }
    }
  });
});

describe("applyResizeDrag — all 4 rotations × mirror", () => {
  it("growing from every handle keeps opposite edge/corner fixed in world space and snaps to grid", () => {
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        for (const handle of ALL_HANDLES) {
          const orig: ComponentInstance = {
            id: "c1",
            type: TEST_BOTH,
            x: 200,
            y: 160,
            rotation,
            mirror: mirror || undefined,
            props: {},
            size: { w: 80, h: 60 },
          };
          const origGeom = geometryOf(orig);
          const { hx, hy } = HANDLE_FRAC[handle];

          // Outward local delta of 30 along X (if dragging X) and 20 along Y (if dragging Y),
          // plus sub-grid noise (+3.2 / -4.1) to verify snapping.
          const localDeltaExact: Point = {
            x: hx === 0 ? -30 : hx === 1 ? 30 : 0,
            y: hy === 0 ? -20 : hy === 1 ? 20 : 0,
          };
          const worldDeltaClean = localVecToWorld(localDeltaExact, rotation, mirror);
          const worldDeltaNoisy: Point = {
            x: worldDeltaClean.x + 3.2,
            y: worldDeltaClean.y - 4.1,
          };

          const beforeHandleWorld = localToWorld(
            orig,
            { x: hx * origGeom.width, y: hy * origGeom.height },
            origGeom,
          );
          const anchorsBefore = oppositeAnchorPoints(handle, origGeom.width, origGeom.height).map((p) =>
            localToWorld(orig, p, origGeom),
          );

          const res = applyResizeDrag(orig, handle, worldDeltaNoisy, GRID);
          assertOnGrid(res.x);
          assertOnGrid(res.y);
          assertOnGrid(res.size.w);
          assertOnGrid(res.size.h);
          expect(res.size.w).toBeGreaterThanOrEqual(GRID);
          expect(res.size.h).toBeGreaterThanOrEqual(GRID);

          const updated: ComponentInstance = { ...orig, x: res.x, y: res.y, size: res.size };
          const nextGeom = geometryOf(updated);

          // Expected local size grew by 30 in W (if X handle) and 20 in H (if Y handle)
          expect(nextGeom.width).toBe(origGeom.width + (hx !== 0.5 ? 30 : 0));
          expect(nextGeom.height).toBe(origGeom.height + (hy !== 0.5 ? 20 : 0));

          // Opposite edge/corner MUST stay fixed in world space
          const anchorsAfter = oppositeAnchorPoints(handle, nextGeom.width, nextGeom.height).map((p) =>
            localToWorld(updated, p, nextGeom),
          );
          expect(anchorsAfter).toEqual(anchorsBefore);

          // Dragged handle MUST move by the exact snapped world delta
          const afterHandleWorld = localToWorld(
            updated,
            { x: hx * nextGeom.width, y: hy * nextGeom.height },
            nextGeom,
          );
          expect(afterHandleWorld).toEqual({
            x: beforeHandleWorld.x + worldDeltaClean.x,
            y: beforeHandleWorld.y + worldDeltaClean.y,
          });
        }
      }
    }
  });

  it("shrinking above minimum keeps opposite edge/corner fixed across all 4 rotations × mirror", () => {
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        for (const handle of ALL_HANDLES) {
          const orig: ComponentInstance = {
            id: "c1",
            type: TEST_BOTH,
            x: 200,
            y: 160,
            rotation,
            mirror: mirror || undefined,
            props: {},
            size: { w: 120, h: 100 },
          };
          const origGeom = geometryOf(orig);
          const { hx, hy } = HANDLE_FRAC[handle];

          // Inward local delta of 20
          const localDelta: Point = {
            x: hx === 0 ? 20 : hx === 1 ? -20 : 0,
            y: hy === 0 ? 20 : hy === 1 ? -20 : 0,
          };
          const worldDelta = localVecToWorld(localDelta, rotation, mirror);

          const anchorsBefore = oppositeAnchorPoints(handle, origGeom.width, origGeom.height).map((p) =>
            localToWorld(orig, p, origGeom),
          );

          const res = applyResizeDrag(orig, handle, worldDelta, GRID);
          assertOnGrid(res.x);
          assertOnGrid(res.y);
          assertOnGrid(res.size.w);
          assertOnGrid(res.size.h);

          const updated: ComponentInstance = { ...orig, x: res.x, y: res.y, size: res.size };
          const nextGeom = geometryOf(updated);

          expect(nextGeom.width).toBe(origGeom.width - (hx !== 0.5 ? 20 : 0));
          expect(nextGeom.height).toBe(origGeom.height - (hy !== 0.5 ? 20 : 0));

          const anchorsAfter = oppositeAnchorPoints(handle, nextGeom.width, nextGeom.height).map((p) =>
            localToWorld(updated, p, nextGeom),
          );
          expect(anchorsAfter).toEqual(anchorsBefore);
        }
      }
    }
  });

  it("dragging far past minimum clamps size >= GRID, respects def min, and STILL keeps opposite edge fixed", () => {
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        for (const handle of ALL_HANDLES) {
          const orig: ComponentInstance = {
            id: "c1",
            type: TEST_BOTH,
            x: 200,
            y: 160,
            rotation,
            mirror: mirror || undefined,
            props: {},
            size: { w: 100, h: 80 },
          };
          const origGeom = geometryOf(orig);
          const { hx, hy } = HANDLE_FRAC[handle];

          // Huge inward drag (250 units past opposite edge)
          const localDelta: Point = {
            x: hx === 0 ? 250 : hx === 1 ? -250 : 0,
            y: hy === 0 ? 250 : hy === 1 ? -250 : 0,
          };
          const worldDelta = localVecToWorld(localDelta, rotation, mirror);

          const anchorsBefore = oppositeAnchorPoints(handle, origGeom.width, origGeom.height).map((p) =>
            localToWorld(orig, p, origGeom),
          );

          const res = applyResizeDrag(orig, handle, worldDelta, GRID);
          assertOnGrid(res.x);
          assertOnGrid(res.y);
          assertOnGrid(res.size.w);
          assertOnGrid(res.size.h);
          expect(res.size.w).toBeGreaterThanOrEqual(GRID);
          expect(res.size.h).toBeGreaterThanOrEqual(GRID);

          const updated: ComponentInstance = { ...orig, x: res.x, y: res.y, size: res.size };
          const nextGeom = geometryOf(updated);

          // Def minimums (60x40) respected
          expect(nextGeom.width).toBeGreaterThanOrEqual(60);
          expect(nextGeom.height).toBeGreaterThanOrEqual(40);
          if (hx !== 0.5) expect(nextGeom.width).toBe(60);
          if (hy !== 0.5) expect(nextGeom.height).toBe(40);

          // Opposite edge STILL fixed in world space despite real geometry exceeding requested size!
          const anchorsAfter = oppositeAnchorPoints(handle, nextGeom.width, nextGeom.height).map((p) =>
            localToWorld(updated, p, nextGeom),
          );
          expect(anchorsAfter).toEqual(anchorsBefore);
        }
      }
    }
  });

  it("keeps opposite edge fixed when def rounds effective size larger than requested (even-grid def)", () => {
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        const orig: ComponentInstance = {
          id: "c1",
          type: TEST_EVEN,
          x: 100,
          y: 100,
          rotation,
          mirror: mirror || undefined,
          props: {},
        };
        const origGeom = geometryOf(orig); // 60 x 40
        // Drag nw outward by 10 on both axes -> requested 70x50 -> effective 80x60!
        const worldDelta = localVecToWorld({ x: -10, y: -10 }, rotation, mirror);
        const anchorBefore = localToWorld(orig, { x: origGeom.width, y: origGeom.height }, origGeom);

        const res = applyResizeDrag(orig, "nw", worldDelta, GRID);
        expect(res.size).toEqual({ w: 70, h: 50 });
        assertOnGrid(res.x);
        assertOnGrid(res.y);

        const updated: ComponentInstance = { ...orig, x: res.x, y: res.y, size: res.size };
        const nextGeom = geometryOf(updated);
        expect(nextGeom.width).toBe(80);
        expect(nextGeom.height).toBe(60);

        const anchorAfter = localToWorld(updated, { x: nextGeom.width, y: nextGeom.height }, nextGeom);
        expect(anchorAfter).toEqual(anchorBefore);
      }
    }
  });

  it("respects axis restrictions for width-only and height-only resizable defs", () => {
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        // Width-only component: dragging w/e with a diagonal world delta only changes width
        const wComp: ComponentInstance = {
          id: "w1",
          type: TEST_WIDTH,
          x: 100,
          y: 100,
          rotation,
          mirror: mirror || undefined,
          props: {},
        };
        const wOrigGeom = geometryOf(wComp);
        const wDelta = localVecToWorld({ x: -30, y: -50 }, rotation, mirror);
        const wAnchorsBefore = oppositeAnchorPoints("w", wOrigGeom.width, wOrigGeom.height).map((p) =>
          localToWorld(wComp, p, wOrigGeom),
        );
        const wRes = applyResizeDrag(wComp, "w", wDelta, GRID);
        const wUpdated = { ...wComp, x: wRes.x, y: wRes.y, size: wRes.size };
        const wNextGeom = geometryOf(wUpdated);
        expect(wNextGeom.width).toBe(90);
        expect(wNextGeom.height).toBe(40);
        expect(
          oppositeAnchorPoints("w", wNextGeom.width, wNextGeom.height).map((p) =>
            localToWorld(wUpdated, p, wNextGeom),
          ),
        ).toEqual(wAnchorsBefore);

        // Height-only component: dragging n/s with a diagonal world delta only changes height
        const hComp: ComponentInstance = {
          id: "h1",
          type: TEST_HEIGHT,
          x: 100,
          y: 100,
          rotation,
          mirror: mirror || undefined,
          props: {},
        };
        const hOrigGeom = geometryOf(hComp);
        const hDelta = localVecToWorld({ x: -50, y: -30 }, rotation, mirror);
        const hAnchorsBefore = oppositeAnchorPoints("n", hOrigGeom.width, hOrigGeom.height).map((p) =>
          localToWorld(hComp, p, hOrigGeom),
        );
        const hRes = applyResizeDrag(hComp, "n", hDelta, GRID);
        const hUpdated = { ...hComp, x: hRes.x, y: hRes.y, size: hRes.size };
        const hNextGeom = geometryOf(hUpdated);
        expect(hNextGeom.width).toBe(60);
        expect(hNextGeom.height).toBe(70);
        expect(
          oppositeAnchorPoints("n", hNextGeom.width, hNextGeom.height).map((p) =>
            localToWorld(hUpdated, p, hNextGeom),
          ),
        ).toEqual(hAnchorsBefore);
      }
    }
  });

  it("hasSnappedResizeDelta ignores sub-grid jitter and perpendicular deltas", () => {
    const inst: ComponentInstance = { id: "c", type: TEST_BOTH, x: 0, y: 0, rotation: 0, props: {} };
    expect(hasSnappedResizeDelta(inst, "e", { x: 4, y: 100 }, GRID)).toBe(false);
    expect(hasSnappedResizeDelta(inst, "e", { x: 6, y: 0 }, GRID)).toBe(true);
    expect(hasSnappedResizeDelta(inst, "n", { x: 100, y: 4 }, GRID)).toBe(false);
    expect(hasSnappedResizeDelta(inst, "n", { x: 0, y: -6 }, GRID)).toBe(true);
  });
});

describe("wire attachment, reset size, and undo/cancel gestures", () => {
  it("keeps wires attached to spreading pins across handle resize, setComponentSizeInDoc, and resetComponentSizeInDoc", () => {
    const doc = emptyDocument();
    const comp: ComponentInstance = {
      id: "b1",
      type: TEST_BOTH,
      x: 100,
      y: 100,
      rotation: 0,
      props: {},
    };
    doc.components.push(comp);

    const pinPos = (id: string) => worldPins(doc.components[0]).find((p) => p.pin.id === id)!.pos;
    const in0Start = pinPos("in0");
    const in1Start = pinPos("in1");
    const outStart = pinPos("out");
    const selStart = pinPos("sel");

    doc.wires.push(
      { id: "w_in0", points: [{ x: 40, y: in0Start.y }, in0Start] },
      { id: "w_in1", points: [{ x: 40, y: in1Start.y }, in1Start] },
      { id: "w_out", points: [outStart, { x: 260, y: outStart.y }] },
      { id: "w_sel", points: [selStart, { x: selStart.x, y: 260 }] },
    );

    // 1. Resize via setComponentSizeInDoc (simulating Properties panel W/H edit)
    setComponentSizeInDoc(doc, "b1", { w: 120, h: 100 });
    expect(doc.components[0].size).toEqual({ w: 120, h: 100 });
    expect(effectiveProps(doc.components[0])[SIZE_W]).toBe(120);
    expect(effectiveProps(doc.components[0])[SIZE_H]).toBe(100);

    // Every wire stayed attached to its pin's new position & remained orthogonal
    expect(doc.wires[0].points[doc.wires[0].points.length - 1]).toEqual(pinPos("in0"));
    expect(doc.wires[1].points[doc.wires[1].points.length - 1]).toEqual(pinPos("in1"));
    expect(doc.wires[2].points[0]).toEqual(pinPos("out"));
    expect(doc.wires[3].points[0]).toEqual(pinPos("sel"));
    for (const w of doc.wires) assertOrthogonal(w.points);

    // 2. Drag nw handle outward -> moves origin AND stretches wires
    const beforeNW = structuredClone(doc.components[0]);
    const res = applyResizeDrag(beforeNW, "nw", { x: -20, y: -20 }, GRID);
    keepWiresAttached(doc, new Set(["b1"]), () => {
      doc.components[0].x = res.x;
      doc.components[0].y = res.y;
      doc.components[0].size = res.size;
    });
    expect(doc.components[0].x).toBe(80);
    expect(doc.components[0].y).toBe(80);
    expect(doc.components[0].size).toEqual({ w: 140, h: 120 });
    expect(doc.wires[0].points[doc.wires[0].points.length - 1]).toEqual(pinPos("in0"));
    expect(doc.wires[1].points[doc.wires[1].points.length - 1]).toEqual(pinPos("in1"));
    expect(doc.wires[2].points[0]).toEqual(pinPos("out"));
    expect(doc.wires[3].points[0]).toEqual(pinPos("sel"));
    for (const w of doc.wires) assertOrthogonal(w.points);

    // Ensure no wire crosses another pin
    const allPins = worldPins(doc.components[0]);
    for (const w of doc.wires) {
      const ends = [w.points[0], w.points[w.points.length - 1]];
      for (const wp of allPins) {
        if (ends.some((e) => e.x === wp.pos.x && e.y === wp.pos.y)) continue;
        for (let i = 0; i + 1 < w.points.length; i++) {
          expect(pointOnSegment(wp.pos, w.points[i], w.points[i + 1])).toBe(false);
        }
      }
    }

    // 3. Reset size deletes `size` and keeps all wires attached
    resetComponentSizeInDoc(doc, "b1");
    expect(doc.components[0].size).toBeUndefined();
    expect(geometryOf(doc.components[0]).width).toBe(60);
    expect(geometryOf(doc.components[0]).height).toBe(40);
    expect(doc.wires[0].points[doc.wires[0].points.length - 1]).toEqual(pinPos("in0"));
    expect(doc.wires[1].points[doc.wires[1].points.length - 1]).toEqual(pinPos("in1"));
    expect(doc.wires[2].points[0]).toEqual(pinPos("out"));
    expect(doc.wires[3].points[0]).toEqual(pinPos("sel"));
    for (const w of doc.wires) assertOrthogonal(w.points);
  });

  it("collapses a multi-tick resize drag into a single undo step and supports cancelGesture", () => {
    const store = new DocumentStore();
    store.update("Add component", (d) => {
      d.components.push({ id: "b1", type: TEST_BOTH, x: 100, y: 100, rotation: 0, props: {} });
      const out = worldPins(d.components[0]).find((p) => p.pin.id === "out")!.pos;
      d.wires.push({ id: "w1", points: [out, { x: out.x + 60, y: out.y }] });
    });

    const origComp = structuredClone(store.doc.components[0]);
    const origWires = structuredClone(store.doc.wires);

    // Multi-tick gesture -> single undo step
    store.beginGesture();
    for (const dx of [10, 20, 40]) {
      const next = applyResizeDrag(origComp, "e", { x: dx, y: 0 }, GRID);
      store.update("Resize", (draft) => {
        draft.components[0] = structuredClone(origComp);
        draft.wires = structuredClone(origWires);
        keepWiresAttached(draft, new Set(["b1"]), () => {
          draft.components[0].x = next.x;
          draft.components[0].y = next.y;
          draft.components[0].size = next.size;
        });
      });
    }
    store.endGesture();

    expect(store.doc.components[0].size).toEqual({ w: 100, h: 40 });
    const outResized = worldPins(store.doc.components[0]).find((p) => p.pin.id === "out")!.pos;
    expect(store.doc.wires[0].points[0]).toEqual(outResized);

    // One undo restores pre-drag state completely
    store.undo();
    expect(store.doc.components[0].size).toBeUndefined();
    expect(store.doc.wires[0].points).toEqual(origWires[0].points);

    // Redo restores final dragged state
    store.redo();
    expect(store.doc.components[0].size).toEqual({ w: 100, h: 40 });

    // Cancel gesture (Esc) reverts completely without adding to undo stack
    const beforeCancelComp = structuredClone(store.doc.components[0]);
    const beforeCancelWires = structuredClone(store.doc.wires);
    store.beginGesture();
    const next2 = applyResizeDrag(beforeCancelComp, "se", { x: 50, y: 50 }, GRID);
    store.update("Resize", (draft) => {
      draft.components[0] = structuredClone(beforeCancelComp);
      draft.wires = structuredClone(beforeCancelWires);
      keepWiresAttached(draft, new Set(["b1"]), () => {
        draft.components[0].x = next2.x;
        draft.components[0].y = next2.y;
        draft.components[0].size = next2.size;
      });
    });
    expect(store.doc.components[0].size).toEqual({ w: 150, h: 90 });

    store.cancelGesture();
    expect(store.doc.components[0].size).toEqual({ w: 100, h: 40 });
    expect(store.doc.wires).toEqual(beforeCancelWires);
  });
});

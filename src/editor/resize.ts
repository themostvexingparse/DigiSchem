/**
 * Pure DOM-free math & document helpers for interactive component resizing.
 * Works generically for any ComponentDef with `resizable: "both" | "width" | "height"`.
 */
import type { ComponentDef } from "../model/component-def";
import { GRID } from "../model/component-def";
import type { ComponentInstance, Point, Rotation, SchematicDocument } from "../model/types";
import { getDef } from "../model/registry";
import { geometryOf, localToWorld, snap } from "../model/geometry";
import { keepWiresAttached } from "./doc-ops";

export type ResizeHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type ResizeCursor = "nwse-resize" | "nesw-resize" | "ns-resize" | "ew-resize";

export interface ResizeHandle {
  id: ResizeHandleId;
  /** World-space position of the handle (body rect corner or edge midpoint). */
  pos: Point;
  /** CSS resize cursor accounting for component rotation and mirror. */
  cursor: ResizeCursor;
}

export interface ResizeResult {
  x: number;
  y: number;
  size: { w: number; h: number };
}

interface HandleSpec {
  /** Normalized local X position on [0, width]: 0 = left, 0.5 = mid, 1 = right. */
  hx: 0 | 0.5 | 1;
  /** Normalized local Y position on [0, height]: 0 = top, 0.5 = mid, 1 = bottom. */
  hy: 0 | 0.5 | 1;
  /** Local outward direction unit-ish vector components (-1, 0, or 1). */
  dirX: -1 | 0 | 1;
  dirY: -1 | 0 | 1;
}

const HANDLE_SPECS: Record<ResizeHandleId, HandleSpec> = {
  nw: { hx: 0, hy: 0, dirX: -1, dirY: -1 },
  n:  { hx: 0.5, hy: 0, dirX: 0, dirY: -1 },
  ne: { hx: 1, hy: 0, dirX: 1, dirY: -1 },
  e:  { hx: 1, hy: 0.5, dirX: 1, dirY: 0 },
  se: { hx: 1, hy: 1, dirX: 1, dirY: 1 },
  s:  { hx: 0.5, hy: 1, dirX: 0, dirY: 1 },
  sw: { hx: 0, hy: 1, dirX: -1, dirY: 1 },
  w:  { hx: 0, hy: 0.5, dirX: -1, dirY: 0 },
};

const CORNER_HANDLES: readonly ResizeHandleId[] = ["nw", "ne", "se", "sw"];

/** Return the resize handles permitted by a ComponentDef's `resizable` mode. */
export function allowedHandles(resizable: ComponentDef["resizable"]): ResizeHandleId[] {
  // Handles are strictly at the four corners; a corner drag changes whichever axes the
  // component allows (both, or only width / height).
  if (resizable === "both" || resizable === "width" || resizable === "height") return [...CORNER_HANDLES];
  return [];
}

/**
 * Compute the CSS resize cursor for a handle on a rotated/mirrored component.
 * Transforms the handle's local outward direction vector into world/screen space.
 */
export function handleCursor(
  handle: ResizeHandleId,
  rotation: Rotation,
  mirror = false,
): ResizeCursor {
  const spec = HANDLE_SPECS[handle];
  let dx: number = mirror ? -spec.dirX : spec.dirX;
  let dy: number = spec.dirY;
  switch (rotation) {
    case 90:
      [dx, dy] = [-dy, dx];
      break;
    case 180:
      [dx, dy] = [-dx, -dy];
      break;
    case 270:
      [dx, dy] = [dy, -dx];
      break;
  }
  if (dx === 0) return "ns-resize";
  if (dy === 0) return "ew-resize";
  return dx * dy > 0 ? "nwse-resize" : "nesw-resize";
}

/**
 * Compute world-space resize handles for a component instance.
 * Returns an empty array if the component's def is not resizable.
 */
export function resizeHandles(inst: ComponentInstance): ResizeHandle[] {
  const def = getDef(inst.type);
  if (!def?.resizable) return [];
  const g = geometryOf(inst);
  const mirror = Boolean(inst.mirror);
  return allowedHandles(def.resizable).map((id) => {
    const spec = HANDLE_SPECS[id];
    const pos = localToWorld(inst, { x: spec.hx * g.width, y: spec.hy * g.height }, g);
    return {
      id,
      pos: { x: pos.x + 0, y: pos.y + 0 },
      cursor: handleCursor(id, inst.rotation, mirror),
    };
  });
}

/** Find the closest resize handle of `inst` within `tolerance` world units. */
export function hitTestResizeHandle(
  inst: ComponentInstance,
  worldPt: Point,
  tolerance = 8,
): ResizeHandle | null {
  let best: ResizeHandle | null = null;
  let bestDist = tolerance;
  for (const h of resizeHandles(inst)) {
    const d = Math.hypot(h.pos.x - worldPt.x, h.pos.y - worldPt.y);
    if (d <= bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}

/**
 * Convert a world-space drag delta into the component's local coordinate system
 * (inverse of rotation followed by inverse of horizontal mirror).
 */
export function worldDeltaToLocal(
  delta: Point,
  rotation: Rotation,
  mirror = false,
): Point {
  let u: number;
  let v: number;
  switch (rotation) {
    case 0:
      u = delta.x;
      v = delta.y;
      break;
    case 90:
      u = delta.y;
      v = -delta.x;
      break;
    case 180:
      u = -delta.x;
      v = -delta.y;
      break;
    case 270:
      u = -delta.y;
      v = delta.x;
      break;
  }
  const lx = mirror ? -u : u;
  return { x: lx + 0, y: v + 0 };
}

/**
 * Return true if `worldDelta`, converted into local coordinates and snapped to `grid`,
 * produces a non-zero change along at least one axis controlled by `handle`.
 */
export function hasSnappedResizeDelta(
  inst: ComponentInstance,
  handle: ResizeHandleId,
  worldDelta: Point,
  grid = GRID,
): boolean {
  const def = getDef(inst.type);
  if (!def?.resizable) return false;
  const spec = HANDLE_SPECS[handle];
  const canW = def.resizable === "both" || def.resizable === "width";
  const canH = def.resizable === "both" || def.resizable === "height";
  const local = worldDeltaToLocal(worldDelta, inst.rotation, Boolean(inst.mirror));
  const dlx = snap(local.x, grid);
  const dly = snap(local.y, grid);
  return (canW && spec.hx !== 0.5 && dlx !== 0) || (canH && spec.hy !== 0.5 && dly !== 0);
}

/**
 * Pure resize math: given the pre-drag component snapshot `origInst`, the dragged
 * handle `handle`, and the pointer's world-space displacement `worldDelta`, compute
 * the new grid-aligned `{ x, y, size }` such that:
 * - `size.w` and `size.h` are multiples of `grid` and never below `grid`,
 * - the real geometry (which may enforce def minimums) is used to position the origin
 *   so the opposite edge/corner stays fixed in world space across all rotations & mirror.
 */
export function applyResizeDrag(
  origInst: ComponentInstance,
  handle: ResizeHandleId,
  worldDelta: Point,
  grid = GRID,
): ResizeResult {
  const def = getDef(origInst.type);
  const origGeom = geometryOf(origInst);
  const baseW = Math.max(grid, snap(origInst.size?.w ?? origGeom.width, grid));
  const baseH = Math.max(grid, snap(origInst.size?.h ?? origGeom.height, grid));

  if (!def?.resizable) {
    return { x: origInst.x, y: origInst.y, size: { w: baseW, h: baseH } };
  }

  const spec = HANDLE_SPECS[handle];
  const canW = def.resizable === "both" || def.resizable === "width";
  const canH = def.resizable === "both" || def.resizable === "height";

  const localDelta = worldDeltaToLocal(worldDelta, origInst.rotation, Boolean(origInst.mirror));
  const dlx = snap(localDelta.x, grid);
  const dly = snap(localDelta.y, grid);

  let reqW = baseW;
  if (canW && spec.hx === 0) {
    reqW = Math.max(grid, snap(origGeom.width - dlx, grid));
  } else if (canW && spec.hx === 1) {
    reqW = Math.max(grid, snap(origGeom.width + dlx, grid));
  }

  let reqH = baseH;
  if (canH && spec.hy === 0) {
    reqH = Math.max(grid, snap(origGeom.height - dly, grid));
  } else if (canH && spec.hy === 1) {
    reqH = Math.max(grid, snap(origGeom.height + dly, grid));
  }

  const nextSize = { w: reqW, h: reqH };
  const nextGeom = geometryOf({ ...origInst, size: nextSize });

  // Anchor the opposite edge/corner in world space using the REAL geometry.
  // For an axis that is not dragged (0.5), fix local 0 (never 0.5, so odd-grid
  // dimensions never introduce half-grid origins).
  const anchorFracX = canW && spec.hx === 0 ? 1 : 0;
  const anchorFracY = canH && spec.hy === 0 ? 1 : 0;

  const anchorBefore = localToWorld(
    origInst,
    { x: anchorFracX * origGeom.width, y: anchorFracY * origGeom.height },
    origGeom,
  );
  const anchorOffsetAfter = localToWorld(
    { ...origInst, x: 0, y: 0, size: nextSize },
    { x: anchorFracX * nextGeom.width, y: anchorFracY * nextGeom.height },
    nextGeom,
  );

  const x = snap(anchorBefore.x - anchorOffsetAfter.x, grid) + 0;
  const y = snap(anchorBefore.y - anchorOffsetAfter.y, grid) + 0;

  return { x, y, size: nextSize };
}

/**
 * Set a resizable component's requested size (snapped to grid, >= grid) while keeping
 * attached wires connected to pins as they move.
 */
export function setComponentSizeInDoc(
  doc: SchematicDocument,
  compId: string,
  size: { w: number; h: number },
): void {
  const comp = doc.components.find((c) => c.id === compId);
  if (!comp) return;
  const def = getDef(comp.type);
  if (!def?.resizable) return;
  const grid = doc.grid || GRID;
  const nextW = Math.max(grid, snap(size.w, grid));
  const nextH = Math.max(grid, snap(size.h, grid));
  keepWiresAttached(doc, new Set([compId]), () => {
    comp.size = { w: nextW, h: nextH };
  });
}

/**
 * Reset a component's custom size (deleting `size`) while keeping attached wires
 * connected to pins as they return to their default positions.
 */
export function resetComponentSizeInDoc(doc: SchematicDocument, compId: string): void {
  const comp = doc.components.find((c) => c.id === compId);
  if (!comp || !comp.size) return;
  keepWiresAttached(doc, new Set([compId]), () => {
    delete comp.size;
  });
}

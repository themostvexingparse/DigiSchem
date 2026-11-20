/**
 * Pure DOM-free utilities for wire routing, normalization, rubber-band stretching,
 * segment dragging, hit testing, and auto-label numbering.
 */
import type {
  ComponentInstance,
  Point,
  SchematicDocument,
  TextNote,
  Wire,
} from "../model/types";
import { GRID } from "../model/component-def";
import { getDef } from "../model/registry";
import {
  boundsOfPoints,
  componentBounds,
  distToSegment,
  pointInRect,
  pointOnSegment,
  rectsIntersect,
  snap,
  wireSegments,
  worldPins,
  type Rect,
  type WorldPin,
} from "../model/geometry";

export function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

export function snapToGrid(p: Point, grid = GRID): Point {
  return { x: snap(p.x, grid), y: snap(p.y, grid) };
}

/**
 * Normalize an orthogonal wire polyline:
 * - drop consecutive duplicate points (zero-length segments)
 * - merge collinear consecutive points (including fold-backs)
 */
export function normalizeWirePoints(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const pt of points) {
    const p: Point = { x: pt.x, y: pt.y };
    if (out.length > 0 && pointsEqual(out[out.length - 1], p)) continue;
    out.push(p);
    while (out.length >= 3) {
      const a = out[out.length - 3];
      const b = out[out.length - 2];
      const c = out[out.length - 1];
      const sameX = a.x === b.x && b.x === c.x;
      const sameY = a.y === b.y && b.y === c.y;
      if (sameX || sameY) {
        out.splice(out.length - 2, 1);
        if (out.length >= 2 && pointsEqual(out[out.length - 2], out[out.length - 1])) {
          out.pop();
        }
      } else {
        break;
      }
    }
  }
  return out;
}

/** Normalize a wire, returning null if degenerate (< 2 points). */
export function normalizeWire(w: Wire): Wire | null {
  const pts = normalizeWirePoints(w.points);
  if (pts.length < 2) return null;
  return { ...w, points: pts };
}

/** Normalize all wires in a document in place, dropping degenerate wires (< 2 points). */
export function normalizeDocWires(doc: SchematicDocument): void {
  const kept: Wire[] = [];
  for (const w of doc.wires) {
    const pts = normalizeWirePoints(w.points);
    if (pts.length >= 2) {
      w.points = pts;
      kept.push(w);
    }
  }
  doc.wires = kept;
}

/**
 * Compute an orthogonal Manhattan L-route from `from` to `to`.
 * Returns 1 point if identical, 2 if axis-aligned, 3 with bend point otherwise.
 */
export function routeOrthogonal(from: Point, to: Point, horizontalFirst: boolean): Point[] {
  if (pointsEqual(from, to)) return [{ x: from.x, y: from.y }];
  if (from.x === to.x || from.y === to.y) {
    return [
      { x: from.x, y: from.y },
      { x: to.x, y: to.y },
    ];
  }
  const bend: Point = horizontalFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  return [{ x: from.x, y: from.y }, bend, { x: to.x, y: to.y }];
}

/** Build a normalized wire preview from committed vertices to the current target point. */
export function buildWirePreview(
  committed: readonly Point[],
  target: Point,
  horizontalFirst: boolean,
): Point[] {
  if (committed.length === 0) return [{ x: target.x, y: target.y }];
  const last = committed[committed.length - 1];
  const leg = routeOrthogonal(last, target, horizontalFirst);
  return normalizeWirePoints([...committed, ...leg.slice(1)]);
}

/** Whether a pin's stub points horizontally in world space (accounting for rotation). */
export function pinExitHorizontal(inst: ComponentInstance, side: "left" | "right" | "top" | "bottom"): boolean {
  const localHoriz = side === "left" || side === "right";
  const quarterTurn = inst.rotation === 90 || inst.rotation === 270;
  return quarterTurn ? !localHoriz : localHoriz;
}

/**
 * Stretch the START endpoint (index 0) of an orthogonal polyline from origPoints[0]
 * to `newStart`, keeping the adjacent segment orthogonal by adjusting/inserting a vertex.
 * Never moves the opposite endpoint (index length - 1).
 */
export function stretchWireStart(origPoints: readonly Point[], newStart: Point): Point[] {
  if (origPoints.length < 2) return origPoints.map((p) => ({ ...p }));
  const p0 = origPoints[0];
  const p1 = origPoints[1];
  if (pointsEqual(p0, newStart)) return origPoints.map((p) => ({ ...p }));

  const rest = origPoints.slice(1).map((p) => ({ ...p }));
  const wasHoriz = p0.y === p1.y;
  const wasVert = p0.x === p1.x;

  if (origPoints.length === 2) {
    // Only 2 points: p1 is the opposite endpoint and must remain fixed.
    if (wasHoriz) {
      if (newStart.y === p1.y) {
        return [{ ...newStart }, { ...p1 }];
      }
      // Insert bend to keep adjacent segment horizontal
      return [{ ...newStart }, { x: p1.x, y: newStart.y }, { ...p1 }];
    }
    if (wasVert) {
      if (newStart.x === p1.x) {
        return [{ ...newStart }, { ...p1 }];
      }
      // Insert bend to keep adjacent segment vertical
      return [{ ...newStart }, { x: newStart.x, y: p1.y }, { ...p1 }];
    }
    // Non-orthogonal fallback: insert horizontal-first bend
    return [{ ...newStart }, { x: p1.x, y: newStart.y }, { ...p1 }];
  }

  // 3+ points: p1 is an interior corner vertex that we can adjust if orthogonal with p2.
  const p2 = origPoints[2];
  if (wasHoriz) {
    if (newStart.y === p1.y) {
      return [{ ...newStart }, ...rest];
    }
    if (p1.x === p2.x) {
      // Adjust p1 vertically to follow newStart.y while staying aligned with p2.x
      rest[0] = { x: p1.x, y: newStart.y };
      return [{ ...newStart }, ...rest];
    }
    return [{ ...newStart }, { x: p1.x, y: newStart.y }, ...rest];
  }
  if (wasVert) {
    if (newStart.x === p1.x) {
      return [{ ...newStart }, ...rest];
    }
    if (p1.y === p2.y) {
      // Adjust p1 horizontally to follow newStart.x while staying aligned with p2.y
      rest[0] = { x: newStart.x, y: p1.y };
      return [{ ...newStart }, ...rest];
    }
    return [{ ...newStart }, { x: newStart.x, y: p1.y }, ...rest];
  }
  return [{ ...newStart }, { x: p1.x, y: newStart.y }, ...rest];
}

/**
 * Stretch a wire whose start and/or end endpoints are attached to moved component pins.
 * `delta` is the movement vector from the wire's original state.
 */
export function stretchWireForMove(
  origPoints: readonly Point[],
  startAttached: boolean,
  endAttached: boolean,
  delta: Point,
  normalize = true,
): Point[] {
  if (origPoints.length < 2 || (delta.x === 0 && delta.y === 0) || (!startAttached && !endAttached)) {
    return origPoints.map((p) => ({ ...p }));
  }
  let pts: Point[];
  if (startAttached && endAttached) {
    pts = origPoints.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
  } else if (startAttached) {
    const newStart = { x: origPoints[0].x + delta.x, y: origPoints[0].y + delta.y };
    pts = stretchWireStart(origPoints, newStart);
  } else {
    // Stretch end endpoint symmetrically by reversing, stretching start, and reversing back
    const rev = [...origPoints].reverse();
    const newEnd = { x: rev[0].x + delta.x, y: rev[0].y + delta.y };
    pts = stretchWireStart(rev, newEnd).reverse();
  }
  return normalize ? normalizeWirePoints(pts) : pts;
}

export interface AttachedWireSnapshot {
  wireId: string;
  origPoints: Point[];
  startAttached: boolean;
  endAttached: boolean;
}

/**
 * Find all UNSELECTED wires that have an endpoint coinciding with a pin of any
 * moved component in `movedComponentIds`.
 */
export function captureAttachedWires(
  doc: SchematicDocument,
  movedComponentIds: ReadonlySet<string>,
  selectedWireIds: ReadonlySet<string>,
): AttachedWireSnapshot[] {
  if (movedComponentIds.size === 0) return [];
  const movedPinKeys = new Set<string>();
  for (const c of doc.components) {
    if (!movedComponentIds.has(c.id)) continue;
    for (const wp of worldPins(c)) {
      movedPinKeys.add(pointKey(wp.pos));
    }
  }
  if (movedPinKeys.size === 0) return [];

  const result: AttachedWireSnapshot[] = [];
  for (const w of doc.wires) {
    if (selectedWireIds.has(w.id) || w.points.length < 2) continue;
    const startAttached = movedPinKeys.has(pointKey(w.points[0]));
    const endAttached = movedPinKeys.has(pointKey(w.points[w.points.length - 1]));
    if (startAttached || endAttached) {
      result.push({
        wireId: w.id,
        origPoints: w.points.map((p) => ({ ...p })),
        startAttached,
        endAttached,
      });
    }
  }
  return result;
}

/**
 * True if `pt` is connected to any component pin or lies on any segment of
 * another wire (excluding `excludeWireId`).
 */
export function isPointAnchored(
  doc: SchematicDocument,
  pt: Point,
  excludeWireId?: string,
): boolean {
  for (const c of doc.components) {
    for (const wp of worldPins(c)) {
      if (pointsEqual(wp.pos, pt)) return true;
    }
  }
  for (const w of doc.wires) {
    if (w.id === excludeWireId || w.points.length < 2) continue;
    for (const [a, b] of wireSegments(w)) {
      if (pointOnSegment(pt, a, b)) return true;
    }
  }
  return false;
}

/**
 * Move a single segment `segIndex` (between origPoints[segIndex] and origPoints[segIndex + 1])
 * perpendicular to itself by `delta` (uses delta.y for horizontal segments, delta.x for vertical).
 * Adjusts adjacent segments, and preserves anchored wire endpoints by inserting a stub segment.
 */
export function dragWireSegmentPoints(
  origPoints: readonly Point[],
  segIndex: number,
  delta: Point,
  startAnchored: boolean,
  endAnchored: boolean,
  normalize = true,
): Point[] {
  if (segIndex < 0 || segIndex + 1 >= origPoints.length) {
    return origPoints.map((p) => ({ ...p }));
  }
  const a = origPoints[segIndex];
  const b = origPoints[segIndex + 1];
  const isHoriz = a.y === b.y;
  const isVert = a.x === b.x;
  if (!isHoriz && !isVert) return origPoints.map((p) => ({ ...p }));

  const shift = isHoriz ? delta.y : delta.x;
  if (shift === 0) return origPoints.map((p) => ({ ...p }));

  const pts = origPoints.map((p) => ({ ...p }));
  let idxA = segIndex;
  let idxB = segIndex + 1;

  // Move the segment endpoints perpendicular to the segment
  if (isHoriz) {
    pts[idxA].y += shift;
    pts[idxB].y += shift;
  } else {
    pts[idxA].x += shift;
    pts[idxB].x += shift;
  }

  // If the segment starts at the wire's first point and that point is anchored, prepend the original anchor
  if (segIndex === 0 && startAnchored) {
    pts.unshift({ ...origPoints[0] });
    idxA += 1;
    idxB += 1;
  }

  // If the segment ends at the wire's last point and that point is anchored, append the original anchor
  if (segIndex + 1 === origPoints.length - 1 && endAnchored) {
    pts.push({ ...origPoints[origPoints.length - 1] });
  }

  // Ensure neighbors (if any) stay orthogonal:
  // If segIndex > 0 and origPoints[segIndex - 1] was somehow collinear (non-normalized), handle gracefully
  if (idxA > 0) {
    const prev = pts[idxA - 1];
    const curr = pts[idxA];
    if (prev.x !== curr.x && prev.y !== curr.y) {
      const origA = origPoints[segIndex];
      const bridge = isHoriz ? { x: origA.x, y: curr.y } : { x: curr.x, y: origA.y };
      pts.splice(idxA, 0, bridge);
      idxB += 1;
    }
  }
  if (idxB + 1 < pts.length) {
    const curr = pts[idxB];
    const next = pts[idxB + 1];
    if (curr.x !== next.x && curr.y !== next.y) {
      const origB = origPoints[segIndex + 1];
      const bridge = isHoriz ? { x: origB.x, y: curr.y } : { x: curr.x, y: origB.y };
      pts.splice(idxB + 1, 0, bridge);
    }
  }

  return normalize ? normalizeWirePoints(pts) : pts;
}

/**
 * Find the next unused label `${prefix}${n}` (n = 1, 2, ...) in the document.
 */
export function nextAutoLabel(doc: SchematicDocument, prefix: string): string {
  const used = new Set<string>();
  for (const c of doc.components) {
    if (c.label) used.add(c.label);
  }
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Choose a label for a pasted/duplicated component:
 * If it matches its component definition's `${labelPrefix}\d+` pattern (or `^[A-Za-z]+\d+$`),
 * assign the next free numbered label with that prefix; otherwise keep the custom label.
 */
export function nextCopyLabel(doc: SchematicDocument, inst: ComponentInstance): string | undefined {
  if (!inst.label) return undefined;
  const def = getDef(inst.type);
  const prefix = def?.labelPrefix;
  if (prefix) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${escaped}\\d+$`).test(inst.label)) {
      return nextAutoLabel(doc, prefix);
    }
  }
  return inst.label;
}

/** Approximate world bounding box of a TextNote, matching renderText(). */
export function textBounds(t: TextNote): Rect {
  const fs = t.fontSize ?? 14;
  const lines = t.text.split("\n");
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  const w = Math.max(fs, maxLen * fs * 0.62);
  const h = lines.length * fs * 1.25;
  return { x: t.x, y: t.y - fs, w, h };
}

/** Find the closest component pin within `tolerance` world units. */
export function findPinAt(
  doc: SchematicDocument,
  worldPt: Point,
  tolerance = 8,
  cachedPins?: readonly WorldPin[],
): WorldPin | null {
  let best: WorldPin | null = null;
  let bestDist = tolerance;
  const pins = cachedPins ?? doc.components.flatMap((c) => worldPins(c));
  for (const wp of pins) {
    const d = Math.hypot(wp.pos.x - worldPt.x, wp.pos.y - worldPt.y);
    if (d <= bestDist) {
      bestDist = d;
      best = wp;
    }
  }
  return best;
}

export interface WireHit {
  wire: Wire;
  segmentIndex: number;
  dist: number;
}

/** Find the closest wire segment within `tolerance` world units. */
export function hitTestWire(
  doc: SchematicDocument,
  worldPt: Point,
  tolerance = 6,
  excludeWireId?: string,
): WireHit | null {
  let best: WireHit | null = null;
  for (let wi = doc.wires.length - 1; wi >= 0; wi--) {
    const w = doc.wires[wi];
    if (w.id === excludeWireId || w.points.length < 2) continue;
    for (let i = 0; i + 1 < w.points.length; i++) {
      const d = distToSegment(worldPt, w.points[i], w.points[i + 1]);
      if (d <= tolerance && (!best || d < best.dist)) {
        best = { wire: w, segmentIndex: i, dist: d };
      }
    }
  }
  return best;
}

/** Find the topmost component whose bounding box (expanded by `padding`) contains `worldPt`. */
export function hitTestComponent(
  doc: SchematicDocument,
  worldPt: Point,
  padding = 2,
  cachedBounds?: readonly { comp: ComponentInstance; bounds: Rect }[],
): ComponentInstance | null {
  if (cachedBounds) {
    for (let i = cachedBounds.length - 1; i >= 0; i--) {
      const { comp, bounds } = cachedBounds[i];
      const r: Rect = {
        x: bounds.x - padding,
        y: bounds.y - padding,
        w: bounds.w + 2 * padding,
        h: bounds.h + 2 * padding,
      };
      if (pointInRect(worldPt, r)) return comp;
    }
    return null;
  }
  for (let i = doc.components.length - 1; i >= 0; i--) {
    const c = doc.components[i];
    const b = componentBounds(c);
    const r: Rect = {
      x: b.x - padding,
      y: b.y - padding,
      w: b.w + 2 * padding,
      h: b.h + 2 * padding,
    };
    if (pointInRect(worldPt, r)) return c;
  }
  return null;
}

/** Find the topmost text note containing `worldPt`. */
export function hitTestText(doc: SchematicDocument, worldPt: Point, padding = 3): TextNote | null {
  for (let i = doc.texts.length - 1; i >= 0; i--) {
    const t = doc.texts[i];
    const b = textBounds(t);
    const r: Rect = {
      x: b.x - padding,
      y: b.y - padding,
      w: b.w + 2 * padding,
      h: b.h + 2 * padding,
    };
    if (pointInRect(worldPt, r)) return t;
  }
  return null;
}

export type DocHit =
  | { kind: "text"; id: string; text: TextNote }
  | { kind: "component"; id: string; component: ComponentInstance }
  | { kind: "wire"; id: string; wire: Wire; segmentIndex: number };

/** Hit test document items in visual top-to-bottom order: text > component > wire. */
export function hitTestDocument(
  doc: SchematicDocument,
  worldPt: Point,
  wireTolerance = 6,
  cachedBounds?: readonly { comp: ComponentInstance; bounds: Rect }[],
): DocHit | null {
  const txt = hitTestText(doc, worldPt);
  if (txt) return { kind: "text", id: txt.id, text: txt };
  const comp = hitTestComponent(doc, worldPt, 2, cachedBounds);
  if (comp) return { kind: "component", id: comp.id, component: comp };
  const wire = hitTestWire(doc, worldPt, wireTolerance);
  if (wire) return { kind: "wire", id: wire.wire.id, wire: wire.wire, segmentIndex: wire.segmentIndex };
  return null;
}

export type SnapTarget =
  | { kind: "pin"; pos: Point; pin: WorldPin }
  | { kind: "wire"; pos: Point; wireId: string };

/**
 * Find a connectable snap target (pin takes priority over wire) under `worldPt`.
 * For wire hits, projects `worldPt` onto the hit segment and snaps to grid along it.
 */
export function findSnapTarget(
  doc: SchematicDocument,
  worldPt: Point,
  tolerance = 8,
  cachedPins?: readonly WorldPin[],
  excludeWireId?: string,
): SnapTarget | null {
  const pin = findPinAt(doc, worldPt, tolerance, cachedPins);
  if (pin) return { kind: "pin", pos: { ...pin.pos }, pin };

  const grid = doc.grid || GRID;
  const wireHit = hitTestWire(doc, worldPt, tolerance, excludeWireId);
  if (wireHit) {
    const a = wireHit.wire.points[wireHit.segmentIndex];
    const b = wireHit.wire.points[wireHit.segmentIndex + 1];
    let snapped: Point;
    if (a.y === b.y) {
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const cx = Math.max(minX, Math.min(maxX, snap(worldPt.x, grid)));
      snapped = { x: cx, y: a.y };
    } else if (a.x === b.x) {
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      const cy = Math.max(minY, Math.min(maxY, snap(worldPt.y, grid)));
      snapped = { x: a.x, y: cy };
    } else {
      snapped = snapToGrid(worldPt, grid);
    }
    return { kind: "wire", pos: snapped, wireId: wireHit.wire.id };
  }
  return null;
}

/** True if segment ab intersects rectangle r (exact for axis-aligned and general segments). */
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const segRect = boundsOfPoints([a, b]);
  if (!rectsIntersect(segRect, r)) return false;
  // For axis-aligned segments, bounding-box intersection is exact!
  if (a.x === b.x || a.y === b.y) return true;
  // General Liang-Barsky clip
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

/** Return IDs of all components, wires, and texts intersecting `rect`. */
export function itemsInRect(
  doc: SchematicDocument,
  rect: Rect,
  cachedBounds?: readonly { comp: ComponentInstance; bounds: Rect }[],
): string[] {
  const ids: string[] = [];
  if (cachedBounds) {
    for (const { comp, bounds } of cachedBounds) {
      if (rectsIntersect(bounds, rect)) ids.push(comp.id);
    }
  } else {
    for (const c of doc.components) {
      if (rectsIntersect(componentBounds(c), rect)) ids.push(c.id);
    }
  }
  for (const w of doc.wires) {
    if (w.points.length < 2) continue;
    for (const [a, b] of wireSegments(w)) {
      if (segmentIntersectsRect(a, b, rect)) {
        ids.push(w.id);
        break;
      }
    }
  }
  for (const t of doc.texts) {
    if (rectsIntersect(textBounds(t), rect)) ids.push(t.id);
  }
  return ids;
}

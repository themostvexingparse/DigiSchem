/** CORE CONTRACT — geometry helpers shared by renderer, editor and exporters. */
import type { ComponentInstance, Point, SchematicDocument, Wire } from "./types";
import type { Geometry, PinDef } from "./component-def";
import { GRID } from "./component-def";
import { getDef } from "./registry";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function snap(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid;
}

export function snapPoint(p: Point, grid = GRID): Point {
  return { x: snap(p.x, grid), y: snap(p.y, grid) };
}

const FALLBACK_GEOMETRY: Geometry = { width: 40, height: 40, pins: [] };

export function geometryOf(inst: ComponentInstance): Geometry {
  const def = getDef(inst.type);
  if (!def) return FALLBACK_GEOMETRY;
  return def.geometry({ ...def.defaultProps, ...inst.props });
}

/** Local → world transform: mirror (about x=width/2), then rotate clockwise about origin, then translate. */
export function localToWorld(inst: ComponentInstance, p: Point, geom?: Geometry): Point {
  const g = geom ?? geometryOf(inst);
  let x = inst.mirror ? g.width - p.x : p.x;
  let y = p.y;
  switch (inst.rotation) {
    case 90: [x, y] = [-y, x]; break;
    case 180: [x, y] = [-x, -y]; break;
    case 270: [x, y] = [y, -x]; break;
  }
  return { x: inst.x + x, y: inst.y + y };
}

/** SVG transform attribute value equivalent to localToWorld. */
export function svgTransform(inst: ComponentInstance, geom?: Geometry): string {
  const g = geom ?? geometryOf(inst);
  let t = `translate(${inst.x} ${inst.y})`;
  if (inst.rotation) t += ` rotate(${inst.rotation})`;
  if (inst.mirror) t += ` translate(${g.width} 0) scale(-1 1)`;
  return t;
}

export interface WorldPin {
  componentId: string;
  pin: PinDef;
  pos: Point;
}

export function worldPins(inst: ComponentInstance): WorldPin[] {
  const g = geometryOf(inst);
  return g.pins.map((pin) => ({ componentId: inst.id, pin, pos: localToWorld(inst, pin, g) }));
}

/** World-space bounding box of a component's body (pins included). */
export function componentBounds(inst: ComponentInstance): Rect {
  const g = geometryOf(inst);
  const pts: Point[] = [
    { x: 0, y: 0 },
    { x: g.width, y: 0 },
    { x: 0, y: g.height },
    { x: g.width, y: g.height },
    ...g.pins,
  ].map((p) => localToWorld(inst, p, g));
  return boundsOfPoints(pts);
}

export function boundsOfPoints(pts: Point[]): Rect {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Bounding box of everything in the document (components, wires, texts). Null if empty. */
export function documentBounds(doc: SchematicDocument): Rect | null {
  let r: Rect | null = null;
  for (const c of doc.components) r = unionRect(r, componentBounds(c));
  for (const w of doc.wires) r = unionRect(r, boundsOfPoints(w.points));
  for (const t of doc.texts) {
    const fs = t.fontSize ?? 14;
    r = unionRect(r, { x: t.x, y: t.y - fs, w: Math.max(fs, t.text.length * fs * 0.6), h: fs * 1.3 });
  }
  return r;
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** True if p lies on segment ab (inclusive of endpoints), for axis-aligned integer geometry. */
export function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  return distToSegment(p, a, b) < 0.5;
}

export function wireSegments(w: Wire): [Point, Point][] {
  const segs: [Point, Point][] = [];
  for (let i = 0; i + 1 < w.points.length; i++) segs.push([w.points[i], w.points[i + 1]]);
  return segs;
}

const key = (p: Point) => `${p.x},${p.y}`;

/**
 * Points where a junction dot should be drawn: any point where 3 or more
 * connection "arms" meet (wire endpoints, interior vertices on other wires' segments, pins).
 */
export function junctionPoints(doc: SchematicDocument): Point[] {
  // Count arms per grid point.
  const arms = new Map<string, number>();
  const add = (p: Point, n: number) => arms.set(key(p), (arms.get(key(p)) ?? 0) + n);
  const pinSet = new Set<string>();
  for (const c of doc.components) for (const wp of worldPins(c)) pinSet.add(key(wp.pos));

  const allSegs: [Point, Point][] = doc.wires.flatMap(wireSegments);
  const endpoints: Point[] = [];
  for (const w of doc.wires) {
    if (w.points.length < 2) continue;
    endpoints.push(w.points[0], w.points[w.points.length - 1]);
  }
  // Each segment contributes one arm at each of its two endpoints.
  for (const [a, b] of allSegs) {
    if (a.x === b.x && a.y === b.y) continue;
    add(a, 1);
    add(b, 1);
  }
  // A wire endpoint landing mid-segment of another segment adds two arms there (T-junction).
  for (const e of endpoints) {
    for (const [a, b] of allSegs) {
      if ((a.x === e.x && a.y === e.y) || (b.x === e.x && b.y === e.y)) continue;
      if (pointOnSegment(e, a, b)) add(e, 2);
    }
  }
  for (const k of pinSet) if (arms.has(k)) add({ x: +k.split(",")[0], y: +k.split(",")[1] }, 1);

  const out: Point[] = [];
  for (const [k, n] of arms) {
    if (n >= 3) {
      const [x, y] = k.split(",").map(Number);
      out.push({ x, y });
    }
  }
  return out;
}

/** Pin endpoints (world) that have no wire or other pin attached — rendered as small "unconnected" markers in the editor. */
export function unconnectedPins(doc: SchematicDocument): Point[] {
  const touched = new Set<string>();
  for (const w of doc.wires) for (const p of w.points) touched.add(key(p));
  const pinCount = new Map<string, number>();
  const pins: Point[] = [];
  for (const c of doc.components)
    for (const wp of worldPins(c)) {
      pins.push(wp.pos);
      pinCount.set(key(wp.pos), (pinCount.get(key(wp.pos)) ?? 0) + 1);
    }
  const segs = doc.wires.flatMap(wireSegments);
  return pins.filter(
    (p) => !touched.has(key(p)) && (pinCount.get(key(p)) ?? 0) < 2 && !segs.some(([a, b]) => pointOnSegment(p, a, b)),
  );
}

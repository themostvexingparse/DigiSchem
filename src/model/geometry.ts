/** CORE CONTRACT — geometry helpers shared by renderer, editor and exporters. */
import type { ComponentInstance, Point, PropValue, SchematicDocument, Wire } from "./types";
import type { Geometry, PinDef } from "./component-def";
import { GRID, SIZE_H, SIZE_W } from "./component-def";
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

/**
 * The props a def's geometry()/symbol() must be called with for an instance:
 * defaults, then instance props, then the resize request as `_w` / `_h`.
 * ALWAYS use this instead of merging props by hand.
 */
export function effectiveProps(inst: Pick<ComponentInstance, "type" | "props" | "size">): Record<string, PropValue> {
  const def = getDef(inst.type);
  const p: Record<string, PropValue> = { ...(def?.defaultProps ?? {}), ...inst.props };
  if (inst.size && def?.resizable) {
    if (def.resizable !== "height") p[SIZE_W] = inst.size.w;
    if (def.resizable !== "width") p[SIZE_H] = inst.size.h;
  }
  return p;
}

export function geometryOf(inst: ComponentInstance): Geometry {
  const def = getDef(inst.type);
  if (!def) return FALLBACK_GEOMETRY;
  return def.geometry(effectiveProps(inst));
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

/** Multi-line text note bounds (approximate glyph metrics; matches renderText line spacing). */
export function textNoteBounds(t: { x: number; y: number; text: string; fontSize?: number }): Rect {
  const fs = t.fontSize ?? 14;
  const lines = t.text.split(/\n/);
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  return { x: t.x, y: t.y - fs, w: Math.max(fs, maxLen * fs * 0.6), h: (lines.length - 1) * fs * 1.25 + fs * 1.35 };
}

export type LabelPlacement = "above" | "below" | "corner";

/**
 * Where a component's label goes so it never sits on a wire leaving a pin:
 * above the body by default, below it when pins leave from the top edge, and at the
 * top-right corner (outside the body) when pins leave from both top and bottom.
 */
export function labelPlacement(inst: ComponentInstance): LabelPlacement {
  const b = componentBounds(inst);
  const pins = worldPins(inst);
  const top = pins.some((p) => p.pos.y === b.y);
  const bottom = pins.some((p) => p.pos.y === b.y + b.h);
  return top ? (bottom ? "corner" : "below") : "above";
}

/** Anchor point + text-anchor of a component's label (world space). */
export function labelAnchor(inst: ComponentInstance): { x: number; y: number; anchor: "middle" | "start" } {
  const b = componentBounds(inst);
  switch (labelPlacement(inst)) {
    case "below":
      return { x: b.x + b.w / 2, y: b.y + b.h + 15, anchor: "middle" };
    case "corner":
      return { x: b.x + b.w + 4, y: b.y - 4, anchor: "start" };
    default:
      return { x: b.x + b.w / 2, y: b.y - 6, anchor: "middle" };
  }
}

/** Approximate bounds of a component's upright label (see labelAnchor). */
export function labelBounds(inst: ComponentInstance): Rect | null {
  if (!inst.label) return null;
  const a = labelAnchor(inst);
  const w = inst.label.length * 6.5 + 8;
  return { x: a.anchor === "middle" ? a.x - w / 2 : a.x, y: a.y - 14, w, h: 16 };
}

/** Bounding box of everything in the document (components + labels, wires, texts). Null if empty. */
export function documentBounds(doc: SchematicDocument): Rect | null {
  let r: Rect | null = null;
  for (const c of doc.components) {
    r = unionRect(r, componentBounds(c));
    const lb = labelBounds(c);
    if (lb) r = unionRect(r, lb);
  }
  for (const w of doc.wires) r = unionRect(r, boundsOfPoints(w.points));
  for (const t of doc.texts) r = unionRect(r, textNoteBounds(t));
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
 * Index of axis-aligned wire segments by row (horizontal) and column (vertical), so
 * "which segments contain point p" is a map lookup instead of a scan over all wires.
 * Non-axis-aligned segments (only possible in hand-edited files) go to a slow list.
 */
export interface SegmentRef {
  wire: number; // index into the wires array given to buildSegmentIndex
  lo: number;
  hi: number;
}
export class SegmentIndex {
  readonly rows = new Map<number, SegmentRef[]>(); // y -> horizontal segments [lo..hi] in x
  readonly cols = new Map<number, SegmentRef[]>(); // x -> vertical segments [lo..hi] in y
  readonly diagonal: { wire: number; a: Point; b: Point }[] = [];

  constructor(wires: readonly Wire[]) {
    wires.forEach((w, wi) => {
      for (let i = 0; i + 1 < w.points.length; i++) {
        const a = w.points[i], b = w.points[i + 1];
        if (a.x === b.x && a.y === b.y) continue;
        if (a.y === b.y) push(this.rows, a.y, { wire: wi, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
        else if (a.x === b.x) push(this.cols, a.x, { wire: wi, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
        else this.diagonal.push({ wire: wi, a, b });
      }
    });
  }

  /** Bitmask of distinct directions wires leave p in: 1=E, 2=W, 4=S, 8=N. */
  directionsAt(p: Point): number {
    let m = 0;
    for (const s of this.rows.get(p.y) ?? []) {
      if (p.x < s.lo || p.x > s.hi) continue;
      if (s.hi > p.x) m |= 1;
      if (s.lo < p.x) m |= 2;
    }
    for (const s of this.cols.get(p.x) ?? []) {
      if (p.y < s.lo || p.y > s.hi) continue;
      if (s.hi > p.y) m |= 4;
      if (s.lo < p.y) m |= 8;
    }
    return m;
  }

  /** Indices of wires with a segment containing p (endpoints inclusive). */
  wiresAt(p: Point): Set<number> {
    const out = new Set<number>();
    for (const s of this.rows.get(p.y) ?? []) if (p.x >= s.lo && p.x <= s.hi) out.add(s.wire);
    for (const s of this.cols.get(p.x) ?? []) if (p.y >= s.lo && p.y <= s.hi) out.add(s.wire);
    for (const d of this.diagonal) if (pointOnSegment(p, d.a, d.b)) out.add(d.wire);
    return out;
  }

  hasWireAt(p: Point): boolean {
    for (const s of this.rows.get(p.y) ?? []) if (p.x >= s.lo && p.x <= s.hi) return true;
    for (const s of this.cols.get(p.x) ?? []) if (p.y >= s.lo && p.y <= s.hi) return true;
    return this.diagonal.some((d) => pointOnSegment(p, d.a, d.b));
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

const popcount4 = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

/**
 * CONNECTIVITY RULE (shared by junction dots, unconnected-pin markers and the netlist):
 * two items connect at a point that is a vertex of one and lies on a segment of the other
 * (shared vertices, T-junctions, overlapping collinear wires, corners resting on a wire,
 * pins on wires). Plain crossings (no vertex at the crossing) do NOT connect.
 *
 * A junction dot is drawn at a vertex/pin point where (distinct wire directions + pins) >= 3.
 */
export function junctionPoints(doc: SchematicDocument): Point[] {
  const idx = new SegmentIndex(doc.wires);
  const pinCount = new Map<string, number>();
  const candidates = new Map<string, Point>();
  for (const c of doc.components)
    for (const wp of worldPins(c)) {
      const k = key(wp.pos);
      pinCount.set(k, (pinCount.get(k) ?? 0) + 1);
      candidates.set(k, wp.pos);
    }
  for (const w of doc.wires) for (const p of w.points) candidates.set(key(p), p);
  const out: Point[] = [];
  for (const [k, p] of candidates) {
    const dirs = popcount4(idx.directionsAt(p));
    const pins = pinCount.get(k) ?? 0;
    if (dirs === 0) continue; // pins merely abutting: no dot
    if (dirs + pins >= 3) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Pin positions (world) with no wire on them and no other pin coinciding — drawn as "unconnected" markers. */
export function unconnectedPins(doc: SchematicDocument): Point[] {
  const idx = new SegmentIndex(doc.wires);
  const pinCount = new Map<string, number>();
  const pins: Point[] = [];
  for (const c of doc.components)
    for (const wp of worldPins(c)) {
      pins.push(wp.pos);
      pinCount.set(key(wp.pos), (pinCount.get(key(wp.pos)) ?? 0) + 1);
    }
  return pins.filter((p) => (pinCount.get(key(p)) ?? 0) < 2 && !idx.hasWireAt(p));
}

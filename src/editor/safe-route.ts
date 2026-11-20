/**
 * Short-free wire routing.
 *
 * Connectivity is geometric (a vertex of one item lying on another item connects them), so a
 * wire path that merely *passes over* a pin, touches another wire's vertex, or puts one of its
 * bends on another wire silently creates a connection. Every editor operation that re-routes
 * a wire (stretching on move/nudge/rotate/mirror/resize/prop change, segment drags, drawing)
 * must therefore check its result with `routeIsBad` and fall back to `safeRoute`, which searches
 * a small family of orthogonal candidates for the simplest path that only touches its own
 * endpoints and never cuts through a component body.
 */
import type { ComponentInstance, Point, SchematicDocument } from "../model/types";
import type { Side } from "../model/component-def";
import { GRID } from "../model/component-def";
import { componentBounds, worldPins, type Rect } from "../model/geometry";
import { normalizeWirePoints, pinExitVector } from "./wire-utils";

const key = (p: Point) => `${p.x},${p.y}`;

/**
 * Allowed-contact keys for a move: every attached wire end that moved WITH the selection
 * keeps whatever T-junction it had. `attached` lists wires with flags for which end moved.
 */
export function movedEndContacts(
  doc: SchematicDocument,
  attached: readonly { wireId: string; startAttached: boolean; endAttached: boolean }[],
): Set<string> {
  const out = new Set<string>();
  for (const a of attached) {
    const w = doc.wires.find((x) => x.id === a.wireId);
    if (!w || w.points.length < 2) continue;
    if (a.startAttached) out.add(`${w.id}@${key(w.points[0])}`);
    if (a.endAttached) out.add(`${w.id}@${key(w.points[w.points.length - 1])}`);
  }
  return out;
}

interface Seg {
  wireId: string;
  lo: number;
  hi: number;
}
interface PinRef {
  pos: Point;
  inst: ComponentInstance;
  side: Side;
}

/** Spatial index of everything a new/changed wire must not accidentally touch. */
export class RouteObstacles {
  readonly grid: number;
  /** horizontal wire segments by y / vertical by x */
  private hRows = new Map<number, Seg[]>();
  private vCols = new Map<number, Seg[]>();
  /** wire vertices: key -> wire ids, plus row/column indexes of vertex keys */
  private vertices = new Map<string, Set<string>>();
  /** "wireId@x,y" for every wire ENDPOINT (T-junction ends are legitimate contacts for peers). */
  private endpointKeys = new Set<string>();
  private vtxRows = new Map<number, Point[]>();
  private vtxCols = new Map<number, Point[]>();
  private pinsByKey = new Map<string, PinRef[]>();
  private pinRows = new Map<number, PinRef[]>();
  private pinCols = new Map<number, PinRef[]>();
  private bodies: { id: string; r: Rect }[] = [];

  /** `ignoreWires`: wires left out entirely (e.g. other wires that are about to be re-routed). */
  constructor(doc: SchematicDocument, ignoreWires: ReadonlySet<string> = new Set()) {
    this.grid = doc.grid || GRID;
    for (const w of doc.wires) {
      // Ignored (about-to-be-rerouted) wires still pin down their ENDPOINTS: a repair keeps
      // endpoints fixed, so other routes must not run over them.
      const ignored = ignoreWires.has(w.id);
      for (let i = 0; i < w.points.length; i++) {
        if (ignored && i !== 0 && i !== w.points.length - 1) continue;
        const p = w.points[i];
        const k = key(p);
        let s = this.vertices.get(k);
        if (!s) {
          this.vertices.set(k, (s = new Set()));
          push(this.vtxRows, p.y, p);
          push(this.vtxCols, p.x, p);
        }
        s.add(w.id);
        if (i === 0 || i === w.points.length - 1) this.endpointKeys.add(`${w.id}@${k}`);
        if (!ignored && i + 1 < w.points.length) {
          const q = w.points[i + 1];
          if (p.y === q.y && p.x !== q.x) push(this.hRows, p.y, { wireId: w.id, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) });
          else if (p.x === q.x && p.y !== q.y) push(this.vCols, p.x, { wireId: w.id, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) });
        }
      }
    }
    for (const c of doc.components) {
      for (const wp of worldPins(c)) {
        const ref: PinRef = { pos: wp.pos, inst: c, side: wp.pin.side };
        push(this.pinsByKey, key(wp.pos), ref);
        push(this.pinRows, wp.pos.y, ref);
        push(this.pinCols, wp.pos.x, ref);
      }
      this.bodies.push({ id: c.id, r: componentBounds(c) });
    }
  }

  /** Total length of the path that runs exactly along a component's bounding-box edge (cosmetic). */
  edgeHugLength(pts: readonly Point[]): number {
    let n = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      for (const { r } of this.bodies) {
        if (a.y === b.y && (a.y === r.y || a.y === r.y + r.h)) n += overlap(a.x, b.x, r.x, r.x + r.w);
        else if (a.x === b.x && (a.x === r.x || a.x === r.x + r.w)) n += overlap(a.y, b.y, r.y, r.y + r.h);
      }
    }
    return n;
  }

  /** Outward exit direction of the pin at `p`, if exactly one pin sits there. */
  exitAt(p: Point): Point | null {
    const refs = this.pinsByKey.get(key(p));
    return refs && refs.length > 0 ? pinExitVector(refs[0].inst, refs[0].side) : null;
  }

  private foreignVertex(vk: string, self: ReadonlySet<string>, allowed?: ReadonlySet<string>): boolean {
    for (const o of this.vertices.get(vk) ?? []) {
      if (self.has(o)) continue;
      // An explicitly allowed contact ("wireId@x,y": a branch end that rode along with a moved
      // wire, i.e. an existing T-junction) is intended, not an accidental short.
      if (allowed?.has(`${o}@${vk}`)) continue;
      return true;
    }
    return false;
  }

  /** Does point p lie on a segment of a wire other than `self`? */
  private onOtherWire(p: Point, self: ReadonlySet<string>): boolean {
    for (const s of this.hRows.get(p.y) ?? []) if (!self.has(s.wireId) && p.x >= s.lo && p.x <= s.hi) return true;
    for (const s of this.vCols.get(p.x) ?? []) if (!self.has(s.wireId) && p.y >= s.lo && p.y <= s.hi) return true;
    return false;
  }

  /**
   * True if the path would create an unintended connection or cut through a component:
   *  - a pin lies on the path anywhere except the path's two endpoints,
   *  - another wire's vertex lies on the path (except at the endpoints),
   *  - one of the path's interior bends lies on another wire,
   *  - a segment passes through the interior of a component body.
   * `self` lists wire ids to ignore (the wire being re-routed).
   */
  routeIsBad(pts: readonly Point[], self: ReadonlySet<string> = new Set(), allowed?: ReadonlySet<string>): boolean {
    if (pts.length < 2) return false;
    const start = key(pts[0]);
    const end = key(pts[pts.length - 1]);
    const isEnd = (k: string) => k === start || k === end;
    for (let i = 1; i + 1 < pts.length; i++) {
      const k = key(pts[i]);
      if (isEnd(k)) continue;
      if (this.onOtherWire(pts[i], self)) return true;
      if (this.pinsByKey.has(k)) return true;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a.y === b.y) {
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        for (const pin of this.pinRows.get(a.y) ?? []) {
          if (pin.pos.x >= lo && pin.pos.x <= hi && !isEnd(key(pin.pos))) return true;
        }
        for (const v of this.vtxRows.get(a.y) ?? []) {
          if (v.x < lo || v.x > hi) continue;
          const vk = key(v);
          if (!isEnd(vk) && this.foreignVertex(vk, self, allowed)) return true;
        }
      } else {
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        for (const pin of this.pinCols.get(a.x) ?? []) {
          if (pin.pos.y >= lo && pin.pos.y <= hi && !isEnd(key(pin.pos))) return true;
        }
        for (const v of this.vtxCols.get(a.x) ?? []) {
          if (v.y < lo || v.y > hi) continue;
          const vk = key(v);
          if (!isEnd(vk) && this.foreignVertex(vk, self, allowed)) return true;
        }
      }
      for (const b2 of this.bodies) if (segmentCrossesInterior(a, b, b2.r)) return true;
    }
    return false;
  }
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(Math.max(a0, a1), b1) - Math.max(Math.min(a0, a1), b0));
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/** True if axis-aligned segment ab passes through the OPEN interior of rect r. */
function segmentCrossesInterior(a: Point, b: Point, r: Rect): boolean {
  const x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
  if (a.y === b.y) {
    if (a.y <= y0 || a.y >= y1) return false;
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    return hi > x0 && lo < x1;
  }
  if (a.x <= x0 || a.x >= x1) return false;
  const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
  return hi > y0 && lo < y1;
}

function pathLength(pts: readonly Point[]): number {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) n += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
  return n;
}

export interface SafeRouteOptions {
  /** Wire ids to ignore as obstacles (the wire being re-routed). */
  self?: ReadonlySet<string>;
  /** Exit vectors at the endpoints (default: looked up from pins at those points). */
  fromExit?: Point | null;
  toExit?: Point | null;
  /** Prefer routes whose vertices stay close to this path (e.g. the user's dragged segment). */
  prefer?: readonly Point[];
  /** Allowed contacts "wireId@x,y" (existing T-junction ends that moved along). */
  allowed?: ReadonlySet<string>;
}

/**
 * Find the simplest orthogonal path from `from` to `to` that `routeIsBad` accepts.
 * Leaves/enters pins along their stub axis. Returns null if no candidate works.
 */
export function safeRoute(obs: RouteObstacles, from: Point, to: Point, opts: SafeRouteOptions = {}): Point[] | null {
  const g = obs.grid;
  const self = opts.self ?? new Set<string>();
  const fromExit = opts.fromExit !== undefined ? opts.fromExit : obs.exitAt(from);
  const toExit = opts.toExit !== undefined ? opts.toExit : obs.exitAt(to);
  if (from.x === to.x && from.y === to.y) return [{ ...from }];

  const stubs = (p: Point, e: Point | null): Point[][] =>
    e ? [1, 2, 3, 4, 6].map((k) => [{ ...p }, { x: p.x + e.x * k * g, y: p.y + e.y * k * g }]) : [[{ ...p }]];
  const heads = stubs(from, fromExit);
  const tails = stubs(to, toExit).map((t) => t.reverse());

  const lo = (v: number[]) => Math.min(...v) - 10 * g;
  const hi = (v: number[]) => Math.max(...v) + 10 * g;
  const xs = [from.x, to.x], ys = [from.y, to.y];
  const channelsX: number[] = [];
  const channelsY: number[] = [];
  for (let x = Math.floor(lo(xs) / g) * g; x <= hi(xs); x += g) channelsX.push(x);
  for (let y = Math.floor(lo(ys) / g) * g; y <= hi(ys); y += g) channelsY.push(y);

  const prefer = opts.prefer;
  const preferCost = (pts: readonly Point[]) => {
    if (!prefer || prefer.length === 0) return 0;
    let c = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let i = 0; i + 1 < prefer.length; i++) best = Math.min(best, distToSeg(p, prefer[i], prefer[i + 1]));
      c += best;
    }
    return c;
  };

  let best: { pts: Point[]; cost: number } | null = null;
  const consider = (raw: Point[]) => {
    const pts = normalizeWirePoints(raw);
    if (pts.length < 2) return;
    // Must leave / enter pins along their stub direction, never sideways along the pin edge.
    if (fromExit && !leavesAlong(pts[0], pts[1], fromExit)) return;
    if (toExit && !leavesAlong(pts[pts.length - 1], pts[pts.length - 2], toExit)) return;
    const cost = (pts.length - 2) * 40 * g + pathLength(pts) + preferCost(pts) * 0.5 + obs.edgeHugLength(pts) * 3;
    if (best && cost >= best.cost) return;
    if (obs.routeIsBad(pts, self, opts.allowed)) return;
    best = { pts, cost };
  };

  for (const h of heads) {
    for (const t of tails) {
      const a = h[h.length - 1];
      const b = t[0];
      const pre = h.slice(0, -1);
      const post = t.slice(1);
      if (a.x === b.x || a.y === b.y) consider([...pre, a, b, ...post]);
      consider([...pre, a, { x: b.x, y: a.y }, b, ...post]);
      consider([...pre, a, { x: a.x, y: b.y }, b, ...post]);
      for (const mx of channelsX) consider([...pre, a, { x: mx, y: a.y }, { x: mx, y: b.y }, b, ...post]);
      for (const my of channelsY) consider([...pre, a, { x: a.x, y: my }, { x: b.x, y: my }, b, ...post]);
    }
  }
  return best ? (best as { pts: Point[] }).pts : null;
}

function leavesAlong(p: Point, next: Point, exit: Point): boolean {
  const dx = Math.sign(next.x - p.x), dy = Math.sign(next.y - p.y);
  return dx === exit.x && dy === exit.y;
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Post-edit repair: for each listed wire, if its current path creates an unintended
 * connection or cuts through a component, replace it with the best safe route between
 * its endpoints (staying close to the current path). Mutates `doc`.
 */
export function repairWires(doc: SchematicDocument, wireIds: Iterable<string>, allowed?: ReadonlySet<string>): void {
  const ids = [...new Set(wireIds)];
  if (ids.length === 0) return;
  const full = new RouteObstacles(doc);
  const bad = ids.filter((id) => {
    const w = doc.wires.find((x) => x.id === id);
    return !!w && w.points.length >= 2 && full.routeIsBad(w.points, new Set([id]), allowed);
  });
  // Re-route one at a time. Bad wires not yet repaired are left out of the obstacles (they
  // are about to move anyway — otherwise two crossed wires can block each other's detour);
  // every repaired wire becomes an obstacle for the next.
  const pending = new Set(bad);
  for (const id of bad) {
    const w = doc.wires.find((x) => x.id === id)!;
    const obs = new RouteObstacles(doc, pending);
    const r = safeRoute(obs, w.points[0], w.points[w.points.length - 1], { self: new Set([id]), prefer: w.points, allowed });
    if (r) w.points = r;
    pending.delete(id);
  }
}

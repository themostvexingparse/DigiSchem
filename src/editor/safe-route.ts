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
import { componentBounds, SegmentIndex, worldPins, type Rect } from "../model/geometry";
import { normalizeWirePoints, pinExitVector, pruneCollapsedWires, stretchWireStart } from "./wire-utils";
import { buildNetlist } from "../io/netlist";
import { getSettings } from "../model/settings";

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

  /**
   * Number of plain crossings between the path and other wires (a perpendicular segment
   * passing strictly through the interior of one of the path's segments). Crossings don't
   * connect, but each one makes the drawing harder to read, so routes minimise them.
   */
  crossings(pts: readonly Point[], self: ReadonlySet<string> = new Set()): number {
    let n = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a.y === b.y) {
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        for (const [x, segs] of this.vCols) {
          if (x <= lo || x >= hi) continue;
          for (const sg of segs) if (!self.has(sg.wireId) && a.y > sg.lo && a.y < sg.hi) n++;
        }
      } else if (a.x === b.x) {
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        for (const [y, segs] of this.hRows) {
          if (y <= lo || y >= hi) continue;
          for (const sg of segs) if (!self.has(sg.wireId) && a.x > sg.lo && a.x < sg.hi) n++;
        }
      }
    }
    return n;
  }

  /**
   * Readability cost of a path (lower is better): crossings weigh most, then bends, then
   * length; hugging a component outline is discouraged. Shared by every router decision.
   */
  routeCost(pts: readonly Point[], self: ReadonlySet<string> = new Set()): number {
    const g = this.grid;
    return (
      this.crossings(pts, self) * 60 * g +
      (pts.length - 2) * 40 * g +
      pathLength(pts) +
      this.edgeHugLength(pts) * 3 +
      // Running ON another wire (even one of the same net) hides it: strongly discouraged.
      this.overlapLength(pts, self) * 4 * g
    );
  }

  /** Total length along which the path runs collinearly on top of other wires. */
  overlapLength(pts: readonly Point[], self: ReadonlySet<string> = new Set()): number {
    let n = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a.y === b.y) {
        for (const sg of this.hRows.get(a.y) ?? []) if (!self.has(sg.wireId)) n += overlap(a.x, b.x, sg.lo, sg.hi);
      } else if (a.x === b.x) {
        for (const sg of this.vCols.get(a.x) ?? []) if (!self.has(sg.wireId)) n += overlap(a.y, b.y, sg.lo, sg.hi);
      }
    }
    return n;
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
  /**
   * Wires electrically on the same net as this one: touching them is harmless (it cannot
   * short anything), so they are not treated as obstacles — but crossings still count.
   */
  sameNet?: ReadonlySet<string>;
}

/**
 * Find the simplest orthogonal path from `from` to `to` that `routeIsBad` accepts.
 * Leaves/enters pins along their stub axis. Returns null if no candidate works.
 */
export function safeRoute(obs: RouteObstacles, from: Point, to: Point, opts: SafeRouteOptions = {}): Point[] | null {
  return safeRouteCandidates(obs, from, to, opts, 1)[0] ?? null;
}

/** Up to `k` distinct valid routes, cheapest first (see safeRoute). */
export function safeRouteCandidates(
  obs: RouteObstacles,
  from: Point,
  to: Point,
  opts: SafeRouteOptions = {},
  k = 1,
): Point[][] {
  const g = obs.grid;
  const self = opts.self ?? new Set<string>();
  const ignore = opts.sameNet ? new Set([...self, ...opts.sameNet]) : self;
  const fromExit = opts.fromExit !== undefined ? opts.fromExit : obs.exitAt(from);
  const toExit = opts.toExit !== undefined ? opts.toExit : obs.exitAt(to);
  if (from.x === to.x && from.y === to.y) return [[{ ...from }]];

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

  // Keep the k cheapest distinct valid candidates (k is small: a sorted array is enough).
  const top: { pts: Point[]; cost: number; key: string }[] = [];
  const worst = () => (top.length < k ? Infinity : top[top.length - 1].cost);
  const consider = (raw: Point[]) => {
    const pts = normalizeWirePoints(raw);
    if (pts.length < 2) return;
    // Must leave / enter pins along their stub direction, never sideways along the pin edge.
    if (fromExit && !leavesAlong(pts[0], pts[1], fromExit)) return;
    if (toExit && !leavesAlong(pts[pts.length - 1], pts[pts.length - 2], toExit)) return;
    const cost = obs.routeCost(pts, self) + preferCost(pts) * 0.5;
    if (cost >= worst()) return;
    const kk = pts.map((p) => `${p.x},${p.y}`).join(";");
    if (top.some((t) => t.key === kk)) return;
    if (obs.routeIsBad(pts, ignore, opts.allowed)) return;
    top.push({ pts, cost, key: kk });
    top.sort((a, b) => a.cost - b.cost);
    if (top.length > k) top.pop();
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
  return top.map((t) => t.pts);
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

const netCache = new WeakMap<SchematicDocument, { byWire: Map<string, string[]>; byPin: Map<string, string[]> }>();

/**
 * Wires of every net touching any of `points` (a pin there, or a wire passing through it).
 * Used while DRAWING a wire: it is meant to join those nets, so touching them is fine.
 * Cached per document version.
 */
export function netWiresAt(doc: SchematicDocument, points: readonly Point[]): Set<string> {
  let c = netCache.get(doc);
  if (!c) {
    const byWire = new Map<string, string[]>();
    const byPin = new Map<string, string[]>();
    const nl = buildNetlist(doc);
    for (const net of nl.nets) {
      for (const w of net.wires) byWire.set(w, net.wires);
      for (const p of net.pins) {
        const comp = doc.components.find((x) => x.id === p.componentId);
        const wp = comp && worldPins(comp).find((q) => q.pin.id === p.pinId);
        if (wp) byPin.set(key(wp.pos), net.wires);
      }
    }
    c = { byWire, byPin };
    netCache.set(doc, c);
  }
  const out = new Set<string>();
  const idx = new SegmentIndex(doc.wires);
  for (const p of points) {
    for (const w of c.byPin.get(key(p)) ?? []) out.add(w);
    for (const wi of idx.wiresAt(p)) for (const w of c.byWire.get(doc.wires[wi].id) ?? []) out.add(w);
  }
  return out;
}

/** For each wire id, the ids of the OTHER wires on the same electrical net. */
export function sameNetWires(doc: SchematicDocument): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const net of buildNetlist(doc).nets) {
    for (const id of net.wires) out.set(id, new Set(net.wires.filter((w) => w !== id)));
  }
  return out;
}

export interface RepairOptions {
  /**
   * Also re-route wires that are electrically fine when a clearly more readable route exists
   * (fewer crossings / bends). Used after a component is displaced, so its wires never pile
   * up loops; a stretched wire is kept unless the fresh route is meaningfully better.
   */
  improve?: boolean;
  /**
   * Same-net map computed BEFORE the edit (sameNetWires of the original document). Required
   * for correctness: computing nets on the edited document would treat an accidental short
   * the edit just created as "same net" and keep it.
   */
  nets?: Map<string, Set<string>>;
  /**
   * Pre-edit paths of the listed wires whose END(S) moved. With it, branch points on those
   * wires are preserved: only the stretch between a moved end and the first branch point is
   * re-routed (see `repairWires`).
   */
  before?: Map<string, Point[]>;
  /** Internal: recursion depth while following a chain of detached branches. */
  depth?: number;
  /**
   * Joint search used by `improve`: "classic" (bounded branch-and-bound) or "advanced"
   * (iterative deepening, futility pruning, move ordering, quiescence). Default: the setting.
   */
  search?: "classic" | "advanced";
  /** Wall-clock budget of the advanced search in ms (default 25 — fits a drag frame). */
  timeBudgetMs?: number;
}


/**
 * Post-edit repair: for each listed wire, if its current path creates an unintended
 * connection or cuts through a component — or, with `improve`, if a fresh route is clearly
 * more readable — replace it with the best safe route between its (unchanged) endpoints.
 * Endpoints never move, so wires stay attached. Mutates `doc`.
 */
function repairWiresCore(
  doc: SchematicDocument,
  wireIds: Iterable<string>,
  allowed?: ReadonlySet<string>,
  opts: RepairOptions = {},
): void {
  const ids = [...new Set(wireIds)].filter((id) => {
    const w = doc.wires.find((x) => x.id === id);
    if (!w || w.points.length < 2) return false;
    // a zero-length (collapsed, kept-for-its-connections) wire has nothing to route
    const a0 = w.points[0], b0 = w.points[w.points.length - 1];
    return !(a0.x === b0.x && a0.y === b0.y);
  });
  if (ids.length === 0) return;
  const nets = opts.nets ?? sameNetWires(doc);
  const full = new RouteObstacles(doc);
  const ignoreFor = (id: string) => new Set([id, ...(nets.get(id) ?? [])]);
  const work = opts.improve
    ? ids
    : ids.filter((id) => full.routeIsBad(doc.wires.find((x) => x.id === id)!.points, ignoreFor(id), allowed));
  if (!opts.improve) {
    // Repair only: re-route each bad wire once. Wires still waiting are left out of the
    // obstacles (they move anyway — otherwise two crossed wires block each other's detour).
    const pending = new Set(work);
    for (const id of work) {
      const w = doc.wires.find((x) => x.id === id)!;
      pending.delete(id);
      const obs = new RouteObstacles(doc, pending);
      const fresh = safeRoute(obs, w.points[0], w.points[w.points.length - 1], {
        self: new Set([id]), sameNet: nets.get(id), allowed, prefer: w.points,
      });
      if (fresh) w.points = fresh;
    }
    return;
  }

  // Improve mode (after a component was displaced): choose the most readable JOINT
  // arrangement of the displaced wires. Routing them one at a time gets stuck (two wires that
  // should swap lanes each block the other), so: every wire gets its K best candidate routes
  // computed against the NON-displaced circuit (its current stretched shape is candidate #0),
  // then a small branch-and-bound search picks one candidate per wire minimising
  //   Σ route cost (crossings ≫ bends > length)  +  crossings between the chosen routes,
  // rejecting any pair that would touch (an accidental connection between different nets).
  const n = work.length;
  if ((opts.search ?? (getSettings().advancedRerouteSearch ? "advanced" : "classic")) === "advanced") {
    advancedJointRepair(doc, work, nets, allowed, ignoreFor, opts.timeBudgetMs ?? 25);
    return;
  }
  const K = n <= 2 ? 12 : n <= 3 ? 8 : n <= 4 ? 5 : n <= 6 ? 3 : 1;
  const g = full.grid;
  const workSet = new Set(work);
  const base = new RouteObstacles(doc, workSet); // the circuit without the displaced wires
  type Cand = { pts: Point[]; cost: number };
  const cands: Cand[][] = work.map((id) => {
    const w = doc.wires.find((x) => x.id === id)!;
    const self = new Set([id]);
    const list: Cand[] = [];
    if (!base.routeIsBad(w.points, ignoreFor(id), allowed)) {
      list.push({ pts: w.points, cost: base.routeCost(w.points, self) - 2 * g }); // keep-shape bonus
    }
    for (const pts of safeRouteCandidates(base, w.points[0], w.points[w.points.length - 1], {
      self, sameNet: nets.get(id), allowed,
    }, K)) list.push({ pts, cost: base.routeCost(pts, self) });
    if (list.length === 0) list.push({ pts: w.points, cost: 1e9 }); // nothing valid: keep as is
    return list.sort((a, b) => a.cost - b.cost);
  });
  const sameNetPair = (i: number, j: number) => nets.get(work[i])?.has(work[j]) ?? false;

  let best: number[] | null = null;
  let bestCost = Infinity;
  const pick: number[] = [];
  let explored = 0;
  const search = (i: number, acc: number) => {
    if (acc >= bestCost || explored++ > 20000) return;
    if (i === n) {
      bestCost = acc;
      best = pick.slice();
      return;
    }
    for (let c = 0; c < cands[i].length; c++) {
      const P = cands[i][c].pts;
      let cost = acc + cands[i][c].cost;
      for (let j = 0; j < i; j++) {
        const Q = cands[j][pick[j]].pts;
        // Touching a wire of another net would short them: a huge penalty rather than a hard
        // reject, so that when one wire has no valid route at all the others still get fixed
        // (the search then picks the arrangement with the fewest shorts).
        if (!sameNetPair(i, j) && pathsTouch(P, Q)) cost += SHORT_PENALTY;
        else cost += pathCrossings(P, Q) * 60 * g;
      }
      if (cost >= bestCost) continue;
      pick[i] = c;
      search(i + 1, cost);
    }
  };
  search(0, 0);
  if (best) (best as number[]).forEach((c, i) => (doc.wires.find((x) => x.id === work[i])!.points = cands[i][c].pts));
}

const SHORT_PENALTY = 1e8;

/** True if two orthogonal paths touch: a vertex of one lies on a segment of the other. */
function pathsTouch(P: readonly Point[], Q: readonly Point[]): boolean {
  const onPath = (p: Point, R: readonly Point[]) => {
    for (let i = 0; i + 1 < R.length; i++) {
      const a = R[i], b = R[i + 1];
      if (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) return true;
      if (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)) return true;
    }
    return false;
  };
  return P.some((p) => onPath(p, Q)) || Q.some((q) => onPath(q, P));
}

/** Plain (interior, perpendicular) crossings between two orthogonal paths. */
function pathCrossings(P: readonly Point[], Q: readonly Point[]): number {
  let n = 0;
  for (let i = 0; i + 1 < P.length; i++)
    for (let j = 0; j + 1 < Q.length; j++) {
      const [a, b] = [P[i], P[i + 1]];
      const [c, d] = [Q[j], Q[j + 1]];
      const h = a.y === b.y ? [a, b] : c.y === d.y ? [c, d] : null;
      const v = h && (h[0] === a ? [c, d] : [a, b]);
      if (!h || !v || v[0].x !== v[1].x || (h[0] === a && c.y === d.y)) continue;
      const x = v[0].x, y = h[0].y;
      if (x > Math.min(h[0].x, h[1].x) && x < Math.max(h[0].x, h[1].x) && y > Math.min(v[0].y, v[1].y) && y < Math.max(v[0].y, v[1].y)) n++;
    }
  return n;
}

/**
 * Split a newly drawn connection at its best branch points: wherever the new wire's start (or
 * end) runs on top of wires of the SAME net, trim that shared stretch so the wire begins where it
 * leaves the existing net — a T-junction (Steiner point) instead of a hidden overlapping
 * duplicate. `netWires` are the wires the new wire is joining. Returns the trimmed polyline.
 */
export function trimToBranchPoints(pts: readonly Point[], netWires: readonly { points: readonly Point[] }[]): Point[] {
  if (pts.length < 2 || netWires.length === 0) return pts.map((p) => ({ ...p }));
  const onNet = (p: Point) =>
    netWires.some((w) => w.points.some((q, i) => i + 1 < w.points.length && onSeg(p, q, w.points[i + 1])));
  const segOnNet = (a: Point, b: Point) => {
    // A segment is shared if its whole length is covered by one collinear net segment.
    for (const w of netWires)
      for (let i = 0; i + 1 < w.points.length; i++) {
        const c = w.points[i], d = w.points[i + 1];
        if (onSeg(a, c, d) && onSeg(b, c, d)) return true;
      }
    return false;
  };
  /** Walk from the start: the furthest point reachable while staying on the net. */
  const trimStart = (path: Point[]): Point[] => {
    if (!onNet(path[0])) return path;
    let i = 0;
    while (i + 1 < path.length && segOnNet(path[i], path[i + 1])) i++;
    // Inside segment i (partially shared)? Advance to the last shared grid point on it.
    if (i + 1 < path.length) {
      const a = path[i], b = path[i + 1];
      const step = { x: Math.sign(b.x - a.x) * GRID, y: Math.sign(b.y - a.y) * GRID };
      let p = { ...a };
      while (!(p.x === b.x && p.y === b.y)) {
        const nx = { x: p.x + step.x, y: p.y + step.y };
        if (!segOnNet(a, nx)) break;
        p = nx;
      }
      if (!(p.x === a.x && p.y === a.y)) return [p, ...path.slice(i + 1)];
    }
    return path.slice(i);
  };
  let out = trimStart(pts.map((p) => ({ ...p })));
  out = trimStart(out.slice().reverse()).reverse();
  return out.length >= 2 && !(out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y)
    ? out
    : pts.map((p) => ({ ...p }));
}

function onSeg(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  return false;
}

// ---------------------------------------------------------------------------------------------
// Branch-point-preserving repair
// ---------------------------------------------------------------------------------------------

/** A point where another wire connects to wire W (before the edit). */
interface BranchPoint {
  p: Point;
  /** Arc-length position along W's original path. */
  t: number;
  /** The other wire, and which of its ends sits on W (null = one of its interior vertices). */
  other: string;
  otherEnd: "start" | "end" | null;
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x) return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  if (a.y === b.y) return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  return false;
}

/** Arc-length position of `p` along `path` (or -1 if it is not on the path). */
function arcPos(path: readonly Point[], p: Point): number {
  let acc = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    if (onSegment(p, a, b)) return acc + Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
    acc += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return -1;
}

function onPath(path: readonly Point[], p: Point): boolean {
  return arcPos(path, p) >= 0;
}

/** Path from the start up to arc position `t` (ending exactly at the point there). */
function cutBefore(path: readonly Point[], t: number): Point[] {
  const out: Point[] = [{ ...path[0] }];
  let acc = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (acc + len >= t) {
      const r = t - acc;
      out.push({ x: a.x + Math.sign(b.x - a.x) * r, y: a.y + Math.sign(b.y - a.y) * r });
      return out;
    }
    out.push({ ...b });
    acc += len;
  }
  return out;
}

/** Path from arc position `t` to the end. */
function cutAfter(path: readonly Point[], t: number): Point[] {
  const total = arcPos(path, path[path.length - 1]);
  return cutBefore([...path].reverse(), total - t).reverse();
}

/** Every point where another wire (not in `exclude`) connects to `orig` (W's pre-edit path). */
function branchPointsOf(doc: SchematicDocument, wid: string, orig: readonly Point[], exclude: ReadonlySet<string>): BranchPoint[] {
  const out: BranchPoint[] = [];
  const seen = new Set<string>();
  const add = (p: Point, other: string, otherEnd: BranchPoint["otherEnd"]) => {
    const t = arcPos(orig, p);
    if (t < 0) return;
    const k = `${other}|${p.x},${p.y}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ p: { x: p.x, y: p.y }, t, other, otherEnd });
  };
  for (const w of doc.wires) {
    if (w.id === wid || exclude.has(w.id) || w.points.length < 2) continue;
    const n = w.points.length;
    // the other wire's vertices lying on W …
    w.points.forEach((p, i) => add(p, w.id, i === 0 ? "start" : i === n - 1 ? "end" : null));
    // … and W's interior vertices lying on the other wire
    for (let i = 1; i + 1 < orig.length; i++) if (onPath(w.points, orig[i])) add(orig[i], w.id, null);
  }
  return out;
}

/** Closest grid point on `path` to `p`. */
function nearestOnPath(path: readonly Point[], p: Point, grid: number): Point {
  let best: Point = { ...path[0] };
  let bestD = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const q =
      a.x === b.x
        ? { x: a.x, y: Math.min(Math.max(p.y, Math.min(a.y, b.y)), Math.max(a.y, b.y)) }
        : { x: Math.min(Math.max(p.x, Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y };
    const snapped = a.x === b.x ? { x: q.x, y: Math.round(q.y / grid) * grid } : { x: Math.round(q.x / grid) * grid, y: q.y };
    const d = Math.abs(snapped.x - p.x) + Math.abs(snapped.y - p.y);
    if (d < bestD && onSegment(snapped, a, b)) {
      bestD = d;
      best = snapped;
    }
  }
  return best;
}

/**
 * Repair after an edit, keeping BRANCH POINTS fixed. For each wire whose end(s) moved (its
 * pre-edit path given in `before`), only the stretch between the moved end and the first point
 * where another wire branches off is re-routed — it simply gets longer or shorter — and the
 * rest of the wire, with every branch on it, stays exactly where it was. So rerouting does not
 * propagate into the rest of the net. Only when a branch point cannot survive (the part moved
 * past it, so the wire would fold back over itself) is the detached branch followed: its end is
 * moved onto the new path and the branch is repaired the same way, recursively.
 */
export function repairWires(
  doc: SchematicDocument,
  wireIds: Iterable<string>,
  allowed?: ReadonlySet<string>,
  opts: RepairOptions = {},
): void {
  const before = opts.before;
  const ids = [...new Set(wireIds)];
  if (!before || before.size === 0) {
    repairWiresCore(doc, ids, allowed, opts);
    return;
  }
  const nets = opts.nets ?? sameNetWires(doc);
  const idSet = new Set(ids);
  const grid = doc.grid || GRID;

  type Split = { wid: string; legS?: string; legE?: string; mid: Point[] | null; branches: BranchPoint[]; keep: Set<string> };
  const splits: Split[] = [];
  const legIds: string[] = [];
  const passthrough: string[] = [];
  const alias = new Map<string, string>(); // leg id → wire id

  for (const wid of ids) {
    const w = doc.wires.find((x) => x.id === wid);
    const orig = before.get(wid);
    if (!w || !orig || orig.length < 2 || w.points.length < 2) {
      passthrough.push(wid);
      continue;
    }
    const S = w.points;
    const startMoved = !(S[0].x === orig[0].x && S[0].y === orig[0].y);
    const endMoved = !(S[S.length - 1].x === orig[orig.length - 1].x && S[S.length - 1].y === orig[orig.length - 1].y);
    const total = arcPos(orig, orig[orig.length - 1]);
    // branch points strictly inside the wire's original path (the ends are the wire's own anchors)
    // (only contacts with wires of the SAME net before the edit — never an accidental short)
    const sameNet = nets.get(wid) ?? new Set<string>();
    const branches = branchPointsOf(doc, wid, orig, idSet).filter((b) => b.t > 0 && b.t < total && sameNet.has(b.other));
    if (!startMoved && !endMoved) {
      // Neither end moved (e.g. a drag that landed back on its start): the wire keeps its exact
      // original shape. Re-routing it freely could drop a branch point and changes the layout
      // the user returned to.
      w.points = orig.map((p) => ({ ...p }));
      continue;
    }
    if (branches.length === 0) {
      passthrough.push(wid);
      continue;
    }
    const ts = branches.map((b) => b.t);
    const tS = startMoved ? Math.min(...ts) : 0;
    const tE = endMoved ? Math.max(...ts) : total;
    const keep = new Set(branches.map((b) => `${b.p.x},${b.p.y}`));
    const split: Split = { wid, mid: null, branches, keep };
    // the untouched middle: from the first to the last branch point
    const mid = cutAfter(cutBefore(orig, tE), tS);
    split.mid = mid.length >= 2 && tE > tS ? mid : null;
    if (startMoved) {
      const leg = normalizeWirePoints(stretchLeg(cutBefore(orig, tS), S[0]));
      if (leg.length >= 2) {
        split.legS = `${wid}~s`;
        doc.wires.push({ id: split.legS, points: leg });
        legIds.push(split.legS);
        alias.set(split.legS, wid);
      }
    }
    if (endMoved) {
      const tail = cutAfter(orig, tE);
      const leg = normalizeWirePoints(stretchLeg([...tail].reverse(), S[S.length - 1]).reverse());
      if (leg.length >= 2) {
        split.legE = `${wid}~e`;
        doc.wires.push({ id: split.legE, points: leg });
        legIds.push(split.legE);
        alias.set(split.legE, wid);
      }
    }
    // while repairing, W itself is just its untouched middle (a fixed obstacle / same net)
    w.points = split.mid ?? [orig[0], orig[0]];
    splits.push(split);
  }

  // Nets / allowed contacts for the temporary legs: a leg belongs to its wire's net.
  const netsX = new Map<string, Set<string>>();

  const legsOf = new Map<string, string[]>();
  for (const [leg, wid] of alias) legsOf.set(wid, [...(legsOf.get(wid) ?? []), leg]);
  const expand = (s: Iterable<string>) => {
    const out = new Set<string>();
    for (const id of s) {
      out.add(id);
      for (const l of legsOf.get(id) ?? []) out.add(l);
    }
    return out;
  };
  for (const [id, set] of nets) netsX.set(id, expand(set));
  for (const [leg, wid] of alias) {
    const s = expand([wid, ...(nets.get(wid) ?? [])]);
    s.delete(leg);
    netsX.set(leg, s);
  }
  let allowedX = allowed;
  if (allowed && alias.size > 0) {
    const a = new Set(allowed);
    for (const k of allowed) {
      const at = k.indexOf("@");
      for (const l of legsOf.get(k.slice(0, at)) ?? []) a.add(`${l}${k.slice(at)}`);
    }
    allowedX = a;
  }

  repairWiresCore(doc, [...passthrough, ...legIds], allowedX, { ...opts, nets: netsX });

  // Merge the legs back into their wires (branch points kept as load-bearing vertices).
  const detached: { other: string; end: "start" | "end"; wid: string }[] = [];
  for (const sp of splits) {
    const w = doc.wires.find((x) => x.id === sp.wid)!;
    const legS = sp.legS ? doc.wires.find((x) => x.id === sp.legS)?.points ?? [] : [];
    const legE = sp.legE ? doc.wires.find((x) => x.id === sp.legE)?.points ?? [] : [];
    const merged = [...legS, ...(sp.mid ?? []), ...legE];
    w.points = normalizeWirePoints(merged, sp.keep);
    for (const b of sp.branches) {
      if (b.otherEnd && !onPath(w.points, b.p)) detached.push({ other: b.other, end: b.otherEnd, wid: sp.wid });
    }
  }
  const legSet = new Set(legIds);
  doc.wires = doc.wires.filter((w) => !legSet.has(w.id));


  // Follow the chain where a branch point could not survive.
  const depth = opts.depth ?? 0;
  if (detached.length > 0 && depth < 8) {
    const moved = new Map<string, Point[]>();
    for (const d of detached) {
      const x = doc.wires.find((w) => w.id === d.other);
      const w = doc.wires.find((v) => v.id === d.wid);
      if (!x || !w || moved.has(x.id)) continue;
      const orig = x.points.map((p) => ({ ...p }));
      const endPt = d.end === "start" ? orig[0] : orig[orig.length - 1];
      const q = nearestOnPath(w.points, endPt, grid);
      x.points = d.end === "start" ? normalizeWirePoints(stretchLeg(orig, q)) : normalizeWirePoints(stretchLeg([...orig].reverse(), q).reverse());
      moved.set(x.id, orig);
    }
    if (moved.size > 0) {
      repairWires(doc, [...moved.keys()], allowed, { ...opts, before: moved, depth: depth + 1 });
    }
  }
  pruneCollapsedWires(doc);
}

/** Move a path's start to `p`, keeping the rest of it (adds a bend if needed). */
function stretchLeg(path: readonly Point[], p: Point): Point[] {
  return stretchWireStart(path, p);
}

// ---------------------------------------------------------------------------------------------
// Advanced joint search (opt-in: Settings → "Advanced re-routing search")
// ---------------------------------------------------------------------------------------------
//
// The same problem as the classic search — pick one candidate route per displaced wire,
// minimising Σ route cost + pairwise crossings (+ a huge penalty per short) — solved with
// techniques borrowed from chess engines:
//
//   • Iterative deepening over the candidate breadth (1, 2, 4, 8 … routes per wire) under a
//     wall-clock budget: always returns the best arrangement found so far (anytime).
//   • Principal-variation move ordering: each wire first tries the route it had in the best
//     arrangement of the previous iteration; the rest are ordered by their incremental cost
//     against the routes already picked (a static evaluation).
//   • Futility pruning with an admissible bound: a partial arrangement is cut as soon as its cost
//     plus the cheapest possible cost of every wire still to place cannot beat the best so far.
//   • Variable ordering ("most constrained first"): wires that interact with the most others are
//     placed first, so conflicts — and therefore cut-offs — show up early.
//   • Transposition table: pairwise costs are cached across nodes and iterations.
//   • Quiescence stage: after the search, wires that were NOT displaced but now cross the new
//     routes are "unquiet"; up to a few of them (those without branches, so no junction moves)
//     are added and the search is re-run, so a cheap detour of a neighbour can remove a crossing.

export interface AdvancedSearchStats {
  iterations: number;
  nodes: number;
  breadth: number;
  quiescenceWires: number;
}

let lastAdvancedStats: AdvancedSearchStats | null = null;
/** Statistics of the most recent advanced search (for tests / diagnostics). */
export function advancedSearchStats(): AdvancedSearchStats | null {
  return lastAdvancedStats;
}

function boundsOfCands(list: { pts: Point[] }[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of list) for (const p of c.pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function advancedJointRepair(
  doc: SchematicDocument,
  work0: string[],
  nets: Map<string, Set<string>>,
  allowed: ReadonlySet<string> | undefined,
  ignoreFor: (id: string) => Set<string>,
  budgetMs: number,
): void {
  const t0 = performance.now();
  const deadline = t0 + budgetMs;
  const g = doc.grid || GRID;
  type Cand = { pts: Point[]; cost: number };

  const buildCands = (work: string[], kMax: number): Cand[][] => {
    const base = new RouteObstacles(doc, new Set(work));
    return work.map((id) => {
      const w = doc.wires.find((x) => x.id === id)!;
      const self = new Set([id]);
      const list: Cand[] = [];
      if (!base.routeIsBad(w.points, ignoreFor(id), allowed)) {
        list.push({ pts: w.points, cost: base.routeCost(w.points, self) - 2 * g });
      }
      // generation is the expensive part: shrink the breadth if time is running out
      const k = performance.now() > t0 + budgetMs * 0.5 ? Math.min(3, kMax) : kMax;
      for (const pts of safeRouteCandidates(base, w.points[0], w.points[w.points.length - 1], {
        self, sameNet: nets.get(id), allowed,
      }, k)) list.push({ pts, cost: base.routeCost(pts, self) });
      if (list.length === 0) list.push({ pts: w.points, cost: 1e9 });
      return list.sort((a, b) => a.cost - b.cost);
    });
  };

  /** Run the iterative-deepening search over `work` with candidate lists `cands`. */
  const solve = (work: string[], cands: Cand[][]) => {
    const n = work.length;
    // variable ordering: most interacting wires first
    const bb = cands.map(boundsOfCands);
    const degree = bb.map((a, i) =>
      bb.reduce((d, b, j) => d + (i !== j && a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1 ? 1 : 0), 0));
    const order = work.map((_, i) => i).sort((a, b) => degree[b] - degree[a] || cands[a].length - cands[b].length);
    const sameNetPair = (i: number, j: number) => nets.get(work[i])?.has(work[j]) ?? false;
    const tt = new Map<number, number>(); // transposition table of pair costs
    const pairCost = (i: number, c: number, j: number, d: number) => {
      const key = ((i * 64 + c) * 1024 + j) * 64 + d;
      let v = tt.get(key);
      if (v === undefined) {
        const P = cands[i][c].pts, Q = cands[j][d].pts;
        v = !sameNetPair(i, j) && pathsTouch(P, Q) ? SHORT_PENALTY : pathCrossings(P, Q) * 60 * g;
        tt.set(key, v);
      }
      return v;
    };
    // initial solution: everyone's cheapest route (a valid arrangement → first bound)
    let best: number[] = work.map(() => 0);
    let bestCost = 0;
    for (let a = 0; a < n; a++) {
      bestCost += cands[a][0].cost;
      for (let b = 0; b < a; b++) bestCost += pairCost(a, 0, b, 0);
    }
    const maxBreadth = Math.max(...cands.map((l) => l.length));
    let nodes = 0;
    let iterations = 0;
    let breadth = 1;
    let timeUp = false;
    const pick = new Array<number>(n).fill(-1);
    for (breadth = 1; ; breadth = Math.min(maxBreadth, breadth * 2)) {
      iterations++;
      // admissible lower bound of the wires still to place (positions in `order`)
      const minCost = order.map((i) => Math.min(...cands[i].slice(0, breadth).map((c) => c.cost)));
      const lbSuffix = new Array<number>(n + 1).fill(0);
      for (let p = n - 1; p >= 0; p--) lbSuffix[p] = lbSuffix[p + 1] + minCost[p];
      const pv = best.slice();
      const search = (pos: number, acc: number) => {
        if ((++nodes & 255) === 0 && performance.now() > deadline) timeUp = true;
        if (timeUp) return;
        if (acc + lbSuffix[pos] >= bestCost) return; // futility cut-off
        if (pos === n) {
          bestCost = acc;
          best = pick.slice();
          return;
        }
        const i = order[pos];
        const lim = Math.min(breadth, cands[i].length);
        // move ordering: PV route first, then by incremental cost against picked routes
        const opts: { c: number; inc: number }[] = [];
        for (let c = 0; c < lim; c++) {
          let inc = cands[i][c].cost;
          for (let q = 0; q < pos; q++) inc += pairCost(i, c, order[q], pick[order[q]]);
          opts.push({ c, inc });
        }
        opts.sort((a, b) => (a.c === pv[i] ? -1 : b.c === pv[i] ? 1 : a.inc - b.inc));
        for (const o of opts) {
          if (acc + o.inc + lbSuffix[pos + 1] >= bestCost) continue;
          pick[i] = o.c;
          search(pos + 1, acc + o.inc);
          if (timeUp) break;
        }
        pick[i] = -1;
      };
      search(0, 0);
      if (timeUp || breadth >= maxBreadth) break;
    }
    return { best, bestCost, nodes, iterations, breadth };
  };

  let work = work0.slice();
  const kMax = work.length <= 2 ? 16 : work.length <= 4 ? 12 : work.length <= 8 ? 8 : 5;
  let cands = buildCands(work, kMax);
  let r = solve(work, cands);
  const apply = (w: string[], c: Cand[][], b: number[]) =>
    b.forEach((ci, i) => (doc.wires.find((x) => x.id === w[i])!.points = c[i][ci].pts));
  apply(work, cands, r.best);

  // Quiescence: neighbours that now cross the new routes get one chance to move too.
  let quiet = 0;
  if (performance.now() < deadline - budgetMs * 0.2) {
    const workSet = new Set(work);
    const chosen = work.map((id) => doc.wires.find((x) => x.id === id)!.points);
    const unquiet: { id: string; hits: number }[] = [];
    for (const w of doc.wires) {
      if (workSet.has(w.id) || w.points.length < 2) continue;
      let hits = 0;
      for (const P of chosen) hits += pathCrossings(P, w.points);
      if (hits === 0) continue;
      // only wires without branches on them (re-routing never moves a junction)
      const hasBranch = doc.wires.some((o) => o.id !== w.id && o.points.some((p, k) =>
        (k === 0 || k === o.points.length - 1) && onPathInterior(w.points, p)));
      if (!hasBranch) unquiet.push({ id: w.id, hits });
    }
    unquiet.sort((a, b) => b.hits - a.hits);
    const extra = unquiet.slice(0, 4).map((u) => u.id);
    if (extra.length > 0) {
      const before = new Map(doc.wires.map((w) => [w.id, w.points]));
      const costOf = (ids: string[]) => {
        const obs = new RouteObstacles(doc, new Set(ids));
        let c = 0;
        const pts = ids.map((id) => doc.wires.find((x) => x.id === id)!.points);
        ids.forEach((id, i) => (c += obs.routeCost(pts[i], new Set([id]))));
        for (let i = 0; i < pts.length; i++) for (let j = 0; j < i; j++) c += pathCrossings(pts[i], pts[j]) * 60 * g;
        return c;
      };
      const all = [...work, ...extra];
      const c0 = costOf(all);
      const cands2 = buildCands(all, 4);
      const r2 = solve(all, cands2);
      if (r2.bestCost < c0 - 1e-6) {
        apply(all, cands2, r2.best);
        quiet = extra.length;
        work = all;
        cands = cands2;
        r = { ...r2, nodes: r.nodes + r2.nodes, iterations: r.iterations + r2.iterations };
      } else {
        for (const w of doc.wires) w.points = before.get(w.id) ?? w.points;
      }
    }
  }
  lastAdvancedStats = { iterations: r.iterations, nodes: r.nodes, breadth: r.breadth, quiescenceWires: quiet };
}

function onPathInterior(path: readonly Point[], p: Point): boolean {
  const n = path.length;
  if ((path[0].x === p.x && path[0].y === p.y) || (path[n - 1].x === p.x && path[n - 1].y === p.y)) return false;
  return onPath(path, p);
}

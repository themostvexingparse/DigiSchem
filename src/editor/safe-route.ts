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
import { normalizeWirePoints, pinExitVector } from "./wire-utils";
import { buildNetlist } from "../io/netlist";

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
    return this.crossings(pts, self) * 60 * g + (pts.length - 2) * 40 * g + pathLength(pts) + this.edgeHugLength(pts) * 3;
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
}


/**
 * Post-edit repair: for each listed wire, if its current path creates an unintended
 * connection or cuts through a component — or, with `improve`, if a fresh route is clearly
 * more readable — replace it with the best safe route between its (unchanged) endpoints.
 * Endpoints never move, so wires stay attached. Mutates `doc`.
 */
export function repairWires(
  doc: SchematicDocument,
  wireIds: Iterable<string>,
  allowed?: ReadonlySet<string>,
  opts: RepairOptions = {},
): void {
  const ids = [...new Set(wireIds)].filter((id) => {
    const w = doc.wires.find((x) => x.id === id);
    return !!w && w.points.length >= 2;
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
      let ok = true;
      for (let j = 0; j < i && ok; j++) {
        const Q = cands[j][pick[j]].pts;
        if (!sameNetPair(i, j) && pathsTouch(P, Q)) ok = false;
        else cost += pathCrossings(P, Q) * 60 * g;
      }
      if (!ok || cost >= bestCost) continue;
      pick[i] = c;
      search(i + 1, cost);
    }
  };
  search(0, 0);
  if (best) (best as number[]).forEach((c, i) => (doc.wires.find((x) => x.id === work[i])!.points = cands[i][c].pts));
}

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

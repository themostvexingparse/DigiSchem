/**
 * Wire relaxation: tidies the wires of a finished drawing without moving any part.
 *
 * The drawing is treated like a molecule. Each wire is a chain held taut by its own tension
 * (every cell of length and every bend costs energy, so wires want to be short and straight).
 * Wires push on each other at short range: two parallel wires one cell apart repel strongly,
 * two cells apart weakly, and crossings, junction dots and wire ends that crowd each other
 * (a crossing right next to a bend or a pin, two junction dots side by side, a wire end that
 * stops one cell short of another wire) repel too. A wire running through the cell in front of
 * a pin it does not connect to is pushed out, since that cell is the pin's only way out.
 *
 * The relaxation repeatedly takes the single move that lowers the energy the most: sliding one
 * segment sideways (the wires that branch off it follow), or re-routing a whole wire between
 * its fixed ends. A move is only taken if it touches nothing new: every wire still connects
 * exactly what it connected, no wire touches a pin, a part or another wire it is not joined to,
 * and no wire enters a keep-out area. Pins and parts never move, so the connections stay the
 * same by construction; the caller still verifies the result.
 */
import type { Point, SchematicDocument } from "../model/types";
import { componentBounds, worldPins, type Rect } from "../model/geometry";
import { dragWireSegmentPoints, normalizeWirePoints, pinExitVector, stretchWireStart } from "../editor/wire-utils";
import { RouteObstacles, ROUTE_WEIGHTS, safeRoute } from "../editor/safe-route";

/** Energies in cells of wire length (the same unit as the router's weights). */
export const RELAX_WEIGHTS = {
  /** tension: per cell of wire, per bend */
  length: ROUTE_WEIGHTS.length,
  bend: ROUTE_WEIGHTS.bend,
  crossing: ROUTE_WEIGHTS.crossing,
  /** repulsion between parallel wires, per cell of side-by-side run, at 1 and 2 cells apart */
  parallel1: 3,
  parallel2: 1,
  /** a crossing within 1 / 2 cells of a bend, a wire end or a pin */
  crossNear1: 12,
  crossNear2: 4,
  /** a wire end (or bend) that stops 1 cell short of another wire */
  nearMiss: 6,
  /** two junction dots 1 / 2 cells apart */
  junction1: 10,
  junction2: 3,
  /** per cell spent in front of a pin the wire does not connect to */
  blockPin: ROUTE_WEIGHTS.blockPin,
  /**
   * Bundles (wires running between the same two parts, each with one jog): per cell that a jog
   * is off the straight line through its neighbours' jogs. Like a bond angle: the jogs settle
   * into an even diagonal staircase, or one aligned column.
   */
  kink: 4,
};

export interface RelaxOptions {
  /** areas no wire may enter */
  keepOut?: readonly Rect[];
  /** wire ids that may not change (e.g. wires drawn as direct drafts) */
  frozen?: ReadonlySet<string>;
  /** soft time budget (default 1500 ms) */
  timeBudgetMs?: number;
  /** maximum sweeps over all wires (default 8) */
  maxSweeps?: number;
  /** farthest a segment slides in one move, in cells (default 8) */
  reach?: number;
  /** never take a move that adds bends (the packer promises compaction adds none) */
  noNewBends?: boolean;
}

export interface RelaxResult {
  energyBefore: number;
  energyAfter: number;
  moves: number;
  sweeps: number;
}

interface Seg {
  w: number; // wire index
  i: number; // segment index in the wire
  h: boolean; // horizontal
  c: number; // y of a horizontal segment, x of a vertical one
  lo: number;
  hi: number;
}

const key = (p: Point) => `${p.x},${p.y}`;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function segsOf(pts: readonly Point[], w: number): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.y === b.y && a.x !== b.x) out.push({ w, i, h: true, c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
    else if (a.x === b.x && a.y !== b.y) out.push({ w, i, h: false, c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
  }
  return out;
}

function onPolyline(p: Point, pts: readonly Point[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)) return true;
    if (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) return true;
  }
  return false;
}

/** Does segment s run through the open interior of r, or along its outline? */
function segHitsRect(s: Seg, r: Rect): boolean {
  const x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
  if (s.h) {
    if (s.c === y0 || s.c === y1) return s.hi >= x0 && s.lo <= x1;
    return s.c > y0 && s.c < y1 && s.hi > x0 && s.lo < x1;
  }
  if (s.c === x0 || s.c === x1) return s.hi >= y0 && s.lo <= y1;
  return s.c > x0 && s.c < x1 && s.hi > y0 && s.lo < y1;
}

/**
 * Relax the wires of `doc` in place. Returns the energy before and after (lower is tidier).
 */
export function relaxWires(doc: SchematicDocument, opts: RelaxOptions = {}): RelaxResult {
  const g = doc.grid || 10;
  const W = RELAX_WEIGHTS;
  const budget = opts.timeBudgetMs ?? 1500;
  const maxSweeps = opts.maxSweeps ?? 8;
  const reach = opts.reach ?? 8;
  const frozen = opts.frozen ?? new Set<string>();
  const t0 = now();

  const wires = doc.wires;
  const idx = new Map(wires.map((w, i) => [w.id, i]));
  // Connections to keep: the stored links, plus every contact the drawing already makes (a wire
  // end on a pin or on another wire). Documents without stored links rely on the latter alone.
  const links: [string, string][] = [...(doc.links ?? [])];
  {
    const pinAt = new Map<string, string[]>();
    for (const c of doc.components) for (const wp of worldPins(c)) (pinAt.get(key(wp.pos)) ?? pinAt.set(key(wp.pos), []).get(key(wp.pos))!).push(`p:${c.id}|${wp.pin.id}`);
    for (const w of wires) {
      if (w.points.length < 2) continue;
      for (const p of [w.points[0], w.points[w.points.length - 1]]) {
        for (const t of pinAt.get(key(p)) ?? []) links.push([`w:${w.id}`, t]);
        for (const o of wires) if (o !== w && o.points.length >= 2 && onPolyline(p, o.points)) links.push([`w:${w.id}`, `w:${o.id}`]);
      }
    }
  }

  // ---- nets (union of the links) -------------------------------------------------------------
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let x = a;
    while (x !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  for (const [a, b] of links) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const netOfWire = wires.map((w) => find(`w:${w.id}`));

  // wire-wire links, and the pins each wire is linked to
  const wireLinks: [number, number][] = [];
  const pinLinked = new Set<string>(); // "wireIndex@x,y"
  const pinPos = new Map<string, Point>();
  for (const c of doc.components) for (const wp of worldPins(c)) pinPos.set(`p:${c.id}|${wp.pin.id}`, wp.pos);
  const linkedPairs = new Set<string>();
  const wirePinLinks: [number, Point][] = [];
  for (const [a, b] of links) {
    const wa = a.startsWith("w:") ? idx.get(a.slice(2)) : undefined;
    const wb = b.startsWith("w:") ? idx.get(b.slice(2)) : undefined;
    if (wa !== undefined && wb !== undefined) {
      wireLinks.push([wa, wb]);
      linkedPairs.add(`${Math.min(wa, wb)}:${Math.max(wa, wb)}`);
    } else if (wa !== undefined || wb !== undefined) {
      const w = (wa ?? wb)!;
      const p = pinPos.get(wa !== undefined ? b : a);
      if (p) {
        pinLinked.add(`${w}@${key(p)}`);
        wirePinLinks.push([w, p]);
      }
    }
  }
  const linked = (a: number, b: number) => linkedPairs.has(`${Math.min(a, b)}:${Math.max(a, b)}`);

  // ---- pins: positions (by row / column) and the cell in front of each ----------------------
  interface PinInfo { pos: Point; net: string }
  const pins: PinInfo[] = [];
  const escapes = new Map<string, string>(); // escape cell -> net of its pin ("" = none)
  for (const c of doc.components) {
    for (const wp of worldPins(c)) {
      const net = parent.has(`p:${c.id}|${wp.pin.id}`) ? find(`p:${c.id}|${wp.pin.id}`) : `#${c.id}|${wp.pin.id}`;
      pins.push({ pos: wp.pos, net });
      const ex = pinExitVector(c, wp.pin.side);
      escapes.set(key({ x: wp.pos.x + ex.x * g, y: wp.pos.y + ex.y * g }), net);
    }
  }
  const pinsByRow = new Map<number, Point[]>(), pinsByCol = new Map<number, Point[]>();
  for (const p of pins) {
    (pinsByRow.get(p.pos.y) ?? pinsByRow.set(p.pos.y, []).get(p.pos.y)!).push(p.pos);
    (pinsByCol.get(p.pos.x) ?? pinsByCol.set(p.pos.x, []).get(p.pos.x)!).push(p.pos);
  }
  const bodies: Rect[] = [...doc.components.map((c) => componentBounds(c)), ...(opts.keepOut ?? [])];

  // ---- bundles: wires between the same two parts, each one horizontal-vertical-horizontal jog,
  // all jogging the same way; ordered top to bottom ---------------------------------------------
  const compAt = new Map<string, string>();
  for (const c of doc.components) for (const wp of worldPins(c)) compAt.set(key(wp.pos), c.id);
  const bundles: number[][] = [];
  {
    const by = new Map<string, number[]>();
    wires.forEach((wr, w) => {
      const P = wr.points;
      if (P.length !== 4 || P[0].y !== P[1].y || P[1].x !== P[2].x || P[2].y !== P[3].y || P[0].y === P[3].y) return;
      if (!pinLinked.has(`${w}@${key(P[0])}`) || !pinLinked.has(`${w}@${key(P[3])}`)) return;
      if (wireLinks.some(([x, y]) => x === w || y === w)) return; // something branches off it
      const [L, R] = P[0].x < P[3].x ? [P[0], P[3]] : [P[3], P[0]];
      const k = `${compAt.get(key(L))}|${compAt.get(key(R))}|${Math.sign(R.y - L.y)}`;
      (by.get(k) ?? by.set(k, []).get(k)!).push(w);
    });
    for (const m of by.values()) {
      if (m.length < 2) continue;
      const leftY = (w: number) => {
        const P = wires[w].points;
        return P[0].x < P[3].x ? P[0].y : P[3].y;
      };
      bundles.push(m.sort((a, b) => leftY(a) - leftY(b)));
    }
  }
  const bundleOf = new Map<number, number[]>();
  for (const b of bundles) for (const w of b) bundleOf.set(w, b);

  // ---- current state ----------------------------------------------------------------------------
  let pts: Point[][] = wires.map((w) => w.points.map((p) => ({ x: p.x, y: p.y })));
  let segs: Seg[][] = pts.map((p, w) => segsOf(p, w));
  const isEndOf = (w: number, p: Point, P = pts) => {
    const a = P[w][0], b = P[w][P[w].length - 1];
    return (a.x === p.x && a.y === p.y) || (b.x === p.x && b.y === p.y);
  };

  // ---- energy -------------------------------------------------------------------------------
  /** tension and pin blocking of one wire */
  function selfE(w: number, P: readonly Point[]): number {
    let len = 0, block = 0;
    const net = netOfWire[w];
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      const n = Math.round((Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / g);
      len += n;
      const dx = Math.sign(b.x - a.x) * g, dy = Math.sign(b.y - a.y) * g;
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const pn = escapes.get(`${a.x + dx * k},${a.y + dy * k}`);
        if (pn !== undefined && pn !== net) block++;
      }
    }
    return len * W.length + Math.max(0, P.length - 2) * W.bend + block * W.blockPin;
  }

  /** short-range forces between two segments (of different wires, or far apart in one wire) */
  function pairE(a: Seg, b: Seg): number {
    if (a.h === b.h) {
      const d = Math.abs(a.c - b.c) / g;
      const ov = (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo)) / g;
      if (d === 0) return ov === -1 ? W.nearMiss : 0;
      // one trunk with a small step in it (two wires of a net continuing each other, offset)
      if (d <= 2 && ov === 0 && netOfWire[a.w] === netOfWire[b.w]) return W.bend;
      if (ov <= 0) return 0;
      return d === 1 ? W.parallel1 * ov : d === 2 ? W.parallel2 * ov : 0;
    }
    const H = a.h ? a : b, V = a.h ? b : a;
    const x = V.c, y = H.c;
    const inH = x > H.lo && x < H.hi, inV = y > V.lo && y < V.hi;
    if (inH && inV) {
      const dEnd = Math.min(x - H.lo, H.hi - x, y - V.lo, V.hi - y) / g;
      return W.crossing + (dEnd <= 1 ? W.crossNear1 : dEnd <= 2 ? W.crossNear2 : 0);
    }
    if (inH && (V.lo - y === g || y - V.hi === g)) return W.nearMiss;
    if (inV && (H.lo - x === g || x - H.hi === g)) return W.nearMiss;
    return 0;
  }

  /** junction dots: wire ends that are not on a pin */
  function junctionsOf(w: number, P: readonly Point[]): Point[] {
    const out: Point[] = [];
    for (const p of [P[0], P[P.length - 1]]) if (!pinLinked.has(`${w}@${key(p)}`)) out.push(p);
    return out;
  }
  function junctionPairE(p: Point, q: Point): number {
    const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) / g;
    return d === 0 ? 0 : d <= 1 ? W.junction1 : d <= 2 ? W.junction2 : 0;
  }

  /** how far the bundle's jogs are from lying on straight lines (members still one jog each) */
  function kinkE(bundle: readonly number[], P: ReadonlyMap<number, Point[]>): number {
    const xs: number[] = [];
    for (const w of bundle) {
      const q = P.get(w) ?? pts[w];
      if (q.length === 4 && q[1].x === q[2].x) xs.push(q[1].x);
    }
    let e = 0;
    for (let i = 1; i + 1 < xs.length; i++) e += (Math.abs(xs[i + 1] - 2 * xs[i] + xs[i - 1]) / g) * W.kink;
    return e;
  }

  /** energy of the wires in `M` (with points `P`) and their interactions with everything else */
  function localE(M: readonly number[], P: ReadonlyMap<number, Point[]>, near: readonly Seg[]): number {
    const inM = new Set(M);
    const mSegs: Seg[] = [];
    let e = 0;
    for (const w of M) {
      const p = P.get(w)!;
      e += selfE(w, p);
      mSegs.push(...segsOf(p, w));
    }
    for (const s of mSegs) for (const t of near) if (!inM.has(t.w)) e += pairE(s, t);
    for (let i = 0; i < mSegs.length; i++)
      for (let j = i + 1; j < mSegs.length; j++) {
        const s = mSegs[i], t = mSegs[j];
        if (s.w === t.w && Math.abs(s.i - t.i) <= 1) continue;
        e += pairE(s, t);
      }
    // junction dots
    const mj: Point[] = [];
    for (const w of M) mj.push(...junctionsOf(w, P.get(w)!));
    for (let o = 0; o < pts.length; o++) {
      if (inM.has(o)) continue;
      for (const q of junctionsOf(o, pts[o])) for (const p of mj) e += junctionPairE(p, q);
    }
    for (let i = 0; i < mj.length; i++) for (let j = i + 1; j < mj.length; j++) e += junctionPairE(mj[i], mj[j]);
    const bs = new Set<number[]>();
    for (const w of M) if (bundleOf.has(w)) bs.add(bundleOf.get(w)!);
    for (const b of bs) e += kinkE(b, P);
    return e;
  }

  function totalE(): number {
    let e = 0;
    for (let w = 0; w < pts.length; w++) e += selfE(w, pts[w]);
    const all = segs.flat();
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const s = all[i], t = all[j];
        if (s.w === t.w && Math.abs(s.i - t.i) <= 1) continue;
        e += pairE(s, t);
      }
    const js = pts.flatMap((p, w) => junctionsOf(w, p));
    for (let i = 0; i < js.length; i++) for (let j = i + 1; j < js.length; j++) e += junctionPairE(js[i], js[j]);
    for (const b of bundles) e += kinkE(b, new Map());
    return e;
  }

  // ---- legality ---------------------------------------------------------------------------
  /** may two segments of wires a and b meet at point p? */
  function contactOk(a: number, b: number, p: Point, P: ReadonlyMap<number, Point[]>): boolean {
    if (a === b) return false;
    if (!linked(a, b)) return false;
    const pa = P.get(a) ?? pts[a], pb = P.get(b) ?? pts[b];
    const endA = (pa[0].x === p.x && pa[0].y === p.y) || (pa[pa.length - 1].x === p.x && pa[pa.length - 1].y === p.y);
    const endB = (pb[0].x === p.x && pb[0].y === p.y) || (pb[pb.length - 1].x === p.x && pb[pb.length - 1].y === p.y);
    return endA || endB;
  }

  function segContactOk(s: Seg, t: Seg, P: ReadonlyMap<number, Point[]>): boolean {
    if (s.w === t.w && Math.abs(s.i - t.i) <= 1) return true;
    if (s.h === t.h) {
      if (s.c !== t.c) return true;
      const ov = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo);
      if (ov < 0) return true;
      if (ov > 0) return false;
      const at = Math.max(s.lo, t.lo);
      return contactOk(s.w, t.w, s.h ? { x: at, y: s.c } : { x: s.c, y: at }, P);
    }
    const H = s.h ? s : t, V = s.h ? t : s;
    const x = V.c, y = H.c;
    if (x < H.lo || x > H.hi || y < V.lo || y > V.hi) return true;
    if (x > H.lo && x < H.hi && y > V.lo && y < V.hi) return true; // a plain crossing
    return contactOk(s.w, t.w, { x, y }, P);
  }

  function legal(M: readonly number[], P: ReadonlyMap<number, Point[]>, near: readonly Seg[]): boolean {
    const inM = new Set(M);
    if (opts.noNewBends) {
      let d = 0;
      for (const w of M) d += P.get(w)!.length - pts[w].length;
      if (d > 0) return false;
    }
    const cur = pts.map((x, i) => P.get(i) ?? x);
    const mSegs: Seg[] = [];
    for (const w of M) {
      const p = P.get(w)!;
      if (p.length < 2) return false;
      const ss = segsOf(p, w);
      if (ss.length !== p.length - 1) return false; // a zero-length or diagonal piece
      mSegs.push(...ss);
    }
    for (const s of mSegs) {
      for (const r of bodies) if (segHitsRect(s, r)) return false;
      // pins on the segment: only the wire's own linked end
      const line = s.h ? pinsByRow.get(s.c) : pinsByCol.get(s.c);
      for (const q of line ?? []) {
        const v = s.h ? q.x : q.y;
        if (v < s.lo || v > s.hi) continue;
        if (!(isEndOf(s.w, q, cur) && pinLinked.has(`${s.w}@${key(q)}`))) return false;
      }
      for (const t of near) if (!inM.has(t.w) && !segContactOk(s, t, P)) return false;
    }
    for (let i = 0; i < mSegs.length; i++) for (let j = i + 1; j < mSegs.length; j++) if (!segContactOk(mSegs[i], mSegs[j], P)) return false;
    // every link of a moved wire still holds
    for (const [a, b] of wireLinks) {
      if (!inM.has(a) && !inM.has(b)) continue;
      const pa = P.get(a) ?? pts[a], pb = P.get(b) ?? pts[b];
      const ok = onPolyline(pa[0], pb) || onPolyline(pa[pa.length - 1], pb) || onPolyline(pb[0], pa) || onPolyline(pb[pb.length - 1], pa);
      if (!ok) return false;
    }
    for (const [w, p] of wirePinLinks) if (inM.has(w) && !isEndOf(w, p, cur)) return false;
    return true;
  }

  // ---- moves ------------------------------------------------------------------------------------
  /** other wires whose end sits on segment i of wire w (they follow it when it slides) */
  function branchesOn(w: number, a: Point, b: Point): { o: number; atStart: boolean }[] {
    const out: { o: number; atStart: boolean }[] = [];
    const onSeg = (p: Point) =>
      a.x === b.x ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y) : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
    for (const [x, y] of wireLinks) {
      const o = x === w ? y : y === w ? x : -1;
      if (o < 0 || out.some((r) => r.o === o)) continue;
      const P = pts[o];
      const s = P[0], e = P[P.length - 1];
      if (onSeg(s) && !pinLinked.has(`${o}@${key(s)}`)) out.push({ o, atStart: true });
      else if (onSeg(e) && !pinLinked.has(`${o}@${key(e)}`)) out.push({ o, atStart: false });
    }
    return out;
  }

  /** segments of other wires within `pad` of the given point sets (only those can interact) */
  function nearSegs(sets: readonly (readonly Point[])[], pad: number): Seg[] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of sets) for (const p of P) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const out: Seg[] = [];
    for (const ss of segs)
      for (const t of ss) {
        const tx0 = t.h ? t.lo : t.c, tx1 = t.h ? t.hi : t.c, ty0 = t.h ? t.c : t.lo, ty1 = t.h ? t.c : t.hi;
        if (tx1 >= x0 && tx0 <= x1 && ty1 >= y0 && ty0 <= y1) out.push(t);
      }
    return out;
  }

  /**
   * The trunk of segment i of wire w: it and every segment of the same net on the same line that
   * touches it end to end (transitively). Null if a member cannot slide (an end on a pin, or two
   * members in one wire).
   */
  function trunkOf(w: number, i: number): { w: number; i: number }[] | null {
    const s0 = segs[w].find((x) => x.i === i);
    if (!s0) return null;
    const net = netOfWire[w];
    const out: Seg[] = [s0];
    for (let k = 0; k < out.length; k++) {
      const s = out[k];
      for (let o = 0; o < segs.length; o++) {
        if (netOfWire[o] !== net) continue;
        for (const t of segs[o]) {
          if (t.h !== s.h || t.c !== s.c || out.includes(t)) continue;
          if (Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) >= 0) out.push(t);
        }
      }
    }
    const seen = new Set<number>();
    for (const s of out) {
      if (seen.has(s.w) || frozen.has(wires[s.w].id)) return null;
      seen.add(s.w);
      const q = pts[s.w];
      if (s.i === 0 && pinLinked.has(`${s.w}@${key(q[0])}`)) return null;
      if (s.i + 1 === q.length - 1 && pinLinked.has(`${s.w}@${key(q[q.length - 1])}`)) return null;
    }
    return out.map((s) => ({ w: s.w, i: s.i }));
  }

  function apply(P: ReadonlyMap<number, Point[]>) {
    for (const [w, p] of P) {
      pts[w] = p;
      segs[w] = segsOf(p, w);
    }
  }

  const energyBefore = totalE();
  let moves = 0, sweeps = 0;
  const outOfTime = () => now() - t0 > budget;

  for (; sweeps < maxSweeps && !outOfTime(); sweeps++) {
    let improved = false;
    // 0. lay each bundle's jogs out as a staircase (or a column) in one move
    for (const bundle of bundles) {
      if (outOfTime()) break;
      if (bundle.some((w) => frozen.has(wires[w].id) || pts[w].length !== 4 || pts[w][1].x !== pts[w][2].x)) continue;
      const ends = bundle.map((w) => {
        const P = pts[w];
        return P[0].x < P[3].x ? { L: P[0], R: P[3], flip: false } : { L: P[3], R: P[0], flip: true };
      });
      const lo = Math.max(...ends.map((e) => e.L.x)) + g, hi = Math.min(...ends.map((e) => e.R.x)) - g;
      if (hi < lo) continue;
      // going down, the upper wire jogs to the right of the lower one (else they would cross);
      // going up, the other way round
      const down = ends[0].R.y > ends[0].L.y;
      const dir = down ? -1 : 1;
      const near = nearSegs(bundle.map((w) => pts[w]).concat([[{ x: lo, y: Math.min(...ends.map((e) => Math.min(e.L.y, e.R.y))) }, { x: hi, y: Math.max(...ends.map((e) => Math.max(e.L.y, e.R.y))) }]]), 3 * g);
      const eBefore = localE(bundle, new Map(bundle.map((w) => [w, pts[w]])), near);
      let best: { P: Map<number, Point[]>; dE: number } | null = null;

      for (let step = 0; step <= 6; step++) {
        for (let x0 = lo; x0 <= hi; x0 += g) {
          const xs = bundle.map((_, i) => x0 + dir * i * step * g);
          if (xs.some((x) => x < lo || x > hi)) continue;
          const P = new Map<number, Point[]>();
          bundle.forEach((w, i) => {
            const { L, R, flip } = ends[i];
            const q = [L, { x: xs[i], y: L.y }, { x: xs[i], y: R.y }, R];
            P.set(w, flip ? q.reverse() : q);
          });
          if (!legal(bundle, P, near)) continue;
          const dE = localE(bundle, P, near) - eBefore;
          if (dE < -1e-6 && (!best || dE < best.dE)) best = { P, dE };
        }
      }
      if (best) {
        apply(best.P);
        moves++;
        improved = true;
      }
    }
    for (let w = 0; w < pts.length && !outOfTime(); w++) {
      if (frozen.has(wires[w].id)) continue;
      // 1. slide each segment sideways, together with the rest of its trunk (segments of the same
      //    net on the same line, end to end: they read as one wire), and the wires branching off
      for (let i = 0; i + 1 < pts[w].length; i++) {
        const P0 = pts[w];
        if (i + 1 >= P0.length) break;
        const a = P0[i], b = P0[i + 1];
        const horiz = a.y === b.y;
        const group = trunkOf(w, i);
        if (!group) continue;
        const gw = new Set(group.map((m) => m.w));
        const br: { o: number; atStart: boolean }[] = [];
        let clash = false;
        for (const m of group) {
          const q = pts[m.w];
          for (const r of branchesOn(m.w, q[m.i], q[m.i + 1])) {
            if (gw.has(r.o)) continue;
            if (br.some((x) => x.o === r.o) || frozen.has(wires[r.o].id)) clash = true;
            br.push(r);
          }
        }
        if (clash) continue;
        const M = [...gw, ...br.map((r) => r.o)];
        const before = new Map(M.map((m) => [m, pts[m]]));
        const near = nearSegs(M.map((m) => pts[m]), (reach + 3) * g);
        const eBefore = localE(M, before, near);
        const shifts = new Set<number>();
        for (let k = 1; k <= reach; k++) shifts.add(k * g).add(-k * g);
        // straightening targets: line up with the segment two before / after (removes a jog)
        const here = horiz ? a.y : a.x;
        for (const m of group) {
          const q = pts[m.w];
          for (const j of [m.i - 2, m.i + 2]) {
            if (j < 0 || j + 1 >= q.length) continue;
            const t = horiz ? q[j].y : q[j].x;
            if (t !== here) shifts.add(t - here);
          }
        }
        let best: { P: Map<number, Point[]>; dE: number } | null = null;
        for (const sh of shifts) {
          const delta = horiz ? { x: 0, y: sh } : { x: sh, y: 0 };
          const P = new Map<number, Point[]>();
          for (const m of group) {
            const q = pts[m.w];
            P.set(m.w, dragWireSegmentPoints(q, m.i, delta, pinLinked.has(`${m.w}@${key(q[0])}`), pinLinked.has(`${m.w}@${key(q[q.length - 1])}`)));
          }
          for (const r of br) {
            const op = pts[r.o];
            const seq = r.atStart ? op : [...op].reverse();
            const moved = normalizeWirePoints(stretchWireStart(seq, { x: seq[0].x + delta.x, y: seq[0].y + delta.y }));
            P.set(r.o, r.atStart ? moved : moved.reverse());
          }
          if (!legal(M, P, near)) continue;
          const dE = localE(M, P, near) - eBefore;
          if (dE < -1e-6 && (!best || dE < best.dE)) best = { P, dE };
        }
        if (best) {
          apply(best.P);
          moves++;
          improved = true;
        }
      }
      // 2. re-route the whole wire between its ends (only if nothing branches off its middle)
      const P0 = pts[w];
      const s0 = P0[0], e0 = P0[P0.length - 1];
      const midBranch = wireLinks.some(([x, y]) => {
        const o = x === w ? y : y === w ? x : -1;
        if (o < 0) return false;
        const op = pts[o];
        return [op[0], op[op.length - 1]].some((p) => onPolyline(p, P0) && !isEndOf(w, p));
      });
      if (midBranch) continue;
      const view: SchematicDocument = { ...doc, wires: wires.map((x, j) => ({ ...x, points: pts[j] })) };
      const obs = new RouteObstacles(view, new Set([wires[w].id]), opts.keepOut ?? []);
      const allowed = new Set<string>();
      for (const [x, y] of wireLinks) {
        const o = x === w ? y : y === w ? x : -1;
        if (o >= 0) for (const p of [s0, e0]) allowed.add(`${wires[o].id}@${key(p)}`);
      }
      const np = safeRoute(obs, s0, e0, { self: new Set([wires[w].id]), allowed });
      if (!np || np.length < 2) continue;
      const cand = normalizeWirePoints(np);
      if (cand.length === P0.length && cand.every((p, j) => p.x === P0[j].x && p.y === P0[j].y)) continue;
      const P = new Map<number, Point[]>([[w, cand]]);
      const near = nearSegs([cand, P0], 3 * g);
      if (!legal([w], P, near)) continue;
      const dE = localE([w], P, near) - localE([w], new Map([[w, P0]]), near);
      if (dE < -1e-6) {
        apply(P);
        moves++;
        improved = true;
      }
    }
    if (!improved) {
      sweeps++;
      break;
    }
  }

  for (let w = 0; w < wires.length; w++) wires[w].points = pts[w];
  return { energyBefore, energyAfter: totalE(), moves, sweeps };
}

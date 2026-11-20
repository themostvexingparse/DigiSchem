/**
 * Axis-symmetric 1-D constraint-graph compaction pass (X or Y).
 *
 * Models every component, text note, and wire vertex as a scalar coordinate variable along
 * the compaction axis `axis` ("x" or "y"), keeping orthogonal coordinates fixed:
 *  1. Equality constraints (wire orthogonality, pin attachments, shared vertices, T-junctions
 *     on perpendicular segments, direct pin abutments, and fixed items outside `opts.ids`)
 *     are merged via an offset Union-Find into rigid coordinate groups.
 *  2. Inequality constraints `X[v] - X[u] >= w` (always multiples of `grid`) enforce:
 *     - Minimum segment length >= 1 grid & orientation/direction preservation (Rules 2, 3, 8b)
 *     - T-junction & mid-segment pin sliding bounds (Rule 4)
 *     - Plain wire crossing separation (Rules 1, 7)
 *     - Same-row / same-column wire & pin separation (Rules 1, 7)
 *     - Component body separation with `componentGap` via shadow-pruned visibility sweep (Rule 6)
 *     - Parallel wire segment spacing & wire-to-unrelated-body spacing with `wireGap` (Rule 6)
 *     - Label & text-note strict non-overlap against bodies, wires, labels, and texts (Rule 6)
 *     - Component relative ordering preservation via transitive-pruned frontier (Rule 8a)
 *  3. Solves minimum (ASAP) and maximum (ALAP) feasible positions via SPFA longest-path
 *     (which cleanly handles negative-weight cycles arising from fixed brackets or rigid
 *     multi-component groups, with positive-cycle detection & clamping fallback).
 *  4. Pulls groups with positive slack toward the median of their connected wire neighbors
 *     (or schematic centroid for unconnected elements) to cluster connected subcircuits and
 *     minimize total wirelength without increasing the optimal bounding span.
 */
import type { Point, SchematicDocument } from "../model/types";
import { GRID } from "../model/component-def";
import {
  componentBounds,
  labelBounds,
  pointOnSegment,
  SegmentIndex,
  textNoteBounds,
  worldPins,
  type Rect,
  type WorldPin,
} from "../model/geometry";
import type { PackOptions } from "./pack";

export type Axis = "x" | "y";

/** Slack-placement strategy within feasible `[dMin, dMax]` bounds. */
export type SlackStrategy = "median" | "centroid" | "min" | "max" | "keep" | "align";

export interface CompactionOptions extends Required<Pick<PackOptions, "componentGap" | "wireGap">> {
  ids?: ReadonlySet<string>;
  /**
   * Optional maximum allowed document span along `axis` for wide-bounds quality polish
   * (e.g. `floor(areaBefore / otherSpan)` so Rule 9 holds).
   */
  maxSpan?: number;
}

export interface CompGroupInfo {
  compIdx: number;
  group: number;
  type: string;
  w: number;
  h: number;
  classKey: string;
  offLo: number;
  offHi: number;
  sLo: number;
  sHi: number;
}

export interface CompactionModel {
  readonly axis: Axis;
  readonly grid: number;
  readonly compGapPx: number;
  readonly numGroups: number;
  readonly anchorGroup: number;
  readonly groupOrig: Float64Array;
  readonly groupLeftExt: Float64Array;
  readonly groupRightExt: Float64Array;
  readonly groupSubLeftExt: Float64Array;
  readonly groupSubRightExt: Float64Array;
  readonly origDocMin: number;
  readonly origDocMax: number;
  readonly adj: { to: number; w: number }[][];
  readonly revAdj: { from: number; w: number }[][];
  /** Tight minimum-span feasible bounds (or anchor-respecting bounds when `ids` is set). */
  readonly dMin: Float64Array;
  readonly dMax: Float64Array;
  /** Wider feasible bounds up to `maxSpan` / `origDocMax` for quality polish. */
  readonly wideMin: Float64Array;
  readonly wideMax: Float64Array;
  readonly compInfos: readonly CompGroupInfo[];
  readonly compGroupSet: ReadonlySet<number>;
  /** Exact dynamic feasible interval `[lo, hi]` for group `g` given current `x` and `[bMin, bMax]`. */
  feasibleInterval(g: number, x: Float64Array, bMin: Float64Array, bMax: Float64Array): [number, number];
  /** Compute a feasible coordinate vector using the requested slack strategy. */
  solveStrategy(strategy: SlackStrategy): Float64Array;
  /** Mutate only group `g`'s primary-axis coordinates in `targetDoc` (zero allocation). */
  setGroupCoord(targetDoc: SchematicDocument, g: number, val: number): void;
  /** Apply full solution vector `sol` in-place to `targetDoc`. */
  applyTo(targetDoc: SchematicDocument, sol: Float64Array): void;
  /** Clone the source document and apply `sol`. */
  materialize(sol: Float64Array): SchematicDocument;
  /** Groups owning wire vertices or perpendicular segments that pass through any of `events`. */
  groupsAffectingEvents(targetDoc: SchematicDocument, events: readonly Point[]): Set<number>;
  /**
   * Run forward SPFA with additional temporary minimum-separation constraints `x[to] - x[from] >= w`
   * (used by quality polish to jointly open cluttered crossing/junction corridors).
   * Returns `null` if infeasible or if anchorGroup would move.
   */
  solveWithExtraEdges(
    extraEdges: readonly { from: number; to: number; w: number }[],
    seed?: Float64Array,
  ): Float64Array | null;
}

const EPS = 1e-6;

function normZero(v: number): number {
  return v === 0 ? 0 : v;
}

/** Smallest multiple of `grid` that is `>= v` (with float tolerance). */
function ceilGrid(v: number, grid: number): number {
  return normZero(Math.ceil((v - EPS) / grid) * grid);
}

/** Largest multiple of `grid` that is `<= v` (with float tolerance). */
function floorGrid(v: number, grid: number): number {
  return normZero(Math.floor((v + EPS) / grid) * grid);
}

/** Smallest multiple of `grid` that is STRICTLY `> v` (with float tolerance). */
function strictGridAbove(v: number, grid: number): number {
  return normZero((Math.floor((v + EPS) / grid) + 1) * grid);
}

function snapGrid(v: number, grid: number): number {
  return normZero(Math.round(v / grid) * grid);
}

/**
 * Union-Find for scalar coordinate variables whose original coordinates are known.
 * All members of a group shift by the exact same displacement delta = X[root] - orig[root].
 */
class GroupUnionFind {
  readonly parent: Int32Array;
  readonly rank: Int32Array;
  readonly orig: Float64Array;

  constructor(origCoords: readonly number[]) {
    const n = origCoords.length;
    this.parent = new Int32Array(n);
    this.rank = new Int32Array(n);
    this.orig = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this.orig[i] = origCoords[i];
    }
  }

  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    let c = x;
    while (c !== r) {
      const next = this.parent[c];
      this.parent[c] = r;
      c = next;
    }
    return r;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
  }
}

/** Subtract interval [cutLo, cutHi] from a sorted disjoint list of open intervals. */
function subtractInterval(intervals: [number, number][], cutLo: number, cutHi: number): [number, number][] {
  if (cutLo >= cutHi || intervals.length === 0) return intervals;
  const out: [number, number][] = [];
  for (const [lo, hi] of intervals) {
    if (cutHi <= lo || cutLo >= hi) {
      out.push([lo, hi]);
    } else {
      if (lo < cutLo) out.push([lo, cutLo]);
      if (cutHi < hi) out.push([cutHi, hi]);
    }
  }
  return out;
}

function overlapsAnyInterval(intervals: readonly [number, number][], lo: number, hi: number): boolean {
  for (const [a, b] of intervals) {
    if (a < hi && lo < b) return true;
  }
  return false;
}

interface BodyItem {
  compIdx: number;
  compId: string;
  group: number;
  pLo: number;
  pHi: number;
  offLo: number;
  offHi: number;
  sLo: number;
  sHi: number;
}

interface BoxItem {
  kind: "label" | "text";
  ownerCompIdx: number; // >=0 for label, -1 for text
  id: string;
  group: number;
  pLo: number;
  pHi: number;
  offLo: number;
  offHi: number;
  sLo: number;
  sHi: number;
}

/** Wire segment perpendicular to compaction axis (vertical in X-pass, horizontal in Y-pass). */
interface PerpSeg {
  wireIdx: number;
  wireId: string;
  segIdx: number;
  group: number;
  p: number;
  off: number;
  sLo: number;
  sHi: number;
}

/** Wire segment parallel to compaction axis (horizontal in X-pass, vertical in Y-pass). */
interface ParSeg {
  wireIdx: number;
  wireId: string;
  segIdx: number;
  s: number;
  loVtxVar: number;
  hiVtxVar: number;
  loGroup: number;
  hiGroup: number;
  pLo: number;
  pHi: number;
  loOff: number;
  hiOff: number;
}

interface WirePullEdge {
  gU: number;
  offU: number;
  gV: number;
  offV: number;
}

interface EdgeMap {
  desired: Map<number, number>;
  clamped: Map<number, number>;
}

/**
 * Longest-path SPFA: finds minimal `d` such that `d[u] >= init[u]` and `d[v] >= d[u] + w(u, v)`.
 * Returns `null` if a positive-weight cycle is detected.
 */
function spfaForward(
  numGroups: number,
  init: Float64Array,
  adj: { to: number; w: number }[][],
  order: readonly number[],
): Float64Array | null {
  const dist = new Float64Array(init);
  const inQ = new Uint8Array(numGroups);
  const count = new Int32Array(numGroups);
  const queue: number[] = [];
  let head = 0;

  for (const u of order) {
    if (dist[u] > -1e14) {
      queue.push(u);
      inQ[u] = 1;
    }
  }

  while (head < queue.length) {
    const u = queue[head++];
    inQ[u] = 0;
    const du = dist[u];
    const edges = adj[u];
    for (let i = 0; i < edges.length; i++) {
      const { to: v, w } = edges[i];
      const cand = du + w;
      if (cand > dist[v]) {
        dist[v] = cand;
        if (!inQ[v]) {
          inQ[v] = 1;
          queue.push(v);
          count[v] += 1;
          if (count[v] > numGroups) return null;
        }
      }
    }
  }
  return dist;
}

/**
 * Dual SPFA: finds maximal `d` such that `d[u] <= init[u]` and `d[u] <= d[v] - w(u, v)`.
 * Returns `null` if a positive-weight cycle is detected.
 */
function spfaBackward(
  numGroups: number,
  init: Float64Array,
  revAdj: { from: number; w: number }[][],
  revOrder: readonly number[],
): Float64Array | null {
  const dist = new Float64Array(init);
  const inQ = new Uint8Array(numGroups);
  const count = new Int32Array(numGroups);
  const queue: number[] = [];
  let head = 0;

  for (const v of revOrder) {
    if (dist[v] < 1e14) {
      queue.push(v);
      inQ[v] = 1;
    }
  }

  while (head < queue.length) {
    const v = queue[head++];
    inQ[v] = 0;
    const dv = dist[v];
    const edges = revAdj[v];
    for (let i = 0; i < edges.length; i++) {
      const { from: u, w } = edges[i];
      const cand = dv - w;
      if (cand < dist[u]) {
        dist[u] = cand;
        if (!inQ[u]) {
          inQ[u] = 1;
          queue.push(u);
          count[u] += 1;
          if (count[u] > numGroups) return null;
        }
      }
    }
  }
  return dist;
}

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  if (values.length % 2 === 1) return values[mid];
  return (values[mid - 1] + values[mid]) / 2;
}

function evalWireLength(x: Float64Array, pulls: readonly WirePullEdge[]): number {
  let total = 0;
  for (let i = 0; i < pulls.length; i++) {
    const e = pulls[i];
    total += Math.abs(x[e.gV] + e.offV - (x[e.gU] + e.offU));
  }
  return total;
}

/** Compute total Manhattan wirelength of a document (used as tie-breaker across passes). */
export function totalWireLength(doc: SchematicDocument): number {
  let total = 0;
  for (const w of doc.wires) {
    for (let i = 0; i + 1 < w.points.length; i++) {
      total += Math.abs(w.points[i + 1].x - w.points[i].x) + Math.abs(w.points[i + 1].y - w.points[i].y);
    }
  }
  return total;
}

/**
 * Build a reusable 1-D constraint-graph compaction model along `axis` ("x" or "y").
 * Returns `null` if the document is empty or the constraint graph is infeasible.
 * Never mutates `doc`.
 */
export function buildCompactionModel(
  doc: SchematicDocument,
  axis: Axis,
  opts: CompactionOptions,
): CompactionModel | null {
  const grid = doc.grid || GRID;
  const compGapPx = opts.componentGap * grid;
  const wireGapPx = opts.wireGap * grid;
  const ids = opts.ids;
  const isX = axis === "x";

  const getP = (pt: Point): number => (isX ? pt.x : pt.y);
  const getS = (pt: Point): number => (isX ? pt.y : pt.x);
  const rectPLo = (r: Rect): number => (isX ? r.x : r.y);
  const rectPHi = (r: Rect): number => (isX ? r.x + r.w : r.y + r.h);
  const rectSLo = (r: Rect): number => (isX ? r.y : r.x);
  const rectSHi = (r: Rect): number => (isX ? r.y + r.h : r.x + r.w);

  // --- 1. Allocate raw scalar variables ---
  // Variable 0 is ANCHOR (only used when opts.ids is set; fixed at orig=0).
  const origCoords: number[] = [0];
  const ANCHOR_VAR = 0;

  const compVars: number[] = [];
  for (const c of doc.components) {
    compVars.push(origCoords.length);
    origCoords.push(isX ? c.x : c.y);
  }
  const textVars: number[] = [];
  for (const t of doc.texts) {
    textVars.push(origCoords.length);
    origCoords.push(isX ? t.x : t.y);
  }
  const vtxVars: number[][] = [];
  for (const w of doc.wires) {
    const arr: number[] = [];
    for (const p of w.points) {
      arr.push(origCoords.length);
      origCoords.push(getP(p));
    }
    vtxVars.push(arr);
  }

  const uf = new GroupUnionFind(origCoords);

  // Pin fixed items (outside opts.ids) to ANCHOR_VAR
  if (ids) {
    for (let i = 0; i < doc.components.length; i++) {
      if (!ids.has(doc.components[i].id)) uf.union(compVars[i], ANCHOR_VAR);
    }
    for (let i = 0; i < doc.texts.length; i++) {
      if (!ids.has(doc.texts[i].id)) uf.union(textVars[i], ANCHOR_VAR);
    }
    for (let wi = 0; wi < doc.wires.length; wi++) {
      if (!ids.has(doc.wires[wi].id)) {
        for (const vv of vtxVars[wi]) uf.union(vv, ANCHOR_VAR);
      }
    }
  }

  // Index component pins & wire vertices by exact world coordinate
  const compBoundsArr: Rect[] = [];
  const compPinsArr: WorldPin[][] = [];
  const pinsAtPt = new Map<string, { compIdx: number; wp: WorldPin }[]>();
  const abuttingCompPairs = new Set<string>();
  const ptKey = (p: Point) => `${p.x},${p.y}`;
  const cPairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

  for (let ci = 0; ci < doc.components.length; ci++) {
    const c = doc.components[ci];
    compBoundsArr.push(componentBounds(c));
    const wps = worldPins(c);
    compPinsArr.push(wps);
    for (const wp of wps) {
      const k = ptKey(wp.pos);
      const list = pinsAtPt.get(k);
      if (list) {
        // Direct pin-to-pin abutment: unite the two components rigidly
        for (const prev of list) {
          uf.union(compVars[ci], compVars[prev.compIdx]);
          if (ci !== prev.compIdx) abuttingCompPairs.add(cPairKey(ci, prev.compIdx));
        }
        list.push({ compIdx: ci, wp });
      } else {
        pinsAtPt.set(k, [{ compIdx: ci, wp }]);
      }
    }
  }

  // Wire orthogonality & diagonal rigidity + shared vertices + pin attachments
  const vtxAtPt = new Map<string, number>();
  for (let wi = 0; wi < doc.wires.length; wi++) {
    const w = doc.wires[wi];
    const vv = vtxVars[wi];
    for (let k = 0; k < w.points.length; k++) {
      const p = w.points[k];
      const pk = ptKey(p);

      // Shared wire vertices
      const firstVtx = vtxAtPt.get(pk);
      if (firstVtx !== undefined) uf.union(vv[k], firstVtx);
      else vtxAtPt.set(pk, vv[k]);

      // Wire vertex on component pin
      const pinsHere = pinsAtPt.get(pk);
      if (pinsHere) {
        for (const { compIdx } of pinsHere) uf.union(vv[k], compVars[compIdx]);
      }

      // Segment orthogonality: perpendicular segments share primary coordinate
      if (k + 1 < w.points.length) {
        const q = w.points[k + 1];
        const sameP = getP(p) === getP(q);
        const sameS = getS(p) === getS(q);
        if (sameP || !sameS) {
          // Perpendicular segment (sameP) OR diagonal segment (!sameP && !sameS): move rigidly
          uf.union(vv[k], vv[k + 1]);
        }
      }
    }
  }

  // T-junctions and mid-segment pin taps on PERPENDICULAR wire segments -> equality in P
  const segIndex = new SegmentIndex(doc.wires);
  const perpLines = isX ? segIndex.cols : segIndex.rows;
  // Map (wireIdx, segIdx) -> first vertex var of perpendicular segments for fast lookup
  const perpSegByCoord = new Map<
    number,
    { wireIdx: number; segIdx: number; sLo: number; sHi: number; vtxVar: number }[]
  >();
  for (let wi = 0; wi < doc.wires.length; wi++) {
    const w = doc.wires[wi];
    for (let si = 0; si + 1 < w.points.length; si++) {
      const a = w.points[si];
      const b = w.points[si + 1];
      if (getP(a) === getP(b) && getS(a) !== getS(b)) {
        const coord = getP(a);
        const entry = {
          wireIdx: wi,
          segIdx: si,
          sLo: Math.min(getS(a), getS(b)),
          sHi: Math.max(getS(a), getS(b)),
          vtxVar: vtxVars[wi][si],
        };
        const arr = perpSegByCoord.get(coord);
        if (arr) arr.push(entry);
        else perpSegByCoord.set(coord, [entry]);
      }
    }
  }

  // Unite wire vertices & component pins lying strictly on perpendicular segments
  for (let wi = 0; wi < doc.wires.length; wi++) {
    const w = doc.wires[wi];
    for (let k = 0; k < w.points.length; k++) {
      const p = w.points[k];
      const pCoord = getP(p);
      const sCoord = getS(p);
      if (!perpLines.has(pCoord)) continue;
      for (const seg of perpSegByCoord.get(pCoord) ?? []) {
        if (seg.wireIdx === wi) continue;
        if (sCoord > seg.sLo && sCoord < seg.sHi) {
          uf.union(vtxVars[wi][k], seg.vtxVar);
        }
      }
    }
  }
  for (let ci = 0; ci < doc.components.length; ci++) {
    for (const wp of compPinsArr[ci]) {
      const pCoord = getP(wp.pos);
      const sCoord = getS(wp.pos);
      for (const seg of perpSegByCoord.get(pCoord) ?? []) {
        if (sCoord > seg.sLo && sCoord < seg.sHi) {
          uf.union(compVars[ci], seg.vtxVar);
        }
      }
    }
  }

  // --- 2. Compress Union-Find roots to dense group indices 0..numGroups-1 ---
  const rootToGroup = new Map<number, number>();
  const groupOrigList: number[] = [];
  const getGroup = (rawVar: number): number => {
    const r = uf.find(rawVar);
    let g = rootToGroup.get(r);
    if (g === undefined) {
      g = groupOrigList.length;
      rootToGroup.set(r, g);
      groupOrigList.push(origCoords[r]);
    }
    return g;
  };

  // Ensure ANCHOR group is created when ids is provided
  const anchorGroup = ids ? getGroup(ANCHOR_VAR) : -1;
  for (let i = 0; i < compVars.length; i++) getGroup(compVars[i]);
  for (let i = 0; i < textVars.length; i++) getGroup(textVars[i]);
  for (let wi = 0; wi < vtxVars.length; wi++) {
    for (let k = 0; k < vtxVars[wi].length; k++) getGroup(vtxVars[wi][k]);
  }

  const numGroups = groupOrigList.length;
  const groupOrig = Float64Array.from(groupOrigList);
  const varGroup = (rawVar: number): number => rootToGroup.get(uf.find(rawVar))!;
  const varOff = (rawVar: number): number => origCoords[rawVar] - groupOrig[varGroup(rawVar)];

  // Track which groups contain any element in `opts.ids` (movable)
  const groupInSubset = new Uint8Array(numGroups);
  if (ids) {
    for (let i = 0; i < doc.components.length; i++) {
      if (ids.has(doc.components[i].id)) groupInSubset[varGroup(compVars[i])] = 1;
    }
    for (let i = 0; i < doc.texts.length; i++) {
      if (ids.has(doc.texts[i].id)) groupInSubset[varGroup(textVars[i])] = 1;
    }
    for (let wi = 0; wi < doc.wires.length; wi++) {
      if (ids.has(doc.wires[wi].id)) {
        for (const vv of vtxVars[wi]) groupInSubset[varGroup(vv)] = 1;
      }
    }
  } else {
    groupInSubset.fill(1);
  }

  // --- 3. Build 2-D geometric element lists & per-group extents ---
  const groupLeftExt = new Float64Array(numGroups).fill(Infinity);
  const groupRightExt = new Float64Array(numGroups).fill(-Infinity);
  const groupSubLeftExt = new Float64Array(numGroups).fill(Infinity);
  const groupSubRightExt = new Float64Array(numGroups).fill(-Infinity);

  const expandExtent = (g: number, offLo: number, offHi: number, inSub: boolean) => {
    if (offLo < groupLeftExt[g]) groupLeftExt[g] = offLo;
    if (offHi > groupRightExt[g]) groupRightExt[g] = offHi;
    if (inSub) {
      if (offLo < groupSubLeftExt[g]) groupSubLeftExt[g] = offLo;
      if (offHi > groupSubRightExt[g]) groupSubRightExt[g] = offHi;
    }
  };

  const bodies: BodyItem[] = [];
  const boxes: BoxItem[] = [];
  for (let ci = 0; ci < doc.components.length; ci++) {
    const c = doc.components[ci];
    const g = varGroup(compVars[ci]);
    const b = compBoundsArr[ci];
    const pLo = rectPLo(b);
    const pHi = rectPHi(b);
    const offLo = pLo - groupOrig[g];
    const offHi = pHi - groupOrig[g];
    const inSub = !ids || ids.has(c.id);
    expandExtent(g, offLo, offHi, inSub);
    bodies.push({
      compIdx: ci,
      compId: c.id,
      group: g,
      pLo,
      pHi,
      offLo,
      offHi,
      sLo: rectSLo(b),
      sHi: rectSHi(b),
    });

    const lb = labelBounds(c);
    if (lb) {
      const lpLo = rectPLo(lb);
      const lpHi = rectPHi(lb);
      const lOffLo = lpLo - groupOrig[g];
      const lOffHi = lpHi - groupOrig[g];
      expandExtent(g, lOffLo, lOffHi, inSub);
      boxes.push({
        kind: "label",
        ownerCompIdx: ci,
        id: c.id,
        group: g,
        pLo: lpLo,
        pHi: lpHi,
        offLo: lOffLo,
        offHi: lOffHi,
        sLo: rectSLo(lb),
        sHi: rectSHi(lb),
      });
    }
  }

  for (let ti = 0; ti < doc.texts.length; ti++) {
    const t = doc.texts[ti];
    const g = varGroup(textVars[ti]);
    const tb = textNoteBounds(t);
    const pLo = rectPLo(tb);
    const pHi = rectPHi(tb);
    const offLo = pLo - groupOrig[g];
    const offHi = pHi - groupOrig[g];
    const inSub = !ids || ids.has(t.id);
    expandExtent(g, offLo, offHi, inSub);
    boxes.push({
      kind: "text",
      ownerCompIdx: -1,
      id: t.id,
      group: g,
      pLo,
      pHi,
      offLo,
      offHi,
      sLo: rectSLo(tb),
      sHi: rectSHi(tb),
    });
  }

  const perpSegs: PerpSeg[] = [];
  const parSegs: ParSeg[] = [];
  const wirePulls: WirePullEdge[] = [];

  for (let wi = 0; wi < doc.wires.length; wi++) {
    const w = doc.wires[wi];
    const inSub = !ids || ids.has(w.id);
    for (let k = 0; k < w.points.length; k++) {
      const g = varGroup(vtxVars[wi][k]);
      const off = varOff(vtxVars[wi][k]);
      expandExtent(g, off, off, inSub);
    }
    for (let si = 0; si + 1 < w.points.length; si++) {
      const a = w.points[si];
      const b = w.points[si + 1];
      const pa = getP(a);
      const pb = getP(b);
      const sa = getS(a);
      const sb = getS(b);
      if (pa === pb && sa !== sb) {
        const g = varGroup(vtxVars[wi][si]);
        perpSegs.push({
          wireIdx: wi,
          wireId: w.id,
          segIdx: si,
          group: g,
          p: pa,
          off: pa - groupOrig[g],
          sLo: Math.min(sa, sb),
          sHi: Math.max(sa, sb),
        });
      } else if (sa === sb && pa !== pb) {
        const loIdx = pa < pb ? si : si + 1;
        const hiIdx = pa < pb ? si + 1 : si;
        const loVtxVar = vtxVars[wi][loIdx];
        const hiVtxVar = vtxVars[wi][hiIdx];
        const loGroup = varGroup(loVtxVar);
        const hiGroup = varGroup(hiVtxVar);
        const pLo = Math.min(pa, pb);
        const pHi = Math.max(pa, pb);
        const loOff = pLo - groupOrig[loGroup];
        const hiOff = pHi - groupOrig[hiGroup];
        parSegs.push({
          wireIdx: wi,
          wireId: w.id,
          segIdx: si,
          s: sa,
          loVtxVar,
          hiVtxVar,
          loGroup,
          hiGroup,
          pLo,
          pHi,
          loOff,
          hiOff,
        });
        if (loGroup !== hiGroup) {
          wirePulls.push({ gU: loGroup, offU: loOff, gV: hiGroup, offV: hiOff });
        }
      }
    }
  }

  // Ensure every group has finite extents (e.g. ANCHOR if empty)
  for (let g = 0; g < numGroups; g++) {
    if (!Number.isFinite(groupLeftExt[g])) {
      groupLeftExt[g] = 0;
      groupRightExt[g] = 0;
    }
  }

  // --- 4. Constraint Graph Construction ---
  // Edges represent: X[v] - X[u] >= w (where w is always an integer multiple of grid).
  const edgeMaps: EdgeMap[] = Array.from({ length: numGroups }, () => ({
    desired: new Map<number, number>(),
    clamped: new Map<number, number>(),
  }));
  let hasRepairEdges = false;

  /**
   * Add constraint `(X[gB] + offB) - (X[gA] + offA) >= minSep` (non-strict)
   * or `> minSep` when `strict = true`.
   */
  const addEdge = (
    gA: number,
    offA: number,
    gB: number,
    offB: number,
    minSep: number,
    strict = false,
  ) => {
    if (gA === gB) return;
    const rawDiff = offA - offB + minSep;
    const wDesired = strict ? strictGridAbove(rawDiff, grid) : ceilGrid(rawDiff, grid);
    const origDelta = groupOrig[gB] - groupOrig[gA];
    const wClamped = Math.min(wDesired, origDelta);
    if (wDesired > wClamped) hasRepairEdges = true;

    const em = edgeMaps[gA];
    const prevD = em.desired.get(gB);
    if (prevD === undefined || wDesired > prevD) em.desired.set(gB, wDesired);
    const prevC = em.clamped.get(gB);
    if (prevC === undefined || wClamped > prevC) em.clamped.set(gB, wClamped);
  };

  // --- Constraint Group A: Parallel wire segment min length (>= grid) & direction preservation ---
  for (const seg of parSegs) {
    const origLen = seg.pHi - seg.pLo;
    const minLen = origLen >= grid ? grid : origLen;
    addEdge(seg.loGroup, seg.loOff, seg.hiGroup, seg.hiOff, minLen);
  }

  // --- Constraint Group B & D: Same-line points/segments (T-junctions, mid-segment pins, collinear wires) ---
  // Group all parallel segments, wire vertices, and component pins by their secondary coordinate `s`.
  interface LineObj {
    loGroup: number;
    loOff: number;
    hiGroup: number;
    hiOff: number;
    pLo: number;
    pHi: number;
    isParSeg: boolean;
    parSegIdx: number;
  }
  const byLine = new Map<number, LineObj[]>();
  const pushLine = (s: number, obj: LineObj) => {
    const arr = byLine.get(s);
    if (arr) arr.push(obj);
    else byLine.set(s, [obj]);
  };

  for (let i = 0; i < parSegs.length; i++) {
    const seg = parSegs[i];
    pushLine(seg.s, {
      loGroup: seg.loGroup,
      loOff: seg.loOff,
      hiGroup: seg.hiGroup,
      hiOff: seg.hiOff,
      pLo: seg.pLo,
      pHi: seg.pHi,
      isParSeg: true,
      parSegIdx: i,
    });
  }
  // Also index every wire vertex & component pin on lines that have at least one parallel segment
  const seenPointOnLine = new Map<number, Set<number>>();
  const addPointOnLine = (s: number, p: number, g: number, off: number) => {
    if (!byLine.has(s)) return;
    let seen = seenPointOnLine.get(s);
    if (!seen) {
      seen = new Set<number>();
      seenPointOnLine.set(s, seen);
    }
    if (seen.has(p)) return;
    seen.add(p);
    pushLine(s, {
      loGroup: g,
      loOff: off,
      hiGroup: g,
      hiOff: off,
      pLo: p,
      pHi: p,
      isParSeg: false,
      parSegIdx: -1,
    });
  };
  for (let wi = 0; wi < doc.wires.length; wi++) {
    const w = doc.wires[wi];
    for (let k = 0; k < w.points.length; k++) {
      const pt = w.points[k];
      const g = varGroup(vtxVars[wi][k]);
      addPointOnLine(getS(pt), getP(pt), g, getP(pt) - groupOrig[g]);
    }
  }
  for (let ci = 0; ci < doc.components.length; ci++) {
    const g = varGroup(compVars[ci]);
    for (const wp of compPinsArr[ci]) {
      addPointOnLine(getS(wp.pos), getP(wp.pos), g, getP(wp.pos) - groupOrig[g]);
    }
  }

  for (const objs of byLine.values()) {
    // B: T-junctions & mid-segment pins strictly inside each parallel segment
    const pts = objs.filter((o) => !o.isParSeg).sort((a, b) => a.pLo - b.pLo);
    const segsOnLine = objs.filter((o) => o.isParSeg);
    for (const segObj of segsOnLine) {
      const interior: LineObj[] = [];
      for (const pt of pts) {
        if (pt.pLo > segObj.pLo && pt.pLo < segObj.pHi) {
          interior.push(pt);
        }
      }
      if (interior.length > 0) {
        addEdge(segObj.loGroup, segObj.loOff, interior[0].loGroup, interior[0].loOff, grid);
        for (let k = 0; k + 1 < interior.length; k++) {
          const origD = interior[k + 1].pLo - interior[k].pLo;
          const gap = Math.max(grid, Math.min(wireGapPx, origD));
          addEdge(interior[k].hiGroup, interior[k].hiOff, interior[k + 1].loGroup, interior[k + 1].loOff, gap);
        }
        const last = interior[interior.length - 1];
        addEdge(last.hiGroup, last.hiOff, segObj.hiGroup, segObj.hiOff, grid);
      }
    }

    // D: Non-overlapping objects on the same line must stay separated (no collinear collisions)
    objs.sort((a, b) => a.pLo - b.pLo || a.pHi - b.pHi);
    for (let i = 0; i < objs.length; i++) {
      const a = objs[i];
      let minNextHi = Infinity;
      for (let j = i + 1; j < objs.length; j++) {
        const b = objs[j];
        if (b.pLo <= a.pHi) continue;
        if (b.pLo >= minNextHi) break;
        const origD = b.pLo - a.pHi;
        const gap = Math.max(grid, Math.min(wireGapPx, origD));
        addEdge(a.hiGroup, a.hiOff, b.loGroup, b.loOff, gap);
        if (b.pHi < minNextHi) minNextHi = b.pHi;
      }
    }
  }

  // --- Constraint Group C & Sweep 5: PerpSeg vs ParSeg (plain crossings & endpoint protection) ---
  const perpByP = [...perpSegs].sort((a, b) => a.p - b.p || a.sLo - b.sLo);
  for (const h of parSegs) {
    // Binary search perpSegs around [h.pLo, h.pHi]
    // 1. Strictly inside (h.pLo, h.pHi): plain crossings stay strictly interior
    let lo = 0;
    let hi = perpByP.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (perpByP[mid].p <= h.pLo) lo = mid + 1;
      else hi = mid;
    }
    for (let idx = lo; idx < perpByP.length && perpByP[idx].p < h.pHi; idx++) {
      const v = perpByP[idx];
      if (v.sLo < h.s && h.s < v.sHi) {
        // Strict crossing (if connected at (v.p, h.s) via 4-way vertex, v.group matches that vertex,
        // which is already inside Group B; here v.group != h.loGroup and != h.hiGroup).
        const gapL = Math.max(grid, Math.min(wireGapPx, v.p - h.pLo));
        const gapR = Math.max(grid, Math.min(wireGapPx, h.pHi - v.p));
        addEdge(h.loGroup, h.loOff, v.group, v.off, gapL);
        addEdge(v.group, v.off, h.hiGroup, h.hiOff, gapR);
      }
    }

    // 2. Nearest perpSeg strictly RIGHT of h.pHi whose s-span covers h.s
    let rStart = lo;
    while (rStart < perpByP.length && perpByP[rStart].p <= h.pHi) rStart++;
    let rightBoundP = Infinity;
    for (let idx = rStart; idx < perpByP.length; idx++) {
      const v = perpByP[idx];
      if (v.p > rightBoundP) break;
      if (v.sLo <= h.s && h.s <= v.sHi) {
        const gap = Math.max(grid, Math.min(wireGapPx, v.p - h.pHi));
        addEdge(h.hiGroup, h.hiOff, v.group, v.off, gap);
        if (gap >= wireGapPx && rightBoundP === Infinity) rightBoundP = v.p;
      }
    }

    // 3. Nearest perpSeg strictly LEFT of h.pLo whose s-span covers h.s
    let lEnd = lo - 1;
    while (lEnd >= 0 && perpByP[lEnd].p >= h.pLo) lEnd--;
    let leftBoundP = -Infinity;
    for (let idx = lEnd; idx >= 0; idx--) {
      const v = perpByP[idx];
      if (v.p < leftBoundP) break;
      if (v.sLo <= h.s && h.s <= v.sHi) {
        const gap = Math.max(grid, Math.min(wireGapPx, h.pLo - v.p));
        addEdge(v.group, v.off, h.loGroup, h.loOff, gap);
        if (gap >= wireGapPx && leftBoundP === -Infinity) leftBoundP = v.p;
      }
    }
  }

  // --- Sweep 1: Body vs Body (componentGap with exact half-expanded Y-interval shadow pruning) ---
  const bodiesByPLo = [...bodies].sort((a, b) => a.pLo - b.pLo || a.pHi - b.pHi);
  const halfCompPad = compGapPx > 0 ? compGapPx / 2 : 0.1;
  for (let i = 0; i < bodiesByPLo.length; i++) {
    const a = bodiesByPLo[i];
    let uncovered: [number, number][] = [[a.sLo - halfCompPad, a.sHi + halfCompPad]];
    for (let j = i + 1; j < bodiesByPLo.length; j++) {
      const b = bodiesByPLo[j];
      if (b.pLo < a.pHi) continue; // already overlapping in P (must be separated in S)
      if (abuttingCompPairs.has(cPairKey(a.compIdx, b.compIdx))) continue;
      const bSLo = b.sLo - halfCompPad;
      const bSHi = b.sHi + halfCompPad;
      if (!overlapsAnyInterval(uncovered, bSLo, bSHi)) continue;

      if (compGapPx > 0) {
        addEdge(a.group, a.offHi, b.group, b.offLo, compGapPx);
      } else {
        addEdge(a.group, a.offHi, b.group, b.offLo, 0, true);
      }
      if (a.group !== b.group && b.pLo - a.pHi >= compGapPx) {
        uncovered = subtractInterval(uncovered, bSLo, bSHi);
        if (uncovered.length === 0) break;
      }
    }
  }

  // --- Sweep 2: PerpSeg vs PerpSeg (parallel wires with shadow pruning) ---
  for (let i = 0; i < perpByP.length; i++) {
    const a = perpByP[i];
    let uncovered: [number, number][] = [[a.sLo - 0.1, a.sHi + 0.1]];
    for (let j = i + 1; j < perpByP.length; j++) {
      const b = perpByP[j];
      if (b.p <= a.p) continue;
      if (!overlapsAnyInterval(uncovered, b.sLo - 0.1, b.sHi + 0.1)) continue;

      const openOverlap = a.sLo < b.sHi && b.sLo < a.sHi;
      const origD = b.p - a.p;
      const req = openOverlap ? Math.max(grid, Math.min(wireGapPx, origD)) : grid;
      addEdge(a.group, a.off, b.group, b.off, req);

      if (a.group !== b.group && req >= wireGapPx && b.sLo < b.sHi) {
        // Subtract strictly open interior so endpoint touches at tips remain unshadowed
        uncovered = subtractInterval(uncovered, b.sLo, b.sHi);
        if (uncovered.length === 0) break;
      }
    }
  }

  // --- Sweep 3: Body vs PerpSeg and Body vs ParSeg (wireGap & body interior avoidance) ---
  // Precompute which wire segments touch a pin of a given component (related segments)
  const segTouchesCompPin = (wireIdx: number, segIdx: number, compIdx: number): boolean => {
    const w = doc.wires[wireIdx];
    const a = w.points[segIdx];
    const b = w.points[segIdx + 1];
    for (const wp of compPinsArr[compIdx]) {
      if (pointOnSegment(wp.pos, a, b)) return true;
    }
    return false;
  };

  const wirePad = wireGapPx > 0 ? wireGapPx : 0.1;

  // 3a. Body vs PerpSeg (scan right and left with body/vseg shadow pruning)
  for (const body of bodiesByPLo) {
    const bsLo = body.sLo - wirePad;
    const bsHi = body.sHi + wirePad;

    // Scan perpSegs with v.p >= body.pHi (right of body)
    let lo = 0;
    let hi = perpByP.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (perpByP[mid].p < body.pHi) lo = mid + 1;
      else hi = mid;
    }
    let uncoveredR: [number, number][] = [[bsLo, bsHi]];
    for (let idx = lo; idx < perpByP.length; idx++) {
      const v = perpByP[idx];
      if (!overlapsAnyInterval(uncoveredR, v.sLo, v.sHi)) continue;
      if (segTouchesCompPin(v.wireIdx, v.segIdx, body.compIdx)) continue;
      const origD = v.p - body.pHi;
      const req = origD >= wireGapPx ? wireGapPx : origD;
      if (origD > 0) {
        addEdge(body.group, body.offHi, v.group, v.off, Math.max(grid, req));
      } else {
        addEdge(body.group, body.offHi, v.group, v.off, 0);
      }
      if (body.group !== v.group && req >= wireGapPx) {
        uncoveredR = subtractInterval(uncoveredR, v.sLo, v.sHi);
        if (uncoveredR.length === 0) break;
      }
    }

    // Scan perpSegs with v.p <= body.pLo (left of body)
    let lEnd = lo - 1;
    while (lEnd >= 0 && perpByP[lEnd].p > body.pLo) lEnd--;
    let uncoveredL: [number, number][] = [[bsLo, bsHi]];
    for (let idx = lEnd; idx >= 0; idx--) {
      const v = perpByP[idx];
      if (!overlapsAnyInterval(uncoveredL, v.sLo, v.sHi)) continue;
      if (segTouchesCompPin(v.wireIdx, v.segIdx, body.compIdx)) continue;
      const origD = body.pLo - v.p;
      const req = origD >= wireGapPx ? wireGapPx : origD;
      if (origD > 0) {
        addEdge(v.group, v.off, body.group, body.offLo, Math.max(grid, req));
      } else {
        addEdge(v.group, v.off, body.group, body.offLo, 0);
      }
      if (body.group !== v.group && req >= wireGapPx) {
        uncoveredL = subtractInterval(uncoveredL, v.sLo, v.sHi);
        if (uncoveredL.length === 0) break;
      }
    }
  }

  // 3b. Body vs ParSeg
  const bodiesByPHi = [...bodies].sort((a, b) => a.pHi - b.pHi);
  for (const h of parSegs) {
    // Bodies to the RIGHT of h.pHi whose expanded S-range contains h.s
    let lo = 0;
    let hi = bodiesByPLo.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bodiesByPLo[mid].pLo < h.pHi) lo = mid + 1;
      else hi = mid;
    }
    let minRightHi = Infinity;
    for (let idx = lo; idx < bodiesByPLo.length; idx++) {
      const b = bodiesByPLo[idx];
      if (b.pLo >= minRightHi) break;
      if (h.s <= b.sLo - wirePad || h.s >= b.sHi + wirePad) continue;
      if (segTouchesCompPin(h.wireIdx, h.segIdx, b.compIdx)) continue;
      const origD = b.pLo - h.pHi;
      const req = origD > 0 ? Math.max(grid, Math.min(wireGapPx, origD)) : 0;
      addEdge(h.hiGroup, h.hiOff, b.group, b.offLo, req);
      if (req >= wireGapPx && b.pHi < minRightHi) minRightHi = b.pHi;
    }

    // Bodies to the LEFT of h.pLo whose expanded S-range contains h.s
    let lLo = 0;
    let lHi = bodiesByPHi.length;
    while (lLo < lHi) {
      const mid = (lLo + lHi) >> 1;
      if (bodiesByPHi[mid].pHi <= h.pLo) lLo = mid + 1;
      else lHi = mid;
    }
    let maxLeftLo = -Infinity;
    for (let idx = lLo - 1; idx >= 0; idx--) {
      const b = bodiesByPHi[idx];
      if (b.pHi <= maxLeftLo) break;
      if (h.s <= b.sLo - wirePad || h.s >= b.sHi + wirePad) continue;
      if (segTouchesCompPin(h.wireIdx, h.segIdx, b.compIdx)) continue;
      const origD = h.pLo - b.pHi;
      const req = origD > 0 ? Math.max(grid, Math.min(wireGapPx, origD)) : 0;
      addEdge(b.group, b.offHi, h.loGroup, h.loOff, req);
      if (req >= wireGapPx && b.pLo > maxLeftLo) maxLeftLo = b.pLo;
    }
  }

  // --- Sweep 4: Labels & Text Notes vs EVERYTHING (strict non-overlap) ---
  const boxesByPLo = [...boxes].sort((a, b) => a.pLo - b.pLo || a.pHi - b.pHi);
  const parSegsByS = [...parSegs].sort((a, b) => a.s - b.s || a.pLo - b.pLo);

  for (let i = 0; i < boxesByPLo.length; i++) {
    const box = boxesByPLo[i];

    // 4a. Box vs Box
    for (let j = i + 1; j < boxesByPLo.length; j++) {
      const other = boxesByPLo[j];
      if (other.pLo < box.pHi - EPS) continue;
      if (box.sLo <= other.sHi + EPS && other.sLo <= box.sHi + EPS) {
        addEdge(box.group, box.offHi, other.group, other.offLo, 0, true);
      }
    }

    // 4b. Box vs Body
    for (const body of bodiesByPLo) {
      if (box.kind === "label" && box.ownerCompIdx === body.compIdx) continue;
      if (box.sLo > body.sHi + EPS || body.sLo > box.sHi + EPS) continue;
      if (body.pLo >= box.pHi - EPS) {
        addEdge(box.group, box.offHi, body.group, body.offLo, 0, true);
      } else if (box.pLo >= body.pHi - EPS) {
        addEdge(body.group, body.offHi, box.group, box.offLo, 0, true);
      }
    }

    // 4c. Box vs PerpSeg (shadow-pruned right and left)
    let lo = 0;
    let hi = perpByP.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (perpByP[mid].p < box.pHi - EPS) lo = mid + 1;
      else hi = mid;
    }
    let uncovR: [number, number][] = [[box.sLo - 0.1, box.sHi + 0.1]];
    for (let idx = lo; idx < perpByP.length; idx++) {
      const v = perpByP[idx];
      if (!overlapsAnyInterval(uncovR, v.sLo - 0.1, v.sHi + 0.1)) continue;
      addEdge(box.group, box.offHi, v.group, v.off, 0, true);
      if (box.group !== v.group && v.p > box.pHi + EPS && v.sLo < v.sHi) {
        uncovR = subtractInterval(uncovR, v.sLo, v.sHi);
        if (uncovR.length === 0) break;
      }
    }

    let lEnd = lo - 1;
    while (lEnd >= 0 && perpByP[lEnd].p > box.pLo + EPS) lEnd--;
    let uncovL: [number, number][] = [[box.sLo - 0.1, box.sHi + 0.1]];
    for (let idx = lEnd; idx >= 0; idx--) {
      const v = perpByP[idx];
      if (!overlapsAnyInterval(uncovL, v.sLo - 0.1, v.sHi + 0.1)) continue;
      addEdge(v.group, v.off, box.group, box.offLo, 0, true);
      if (box.group !== v.group && v.p < box.pLo - EPS && v.sLo < v.sHi) {
        uncovL = subtractInterval(uncovL, v.sLo, v.sHi);
        if (uncovL.length === 0) break;
      }
    }

    // 4d. Box vs ParSeg (binary search parSegs in [box.sLo, box.sHi])
    let sLoIdx = 0;
    let sHiIdx = parSegsByS.length;
    while (sLoIdx < sHiIdx) {
      const mid = (sLoIdx + sHiIdx) >> 1;
      if (parSegsByS[mid].s < box.sLo - EPS) sLoIdx = mid + 1;
      else sHiIdx = mid;
    }
    for (let idx = sLoIdx; idx < parSegsByS.length && parSegsByS[idx].s <= box.sHi + EPS; idx++) {
      const h = parSegsByS[idx];
      if (h.pLo >= box.pHi - EPS) {
        addEdge(box.group, box.offHi, h.loGroup, h.loOff, 0, true);
      } else if (box.pLo >= h.pHi - EPS) {
        addEdge(h.hiGroup, h.hiOff, box.group, box.offLo, 0, true);
      }
    }
  }

  // --- Sweep 6: Component Relative Ordering (Rule 8a) with exact transitive frontier ---
  for (let i = 0; i < bodiesByPLo.length; i++) {
    const a = bodiesByPLo[i];
    let minRight = Infinity;
    for (let j = i + 1; j < bodiesByPLo.length; j++) {
      const b = bodiesByPLo[j];
      if (b.pLo < a.pHi) continue;
      if (b.pLo >= minRight) break;
      addEdge(a.group, a.offHi, b.group, b.offLo, 0);
      if (b.pHi - b.pLo >= grid && b.pHi < minRight) {
        minRight = b.pHi;
      }
    }
  }

  // --- 5. Materialize adjacency lists & solve via SPFA ---
  const buildAdjacency = (useDesired: boolean) => {
    const adj: { to: number; w: number }[][] = Array.from({ length: numGroups }, () => []);
    const revAdj: { from: number; w: number }[][] = Array.from({ length: numGroups }, () => []);
    for (let u = 0; u < numGroups; u++) {
      const m = useDesired ? edgeMaps[u].desired : edgeMaps[u].clamped;
      for (const [v, w] of m) {
        adj[u].push({ to: v, w });
        revAdj[v].push({ from: u, w });
      }
    }
    return { adj, revAdj };
  };

  // Topological-like queue order: ascending / descending original group coordinates
  const orderAsc = Array.from({ length: numGroups }, (_, i) => i).sort(
    (a, b) => groupOrig[a] - groupOrig[b],
  );
  const orderDesc = [...orderAsc].reverse();

  // Compute original document span along primary axis
  let origDocMin = Infinity;
  let origDocMax = -Infinity;
  let origSubMin = Infinity;
  let origSubMax = -Infinity;
  for (let g = 0; g < numGroups; g++) {
    origDocMin = Math.min(origDocMin, groupOrig[g] + groupLeftExt[g]);
    origDocMax = Math.max(origDocMax, groupOrig[g] + groupRightExt[g]);
    if (Number.isFinite(groupSubLeftExt[g])) {
      origSubMin = Math.min(origSubMin, groupOrig[g] + groupSubLeftExt[g]);
      origSubMax = Math.max(origSubMax, groupOrig[g] + groupSubRightExt[g]);
    }
  }
  if (!Number.isFinite(origDocMin)) return null;

  const tryBuildBounds = (
    adj: { to: number; w: number }[][],
    revAdj: { from: number; w: number }[][],
  ): { dMin: Float64Array; dMax: Float64Array; wideMin: Float64Array; wideMax: Float64Array; minSpanMax: number } | null => {
    if (anchorGroup < 0) {
      const initMin = new Float64Array(numGroups);
      for (let g = 0; g < numGroups; g++) {
        initMin[g] = ceilGrid(origDocMin - groupLeftExt[g], grid);
      }
      const dMin = spfaForward(numGroups, initMin, adj, orderAsc);
      if (!dMin) return null;

      let minSpanMax = -Infinity;
      for (let g = 0; g < numGroups; g++) {
        const right = dMin[g] + groupRightExt[g];
        if (right > minSpanMax) minSpanMax = right;
      }

      const initMax = new Float64Array(numGroups);
      for (let g = 0; g < numGroups; g++) {
        initMax[g] = floorGrid(minSpanMax - groupRightExt[g], grid);
      }
      const dMax = spfaBackward(numGroups, initMax, revAdj, orderDesc) ?? new Float64Array(dMin);

      // Compute wider upper bounds for quality polish (staying within legal Rule 9 span when provided)
      const extraMargin = 8 * grid;
      let wideRight = Math.max(origDocMax, minSpanMax);
      if (opts.maxSpan !== undefined) {
        const legalRight = origDocMin + opts.maxSpan;
        wideRight = Math.min(legalRight, Math.max(origDocMax, minSpanMax + extraMargin));
      }
      wideRight = Math.max(minSpanMax, wideRight);

      let wideMax: Float64Array;
      if (wideRight > minSpanMax + EPS) {
        const initWideMax = new Float64Array(numGroups);
        for (let g = 0; g < numGroups; g++) {
          initWideMax[g] = floorGrid(wideRight - groupRightExt[g], grid);
        }
        wideMax = spfaBackward(numGroups, initWideMax, revAdj, orderDesc) ?? dMax;
        for (let g = 0; g < numGroups; g++) {
          if (wideMax[g] < dMax[g]) wideMax[g] = dMax[g];
        }
      } else {
        wideMax = dMax;
      }

      return { dMin, dMax, wideMin: dMin, wideMax, minSpanMax };
    }

    // Partial compaction (opts.ids): ANCHOR group is strictly pinned at its original coordinate
    const anchorOrig = groupOrig[anchorGroup];
    const initMin = new Float64Array(numGroups);
    const initMax = new Float64Array(numGroups);
    for (let g = 0; g < numGroups; g++) {
      initMin[g] = g === anchorGroup ? anchorOrig : ceilGrid(origDocMin - groupLeftExt[g], grid);
      initMax[g] = g === anchorGroup ? anchorOrig : floorGrid(origDocMax - groupRightExt[g], grid);
    }
    const dMin = spfaForward(numGroups, initMin, adj, orderAsc);
    const dMax = spfaBackward(numGroups, initMax, revAdj, orderDesc);
    if (!dMin || !dMax) return null;
    if (dMin[anchorGroup] !== anchorOrig || dMax[anchorGroup] !== anchorOrig) return null;

    return { dMin, dMax, wideMin: dMin, wideMax: dMax, minSpanMax: origDocMax };
  };

  let chosenGraph = hasRepairEdges ? buildAdjacency(true) : buildAdjacency(false);
  let solved = tryBuildBounds(chosenGraph.adj, chosenGraph.revAdj);
  if (!solved && hasRepairEdges) {
    chosenGraph = buildAdjacency(false);
    solved = tryBuildBounds(chosenGraph.adj, chosenGraph.revAdj);
  }
  if (!solved) return null;

  const { adj, revAdj } = chosenGraph;
  const { dMin, dMax, wideMin, wideMax, minSpanMax } = solved;

  // Precompute per-group element references for fast zero-allocation updates
  const groupCompRefs: { compIdx: number; off: number }[][] = Array.from({ length: numGroups }, () => []);
  const groupTextRefs: { textIdx: number; off: number }[][] = Array.from({ length: numGroups }, () => []);
  const groupVtxRefs: { wireIdx: number; ptIdx: number; off: number }[][] = Array.from({ length: numGroups }, () => []);

  for (let ci = 0; ci < doc.components.length; ci++) {
    const g = varGroup(compVars[ci]);
    groupCompRefs[g].push({ compIdx: ci, off: varOff(compVars[ci]) });
  }
  for (let ti = 0; ti < doc.texts.length; ti++) {
    const g = varGroup(textVars[ti]);
    groupTextRefs[g].push({ textIdx: ti, off: varOff(textVars[ti]) });
  }
  const vtxGroupIdx: number[][] = [];
  for (let wi = 0; wi < doc.wires.length; wi++) {
    const arr: number[] = [];
    for (let k = 0; k < doc.wires[wi].points.length; k++) {
      const g = varGroup(vtxVars[wi][k]);
      arr.push(g);
      groupVtxRefs[g].push({ wireIdx: wi, ptIdx: k, off: varOff(vtxVars[wi][k]) });
    }
    vtxGroupIdx.push(arr);
  }

  // Component metadata for alignment / spacing exploitation
  const compInfos: CompGroupInfo[] = [];
  const compGroupSet = new Set<number>();
  for (let ci = 0; ci < doc.components.length; ci++) {
    const c = doc.components[ci];
    const b = compBoundsArr[ci];
    const g = varGroup(compVars[ci]);
    compGroupSet.add(g);
    compInfos.push({
      compIdx: ci,
      group: g,
      type: c.type,
      w: b.w,
      h: b.h,
      classKey: `${c.type}|${Math.round(b.w * 2)}x${Math.round(b.h * 2)}`,
      offLo: rectPLo(b) - groupOrig[g],
      offHi: rectPHi(b) - groupOrig[g],
      sLo: rectSLo(b),
      sHi: rectSHi(b),
    });
  }

  const feasibleInterval = (
    g: number,
    x: Float64Array,
    bMin: Float64Array,
    bMax: Float64Array,
  ): [number, number] => {
    if (g === anchorGroup) return [x[g], x[g]];
    let lo = bMin[g];
    let hi = bMax[g];
    const inc = revAdj[g];
    for (let i = 0; i < inc.length; i++) {
      const bound = x[inc[i].from] + inc[i].w;
      if (bound > lo) lo = bound;
    }
    const out = adj[g];
    for (let i = 0; i < out.length; i++) {
      const bound = x[out[i].to] - out[i].w;
      if (bound < hi) hi = bound;
    }
    return [lo, hi];
  };

  /** Snap same-type, same-size components into shared coordinates along `axis` within `[bMin, bMax]`. */
  const applyAlignmentSnap = (x: Float64Array, bMin: Float64Array, bMax: Float64Array): void => {
    const byClass = new Map<string, CompGroupInfo[]>();
    for (const info of compInfos) {
      const list = byClass.get(info.classKey);
      if (list) list.push(info);
      else byClass.set(info.classKey, [info]);
    }

    for (const list of byClass.values()) {
      if (list.length < 2) continue;
      const remaining = new Set<CompGroupInfo>(list);

      while (remaining.size >= 2) {
        const cands = new Set<number>();
        const intervals = new Map<CompGroupInfo, [number, number]>();
        for (const info of remaining) {
          const lo = bMin[info.group] + info.offLo;
          const hi = bMax[info.group] + info.offLo;
          intervals.set(info, [lo, hi]);
          cands.add(snapGrid(lo, grid));
          cands.add(snapGrid(hi, grid));
          cands.add(snapGrid(x[info.group] + info.offLo, grid));
        }

        let bestV = 0;
        let bestCluster: CompGroupInfo[] = [];
        let bestDist = Infinity;

        for (const v of cands) {
          const hit: CompGroupInfo[] = [];
          let dist = 0;
          for (const info of remaining) {
            const [lo, hi] = intervals.get(info)!;
            if (v >= lo - EPS && v <= hi + EPS) {
              hit.push(info);
              dist += Math.abs(x[info.group] + info.offLo - v);
            }
          }
          if (
            hit.length > bestCluster.length ||
            (hit.length === bestCluster.length &&
              (dist < bestDist - EPS || (Math.abs(dist - bestDist) <= EPS && v < bestV)))
          ) {
            bestCluster = hit;
            bestV = v;
            bestDist = dist;
          }
        }

        if (bestCluster.length < 2) break;

        // Sweep in both directions so coupled groups can slide toward `bestV`
        const sortedAsc = [...bestCluster].sort((a, b) => x[a.group] - x[b.group]);
        const sortedDesc = [...sortedAsc].reverse();
        for (const pass of [sortedDesc, sortedAsc]) {
          for (const info of pass) {
            const g = info.group;
            const target = normZero(snapGrid(bestV - info.offLo, grid));
            const [lo, hi] = feasibleInterval(g, x, bMin, bMax);
            if (target >= lo - EPS && target <= hi + EPS) {
              x[g] = normZero(Math.max(lo, Math.min(hi, target)));
            }
          }
        }
        for (const info of bestCluster) remaining.delete(info);
      }
    }
  };

  /** Equalise consecutive gaps in same-type rows/columns along `axis` within `[bMin, bMax]`. */
  const applySpacingEqualize = (x: Float64Array, bMin: Float64Array, bMax: Float64Array): void => {
    const byLine = new Map<string, CompGroupInfo[]>();
    for (const info of compInfos) {
      const lk = `${info.classKey}@${Math.round(info.sLo * 2)}`;
      const list = byLine.get(lk);
      if (list) list.push(info);
      else byLine.set(lk, [info]);
    }

    for (const line of byLine.values()) {
      if (line.length < 3) continue;
      line.sort((a, b) => (x[a.group] + a.offLo) - (x[b.group] + b.offLo));
      const m = line.length;
      const first = line[0];
      const last = line[m - 1];
      const p0 = x[first.group] + first.offLo;
      const pLast = x[last.group] + last.offLo;
      const compSize = first.offHi - first.offLo;
      const minPitch = ceilGrid(compSize + compGapPx, grid);
      const rawPitch = (pLast - p0) / (m - 1);
      const pitchCands = [
        Math.max(minPitch, floorGrid(rawPitch, grid)),
        Math.max(minPitch, ceilGrid(rawPitch, grid)),
        minPitch,
      ];

      let appliedUniform = false;
      for (const pitch of pitchCands) {
        let startLo = -Infinity;
        let startHi = Infinity;
        for (let k = 0; k < m; k++) {
          const info = line[k];
          const lo = bMin[info.group] + info.offLo - k * pitch;
          const hi = bMax[info.group] + info.offLo - k * pitch;
          if (lo > startLo) startLo = lo;
          if (hi < startHi) startHi = hi;
        }
        if (startLo > startHi + EPS) continue;
        const start = Math.max(ceilGrid(startLo, grid), Math.min(floorGrid(startHi, grid), snapGrid(p0, grid)));
        if (start < startLo - EPS || start > startHi + EPS) continue;

        const saved = new Float64Array(x);
        let allHit = true;
        // Two sweeps (right-to-left then left-to-right) let chains shift cleanly
        for (const dir of [-1, 1]) {
          for (let idx = dir < 0 ? m - 1 : 0; dir < 0 ? idx >= 0 : idx < m; idx += dir) {
            const info = line[idx];
            const target = normZero(start + idx * pitch - info.offLo);
            const [lo, hi] = feasibleInterval(info.group, x, bMin, bMax);
            x[info.group] = normZero(Math.max(lo, Math.min(hi, target)));
          }
        }
        for (let k = 0; k < m; k++) {
          const info = line[k];
          if (Math.abs((x[info.group] + info.offLo) - (start + k * pitch)) > EPS) {
            allHit = false;
            break;
          }
        }
        if (allHit) {
          appliedUniform = true;
          break;
        }
        x.set(saved);
      }

      if (!appliedUniform) {
        // Fallback: relax interior components toward midpoints of their immediate neighbors
        for (let iter = 0; iter < 3; iter++) {
          for (let k = 1; k < m - 1; k++) {
            const prev = line[k - 1];
            const cur = line[k];
            const next = line[k + 1];
            const mid = snapGrid(((x[prev.group] + prev.offLo) + (x[next.group] + next.offLo)) / 2, grid);
            const target = normZero(mid - cur.offLo);
            const [lo, hi] = feasibleInterval(cur.group, x, bMin, bMax);
            if (lo <= hi) x[cur.group] = normZero(Math.max(lo, Math.min(hi, target)));
          }
        }
      }
    }
  };

  const solvePartial = (strategy: SlackStrategy): Float64Array => {
    const anchorOrig = groupOrig[anchorGroup];
    const subCenter = Number.isFinite(origSubMin) ? (origSubMin + origSubMax) / 2 : (origDocMin + origDocMax) / 2;

    let dMinSubMax = -Infinity;
    let dMaxSubMin = Infinity;
    for (let g = 0; g < numGroups; g++) {
      if (Number.isFinite(groupSubRightExt[g])) {
        dMinSubMax = Math.max(dMinSubMax, dMin[g] + groupSubRightExt[g]);
      }
      if (Number.isFinite(groupSubLeftExt[g])) {
        dMaxSubMin = Math.min(dMaxSubMin, dMax[g] + groupSubLeftExt[g]);
      }
    }

    const initSqueezeLR = new Float64Array(numGroups);
    const initSqueezeRL = new Float64Array(numGroups);
    for (let g = 0; g < numGroups; g++) {
      if (g === anchorGroup) {
        initSqueezeLR[g] = anchorOrig;
        initSqueezeRL[g] = anchorOrig;
      } else {
        const ceilFromMin = Number.isFinite(groupSubRightExt[g]) && Number.isFinite(dMinSubMax)
          ? floorGrid(dMinSubMax - groupSubRightExt[g], grid)
          : dMax[g];
        initSqueezeLR[g] = Math.max(dMin[g], Math.min(dMax[g], ceilFromMin));

        const floorFromMax = Number.isFinite(groupSubLeftExt[g]) && Number.isFinite(dMaxSubMin)
          ? ceilGrid(dMaxSubMin - groupSubLeftExt[g], grid)
          : dMin[g];
        initSqueezeRL[g] = Math.min(dMax[g], Math.max(dMin[g], floorFromMax));
      }
    }
    const sLR = spfaBackward(numGroups, initSqueezeLR, revAdj, orderDesc);
    const sRL = spfaForward(numGroups, initSqueezeRL, adj, orderAsc);

    const candidates: Float64Array[] = [];
    const seeds: (Float64Array | null)[] = [sLR, sRL, dMin, dMax, groupOrig];
    for (const seed of seeds) {
      if (!seed || seed[anchorGroup] !== anchorOrig) continue;
      let ok = true;
      for (let g = 0; g < numGroups; g++) {
        if (seed[g] < dMin[g] || seed[g] > dMax[g]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      let seedSubLo = Infinity;
      let seedSubHi = -Infinity;
      for (let g = 0; g < numGroups; g++) {
        if (Number.isFinite(groupSubLeftExt[g])) {
          seedSubLo = Math.min(seedSubLo, seed[g] + groupSubLeftExt[g]);
          seedSubHi = Math.max(seedSubHi, seed[g] + groupSubRightExt[g]);
        }
      }
      const rLo = new Float64Array(dMin);
      const rHi = new Float64Array(dMax);
      if (Number.isFinite(seedSubLo)) {
        for (let g = 0; g < numGroups; g++) {
          if (g === anchorGroup || !Number.isFinite(groupSubLeftExt[g])) continue;
          const bLo = ceilGrid(seedSubLo - groupSubLeftExt[g], grid);
          const bHi = floorGrid(seedSubHi - groupSubRightExt[g], grid);
          if (bLo <= seed[g] && bLo > rLo[g]) rLo[g] = bLo;
          if (bHi >= seed[g] && bHi < rHi[g]) rHi[g] = bHi;
        }
      }

      if (strategy === "min" || strategy === "max") {
        candidates.push(new Float64Array(seed));
      } else {
        const mode = strategy === "align" ? "median" : strategy;
        const relaxed = relaxSlack(
          seed,
          rLo,
          rHi,
          adj,
          revAdj,
          wirePulls,
          groupLeftExt,
          groupRightExt,
          groupOrig,
          subCenter,
          grid,
          anchorGroup,
          mode,
        );
        if (strategy === "align") {
          applyAlignmentSnap(relaxed, rLo, rHi);
          applySpacingEqualize(relaxed, rLo, rHi);
        }
        candidates.push(relaxed);
      }
    }
    if (candidates.length === 0) return new Float64Array(groupOrig);

    const scoreCandidate = (x: Float64Array) => {
      let dLo = Infinity;
      let dHi = -Infinity;
      let sLo = Infinity;
      let sHi = -Infinity;
      for (let g = 0; g < numGroups; g++) {
        dLo = Math.min(dLo, x[g] + groupLeftExt[g]);
        dHi = Math.max(dHi, x[g] + groupRightExt[g]);
        if (Number.isFinite(groupSubLeftExt[g])) {
          sLo = Math.min(sLo, x[g] + groupSubLeftExt[g]);
          sHi = Math.max(sHi, x[g] + groupSubRightExt[g]);
        }
      }
      const docSpan = dHi - dLo;
      const subSpan = Number.isFinite(sLo) ? sHi - sLo : docSpan;
      const wl = evalWireLength(x, wirePulls);
      return { docSpan, subSpan, wl };
    };

    let best = candidates[0];
    let bestScore = scoreCandidate(best);
    for (let i = 1; i < candidates.length; i++) {
      const sc = scoreCandidate(candidates[i]);
      const better =
        sc.subSpan < bestScore.subSpan - EPS ||
        (Math.abs(sc.subSpan - bestScore.subSpan) <= EPS &&
          (sc.docSpan < bestScore.docSpan - EPS ||
            (Math.abs(sc.docSpan - bestScore.docSpan) <= EPS && sc.wl < bestScore.wl - EPS)));
      if (better) {
        best = candidates[i];
        bestScore = sc;
      }
    }
    return best;
  };

  const solveStrategy = (strategy: SlackStrategy): Float64Array => {
    if (anchorGroup >= 0) return solvePartial(strategy);

    if (strategy === "min") return new Float64Array(dMin);
    if (strategy === "max") return new Float64Array(dMax);

    const centroid = (origDocMin + minSpanMax) / 2;
    const mode = strategy === "align" ? "median" : strategy;
    const xA = relaxSlack(
      dMin,
      dMin,
      dMax,
      adj,
      revAdj,
      wirePulls,
      groupLeftExt,
      groupRightExt,
      groupOrig,
      centroid,
      grid,
      -1,
      mode,
    );
    const xB = relaxSlack(
      dMax,
      dMin,
      dMax,
      adj,
      revAdj,
      wirePulls,
      groupLeftExt,
      groupRightExt,
      groupOrig,
      centroid,
      grid,
      -1,
      mode,
    );
    const chosen = evalWireLength(xB, wirePulls) < evalWireLength(xA, wirePulls) ? xB : xA;
    if (strategy === "align") {
      applyAlignmentSnap(chosen, dMin, dMax);
      applySpacingEqualize(chosen, dMin, dMax);
    }
    return chosen;
  };

  const setGroupCoord = (targetDoc: SchematicDocument, g: number, val: number): void => {
    const comps = groupCompRefs[g];
    for (let i = 0; i < comps.length; i++) {
      const r = comps[i];
      const v = normZero(val + r.off);
      if (isX) targetDoc.components[r.compIdx].x = v;
      else targetDoc.components[r.compIdx].y = v;
    }
    const texts = groupTextRefs[g];
    for (let i = 0; i < texts.length; i++) {
      const r = texts[i];
      const v = normZero(val + r.off);
      if (isX) targetDoc.texts[r.textIdx].x = v;
      else targetDoc.texts[r.textIdx].y = v;
    }
    const vtxs = groupVtxRefs[g];
    for (let i = 0; i < vtxs.length; i++) {
      const r = vtxs[i];
      const v = normZero(val + r.off);
      if (isX) targetDoc.wires[r.wireIdx].points[r.ptIdx].x = v;
      else targetDoc.wires[r.wireIdx].points[r.ptIdx].y = v;
    }
  };

  const applyTo = (targetDoc: SchematicDocument, sol: Float64Array): void => {
    for (let g = 0; g < numGroups; g++) setGroupCoord(targetDoc, g, sol[g]);
  };

  const materialize = (sol: Float64Array): SchematicDocument => {
    const out = structuredClone(doc);
    applyTo(out, sol);
    return out;
  };

  const groupsAffectingEvents = (targetDoc: SchematicDocument, events: readonly Point[]): Set<number> => {
    const out = new Set<number>();
    if (events.length === 0) return out;
    const byP = new Map<number, number[]>();
    const ptKeys = new Set<string>();
    for (const e of events) {
      ptKeys.add(`${e.x},${e.y}`);
      const p = isX ? e.x : e.y;
      const s = isX ? e.y : e.x;
      const list = byP.get(p);
      if (list) list.push(s);
      else byP.set(p, [s]);
    }
    for (let wi = 0; wi < targetDoc.wires.length; wi++) {
      const pts = targetDoc.wires[wi].points;
      for (let k = 0; k < pts.length; k++) {
        const pt = pts[k];
        if (ptKeys.has(`${pt.x},${pt.y}`)) {
          out.add(vtxGroupIdx[wi][k]);
        }
        if (k + 1 < pts.length) {
          const q = pts[k + 1];
          const pa = isX ? pt.x : pt.y;
          const pb = isX ? q.x : q.y;
          if (pa === pb) {
            const evS = byP.get(pa);
            if (evS) {
              const sLo = Math.min(isX ? pt.y : pt.x, isX ? q.y : q.x);
              const sHi = Math.max(isX ? pt.y : pt.x, isX ? q.y : q.x);
              for (let j = 0; j < evS.length; j++) {
                if (evS[j] >= sLo && evS[j] <= sHi) {
                  out.add(vtxGroupIdx[wi][k]);
                  break;
                }
              }
            }
          }
        }
      }
    }
    return out;
  };

  const solveWithExtraEdges = (
    extraEdges: readonly { from: number; to: number; w: number }[],
    seed?: Float64Array,
  ): Float64Array | null => {
    if (extraEdges.length === 0) return seed ? new Float64Array(seed) : new Float64Array(dMin);
    const augAdj: { to: number; w: number }[][] = adj.map((edges) => edges.slice());
    for (const e of extraEdges) {
      if (e.from !== e.to && e.from >= 0 && e.to >= 0 && e.from < numGroups && e.to < numGroups) {
        augAdj[e.from].push({ to: e.to, w: e.w });
      }
    }
    const init = seed ? new Float64Array(seed) : new Float64Array(dMin);
    const sol = spfaForward(numGroups, init, augAdj, orderAsc);
    if (!sol) return null;
    if (anchorGroup >= 0 && sol[anchorGroup] !== groupOrig[anchorGroup]) return null;
    return sol;
  };

  return {
    axis,
    grid,
    compGapPx,
    numGroups,
    anchorGroup,
    groupOrig,
    groupLeftExt,
    groupRightExt,
    groupSubLeftExt,
    groupSubRightExt,
    origDocMin,
    origDocMax,
    adj,
    revAdj,
    dMin,
    dMax,
    wideMin,
    wideMax,
    compInfos,
    compGroupSet,
    feasibleInterval,
    solveStrategy,
    setGroupCoord,
    applyTo,
    materialize,
    groupsAffectingEvents,
    solveWithExtraEdges,
  };
}

/**
 * Perform one 1-D compaction pass along `axis` ("x" or "y"), returning a new SchematicDocument.
 * Never mutates the input `doc`.
 */
export function compact1D(
  doc: SchematicDocument,
  axis: Axis,
  opts: Required<Pick<PackOptions, "componentGap" | "wireGap">> & { ids?: ReadonlySet<string> },
  strategy: SlackStrategy = "median",
): SchematicDocument {
  const model = buildCompactionModel(doc, axis, opts);
  if (!model) return structuredClone(doc);
  return model.materialize(model.solveStrategy(strategy));
}

/**
 * Pull groups with positive slack toward a strategy-specific target:
 *  - `"median"`: median of connected wire neighbors (or schematic centroid if unconnected)
 *  - `"centroid"`: schematic centroid (blended with neighbor mean)
 *  - `"keep"`: original coordinate `groupOrig[g]`
 * stays strictly within `[dMin, dMax]` and obeys all difference constraints.
 */
function relaxSlack(
  seed: Float64Array,
  dMin: Float64Array,
  dMax: Float64Array,
  adj: { to: number; w: number }[][],
  revAdj: { from: number; w: number }[][],
  wirePulls: readonly WirePullEdge[],
  groupLeftExt: Float64Array,
  groupRightExt: Float64Array,
  groupOrig: Float64Array,
  centroid: number,
  grid: number,
  anchorGroup: number,
  mode: "median" | "centroid" | "keep",
): Float64Array {
  const n = seed.length;
  const x = new Float64Array(seed);

  // Precompute per-group wire pull neighbors
  const pullNeighbors: { other: number; shift: number }[][] = Array.from({ length: n }, () => []);
  for (const e of wirePulls) {
    pullNeighbors[e.gU].push({ other: e.gV, shift: e.offV - e.offU });
    pullNeighbors[e.gV].push({ other: e.gU, shift: e.offU - e.offV });
  }

  const slackGroups: number[] = [];
  for (let g = 0; g < n; g++) {
    if (g !== anchorGroup && dMax[g] > dMin[g]) slackGroups.push(g);
  }
  if (slackGroups.length === 0) return x;

  const targets: number[] = [];
  const relaxOne = (g: number) => {
    let lo = dMin[g];
    let hi = dMax[g];
    const inc = revAdj[g];
    for (let i = 0; i < inc.length; i++) {
      const bound = x[inc[i].from] + inc[i].w;
      if (bound > lo) lo = bound;
    }
    const out = adj[g];
    for (let i = 0; i < out.length; i++) {
      const bound = x[out[i].to] - out[i].w;
      if (bound < hi) hi = bound;
    }
    if (lo >= hi) return;

    let ideal: number;
    if (mode === "keep") {
      ideal = groupOrig[g];
    } else if (mode === "centroid") {
      const halfSpan = (groupLeftExt[g] + groupRightExt[g]) / 2;
      const centTarget = centroid - halfSpan;
      const nbrs = pullNeighbors[g];
      if (nbrs.length > 0) {
        let sum = 0;
        for (let i = 0; i < nbrs.length; i++) sum += x[nbrs[i].other] + nbrs[i].shift;
        ideal = (centTarget + sum / nbrs.length) / 2;
      } else {
        ideal = centTarget;
      }
    } else {
      const nbrs = pullNeighbors[g];
      if (nbrs.length > 0) {
        targets.length = 0;
        for (let i = 0; i < nbrs.length; i++) {
          targets.push(x[nbrs[i].other] + nbrs[i].shift);
        }
        ideal = medianOf(targets);
      } else {
        // Unconnected component or text note: pull toward schematic centroid
        const halfSpan = (groupLeftExt[g] + groupRightExt[g]) / 2;
        ideal = centroid - halfSpan;
      }
    }

    const snapped = snapGrid(ideal, grid);
    const clamped = Math.max(lo, Math.min(hi, snapped));
    x[g] = normZero(clamped);
  };

  for (let iter = 0; iter < 4; iter++) {
    // Right-to-left sweep lets slack clusters slide right together
    slackGroups.sort((a, b) => x[b] - x[a]);
    for (let i = 0; i < slackGroups.length; i++) relaxOne(slackGroups[i]);
    // Left-to-right sweep lets slack clusters slide left together
    slackGroups.sort((a, b) => x[a] - x[b]);
    for (let i = 0; i < slackGroups.length; i++) relaxOne(slackGroups[i]);
  }

  return x;
}

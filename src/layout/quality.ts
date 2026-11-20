/**
 * Weighted visual quality objective for DigiSchem schematic layout packing.
 *
 * Lower `total` is better. Hard visual defects (collinear wire overlaps between
 * different wires and component body collisions / componentGap violations) incur
 * `+Infinity` so invalid candidates are always rejected. Soft visual terms balance
 * readability (plain crossings, junctions, superlinear local clutter density),
 * visual structure (same-type/same-size alignment and regular spacing), and
 * compactness (normalised bounding-box area).
 */
import type { Point, SchematicDocument } from "../model/types";
import { GRID } from "../model/component-def";
import { componentBounds, documentBounds, junctionPoints, worldPins, type Rect } from "../model/geometry";

const EPS = 1e-6;

function normZero(v: number): number {
  return v === 0 ? 0 : v;
}

/** Per-term weighted cost breakdown of a schematic layout (lower `total` is better). */
export interface QualityBreakdown {
  /** Weak compactness term: (documentArea / grid²) * areaWeight. */
  area: number;
  /** Plain orthogonal wire crossing penalty (>= 0). */
  crossings: number;
  /** Collinear wire-segment overlap penalty between different wires (0 or +Infinity by default). */
  overlaps: number;
  /** Component body collision / componentGap violation penalty (0 or +Infinity by default). */
  componentCollisions: number;
  /** Junction dot penalty (>= 0, strictly lower per event than crossings). */
  junctions: number;
  /** Superlinear local density penalty over (crossings ∪ junctions) (>= 0). */
  clutter: number;
  /** Alignment reward (<= 0) for same-type, same-size components sharing a row or column. */
  alignment: number;
  /** Spacing term for same-type rows/columns: negative for equal consecutive gaps, positive for uneven gaps. */
  spacing: number;
  /** Sum of all terms (`+Infinity` if any infinite defect is present). */
  total: number;
}

/** Tunable weights and parameters for `layoutQuality`. */
export interface QualityWeights {
  /** Cost per collinear overlap between two DIFFERENT wires (default: `Infinity`). */
  overlap?: number;
  /** Cost per component collision or `componentGap` violation (default: `Infinity`). */
  componentCollision?: number;
  /** Mild penalty per plain orthogonal wire crossing (default: `12`). */
  crossing?: number;
  /** Penalty per junction dot — strictly lower than `crossing` (default: `5`). */
  junction?: number;
  /** Weight multiplying the superlinear pairwise clutter density (default: `8`). */
  clutter?: number;
  /** Neighborhood radius in grid cells within which event pairs contribute to clutter (default: `5`). */
  clutterRadius?: number;
  /** Reward (negated in `alignment`) per aligned pair of same-type, same-size components (default: `6`). */
  alignment?: number;
  /** Reward (negated in `spacing`) per equal consecutive gap pair in a same-type row/column (default: `4`). */
  spacingEqual?: number;
  /** Penalty per grid cell of gap standard deviation in a same-type row/column (default: `1`). */
  spacingUneven?: number;
  /** Weak compactness weight per grid² of document bounding-box area (default: `0.05`). */
  area?: number;
  /** Minimum clearance in grid cells between non-abutting component bodies (default: `2`). */
  componentGap?: number;
}

/**
 * Default quality weights.
 *
 * Satisfies:
 *   overlap = componentCollision = Infinity > crossing (12) > junction (5) > 0
 *   clutter is strictly superlinear in local event density (pairwise quadratic decay within R = 5 cells)
 *   area weight (0.05 / grid²) keeps layouts compact while letting visual quality win over the last few percent of area.
 */
export const DEFAULT_QUALITY_WEIGHTS: Readonly<Required<QualityWeights>> = Object.freeze({
  overlap: Infinity,
  componentCollision: Infinity,
  crossing: 12,
  junction: 5,
  clutter: 8,
  clutterRadius: 5,
  alignment: 6,
  spacingEqual: 4,
  spacingUneven: 1,
  area: 0.05,
  componentGap: 2,
});

interface HSeg {
  wireIdx: number;
  y: number;
  lo: number;
  hi: number;
}

interface VSeg {
  wireIdx: number;
  x: number;
  lo: number;
  hi: number;
}

function extractSegments(doc: SchematicDocument): { hSegs: HSeg[]; vSegs: VSeg[] } {
  const hSegs: HSeg[] = [];
  const vSegs: VSeg[] = [];
  for (let wi = 0; wi < doc.wires.length; wi++) {
    const pts = doc.wires[wi].points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.x === b.x && a.y === b.y) continue;
      if (a.y === b.y) {
        hSegs.push({ wireIdx: wi, y: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      } else if (a.x === b.x) {
        vSegs.push({ wireIdx: wi, x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
      }
    }
  }
  return { hSegs, vSegs };
}

/** Count collinear overlapping segment stretches between DIFFERENT wires. */
function countWireOverlaps(hSegs: readonly HSeg[], vSegs: readonly VSeg[]): number {
  let count = 0;

  const byRow = new Map<number, HSeg[]>();
  for (const s of hSegs) {
    const arr = byRow.get(s.y);
    if (arr) arr.push(s);
    else byRow.set(s.y, [s]);
  }
  for (const list of byRow.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.lo >= a.hi) break;
        if (a.wireIdx !== b.wireIdx) count++;
      }
    }
  }

  const byCol = new Map<number, VSeg[]>();
  for (const s of vSegs) {
    const arr = byCol.get(s.x);
    if (arr) arr.push(s);
    else byCol.set(s.x, [s]);
  }
  for (const list of byCol.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.lo >= a.hi) break;
        if (a.wireIdx !== b.wireIdx) count++;
      }
    }
  }

  return count;
}

/** Find all plain orthogonal wire crossing points (strictly interior to both segments, excluding junctions). */
function findPlainCrossings(
  hSegs: readonly HSeg[],
  vSegs: readonly VSeg[],
  junctionKeys: ReadonlySet<string>,
): Point[] {
  if (hSegs.length === 0 || vSegs.length === 0) return [];
  const vSorted = [...vSegs].sort((a, b) => a.x - b.x || a.lo - b.lo);
  const crossings: Point[] = [];

  for (const h of hSegs) {
    let lo = 0;
    let hi = vSorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vSorted[mid].x <= h.lo) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < vSorted.length && vSorted[i].x < h.hi; i++) {
      const v = vSorted[i];
      if (v.lo < h.y && h.y < v.hi) {
        if (!junctionKeys.has(`${v.x},${h.y}`)) {
          crossings.push({ x: v.x, y: h.y });
        }
      }
    }
  }
  return crossings;
}

/** Extract all crossing points and junction points (visual "events") of a schematic. */
export function extractVisualEvents(doc: SchematicDocument): {
  crossings: Point[];
  junctions: Point[];
  events: Point[];
} {
  const { hSegs, vSegs } = extractSegments(doc);
  const junctions = junctionPoints(doc);
  const junctionKeys = new Set<string>(junctions.map((p) => `${p.x},${p.y}`));
  const crossings = findPlainCrossings(hSegs, vSegs, junctionKeys);
  return { crossings, junctions, events: [...crossings, ...junctions] };
}

/**
 * Superlinear clutter / density measure over visual events (crossings ∪ junction points).
 *
 * For every unordered pair of events separated by Euclidean distance `d < radiusCells`
 * (measured in grid cells), adds `(1 - d / radiusCells)²`. Because a cluster of `m` events
 * within radius `R` generates `m*(m-1)/2` interacting pairs, dense clusters incur a strictly
 * superlinear (quadratic) penalty compared to the same number of events spread apart.
 */
export function computeEventClutter(
  events: readonly Point[],
  grid: number,
  radiusCells: number,
): number {
  const n = events.length;
  if (n < 2 || radiusCells <= 0) return 0;

  const sorted = [...events].sort((a, b) => a.x - b.x || a.y - b.y);
  const rPx = radiusCells * grid;
  const r2 = rPx * rPx;
  let total = 0;

  for (let i = 0; i < n; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < n; j++) {
      const b = sorted[j];
      const dx = b.x - a.x;
      if (dx >= rPx) break;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const dCells = Math.sqrt(d2) / grid;
      const t = 1 - dCells / radiusCells;
      total += t * t;
    }
  }
  return normZero(total);
}

/** L-infinity separation between two rectangles (>0 disjoint, 0 touching, <0 overlapping). */
function rectSeparation(a: Rect, b: Rect): number {
  const sepX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const sepY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(sepX, sepY);
}

/** Count component body collisions or componentGap violations (exempting clean pin-to-pin abutment). */
function countComponentCollisions(
  doc: SchematicDocument,
  bounds: readonly Rect[],
  compGapPx: number,
): number {
  const n = doc.components.length;
  if (n < 2) return 0;

  // Identify direct pin-to-pin abutting component pairs
  const pinOwners = new Map<string, number[]>();
  const abutting = new Set<string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let i = 0; i < n; i++) {
    for (const wp of worldPins(doc.components[i])) {
      const k = `${wp.pos.x},${wp.pos.y}`;
      const list = pinOwners.get(k);
      if (list) {
        for (const prev of list) {
          if (prev !== i) abutting.add(pairKey(prev, i));
        }
        list.push(i);
      } else {
        pinOwners.set(k, [i]);
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => bounds[a].x - bounds[b].x || bounds[a].y - bounds[b].y,
  );

  let collisions = 0;
  for (let ii = 0; ii < n; ii++) {
    const i = order[ii];
    const bi = bounds[i];
    const maxX = bi.x + bi.w + compGapPx + EPS;
    for (let jj = ii + 1; jj < n; jj++) {
      const j = order[jj];
      const bj = bounds[j];
      if (bj.x >= maxX) break;
      const sep = rectSeparation(bi, bj);
      if (sep < -EPS) {
        // Interior overlap is always a collision, even if pins coincide
        collisions++;
      } else if (compGapPx > 0 && sep < compGapPx - EPS) {
        if (!abutting.has(pairKey(i, j))) collisions++;
      }
    }
  }
  return collisions;
}

/**
 * Evaluate alignment and regular spacing across same-type, same-size component groups.
 *
 * Components are grouped by `(type, bounds.w, bounds.h)`. Within each group:
 * - Every unordered pair sharing a row (`top` / `centerY` coincide) or column (`left` / `centerX`
 *   coincide) adds 1 to `alignedPairs`.
 * - For each row or column of >= 3 components, consecutive edge-to-edge gaps (in grid cells)
 *   are measured: each equal consecutive pair adds 1 to `equalGapPairs`, and the gap standard
 *   deviation `sqrt(Var(gaps))` is accumulated into `unevenGapStdDev`.
 */
function computeAlignmentAndSpacing(
  doc: SchematicDocument,
  bounds: readonly Rect[],
  grid: number,
): { alignedPairs: number; equalGapPairs: number; unevenGapStdDev: number } {
  const byClass = new Map<string, Rect[]>();
  for (let i = 0; i < doc.components.length; i++) {
    const c = doc.components[i];
    const b = bounds[i];
    const key = `${c.type}|${Math.round(b.w * 2)}x${Math.round(b.h * 2)}`;
    const arr = byClass.get(key);
    if (arr) arr.push(b);
    else byClass.set(key, [b]);
  }

  let alignedPairs = 0;
  let equalGapPairs = 0;
  let unevenGapStdDev = 0;

  const evalLine = (rects: Rect[], alongX: boolean) => {
    const m = rects.length;
    if (m < 2) return;
    alignedPairs += (m * (m - 1)) / 2;
    if (m < 3) return;

    rects.sort((a, b) => (alongX ? a.x - b.x : a.y - b.y));
    const gaps: number[] = [];
    for (let i = 0; i + 1 < m; i++) {
      const a = rects[i];
      const b = rects[i + 1];
      const gapPx = alongX ? b.x - (a.x + a.w) : b.y - (a.y + a.h);
      gaps.push(gapPx / grid);
    }

    let mean = 0;
    for (let i = 0; i < gaps.length; i++) {
      mean += gaps[i];
      if (i + 1 < gaps.length && Math.abs(gaps[i + 1] - gaps[i]) < EPS) {
        equalGapPairs++;
      }
    }
    mean /= gaps.length;

    let varSum = 0;
    for (let i = 0; i < gaps.length; i++) {
      const d = gaps[i] - mean;
      varSum += d * d;
    }
    unevenGapStdDev += Math.sqrt(varSum / gaps.length);
  };

  for (const list of byClass.values()) {
    if (list.length < 2) continue;

    // Rows (same top edge === same centerY === same bottom edge for identical size)
    const rows = new Map<number, Rect[]>();
    // Columns (same left edge === same centerX === same right edge for identical size)
    const cols = new Map<number, Rect[]>();
    for (const b of list) {
      const rk = Math.round(b.y * 2);
      const ck = Math.round(b.x * 2);
      const rArr = rows.get(rk);
      if (rArr) rArr.push(b);
      else rows.set(rk, [b]);
      const cArr = cols.get(ck);
      if (cArr) cArr.push(b);
      else cols.set(ck, [b]);
    }

    for (const row of rows.values()) evalLine(row, true);
    for (const col of cols.values()) evalLine(col, false);
  }

  return { alignedPairs, equalGapPairs, unevenGapStdDev };
}

/**
 * Evaluate the weighted visual quality of a schematic document.
 * Lower `total` is better; hard defects (wire overlaps, component collisions) yield `+Infinity`.
 */
export function layoutQuality(doc: SchematicDocument, opts?: QualityWeights): QualityBreakdown {
  const w: Required<QualityWeights> = {
    overlap: opts?.overlap ?? DEFAULT_QUALITY_WEIGHTS.overlap,
    componentCollision: opts?.componentCollision ?? DEFAULT_QUALITY_WEIGHTS.componentCollision,
    crossing: opts?.crossing ?? DEFAULT_QUALITY_WEIGHTS.crossing,
    junction: opts?.junction ?? DEFAULT_QUALITY_WEIGHTS.junction,
    clutter: opts?.clutter ?? DEFAULT_QUALITY_WEIGHTS.clutter,
    clutterRadius: opts?.clutterRadius ?? DEFAULT_QUALITY_WEIGHTS.clutterRadius,
    alignment: opts?.alignment ?? DEFAULT_QUALITY_WEIGHTS.alignment,
    spacingEqual: opts?.spacingEqual ?? DEFAULT_QUALITY_WEIGHTS.spacingEqual,
    spacingUneven: opts?.spacingUneven ?? DEFAULT_QUALITY_WEIGHTS.spacingUneven,
    area: opts?.area ?? DEFAULT_QUALITY_WEIGHTS.area,
    componentGap: opts?.componentGap ?? DEFAULT_QUALITY_WEIGHTS.componentGap,
  };

  const grid = doc.grid || GRID;
  const compGapPx = w.componentGap * grid;

  const bounds = doc.components.map((c) => componentBounds(c));
  const { hSegs, vSegs } = extractSegments(doc);

  // 1. Hard defects (infinite penalty by default)
  const overlapCount = countWireOverlaps(hSegs, vSegs);
  const overlaps = overlapCount === 0 ? 0 : overlapCount * w.overlap;

  const collisionCount = countComponentCollisions(doc, bounds, compGapPx);
  const componentCollisions = collisionCount === 0 ? 0 : collisionCount * w.componentCollision;

  // 2. Junctions & plain orthogonal crossings
  const jPts = junctionPoints(doc);
  const junctionKeys = new Set<string>(jPts.map((p) => `${p.x},${p.y}`));
  const crossingPts = findPlainCrossings(hSegs, vSegs, junctionKeys);

  const crossings = normZero(crossingPts.length === 0 ? 0 : crossingPts.length * w.crossing);
  const junctions = normZero(jPts.length === 0 ? 0 : jPts.length * w.junction);

  // 3. Superlinear local density / clutter over crossings ∪ junctions
  const events: Point[] = [...crossingPts, ...jPts];
  const rawClutter = computeEventClutter(events, grid, w.clutterRadius);
  const clutter = normZero(rawClutter === 0 ? 0 : rawClutter * w.clutter);

  // 4. Alignment & regular spacing of same-type, same-size components
  const { alignedPairs, equalGapPairs, unevenGapStdDev } = computeAlignmentAndSpacing(doc, bounds, grid);
  const alignment = normZero(alignedPairs === 0 ? 0 : -alignedPairs * w.alignment);
  const spacing = normZero(-equalGapPairs * w.spacingEqual + unevenGapStdDev * w.spacingUneven);

  // 5. Weak normalised bounding-box area term
  const docB = documentBounds(doc);
  const areaGrid2 = docB ? (docB.w * docB.h) / (grid * grid) : 0;
  const area = normZero(areaGrid2 === 0 ? 0 : areaGrid2 * w.area);

  const total =
    overlaps === Infinity || componentCollisions === Infinity
      ? Infinity
      : normZero(overlaps + componentCollisions + crossings + junctions + clutter + alignment + spacing + area);

  return {
    area,
    crossings,
    overlaps,
    componentCollisions,
    junctions,
    clutter,
    alignment,
    spacing,
    total,
  };
}

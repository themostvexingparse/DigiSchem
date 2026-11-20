/**
 * Quality-driven schematic layout packer / compactor.
 *
 * Optimises the weighted visual quality objective (`layoutQuality`: infinite penalty on
 * wire overlaps & component collisions; crossing > junction; superlinear local clutter
 * density; same-type alignment & regular spacing rewards; weak normalised area) while
 * strictly preserving all 9 hard packing invariants (`validatePacking`).
 *
 * Algorithm overview:
 *  1. Precompute `ValidationBaseline` and `qualityBefore` once.
 *  2. Multi-start alternating 1-D compaction (`X-first` / `Y-first` across slack strategies
 *     `align`, `median`, `min`, `keep`, `centroid`), accepting only passes that strictly
 *     improve `layoutQuality.total` (with area/wirelength tie-breaking) and pass all rules 1–9.
 *  3. Quality-driven slack exploitation & local search on the best candidate (within
 *     `timeBudgetMs`, default 1500 ms):
 *       - Joint same-type alignment snaps (snapping components to the best common feasible edge).
 *       - Joint same-type row/column gap equalisation (uniform pitch search over feasible intervals).
 *       - Ascending + descending coordinate-descent sweeps moving individual groups within their
 *         exact dynamic feasible `[lo, hi]` interval (by ±k grid, alignment targets, midpoints,
 *         and clutter-spreading offsets) using zero-allocation in-place updates.
 *  4. Every accepted state is validated via `validateAgainstBaseline` against all rules 1–9.
 *     If `qualityAfter.total` does not strictly improve over `qualityBefore.total` (and no
 *     partial-pack subset area improvement occurred), returns an unmodified deep copy.
 */
import type { SchematicDocument } from "../model/types";
import { documentBounds } from "../model/geometry";
import {
  buildCompactionModel,
  totalWireLength,
  type Axis,
  type CompGroupInfo,
  type CompactionModel,
  type SlackStrategy,
} from "./compact1d";
import {
  DEFAULT_QUALITY_WEIGHTS,
  extractVisualEvents,
  layoutQuality,
  type QualityBreakdown,
  type QualityWeights,
} from "./quality";
import {
  documentArea,
  prepareValidationBaseline,
  subsetArea,
  validateAgainstBaseline,
  type ValidationBaseline,
} from "./validate";

export interface PackOptions {
  /** Minimum clearance in grid cells between component bodies (incl. pin legs) — default 2. */
  componentGap?: number;
  /** Minimum spacing in grid cells between parallel wire segments and between a wire and an unrelated body — default 1. */
  wireGap?: number;
  /** Optional: only pack these component/wire/text ids (default: whole document). Others are fixed obstacles. */
  ids?: ReadonlySet<string>;
  /** Max improvement passes per start schedule (default 8). */
  maxPasses?: number;
  /** Optional quality-weight overrides (`componentGap` defaults to `PackOptions.componentGap`). */
  qualityWeights?: QualityWeights;
  /** Soft wall-clock time budget in milliseconds for multi-start + local search (default 1500). */
  timeBudgetMs?: number;
}

export interface PackResult {
  doc: SchematicDocument;
  areaBefore: number;
  areaAfter: number;
  qualityBefore: QualityBreakdown;
  qualityAfter: QualityBreakdown;
  passes: number;
}

const EPS = 1e-6;
const DEFAULT_TIME_BUDGET_MS = 1500;

interface Metrics {
  quality: QualityBreakdown;
  primaryArea: number;
  docArea: number;
  perimeter: number;
  wireLen: number;
}

function measureMetrics(
  doc: SchematicDocument,
  qWeights: QualityWeights,
  ids?: ReadonlySet<string>,
): Metrics {
  const b = documentBounds(doc);
  const docA = b ? b.w * b.h : 0;
  const primaryArea = ids ? subsetArea(doc, ids) : docA;
  const perimeter = b ? b.w + b.h : 0;
  return {
    quality: layoutQuality(doc, qWeights),
    primaryArea,
    docArea: docA,
    perimeter,
    wireLen: totalWireLength(doc),
  };
}

/** True if candidate `a` is strictly better than `b` under quality.total (with geometric tie-breakers). */
function isStrictlyBetter(a: Metrics, b: Metrics): boolean {
  if (!Number.isFinite(a.quality.total)) return false;
  if (!Number.isFinite(b.quality.total)) return true;
  if (a.quality.total < b.quality.total - EPS) return true;
  if (a.quality.total > b.quality.total + EPS) return false;
  if (a.primaryArea < b.primaryArea - EPS) return true;
  if (a.primaryArea > b.primaryArea + EPS) return false;
  if (a.docArea < b.docArea - EPS) return true;
  if (a.docArea > b.docArea + EPS) return false;
  if (a.perimeter < b.perimeter - EPS) return true;
  if (a.perimeter > b.perimeter + EPS) return false;
  return a.wireLen < b.wireLen - EPS;
}

interface ScheduleOutcome {
  doc: SchematicDocument;
  metrics: Metrics;
  passes: number;
}

function normZero(v: number): number {
  return v === 0 ? 0 : v;
}

function snapGrid(v: number, grid: number): number {
  return normZero(Math.round(v / grid) * grid);
}

function ceilGrid(v: number, grid: number): number {
  return normZero(Math.ceil((v - EPS) / grid) * grid);
}

function floorGrid(v: number, grid: number): number {
  return normZero(Math.floor((v + EPS) / grid) * grid);
}

function runSchedule(
  input: SchematicDocument,
  baseline: ValidationBaseline,
  firstAxis: Axis,
  strategy: SlackStrategy,
  compOpts: { componentGap: number; wireGap: number; ids?: ReadonlySet<string> },
  qWeights: QualityWeights,
  maxPasses: number,
  deadline: number,
  minGuaranteedSteps: number,
): ScheduleOutcome {
  let current = structuredClone(input);
  let curMetrics = measureMetrics(current, qWeights, compOpts.ids);
  let bestDoc = current;
  let bestMetrics = curMetrics;
  let bestPasses = 0;
  let acceptedPasses = 0;
  let staleStreak = 0;

  for (let step = 0; step < maxPasses; step++) {
    if (step >= minGuaranteedSteps && performance.now() > deadline) break;

    const axis: Axis = step % 2 === 0 ? firstAxis : firstAxis === "x" ? "y" : "x";
    const model = buildCompactionModel(current, axis, compOpts);
    if (!model) {
      staleStreak += 1;
      if (staleStreak >= 2) break;
      continue;
    }

    const sol = model.solveStrategy(strategy);
    const candidate = model.materialize(sol);
    const candMetrics = measureMetrics(candidate, qWeights, compOpts.ids);

    // Must obey Rule 9 area bound against baseline and improve quality
    const areaWithinBaseline =
      candMetrics.docArea <= baseline.areaBefore + EPS &&
      (baseline.subsetAreaBefore === null || candMetrics.primaryArea <= baseline.subsetAreaBefore + EPS);

    if (areaWithinBaseline && isStrictlyBetter(candMetrics, curMetrics)) {
      const violations = validateAgainstBaseline(baseline, candidate);
      if (violations.length === 0) {
        current = candidate;
        curMetrics = candMetrics;
        acceptedPasses += 1;
        staleStreak = 0;
        if (isStrictlyBetter(curMetrics, bestMetrics)) {
          bestDoc = current;
          bestMetrics = curMetrics;
          bestPasses = acceptedPasses;
        }
        continue;
      }
    }

    staleStreak += 1;
    if (staleStreak >= 2) break;
  }

  return { doc: bestDoc, metrics: bestMetrics, passes: bestPasses };
}

/** Fast Rule-9 area guard during local search (avoids full validation on every trial move). */
function obeysAreaBaseline(doc: SchematicDocument, baseline: ValidationBaseline): boolean {
  if (documentArea(doc) > baseline.areaBefore + EPS) return false;
  if (baseline.ids && baseline.subsetAreaBefore !== null) {
    if (subsetArea(doc, baseline.ids) > baseline.subsetAreaBefore + EPS) return false;
  }
  return true;
}

/**
 * Joint same-type alignment snap on `workDoc` along `model.axis`.
 * Tries the top candidate coordinates covering the most same-type, same-size components
 * and commits any move that strictly improves `layoutQuality.total` while respecting Rule 9.
 */
function polishAlignmentSnap(
  model: CompactionModel,
  workDoc: SchematicDocument,
  x: Float64Array,
  bMin: Float64Array,
  bMax: Float64Array,
  baseline: ValidationBaseline,
  qWeights: QualityWeights,
  curQ: QualityBreakdown,
  deadline: number,
): QualityBreakdown {
  const { grid, compInfos } = model;
  const byClass = new Map<string, CompGroupInfo[]>();
  for (const info of compInfos) {
    const arr = byClass.get(info.classKey);
    if (arr) arr.push(info);
    else byClass.set(info.classKey, [info]);
  }

  let bestQ = curQ;
  for (const list of byClass.values()) {
    if (list.length < 2 || performance.now() > deadline) continue;

    // Collect candidate edge coordinates from interval endpoints and current edges
    const candSet = new Set<number>();
    for (const info of list) {
      candSet.add(snapGrid(x[info.group] + info.offLo, grid));
      candSet.add(snapGrid(bMin[info.group] + info.offLo, grid));
      candSet.add(snapGrid(bMax[info.group] + info.offLo, grid));
    }

    // Rank candidates by how many components in this class can feasibly reach them
    const ranked: { v: number; count: number; dist: number }[] = [];
    for (const v of candSet) {
      let count = 0;
      let dist = 0;
      for (const info of list) {
        const lo = bMin[info.group] + info.offLo;
        const hi = bMax[info.group] + info.offLo;
        if (v >= lo - EPS && v <= hi + EPS) {
          count++;
          dist += Math.abs(x[info.group] + info.offLo - v);
        }
      }
      if (count >= 2) ranked.push({ v, count, dist });
    }
    ranked.sort((a, b) => b.count - a.count || a.dist - b.dist || a.v - b.v);

    const limit = Math.min(4, ranked.length);
    for (let ci = 0; ci < limit; ci++) {
      if (performance.now() > deadline) break;
      const v = ranked[ci].v;
      const saved = new Float64Array(x);

      const eligible = list.filter((info) => {
        const lo = bMin[info.group] + info.offLo;
        const hi = bMax[info.group] + info.offLo;
        return v >= lo - EPS && v <= hi + EPS;
      });
      const asc = [...eligible].sort((a, b) => x[a.group] - x[b.group]);
      const desc = [...asc].reverse();
      let movedAny = false;
      for (const pass of [desc, asc]) {
        for (const info of pass) {
          const g = info.group;
          const target = normZero(snapGrid(v - info.offLo, grid));
          const [lo, hi] = model.feasibleInterval(g, x, bMin, bMax);
          if (target >= lo - EPS && target <= hi + EPS) {
            const clamped = normZero(Math.max(lo, Math.min(hi, target)));
            if (clamped !== x[g]) {
              x[g] = clamped;
              model.setGroupCoord(workDoc, g, clamped);
              movedAny = true;
            }
          }
        }
      }

      if (!movedAny) continue;
      if (obeysAreaBaseline(workDoc, baseline)) {
        const q = layoutQuality(workDoc, qWeights);
        if (Number.isFinite(q.total) && q.total < bestQ.total - EPS) {
          bestQ = q;
          continue;
        }
      }
      x.set(saved);
      model.applyTo(workDoc, x);
    }
  }
  return bestQ;
}

/**
 * Joint same-type row/column gap equalisation on `workDoc` along `model.axis`.
 * Searches uniform pitches across the feasible intervals of each same-type line (>= 3 items)
 * and commits any improvement to `layoutQuality.total` respecting Rule 9.
 */
function polishSpacingEqualize(
  model: CompactionModel,
  workDoc: SchematicDocument,
  x: Float64Array,
  bMin: Float64Array,
  bMax: Float64Array,
  baseline: ValidationBaseline,
  qWeights: QualityWeights,
  curQ: QualityBreakdown,
  deadline: number,
): QualityBreakdown {
  const { grid, compGapPx, compInfos } = model;
  const byLine = new Map<string, CompGroupInfo[]>();
  for (const info of compInfos) {
    const lk = `${info.classKey}@${Math.round(info.sLo * 2)}`;
    const arr = byLine.get(lk);
    if (arr) arr.push(info);
    else byLine.set(lk, [info]);
  }

  let bestQ = curQ;
  for (const line of byLine.values()) {
    if (line.length < 3 || performance.now() > deadline) continue;
    line.sort((a, b) => (x[a.group] + a.offLo) - (x[b.group] + b.offLo));
    const m = line.length;
    const compSize = line[0].offHi - line[0].offLo;
    const minPitch = ceilGrid(compSize + compGapPx, grid);
    const p0 = x[line[0].group] + line[0].offLo;
    const pLast = x[line[m - 1].group] + line[m - 1].offLo;
    const rawPitch = (pLast - p0) / (m - 1);

    const pitchSet = new Set<number>();
    const pFloor = Math.max(minPitch, floorGrid(rawPitch, grid));
    const pCeil = Math.max(minPitch, ceilGrid(rawPitch, grid));
    for (const p of [minPitch, pFloor - grid, pFloor, pCeil, pCeil + grid]) {
      if (p >= minPitch) pitchSet.add(p);
    }

    for (const pitch of pitchSet) {
      if (performance.now() > deadline) break;
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

      const sMin = ceilGrid(startLo, grid);
      const sMax = floorGrid(startHi, grid);
      if (sMin > sMax) continue;
      const sNear = Math.max(sMin, Math.min(sMax, snapGrid(p0, grid)));
      const starts = sNear === sMin ? [sMin] : [sMin, sNear];

      for (const start of starts) {
        const saved = new Float64Array(x);
        let movedAny = false;
        for (const dir of [-1, 1]) {
          for (let idx = dir < 0 ? m - 1 : 0; dir < 0 ? idx >= 0 : idx < m; idx += dir) {
            const info = line[idx];
            const target = normZero(start + idx * pitch - info.offLo);
            const [lo, hi] = model.feasibleInterval(info.group, x, bMin, bMax);
            const clamped = normZero(Math.max(lo, Math.min(hi, target)));
            if (clamped !== x[info.group]) {
              x[info.group] = clamped;
              model.setGroupCoord(workDoc, info.group, clamped);
              movedAny = true;
            }
          }
        }
        if (!movedAny) continue;
        if (obeysAreaBaseline(workDoc, baseline)) {
          const q = layoutQuality(workDoc, qWeights);
          if (Number.isFinite(q.total) && q.total < bestQ.total - EPS) {
            bestQ = q;
            continue;
          }
        }
        x.set(saved);
        model.applyTo(workDoc, x);
      }
    }
  }
  return bestQ;
}

/**
 * Single-group coordinate-descent local search along `model.axis`.
 * Moves individual groups within their dynamic feasible `[lo, hi]` interval across targeted
 * candidate offsets (±k grid, endpoints, midpoint, same-type alignment & spacing targets),
 * sweeping both descending and ascending so chained wires/components can open space together.
 */
function polishLocalSearch1D(
  model: CompactionModel,
  workDoc: SchematicDocument,
  x: Float64Array,
  bMin: Float64Array,
  bMax: Float64Array,
  baseline: ValidationBaseline,
  qWeights: QualityWeights,
  curQ: QualityBreakdown,
  deadline: number,
): QualityBreakdown {
  const { grid, numGroups, anchorGroup, compInfos, compGroupSet } = model;
  const { events } = extractVisualEvents(workDoc);
  const eventGroups = model.groupsAffectingEvents(workDoc, events);

  // Build quick lookup of component infos by group, class, and line
  const groupComps = new Map<number, CompGroupInfo[]>();
  const byClass = new Map<string, CompGroupInfo[]>();
  const byLine = new Map<string, CompGroupInfo[]>();
  for (const info of compInfos) {
    const gc = groupComps.get(info.group);
    if (gc) gc.push(info);
    else groupComps.set(info.group, [info]);
    const bc = byClass.get(info.classKey);
    if (bc) bc.push(info);
    else byClass.set(info.classKey, [info]);
    const lk = `${info.classKey}@${Math.round(info.sLo * 2)}`;
    const bl = byLine.get(lk);
    if (bl) bl.push(info);
    else byLine.set(lk, [info]);
  }

  // Collect slack groups; on huge schematics prioritize event-bearing & component groups first
  const priorityGroups: number[] = [];
  const otherGroups: number[] = [];
  for (let g = 0; g < numGroups; g++) {
    if (g === anchorGroup || bMax[g] <= bMin[g] + EPS) continue;
    if (eventGroups.has(g) || compGroupSet.has(g)) priorityGroups.push(g);
    else otherGroups.push(g);
  }
  const activeGroups =
    priorityGroups.length + otherGroups.length <= 160
      ? [...priorityGroups, ...otherGroups]
      : priorityGroups.slice(0, 160);
  if (activeGroups.length === 0) return curQ;

  let bestQ = curQ;
  const smallSteps = [-5, -3, -2, -1, 1, 2, 3, 5];
  const eventSteps = [-6, -4, 4, 6];

  for (let sweep = 0; sweep < 2; sweep++) {
    if (performance.now() > deadline) break;
    // Sweep 0: descending coordinate (lets packed chains expand right/down); Sweep 1: ascending
    activeGroups.sort((a, b) => (sweep === 0 ? x[b] - x[a] : x[a] - x[b]));

    for (let i = 0; i < activeGroups.length; i++) {
      if (performance.now() > deadline) break;
      const g = activeGroups[i];
      const [lo, hi] = model.feasibleInterval(g, x, bMin, bMax);
      if (lo >= hi - EPS) continue;

      const curVal = x[g];
      const cands = new Set<number>();
      const addCand = (raw: number) => {
        const s = normZero(snapGrid(raw, grid));
        if (s >= lo - EPS && s <= hi + EPS && s !== curVal) {
          cands.add(normZero(Math.max(lo, Math.min(hi, s))));
        }
      };

      // Interval landmarks + ±k grid neighborhood
      addCand(lo);
      addCand(hi);
      addCand((lo + hi) / 2);
      for (const k of smallSteps) addCand(curVal + k * grid);
      if (eventGroups.has(g)) {
        for (const k of eventSteps) addCand(curVal + k * grid);
      }

      // Same-type alignment targets and equal-spacing midpoints
      const myComps = groupComps.get(g);
      if (myComps) {
        for (const me of myComps) {
          const peers = byClass.get(me.classKey);
          if (peers && peers.length >= 2) {
            for (let p = 0; p < peers.length && p < 16; p++) {
              const other = peers[p];
              if (other.group === g) continue;
              addCand(x[other.group] + other.offLo - me.offLo);
            }
          }
          const line = byLine.get(`${me.classKey}@${Math.round(me.sLo * 2)}`);
          if (line && line.length >= 3) {
            const sorted = [...line].sort((a, b) => (x[a.group] + a.offLo) - (x[b.group] + b.offLo));
            const idx = sorted.indexOf(me);
            if (idx > 0 && idx < sorted.length - 1) {
              const prevPos = x[sorted[idx - 1].group] + sorted[idx - 1].offLo;
              const nextPos = x[sorted[idx + 1].group] + sorted[idx + 1].offLo;
              addCand((prevPos + nextPos) / 2 - me.offLo);
            }
            if (idx >= 2) {
              const p1 = x[sorted[idx - 2].group] + sorted[idx - 2].offLo;
              const p2 = x[sorted[idx - 1].group] + sorted[idx - 1].offLo;
              addCand(p2 + (p2 - p1) - me.offLo);
            }
            if (idx >= 0 && idx + 2 < sorted.length) {
              const p1 = x[sorted[idx + 1].group] + sorted[idx + 1].offLo;
              const p2 = x[sorted[idx + 2].group] + sorted[idx + 2].offLo;
              addCand(p1 - (p2 - p1) - me.offLo);
            }
          }
        }
      }

      let bestVal = curVal;
      let bestCandQ = bestQ;
      for (const v of cands) {
        model.setGroupCoord(workDoc, g, v);
        if (obeysAreaBaseline(workDoc, baseline)) {
          const q = layoutQuality(workDoc, qWeights);
          if (Number.isFinite(q.total) && q.total < bestCandQ.total - EPS) {
            bestVal = v;
            bestCandQ = q;
          }
        }
      }

      if (bestVal !== curVal) {
        x[g] = bestVal;
        model.setGroupCoord(workDoc, g, bestVal);
        bestQ = bestCandQ;
      } else {
        model.setGroupCoord(workDoc, g, curVal);
      }
    }
  }

  return bestQ;
}

/**
 * Joint clutter-spreading pass along `model.axis`.
 * When multiple crossing/junction events sit closer than `clutterRadius`, adds temporary
 * minimum-separation edges between adjacent event-bearing groups and runs forward SPFA so
 * downstream obstacles open the corridor together; commits only if `layoutQuality.total`
 * strictly improves while obeying Rule 9.
 */
function polishClutterSpread(
  model: CompactionModel,
  workDoc: SchematicDocument,
  x: Float64Array,
  baseline: ValidationBaseline,
  qWeights: QualityWeights,
  curQ: QualityBreakdown,
  deadline: number,
): QualityBreakdown {
  if (curQ.clutter <= EPS || performance.now() > deadline) return curQ;
  const { grid, axis } = model;
  const isX = axis === "x";
  const radiusCells = qWeights.clutterRadius ?? DEFAULT_QUALITY_WEIGHTS.clutterRadius;
  const rPx = radiusCells * grid;

  const { events } = extractVisualEvents(workDoc);
  if (events.length < 2) return curQ;

  // Map each event-bearing group to the bounding coordinates of events it carries
  const eventGroupSet = model.groupsAffectingEvents(workDoc, events);
  if (eventGroupSet.size < 2) return curQ;

  const groupEventCoords = new Map<number, { p: number; sMin: number; sMax: number }>();
  for (const g of eventGroupSet) {
    // Find events lying on this group's current primary coordinate (via workDoc)
    const testSet = new Set<number>([g]);
    let pSum = 0;
    let count = 0;
    let sMin = Infinity;
    let sMax = -Infinity;
    for (const e of events) {
      const grp = model.groupsAffectingEvents(workDoc, [e]);
      if (grp.has(g)) {
        const ep = isX ? e.x : e.y;
        const es = isX ? e.y : e.x;
        pSum += ep;
        count++;
        if (es < sMin) sMin = es;
        if (es > sMax) sMax = es;
      }
    }
    if (count > 0 && testSet.size > 0) {
      groupEventCoords.set(g, { p: pSum / count, sMin, sMax });
    }
  }

  const ordered = [...groupEventCoords.entries()].sort((a, b) => a[1].p - b[1].p);
  if (ordered.length < 2) return curQ;

  let bestQ = curQ;
  const savedBestX = new Float64Array(x);
  const maxTargetCells = Math.max(2, Math.ceil(radiusCells));

  for (let targetCells = 2; targetCells <= maxTargetCells; targetCells++) {
    if (performance.now() > deadline) break;
    const targetPx = targetCells * grid;
    const extraEdges: { from: number; to: number; w: number }[] = [];

    for (let i = 0; i + 1 < ordered.length; i++) {
      const [gA, infoA] = ordered[i];
      const [gB, infoB] = ordered[i + 1];
      const curPDelta = infoB.p - infoA.p;
      if (curPDelta <= 0 || curPDelta >= targetPx) continue;
      // Only separate pairs whose events are actually close along the orthogonal axis too
      const sGap = Math.max(0, infoB.sMin - infoA.sMax, infoA.sMin - infoB.sMax);
      if (sGap >= rPx) continue;
      const offA = infoA.p - x[gA];
      const offB = infoB.p - x[gB];
      const w = ceilGrid(offA - offB + targetPx, grid);
      extraEdges.push({ from: gA, to: gB, w });
    }

    if (extraEdges.length === 0) continue;
    const sol = model.solveWithExtraEdges(extraEdges, savedBestX);
    if (!sol) continue;

    model.applyTo(workDoc, sol);
    if (obeysAreaBaseline(workDoc, baseline)) {
      const q = layoutQuality(workDoc, qWeights);
      if (Number.isFinite(q.total) && q.total < bestQ.total - EPS) {
        bestQ = q;
        savedBestX.set(sol);
      }
    }
  }

  x.set(savedBestX);
  model.applyTo(workDoc, x);
  return bestQ;
}

/** Run alternating Y/X quality polish rounds (slack exploitation + local search) within `deadline`. */
function runQualityPolish(
  start: ScheduleOutcome,
  baseline: ValidationBaseline,
  compOpts: { componentGap: number; wireGap: number; ids?: ReadonlySet<string> },
  qWeights: QualityWeights,
  deadline: number,
): ScheduleOutcome {
  let best = start;
  const axes: Axis[] = ["y", "x", "y", "x", "y", "x"];
  let staleAxes = 0;

  for (let round = 0; round < axes.length; round++) {
    if (performance.now() > deadline) break;
    const axis = axes[round];

    // Compute maximum legal span along `axis` under Rule 9 (areaAfter <= areaBefore)
    const curB = documentBounds(best.doc);
    const otherSpan = curB ? (axis === "x" ? curB.h : curB.w) : 0;
    const maxSpan = otherSpan > 0 ? Math.floor(baseline.areaBefore / otherSpan) : undefined;

    const model = buildCompactionModel(best.doc, axis, { ...compOpts, maxSpan });
    if (!model) {
      staleAxes++;
      if (staleAxes >= 2) break;
      continue;
    }

    const workDoc = structuredClone(best.doc);
    const x = new Float64Array(model.groupOrig);
    const bMin = new Float64Array(model.wideMin);
    const bMax = new Float64Array(model.wideMax);
    for (let g = 0; g < model.numGroups; g++) {
      if (x[g] < bMin[g]) bMin[g] = x[g];
      if (x[g] > bMax[g]) bMax[g] = x[g];
    }

    let workQ = best.metrics.quality;
    workQ = polishClutterSpread(model, workDoc, x, baseline, qWeights, workQ, deadline);
    // Re-clamp wide bounds if clutter spread shifted coordinates slightly
    for (let g = 0; g < model.numGroups; g++) {
      if (x[g] < bMin[g]) bMin[g] = x[g];
      if (x[g] > bMax[g]) bMax[g] = x[g];
    }
    workQ = polishAlignmentSnap(model, workDoc, x, bMin, bMax, baseline, qWeights, workQ, deadline);
    workQ = polishSpacingEqualize(model, workDoc, x, bMin, bMax, baseline, qWeights, workQ, deadline);
    workQ = polishLocalSearch1D(model, workDoc, x, bMin, bMax, baseline, qWeights, workQ, deadline);

    if (workQ.total < best.metrics.quality.total - EPS) {
      const violations = validateAgainstBaseline(baseline, workDoc);
      if (violations.length === 0) {
        best = {
          doc: workDoc,
          metrics: measureMetrics(workDoc, qWeights, compOpts.ids),
          passes: best.passes + 1,
        };
        staleAxes = 0;
        continue;
      }
    }

    staleAxes++;
    if (staleAxes >= 2) break;
  }

  return best;
}

/**
 * Pack components, wires, and text notes to minimise the weighted visual quality objective
 * (`layoutQuality`) while strictly preserving all 9 hard packing invariants (topology, wire
 * shape, connectivity, clearances, ordering, and non-increasing bounding-box area).
 * Pure function: never mutates the input document.
 */
export function packSchematic(doc: SchematicDocument, opts?: PackOptions): PackResult {
  const componentGap = Math.max(0, Math.round(opts?.componentGap ?? 2));
  const wireGap = Math.max(0, Math.round(opts?.wireGap ?? 1));
  const maxPasses = Math.max(0, Math.round(opts?.maxPasses ?? 8));
  const timeBudgetMs = Math.max(0, opts?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const ids = opts?.ids;
  const qWeights: QualityWeights = { componentGap, ...opts?.qualityWeights };

  const areaBefore = ids ? subsetArea(doc, ids) : documentArea(doc);
  const qualityBefore = layoutQuality(doc, qWeights);

  // Empty document, empty selection, or zero passes -> return deep copy unchanged
  if (
    maxPasses === 0 ||
    (doc.components.length === 0 && doc.wires.length === 0 && doc.texts.length === 0) ||
    (ids && ids.size === 0)
  ) {
    return {
      doc: structuredClone(doc),
      areaBefore,
      areaAfter: areaBefore,
      qualityBefore,
      qualityAfter: qualityBefore,
      passes: 0,
    };
  }

  const tStart = performance.now();
  const hardDeadline = tStart + timeBudgetMs;
  const multiStartDeadline = tStart + timeBudgetMs * 0.65;

  const normalizedOpts: PackOptions = { componentGap, wireGap, ids, maxPasses, qualityWeights: qWeights, timeBudgetMs };
  const baseline = prepareValidationBaseline(doc, normalizedOpts);
  const compOpts = { componentGap, wireGap, ids };

  const startMetrics = measureMetrics(doc, qWeights, ids);
  let winner: ScheduleOutcome = {
    doc: structuredClone(doc),
    metrics: startMetrics,
    passes: 0,
  };

  // Stage 1: Multi-start alternating 1-D compaction across axis orders & slack strategies
  const schedules: { firstAxis: Axis; strategy: SlackStrategy; guaranteed: number }[] = [
    { firstAxis: "x", strategy: "align", guaranteed: 2 },
    { firstAxis: "y", strategy: "align", guaranteed: 2 },
    { firstAxis: "x", strategy: "median", guaranteed: 0 },
    { firstAxis: "y", strategy: "median", guaranteed: 0 },
    { firstAxis: "x", strategy: "min", guaranteed: 0 },
    { firstAxis: "y", strategy: "keep", guaranteed: 0 },
    { firstAxis: "x", strategy: "centroid", guaranteed: 0 },
  ];

  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    if (s.guaranteed === 0 && performance.now() > multiStartDeadline) break;
    const outcome = runSchedule(
      doc,
      baseline,
      s.firstAxis,
      s.strategy,
      compOpts,
      qWeights,
      maxPasses,
      s.guaranteed > 0 ? hardDeadline : multiStartDeadline,
      s.guaranteed,
    );
    if (isStrictlyBetter(outcome.metrics, winner.metrics)) {
      winner = outcome;
    }
  }

  // Stage 2: Slack exploitation & local search polish within remaining time budget
  if (performance.now() < hardDeadline) {
    winner = runQualityPolish(winner, baseline, compOpts, qWeights, hardDeadline);
  }

  // Accept only if visual quality strictly improved (or partial-pack subset area improved with equal quality)
  const improved =
    winner.passes > 0 &&
    (winner.metrics.quality.total < qualityBefore.total - EPS ||
      (ids !== undefined &&
        winner.metrics.quality.total <= qualityBefore.total + EPS &&
        winner.metrics.primaryArea < areaBefore - EPS));

  if (!improved) {
    return {
      doc: structuredClone(doc),
      areaBefore,
      areaAfter: areaBefore,
      qualityBefore,
      qualityAfter: qualityBefore,
      passes: 0,
    };
  }

  return {
    doc: winner.doc,
    areaBefore,
    areaAfter: winner.metrics.primaryArea,
    qualityBefore,
    qualityAfter: winner.metrics.quality,
    passes: winner.passes,
  };
}

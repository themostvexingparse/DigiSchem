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
import { componentBounds, documentBounds } from "../model/geometry";
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
  wireNetIndex,
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
  /**
   * Soft wall-clock time budget in milliseconds (default grows with size: 1500 ms + 25 ms per
   * component, capped at 4000 ms; the beam adds up to half of that again).
   */
  timeBudgetMs?: number;
  /** Beam width of the search (default 4; 0 = greedy pipeline only). */
  beamWidth?: number;
  /** Keep the layout's centre of mass where it was (default true). */
  preserveCenter?: boolean;
}

export interface PackResult {
  doc: SchematicDocument;
  areaBefore: number;
  areaAfter: number;
  qualityBefore: QualityBreakdown;
  qualityAfter: QualityBreakdown;
  passes: number;
  /** Area-weighted centre of mass of the components before / after packing. */
  centerBefore: { x: number; y: number } | null;
  centerAfter: { x: number; y: number } | null;
  /** Beam statistics (depth reached, states expanded). */
  beam: { depth: number; expanded: number };
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
  // Priority groups first; every group gets a turn while time remains (the sweep is deadline-bounded).
  const activeGroups = [...priorityGroups, ...otherGroups];
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

  // Per group: mean primary coordinate and orthogonal extent of the events it carries.
  // (Each event's groups are computed ONCE — the per-group × per-event rescan was O(G·E) doc scans.)
  const acc = new Map<number, { pSum: number; count: number; sMin: number; sMax: number }>();
  for (const e of events) {
    const ep = isX ? e.x : e.y;
    const es = isX ? e.y : e.x;
    for (const g of model.groupsAffectingEvents(workDoc, [e])) {
      if (!eventGroupSet.has(g)) continue;
      const a = acc.get(g);
      if (a) {
        a.pSum += ep;
        a.count++;
        if (es < a.sMin) a.sMin = es;
        if (es > a.sMax) a.sMax = es;
      } else acc.set(g, { pSum: ep, count: 1, sMin: es, sMax: es });
    }
  }
  const groupEventCoords = new Map<number, { p: number; sMin: number; sMax: number }>();
  for (const [g, a] of acc) groupEventCoords.set(g, { p: a.pSum / a.count, sMin: a.sMin, sMax: a.sMax });

  const ordered = [...groupEventCoords.entries()].sort((a, b) => a[1].p - b[1].p || a[0] - b[0]);
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

/**
 * One quality-polish round along `axis` (clutter spreading, same-type alignment snaps, gap
 * equalisation, single-group local search inside each group's feasible interval).
 * Returns the validated improved state, or null if nothing improved.
 */
function polishRound(
  best: ScheduleOutcome,
  axis: Axis,
  baseline: ValidationBaseline,
  compOpts: { componentGap: number; wireGap: number; ids?: ReadonlySet<string> },
  qWeights: QualityWeights,
  deadline: number,
  mode: "full" | "cheap" = "full",
): ScheduleOutcome | null {
  // Maximum legal span along `axis` under Rule 9 (areaAfter <= areaBefore)
  const curB = documentBounds(best.doc);
  const otherSpan = curB ? (axis === "x" ? curB.h : curB.w) : 0;
  const maxSpan = otherSpan > 0 ? Math.floor(baseline.areaBefore / otherSpan) : undefined;

  const model = buildCompactionModel(best.doc, axis, { ...compOpts, maxSpan });
  if (!model) return null;

  const workDoc = structuredClone(best.doc);
  const x = new Float64Array(model.groupOrig);
  const bMin = new Float64Array(model.wideMin);
  const bMax = new Float64Array(model.wideMax);
  const clamp = () => {
    for (let g = 0; g < model.numGroups; g++) {
      if (x[g] < bMin[g]) bMin[g] = x[g];
      if (x[g] > bMax[g]) bMax[g] = x[g];
    }
  };
  clamp();
  let workQ = best.metrics.quality;
  if (mode === "full") {
    workQ = polishClutterSpread(model, workDoc, x, baseline, qWeights, workQ, deadline);
    clamp(); // clutter spreading may have shifted coordinates slightly
  }
  workQ = polishAlignmentSnap(model, workDoc, x, bMin, bMax, baseline, qWeights, workQ, deadline);
  workQ = polishSpacingEqualize(model, workDoc, x, bMin, bMax, baseline, qWeights, workQ, deadline);
  if (mode === "full") {
    workQ = polishLocalSearch1D(model, workDoc, x, bMin, bMax, baseline, qWeights, workQ, deadline);
  }

  if (!(workQ.total < best.metrics.quality.total - EPS)) return null;
  if (validateAgainstBaseline(baseline, workDoc).length > 0) return null;
  return { doc: workDoc, metrics: measureMetrics(workDoc, qWeights, compOpts.ids), passes: best.passes + 1 };
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
  for (const axis of axes) {
    if (performance.now() > deadline) break;
    const next = polishRound(best, axis, baseline, compOpts, qWeights, deadline);
    if (next) {
      best = next;
      staleAxes = 0;
    } else if (++staleAxes >= 2) break;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Beam search
// ---------------------------------------------------------------------------------------------


/** -1 if a is better, 1 if b is better, 0 if tied (same order as `isStrictlyBetter`). */
function cmpMetrics(a: Metrics, b: Metrics): number {
  if (isStrictlyBetter(a, b)) return -1;
  if (isStrictlyBetter(b, a)) return 1;
  return 0;
}

/** Position fingerprint of a layout (components, text notes and wire vertices). */
function layoutKey(doc: SchematicDocument): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x01000193 | 0;
  const mix = (v: number) => {
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 + v, 0x5bd1e995) ^ (h2 >>> 15);
  };
  for (const c of doc.components) {
    mix(Math.round(c.x * 2));
    mix(Math.round(c.y * 2));
  }
  for (const t of doc.texts) {
    mix(Math.round(t.x * 2));
    mix(Math.round(t.y * 2));
  }
  for (const w of doc.wires) for (const p of w.points) mix(Math.round(p.x * 2) * 31 + Math.round(p.y * 2));
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

const CHAIN_MOVES_PER_KIND = 6;

/**
 * Candidate chain moves along `model.axis`, as extra solver constraints `x[to] - x[from] >= w`:
 *  - SEPARATE the groups carrying the closest pairs of crossings/junctions (declutter), and
 *  - ALIGN near-miss pairs of same-type, same-size components onto one line (two opposite
 *    edges = equality; the lower one is pushed up and drags its dependents along).
 */
function chainMoves(
  model: CompactionModel,
  doc: SchematicDocument,
  qWeights: QualityWeights,
  perKind: number,
): { from: number; to: number; w: number }[][] {
  const { grid, axis } = model;
  const isX = axis === "x";
  const x = model.groupOrig;
  const moves: { score: number; edges: { from: number; to: number; w: number }[] }[] = [];

  // 1) separation of close event pairs
  const radiusCells = qWeights.clutterRadius ?? DEFAULT_QUALITY_WEIGHTS.clutterRadius;
  const { events } = extractVisualEvents(doc);
  if (events.length >= 2) {
    const evGroups = model.groupsAffectingEvents(doc, events);
    const acc = new Map<number, { p: number; s: number }>();
    for (const e of events) {
      for (const g of model.groupsAffectingEvents(doc, [e])) {
        if (evGroups.has(g) && !acc.has(g)) acc.set(g, { p: isX ? e.x : e.y, s: isX ? e.y : e.x });
      }
    }
    const ord = [...acc.entries()].sort((a, b) => a[1].p - b[1].p || a[0] - b[0]);
    const sep: { score: number; edges: { from: number; to: number; w: number }[] }[] = [];
    for (let i = 0; i + 1 < ord.length; i++) {
      const [gA, a] = ord[i];
      const [gB, b] = ord[i + 1];
      const dp = b.p - a.p;
      const ds = Math.abs(b.s - a.s);
      if (dp <= 0 || dp >= radiusCells * grid || ds >= radiusCells * grid) continue;
      const target = Math.min(radiusCells, Math.ceil(dp / grid) + 2) * grid;
      sep.push({
        score: Math.hypot(dp, ds),
        edges: [{ from: gA, to: gB, w: ceilGrid(a.p - x[gA] - (b.p - x[gB]) + target, grid) }],
      });
    }
    sep.sort((a, b) => a.score - b.score);
    moves.push(...sep.slice(0, perKind));
  }

  // 2) alignment of near-miss same-class pairs
  const byClass = new Map<string, CompGroupInfo[]>();
  for (const info of model.compInfos) {
    const l = byClass.get(info.classKey);
    if (l) l.push(info);
    else byClass.set(info.classKey, [info]);
  }
  const al: { score: number; edges: { from: number; to: number; w: number }[] }[] = [];
  for (const list of byClass.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (A.group === B.group) continue;
        const pa = x[A.group] + A.offLo;
        const pb = x[B.group] + B.offLo;
        const dp = Math.abs(pa - pb);
        if (dp < 0.5 || dp > 8 * grid) continue;
        const ds = Math.abs(A.sLo - B.sLo);
        // equality x[A]+offA = x[B]+offB as two opposite edges
        al.push({
          score: dp + ds * 0.25,
          edges: [
            { from: A.group, to: B.group, w: A.offLo - B.offLo },
            { from: B.group, to: A.group, w: B.offLo - A.offLo },
          ],
        });
      }
    }
  }
  al.sort((a, b) => a.score - b.score);
  moves.push(...al.slice(0, perKind));
  return moves.map((m) => m.edges);
}

interface BeamCandidate extends ScheduleOutcome {
  validated: boolean;
}

/**
 * Beam search over packing moves. Each state in the beam is expanded with
 *   - a 1-D compaction pass along X and along Y under every slack strategy, and
 *   - a quality-polish round along X and along Y;
 * the `width` best DISTINCT children survive to the next depth even when they are worse than
 * their parent — that is what lets the search leave the local optima a greedy pass gets stuck
 * in. The best state ever seen (seeds included, so the result is never worse than the seeds)
 * is returned. Full rule validation runs only on children that would enter the beam.
 */
function runBeamSearch(
  seeds: ScheduleOutcome[],
  baseline: ValidationBaseline,
  compOpts: { componentGap: number; wireGap: number; ids?: ReadonlySet<string> },
  qWeights: QualityWeights,
  deadline: number,
  width: number,
  maxDepth: number,
): { best: ScheduleOutcome; finalists: ScheduleOutcome[]; depth: number; expanded: number } {
  const seen = new Set<string>();
  let beam: ScheduleOutcome[] = [];
  let best = seeds[0];
  for (const sd of seeds) {
    const k = layoutKey(sd.doc);
    if (seen.has(k)) continue;
    seen.add(k);
    beam.push(sd);
    if (isStrictlyBetter(sd.metrics, best.metrics)) best = sd;
  }
  const timeUp = () => performance.now() > deadline;
  let depth = 0;
  let expanded = 0;
  let sinceImprovement = 0;

  for (; depth < maxDepth && beam.length > 0 && !timeUp(); depth++) {
    const children: BeamCandidate[] = [];
    const push = (st: ScheduleOutcome, cand: SchematicDocument) => {
      const k = layoutKey(cand);
      if (seen.has(k)) return;
      seen.add(k);
      if (!obeysAreaBaseline(cand, baseline)) return;
      const m = measureMetrics(cand, qWeights, compOpts.ids);
      if (!Number.isFinite(m.quality.total)) return;
      children.push({ doc: cand, metrics: m, passes: st.passes + 1, validated: false });
      expanded++;
    };
    // Chain moves: each adds one or two constraints and lets the solver push every dependent
    // group along — moves a single-group local search cannot make, and that often look worse
    // before they pay off (which is why the beam keeps them).
    for (const st of beam) {
      for (const axis of ["x", "y"] as Axis[]) {
        if (timeUp()) break;
        const model = buildCompactionModel(st.doc, axis, compOpts);
        if (!model) continue;
        for (const edges of chainMoves(model, st.doc, qWeights, CHAIN_MOVES_PER_KIND)) {
          if (timeUp()) break;
          const sol = model.solveWithExtraEdges(edges, model.groupOrig);
          if (sol) push(st, model.materialize(sol));
        }
      }
    }
    // Cheap polish (alignment snap + gap equalisation) of every beam state.
    for (const st of beam) {
      for (const axis of ["y", "x"] as Axis[]) {
        if (timeUp()) break;
        const next = polishRound(st, axis, baseline, compOpts, qWeights, deadline, "cheap");
        if (!next) continue;
        const k = layoutKey(next.doc);
        if (seen.has(k)) continue;
        seen.add(k);
        children.push({ ...next, validated: true });
        expanded++;
      }
    }

    children.sort((a, b) => cmpMetrics(a.metrics, b.metrics));
    const nextBeam: ScheduleOutcome[] = [];
    for (const c of children) {
      if (nextBeam.length >= width) break;
      if (!c.validated && validateAgainstBaseline(baseline, c.doc).length > 0) continue;
      nextBeam.push(c);
    }
    if (nextBeam.length === 0) break;
    beam = nextBeam;
    if (isStrictlyBetter(beam[0].metrics, best.metrics)) {
      best = beam[0];
      sinceImprovement = 0;
    } else if (++sinceImprovement >= 3) {
      break; // three depths without a new best: converged
    }
  }
  const finalists = [best, ...beam.filter((b) => b !== best)];
  return { best, finalists, depth, expanded };
}

// ---------------------------------------------------------------------------------------------
// Centre of mass
// ---------------------------------------------------------------------------------------------

/**
 * Centre of mass of a layout: the AREA-WEIGHTED centroid of the component bounds (bodies incl.
 * pin legs). Falls back to the centre of the bounding box when there are no components (only
 * wires / text). With `ids`, only those items count.
 */
export function centerOfMass(doc: SchematicDocument, ids?: ReadonlySet<string>): { x: number; y: number } | null {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const c of doc.components) {
    if (ids && !ids.has(c.id)) continue;
    const b = componentBounds(c);
    const w = Math.max(1, b.w * b.h);
    sw += w;
    sx += w * (b.x + b.w / 2);
    sy += w * (b.y + b.h / 2);
  }
  if (sw > 0) return { x: sx / sw, y: sy / sw };
  const b = documentBounds(doc);
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
}

/** Rigidly translate the movable items (`ids`, or everything) by (dx, dy). */
function translated(doc: SchematicDocument, dx: number, dy: number, ids?: ReadonlySet<string>): SchematicDocument {
  const d = structuredClone(doc);
  const moves = (id: string) => !ids || ids.has(id);
  for (const c of d.components) {
    if (!moves(c.id)) continue;
    c.x += dx;
    c.y += dy;
  }
  for (const w of d.wires) {
    if (!moves(w.id)) continue;
    for (const p of w.points) {
      p.x += dx;
      p.y += dy;
    }
  }
  for (const t of d.texts) {
    if (!moves(t.id)) continue;
    t.x += dx;
    t.y += dy;
  }
  return d;
}

/**
 * Shift the packed layout so its centre of mass lands back on the original one (snapped to the
 * grid, so it matches within half a cell). A rigid translation of the whole document keeps every
 * rule; for a partial pack (fixed obstacles stay put) the shift is validated, and shorter shifts
 * are tried if the full one would collide or detach a wire.
 */
function restoreCenterOfMass(
  packed: SchematicDocument,
  target: { x: number; y: number } | null,
  baseline: ValidationBaseline,
  ids?: ReadonlySet<string>,
): SchematicDocument {
  const cur = centerOfMass(packed, ids);
  if (!target || !cur) return packed;
  const grid = baseline.grid;
  const dx0 = snapGrid(target.x - cur.x, grid);
  const dy0 = snapGrid(target.y - cur.y, grid);
  if (dx0 === 0 && dy0 === 0) return packed;
  // Full shift first; then each axis on its own (for a selection, the order rule can forbid the
  // small vertical part while the horizontal part is fine, or vice versa); then shorter shifts.
  for (const f of [1, 0.75, 0.5, 0.25]) {
    const dx = snapGrid(dx0 * f, grid);
    const dy = snapGrid(dy0 * f, grid);
    const tries: [number, number][] = [[dx, dy]];
    if (ids && dx !== 0 && dy !== 0) {
      // try the larger component first
      if (Math.abs(dx) >= Math.abs(dy)) tries.push([dx, 0], [0, dy]);
      else tries.push([0, dy], [dx, 0]);
    }
    for (const [tx, ty] of tries) {
      if (tx === 0 && ty === 0) continue;
      const cand = translated(packed, tx, ty, ids);
      if (validateAgainstBaseline(baseline, cand).length === 0) return cand;
    }
  }
  return packed;
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
  const timeBudgetMs = Math.max(
    0,
    opts?.timeBudgetMs ?? Math.min(4000, DEFAULT_TIME_BUDGET_MS + 25 * doc.components.length),
  );
  const beamWidth = Math.max(0, Math.round(opts?.beamWidth ?? 4));
  const preserveCenter = opts?.preserveCenter ?? true;
  const ids = opts?.ids;
  const centerBefore = centerOfMass(doc, ids);
  const qWeights: QualityWeights = { componentGap, baselineNets: wireNetIndex(doc), ...opts?.qualityWeights };

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
      centerBefore,
      centerAfter: centerBefore,
      beam: { depth: 0, expanded: 0 },
    };
  }

  const tStart = performance.now();
  const hardDeadline = tStart + timeBudgetMs;
  // Greedy pipeline first (it seeds the beam, so the beam can only do better), then the beam.
  // Budget: the greedy pipeline gets the FULL budget (it usually converges early), so beam mode
  // can never end worse than greedy-only. The beam then gets the leftover plus `beamExtraMs`;
  // its last 40% refines the best finalists with the expensive polish.
  const multiStartDeadline = tStart + timeBudgetMs * 0.65;
  const greedyDeadline = hardDeadline;
  const beamExtraMs = beamWidth > 0 ? timeBudgetMs * 0.5 : 0;

  const normalizedOpts: PackOptions = { componentGap, wireGap, ids, maxPasses, qualityWeights: qWeights, timeBudgetMs };
  const baseline = prepareValidationBaseline(doc, normalizedOpts);
  const compOpts = { componentGap, wireGap, ids };

  const startMetrics = measureMetrics(doc, qWeights, ids);
  let winner: ScheduleOutcome = {
    doc: structuredClone(doc),
    metrics: startMetrics,
    passes: 0,
  };

  const starts: ScheduleOutcome[] = [];
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
    starts.push(outcome);
    if (isStrictlyBetter(outcome.metrics, winner.metrics)) {
      winner = outcome;
    }
  }

  // Stage 2: Slack exploitation & local search polish
  if (performance.now() < greedyDeadline) {
    winner = runQualityPolish(winner, baseline, compOpts, qWeights, greedyDeadline);
  }

  // Stage 3: beam search seeded with the greedy winner, the multi-start outcomes and the input
  let beamStats = { depth: 0, expanded: 0 };
  if (beamWidth > 0) {
    const beamStart = performance.now();
    const beamEnd = Math.max(hardDeadline, beamStart) + beamExtraMs;
    const beamDeadline = beamStart + (beamEnd - beamStart) * 0.6;
    const r = runBeamSearch(
      [winner, ...starts, { doc: structuredClone(doc), metrics: startMetrics, passes: 0 }],
      baseline,
      compOpts,
      qWeights,
      beamDeadline,
      beamWidth,
      40,
    );
    beamStats = { depth: r.depth, expanded: r.expanded };
    // Stage 4: refine the best few distinct finalists with the expensive polish (clutter
    // spreading + local search), splitting the remaining time between them.
    const finalists = r.finalists.slice(0, 3);
    for (let i = 0; i < finalists.length && performance.now() < beamEnd; i++) {
      const slice = (beamEnd - performance.now()) / (finalists.length - i);
      const refined = runQualityPolish(finalists[i], baseline, compOpts, qWeights, performance.now() + slice);
      if (isStrictlyBetter(refined.metrics, winner.metrics)) winner = refined;
    }
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
      centerBefore,
      centerAfter: centerBefore,
      beam: { depth: 0, expanded: 0 },
    };
  }

  const out = preserveCenter ? restoreCenterOfMass(winner.doc, centerBefore, baseline, ids) : winner.doc;
  return {
    doc: out,
    areaBefore,
    // measured on the returned (centre-restored) document, so a re-pack of it agrees exactly
    areaAfter: ids ? subsetArea(out, ids) : documentArea(out),
    qualityBefore,
    qualityAfter: out === winner.doc ? winner.metrics.quality : layoutQuality(out, qWeights),
    passes: winner.passes,
    centerBefore,
    centerAfter: centerOfMass(out, ids),
    beam: beamStats,
  };
}

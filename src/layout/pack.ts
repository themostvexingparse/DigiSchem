/**
 * Heuristic-guided schematic layout packer / compactor.
 *
 * Algorithm overview (1-D constraint-graph compaction alternated in X and Y):
 *  1. Precompute a `ValidationBaseline` of the input document once (netlist, logical
 *     junctions, RouteObstacles cleanliness, pin attachments, component ordering).
 *  2. Run two candidate schedules and keep the smaller-area result:
 *       - X-first: X, Y, X, Y, ... up to `maxPasses` (default 8)
 *       - Y-first: Y, X, Y, X, ... up to `maxPasses`
 *  3. Each 1-D pass (`compact1D`) builds a sparse constraint graph along the active axis:
 *       - Merges coordinates bound by equality constraints (orthogonal wire segments,
 *         pin attachments, shared vertices, T-junctions on perpendicular segments, direct
 *         pin abutments, and fixed items outside `opts.ids`) via Union-Find.
 *       - Adds inequality constraints for wire segment min-length (>= 1 grid) & direction,
 *         T-junction sliding bounds, plain crossing clearance, collinear wire separation,
 *         shadow-pruned component body clearance (`componentGap`), parallel wire and
 *         wire-to-body spacing (`wireGap`), strict label/text-note non-overlap, and
 *         component relative ordering preservation.
 *       - Computes global-minimum span via forward/backward SPFA longest-path and pulls
 *         slack groups toward the median of their connected wire neighbors (or schematic
 *         centroid for isolated items) so tightly connected clusters pack together.
 *  4. After each 1-D pass, validates ALL rules 1–9 via `validateAgainstBaseline`; any
 *     pass that introduces a violation is discarded. Stops early once two consecutive
 *     orthogonal passes fail to improve `(area, perimeter, wireLength)`.
 *  5. Enforces Rule 9 strictly: if the final bounding-box area does not strictly improve
 *     over `areaBefore`, returns an unmodified deep copy of the input (`passes: 0`).
 */
import type { SchematicDocument } from "../model/types";
import { documentBounds } from "../model/geometry";
import { compact1D, totalWireLength, type Axis } from "./compact1d";
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
  /** Max improvement passes (default 8). */
  maxPasses?: number;
}

export interface PackResult {
  doc: SchematicDocument;
  areaBefore: number;
  areaAfter: number;
  passes: number;
}

const EPS = 1e-6;

interface Metrics {
  primaryArea: number;
  docArea: number;
  perimeter: number;
  wireLen: number;
}

function measureMetrics(doc: SchematicDocument, ids?: ReadonlySet<string>): Metrics {
  const b = documentBounds(doc);
  const docA = b ? b.w * b.h : 0;
  const primaryArea = ids ? subsetArea(doc, ids) : docA;
  const perimeter = b ? b.w + b.h : 0;
  return {
    primaryArea,
    docArea: docA,
    perimeter,
    wireLen: totalWireLength(doc),
  };
}

function isStrictlyBetter(a: Metrics, b: Metrics): boolean {
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

function runSchedule(
  input: SchematicDocument,
  baseline: ValidationBaseline,
  firstAxis: Axis,
  compOpts: { componentGap: number; wireGap: number; ids?: ReadonlySet<string> },
  maxPasses: number,
): ScheduleOutcome {
  let current = structuredClone(input);
  let curMetrics = measureMetrics(current, compOpts.ids);
  let bestDoc = current;
  let bestMetrics = curMetrics;
  let bestPasses = 0;
  let acceptedPasses = 0;
  let staleStreak = 0;

  for (let step = 0; step < maxPasses; step++) {
    const axis: Axis = step % 2 === 0 ? firstAxis : firstAxis === "x" ? "y" : "x";
    const candidate = compact1D(current, axis, compOpts);
    const candMetrics = measureMetrics(candidate, compOpts.ids);

    // Must never increase document or subset area, and must pass all rules 1-9
    const areaOk =
      candMetrics.docArea <= curMetrics.docArea + EPS &&
      candMetrics.primaryArea <= curMetrics.primaryArea + EPS;

    if (areaOk && isStrictlyBetter(candMetrics, curMetrics)) {
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
    // Stop once both X and Y fail to improve consecutively
    if (staleStreak >= 2) break;
  }

  return { doc: bestDoc, metrics: bestMetrics, passes: bestPasses };
}

/**
 * Tightly pack components, wires, and text notes to minimize bounding-box area
 * while strictly preserving topology, wire shape, connectivity, clearances, and readability.
 * Pure function: never mutates the input document.
 */
export function packSchematic(doc: SchematicDocument, opts?: PackOptions): PackResult {
  const componentGap = Math.max(0, Math.round(opts?.componentGap ?? 2));
  const wireGap = Math.max(0, Math.round(opts?.wireGap ?? 1));
  const maxPasses = Math.max(0, Math.round(opts?.maxPasses ?? 8));
  const ids = opts?.ids;

  const areaBefore = ids ? subsetArea(doc, ids) : documentArea(doc);

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
      passes: 0,
    };
  }

  const normalizedOpts: PackOptions = { componentGap, wireGap, ids, maxPasses };
  const baseline = prepareValidationBaseline(doc, normalizedOpts);
  const compOpts = { componentGap, wireGap, ids };

  // Try both X-first and Y-first alternating schedules and keep the smaller area result
  const xFirst = runSchedule(doc, baseline, "x", compOpts, maxPasses);
  const yFirst = runSchedule(doc, baseline, "y", compOpts, maxPasses);

  const winner = isStrictlyBetter(yFirst.metrics, xFirst.metrics) ? yFirst : xFirst;

  // Rule 9: area must strictly decrease to accept; otherwise return unmodified deep copy
  if (winner.metrics.primaryArea >= areaBefore - EPS && winner.metrics.docArea >= baseline.areaBefore - EPS) {
    return {
      doc: structuredClone(doc),
      areaBefore,
      areaAfter: areaBefore,
      passes: 0,
    };
  }

  return {
    doc: winner.doc,
    areaBefore,
    areaAfter: winner.metrics.primaryArea,
    passes: winner.passes,
  };
}

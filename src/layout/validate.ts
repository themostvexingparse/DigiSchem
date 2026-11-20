/**
 * Automated rule checker for schematic layout packing / compaction.
 *
 * Verifies all 9 hard packing invariants:
 *  1. Identical electrical topology (buildNetlist sets of pins & wire IDs).
 *  2. Same wire point counts & normalizeWirePoints stability (no new/removed waypoints,
 *     no zero-length or newly collinear/folded segments).
 *  3. Wire segment orientations, directions, and bend turns preserved; lengths >= 1 grid.
 *  4. Wire vertices remain attached to the exact same component pins and T-junctions.
 *  5. Components/wires/texts keep all non-coordinate properties; grid alignment preserved;
 *     elements outside `opts.ids` remain fixed.
 *  6. No overlaps: component bodies (+ componentGap), labels vs bodies/wires/labels/texts,
 *     text notes vs everything, parallel wire spacing (wireGap), wire vs unrelated body.
 *  7. No accidental connections (RouteObstacles.routeIsBad) and identical multiset of
 *     logical junction dots (junctionPoints).
 *  8. Readability: relative left/right and above/below ordering of non-overlapping
 *     component bodies preserved; pin exit legs stay straight >= 1 grid.
 *  9. Bounding-box area never increases.
 */
import type { ComponentInstance, Point, SchematicDocument, TextNote, Wire } from "../model/types";
import { GRID } from "../model/component-def";
import {
  boundsOfPoints,
  componentBounds,
  documentBounds,
  junctionPoints,
  labelBounds,
  pointOnSegment,
  rectsIntersect,
  SegmentIndex,
  textNoteBounds,
  unionRect,
  worldPins,
  type Rect,
  type WorldPin,
} from "../model/geometry";
import { buildNetlist } from "../io/netlist";
import { RouteObstacles } from "../editor/safe-route";
import { normalizeWirePoints, pinExitVector, segmentIntersectsRect } from "../editor/wire-utils";
import type { PackOptions } from "./pack";

const EPS = 1e-6;

function ptKey(p: Point): string {
  return `${p.x},${p.y}`;
}

function pinIdKey(componentId: string, pinId: string): string {
  return `${componentId}:${pinId}`;
}

function pointsArrayEqual(a: readonly Point[], b: readonly Point[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
  }
  return true;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      if (
        !deepEqualJson(
          (a as Record<string, unknown>)[ka[i]],
          (b as Record<string, unknown>)[kb[i]],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function rectArea(r: Rect | null): number {
  return r ? r.w * r.h : 0;
}

/** Bounding-box area of the whole document (components + labels, wires, texts). */
export function documentArea(doc: SchematicDocument): number {
  return rectArea(documentBounds(doc));
}

/** Bounding-box area of the subset of document elements listed in `ids`. */
export function subsetArea(doc: SchematicDocument, ids: ReadonlySet<string>): number {
  let r: Rect | null = null;
  for (const c of doc.components) {
    if (!ids.has(c.id)) continue;
    r = unionRect(r, componentBounds(c));
    const lb = labelBounds(c);
    if (lb) r = unionRect(r, lb);
  }
  for (const w of doc.wires) {
    if (!ids.has(w.id) || w.points.length === 0) continue;
    r = unionRect(r, boundsOfPoints(w.points));
  }
  for (const t of doc.texts) {
    if (!ids.has(t.id)) continue;
    r = unionRect(r, textNoteBounds(t));
  }
  return rectArea(r);
}

/** L-infinity separation between two rectangles (>0 means disjoint, 0 touching, <0 overlapping). */
function rectSeparation(a: Rect, b: Rect): number {
  const sepX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const sepY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(sepX, sepY);
}

/** Fast exact intersection check for axis-aligned segments (falls back for diagonal). */
function segIntersectsRectFast(a: Point, b: Point, r: Rect): boolean {
  if (a.x === b.x || a.y === b.y) {
    const minX = a.x < b.x ? a.x : b.x;
    const maxX = a.x > b.x ? a.x : b.x;
    const minY = a.y < b.y ? a.y : b.y;
    const maxY = a.y > b.y ? a.y : b.y;
    return minX <= r.x + r.w && r.x <= maxX && minY <= r.y + r.h && r.y <= maxY;
  }
  return segmentIntersectsRect(a, b, r);
}

/** L-infinity separation between an axis-aligned segment and a rectangle. */
function segRectSeparation(a: Point, b: Point, r: Rect): number {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const sepX = Math.max(r.x - maxX, minX - (r.x + r.w));
  const sepY = Math.max(r.y - maxY, minY - (r.y + r.h));
  return Math.max(sepX, sepY);
}

function canonicalNetSignatures(doc: SchematicDocument): string[] {
  const { nets } = buildNetlist(doc);
  return nets
    .map((net) => {
      const pins = net.pins
        .map((p) => pinIdKey(p.componentId, p.pinId))
        .sort()
        .join(",");
      const wires = [...net.wires].sort().join(",");
      return `P[${pins}]|W[${wires}]`;
    })
    .sort();
}

function logicalJunctionSignatures(doc: SchematicDocument): string[] {
  const idx = new SegmentIndex(doc.wires);
  const pinsAtKey = new Map<string, string[]>();
  for (const c of doc.components) {
    for (const wp of worldPins(c)) {
      const k = ptKey(wp.pos);
      const list = pinsAtKey.get(k);
      const id = pinIdKey(c.id, wp.pin.id);
      if (list) list.push(id);
      else pinsAtKey.set(k, [id]);
    }
  }
  return junctionPoints(doc)
    .map((p) => {
      const wireIds = [...idx.wiresAt(p)].map((wi) => doc.wires[wi].id).sort();
      const pinIds = [...(pinsAtKey.get(ptKey(p)) ?? [])].sort();
      return `W[${wireIds.join(",")}]|P[${pinIds.join(",")}]`;
    })
    .sort();
}

function protectedVertexKeys(doc: SchematicDocument): Set<string> {
  const owners = new Map<string, number>();
  for (const w of doc.wires) {
    const seen = new Set<string>();
    for (const p of w.points) {
      const k = ptKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      owners.set(k, (owners.get(k) ?? 0) + 1);
    }
  }
  const keep = new Set<string>();
  for (const [k, n] of owners) if (n >= 2) keep.add(k);
  for (const c of doc.components) {
    for (const wp of worldPins(c)) keep.add(ptKey(wp.pos));
  }
  return keep;
}

interface TJunctionRef {
  hostWireId: string;
  hostSegIdx: number;
  strictInterior: boolean;
}

interface PinExitRecord {
  endIdx: number; // 0 or points.length - 1
  adjIdx: number; // 1 or points.length - 2
  exit: Point;
}

interface ParallelPairRecord {
  w1: string;
  s1: number;
  w2: string;
  s2: number;
  dist: number;
}

/** Precomputed baseline information about the `before` document for fast repeated validation. */
export interface ValidationBaseline {
  before: SchematicDocument;
  /**
   * Violations the INPUT already has (e.g. a hand-drawn label touching a neighbouring body).
   * Packing is judged only on what it introduces: these are filtered out of every check, so a
   * single pre-existing imperfection doesn't make the whole schematic un-packable.
   */
  preexisting: ReadonlySet<string>;
  grid: number;
  componentGap: number;
  wireGap: number;
  ids: ReadonlySet<string> | undefined;
  areaBefore: number;
  subsetAreaBefore: number | null;
  netSignatures: string[];
  junctionSignatures: string[];
  compById: Map<string, ComponentInstance>;
  compBounds: Map<string, Rect>;
  compPins: Map<string, WorldPin[]>;
  wireById: Map<string, Wire>;
  textById: Map<string, TextNote>;
  /** Direct pin-abutting component pairs ("idA|idB" sorted). */
  abuttingCompPairs: Set<string>;
  /** For each wire id, whether bare normalizeWirePoints left it unchanged. */
  wireNormalizedBare: Map<string, boolean>;
  /** For each wire id, whether protected normalizeWirePoints left it unchanged. */
  wireNormalizedProtected: Map<string, boolean>;
  /** For each wire id, whether routeIsBad(w, {w}) was false in before. */
  wireRouteClean: Map<string, boolean>;
  /** For each wire id, whether routeIsBad(w, {w}, allowed) was false in before. */
  wireRouteCleanWithAllowed: Map<string, boolean>;
  /** For each host wire id, list of { otherWireId, vertexIdx } intentionally resting on its interior. */
  intentionalInteriorContacts: Map<string, { otherWireId: string; vertexIdx: number }[]>;
  /** For each wire id -> vertex index -> pins coinciding with that vertex in before. */
  vertexPinAttachments: Map<string, Map<number, string[]>>;
  /** For each wire id -> vertex index -> other wire segments containing that vertex in before. */
  vertexWireAttachments: Map<string, Map<number, TJunctionRef[]>>;
  /** For each pinKey -> sorted list of wire ids touching that pin in before. */
  pinWires: Map<string, string[]>;
  /** For each pinKey -> sorted list of other pinKeys coinciding with it in before. */
  pinCoincidentPins: Map<string, string[]>;
  /** For each wire id -> segment index -> set of component ids related (pin on segment) to it. */
  segRelatedComps: Map<string, Map<number, Set<string>>>;
  /** For each wire id -> pin exit expectations for endpoints attached to pins. */
  wirePinExits: Map<string, PinExitRecord[]>;
  /** Parallel segment pairs that were closer than wireGap * grid in before. */
  beforeTightParallelDist: Map<string, number>;
  /** Wire-segment / unrelated-body pairs that were closer than wireGap * grid in before. */
  beforeTightSegBodyDist: Map<string, number>;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function segPairKey(w1: string, s1: number, w2: string, s2: number): string {
  const k1 = `${w1}#${s1}`;
  const k2 = `${w2}#${s2}`;
  return k1 < k2 ? `${k1}\0${k2}` : `${k2}\0${k1}`;
}

interface AxisSeg {
  wireId: string;
  segIdx: number;
  coord: number; // y for H, x for V
  lo: number; // minX for H, minY for V
  hi: number; // maxX for H, maxY for V
}

function extractAxisSegments(doc: SchematicDocument): { hSegs: AxisSeg[]; vSegs: AxisSeg[] } {
  const hSegs: AxisSeg[] = [];
  const vSegs: AxisSeg[] = [];
  for (const w of doc.wires) {
    for (let i = 0; i + 1 < w.points.length; i++) {
      const a = w.points[i];
      const b = w.points[i + 1];
      if (a.x === b.x && a.y === b.y) continue;
      if (a.y === b.y) {
        hSegs.push({ wireId: w.id, segIdx: i, coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      } else if (a.x === b.x) {
        vSegs.push({ wireId: w.id, segIdx: i, coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
      }
    }
  }
  return { hSegs, vSegs };
}

function collectCloseParallelPairs(segs: AxisSeg[], maxDist: number): ParallelPairRecord[] {
  const out: ParallelPairRecord[] = [];
  if (segs.length < 2 || maxDist <= 0) return out;
  const sorted = [...segs].sort((a, b) => a.coord - b.coord || a.lo - b.lo);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const dist = b.coord - a.coord;
      if (dist >= maxDist) break;
      // Open overlap along segment axis
      if (a.lo < b.hi && b.lo < a.hi) {
        out.push({ w1: a.wireId, s1: a.segIdx, w2: b.wireId, s2: b.segIdx, dist });
      }
    }
  }
  return out;
}

/** Precompute baseline state for `before` so multiple compaction passes can validate quickly. */
export function prepareValidationBaseline(
  before: SchematicDocument,
  opts?: PackOptions,
): ValidationBaseline {
  const grid = before.grid || GRID;
  const componentGap = opts?.componentGap ?? 2;
  const wireGap = opts?.wireGap ?? 1;
  const ids = opts?.ids;

  const compById = new Map<string, ComponentInstance>();
  const compBounds = new Map<string, Rect>();
  const compPins = new Map<string, WorldPin[]>();
  const pinsByPt = new Map<string, { comp: ComponentInstance; wp: WorldPin }[]>();

  for (const c of before.components) {
    compById.set(c.id, c);
    compBounds.set(c.id, componentBounds(c));
    const wps = worldPins(c);
    compPins.set(c.id, wps);
    for (const wp of wps) {
      const k = ptKey(wp.pos);
      const list = pinsByPt.get(k);
      if (list) list.push({ comp: c, wp });
      else pinsByPt.set(k, [{ comp: c, wp }]);
    }
  }

  const abuttingCompPairs = new Set<string>();
  const pinCoincidentPins = new Map<string, string[]>();
  for (const list of pinsByPt.values()) {
    for (let i = 0; i < list.length; i++) {
      const pA = pinIdKey(list[i].comp.id, list[i].wp.pin.id);
      const others: string[] = [];
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        others.push(pinIdKey(list[j].comp.id, list[j].wp.pin.id));
        if (list[i].comp.id !== list[j].comp.id) {
          abuttingCompPairs.add(pairKey(list[i].comp.id, list[j].comp.id));
        }
      }
      pinCoincidentPins.set(pA, others.sort());
    }
  }

  const wireById = new Map<string, Wire>();
  for (const w of before.wires) wireById.set(w.id, w);

  const textById = new Map<string, TextNote>();
  for (const t of before.texts) textById.set(t.id, t);

  const keepBefore = protectedVertexKeys(before);
  const wireNormalizedBare = new Map<string, boolean>();
  const wireNormalizedProtected = new Map<string, boolean>();
  for (const w of before.wires) {
    wireNormalizedBare.set(w.id, pointsArrayEqual(normalizeWirePoints(w.points), w.points));
    wireNormalizedProtected.set(
      w.id,
      pointsArrayEqual(normalizeWirePoints(w.points, keepBefore), w.points),
    );
  }

  const segIndex = new SegmentIndex(before.wires);
  const pinWires = new Map<string, string[]>();
  for (const c of before.components) {
    for (const wp of compPins.get(c.id) ?? []) {
      const wires = [...segIndex.wiresAt(wp.pos)].map((wi) => before.wires[wi].id).sort();
      pinWires.set(pinIdKey(c.id, wp.pin.id), wires);
    }
  }

  const vertexPinAttachments = new Map<string, Map<number, string[]>>();
  const vertexWireAttachments = new Map<string, Map<number, TJunctionRef[]>>();
  const intentionalInteriorContacts = new Map<string, { otherWireId: string; vertexIdx: number }[]>();
  const segRelatedComps = new Map<string, Map<number, Set<string>>>();
  const wirePinExits = new Map<string, PinExitRecord[]>();

  for (const w of before.wires) {
    const vPinMap = new Map<number, string[]>();
    const vWireMap = new Map<number, TJunctionRef[]>();
    vertexPinAttachments.set(w.id, vPinMap);
    vertexWireAttachments.set(w.id, vWireMap);

    for (let vi = 0; vi < w.points.length; vi++) {
      const p = w.points[vi];
      const pk = ptKey(p);
      const pinsHere = pinsByPt.get(pk);
      if (pinsHere && pinsHere.length > 0) {
        vPinMap.set(
          vi,
          pinsHere.map((x) => pinIdKey(x.comp.id, x.wp.pin.id)),
        );
      }

      const touchingWires = segIndex.wiresAt(p);
      const refs: TJunctionRef[] = [];
      for (const otherIdx of touchingWires) {
        const other = before.wires[otherIdx];
        if (other.id === w.id) continue;
        for (let si = 0; si + 1 < other.points.length; si++) {
          const a = other.points[si];
          const b = other.points[si + 1];
          if (!pointOnSegment(p, a, b)) continue;
          const onEnd = (p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y);
          refs.push({ hostWireId: other.id, hostSegIdx: si, strictInterior: !onEnd });
          // Track intentional interior contacts on `other` for allowed-set routeIsBad check
          const otherEnd0 = other.points[0];
          const otherEnd1 = other.points[other.points.length - 1];
          const isOtherEndpoint =
            (p.x === otherEnd0.x && p.y === otherEnd0.y) ||
            (p.x === otherEnd1.x && p.y === otherEnd1.y);
          if (!isOtherEndpoint) {
            let list = intentionalInteriorContacts.get(other.id);
            if (!list) {
              list = [];
              intentionalInteriorContacts.set(other.id, list);
            }
            list.push({ otherWireId: w.id, vertexIdx: vi });
          }
        }
      }
      if (refs.length > 0) vWireMap.set(vi, refs);
    }

    // Related components per segment (any pin lying on the segment)
    const relMap = new Map<number, Set<string>>();
    segRelatedComps.set(w.id, relMap);
    for (let si = 0; si + 1 < w.points.length; si++) {
      const a = w.points[si];
      const b = w.points[si + 1];
      const set = new Set<string>();
      for (const c of before.components) {
        const rb = compBounds.get(c.id)!;
        if (!segIntersectsRectFast(a, b, rb)) continue;
        for (const wp of compPins.get(c.id) ?? []) {
          if (pointOnSegment(wp.pos, a, b)) {
            set.add(c.id);
            break;
          }
        }
      }
      if (set.size > 0) relMap.set(si, set);
    }

    // Pin exit legs at endpoints
    const exits: PinExitRecord[] = [];
    if (w.points.length >= 2) {
      const endpoints: [number, number][] = [
        [0, 1],
        [w.points.length - 1, w.points.length - 2],
      ];
      for (const [endIdx, adjIdx] of endpoints) {
        const ep = w.points[endIdx];
        const ap = w.points[adjIdx];
        const pinsHere = pinsByPt.get(ptKey(ep));
        if (!pinsHere) continue;
        const dx = Math.sign(ap.x - ep.x);
        const dy = Math.sign(ap.y - ep.y);
        for (const { comp, wp } of pinsHere) {
          const ev = pinExitVector(comp, wp.pin.side);
          if (dx === ev.x && dy === ev.y) {
            exits.push({ endIdx, adjIdx, exit: ev });
          }
        }
      }
    }
    if (exits.length > 0) wirePinExits.set(w.id, exits);
  }

  const obsBefore = new RouteObstacles(before);
  const wireRouteClean = new Map<string, boolean>();
  const wireRouteCleanWithAllowed = new Map<string, boolean>();
  for (const w of before.wires) {
    const self = new Set([w.id]);
    const clean = !obsBefore.routeIsBad(w.points, self);
    wireRouteClean.set(w.id, clean);
    if (clean) {
      wireRouteCleanWithAllowed.set(w.id, true);
    } else {
      const contacts = intentionalInteriorContacts.get(w.id);
      if (contacts && contacts.length > 0) {
        const allowed = new Set<string>();
        for (const c of contacts) {
          const ow = wireById.get(c.otherWireId);
          if (ow && ow.points[c.vertexIdx]) {
            allowed.add(`${c.otherWireId}@${ptKey(ow.points[c.vertexIdx])}`);
          }
        }
        wireRouteCleanWithAllowed.set(w.id, !obsBefore.routeIsBad(w.points, self, allowed));
      } else {
        wireRouteCleanWithAllowed.set(w.id, false);
      }
    }
  }

  const wireGapPx = wireGap * grid;
  const { hSegs, vSegs } = extractAxisSegments(before);
  const beforeTightParallelDist = new Map<string, number>();
  for (const pair of [
    ...collectCloseParallelPairs(hSegs, wireGapPx),
    ...collectCloseParallelPairs(vSegs, wireGapPx),
  ]) {
    beforeTightParallelDist.set(segPairKey(pair.w1, pair.s1, pair.w2, pair.s2), pair.dist);
  }

  const beforeTightSegBodyDist = new Map<string, number>();
  for (const w of before.wires) {
    const relMap = segRelatedComps.get(w.id);
    for (let si = 0; si + 1 < w.points.length; si++) {
      const a = w.points[si];
      const b = w.points[si + 1];
      const rel = relMap?.get(si);
      for (const c of before.components) {
        if (rel?.has(c.id)) continue;
        const d = segRectSeparation(a, b, compBounds.get(c.id)!);
        if (d < wireGapPx) {
          beforeTightSegBodyDist.set(`${w.id}#${si}\0${c.id}`, d);
        }
      }
    }
  }

  const baseline: ValidationBaseline = {
    preexisting: new Set<string>(),
    before,
    grid,
    componentGap,
    wireGap,
    ids,
    areaBefore: documentArea(before),
    subsetAreaBefore: ids ? subsetArea(before, ids) : null,
    netSignatures: canonicalNetSignatures(before),
    junctionSignatures: logicalJunctionSignatures(before),
    compById,
    compBounds,
    compPins,
    wireById,
    textById,
    abuttingCompPairs,
    wireNormalizedBare,
    wireNormalizedProtected,
    wireRouteClean,
    wireRouteCleanWithAllowed,
    intentionalInteriorContacts,
    vertexPinAttachments,
    vertexWireAttachments,
    pinWires,
    pinCoincidentPins,
    segRelatedComps,
    wirePinExits,
    beforeTightParallelDist,
    beforeTightSegBodyDist,
  };
  // What does the input violate on its own? (computed against itself, with nothing filtered)
  baseline.preexisting = new Set(validateAgainstBaseline(baseline, before));
  return baseline;
}

/** Validate `after` against a precomputed `ValidationBaseline`. Returns list of violation messages. */
export function validateAgainstBaseline(
  base: ValidationBaseline,
  after: SchematicDocument,
): string[] {
  const violations: string[] = [];
  const { before, grid, componentGap, wireGap, ids } = base;
  const involvesMovable = (idA: string, idB?: string): boolean => {
    if (!ids) return true;
    return ids.has(idA) || (idB !== undefined && ids.has(idB));
  };

  // --- Structural & Rule 5 checks ---
  if (after.format !== before.format) violations.push(`Rule 5: document format changed`);
  if (after.version !== before.version) violations.push(`Rule 5: document version changed`);
  if (after.grid !== before.grid) violations.push(`Rule 5: document grid changed`);
  if (after.components.length !== before.components.length) {
    violations.push(`Rule 5: component count changed (${before.components.length} -> ${after.components.length})`);
  }
  if (after.wires.length !== before.wires.length) {
    violations.push(`Rule 5: wire count changed (${before.wires.length} -> ${after.wires.length})`);
  }
  if (after.texts.length !== before.texts.length) {
    violations.push(`Rule 5: text note count changed (${before.texts.length} -> ${after.texts.length})`);
  }

  const afterCompById = new Map<string, ComponentInstance>();
  const afterCompBounds = new Map<string, Rect>();
  const afterLabelBounds = new Map<string, Rect>();
  const afterPinPos = new Map<string, Point>();
  const afterPinsByPt = new Map<string, string[]>();

  for (const c of after.components) {
    afterCompById.set(c.id, c);
    const cb = base.compById.get(c.id);
    if (!cb) {
      violations.push(`Rule 5: unexpected component ${c.id}`);
      continue;
    }
    if (
      c.type !== cb.type ||
      c.rotation !== cb.rotation ||
      Boolean(c.mirror) !== Boolean(cb.mirror) ||
      c.label !== cb.label ||
      !deepEqualJson(c.props, cb.props) ||
      !deepEqualJson(c.size, cb.size)
    ) {
      violations.push(`Rule 5: component ${c.id} non-coordinate properties changed`);
    }
    const moved = c.x !== cb.x || c.y !== cb.y;
    if (ids && !ids.has(c.id) && moved) {
      violations.push(`Rule 5: fixed component ${c.id} moved`);
    }
    const wasOnGrid = cb.x % grid === 0 && cb.y % grid === 0;
    if ((moved || wasOnGrid) && (c.x % grid !== 0 || c.y % grid !== 0)) {
      violations.push(`Rule 5: component ${c.id} not on ${grid}-unit grid (${c.x},${c.y})`);
    }
    afterCompBounds.set(c.id, componentBounds(c));
    const lb = labelBounds(c);
    if (lb) afterLabelBounds.set(c.id, lb);
    for (const wp of worldPins(c)) {
      const pid = pinIdKey(c.id, wp.pin.id);
      afterPinPos.set(pid, wp.pos);
      const pk = ptKey(wp.pos);
      const list = afterPinsByPt.get(pk);
      if (list) list.push(pid);
      else afterPinsByPt.set(pk, [pid]);
    }
  }

  const afterTextById = new Map<string, TextNote>();
  const afterTextBounds = new Map<string, Rect>();
  for (const t of after.texts) {
    afterTextById.set(t.id, t);
    const tb = base.textById.get(t.id);
    if (!tb) {
      violations.push(`Rule 5: unexpected text note ${t.id}`);
      continue;
    }
    if (t.text !== tb.text || t.fontSize !== tb.fontSize) {
      violations.push(`Rule 5: text note ${t.id} content/fontSize changed`);
    }
    const moved = t.x !== tb.x || t.y !== tb.y;
    if (ids && !ids.has(t.id) && moved) {
      violations.push(`Rule 5: fixed text note ${t.id} moved`);
    }
    const wasOnGrid = tb.x % grid === 0 && tb.y % grid === 0;
    if ((moved || wasOnGrid) && (t.x % grid !== 0 || t.y % grid !== 0)) {
      violations.push(`Rule 5: text note ${t.id} not on ${grid}-unit grid (${t.x},${t.y})`);
    }
    afterTextBounds.set(t.id, textNoteBounds(t));
  }

  const afterWireById = new Map<string, Wire>();
  for (const w of after.wires) afterWireById.set(w.id, w);

  const keepAfter = protectedVertexKeys(after);

  // --- Rule 2, 3, 5 (wires) & Rule 8b (pin legs) ---
  for (const w of after.wires) {
    const wb = base.wireById.get(w.id);
    if (!wb) {
      violations.push(`Rule 5: unexpected wire ${w.id}`);
      continue;
    }
    if (w.width !== wb.width) {
      violations.push(`Rule 5: wire ${w.id} bus width changed`);
    }
    if (w.points.length !== wb.points.length) {
      violations.push(
        `Rule 2: wire ${w.id} point count changed (${wb.points.length} -> ${w.points.length})`,
      );
      continue;
    }
    const fixed = ids !== undefined && !ids.has(w.id);
    for (let i = 0; i < w.points.length; i++) {
      const p = w.points[i];
      const pb = wb.points[i];
      const moved = p.x !== pb.x || p.y !== pb.y;
      if (fixed && moved) {
        violations.push(`Rule 5: fixed wire ${w.id} point ${i} moved`);
        break;
      }
      const wasOnGrid = pb.x % grid === 0 && pb.y % grid === 0;
      if ((moved || wasOnGrid) && (p.x % grid !== 0 || p.y % grid !== 0)) {
        violations.push(`Rule 5: wire ${w.id} point ${i} not on ${grid}-unit grid (${p.x},${p.y})`);
        break;
      }
    }

    // Rule 2: normalizeWirePoints must not change wire
    if (base.wireNormalizedBare.get(w.id)) {
      if (!pointsArrayEqual(normalizeWirePoints(w.points), w.points)) {
        violations.push(`Rule 2: normalizeWirePoints modifies wire ${w.id}`);
      }
    } else if (base.wireNormalizedProtected.get(w.id)) {
      if (!pointsArrayEqual(normalizeWirePoints(w.points, keepAfter), w.points)) {
        violations.push(`Rule 2: protected normalizeWirePoints modifies wire ${w.id}`);
      }
    }

    // Rule 3: segment orientation, direction, min length >= grid
    for (let i = 0; i + 1 < w.points.length; i++) {
      const dx0 = wb.points[i + 1].x - wb.points[i].x;
      const dy0 = wb.points[i + 1].y - wb.points[i].y;
      const dx1 = w.points[i + 1].x - w.points[i].x;
      const dy1 = w.points[i + 1].y - w.points[i].y;
      if (dy0 === 0 && dx0 !== 0) {
        const minLen = Math.abs(dx0) >= grid ? grid : Math.abs(dx0);
        if (dy1 !== 0 || Math.sign(dx1) !== Math.sign(dx0) || Math.abs(dx1) < minLen) {
          violations.push(
            `Rule 3: wire ${w.id} horizontal segment ${i} orientation/direction/length violated`,
          );
          break;
        }
      } else if (dx0 === 0 && dy0 !== 0) {
        const minLen = Math.abs(dy0) >= grid ? grid : Math.abs(dy0);
        if (dx1 !== 0 || Math.sign(dy1) !== Math.sign(dy0) || Math.abs(dy1) < minLen) {
          violations.push(
            `Rule 3: wire ${w.id} vertical segment ${i} orientation/direction/length violated`,
          );
          break;
        }
      } else if (dx0 !== 0 || dy0 !== 0) {
        if (dx1 !== dx0 || dy1 !== dy0) {
          violations.push(`Rule 3: wire ${w.id} non-orthogonal segment ${i} distorted`);
          break;
        }
      }
    }

    // Rule 8b: pin exit legs keep straight exit >= 1 grid
    const exits = base.wirePinExits.get(w.id);
    if (exits) {
      for (const rec of exits) {
        const ep = w.points[rec.endIdx];
        const ap = w.points[rec.adjIdx];
        const dx = ap.x - ep.x;
        const dy = ap.y - ep.y;
        const len = Math.abs(dx) + Math.abs(dy);
        if (Math.sign(dx) !== rec.exit.x || Math.sign(dy) !== rec.exit.y || len < grid) {
          violations.push(`Rule 8: wire ${w.id} pin leg at vertex ${rec.endIdx} shortened or bent`);
        }
      }
    }
  }

  // Bail early if structure is fundamentally broken (missing ids/points)
  if (
    afterCompById.size !== base.compById.size ||
    afterWireById.size !== base.wireById.size ||
    afterTextById.size !== base.textById.size
  ) {
    return violations;
  }

  // --- Rule 4: Wire vertices & pin attachments ---
  const afterSegIndex = new SegmentIndex(after.wires);
  for (const w of after.wires) {
    const vPinMap = base.vertexPinAttachments.get(w.id);
    if (vPinMap) {
      for (const [vi, pinKeys] of vPinMap) {
        const p = w.points[vi];
        for (const pk of pinKeys) {
          const pinPos = afterPinPos.get(pk);
          if (!pinPos || pinPos.x !== p.x || pinPos.y !== p.y) {
            violations.push(`Rule 4: wire ${w.id} vertex ${vi} detached from pin ${pk}`);
          }
        }
      }
    }
    const vWireMap = base.vertexWireAttachments.get(w.id);
    if (vWireMap) {
      for (const [vi, refs] of vWireMap) {
        const p = w.points[vi];
        for (const ref of refs) {
          const host = afterWireById.get(ref.hostWireId);
          if (!host || ref.hostSegIdx + 1 >= host.points.length) {
            violations.push(`Rule 4: wire ${w.id} vertex ${vi} lost host wire ${ref.hostWireId}`);
            continue;
          }
          const a = host.points[ref.hostSegIdx];
          const b = host.points[ref.hostSegIdx + 1];
          if (!pointOnSegment(p, a, b)) {
            violations.push(
              `Rule 4: wire ${w.id} vertex ${vi} detached from T-junction on ${ref.hostWireId}`,
            );
          } else if (ref.strictInterior) {
            if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y)) {
              violations.push(
                `Rule 4: wire ${w.id} vertex ${vi} slid onto endpoint of ${ref.hostWireId}`,
              );
            }
          }
        }
      }
    }
  }

  // Verify pins stay attached to the exact same wires & coincident pins
  for (const [pid, pos] of afterPinPos) {
    const afterWires = [...afterSegIndex.wiresAt(pos)].map((wi) => after.wires[wi].id).sort();
    const beforeWires = base.pinWires.get(pid) ?? [];
    if (
      afterWires.length !== beforeWires.length ||
      afterWires.some((id, idx) => id !== beforeWires[idx])
    ) {
      violations.push(`Rule 4: pin ${pid} wire attachments changed`);
    }
    const afterCoinc = (afterPinsByPt.get(ptKey(pos)) ?? []).filter((x) => x !== pid).sort();
    const beforeCoinc = base.pinCoincidentPins.get(pid) ?? [];
    if (
      afterCoinc.length !== beforeCoinc.length ||
      afterCoinc.some((id, idx) => id !== beforeCoinc[idx])
    ) {
      violations.push(`Rule 4: pin ${pid} pin-to-pin abutment changed`);
    }
  }

  // --- Rule 1: Topology identical (buildNetlist) ---
  const afterNets = canonicalNetSignatures(after);
  if (
    afterNets.length !== base.netSignatures.length ||
    afterNets.some((s, i) => s !== base.netSignatures[i])
  ) {
    violations.push(`Rule 1: netlist topology changed`);
  }

  // --- Rule 7: No accidental connections & identical logical junctions ---
  const obsAfter = new RouteObstacles(after);
  for (const w of after.wires) {
    const self = new Set([w.id]);
    if (base.wireRouteClean.get(w.id)) {
      if (obsAfter.routeIsBad(w.points, self)) {
        violations.push(`Rule 7: wire ${w.id} created an accidental connection or body crossing`);
      }
    } else if (base.wireRouteCleanWithAllowed.get(w.id)) {
      const contacts = base.intentionalInteriorContacts.get(w.id) ?? [];
      const allowed = new Set<string>();
      for (const c of contacts) {
        const ow = afterWireById.get(c.otherWireId);
        if (ow && ow.points[c.vertexIdx]) {
          allowed.add(`${c.otherWireId}@${ptKey(ow.points[c.vertexIdx])}`);
        }
      }
      if (obsAfter.routeIsBad(w.points, self, allowed)) {
        violations.push(`Rule 7: T-junction trunk wire ${w.id} created an accidental connection or body crossing`);
      }
    }
  }

  const afterJunctions = logicalJunctionSignatures(after);
  if (
    afterJunctions.length !== base.junctionSignatures.length ||
    afterJunctions.some((s, i) => s !== base.junctionSignatures[i])
  ) {
    violations.push(`Rule 7: logical junction dots changed`);
  }

  // --- Rule 6: No overlaps ---
  const compGapPx = componentGap * grid;
  const wireGapPx = wireGap * grid;
  const comps = after.components;

  // 6a. Component body vs component body (+ componentGap)
  for (let i = 0; i < comps.length; i++) {
    const c1 = comps[i];
    const b1 = afterCompBounds.get(c1.id)!;
    for (let j = i + 1; j < comps.length; j++) {
      const c2 = comps[j];
      if (!involvesMovable(c1.id, c2.id)) continue;
      if (base.abuttingCompPairs.has(pairKey(c1.id, c2.id))) continue;
      const b2 = afterCompBounds.get(c2.id)!;
      const sep = rectSeparation(b1, b2);
      if (compGapPx > 0) {
        if (sep < compGapPx - EPS) {
          violations.push(
            `Rule 6: component bodies ${c1.id} and ${c2.id} closer than componentGap (${sep} < ${compGapPx})`,
          );
        }
      } else if (sep < -EPS) {
        violations.push(`Rule 6: component bodies ${c1.id} and ${c2.id} overlap`);
      }
    }
  }

  // 6b. Component labels vs bodies, other labels, texts, wires
  for (const [cid, lb] of afterLabelBounds) {
    for (const c2 of comps) {
      if (!involvesMovable(cid, c2.id)) continue;
      const b2 = afterCompBounds.get(c2.id)!;
      if (rectsIntersect(lb, b2)) {
        violations.push(`Rule 6: label of ${cid} overlaps body of ${c2.id}`);
      }
    }
    for (const [cid2, lb2] of afterLabelBounds) {
      if (cid >= cid2) continue;
      if (!involvesMovable(cid, cid2)) continue;
      if (rectsIntersect(lb, lb2)) {
        violations.push(`Rule 6: labels of ${cid} and ${cid2} overlap`);
      }
    }
    for (const w of after.wires) {
      if (!involvesMovable(cid, w.id)) continue;
      for (let si = 0; si + 1 < w.points.length; si++) {
        if (segIntersectsRectFast(w.points[si], w.points[si + 1], lb)) {
          violations.push(`Rule 6: label of ${cid} overlaps wire ${w.id}`);
          break;
        }
      }
    }
  }

  // 6c. Text notes vs bodies, labels, other texts, wires
  const texts = after.texts;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const tb = afterTextBounds.get(t.id)!;
    for (const c of comps) {
      if (!involvesMovable(t.id, c.id)) continue;
      if (rectsIntersect(tb, afterCompBounds.get(c.id)!)) {
        violations.push(`Rule 6: text note ${t.id} overlaps component ${c.id}`);
      }
      const lb = afterLabelBounds.get(c.id);
      if (lb && rectsIntersect(tb, lb)) {
        violations.push(`Rule 6: text note ${t.id} overlaps label of ${c.id}`);
      }
    }
    for (let j = i + 1; j < texts.length; j++) {
      const t2 = texts[j];
      if (!involvesMovable(t.id, t2.id)) continue;
      if (rectsIntersect(tb, afterTextBounds.get(t2.id)!)) {
        violations.push(`Rule 6: text notes ${t.id} and ${t2.id} overlap`);
      }
    }
    for (const w of after.wires) {
      if (!involvesMovable(t.id, w.id)) continue;
      for (let si = 0; si + 1 < w.points.length; si++) {
        if (segIntersectsRectFast(w.points[si], w.points[si + 1], tb)) {
          violations.push(`Rule 6: text note ${t.id} overlaps wire ${w.id}`);
          break;
        }
      }
    }
  }

  // 6d. Parallel wire segment spacing (wireGap) & wire vs unrelated body (wireGap)
  if (wireGapPx > 0) {
    const { hSegs, vSegs } = extractAxisSegments(after);
    for (const pair of [
      ...collectCloseParallelPairs(hSegs, wireGapPx),
      ...collectCloseParallelPairs(vSegs, wireGapPx),
    ]) {
      if (!involvesMovable(pair.w1, pair.w2)) continue;
      const pk = segPairKey(pair.w1, pair.s1, pair.w2, pair.s2);
      const prevDist = base.beforeTightParallelDist.get(pk);
      const minAllowed = prevDist !== undefined ? prevDist : wireGapPx;
      if (pair.dist < minAllowed - EPS) {
        violations.push(
          `Rule 6: parallel wire segments ${pair.w1}[${pair.s1}] and ${pair.w2}[${pair.s2}] closer than wireGap (${pair.dist} < ${minAllowed})`,
        );
      }
    }

    for (const w of after.wires) {
      const relMap = base.segRelatedComps.get(w.id);
      for (let si = 0; si + 1 < w.points.length; si++) {
        const a = w.points[si];
        const b = w.points[si + 1];
        const rel = relMap?.get(si);
        for (const c of comps) {
          if (rel?.has(c.id)) continue;
          if (!involvesMovable(w.id, c.id)) continue;
          const d = segRectSeparation(a, b, afterCompBounds.get(c.id)!);
          if (d < wireGapPx - EPS) {
            const prevDist = base.beforeTightSegBodyDist.get(`${w.id}#${si}\0${c.id}`);
            const minAllowed = prevDist !== undefined ? prevDist : wireGapPx;
            if (d < minAllowed - EPS) {
              violations.push(
                `Rule 6: wire ${w.id}[${si}] too close to unrelated body ${c.id} (${d} < ${minAllowed})`,
              );
            }
          }
        }
      }
    }
  }

  // --- Rule 8a: Relative ordering preserved ---
  for (let i = 0; i < comps.length; i++) {
    const cA = comps[i];
    const bBeforeA = base.compBounds.get(cA.id)!;
    const bAfterA = afterCompBounds.get(cA.id)!;
    for (let j = i + 1; j < comps.length; j++) {
      const cB = comps[j];
      const bBeforeB = base.compBounds.get(cB.id)!;
      const bAfterB = afterCompBounds.get(cB.id)!;

      if (bBeforeA.x + bBeforeA.w <= bBeforeB.x) {
        if (bAfterA.x + bAfterA.w > bAfterB.x) {
          violations.push(`Rule 8: relative X order violated (${cA.id} no longer left of ${cB.id})`);
        }
      } else if (bBeforeB.x + bBeforeB.w <= bBeforeA.x) {
        if (bAfterB.x + bAfterB.w > bAfterA.x) {
          violations.push(`Rule 8: relative X order violated (${cB.id} no longer left of ${cA.id})`);
        }
      }

      if (bBeforeA.y + bBeforeA.h <= bBeforeB.y) {
        if (bAfterA.y + bAfterA.h > bAfterB.y) {
          violations.push(`Rule 8: relative Y order violated (${cA.id} no longer above ${cB.id})`);
        }
      } else if (bBeforeB.y + bBeforeB.h <= bBeforeA.y) {
        if (bAfterB.y + bAfterB.h > bAfterA.y) {
          violations.push(`Rule 8: relative Y order violated (${cB.id} no longer above ${cA.id})`);
        }
      }
    }
  }

  // --- Rule 9: Area never increases ---
  const areaAfter = documentArea(after);
  if (areaAfter > base.areaBefore + EPS) {
    violations.push(`Rule 9: document area increased (${base.areaBefore} -> ${areaAfter})`);
  }
  if (ids && base.subsetAreaBefore !== null) {
    const subAfter = subsetArea(after, ids);
    if (subAfter > base.subsetAreaBefore + EPS) {
      violations.push(`Rule 9: subset area increased (${base.subsetAreaBefore} -> ${subAfter})`);
    }
  }

  return base.preexisting.size > 0 ? violations.filter((v) => !base.preexisting.has(v)) : violations;
}

/**
 * Validate that `after` is a legal packing of `before` under `opts`.
 * Returns an empty array when all rules 1–9 hold, or a list of violation descriptions.
 */
export function validatePacking(
  before: SchematicDocument,
  after: SchematicDocument,
  opts?: PackOptions,
): string[] {
  const baseline = prepareValidationBaseline(before, opts);
  return validateAgainstBaseline(baseline, after);
}

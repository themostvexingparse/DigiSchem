/**
 * Smart guides for moving components (pure, DOM-free).
 *
 * Peers are components of the SAME TYPE and the SAME WORLD SIZE as the dragged "anchor"
 * component. While dragging:
 *  - Alignment: when the anchor's left/center/right (or top/middle/bottom) lines up with a
 *    peer, a guide line is shown through all aligned peers; within `snapDist` it snaps.
 *  - Equal spacing: peers sharing the anchor's row (same top) or column (same left) form a
 *    sequence; if the anchor's gap to its neighbour equals a gap between other neighbours in
 *    that sequence (or it sits midway between two neighbours), spacing bars are shown on every
 *    equal gap; within `snapDist` it snaps to that gap.
 */
import type { ComponentInstance, Point, SchematicDocument } from "../model/types";
import { componentBounds, type Rect } from "../model/geometry";

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GuideResult {
  /** Adjustment to add to the proposed move delta (zero when nothing snaps). */
  adjust: Point;
  /** Alignment guide lines (world coords). */
  lines: GuideLine[];
  /** Equal-spacing bars (world coords): each spans one gap between two neighbours. */
  spacings: GuideLine[];
}

const EMPTY: GuideResult = { adjust: { x: 0, y: 0 }, lines: [], spacings: [] };

type Axis = "x" | "y";

function shifted(r: Rect, d: Point): Rect {
  return { x: r.x + d.x, y: r.y + d.y, w: r.w, h: r.h };
}

/** Peers of the anchor: same type and same world bounds size, not part of the moving set. */
export function guidePeers(doc: SchematicDocument, anchor: ComponentInstance, moving: ReadonlySet<string>): Rect[] {
  const ab = componentBounds(anchor);
  const out: Rect[] = [];
  for (const c of doc.components) {
    if (c.id === anchor.id || moving.has(c.id) || c.type !== anchor.type) continue;
    const b = componentBounds(c);
    if (b.w === ab.w && b.h === ab.h) out.push(b);
  }
  return out;
}

/**
 * @param anchorOrig the anchor's bounds BEFORE the drag
 * @param delta      proposed move delta (grid-snapped)
 * @param snapDist   snap distance in world units (0 = show guides only)
 */
export function computeGuides(anchorOrig: Rect, peers: readonly Rect[], delta: Point, snapDist: number): GuideResult {
  if (peers.length === 0) return EMPTY;
  const adjust = { x: 0, y: 0 };

  // ---- 1) alignment snap per axis (left/center/right in x, top/middle/bottom in y) ----
  for (const axis of ["x", "y"] as Axis[]) {
    const pos = (r: Rect) => (axis === "x" ? r.x : r.y);
    const cur = pos(anchorOrig) + (axis === "x" ? delta.x : delta.y);
    let best: number | null = null;
    for (const p of peers) {
      const d = pos(p) - cur; // same size ⇒ aligning one edge aligns all three references
      if (Math.abs(d) <= snapDist && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) adjust[axis] = best;
  }

  // ---- 2) equal-spacing snap along each axis (only if not already aligned on that axis) ----
  const spacingAdjust = (axis: Axis): number | null => {
    const cross: Axis = axis === "x" ? "y" : "x";
    const a = shifted(anchorOrig, { x: delta.x + adjust.x, y: delta.y + adjust.y });
    const crossPos = (r: Rect) => (cross === "x" ? r.x : r.y);
    const lo = (r: Rect) => (axis === "x" ? r.x : r.y);
    const len = (r: Rect) => (axis === "x" ? r.w : r.h);
    const line = peers.filter((p) => crossPos(p) === crossPos(a)).sort((p, q) => lo(p) - lo(q));
    if (line.length < 1) return null;
    const before = line.filter((p) => lo(p) + len(p) <= lo(a)).pop();
    const after = line.find((p) => lo(p) >= lo(a) + len(a));
    const gaps: number[] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const g = lo(line[i + 1]) - (lo(line[i]) + len(line[i]));
      if (g > 0) gaps.push(g);
    }
    let best: number | null = null;
    const consider = (d: number) => {
      if (Math.abs(d) <= snapDist && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    };
    if (before) for (const g of gaps) consider(lo(before) + len(before) + g - lo(a)); // gap after left neighbour
    if (after) for (const g of gaps) consider(lo(after) - g - len(a) - lo(a)); // gap before right neighbour
    if (before && after) {
      const mid = (lo(before) + len(before) + lo(after) - len(a)) / 2; // centered between them
      if (Number.isInteger(mid / 10)) consider(mid - lo(a));
    }
    return best;
  };
  if (snapDist > 0) {
    if (adjust.x === 0) {
      const sx = spacingAdjust("x");
      if (sx !== null) adjust.x = sx;
    }
    if (adjust.y === 0) {
      const sy = spacingAdjust("y");
      if (sy !== null) adjust.y = sy;
    }
  }

  // ---- visuals for the final position ----
  const a = shifted(anchorOrig, { x: delta.x + adjust.x, y: delta.y + adjust.y });
  const lines: GuideLine[] = [];
  const alignedX = peers.filter((p) => p.x === a.x);
  if (alignedX.length > 0) {
    const all = [...alignedX, a];
    const top = Math.min(...all.map((r) => r.y)) - 10;
    const bottom = Math.max(...all.map((r) => r.y + r.h)) + 10;
    for (const x of [a.x, a.x + a.w / 2, a.x + a.w]) lines.push({ x1: x, y1: top, x2: x, y2: bottom });
  }
  const alignedY = peers.filter((p) => p.y === a.y);
  if (alignedY.length > 0) {
    const all = [...alignedY, a];
    const left = Math.min(...all.map((r) => r.x)) - 10;
    const right = Math.max(...all.map((r) => r.x + r.w)) + 10;
    for (const y of [a.y, a.y + a.h / 2, a.y + a.h]) lines.push({ x1: left, y1: y, x2: right, y2: y });
  }

  const spacings: GuideLine[] = [];
  for (const axis of ["x", "y"] as Axis[]) {
    const cross: Axis = axis === "x" ? "y" : "x";
    const crossPos = (r: Rect) => (cross === "x" ? r.x : r.y);
    const lo = (r: Rect) => (axis === "x" ? r.x : r.y);
    const len = (r: Rect) => (axis === "x" ? r.w : r.h);
    const seq = [...peers.filter((p) => crossPos(p) === crossPos(a)), a].sort((p, q) => lo(p) - lo(q));
    if (seq.length < 3) continue;
    const gapOf = (i: number) => lo(seq[i + 1]) - (lo(seq[i]) + len(seq[i]));
    const ai = seq.indexOf(a);
    const anchorGaps = new Set<number>();
    if (ai > 0) anchorGaps.add(gapOf(ai - 1));
    if (ai + 1 < seq.length) anchorGaps.add(gapOf(ai));
    for (const g of anchorGaps) {
      if (g <= 0) continue;
      const matches: number[] = [];
      for (let i = 0; i + 1 < seq.length; i++) if (gapOf(i) === g) matches.push(i);
      if (matches.length < 2) continue; // need the anchor's gap to equal at least one other gap
      for (const i of matches) {
        const from = lo(seq[i]) + len(seq[i]);
        const to = lo(seq[i + 1]);
        // Bar drawn just outside the row/column (below a row, right of a column).
        const r = seq[i];
        const off = (cross === "y" ? Math.max(r.y + r.h, seq[i + 1].y + seq[i + 1].h) : Math.max(r.x + r.w, seq[i + 1].x + seq[i + 1].w)) + 12;
        spacings.push(axis === "x" ? { x1: from, y1: off, x2: to, y2: off } : { x1: off, y1: from, x2: off, y2: to });
      }
    }
  }
  return { adjust, lines, spacings };
}

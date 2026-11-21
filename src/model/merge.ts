/**
 * Merge wires that meet END TO END with nothing else there: two wire endpoints at one point,
 * no pin, no third wire touching it, and the two wires connected to each other. Such a joint is
 * not a junction — just a seam left by drawing a wire onward from the end of another — so the
 * two become one wire (the first keeps its id; the second's connections move to it).
 * Never merges across a conflict (wires touching without being connected) or different widths.
 */
import type { Point, SchematicDocument, Wire } from "./types";
import { SegmentIndex, worldPins } from "./geometry";
import { canonicalLinks } from "./links";
import { normalizeWirePoints, pathOverlapsItself } from "../editor/wire-utils";

const key = (p: Point) => `${p.x},${p.y}`;

/** Merge all end-to-end seams in `doc` (in place). Returns how many merges were made. */
export function mergeWireSeams(doc: SchematicDocument): number {
  let merges = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const m = findSeam(doc);
    if (!m) break;
    applyMerge(doc, m.a, m.b, m.at);
    merges++;
  }
  return merges;
}

function findSeam(doc: SchematicDocument): { a: Wire; b: Wire; at: Point } | null {
  const pins = new Set<string>();
  for (const c of doc.components) for (const wp of worldPins(c)) pins.add(key(wp.pos));
  const ends = new Map<string, Wire[]>();
  for (const w of doc.wires) {
    if (w.points.length < 2) continue;
    const s = w.points[0], e = w.points[w.points.length - 1];
    if (key(s) === key(e)) continue; // zero-length or closed: leave alone
    for (const p of [s, e]) {
      const l = ends.get(key(p));
      if (l) l.push(w);
      else ends.set(key(p), [w]);
    }
  }
  const linked = doc.links ? new Set(doc.links.map(([x, y]) => `${x}\u0000${y}`)) : null;
  const isLinked = (a: string, b: string) => {
    if (!linked) return true; // no stored connections: touching means connected
    const [x, y] = a < b ? [a, b] : [b, a];
    return linked.has(`${x}\u0000${y}`);
  };
  let index: SegmentIndex | null = null;
  const wireIdx = new Map(doc.wires.map((w, i) => [w.id, i]));
  for (const [k, list] of ends) {
    if (list.length !== 2 || list[0] === list[1] || pins.has(k)) continue;
    const [a, b] = list;
    if ((a.width ?? 1) !== (b.width ?? 1)) continue;
    if (!isLinked(`w:${a.id}`, `w:${b.id}`)) continue;
    // nothing else may touch the point (a third wire passing through or ending on it)
    index ??= new SegmentIndex(doc.wires);
    const [x, y] = k.split(",").map(Number);
    const at = { x, y };
    const touching = [...index.wiresAt(at)].filter((i) => i !== wireIdx.get(a.id) && i !== wireIdx.get(b.id));
    if (touching.length > 0) continue;
    // the merged path must not double back over itself along one line through the seam
    if (foldsBack(a, b, at)) continue;
    // …nor anywhere else (two wires that already overlap stay two wires)
    if (pathOverlapsItself(mergedPath(a, b, at))) continue;
    return { a, b, at };
  }
  return null;
}

function oriented(w: Wire, endAt: Point): Point[] {
  const last = w.points[w.points.length - 1];
  return key(last) === key(endAt) ? w.points.map((p) => ({ ...p })) : [...w.points].reverse().map((p) => ({ ...p }));
}

function foldsBack(a: Wire, b: Wire, at: Point): boolean {
  const pa = oriented(a, at); // ends at `at`
  const pb = oriented(b, at).reverse(); // starts at `at`
  const p = pa[pa.length - 2], q = pb[1];
  const sameLine = (p.x === at.x && q.x === at.x) || (p.y === at.y && q.y === at.y);
  if (!sameLine) return false;
  const d1 = Math.sign(at.x - p.x) || Math.sign(at.y - p.y);
  const d2 = Math.sign(q.x - at.x) || Math.sign(q.y - at.y);
  return d1 !== d2;
}

function mergedPath(a: Wire, b: Wire, at: Point): Point[] {
  const pa = oriented(a, at);
  const pb = oriented(b, at).reverse();
  return normalizeWirePoints([...pa, ...pb.slice(1)]);
}

function applyMerge(doc: SchematicDocument, a: Wire, b: Wire, at: Point): void {
  a.points = mergedPath(a, b, at);
  doc.wires = doc.wires.filter((w) => w !== b);
  if (doc.links) {
    const A = `w:${a.id}`, B = `w:${b.id}`;
    doc.links = canonicalLinks(
      doc.links
        .map(([x, y]) => [x === B ? A : x, y === B ? A : y] as [string, string])
        .filter(([x, y]) => x !== y),
    );
  }
}

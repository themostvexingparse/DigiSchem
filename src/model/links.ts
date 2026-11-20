/**
 * Logical connectivity ("links") maintenance and connection-conflict detection.
 *
 * The document stores WHAT CONNECTS TO WHAT (`doc.links`) separately from the drawing. The
 * DocumentStore keeps it up to date with one rule, applied after every edit:
 *   - links between items that still exist are KEPT — so moving, rotating, resizing or compacting
 *     can never connect or disconnect anything, however the drawing ends up overlapping;
 *   - links of deleted wires / components / pins are dropped;
 *   - only terminals that are NEW in this edit (a drawn wire, a placed or pasted part, a pin added
 *     by a property change) are connected by touch, from the drawing.
 * Where the drawing and the links disagree, `connectionConflicts` reports it so the editor can
 * warn — the connections themselves are never lost.
 */
import type { Point, SchematicDocument } from "./types";
import { worldPins } from "./geometry";
import { geometricContacts, pinTerm, wireTerm, type Terminal } from "../io/netlist";

export function terminalsOf(doc: SchematicDocument): Set<Terminal> {
  const out = new Set<Terminal>();
  for (const w of doc.wires) out.add(wireTerm(w.id));
  for (const c of doc.components) for (const wp of worldPins(c)) out.add(pinTerm(c.id, wp.pin.id));
  return out;
}

export function canonicalLinks(links: Iterable<readonly [string, string]>): [string, string][] {
  const m = new Map<string, [string, string]>();
  for (const [a, b] of links) {
    if (a === b) continue;
    const pair: [string, string] = a < b ? [a, b] : [b, a];
    m.set(`${pair[0]}\u0000${pair[1]}`, pair);
  }
  return [...m.values()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
}

/** Links read from the drawing (used for documents that have none yet). */
export function inferLinks(doc: SchematicDocument): [string, string][] {
  return canonicalLinks(geometricContacts(doc).map((c) => [c.a, c.b] as const));
}

/** Update `draft.links` after an edit from `before` (see the module comment). */
export function maintainLinks(before: SchematicDocument, draft: SchematicDocument): void {
  const prev = before.links ?? inferLinks(before);
  const now = terminalsOf(draft);
  const old = before.links || before.wires.length || before.components.length ? terminalsOf(before) : new Set<Terminal>();
  const kept: [string, string][] = prev.filter(([a, b]) => now.has(a) && now.has(b));
  const fresh = new Set<Terminal>();
  for (const t of now) if (!old.has(t)) fresh.add(t);
  if (fresh.size > 0) {
    for (const c of geometricContacts(draft)) if (fresh.has(c.a) || fresh.has(c.b)) kept.push([c.a, c.b]);
  }
  draft.links = canonicalLinks(kept);
}

// ---------------------------------------------------------------------------------------------

export interface ConnectionConflict {
  /** "unintended": two items touch that are not connected; "broken": connected items no longer touch. */
  kind: "unintended" | "broken";
  at: Point;
  a: Terminal;
  b: Terminal;
}

class UF {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = x;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    let c = x;
    while (c !== r) {
      const n = this.p.get(c) ?? r;
      this.p.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

/**
 * Where the drawing disagrees with the stored connections. Tunnels are ignored (they join nets
 * by name in both views). Empty when the document has no links.
 */
export function connectionConflicts(doc: SchematicDocument): ConnectionConflict[] {
  if (!doc.links) return [];
  const terms = terminalsOf(doc);
  const contacts = geometricContacts(doc);
  const logical = new UF();
  for (const [a, b] of doc.links) if (terms.has(a) && terms.has(b)) logical.union(a, b);
  const geo = new UF();
  for (const c of contacts) geo.union(c.a, c.b);
  const out: ConnectionConflict[] = [];
  for (const c of contacts) {
    if (logical.find(c.a) !== logical.find(c.b)) out.push({ kind: "unintended", at: c.at, a: c.a, b: c.b });
  }
  // locations of terminals, for "broken" markers
  const pinPos = new Map<Terminal, Point>();
  for (const comp of doc.components) for (const wp of worldPins(comp)) pinPos.set(pinTerm(comp.id, wp.pin.id), wp.pos);
  const wirePts = new Map<Terminal, Point[]>();
  for (const w of doc.wires) wirePts.set(wireTerm(w.id), w.points);
  const near = (t: Terminal, other: Terminal): Point => {
    const target = pinPos.get(other) ?? wirePts.get(other)?.[0];
    const p = pinPos.get(t);
    if (p) return p;
    const pts = wirePts.get(t) ?? [];
    const ends = pts.length ? [pts[0], pts[pts.length - 1]] : [];
    if (!target || ends.length === 0) return ends[0] ?? { x: 0, y: 0 };
    return ends.reduce((m, e) => (Math.abs(e.x - target.x) + Math.abs(e.y - target.y) < Math.abs(m.x - target.x) + Math.abs(m.y - target.y) ? e : m));
  };
  for (const [a, b] of doc.links) {
    if (!terms.has(a) || !terms.has(b)) continue;
    if (geo.find(a) !== geo.find(b)) out.push({ kind: "broken", at: near(a.startsWith("p:") ? a : b, a.startsWith("p:") ? b : a), a, b });
  }
  return out;
}

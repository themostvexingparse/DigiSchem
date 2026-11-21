/**
 * Logical connectivity ("links") maintenance and connection-conflict detection.
 *
 * The document stores WHAT CONNECTS TO WHAT (`doc.links`) separately from the drawing. The
 * DocumentStore keeps it up to date with one rule, applied after every edit:
 *   - links between items that still exist are KEPT — so moving, rotating, resizing or compacting
 *     can never connect or disconnect anything, however the drawing ends up overlapping;
 *   - links of deleted wires / components / pins are dropped — but what was connected THROUGH a
 *     removed pin stays connected (only deleting a wire cuts a connection);
 *   - only terminals that are NEW in this edit (a drawn wire, a placed or pasted part, a pin added
 *     by a property change) are connected by touch, from the drawing.
 * Where the drawing and the links disagree, `connectionConflicts` reports it so the editor can
 * warn — the connections themselves are never lost.
 */
import type { Point, SchematicDocument } from "./types";
import { effectiveProps, worldPins } from "./geometry";
import { geometricContacts, pinTerm, wireTerm, type Contact, type Terminal } from "../io/netlist";

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

/** Pin terminals that DRIVE a net (outputs; tri-state outputs and pull resistors may share). */
function driverTerms(doc: SchematicDocument): Set<Terminal> {
  const out = new Set<Terminal>();
  for (const c of doc.components) {
    if (c.type === "tristate" || c.type === "pull-up" || c.type === "pull-down") continue;
    for (const wp of worldPins(c)) if (wp.pin.dir === "out") out.add(pinTerm(c.id, wp.pin.id));
  }
  return out;
}

/**
 * How deliberate a geometric contact looks: 0 wire end on a pin, 1 wire end on a wire, 2 other.
 * With `fresh` (the terminals an edit just created), a wire-on-wire contact is only deliberate
 * when it is the NEW wire's end that lands there — an old wire's end that a new wire merely runs
 * over is an accident of the drawing.
 */
function contactIntent(doc: SchematicDocument, c: Contact, fresh?: ReadonlySet<Terminal>): number {
  const ends = (t: Terminal) => {
    if (!t.startsWith("w:")) return [] as Point[];
    const w = doc.wires.find((x) => x.id === t.slice(2));
    return w && w.points.length ? [w.points[0], w.points[w.points.length - 1]] : [];
  };
  const atEnd = (t: Terminal) => ends(t).some((p) => p.x === c.at.x && p.y === c.at.y);
  const pinSide = c.a.startsWith("p:") || c.b.startsWith("p:");
  if (pinSide) {
    const wire = c.a.startsWith("w:") ? c.a : c.b.startsWith("w:") ? c.b : null;
    return wire && atEnd(wire) ? 0 : wire ? 2 : 0; // pin-on-pin abutment counts as deliberate
  }
  if (fresh && (fresh.has(c.a) || fresh.has(c.b))) {
    return (fresh.has(c.a) && atEnd(c.a)) || (fresh.has(c.b) && atEnd(c.b)) ? 1 : 2;
  }
  return atEnd(c.a) || atEnd(c.b) ? 1 : 2;
}

/**
 * Read connections from contacts, most deliberate first, never letting a contact put two
 * outputs on one net — that is a short in the drawing, not something anyone draws on purpose.
 * Such contacts are left unconnected (and reported by `connectionConflicts`). With `only`, just
 * the contacts touching those terminals are considered (and accidental-looking ones of them are
 * subject to the driver rule; deliberate ones — a wire drawn onto a pin — always connect).
 */
function linksFromContacts(
  doc: SchematicDocument,
  contacts: Contact[],
  base: [string, string][],
  guardAll: boolean,
  fresh?: ReadonlySet<Terminal>,
): [string, string][] {
  const drivers = driverTerms(doc);
  const parent = new Map<string, string>();
  const nDrv = new Map<string, number>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r)) r = parent.get(r)!;
    let c = x;
    while (parent.has(c) && parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const drv = (r: string) => nDrv.get(r) ?? (drivers.has(r) ? 1 : 0);
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const n = drv(ra) + drv(rb);
    parent.set(ra, rb);
    nDrv.set(rb, n);
  };
  for (const [a, b] of base) union(a, b);
  const out = [...base];
  const ranked = contacts.map((c) => ({ c, k: contactIntent(doc, c, fresh) })).sort((x, y) => x.k - y.k);
  for (const { c, k } of ranked) {
    const ra = find(c.a), rb = find(c.b);
    if (ra !== rb && (guardAll || k === 2) && drv(ra) > 0 && drv(rb) > 0) continue; // would short two outputs
    union(c.a, c.b);
    out.push([c.a, c.b]);
  }
  return out;
}

/** Links read from the drawing (used for documents that have none yet). */
export function inferLinks(doc: SchematicDocument): [string, string][] {
  return canonicalLinks(linksFromContacts(doc, geometricContacts(doc), [], true));
}

/**
 * A removed PIN (its part deleted, or the pin dropped by a property change) is not a conductor
 * anyone meant to cut: whatever was connected THROUGH it stays connected to each other. (A removed
 * wire is different — deleting a wire is how connections are cut.)
 */
function bridgeRemovedPins(prev: readonly [string, string][], now: ReadonlySet<Terminal>): [string, string][] {
  const adj = new Map<string, string[]>();
  for (const [a, b] of prev) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const gone = (t: string) => t.startsWith("p:") && !now.has(t);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const t of adj.keys()) {
    if (!gone(t) || seen.has(t)) continue;
    // all surviving terminals reachable from t through removed pins
    const survivors = new Set<string>();
    const stack = [t];
    seen.add(t);
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of adj.get(x) ?? []) {
        if (now.has(y)) survivors.add(y);
        else if (gone(y) && !seen.has(y)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    const list = [...survivors].sort();
    for (let i = 1; i < list.length; i++) out.push([list[0], list[i]]);
  }
  return out;
}

export interface MaintainOptions {
  /**
   * Connect NEW terminals by touch (default true: a drawn wire, a placed part). Paste / duplicate
   * pass false — a copy keeps exactly the connections it had among the copied items (supplied by
   * the edit in `draft.links`) and joins nothing it merely lands on.
   */
  connectByTouch?: boolean;
}

/** Update `draft.links` after an edit from `before` (see the module comment). */
export function maintainLinks(before: SchematicDocument, draft: SchematicDocument, opts: MaintainOptions = {}): void {
  const prev = before.links ?? inferLinks(before);
  const now = terminalsOf(draft);
  const old = before.links || before.wires.length || before.components.length ? terminalsOf(before) : new Set<Terminal>();
  const kept: [string, string][] = prev.filter(([a, b]) => now.has(a) && now.has(b));
  kept.push(...bridgeRemovedPins(prev, now));
  const fresh = new Set<Terminal>();
  for (const t of now) if (!old.has(t)) fresh.add(t);
  // links the edit itself supplied for its new items (e.g. a pasted copy's internal connections)
  if (before.links && draft.links && draft.links !== before.links) {
    for (const [a, b] of draft.links) if ((fresh.has(a) || fresh.has(b)) && now.has(a) && now.has(b)) kept.push([a, b]);
  }
  if (fresh.size > 0 && opts.connectByTouch !== false) {
    const touching = geometricContacts(draft).filter((c) => fresh.has(c.a) || fresh.has(c.b));
    draft.links = canonicalLinks(linksFromContacts(draft, touching, kept, false, fresh));
    return;
  }
  draft.links = canonicalLinks(kept);
}

// ---------------------------------------------------------------------------------------------

export interface ConnectionConflict {
  /**
   * "unintended": two items touch that are not connected; "broken": connected items no longer
   * touch; "drivers": a connected net has more than one output driving it.
   */
  kind: "unintended" | "broken" | "drivers";
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
  // electrical rule: two outputs on one connected net (tunnels of the same name are one net)
  const tunnelFirst = new Map<string, Terminal>();
  for (const comp of doc.components) {
    if (comp.type !== "tunnel") continue;
    const nm = effectiveProps(comp).name;
    const name = typeof nm === "string" ? nm.trim() : "";
    if (!name) continue;
    for (const wp of worldPins(comp)) {
      const t = pinTerm(comp.id, wp.pin.id);
      const first = tunnelFirst.get(name);
      if (first) logical.union(first, t);
      else tunnelFirst.set(name, t);
    }
  }
  const firstDriver = new Map<string, Terminal>();
  for (const d of driverTerms(doc)) {
    const r = logical.find(d);
    const first = firstDriver.get(r);
    if (!first) firstDriver.set(r, d);
    else out.push({ kind: "drivers", at: pinPos.get(d) ?? { x: 0, y: 0 }, a: first, b: d });
  }
  return out;
}

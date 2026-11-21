/**
 * Realign stage of the layout packer: moves single components back onto the row / column of
 * their same-type, same-size peers AND re-routes their wires (with the editor's branch-point
 * preserving router). The shape-preserving compactor cannot do this on its own: a part that was
 * dragged out of line got extra bends in its wires, and only re-routing can take them out.
 *
 * A move is kept only if
 *   - connectivity is identical (same netlist),
 *   - it creates no new collision and no new short (quality stays finite),
 *   - the total number of wire bends does not grow, and every re-routed wire is clean,
 *   - and the weighted layout quality strictly improves.
 */
import type { SchematicDocument } from "../model/types";
import { componentBounds, worldPins } from "../model/geometry";
import { buildNetlist } from "../io/netlist";
import { keepWiresAttached } from "../editor/doc-ops";
import { normalizeWirePoints, stretchWireStart } from "../editor/wire-utils";
import { RouteObstacles, sameNetWires } from "../editor/safe-route";
import { connectionConflicts } from "../model/links";
import { layoutQuality, type QualityBreakdown, type QualityWeights } from "./quality";
import { prepareValidationBaseline, validateAgainstBaseline, validatePacking } from "./validate";

/**
 * Packing-rule violations a realign move may cause on purpose: only the shape-related ones of
 * the wires it re-routed (shape, vertex positions, pin legs), plus junction dots and area (the
 * quality score weighs those). Clearance, overlaps, accidental connections, part order, fixed
 * parts and connectivity stay enforced.
 */
function exempt(msg: string, rerouted: ReadonlySet<string>, attachedTo: ReadonlyMap<string, Set<string>>): boolean {
  if (/^Rule 9:/.test(msg) || /^Rule 7: logical junction dots changed/.test(msg)) return true;
  // clearance between a re-routed wire and the part it connects to (the validator's segment ↔
  // part relations come from the wire's old shape)
  const c = /^Rule 6: wire ([^\s\[]+)\[\d+\] too close to unrelated body (\S+)/.exec(msg);
  if (c) return rerouted.has(c[1]) && (attachedTo.get(c[1])?.has(c[2]) ?? false);
  const m = /^Rule (\d+): (?:protected )?(?:normalizeWirePoints modifies )?wire ([^\s\[]+)/.exec(msg);
  if (!m) return false;
  const rule = Number(m[1]);
  if (!rerouted.has(m[2])) return false;
  if (rule === 2 || rule === 3) return true;
  if (rule === 4 && /vertex/.test(msg)) return true;
  if (rule === 8 && /pin leg/.test(msg)) return true;
  return false;
}

function ruleProblems(violations: string[], rerouted: ReadonlySet<string>, doc: SchematicDocument): string[] {
  // wire → components its ends sit on
  const pinOwner = new Map<string, string>();
  for (const c of doc.components) for (const wp of worldPins(c)) pinOwner.set(`${wp.pos.x},${wp.pos.y}`, c.id);
  const attachedTo = new Map<string, Set<string>>();
  for (const w of doc.wires) {
    if (!rerouted.has(w.id)) continue;
    const s = new Set<string>();
    for (const e of [w.points[0], w.points[w.points.length - 1]]) {
      const o = e && pinOwner.get(`${e.x},${e.y}`);
      if (o) s.add(o);
    }
    attachedTo.set(w.id, s);
  }
  // With stored connections, accidental pin-on-pin contacts (no stored pin-to-pin connection)
  // may come apart, and the netlist is compared by the caller (sameConnectivity).
  const pinPinLinked = new Set<string>();
  for (const [a, b] of doc.links ?? []) {
    if (a.startsWith("p:") && b.startsWith("p:")) for (const t of [a, b]) pinPinLinked.add(t.slice(2).replace("|", ":"));
  }
  return violations.filter((v) => {
    if (exempt(v, rerouted, attachedTo)) return false;
    if (doc.links) {
      if (/^Rule 1: netlist topology changed/.test(v)) return false;
      const m = /^Rule 4: pin (\S+) pin-to-pin abutment changed/.exec(v);
      if (m && !pinPinLinked.has(m[1])) return false;
    }
    return true;
  });
}

export interface RealignResult {
  doc: SchematicDocument;
  /** Components moved back into line. */
  moved: string[];
  /** Wires whose shape was re-routed. */
  rerouted: string[];
}

export interface RealignOptions {
  /** Only these components may move (and only wires in this set may be re-routed). */
  ids?: ReadonlySet<string>;
  deadline: number;
  /** Largest move considered, in grid cells (default 12). */
  maxCells?: number;
}

/** Canonical connectivity signature (pins per net). */
export function netSignature(doc: SchematicDocument): string {
  return buildNetlist(doc, "geometric")
    .nets.map((n) => n.pins.map((p) => `${p.componentId}.${p.pinId}`).sort().join(","))
    .filter((s) => s.length > 0)
    .sort()
    .join("|");
}

const bendsOf = (doc: SchematicDocument) => doc.wires.reduce((n, w) => n + Math.max(0, w.points.length - 2), 0);

/**
 * With stored connections, the drawing may change what TOUCHES (e.g. two stacked parts pulled
 * apart) — as long as it does not get worse: no stored connection newly drawn apart, no new
 * accidental contact.
 */
function drawingRegressed(before: SchematicDocument, after: SchematicDocument): boolean {
  const count = (d: SchematicDocument) => {
    const c = connectionConflicts(d);
    return { broken: c.filter((x) => x.kind === "broken").length, unintended: c.filter((x) => x.kind === "unintended").length };
  };
  const a = count(before), b = count(after);
  return b.broken > a.broken || b.unintended > a.unintended;
}

/** Same connectivity: identical drawn nets, or (with stored connections) a drawing that agrees with them no worse. */
function sameConnectivity(before: SchematicDocument, after: SchematicDocument, sigBefore = netSignature(before)): boolean {
  if (netSignature(after) === sigBefore) return true;
  return !!after.links && JSON.stringify(after.links) === JSON.stringify(before.links) && !drawingRegressed(before, after);
}

/** Packing-order violations involving one of `ids` (a part pulled off another must change order). */
function orderRuleOf(msg: string, ids: ReadonlySet<string>): boolean {
  const m = /^Rule 8: relative [XY] order violated \((\S+) no longer (?:left of|above) (\S+)\)/.exec(msg);
  return !!m && (ids.has(m[1]) || ids.has(m[2]));
}

/** Pairs of parts whose bodies overlap (one drawn on top of the other). */
export function overlappingPartPairs(doc: SchematicDocument): [string, string][] {
  const bs = doc.components.map((c) => ({ id: c.id, b: componentBounds(c) }));
  const out: [string, string][] = [];
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i].b, b = bs[j].b;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push([bs[i].id, bs[j].id]);
    }
  }
  return out;
}

/**
 * Separation phase: a part lying on top of another (e.g. a fresh duplicate) is moved to the
 * nearest place where it overlaps nothing, its wires re-routed. The later part of each pair (in
 * document order — usually the copy) moves. Adding bends is allowed here: an overlap is worse.
 */
function separateOverlaps(
  input: SchematicDocument,
  opts: RealignOptions,
): { doc: SchematicDocument; moved: string[]; rerouted: string[] } {
  let cur = input;
  const moved: string[] = [];
  const rerouted = new Set<string>();
  const grid = cur.grid || 10;
  const room = 2 * grid; // default componentGap
  const baseline = prepareValidationBaseline(cur, opts.ids ? { ids: opts.ids } : {});
  const order = new Map(cur.components.map((c, i) => [c.id, i]));
  const offsets: [number, number][] = [];
  for (let k = 1; k <= 40; k++) {
    for (const [dx, dy] of [[k, 0], [-k, 0], [0, k], [0, -k], [k, k], [-k, k], [k, -k], [-k, -k]]) offsets.push([dx * grid, dy * grid]);
  }
  // its own time budget (only spent when parts overlap): the realign deadline is short
  const deadline = Math.max(opts.deadline, performance.now() + 2500);
  for (let round = 0; round < 32 && performance.now() < deadline; round++) {
    const pairs = overlappingPartPairs(cur);
    if (pairs.length === 0) break;
    // the part to move: the later one of a pair, if it may move
    const movable = (id: string) => !opts.ids || opts.ids.has(id);
    let target: string | null = null;
    for (const [a, b] of pairs) {
      const [first, second] = order.get(a)! < order.get(b)! ? [a, b] : [b, a];
      if (movable(second)) target = second;
      else if (movable(first)) target = first;
      if (target) break;
    }
    if (!target) break;
    const n0 = pairs.length;
    const netsBefore = sameNetWires(cur);
    let done = false;
    const b0 = componentBounds(cur.components.find((x) => x.id === target)!);
    const others = cur.components.filter((o) => o.id !== target).map((o) => componentBounds(o));
    // in a crowded drawing there may be no room nearby: also just outside the drawing, in line
    // with where the part is (right of it, below it, left, above)
    const all = others.reduce((m, b) => ({ x0: Math.min(m.x0, b.x), y0: Math.min(m.y0, b.y), x1: Math.max(m.x1, b.x + b.w), y1: Math.max(m.y1, b.y + b.h) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const snapG = (v: number) => Math.round(v / grid) * grid;
    const outside: [number, number][] = Number.isFinite(all.x0)
      ? [
          [snapG(all.x1 + 3 * grid - b0.x), 0],
          [0, snapG(all.y1 + 3 * grid - b0.y)],
          [snapG(all.x0 - 3 * grid - b0.w - b0.x), 0],
          [0, snapG(all.y0 - 3 * grid - b0.h - b0.y)],
        ]
      : [];
    for (const [dx, dy] of [...offsets, ...outside]) {
      if (performance.now() > deadline) break;
      // cheap test first: is the spot clear of every other part (the packer's 2 cells of room)?
      const nb0 = { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h };
      if (others.some((b) => nb0.x < b.x + b.w + room && b.x < nb0.x + nb0.w + room && nb0.y < b.y + b.h + room && b.y < nb0.y + nb0.h + room)) continue;
      const cand = structuredClone(cur);
      keepWiresAttached(cand, new Set([target]), () => {
        const c = cand.components.find((x) => x.id === target)!;
        c.x += dx;
        c.y += dy;
      });
      if (cand.wires.length !== cur.wires.length) continue;
      const nb = componentBounds(cand.components.find((x) => x.id === target)!);
      // clear of every other part, with room
      const clear = cand.components.every((o) => {
        if (o.id === target) return true;
        const b = componentBounds(o);
        return !(nb.x < b.x + b.w + room && b.x < nb.x + nb.w + room && nb.y < b.y + b.h + room && b.y < nb.y + nb.h + room);
      });
      if (!clear) continue;
      if (overlappingPartPairs(cand).length >= n0) continue;
      if (!sameConnectivity(cur, cand, netSignature(cur))) continue;
      const changed = cand.wires.filter((w, i) => JSON.stringify(w.points) !== JSON.stringify(cur.wires[i]?.points)).map((w) => w.id);
      if (opts.ids && changed.some((id) => !opts.ids!.has(id))) continue;
      // a re-routed wire may not get worse (a copy's wire still lying on its original is no
      // cleaner after the move, but no dirtier either)
      const obs = new RouteObstacles(cand);
      const obs0 = new RouteObstacles(cur);
      if (changed.some((id) => {
        const w = cand.wires.find((x) => x.id === id)!;
        const w0 = cur.wires.find((x) => x.id === id)!;
        const ign = new Set([id, ...(netsBefore.get(id) ?? [])]);
        return obs.routeIsBad(w.points, ign) && !obs0.routeIsBad(w0.points, ign);
      })) continue;
      const tset = new Set([target]);
      if (ruleProblems(validateAgainstBaseline(baseline, cand), new Set(changed), cand).some((v) => !orderRuleOf(v, tset))) continue;
      cur = cand;
      moved.push(target);
      for (const id of changed) rerouted.add(id);
      done = true;
      break;
    }
    if (!done) break;
  }
  return { doc: cur, moved, rerouted: [...rerouted] };
}

/** Problems of a realigned layout relative to the original (empty = acceptable). */
export function realignProblems(
  before: SchematicDocument,
  after: SchematicDocument,
  ids?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (!sameConnectivity(before, after)) out.push("Realign: connectivity changed");
  if (after.components.length !== before.components.length || after.wires.length !== before.wires.length)
    out.push("Realign: part or wire count changed");
  // (bends may only grow where parts lying on top of each other were pulled apart)
  if (bendsOf(after) > bendsOf(before) && overlappingPartPairs(after).length >= overlappingPartPairs(before).length)
    out.push("Realign: added wire bends");
  if (overlappingPartPairs(after).length > overlappingPartPairs(before).length) out.push("Realign: parts overlap");
  const byId = new Map(before.components.map((c) => [c.id, c]));
  for (const c of after.components) {
    const o = byId.get(c.id);
    if (!o) {
      out.push(`Realign: unexpected component ${c.id}`);
      continue;
    }
    if (JSON.stringify(o.props) !== JSON.stringify(c.props) || o.rotation !== c.rotation || o.type !== c.type)
      out.push(`Realign: component ${c.id} changed`);
    if (ids && !ids.has(c.id) && (o.x !== c.x || o.y !== c.y)) out.push(`Realign: fixed component ${c.id} moved`);
  }
  const changedWires = new Set(after.wires.filter((w, i) => JSON.stringify(w.points) !== JSON.stringify(before.wires[i]?.points)).map((w) => w.id));
  // parts pulled off one another necessarily change their order relative to others
  const overl = (d: SchematicDocument) => new Set(overlappingPartPairs(d).flat());
  const after0 = overl(after);
  const separated = new Set([...overl(before)].filter((id) => !after0.has(id)));
  out.push(...ruleProblems(validatePacking(before, after, ids ? { ids } : {}), changedWires, after).filter((v) => !orderRuleOf(v, separated)));
  if (ids) {
    const wb = new Map(before.wires.map((w) => [w.id, JSON.stringify(w.points)]));
    for (const w of after.wires) if (!ids.has(w.id) && wb.get(w.id) !== JSON.stringify(w.points)) out.push(`Realign: fixed wire ${w.id} changed`);
  }
  return out;
}

/** Greedy realign: repeatedly apply the single best improving move until none is left. */
export function realignWithReroute(
  input: SchematicDocument,
  qWeights: QualityWeights,
  opts: RealignOptions,
): RealignResult {
  // first pull apart parts lying on top of each other
  const sep = separateOverlaps(structuredClone(input), opts);
  let cur = sep.doc;
  const grid = cur.grid || 10;
  const maxD = (opts.maxCells ?? 12) * grid;
  const sig0 = netSignature(cur);
  let q: QualityBreakdown = layoutQuality(cur, qWeights);
  const moved = new Set<string>(sep.moved);
  const rerouted = new Set<string>(sep.rerouted);
  const tried = new Set<string>(); // "compId@x,y" positions already evaluated (and rejected)

  for (let round = 0; round < 64 && performance.now() < opts.deadline; round++) {
    // Same-type, same-size classes
    const bounds = new Map(cur.components.map((c) => [c.id, componentBounds(c)]));
    const classes = new Map<string, string[]>();
    for (const c of cur.components) {
      const b = bounds.get(c.id)!;
      const k = `${c.type}|${b.w}x${b.h}|${c.rotation}`;
      classes.set(k, [...(classes.get(k) ?? []), c.id]);
    }
    // Candidate moves: onto a peer's column (same x), a peer's row (same y), or both.
    // kind 0 = straightens a bent wire (strongest evidence of a displaced part), 1 = alignment /
    // spacing slot; support = how many peers / wires agree with the target.
    type Move = { id: string; dx: number; dy: number; prio: number; kind?: number; support?: number };
    const moves: Move[] = [];
    for (const members of classes.values()) {
      if (members.length < 2) continue;
      for (const id of members) {
        if (opts.ids && !opts.ids.has(id)) continue;
        const c = cur.components.find((x) => x.id === id)!;
        const xs = new Set<number>(), ys = new Set<number>();
        let sharesCol = false, sharesRow = false;
        for (const pid of members) {
          if (pid === id) continue;
          const p = cur.components.find((x) => x.id === pid)!;
          const dx = p.x - c.x, dy = p.y - c.y;
          if (dx === 0) sharesCol = true;
          else if (Math.abs(dx) <= maxD) xs.add(dx);
          if (dy === 0) sharesRow = true;
          else if (Math.abs(dy) <= maxD) ys.add(dy);
        }
        // outliers (in line with no peer at all) first
        const prio = (sharesCol ? 1 : 0) + (sharesRow ? 1 : 0);
        const near = (s: Set<number>) => [...s].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 3);
        const dxs = near(xs), dys = near(ys);
        // Regular-spacing slots inside the column / row it would join: midpoints between
        // neighbours and positions continuing the line's pitch.
        const slots = (line: number[], here: number) => {
          const v = [...new Set(line)].sort((a, b) => a - b);
          const out = new Set<number>();
          const gaps = v.slice(1).map((y, i) => y - v[i]);
          const pitch = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
          for (let i = 0; i + 1 < v.length; i++) {
            const mid = Math.round((v[i] + v[i + 1]) / 2 / grid) * grid;
            if (mid !== v[i] && mid !== v[i + 1]) out.add(mid - here);
          }
          if (pitch > 0 && v.length) {
            out.add(v[0] - pitch - here);
            out.add(v[v.length - 1] + pitch - here);
          }
          return [...out].filter((d) => d !== 0 && Math.abs(d) <= maxD);
        };
        const colY = (x: number) => members.filter((m) => m !== id).map((m) => cur.components.find((q) => q.id === m)!).filter((q) => q.x === x).map((q) => q.y);
        const rowX = (y: number) => members.filter((m) => m !== id).map((m) => cur.components.find((q) => q.id === m)!).filter((q) => q.y === y).map((q) => q.x);
        for (const dx of [0, ...dxs]) {
          const col = colY(c.x + dx);
          if (col.length >= 2) for (const dy of slots(col, c.y)) moves.push({ id, dx, dy, prio });
        }
        for (const dy of [0, ...dys]) {
          const row = rowX(c.y + dy);
          if (row.length >= 2) for (const dx of slots(row, c.x)) moves.push({ id, dx, dy, prio });
        }
        const supX = (dx: number) => members.filter((m) => m !== id && cur.components.find((q) => q.id === m)!.x === c.x + dx).length;
        const supY = (dy: number) => members.filter((m) => m !== id && cur.components.find((q) => q.id === m)!.y === c.y + dy).length;
        for (const dx of dxs) moves.push({ id, dx, dy: 0, prio, support: supX(dx) });
        for (const dy of dys) moves.push({ id, dx: 0, dy, prio, support: supY(dy) });
        for (const dx of dxs.slice(0, 2)) for (const dy of dys.slice(0, 2)) moves.push({ id, dx, dy, prio });
      }
    }
    const seenMove = new Set<string>();
    const uniq = moves.filter((m) => {
      const k = `${m.id}:${m.dx},${m.dy}`;
      if (seenMove.has(k)) return false;
      seenMove.add(k);
      return true;
    });
    moves.length = 0;
    moves.push(...uniq);
    const pinOf = new Map<string, string>();
    for (const c of cur.components) for (const wp of worldPins(c)) pinOf.set(`${wp.pos.x},${wp.pos.y}`, c.id);
    const straighten = new Map<string, { dxs: Map<number, number>; dys: Map<number, number> }>();
    for (const w of cur.wires) {
      if (w.points.length <= 2) continue; // already straight
      const ends: [number, number][] = [[0, w.points.length - 1], [w.points.length - 1, 0]];
      for (const [i, j] of ends) {
        const p = w.points[i], e = w.points[j];
        const id = pinOf.get(`${p.x},${p.y}`);
        if (!id || (opts.ids && !opts.ids.has(id))) continue;
        const st = straighten.get(id) ?? { dxs: new Map(), dys: new Map() };
        const dy = e.y - p.y, dx = e.x - p.x;
        if (dy !== 0 && Math.abs(dy) <= maxD) st.dys.set(dy, (st.dys.get(dy) ?? 0) + 1);
        if (dx !== 0 && Math.abs(dx) <= maxD) st.dxs.set(dx, (st.dxs.get(dx) ?? 0) + 1);
        straighten.set(id, st);
      }
    }
    for (const [id, st] of straighten) {
      for (const [dy, n] of st.dys) moves.push({ id, dx: 0, dy, prio: 0, kind: 0, support: n });
      for (const [dx, n] of st.dxs) moves.push({ id, dx, dy: 0, prio: 0, kind: 0, support: n });
      for (const [dx, nx] of st.dxs) for (const [dy, ny] of st.dys) moves.push({ id, dx, dy, prio: 0, kind: 0, support: nx + ny });
      // straighten in one axis + align / slot in the other
      for (const [dy] of st.dys) {
        for (const m of moves) if (m.id === id && m.kind === undefined && m.dy === 0 && m.dx !== 0) moves.push({ id, dx: m.dx, dy, prio: 0, kind: 0, support: 1 });
      }
    }
    // Cheap estimate of each move's effect on bends: stretch the part's wires to the new pin
    // positions (no routing) and count the bends saved. Straightening moves that save nothing
    // are dropped; everything is tried in order of expected bends saved.
    const wiresAt = new Map<string, { w: number; atStart: boolean }[]>();
    cur.wires.forEach((w, wi) => {
      const n = w.points.length;
      const a = pinOf.get(`${w.points[0].x},${w.points[0].y}`);
      const b = pinOf.get(`${w.points[n - 1].x},${w.points[n - 1].y}`);
      if (a) wiresAt.set(a, [...(wiresAt.get(a) ?? []), { w: wi, atStart: true }]);
      if (b && b !== a) wiresAt.set(b, [...(wiresAt.get(b) ?? []), { w: wi, atStart: false }]);
    });
    const saved = (m: Move) => {
      let d = 0;
      for (const { w, atStart } of wiresAt.get(m.id) ?? []) {
        const pts = cur.wires[w].points;
        const o = atStart ? pts : [...pts].reverse();
        const np = normalizeWirePoints(stretchWireStart(o, { x: o[0].x + m.dx, y: o[0].y + m.dy }));
        d += o.length - np.length;
      }
      return d;
    };
    const est = new Map<Move, number>();
    for (const m of moves) est.set(m, saved(m));
    const kept = moves.filter((m) => m.kind !== 0 || est.get(m)! > 0);
    moves.length = 0;
    moves.push(...kept);
    moves.sort((a, b) =>
      est.get(b)! - est.get(a)! ||
      (a.kind ?? 1) - (b.kind ?? 1) ||
      (b.support ?? 0) - (a.support ?? 0) || a.prio - b.prio || Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));

    // selection score: quality, with straighter wires as a tie-break (quality has no bend term)
    const BEND = 0; // bends are part of the quality score now
    let best: { doc: SchematicDocument; q: QualityBreakdown; id: string; changed: string[]; score: number } | null = null;
    const netsBefore = sameNetWires(cur);
    const baseline = prepareValidationBaseline(cur, opts.ids ? { ids: opts.ids } : {});
    const bends0 = bendsOf(cur);
    for (const m of moves) {
      if (performance.now() > opts.deadline) break;
      const c0 = cur.components.find((x) => x.id === m.id)!;
      const key = `${m.id}@${c0.x + m.dx},${c0.y + m.dy}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const cand = structuredClone(cur);
      keepWiresAttached(cand, new Set([m.id]), () => {
        const c = cand.components.find((x) => x.id === m.id)!;
        c.x += m.dx;
        c.y += m.dy;
      });
      if (cand.wires.length !== cur.wires.length) continue; // a wire collapsed
      const cq = layoutQuality(cand, qWeights);
      if (!Number.isFinite(cq.total) || !(cq.total < q.total - 1e-6)) continue;
      const b = bendsOf(cand);
      if (b > bends0) continue;
      const score = cq.total + BEND * b;
      if (best && !(score < best.score - 1e-6)) continue;
      const changed = cand.wires.filter((w, i) => JSON.stringify(w.points) !== JSON.stringify(cur.wires[i]?.points)).map((w) => w.id);
      if (opts.ids && changed.some((id) => !opts.ids!.has(id))) continue;
      const obs = new RouteObstacles(cand);
      if (changed.some((id) => {
        const w = cand.wires.find((x) => x.id === id)!;
        return obs.routeIsBad(w.points, new Set([id, ...(netsBefore.get(id) ?? [])]));
      })) continue;
      if (netSignature(cand) !== sig0) continue;
      if (ruleProblems(validateAgainstBaseline(baseline, cand), new Set(changed), cand).length > 0) continue;
      best = { doc: cand, q: cq, id: m.id, changed, score };
    }
    if (!best) break;
    cur = best.doc;
    q = best.q;
    moved.add(best.id);
    for (const id of best.changed) rerouted.add(id);
    tried.clear(); // the layout changed: earlier rejections may now succeed
  }
  return { doc: cur, moved: [...moved], rerouted: [...rerouted] };
}

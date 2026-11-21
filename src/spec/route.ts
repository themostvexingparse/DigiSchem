/**
 * DSpec net routing. A net is routed as a tree: its first pin (a driver when there is one) is
 * the root, and every other pin is joined to the nearest point of what is already drawn for the
 * net (a pin, a wire corner, or a T-junction on a wire), using the editor's clean router (no
 * wire touches anything it is not connected to). Connections are recorded as links from the
 * spec, never inferred from touch.
 *
 * When a pin cannot be reached cleanly the whole net falls back to tunnels (net labels) on each
 * pin, which is always correct; "@route tunnel" asks for that up front.
 */
import { componentBounds, geometryOf, localToWorld, pointOnSegment, rectsIntersect, worldPins, type WorldPin } from "../model/geometry";
import type { ComponentInstance, Point, Rotation, SchematicDocument } from "../model/types";
import { RouteObstacles, safeRoute } from "../editor/safe-route";
import { normalizeWirePoints, pinExitVector, routeOrthogonal, segmentIntersectsRect } from "../editor/wire-utils";

export interface NetState {
  name: string;
  /** pin terminals "p:part|pin" in spec order (driver first when there is one) */
  pins: string[];
  /** pins already part of the drawn tree */
  attached: Set<string>;
  wires: string[];
  mode: "clean" | "direct" | "tunnel";
  fallback: "tunnel" | "direct" | "error";
  tunneled: boolean;
  tunnelName: string;
  counter: number;
  /** compiler-made tunnel parts */
  tunnels: string[];
  failed: boolean;
  /** drawn (partly) with direct wires, which may touch other nets */
  direct: boolean;
}

export interface RouteContext {
  doc: SchematicDocument;
  links: [string, string][];
  /** probing: on a failed route just mark the net failed (no fallback, no message) */
  probe?: boolean;
  onWarn: (net: NetState, message: string) => void;
  onError: (net: NetState, message: string) => void;
}

const termPart = (t: string) => t.slice(2, t.indexOf("|"));
const termPin = (t: string) => t.slice(t.indexOf("|") + 1);
const key = (p: Point) => `${p.x},${p.y}`;
const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function pinOf(doc: SchematicDocument, t: string): { inst: ComponentInstance; wp: WorldPin } | null {
  const inst = doc.components.find((c) => c.id === termPart(t));
  if (!inst) return null;
  const wp = worldPins(inst).find((p) => p.pin.id === termPin(t));
  return wp ? { inst, wp } : null;
}

function pathCost(pts: readonly Point[]): number {
  let len = 0;
  for (let i = 0; i + 1 < pts.length; i++) len += dist(pts[i], pts[i + 1]);
  return len + 15 * Math.max(0, pts.length - 2);
}

interface Target {
  pt: Point;
  term: string;
}

function targetsFor(doc: SchematicDocument, net: NetState, from: Point, exit: Point): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  const add = (pt: Point, term: string) => {
    const k = key(pt);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ pt, term });
  };
  for (const t of net.attached) {
    const p = pinOf(doc, t);
    if (p) add(p.wp.pos, t);
  }
  for (const id of net.wires) {
    const w = doc.wires.find((x) => x.id === id);
    if (!w) continue;
    for (const v of w.points) add(v, `w:${id}`);
    // points on each segment level with the pin and with the end of its exit stub (so the new
    // wire can leave the pin, turn once and meet the segment square on), plus the midpoint
    const probes = [0, 1, 2, 3, 4].map((k) => ({ x: from.x + exit.x * k * 10, y: from.y + exit.y * k * 10 }));
    for (let i = 0; i + 1 < w.points.length; i++) {
      const a = w.points[i], b = w.points[i + 1];
      const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
      for (const p of probes) {
        if (a.y === b.y && p.x > lo.x && p.x < hi.x) add({ x: p.x, y: a.y }, `w:${id}`);
        if (a.x === b.x && p.y > lo.y && p.y < hi.y) add({ x: a.x, y: p.y }, `w:${id}`);
      }
      const mid = { x: Math.round((a.x + b.x) / 20) * 10, y: Math.round((a.y + b.y) / 20) * 10 };
      add(mid, `w:${id}`);
    }
  }
  // a point another net's wire or pin passes through is not a place to join (it would touch both)
  const own = new Set(net.wires);
  const foreignAt = (pt: Point) =>
    doc.wires.some((w) => !own.has(w.id) && w.points.some((q, i) => (i + 1 < w.points.length && pointOnSegment(pt, q, w.points[i + 1])) || (q.x === pt.x && q.y === pt.y))) ||
    doc.components.some((c) => worldPins(c).some((wp) => wp.pos.x === pt.x && wp.pos.y === pt.y && !net.pins.includes(`p:${c.id}|${wp.pin.id}`) && !net.tunnels.includes(c.id)));
  return out
    .filter((tg) => !foreignAt(tg.pt))
    .sort((a, b) => dist(a.pt, from) - dist(b.pt, from) || a.pt.x - b.pt.x || a.pt.y - b.pt.y);
}

function busWidth(doc: SchematicDocument, net: NetState): number {
  let w = 1;
  for (const t of net.pins) w = Math.max(w, pinOf(doc, t)?.wp.pin.width ?? 1);
  return w;
}

function addWire(ctx: RouteContext, net: NetState, pts: Point[], a: string, b: string): void {
  const id = `w_${net.name}_${++net.counter}`;
  const width = busWidth(ctx.doc, net);
  ctx.doc.wires.push({ id, points: normalizeWirePoints(pts), ...(width > 1 ? { width } : {}) });
  net.wires.push(id);
  ctx.links.push([`w:${id}`, a], [`w:${id}`, b]);
}

/** Join pin `t` to the net's tree; false when no clean route exists. */
function connect(ctx: RouteContext, net: NetState, t: string): boolean {
  const p = pinOf(ctx.doc, t);
  if (!p) return false;
  const from = p.wp.pos;
  const targets = targetsFor(ctx.doc, net, from, pinExitVector(p.inst, p.wp.pin.side));
  if (targets.length && dist(targets[0].pt, from) === 0) {
    ctx.links.push([t, targets[0].term]);
    return true;
  }
  if (net.mode === "direct") {
    const tg = targets[0];
    if (!tg) return false;
    const ex = pinExitVector(p.inst, p.wp.pin.side);
    addWire(ctx, net, routeOrthogonal(from, tg.pt, ex.x !== 0), t, tg.term);
    net.direct = true;
    return true;
  }
  // The net's own wires are obstacles too: a new wire may cross them and end on them (a
  // T-junction), but never run along them (that would hide one wire under another).
  const obs = new RouteObstacles(ctx.doc);
  let best: { pts: Point[]; tg: Target } | null = null;
  let tried = 0;
  for (const tg of targets) {
    if (tried >= 12 || (best && tried >= 5)) break;
    tried++;
    const allowed = new Set(net.wires.map((w) => `${w}@${key(tg.pt)}`));
    const pts = safeRoute(obs, from, tg.pt, { allowed });
    if (pts && pts.length >= 2 && (!best || pathCost(pts) < pathCost(best.pts))) best = { pts, tg };
  }
  if (!best) return false;
  addWire(ctx, net, best.pts, t, best.tg.term);
  return true;
}

/** A tunnel turned so its body extends away from the pin at `wp`, its own pin on that pin. */
function tunnelAt(id: string, name: string, owner: ComponentInstance, wp: WorldPin): ComponentInstance {
  const exit = pinExitVector(owner, wp.pin.side);
  const width = wp.pin.width ?? 1;
  let best: ComponentInstance | null = null;
  let bestScore = -Infinity;
  for (const rotation of [0, 90, 180, 270] as Rotation[]) {
    for (const mirror of [false, true]) {
      const t: ComponentInstance = { id, type: "tunnel", x: 0, y: 0, rotation, props: { name, ...(width > 1 ? { width } : {}) } };
      if (mirror) t.mirror = true;
      const g = geometryOf(t);
      const tp = worldPins(t)[0].pos;
      const c = localToWorld(t, { x: g.width / 2, y: g.height / 2 }, g);
      const mid = { x: c.x - tp.x, y: c.y - tp.y };
      // body along the exit direction; among equals prefer no rotation, then no mirror
      const score = mid.x * exit.x + mid.y * exit.y - (rotation === 0 ? 0 : 0.5) - (mirror ? 0.1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { ...t, x: wp.pos.x - tp.x, y: wp.pos.y - tp.y };
      }
    }
  }
  return best!;
}

function tunnelize(ctx: RouteContext, net: NetState, reason: string | null): void {
  if (reason) ctx.onWarn(net, reason);
  // drop what was drawn for the net
  const gone = new Set(net.wires.map((w) => `w:${w}`));
  ctx.doc.wires = ctx.doc.wires.filter((w) => !gone.has(`w:${w.id}`));
  ctx.links.splice(0, ctx.links.length, ...ctx.links.filter(([a, b]) => !gone.has(a) && !gone.has(b)));
  // pin-to-pin links of this net's tree (direct contacts) stay: they are drawn by touching
  net.wires = [];
  net.tunneled = true;
  net.attached = new Set();
  for (const t of net.pins) if (pinOf(ctx.doc, t)) attachTunnel(ctx, net, t);
}

function attachTunnel(ctx: RouteContext, net: NetState, t: string): void {
  const p = pinOf(ctx.doc, t)!;
  const id = `T_${net.name}_${net.tunnels.length + 1}`;
  const exit = pinExitVector(p.inst, p.wp.pin.side);
  // Right on the pin when there is room; otherwise out on a short stub wire, so the label does
  // not sit on top of another part, label or wire.
  // (when no spot is clear, the label goes right on the pin: it may overlap, but touches nothing)
  for (const k of [0, 2, 3, 4, 6, 8, -1]) {
    const last = k === -1;
    const at = last ? { ...p.wp.pos } : { x: p.wp.pos.x + exit.x * k * 10, y: p.wp.pos.y + exit.y * k * 10 };
    const tun = tunnelAt(id, net.tunnelName, p.inst, { ...p.wp, pos: at });
    const r = componentBounds(tun);
    const clear =
      !ctx.doc.components.some((c) => c.id !== p.inst.id && rectsIntersect(r, componentBounds(c))) &&
      !ctx.doc.wires.some((w) => w.points.some((q, i) => i + 1 < w.points.length && segmentIntersectsRect(q, w.points[i + 1], r))) &&
      (k <= 0 || (!ctx.doc.components.some((c) => rectsIntersect(stubRect(p.wp.pos, at), componentBounds(c)) && c.id !== p.inst.id) && !new RouteObstacles(ctx.doc).routeIsBad([p.wp.pos, at])));
    if (!clear && !last) continue;
    ctx.doc.components.push(tun);
    net.tunnels.push(id);
    if (k <= 0) ctx.links.push([t, `p:${id}|net`]);
    else {
      const wid = `w_${net.name}_${++net.counter}`;
      ctx.doc.wires.push({ id: wid, points: [{ ...p.wp.pos }, at] });
      ctx.links.push([`w:${wid}`, t], [`w:${wid}`, `p:${id}|net`]);
      net.wires.push(wid);
    }
    net.attached.add(t);
    return;
  }
}

function stubRect(a: Point, b: Point) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Route the pins of `net` that are placed but not yet attached. */
export function routeNet(ctx: RouteContext, net: NetState): void {
  const placed = net.pins.filter((t) => pinOf(ctx.doc, t));
  const todo = placed.filter((t) => !net.attached.has(t));
  if (!todo.length) return;
  if (net.mode === "tunnel" || net.tunneled) {
    if (!net.tunneled) {
      net.tunneled = true;
      net.attached = new Set();
    }
    if (placed.length < 2 && net.tunnels.length === 0) return; // nothing to join yet
    for (const t of placed) if (!net.attached.has(t)) attachTunnel(ctx, net, t);
    return;
  }
  if (net.attached.size === 0) {
    net.attached.add(todo[0]);
    todo.shift();
  }
  // nearest first, so the tree grows outward
  const rootPos = pinOf(ctx.doc, [...net.attached][0])!.wp.pos;
  todo.sort((a, b) => dist(pinOf(ctx.doc, a)!.wp.pos, rootPos) - dist(pinOf(ctx.doc, b)!.wp.pos, rootPos));
  for (const t of todo) {
    if (connect(ctx, net, t)) {
      net.attached.add(t);
      continue;
    }
    if (ctx.probe) {
      net.failed = true;
      return;
    }
    if (net.fallback === "error") {
      ctx.onError(net, `no clean route for ${termPart(t)}.${termPin(t)} in net ${net.name} (allow @fallback tunnel or direct)`);
      net.failed = true;
      net.attached.add(t);
      continue;
    }
    if (net.fallback === "direct") {
      const saved: NetState["mode"] = net.mode;
      net.mode = "direct";
      connect(ctx, net, t);
      net.mode = saved;
      net.attached.add(t);
      ctx.onWarn(net, `net ${net.name}: ${termPart(t)}.${termPin(t)} was drawn with a direct wire that may cross other wires`);
      continue;
    }
    tunnelize(ctx, net, `net ${net.name}: no clean route for ${termPart(t)}.${termPin(t)}, so the net is drawn with tunnels (net labels)`);
    return;
  }
}

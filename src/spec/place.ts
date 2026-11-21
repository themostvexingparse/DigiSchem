/**
 * DSpec automatic placement.
 *
 * "flow": columns by signal depth (inputs left, outputs right). Each net's outputs point to
 * the parts it feeds; feedback loops (a counter's Q back to its own logic) are broken where a
 * depth-first walk from the inputs closes them. Columns are ordered to reduce crossings
 * (barycenter sweeps), and each part is lined up with the pin that drives it so chains come
 * out as straight wires.
 * "grid": rows and columns in source order. Fixed parts (at=..., or kept from the previous
 * build) are never moved; others are kept clear of them.
 */
import { componentBounds, rectsIntersect, worldPins, type Rect } from "../model/geometry";
import type { ComponentInstance, SchematicDocument } from "../model/types";
import { segmentIntersectsRect } from "../editor/wire-utils";

export interface PlaceItem {
  inst: ComponentInstance;
  fixed: boolean;
  mode: "flow" | "grid" | "manual";
}

export interface PlaceOptions {
  colGap: number; // grid cells between columns
  rowGap: number; // grid cells between parts in a column
}

const SOURCE_TYPES = new Set(["input-pin", "clock", "constant", "vcc", "ground", "push-button", "dip-switch", "keypad"]);
const SINK_TYPES = new Set(["output-pin", "probe", "seven-segment", "hex-display", "led-bar"]);
const G = 10;
const snap = (v: number) => Math.round(v / G) * G;

function localBounds(inst: ComponentInstance): Rect {
  return componentBounds({ ...inst, x: 0, y: 0 });
}

function boundsAt(inst: ComponentInstance, x: number, y: number): Rect {
  const b = localBounds(inst);
  return { x: b.x + x, y: b.y + y, w: b.w, h: b.h };
}

function grow(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** Assign x/y to every non-fixed item. `nets`: terminals "p:part|pin" per net. */
export function placeParts(items: PlaceItem[], nets: readonly (readonly string[])[], opts: PlaceOptions): void {
  const flow = items.filter((it) => !it.fixed && it.mode === "flow");
  const grid = items.filter((it) => !it.fixed && it.mode === "grid");
  const fixedRects = () => items.filter((it) => it.fixed).map((it) => grow(boundsAt(it.inst, it.inst.x, it.inst.y), opts.rowGap * G));
  if (flow.length) placeFlow(items, flow, nets, opts, fixedRects());
  if (grid.length) placeGrid(items, grid, opts);
}

function placeGrid(all: PlaceItem[], list: PlaceItem[], opts: PlaceOptions): void {
  const placed = all.filter((it) => it.fixed || !list.includes(it)).map((it) => boundsAt(it.inst, it.inst.x, it.inst.y));
  const startY = placed.length ? Math.max(...placed.map((r) => r.y + r.h)) + opts.rowGap * G * 2 : 0;
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const cw = Math.max(...list.map((it) => localBounds(it.inst).w)) + opts.colGap * G;
  const ch = Math.max(...list.map((it) => localBounds(it.inst).h)) + opts.rowGap * G;
  list.forEach((it, i) => {
    const b = localBounds(it.inst);
    it.inst.x = snap((i % cols) * cw - b.x);
    it.inst.y = snap(startY + Math.floor(i / cols) * ch - b.y);
  });
}

function placeFlow(all: PlaceItem[], list: PlaceItem[], nets: readonly (readonly string[])[], opts: PlaceOptions, fixed: Rect[]): void {
  const pinInfo = new Map<string, { part: number; dir: string; dy: number }>();
  list.forEach((it, i) => {
    for (const wp of worldPins({ ...it.inst, x: 0, y: 0 })) pinInfo.set(`p:${it.inst.id}|${wp.pin.id}`, { part: i, dir: wp.pin.dir, dy: wp.pos.y });
  });
  // driver -> sink edges between flow parts
  type Edge = { from: number; to: number; drv: string; snk: string };
  const out: Edge[][] = list.map(() => []);
  const inc: Edge[][] = list.map(() => []);
  for (const net of nets) {
    const drv = net.filter((t) => pinInfo.get(t)?.dir === "out");
    const snk = net.filter((t) => { const d = pinInfo.get(t)?.dir; return d === "in" || d === "inout"; });
    for (const d of drv)
      for (const s of snk) {
        const a = pinInfo.get(d)!.part, b = pinInfo.get(s)!.part;
        if (a === b) continue;
        const e = { from: a, to: b, drv: d, snk: s };
        out[a].push(e);
        inc[b].push(e);
      }
  }
  // break cycles with a DFS from the sources (inputs first, then source order)
  const n = list.length;
  const color = new Array<number>(n).fill(0);
  const back = new Set<Edge>();
  const order = [...list.keys()].sort((a, b) => {
    const sa = SOURCE_TYPES.has(list[a].inst.type) || inc[a].length === 0 ? 0 : 1;
    const sb = SOURCE_TYPES.has(list[b].inst.type) || inc[b].length === 0 ? 0 : 1;
    return sa - sb || a - b;
  });
  for (const root of order) {
    if (color[root]) continue;
    const stack: { v: number; i: number }[] = [{ v: root, i: 0 }];
    color[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= out[top.v].length) {
        color[top.v] = 2;
        stack.pop();
        continue;
      }
      const e = out[top.v][top.i++];
      if (color[e.to] === 1) back.add(e);
      else if (color[e.to] === 0) {
        color[e.to] = 1;
        stack.push({ v: e.to, i: 0 });
      }
    }
  }
  // longest-path depth over the remaining DAG (Kahn order)
  const level = new Array<number>(n).fill(0);
  const indeg = new Array<number>(n).fill(0);
  for (let v = 0; v < n; v++) for (const e of out[v]) if (!back.has(e)) indeg[e.to]++;
  const queue = [...list.keys()].filter((v) => indeg[v] === 0);
  const topo: number[] = [];
  while (queue.length) {
    const v = queue.shift()!;
    topo.push(v);
    for (const e of out[v]) {
      if (back.has(e)) continue;
      level[e.to] = Math.max(level[e.to], level[v] + 1);
      if (--indeg[e.to] === 0) queue.push(e.to);
    }
  }
  for (let v = 0; v < n; v++) if (SOURCE_TYPES.has(list[v].inst.type)) level[v] = 0;
  const maxLevel = Math.max(0, ...level);
  for (let v = 0; v < n; v++) if (SINK_TYPES.has(list[v].inst.type) && out[v].every((e) => back.has(e))) level[v] = Math.max(level[v], maxLevel + (maxLevel > 0 || n > 1 ? 1 : 0));
  // columns, ordered by barycenters (a few sweeps each way)
  const nCols = Math.max(...level) + 1;
  const cols: number[][] = Array.from({ length: nCols }, () => []);
  for (let v = 0; v < n; v++) cols[level[v]].push(v);
  const pos = new Array<number>(n).fill(0);
  const renumber = () => cols.forEach((c) => c.forEach((v, i) => (pos[v] = i)));
  renumber();
  const bary = (v: number, edges: Edge[], other: (e: Edge) => number) => {
    const ns = edges.filter((e) => !back.has(e)).map(other);
    return ns.length ? ns.reduce((s, u) => s + pos[u], 0) / ns.length : pos[v];
  };
  for (let sweep = 0; sweep < 5; sweep++) { // ends on a left-to-right sweep
    const down = sweep % 2 === 0;
    const seq = down ? cols.slice(1) : cols.slice(0, -1).reverse();
    for (const c of seq) {
      const key = new Map(c.map((v) => [v, down ? bary(v, inc[v], (e) => e.from) : bary(v, out[v], (e) => e.to)]));
      c.sort((a, b) => key.get(a)! - key.get(b)! || a - b);
      renumber();
    }
  }
  // coordinates: columns left to right; each part lined up with the pin driving it
  const colW = cols.map((c) => Math.max(0, ...c.map((v) => localBounds(list[v].inst).w)));
  // every net crossing a column gap needs its own vertical lane there
  const gapCells = cols.map(() => opts.colGap);
  const through = cols.map(() => 0);
  for (const net of nets) {
    const cs = net.map((t) => pinInfo.get(t)).filter((x) => x).map((x) => level[x!.part]);
    if (cs.length < 2) continue;
    const lo = Math.min(...cs), hi = Math.max(...cs);
    for (let c = lo; c < hi; c++) through[c]++;
  }
  for (let c = 0; c < nCols; c++) gapCells[c] = Math.max(opts.colGap, through[c] + 3);
  let x0 = 0;
  const others = all.filter((it) => !list.includes(it) && it.fixed);
  if (others.length) x0 = snap(Math.min(...fixed.map((r) => r.x)));
  const placedRects: Rect[] = [...fixed];
  const pinWorldY = (t: string) => {
    const info = pinInfo.get(t)!;
    return list[info.part].inst.y + info.dy;
  };
  let colX = x0;
  for (let c = 0; c < nCols; c++) {
    let bottom = -Infinity;
    for (const v of cols[c]) {
      const inst = list[v].inst;
      const b = localBounds(inst);
      const wants = inc[v].filter((e) => !back.has(e) && level[e.from] < c).map((e) => pinWorldY(e.drv) - pinInfo.get(e.snk)!.dy);
      wants.sort((a, b2) => a - b2);
      let y = wants.length ? wants[Math.floor((wants.length - 1) / 2)] : bottom === -Infinity ? 0 : bottom + opts.rowGap * G - b.y;
      if (bottom !== -Infinity) y = Math.max(y, bottom + opts.rowGap * G - b.y);
      y = snap(y);
      const x = snap(colX + (colW[c] - b.w) / 2 - b.x);
      // stay clear of fixed parts
      let guard = 0;
      while (placedRects.some((r) => rectsIntersect(r, grow(boundsAt(inst, x, y), (opts.rowGap * G) / 2))) && guard++ < 400) y += G;
      inst.x = x;
      inst.y = y;
      const r = boundsAt(inst, x, y);
      placedRects.push(r);
      bottom = r.y + r.h;
    }
    colX += colW[c] + gapCells[c] * G;
  }
}

/** True when `inst` at its position would touch another part (with `gap` cells) or a wire. */
export function collides(doc: SchematicDocument, inst: ComponentInstance, gap: number): boolean {
  const r = grow(componentBounds(inst), gap * G);
  for (const c of doc.components) if (c.id !== inst.id && rectsIntersect(r, componentBounds(c))) return true;
  const near = grow(componentBounds(inst), G);
  for (const w of doc.wires) for (let i = 0; i + 1 < w.points.length; i++) if (segmentIntersectsRect(w.points[i], w.points[i + 1], near)) return true;
  return false;
}

/** Move `inst` to the nearest spot (from where it is) that does not collide. */
export function moveToFreeSpot(doc: SchematicDocument, inst: ComponentInstance, gap: number): void {
  if (!collides(doc, inst, gap)) return;
  const x0 = inst.x, y0 = inst.y;
  for (let r = 1; r <= 80; r++) {
    const ring: [number, number][] = [];
    for (let dx = -r; dx <= r; dx++) for (const dy of [-r, r]) ring.push([dx, dy]);
    for (let dy = -r + 1; dy <= r - 1; dy++) for (const dx of [-r, r]) ring.push([dx, dy]);
    ring.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])) || a[0] - b[0] || a[1] - b[1]);
    for (const [dx, dy] of ring) {
      inst.x = x0 + dx * 2 * G;
      inst.y = y0 + dy * 2 * G;
      if (!collides(doc, inst, gap)) return;
    }
  }
  inst.x = x0;
  inst.y = y0;
}

/**
 * Where a part added after the layout was compacted should go: just right of the parts driving
 * it (lined up with the driving pin), or just left of the parts it drives. Null: no placed
 * neighbour, keep the planned spot.
 */
export function neighborSpot(doc: SchematicDocument, inst: ComponentInstance, nets: readonly (readonly string[])[], colGap: number): { x: number; y: number } | null {
  const placed = new Map(doc.components.map((c) => [c.id, c]));
  const pinPos = new Map<string, { x: number; y: number; dir: string }>();
  for (const c of doc.components) for (const wp of worldPins(c)) pinPos.set(`p:${c.id}|${wp.pin.id}`, { ...wp.pos, dir: wp.pin.dir });
  const local = worldPins({ ...inst, x: 0, y: 0 });
  const b = localBounds(inst);
  const after: { x: number; y: number }[] = [], before: { x: number; y: number }[] = [];
  for (const net of nets) {
    for (const lp of local) {
      const me = `p:${inst.id}|${lp.pin.id}`;
      if (!net.includes(me)) continue;
      for (const t of net) {
        if (t === me) continue;
        const other = pinPos.get(t);
        if (!other || !placed.has(t.slice(2, t.indexOf("|")))) continue;
        if (lp.pin.dir !== "out" && other.dir === "out") after.push({ x: other.x + colGap * G - b.x, y: other.y - lp.pos.y });
        else if (lp.pin.dir === "out" && other.dir !== "out") before.push({ x: other.x - colGap * G - (b.x + b.w), y: other.y - lp.pos.y });
      }
    }
  }
  const use = after.length ? after : before;
  const xs = use.map((p) => p.x), ys = use.map((p) => p.y);
  if (!xs.length) return null;
  const med = (v: number[]) => [...v].sort((p, q) => p - q)[Math.floor((v.length - 1) / 2)];
  return { x: snap(after.length ? Math.max(...xs) : Math.min(...xs)), y: snap(med(ys)) };
}

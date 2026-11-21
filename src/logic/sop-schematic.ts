/**
 * Draws a sum of products as a classic two-level AND-OR schematic:
 *
 *   w3   w2   w1   w0        inputs across the top, most significant first
 *   |  \ |  \ |  \ |  \      each input drops a vertical rail; a NOT gate beside it drops the
 *   |  N |  N |  N |  N      complement rail (only for variables used complemented)
 *   |  | |  | |  | |  |
 *   +--|-+--|-|--|-|--+--[AND]--\
 *   |  +-|--|-+--|-|--|--[AND]---[OR]--> out
 *                                /
 *
 * Every AND input taps straight off its rail (so each wire is one horizontal line), and the AND
 * outputs reach the OR inputs in a staircase that never crosses itself. The wires are placed
 * exactly, not routed, so the drawing is the same every time; it stores its connections.
 */
import type { ComponentInstance, Point, SchematicDocument, TextNote, Wire } from "../model/types";
import { worldPins } from "../model/geometry";
import { literalCount, sopToString, termToString, type Term } from "./minimize";

export interface SopSchematicOptions {
  /** document name (default: the expression) */
  title?: string;
  /** write the expression as a text note above the drawing (default true) */
  caption?: boolean;
}

export function sopToSchematic(terms: readonly Term[], names: readonly string[], out: string, opts: SopSchematicOptions = {}): SchematicDocument {
  const n = names.length;
  const expr = `${out} = ${sopToString(terms, names)}`;
  const components: ComponentInstance[] = [];
  const wires: Wire[] = [];
  const links: [string, string][] = [];
  const texts: TextNote[] = [];
  let wn = 0;
  const pinPos = (c: ComponentInstance, id: string): Point => worldPins(c).find((p) => p.pin.id === id)!.pos;
  /** add a wire; `ends` are what its first and last points connect to ("p:..." or "w:...") */
  const wire = (pts: Point[], a: string | null, b: string | null): string => {
    const id = `wire${++wn}`;
    wires.push({ id, points: pts });
    if (a) links.push([`w:${id}`, a]);
    if (b) links.push([`w:${id}`, b]);
    return id;
  };
  const term = (c: ComponentInstance, pin: string) => `p:${c.id}|${pin}`;

  const outPin: ComponentInstance = { id: out, type: "output-pin", x: 0, y: 0, rotation: 0, props: { name: out }, label: "" };

  // ---- constants ---------------------------------------------------------------------------
  const isOne = terms.length === 1 && literalCount(terms[0], n) === 0;
  if (!terms.length || isOne) {
    const k: ComponentInstance = { id: isOne ? "ONE" : "ZERO", type: "constant", x: 0, y: 0, rotation: 0, props: { value: isOne ? "1" : "0" }, label: "" };
    outPin.x = 100;
    components.push(k, outPin);
    const a = pinPos(k, "out");
    outPin.y = a.y - (pinPos(outPin, "in").y - outPin.y);
    wire([a, pinPos(outPin, "in")], term(k, "out"), term(outPin, "in"));
    return finish();
  }

  // ---- inputs and rails ------------------------------------------------------------------------
  const order = Array.from({ length: n }, (_, j) => n - 1 - j); // variable indices, MSB first
  const used = new Set<number>(), inverted = new Set<number>();
  for (const t of terms)
    for (let i = 0; i < n; i++) {
      if (t.mask & (1 << i)) continue;
      used.add(i);
      if (!(t.value & (1 << i))) inverted.add(i);
    }
  const RAIL_TOP = 50; // input pins (rotated to point down) end here
  const FEED_Y = 70; // where a rail feeds its inverter
  const INV_Y = 90; // inverter input
  const railX = new Map<string, number>(); // "i" or "i'" -> x
  let x = 0;
  const inputs = new Map<number, ComponentInstance>(), nots = new Map<number, ComponentInstance>();
  for (const i of order) {
    const pin: ComponentInstance = { id: names[i], type: "input-pin", x: x + 10, y: 0, rotation: 90, props: { name: names[i] }, label: "" };
    components.push(pin);
    inputs.set(i, pin);
    railX.set(`${i}`, x);
    if (inverted.has(i)) {
      const nx = x + 40;
      const g: ComponentInstance = { id: `N_${names[i]}`, type: "not", x: nx + 20, y: INV_Y, rotation: 90, props: {}, label: `${names[i]}'` };
      components.push(g);
      nots.set(i, g);
      railX.set(`${i}'`, nx);
      x += 100;
    } else x += 60;
  }
  const railsEnd = x; // first free x right of the rails

  // ---- AND gates (one row per term; a one-literal term gets a plain row) ------------------------
  const GAP = 30;
  const andX = railsEnd + 40;
  let y = 220;
  interface Row { lits: { i: number; plain: boolean }[]; gate?: ComponentInstance; outPt: Point; srcTerm: string }
  const rows: Row[] = [];
  terms.forEach((t, k) => {
    const lits: { i: number; plain: boolean }[] = [];
    for (const i of order) if (!(t.mask & (1 << i))) lits.push({ i, plain: !!(t.value & (1 << i)) });
    if (lits.length === 1) {
      rows.push({ lits, outPt: { x: andX, y: y + 10 }, srcTerm: "" });
      y += 20 + GAP;
      return;
    }
    const g: ComponentInstance = { id: `P${k}`, type: "and", x: andX, y, rotation: 0, props: { inputs: lits.length }, label: termToString(t, names) };
    components.push(g);
    rows.push({ lits, gate: g, outPt: pinPos(g, "out"), srcTerm: term(g, "out") });
    y += 20 * lits.length + GAP;
  });
  const andRight = Math.max(...rows.map((r) => (r.gate ? pinPos(r.gate, "out").x : andX)));

  // rails: each rail runs from its source down to its lowest tap; taps are horizontal lines
  const taps = new Map<string, { y: number; to: string; toPt: Point }[]>();
  rows.forEach((r) => {
    if (r.gate) r.lits.forEach((l, j) => {
      const p = pinPos(r.gate!, `in${j}`);
      const k = l.plain ? `${l.i}` : `${l.i}'`;
      (taps.get(k) ?? taps.set(k, []).get(k)!).push({ y: p.y, to: term(r.gate!, `in${j}`), toPt: p });
    });
  });
  const railWire = new Map<string, string>();
  for (const i of order) {
    for (const plain of [true, false]) {
      const k = plain ? `${i}` : `${i}'`;
      if (!railX.has(k)) continue;
      const rx = railX.get(k)!;
      const ts = taps.get(k) ?? [];
      const singleRows = rows.filter((r) => !r.gate && r.lits[0].i === i && r.lits[0].plain === plain);
      const lows = [...ts.map((t) => t.y), ...singleRows.map((r) => r.outPt.y)];
      const top = plain ? RAIL_TOP : pinPos(nots.get(i)!, "out").y;
      const bottom = Math.max(top, ...lows, plain && inverted.has(i) ? FEED_Y : top);
      const src = plain ? term(inputs.get(i)!, "out") : term(nots.get(i)!, "out");
      if (bottom > top) railWire.set(k, wire([{ x: rx, y: top }, { x: rx, y: bottom }], src, null));
    }
  }
  // inverter feeds
  for (const [i, g] of nots) {
    const rx = railX.get(`${i}`)!;
    const inPt = pinPos(g, "in0");
    wire([{ x: rx, y: FEED_Y }, { x: inPt.x, y: FEED_Y }, inPt], `w:${railWire.get(`${i}`)}`, term(g, "in0"));
  }
  // taps into AND inputs
  for (const [k, ts] of taps) {
    const rx = railX.get(k)!;
    for (const t of ts) wire([{ x: rx, y: t.y }, t.toPt], `w:${railWire.get(k)}`, t.to);
  }

  // ---- OR gate and output --------------------------------------------------------------------
  const finishTo = (from: Point, src: string | null, srcRail: string | null) => ({ from, src, srcRail });
  const sources = rows.map((r) => {
    if (r.gate) return finishTo(r.outPt, r.srcTerm, null);
    const k = r.lits[0].plain ? `${r.lits[0].i}` : `${r.lits[0].i}'`;
    return finishTo({ x: railX.get(k)!, y: r.outPt.y }, null, railWire.get(k)!);
  });
  if (rows.length === 1) {
    const s = sources[0];
    outPin.x = andRight + 40;
    outPin.y = s.from.y - 10;
    components.push(outPin);
    wire([s.from, pinPos(outPin, "in")], s.src ?? `w:${s.srcRail}`, term(outPin, "in"));
    return finish();
  }
  const orH = 20 * rows.length;
  const firstY = sources[0].from.y, lastY = sources[sources.length - 1].from.y;
  const orY = Math.round(((firstY + lastY) / 2 - orH / 2) / 10) * 10;
  const down = sources.map((s, j) => s.from.y < orY + 10 + 20 * j).filter(Boolean).length;
  const up = rows.length - down;
  const jogBase = andRight + 20;
  const orX = jogBase + 10 * Math.max(down, up) + 20;
  const or: ComponentInstance = { id: "SUM", type: "or", x: orX, y: orY, rotation: 0, props: { inputs: rows.length }, label: "" };
  components.push(or);
  // AND outputs to OR inputs: wires going down jog right-to-left from the top, wires going up
  // left-to-right, so the jogs form two staircases and nothing crosses
  let di = 0, ui = 0;
  sources.forEach((s, j) => {
    const inPt = pinPos(or, `in${j}`);
    const a = s.src ?? `w:${s.srcRail}`;
    if (inPt.y === s.from.y) {
      wire([s.from, inPt], a, term(or, `in${j}`));
      return;
    }
    const goingDown = inPt.y > s.from.y;
    const jx = goingDown ? jogBase + 10 * (down - 1 - di++) : jogBase + 10 * ui++;
    wire([s.from, { x: jx, y: s.from.y }, { x: jx, y: inPt.y }, inPt], a, term(or, `in${j}`));
  });
  const orOut = pinPos(or, "out");
  outPin.x = orOut.x + 40;
  outPin.y = orOut.y - 10;
  components.push(outPin);
  wire([orOut, pinPos(outPin, "in")], term(or, "out"), term(outPin, "in"));
  return finish();

  function finish(): SchematicDocument {
    if (opts.caption !== false) texts.push({ id: "caption", x: 0, y: -40, text: expr });
    return { format: "digischem", version: 1, name: opts.title ?? expr, grid: 10, components, wires, texts, links };
  }
}

export interface SopOutput {
  /** output pin name */
  name: string;
  /** its sum of products */
  terms: readonly Term[];
  /** label for its OR gate (default: none) */
  label?: string;
}

/**
 * Several sums of products over the same inputs as one two-level schematic: input rails across
 * the top (most significant first), one column of AND gates in which a product needed by several
 * outputs is built once, an OR gate per output on the right, and the output pins in a column in
 * the order given. Each AND output drops down a lane of its own and branches off to every OR
 * gate that uses it, so the wiring stays legible however the terms are shared. Wires are placed
 * exactly and the connections stored, like `sopToSchematic`.
 */
export function sopsToSchematic(outputs: readonly SopOutput[], names: readonly string[], opts: { title?: string } = {}): SchematicDocument {
  const n = names.length;
  const components: ComponentInstance[] = [];
  const wires: Wire[] = [];
  const links: [string, string][] = [];
  let wn = 0;
  const pinPos = (c: ComponentInstance, id: string): Point => worldPins(c).find((p) => p.pin.id === id)!.pos;
  const wire = (pts: Point[], a: string | null, b: string | null): string => {
    const id = `wire${++wn}`;
    wires.push({ id, points: pts });
    if (a) links.push([`w:${id}`, a]);
    if (b) links.push([`w:${id}`, b]);
    return id;
  };
  const term = (c: ComponentInstance, pin: string) => `p:${c.id}|${pin}`;
  const key = (t: Term) => `${t.value & ~t.mask}/${t.mask}`;

  // ---- distinct products, in order of first use ------------------------------------------------
  const products: { t: Term; users: number[] }[] = [];
  const byKey = new Map<string, { t: Term; users: number[] }>();
  outputs.forEach((o, k) =>
    o.terms.forEach((t) => {
      if (literalCount(t, n) === 0) return; // constant 1: handled per output
      let p = byKey.get(key(t));
      if (!p) {
        p = { t, users: [] };
        byKey.set(key(t), p);
        products.push(p);
      }
      if (!p.users.includes(k)) p.users.push(k);
    }),
  );

  // ---- inputs, inverters and rails (as in sopToSchematic) --------------------------------------
  const order = Array.from({ length: n }, (_, j) => n - 1 - j);
  const inverted = new Set<number>();
  for (const { t } of products) for (let i = 0; i < n; i++) if (!(t.mask & (1 << i)) && !(t.value & (1 << i))) inverted.add(i);
  const RAIL_TOP = 50, FEED_Y = 70, INV_Y = 90;
  const railX = new Map<string, number>();
  const inputs = new Map<number, ComponentInstance>(), nots = new Map<number, ComponentInstance>();
  let x = 0;
  for (const i of order) {
    const pin: ComponentInstance = { id: names[i], type: "input-pin", x: x + 10, y: 0, rotation: 90, props: { name: names[i] }, label: "" };
    components.push(pin);
    inputs.set(i, pin);
    railX.set(`${i}`, x);
    if (inverted.has(i)) {
      const nx = x + 40;
      const g: ComponentInstance = { id: `N_${names[i]}`, type: "not", x: nx + 20, y: INV_Y, rotation: 90, props: {}, label: `${names[i]}'` };
      components.push(g);
      nots.set(i, g);
      railX.set(`${i}'`, nx);
      x += 100;
    } else x += 60;
  }

  // ---- AND column --------------------------------------------------------------------------------
  const andX = x + 40;
  let y = 220;
  interface Src { pt: Point; from: string; users: number[] }
  const srcs: Src[] = [];
  const taps = new Map<string, { y: number; to: string; toPt: Point }[]>();
  const addTap = (k: string, t: { y: number; to: string; toPt: Point }) => {
    const l = taps.get(k);
    if (l) l.push(t);
    else taps.set(k, [t]);
  };
  products.forEach((p, idx) => {
    const lits: { i: number; plain: boolean }[] = [];
    for (const i of order) if (!(p.t.mask & (1 << i))) lits.push({ i, plain: !!(p.t.value & (1 << i)) });
    if (lits.length === 1) {
      // a single literal: its rail runs straight through a free row of the AND column
      const k = lits[0].plain ? `${lits[0].i}` : `${lits[0].i}'`;
      srcs.push({ pt: { x: railX.get(k)!, y: y + 10 }, from: `rail:${k}`, users: p.users });
      y += 50;
      return;
    }
    const g: ComponentInstance = { id: `P${idx}`, type: "and", x: andX, y, rotation: 0, props: { inputs: lits.length }, label: termToString(p.t, names) };
    components.push(g);
    lits.forEach((l, j) => {
      const pp = pinPos(g, `in${j}`);
      addTap(l.plain ? `${l.i}` : `${l.i}'`, { y: pp.y, to: term(g, `in${j}`), toPt: pp });
    });
    srcs.push({ pt: pinPos(g, "out"), from: term(g, "out"), users: p.users });
    y += 20 * lits.length + 30;
  });
  const andRight = Math.max(andX + 100, ...components.filter((c) => c.type === "and").map((c) => pinPos(c, "out").x));

  // rails
  const railWire = new Map<string, string>();
  for (const i of order)
    for (const plain of [true, false]) {
      const k = plain ? `${i}` : `${i}'`;
      if (!railX.has(k)) continue;
      const rx = railX.get(k)!;
      const lows = [...(taps.get(k) ?? []).map((t) => t.y), ...srcs.filter((s) => s.from === `rail:${k}`).map((s) => s.pt.y)];
      const top = plain ? RAIL_TOP : pinPos(nots.get(i)!, "out").y;
      const bottom = Math.max(top, ...lows, plain && inverted.has(i) ? FEED_Y : top);
      const src = plain ? term(inputs.get(i)!, "out") : term(nots.get(i)!, "out");
      if (bottom > top) railWire.set(k, wire([{ x: rx, y: top }, { x: rx, y: bottom }], src, null));
    }
  for (const [i, g] of nots) {
    const rx = railX.get(`${i}`)!;
    const inPt = pinPos(g, "in0");
    wire([{ x: rx, y: FEED_Y }, { x: inPt.x, y: FEED_Y }, inPt], `w:${railWire.get(`${i}`)}`, term(g, "in0"));
  }
  for (const [k, ts] of taps) for (const t of ts) wire([{ x: railX.get(k)!, y: t.y }, t.toPt], `w:${railWire.get(k)}`, t.to);
  for (const s of srcs) if (s.from.startsWith("rail:")) s.from = `w:${railWire.get(s.from.slice(5))}`;

  // ---- OR gates: in output order, each near the products it uses -------------------------------
  const laneX = (j: number) => andRight + 20 + 10 * j;
  const orX = laneX(srcs.length) + 30;
  const andOutYs = new Set(srcs.map((s) => s.pt.y));
  const ors: (ComponentInstance | null)[] = [];
  let nextFree = 220;
  outputs.forEach((o, k) => {
    const mine = srcs.filter((s) => s.users.includes(k));
    if (o.terms.some((t) => literalCount(t, n) === 0) || mine.length < 2) {
      ors.push(null);
      return;
    }
    const h = 20 * mine.length;
    let oy = Math.max(Math.round((mine.reduce((s, m) => s + m.pt.y, 0) / mine.length - h / 2) / 10) * 10, nextFree);
    // no OR input may sit on the row of an AND output (the two horizontal wires would overlap)
    while (Array.from({ length: mine.length }, (_, j) => oy + 10 + 20 * j).some((yy) => andOutYs.has(yy))) oy += 10;
    const g: ComponentInstance = { id: `S${k}`, type: "or", x: orX, y: oy, rotation: 0, props: { inputs: mine.length }, label: o.label ?? "" };
    components.push(g);
    ors.push(g);
    nextFree = oy + h + 40;
  });

  // where each product goes: OR inputs, or the output pin itself for a one-product output
  const outX = orX + 150;
  const targets: { pt: Point; to: string }[][] = srcs.map(() => []);
  outputs.forEach((o, k) => {
    const mine = srcs.map((s, j) => ({ s, j })).filter(({ s }) => s.users.includes(k));
    const pin: ComponentInstance = { id: o.name, type: "output-pin", x: outX, y: 0, rotation: 0, props: { name: o.name }, label: "" };
    const g = ors[k];
    if (g) {
      const outPt = pinPos(g, "out");
      pin.y = outPt.y - 10;
      components.push(pin);
      wire([outPt, pinPos(pin, "in")], term(g, "out"), term(pin, "in"));
      mine.forEach(({ j }, m) => targets[j].push({ pt: pinPos(g, `in${m}`), to: term(g, `in${m}`) }));
      return;
    }
    const constOne = o.terms.some((t) => literalCount(t, n) === 0);
    if (constOne || mine.length === 0) {
      const c: ComponentInstance = { id: `K${k}`, type: "constant", x: outX - 80, y: nextFree, rotation: 0, props: { value: constOne ? "1" : "0" }, label: "" };
      components.push(c);
      const a = pinPos(c, "out");
      pin.y = a.y - 10;
      components.push(pin);
      wire([a, pinPos(pin, "in")], term(c, "out"), term(pin, "in"));
      nextFree += 50;
      return;
    }
    let py = Math.max(nextFree, Math.round(mine[0].s.pt.y / 10) * 10);
    while (andOutYs.has(py) && py !== mine[0].s.pt.y) py += 10;
    pin.y = py - 10;
    components.push(pin);
    targets[mine[0].j].push({ pt: pinPos(pin, "in"), to: term(pin, "in") });
    nextFree = py + 50;
  });

  // ---- lanes: AND output -> its own vertical lane -> each target -------------------------------
  srcs.forEach((s, j) => {
    const ts = targets[j];
    if (!ts.length) return;
    const lx = laneX(j);
    const ys = [s.pt.y, ...ts.map((t) => t.pt.y)];
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y0 === y1) {
      wire([s.pt, ts[0].pt], s.from, ts[0].to);
      return;
    }
    const lane = wire([{ x: lx, y: y0 }, { x: lx, y: y1 }], null, null);
    wire([s.pt, { x: lx, y: s.pt.y }], s.from, `w:${lane}`);
    for (const t of ts) wire([{ x: lx, y: t.pt.y }, t.pt], `w:${lane}`, t.to);
  });

  return { format: "digischem", version: 1, name: opts.title ?? outputs.map((o) => o.name).join(", "), grid: 10, components, wires, texts: [], links };
}

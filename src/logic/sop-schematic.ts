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

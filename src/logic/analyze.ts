/**
 * Truth tables and Karnaugh maps read from a circuit by simulating it: every combination of
 * the inputs is applied and the outputs recorded, so the result is what the drawing computes,
 * whatever gates it uses. Each output bit then gets its minimal sum of products (minimize.ts).
 */
import type { Circuit, CircuitPart } from "./circuit";
import { STATEFUL } from "./check";
import { kmapText, minimize, sopToString, type MinimizeResult } from "./minimize";
import { MODELS } from "./models";
import { type Bit, PASSIVE, Simulator, STIMULI, SWITCHES, bitChar, numberToBits } from "./simulate";

export interface Port {
  /** part id */
  id: string;
  name: string;
  width: number;
}

export interface TruthTable {
  inputs: Port[];
  outputs: Port[];
  /**
   * Input variable names, LEAST significant first (variable i is bit i of the row number), as
   * minimize() numbers them: the first input given is the most significant, a bus as name[k].
   */
  vars: string[];
  /** output bit names, in the order of `rows[m]` */
  outBits: string[];
  /** rows[m][j]: output bit j for row m */
  rows: Bit[][];
}

export interface TruthTableOptions {
  /** input part ids or names, most significant first (default: every input pin, in document order) */
  inputs?: string[];
  /** output part ids or names (default: every output pin) */
  outputs?: string[];
  /** refuse more input bits than this (default 16: 65536 rows) */
  maxInputBits?: number;
}

/** Parts that only show a value: they end a cone, and their inputs can be outputs of a table. */
const OUTPUTS = new Set(["output-pin", "probe", "seven-segment", "hex-display", "led-bar"]);

function findPart(c: Circuit, ref: string): CircuitPart {
  const p = c.parts.find((x) => x.id === ref) ?? c.parts.find((x) => x.name === ref);
  if (!p) throw new Error(`no part ${ref}`);
  return p;
}

const width = (p: CircuitPart, dir: "in" | "out") => p.pins.filter((x) => x.dir === dir).reduce((s, x) => s + x.width, 0);

/**
 * Parts with state (or not simulated) that the given parts depend on. A truth table of an output
 * that depends on them would describe one state, not the function.
 */
export function stateInCone(c: Circuit, from: readonly CircuitPart[]): CircuitPart[] {
  const drivers: number[][] = Array.from({ length: c.nodes }, () => []);
  c.parts.forEach((p, pi) => p.pins.forEach((pin) => pin.dir !== "in" && pin.bits.forEach((n) => drivers[n].push(pi))));
  const seen = new Set<number>();
  const found: CircuitPart[] = [];
  const stack = from.map((p) => c.parts.indexOf(p));
  while (stack.length) {
    const pi = stack.pop()!;
    if (seen.has(pi)) continue;
    seen.add(pi);
    const p = c.parts[pi];
    if (STATEFUL.has(p.type) || (!MODELS[p.type] && !STIMULI.has(p.type) && !PASSIVE.has(p.type) && !SWITCHES[p.type] && !OUTPUTS.has(p.type))) found.push(p);
    for (const pin of p.pins) if (pin.dir !== "out") for (const n of pin.bits) for (const d of drivers[n]) if (!seen.has(d)) stack.push(d);
  }
  return found;
}

/** Simulate every input combination. Throws for a circuit whose outputs depend on state. */
export function truthTable(c: Circuit, opts: TruthTableOptions = {}): TruthTable {
  const ins = (opts.inputs ?? c.parts.filter((p) => p.type === "input-pin").map((p) => p.id)).map((r) => findPart(c, r));
  const outs = (opts.outputs ?? c.parts.filter((p) => p.type === "output-pin").map((p) => p.id)).map((r) => findPart(c, r));
  for (const p of ins) if (!STIMULI.has(p.type)) throw new Error(`${p.name} is not an input`);
  for (const p of outs) if (!p.pins.some((x) => x.dir === "in")) throw new Error(`${p.name} has no input to read`);
  const state = stateInCone(c, outs);
  if (state.length) throw new Error(`the outputs depend on parts with state or that are not simulated: ${state.map((p) => `${p.name} (${p.type})`).join(", ")}`);
  const inputs: Port[] = ins.map((p) => ({ id: p.id, name: p.name, width: width(p, "out") }));
  const outputs: Port[] = outs.map((p) => ({ id: p.id, name: p.name, width: width(p, "in") }));
  const n = inputs.reduce((s, p) => s + p.width, 0);
  if (n > (opts.maxInputBits ?? 16)) throw new Error(`${n} input bits is too many for a truth table`);
  const bitName = (p: Port, k: number) => (p.width === 1 ? p.name : `${p.name}[${k}]`);
  const vars: string[] = [];
  for (let i = inputs.length - 1; i >= 0; i--) for (let k = 0; k < inputs[i].width; k++) vars.push(bitName(inputs[i], k));
  const outBits: string[] = [];
  for (const p of outputs) for (let k = 0; k < p.width; k++) outBits.push(bitName(p, k));

  const sim = new Simulator(c);
  const rows: Bit[][] = [];
  for (let m = 0; m < 1 << n; m++) {
    let at = 0;
    for (let i = inputs.length - 1; i >= 0; i--) {
      // as raw bits, so every output bit of the input (a keypad's VALID too) takes both values
      sim.set(inputs[i].id, numberToBits((m >> at) & ((1 << inputs[i].width) - 1), inputs[i].width));
      at += inputs[i].width;
    }
    sim.settle();
    const row: Bit[] = [];
    for (const p of outs) for (const pin of p.pins) if (pin.dir === "in") row.push(...sim.pinBits(p.id, pin.id));
    rows.push(row);
  }
  return { inputs, outputs, vars, outBits, rows };
}

/** The table as text: one row per input combination, MSB first. */
export function truthTableText(t: TruthTable): string {
  const head = [...t.vars].reverse().join(" ") + " | " + t.outBits.join(" ");
  const lines = [head, "-".repeat(head.length)];
  const nv = t.vars.length;
  t.rows.forEach((row, m) => {
    const ins = [...t.vars].reverse().map((v, i) => String((m >> (nv - 1 - i)) & 1).padStart(v.length));
    lines.push(ins.join(" ") + " | " + row.map((b, j) => bitChar(b).padStart(t.outBits[j].length)).join(" "));
  });
  return lines.join("\n");
}

export interface OutputFunction {
  /** output bit name */
  name: string;
  minterms: number[];
  /** rows where the output is X or Z: the circuit does not define it there */
  unknown: number[];
  /** minimal sum of products (unknown rows count as 0) */
  result: MinimizeResult;
  /** the sum of products as text, with the table's variable names */
  sop: string;
  /** Karnaugh map text (2 to 4 inputs only) */
  kmap?: string;
}

/** Each output bit of a truth table as a boolean function: minterms, minimal SOP, Karnaugh map. */
export function outputFunctions(t: TruthTable): OutputFunction[] {
  const n = t.vars.length;
  return t.outBits.map((name, j) => {
    const minterms: number[] = [], unknown: number[] = [];
    t.rows.forEach((row, m) => {
      if (row[j] === 1) minterms.push(m);
      else if (row[j] > 1) unknown.push(m);
    });
    const result = minimize(n, minterms);
    const f: OutputFunction = { name, minterms, unknown, result, sop: sopToString(result.terms, t.vars) };
    if (n >= 2 && n <= 4) {
      const set = new Set(minterms), unk = new Set(unknown);
      f.kmap = kmapText(n, (m) => (set.has(m) ? 1 : unk.has(m) ? "x" : 0), t.vars, result.terms);
    }
    return f;
  });
}

/** Parts a state table can cut open: their outputs are the present state, their inputs the next-state logic. */
const STATE_PARTS = new Set(["d-ff", "jk-ff", "t-ff", "sr-ff", "d-latch", "sr-latch", "gated-sr-latch", "register"]);

export interface StateTable extends TruthTable {
  /** the state variables (present state), most significant first, as they appear in `inputs` */
  state: Port[];
}

/**
 * The state table of a synchronous circuit, for designing or checking its next-state logic:
 * every flip-flop (and latch, register) is cut out, its Q output becomes an input of the table
 * (the present state, named `F1_q`) and each of its other inputs except the clock becomes an
 * output (`F1_d`, `F1_j`...); Q' is computed from Q. The table's inputs are the present state
 * (first, most significant) followed by the circuit's inputs; its outputs are the flip-flop
 * inputs followed by the circuit's outputs. outputFunctions() then gives the excitation equations.
 */
export function stateTable(c: Circuit, opts: { inputs?: string[]; outputs?: string[]; maxInputBits?: number } = {}): StateTable {
  const parts: CircuitPart[] = [];
  const state: CircuitPart[] = [];
  const excite: CircuitPart[] = [];
  for (const p of c.parts) {
    if (!STATEFUL.has(p.type)) {
      parts.push(p);
      continue;
    }
    if (!STATE_PARTS.has(p.type)) throw new Error(`${p.name} (${p.type}) cannot be cut open for a state table`);
    const q = p.pins.find((x) => x.id === "q");
    if (!q) continue;
    const pin = (id: string, dir: "in" | "out", src: typeof q) => ({ ...src, id, name: id, dir, inverted: false, clock: false });
    const sv: CircuitPart = { id: `${p.id}__q`, name: `${p.name}_q`, type: "input-pin", props: { name: `${p.name}_q`, width: q.width }, pins: [pin("out", "out", q)] };
    parts.push(sv);
    state.push(sv);
    const qn = p.pins.find((x) => x.id === "qn");
    if (qn)
      for (let b = 0; b < qn.width; b++)
        parts.push({
          id: `${p.id}__qn${b}`,
          name: `${p.name}_qn${b}`,
          type: "not",
          props: {},
          pins: [
            { ...pin("in0", "in", q), width: 1, bits: [q.bits[b]] },
            { ...pin("out", "out", qn), width: 1, bits: [qn.bits[b]] },
          ],
        });
    for (const x of p.pins) {
      if (x.dir !== "in" || x.clock) continue;
      const o: CircuitPart = { id: `${p.id}__${x.id}`, name: `${p.name}_${x.id}`, type: "output-pin", props: { name: `${p.name}_${x.id}`, width: x.width }, pins: [{ ...x, id: "in", name: "in", inverted: false }] };
      parts.push(o);
      excite.push(o);
    }
  }
  const cut: Circuit = { ...c, parts };
  const ins = opts.inputs ?? c.parts.filter((p) => p.type === "input-pin").map((p) => p.id);
  const outs = opts.outputs ?? c.parts.filter((p) => p.type === "output-pin").map((p) => p.id);
  const t = truthTable(cut, { inputs: [...state.map((p) => p.id), ...ins], outputs: [...excite.map((p) => p.id), ...outs], maxInputBits: opts.maxInputBits });
  return { ...t, state: t.inputs.slice(0, state.length) };
}

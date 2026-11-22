/**
 * Truth tables and Karnaugh maps read from a circuit by simulating it: every combination of
 * the inputs is applied and the outputs recorded, so the result is what the drawing computes,
 * whatever gates it uses. Each output bit then gets its minimal sum of products (minimize.ts).
 */
import type { Circuit, CircuitPart } from "./circuit";
import { STATEFUL, checkCircuit, switchClusters } from "./check";
import { kmapText, minimize, sopToString, type MinimizeResult } from "./minimize";
import { MODELS } from "./models";
import { type Bit, PASSIVE, Simulator, STIMULI, SUPPLIES, SWITCHES, bitChar, numberToBits } from "./simulate";

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
  // the parts that can set each node: its drivers, and the transistors (and their drivers)
  // that can connect it to other nets, though not back through a supply rail
  const local = switchClusters(c, false);
  const rail = new Set<number>();
  for (const p of c.parts) if (SUPPLIES.has(p.type)) for (const pin of p.pins) if (pin.dir !== "in") for (const n of pin.bits) rail.add(n);
  const byCluster = new Map<number, number[]>();
  c.parts.forEach((p, pi) =>
    p.pins.forEach((pin) => {
      if (pin.dir === "in") return;
      for (const n of pin.bits) {
        if (SWITCHES[p.type] && rail.has(n)) continue; // a transistor on a rail does not set the rail
        const l = byCluster.get(local[n]);
        if (l) l.push(pi);
        else byCluster.set(local[n], [pi]);
      }
    }),
  );
  const drivers: number[][] = Array.from({ length: c.nodes }, (_, n) => byCluster.get(local[n]) ?? []);
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

/** Parts of combinational feedback loops that the given parts depend on. */
export function loopsInCone(c: Circuit, from: readonly CircuitPart[]): CircuitPart[] {
  const inLoop = new Set<string>();
  for (const i of checkCircuit(c)) if (i.kind === "feedback") for (const n of i.pins) inLoop.add(n);
  if (!inLoop.size) return [];
  // walk the cone backwards, like stateInCone, collecting loop parts
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
    if (inLoop.has(p.name)) found.push(p);
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
  const loops = loopsInCone(c, outs);
  if (loops.length) throw new Error(`the outputs depend on a feedback loop (a latch built from gates?), so they have a state: ${loops.map((p) => p.name).join(", ")}`);
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
    // Q is one bus pin `q` or bit pins q0, q1, ...: either way one state variable per pin
    const qs = p.pins.filter((x) => x.dir === "out" && /^q\d*$/.test(x.id));
    if (!qs.length) continue;
    const pin = (id: string, dir: "in" | "out", src: (typeof qs)[number]) => ({ ...src, id, name: id, dir, inverted: false, clock: false });
    for (const q of qs) {
      const sv: CircuitPart = { id: `${p.id}__${q.id}`, name: `${p.name}_${q.id}`, type: "input-pin", props: { name: `${p.name}_${q.id}`, width: q.width }, pins: [pin("out", "out", q)] };
      parts.push(sv);
      state.push(sv);
    }
    const qBits = qs.flatMap((q) => q.bits);
    const qn = p.pins.find((x) => x.id === "qn");
    if (qn)
      for (let b = 0; b < qn.width; b++)
        parts.push({
          id: `${p.id}__qn${b}`,
          name: `${p.name}_qn${b}`,
          type: "not",
          props: {},
          pins: [
            { ...pin("in0", "in", qs[0]), width: 1, bits: [qBits[b]] },
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
  // (the parts are renumbered: the build issues, which point at parts by index, do not carry over)
  const cut: Circuit = { ...c, parts, issues: [] };
  const ins = opts.inputs ?? c.parts.filter((p) => p.type === "input-pin").map((p) => p.id);
  const outs = opts.outputs ?? c.parts.filter((p) => p.type === "output-pin").map((p) => p.id);
  const t = truthTable(cut, { inputs: [...state.map((p) => p.id), ...ins], outputs: [...excite.map((p) => p.id), ...outs], maxInputBits: opts.maxInputBits });
  return { ...t, state: t.inputs.slice(0, state.length) };
}

export interface Mismatch {
  /** input values by name (for a sequential compare, at the cycle where they differ) */
  inputs: Record<string, number>;
  /** clock cycle of a sequential compare (0 for combinational) */
  cycle: number;
  output: string;
  a: number | null;
  b: number | null;
}

export interface CompareResult {
  equal: boolean;
  /** how the circuits were compared */
  mode: "exhaustive" | "random";
  /** input combinations (or cycles) tried */
  tried: number;
  mismatches: Mismatch[];
  /** inputs and outputs only one of the circuits has */
  onlyA: string[];
  onlyB: string[];
}

export interface CompareOptions {
  /** input bits up to which a combinational compare tries every combination (default 16) */
  maxInputBits?: number;
  /** random cycles for a sequential compare (default 500) */
  cycles?: number;
  seed?: number;
  /** stop after this many mismatches (default 10) */
  maxMismatches?: number;
  /** names of inputs that reset the design: held at 1 for the first two cycles of a sequential compare */
  resets?: string[];
}

/**
 * Do two circuits compute the same thing? Inputs and outputs are matched by name (input pins and
 * output pins). Combinational circuits are compared on every input combination; circuits with
 * state, on seeded random inputs over many clock cycles (both starting at 0, and with the reset
 * inputs held for the first cycles). An X on both sides counts as equal.
 */
export function compareCircuits(a: Circuit, b: Circuit, opts: CompareOptions = {}): CompareResult {
  const ports = (c: Circuit, type: string) => new Map(c.parts.filter((p) => p.type === type).map((p) => [p.name, p] as const));
  const ia = ports(a, "input-pin"), ib = ports(b, "input-pin"), oa = ports(a, "output-pin"), ob = ports(b, "output-pin");
  const onlyA = [...[...ia.keys()].filter((k) => !ib.has(k)), ...[...oa.keys()].filter((k) => !ob.has(k))];
  const onlyB = [...[...ib.keys()].filter((k) => !ia.has(k)), ...[...ob.keys()].filter((k) => !oa.has(k))];
  const ins = [...ia.keys()].filter((k) => ib.has(k));
  const outs = [...oa.keys()].filter((k) => ob.has(k));
  const widthOf = (p: CircuitPart) => p.pins.reduce((s, x) => s + (x.dir === "out" ? x.width : 0), 0);
  const widths = ins.map((k) => Math.max(widthOf(ia.get(k)!), widthOf(ib.get(k)!)));
  const sa = new Simulator(a, { initial: "zero" }), sb = new Simulator(b, { initial: "zero" });
  const max = opts.maxMismatches ?? 10;
  const mismatches: Mismatch[] = [];
  const apply = (vals: number[]) => ins.forEach((k, i) => (sa.set(ia.get(k)!.id, vals[i]), sb.set(ib.get(k)!.id, vals[i])));
  const check = (vals: number[], cycle: number) => {
    for (const k of outs) {
      const x = sa.read(oa.get(k)!.id), y = sb.read(ob.get(k)!.id);
      if (x !== y && mismatches.length < max) mismatches.push({ inputs: Object.fromEntries(ins.map((n, i) => [n, vals[i]])), cycle, output: k, a: x, b: y });
    }
  };
  const sequential = stateInCone(a, [...oa.values()]).length > 0 || stateInCone(b, [...ob.values()]).length > 0;
  const bits = widths.reduce((s, w) => s + w, 0);
  if (!sequential && bits <= (opts.maxInputBits ?? 16)) {
    let tried = 0;
    for (let m = 0; m < 2 ** bits && mismatches.length < max; m++, tried++) {
      let at = 0;
      const vals = widths.map((w) => {
        const v = Math.floor(m / 2 ** at) % 2 ** w;
        at += w;
        return v;
      });
      apply(vals);
      sa.settle();
      sb.settle();
      check(vals, 0);
    }
    return { equal: !mismatches.length && !onlyA.length && !onlyB.length, mode: "exhaustive", tried, mismatches, onlyA, onlyB };
  }
  let seed = (opts.seed ?? 1) >>> 0 || 1;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const resets = new Set(opts.resets ?? []);
  const clocks = (s: Simulator) => s.circuit.parts.some((p) => p.type === "clock");
  const cycles = opts.cycles ?? 500;
  let tried = 0;
  for (let t = 0; t < cycles && mismatches.length < max; t++, tried++) {
    const vals = ins.map((k, i) => (resets.has(k) ? (t < 2 ? 1 : 0) : Math.floor(rnd() * 2 ** widths[i])));
    apply(vals);
    sa.settle();
    sb.settle();
    check(vals, t);
    // a clock cycle, compared while the clock is high too: that tells the edges apart
    const phase = (v: number) => {
      for (const s of [sa, sb]) {
        if (!clocks(s)) continue;
        for (const p of s.circuit.parts) if (p.type === "clock") s.set(p.id, v);
        s.settle();
      }
    };
    phase(1);
    check(vals, t + 0.5);
    phase(0);
  }
  return { equal: !mismatches.length && !onlyA.length && !onlyB.length, mode: "random", tried, mismatches, onlyA, onlyB };
}

export interface ScanFinding {
  kind: "contention" | "floating" | "oscillation";
  pins: string[];
  message: string;
  /** how many of the tried inputs showed it */
  count: number;
  /** the first input values (by input name) that showed it, and the clock cycle */
  example: Record<string, number>;
  cycle: number;
}

export interface ScanResult {
  mode: "exhaustive" | "random";
  tried: number;
  findings: ScanFinding[];
}

/**
 * Run a circuit through its inputs and collect the problems that only show for some values: a
 * short that happens when two tri-state buffers are enabled together, an input that floats when
 * a bus is released, a loop that oscillates for one input combination. Circuits without clocks
 * with up to `maxInputBits` (default 12) input bits are tried exhaustively; others with `vectors`
 * (default 256) seeded random inputs, ticking the clocks after each.
 */
export function scanCircuit(c: Circuit, opts: { maxInputBits?: number; vectors?: number; seed?: number; initial?: "x" | "zero" } = {}): ScanResult {
  const ins = c.parts.filter((p) => STIMULI.has(p.type) && p.type !== "clock");
  const widths = ins.map((p) => p.pins.reduce((s, x) => s + (x.dir === "out" ? x.width : 0), 0));
  const bits = widths.reduce((s, w) => s + w, 0);
  const clocked = c.parts.some((p) => p.type === "clock");
  const sim = new Simulator(c, { initial: opts.initial ?? "zero" });
  const found = new Map<string, ScanFinding>();
  const note = (vals: number[], cycle: number, issues: { kind: string; pins: string[]; message: string }[]) => {
    for (const i of issues) {
      if (i.kind !== "contention" && i.kind !== "floating" && i.kind !== "oscillation") continue;
      const key = `${i.kind}|${[...i.pins].sort().join(",")}`;
      const f = found.get(key);
      if (f) f.count++;
      else found.set(key, { kind: i.kind, pins: i.pins, message: i.message, count: 1, example: Object.fromEntries(ins.map((p, k) => [p.name, vals[k]])), cycle });
    }
  };
  const apply = (vals: number[]) => ins.forEach((p, k) => sim.set(p.id, numberToBits(vals[k], widths[k])));
  if (!clocked && bits <= (opts.maxInputBits ?? 12)) {
    for (let m = 0; m < 2 ** bits; m++) {
      let at = 0;
      const vals = widths.map((w) => {
        const v = Math.floor(m / 2 ** at) % 2 ** w;
        at += w;
        return v;
      });
      apply(vals);
      note(vals, 0, sim.settle().issues);
    }
    return { mode: "exhaustive", tried: 2 ** bits, findings: [...found.values()] };
  }
  let seed = (opts.seed ?? 1) >>> 0 || 1;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const n = opts.vectors ?? 256;
  for (let t = 0; t < n; t++) {
    const vals = widths.map((w) => Math.floor(rnd() * 2 ** Math.min(w, 32)));
    apply(vals);
    note(vals, t, sim.settle().issues);
    if (clocked) for (const r of sim.tick()) note(vals, t, r.issues);
  }
  return { mode: "random", tried: n, findings: [...found.values()] };
}

export interface Hazard {
  /** output pin name (and bit, for a bus) */
  output: string;
  /** static-1: should stay 1 but dips to 0; static-0: should stay 0 but pulses to 1; dynamic: changes more than once on its way to the new value */
  kind: "static-0" | "static-1" | "dynamic";
  /** the input that changed */
  input: string;
  /** input values before the change, by input name */
  from: Record<string, number>;
  /** the values the output went through, one gate delay apart */
  waveform: string;
  /** how many single-input changes showed this hazard on this output and input */
  count: number;
}

/**
 * Hazards (glitches) of a combinational circuit, found with unit gate delays: from every input
 * combination (up to `maxInputBits`, default 10), every single input bit is changed, and each
 * output that goes through more than the one expected change is reported. A two-level circuit
 * built from a minimal sum of products has static-1 hazards wherever two adjacent groups on the
 * Karnaugh map are not overlapped by a third (the consensus term).
 */
export function hazardScan(c: Circuit, opts: { maxInputBits?: number; outputs?: string[] } = {}): Hazard[] {
  const ins = c.parts.filter((p) => p.type === "input-pin");
  const outs = (opts.outputs ?? c.parts.filter((p) => p.type === "output-pin").map((p) => p.id)).map((r) => findPart(c, r));
  const bitsOf = (p: CircuitPart) => p.pins.filter((x) => x.dir === "out").flatMap((x) => x.bits);
  const inBits = ins.map((p) => bitsOf(p).length);
  const n = inBits.reduce((s, w) => s + w, 0);
  if (n > (opts.maxInputBits ?? 10)) throw new Error(`${n} input bits is too many to scan for hazards`);
  const watch: { name: string; node: number }[] = [];
  for (const p of outs) {
    const pin = p.pins.find((x) => x.dir === "in");
    if (!pin) continue;
    pin.bits.forEach((node, k) => watch.push({ name: pin.bits.length > 1 ? `${p.name}[${k}]` : p.name, node }));
  }
  const sim = new Simulator(c, { timing: "unit", initial: "zero" });
  const apply = (m: number) => {
    let at = 0;
    ins.forEach((p, i) => {
      sim.set(p.id, (m >> at) & ((1 << inBits[i]) - 1));
      at += inBits[i];
    });
  };
  const bitName = (b: number) => {
    let at = 0;
    for (let i = 0; i < ins.length; i++) {
      if (b < at + inBits[i]) return inBits[i] > 1 ? `${ins[i].name}[${b - at}]` : ins[i].name;
      at += inBits[i];
    }
    return `bit${b}`;
  };
  const values = (m: number) => {
    const o: Record<string, number> = {};
    let at = 0;
    ins.forEach((p, i) => {
      o[p.name] = (m >> at) & ((1 << inBits[i]) - 1);
      at += inBits[i];
    });
    return o;
  };
  const found = new Map<string, Hazard>();
  for (let m = 0; m < 1 << n; m++)
    for (let b = 0; b < n; b++) {
      apply(m);
      sim.settle();
      apply(m ^ (1 << b));
      const r = sim.settle();
      for (const w of watch) {
        const h = r.history?.get(w.node);
        if (!h || h.length < 3 || h.some((x) => x > 1)) continue;
        const kind = h[0] === h[h.length - 1] ? (h[0] === 1 ? "static-1" : "static-0") : h.length >= 4 ? "dynamic" : null;
        if (!kind) continue;
        const key = `${w.name}|${kind}|${bitName(b)}`;
        const f = found.get(key);
        if (f) f.count++;
        else found.set(key, { output: w.name, kind, input: bitName(b), from: values(m), waveform: h.map((x) => "01XZ"[x]).join(""), count: 1 });
      }
    }
  return [...found.values()];
}

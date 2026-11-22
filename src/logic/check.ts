/**
 * Static checks on the stripped circuit: problems visible from the connections alone, before
 * anything is simulated. A simulation (simulate.ts) then finds the ones that depend on values,
 * such as two enabled tri-state buffers disagreeing.
 */
import type { Circuit } from "./circuit";
import { MODELS } from "./models";
import { PASSIVE, STIMULI } from "./simulate";

export type Severity = "error" | "warning" | "info";

export interface CheckIssue {
  kind:
    | "floating-input"
    | "multiple-drivers"
    | "possible-contention"
    | "width-mismatch"
    | "unmodelled"
    | "feedback"
    | "unused-input";
  severity: Severity;
  /** the pins involved, as `part name.pin` */
  pins: string[];
  message: string;
}

/** Outputs that may share a net (they can stop driving it). */
const CONDITIONAL = new Set(["tristate", "bus-transceiver", "nmos", "pmos", "transmission-gate"]);
const WEAK = new Set(["pull-up", "pull-down"]);
/** Parts that remember something: a loop through one of these is not a combinational loop. */
export const STATEFUL = new Set([
  "sr-latch", "d-latch", "gated-sr-latch", "d-ff", "jk-ff", "t-ff", "sr-ff",
  "register", "shift-register", "counter", "register-file", "ring-counter", "lfsr",
  "clock-divider", "synchronizer", "edge-detector", "decade-counter", "debouncer",
  "ram", "rom", "fifo", "dual-port-ram", "stack",
]);

export function checkCircuit(c: Circuit): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const label = (pi: number, k: number) => `${c.parts[pi].name}.${c.parts[pi].pins[k].id}`;

  // who drives and who reads each bit node
  const strong: number[][] = Array.from({ length: c.nodes }, () => []);
  const cond: number[][] = Array.from({ length: c.nodes }, () => []);
  const weak: number[][] = Array.from({ length: c.nodes }, () => []);
  const drvPin: string[][] = Array.from({ length: c.nodes }, () => []);
  c.parts.forEach((p, pi) => {
    if (PASSIVE.has(p.type)) return;
    p.pins.forEach((pin, k) => {
      if (pin.dir === "in") return;
      for (const n of pin.bits) {
        (WEAK.has(p.type) ? weak : CONDITIONAL.has(p.type) || pin.dir === "inout" ? cond : strong)[n].push(pi);
        drvPin[n].push(label(pi, k));
      }
    });
  });
  // ground's only pin is bidirectional but it always drives 0
  c.parts.forEach((p, pi) => {
    if (p.type !== "ground") return;
    for (const pin of p.pins)
      for (const n of pin.bits) {
        cond[n] = cond[n].filter((x) => x !== pi);
        strong[n].push(pi);
      }
  });

  // ---- floating inputs ----
  c.parts.forEach((p, pi) => {
    if (PASSIVE.has(p.type)) return;
    p.pins.forEach((pin, k) => {
      if (pin.dir !== "in") return;
      const undriven = pin.bits.filter((n) => !strong[n].length && !cond[n].length && !weak[n].length);
      if (!undriven.length) return;
      const what = pin.net < 0 ? "is not connected" : undriven.length < pin.bits.length ? `has ${undriven.length} undriven bit(s)` : `is on net ${c.nets[pin.net].name}, which nothing drives`;
      issues.push({ kind: "floating-input", severity: "error", pins: [label(pi, k)], message: `${label(pi, k)} ${what}` });
    });
  });

  // ---- several outputs on one net ----
  const seen = new Set<string>();
  for (let n = 0; n < c.nodes; n++) {
    const parts = new Set(strong[n]);
    const key = drvPin[n].slice().sort().join(",");
    if (seen.has(key)) continue;
    if (parts.size >= 2) {
      seen.add(key);
      issues.push({ kind: "multiple-drivers", severity: "error", pins: drvPin[n], message: `outputs are joined (a short whenever they differ): ${drvPin[n].join(", ")}` });
    } else if (parts.size === 1 && cond[n].length) {
      seen.add(key);
      issues.push({ kind: "possible-contention", severity: "warning", pins: drvPin[n], message: `an output shares a net with tri-state outputs, so they clash whenever one is enabled: ${drvPin[n].join(", ")}` });
    }
  }

  for (const i of c.issues) issues.push({ kind: "width-mismatch", severity: "error", pins: [], message: `net ${c.nets[i.net].name}: ${i.message}` });

  // ---- parts the simulator does not model ----
  for (const p of c.parts)
    if (!MODELS[p.type] && !STIMULI.has(p.type) && !PASSIVE.has(p.type) && p.pins.some((pin) => pin.dir !== "in"))
      issues.push({ kind: "unmodelled", severity: "info", pins: [p.name], message: `${p.name} (${p.type}) is not simulated; its outputs read X` });

  // ---- combinational loops (strongly connected parts, not through anything with state) ----
  const readersOf: number[][] = Array.from({ length: c.nodes }, () => []);
  c.parts.forEach((p, pi) => p.pins.forEach((pin) => pin.dir !== "out" && pin.bits.forEach((n) => readersOf[n].push(pi))));
  const succ = c.parts.map((p, pi) => {
    if (STATEFUL.has(p.type) || PASSIVE.has(p.type)) return [] as number[];
    const s = new Set<number>();
    for (const pin of p.pins) if (pin.dir !== "in") for (const n of pin.bits) for (const r of readersOf[n]) if (!STATEFUL.has(c.parts[r].type)) s.add(r);
    s.delete(pi);
    return [...s];
  });
  for (const scc of stronglyConnected(succ)) {
    if (scc.length < 2) continue;
    const names = scc.map((i) => c.parts[i].name);
    issues.push({
      kind: "feedback",
      severity: "info",
      pins: names,
      message: `combinational feedback loop through ${names.join(", ")} (fine for a latch built from gates; otherwise it may oscillate)`,
    });
  }

  // ---- inputs nothing reads ----
  c.parts.forEach((p) => {
    if (!STIMULI.has(p.type)) return;
    const used = p.pins.some((pin) => pin.dir !== "in" && pin.bits.some((n) => readersOf[n].some((r) => c.parts[r] !== p)));
    if (!used) issues.push({ kind: "unused-input", severity: "info", pins: [p.name], message: `${p.name} is not connected to anything` });
  });

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Tarjan's algorithm, iterative. */
function stronglyConnected(succ: readonly number[][]): number[][] {
  const n = succ.length;
  const index = new Array<number>(n).fill(-1), low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const out: number[][] = [];
  let next = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue;
    const work: [number, number][] = [[root, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i === 0) {
        index[v] = low[v] = next++;
        stack.push(v);
        onStack[v] = true;
      }
      if (i < succ[v].length) {
        top[1]++;
        const w = succ[v][i];
        if (index[w] < 0) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    }
  }
  return out;
}

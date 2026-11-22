/**
 * Static checks on the stripped circuit: problems visible from the connections alone, before
 * anything is simulated. A simulation (simulate.ts) then finds the ones that depend on values,
 * such as two enabled tri-state buffers disagreeing.
 */
import type { Circuit } from "./circuit";
import { MODELS } from "./models";
import { PASSIVE, STATEFUL, STIMULI, SWITCHES } from "./simulate";
import { stronglyConnected } from "./graph";

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
export { STATEFUL };

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
    const key = drvPin[n].slice().sort().join(",");
    if (seen.has(key)) continue;
    // count driving pins, not parts: two outputs of one part joined are a short too
    const strongPins = strong[n].length;
    if (strongPins >= 2) {
      seen.add(key);
      issues.push({ kind: "multiple-drivers", severity: "error", pins: drvPin[n], message: `outputs are joined (a short whenever they differ): ${drvPin[n].join(", ")}` });
    } else if (strongPins === 1 && cond[n].length) {
      seen.add(key);
      issues.push({ kind: "possible-contention", severity: "warning", pins: drvPin[n], message: `an output shares a net with tri-state outputs, so they clash whenever one is enabled: ${drvPin[n].join(", ")}` });
    }
  }

  for (const i of c.issues) issues.push({ kind: "width-mismatch", severity: "error", pins: [], message: `net ${c.nets[i.net].name}: ${i.message}` });

  // ---- parts the simulator does not model ----
  for (const p of c.parts)
    if (!MODELS[p.type] && !STIMULI.has(p.type) && !PASSIVE.has(p.type) && !SWITCHES[p.type] && p.pins.some((pin) => pin.dir !== "in"))
      issues.push({ kind: "unmodelled", severity: "info", pins: [p.name], message: `${p.name} (${p.type}) is not simulated; its outputs read X` });

  // ---- combinational loops (strongly connected parts, not through anything with state) ----
  const readersOf: number[][] = Array.from({ length: c.nodes }, () => []);
  // (a ground's pin is bidirectional, but a ground only drives)
  c.parts.forEach((p, pi) => p.type !== "ground" && p.pins.forEach((pin) => pin.dir !== "out" && pin.bits.forEach((n) => readersOf[n].push(pi))));
  const succ = c.parts.map((p) => {
    if (STATEFUL.has(p.type) || PASSIVE.has(p.type)) return [] as number[];
    const s = new Set<number>();
    for (const pin of p.pins) if (pin.dir !== "in") for (const n of pin.bits) for (const r of readersOf[n]) if (!STATEFUL.has(c.parts[r].type)) s.add(r);
    return [...s];
  });
  for (const scc of stronglyConnected(succ)) {
    if (scc.length < 2 && !succ[scc[0]].includes(scc[0])) continue;
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

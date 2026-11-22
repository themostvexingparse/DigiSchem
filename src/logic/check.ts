/**
 * Static checks on the stripped circuit: problems visible from the connections alone, before
 * anything is simulated. A simulation (simulate.ts) then finds the ones that depend on values,
 * such as two enabled tri-state buffers disagreeing.
 */
import type { Circuit } from "./circuit";
import { MODELS } from "./models";
import { PASSIVE, STATEFUL, STIMULI, SUPPLIES, SWITCHES } from "./simulate";
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
    | "unused-input"
    | "no-reset";
  severity: Severity;
  /** the pins involved, as `part name.pin` */
  pins: string[];
  message: string;
}

/** Outputs that may share a net (they can stop driving it). */
const CONDITIONAL = new Set(["tristate", "bus-transceiver", "nmos", "pmos", "transmission-gate"]);
const WEAK = new Set(["pull-up", "pull-down"]);
export { STATEFUL };

/** Outputs that can switch themselves off (Z): tri-state parts, and memories with a chip select or a shared data port. */
function conditional(p: Circuit["parts"][number]): boolean {
  if (CONDITIONAL.has(p.type)) return true;
  if ((p.type === "ram" || p.type === "rom") && p.props.chipSelect) return true;
  return p.type === "ram" && p.props.dataPortMode === "shared";
}

/** A transistor's channel pin: it joins nets rather than driving or reading them. */
const isChannel = (p: Circuit["parts"][number], pin: Circuit["parts"][number]["pins"][number]) => !!SWITCHES[p.type] && pin.dir === "inout";

/**
 * Nets that transistors can join, as a map from each node to its cluster. With `throughSupplies`
 * false, a rail (a node a supply or input drives) does not join the clusters on either side of
 * it, so the gates of a chain of CMOS inverters stay separate.
 */
export function switchClusters(c: Circuit, throughSupplies: boolean): Int32Array {
  const parent = new Int32Array(c.nodes).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const supply = new Set<number>();
  if (!throughSupplies)
    for (const p of c.parts) if (SUPPLIES.has(p.type)) for (const pin of p.pins) if (pin.dir !== "in") for (const n of pin.bits) supply.add(n);
  for (const p of c.parts) {
    const sw = SWITCHES[p.type];
    if (!sw) continue;
    for (const ch of sw) {
      const a = p.pins.find((x) => x.id === ch.ends[0]), b = p.pins.find((x) => x.id === ch.ends[1]);
      if (!a || !b) continue;
      for (let i = 0; i < Math.min(a.bits.length, b.bits.length); i++) {
        if (supply.has(a.bits[i]) || supply.has(b.bits[i])) continue;
        const x = find(a.bits[i]), y = find(b.bits[i]);
        if (x !== y) parent[x] = y;
      }
    }
  }
  return parent.map((_, i) => find(i));
}

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
      if (pin.dir === "in" || isChannel(p, pin)) return;
      for (const n of pin.bits) {
        (WEAK.has(p.type) ? weak : conditional(p) || pin.dir === "inout" ? cond : strong)[n].push(pi);
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

  // ---- floating inputs (a net transistors can connect to a driven one counts as driven) ----
  const cluster = switchClusters(c, true);
  const clusterDriven = new Set<number>();
  for (let n = 0; n < c.nodes; n++) if (strong[n].length || cond[n].length || weak[n].length) clusterDriven.add(cluster[n]);
  c.parts.forEach((p, pi) => {
    if (PASSIVE.has(p.type)) return;
    p.pins.forEach((pin, k) => {
      if (pin.dir !== "in") return;
      const undriven = pin.bits.filter((n) => !clusterDriven.has(cluster[n]));
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

  for (const i of c.issues) {
    const pins = c.nets[i.net].pins.map((r) => `${c.parts[r.part].name}.${c.parts[r.part].pins[r.pin].id}`);
    issues.push({ kind: "width-mismatch", severity: "error", pins, message: `net ${c.nets[i.net].name}: ${i.message}` });
  }

  // ---- parts with state that nothing can reset: they start unknown ----
  const RESETS = /^(rst|set|clr|ld|load)$/;
  const noReset = c.parts.filter(
    (p) => STATEFUL.has(p.type) && !["ram", "dual-port-ram", "register-file", "rom"].includes(p.type) && !p.pins.some((x) => RESETS.test(x.id) && x.net >= 0),
  );
  if (noReset.length)
    issues.push({
      kind: "no-reset",
      severity: "info",
      pins: noReset.map((p) => p.name),
      message: `${noReset.map((p) => p.name).join(", ")} ${noReset.length > 1 ? "have" : "has"} no reset connected: ${noReset.length > 1 ? "they start" : "it starts"} unknown (X) until clocked with known data`,
    });

  // ---- parts the simulator does not model ----
  for (const p of c.parts)
    if (!MODELS[p.type] && !STIMULI.has(p.type) && !PASSIVE.has(p.type) && !SWITCHES[p.type] && p.pins.some((pin) => pin.dir !== "in"))
      issues.push({ kind: "unmodelled", severity: "info", pins: [p.name], message: `${p.name} (${p.type}) is not simulated; its outputs read X` });

  // ---- combinational loops (strongly connected parts, not through anything with state) ----
  const readersOf: number[][] = Array.from({ length: c.nodes }, () => []);
  // (a ground's pin is bidirectional, but a ground only drives; a transistor reads only its gate)
  c.parts.forEach((p, pi) => p.type !== "ground" && p.pins.forEach((pin) => pin.dir !== "out" && !isChannel(p, pin) && pin.bits.forEach((n) => readersOf[n].push(pi))));
  // whatever transistors join is one net for the flow of signals (but not through the rails)
  const local = switchClusters(c, false);
  const clusterReaders = new Map<number, number[]>();
  for (let n = 0; n < c.nodes; n++) {
    const l = clusterReaders.get(local[n]);
    if (l) l.push(...readersOf[n]);
    else clusterReaders.set(local[n], [...readersOf[n]]);
  }
  const succ = c.parts.map((p, pi) => {
    if (STATEFUL.has(p.type) || PASSIVE.has(p.type)) return [] as number[];
    const s = new Set<number>();
    for (const pin of p.pins)
      if (pin.dir !== "in")
        for (const n of pin.bits)
          for (const r of clusterReaders.get(local[n]) ?? []) {
            if (STATEFUL.has(c.parts[r].type)) continue;
            // reading back its own bidirectional pin (a bus transceiver's side) is not a loop
            if (r === pi && pin.dir === "inout" && !p.pins.some((q) => q !== pin && q.dir !== "out" && q.bits.includes(n))) continue;
            s.add(r);
          }
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

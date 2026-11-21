/**
 * Evaluates a combinational drawing (basic gates, constants, input and output pins) through its
 * netlist: what the drawing actually computes, for checking a schematic against a truth table.
 * Sequential parts and anything else are not modelled; an output that depends on them, or on
 * a feedback loop, reads as undefined.
 */
import type { SchematicDocument } from "../model/types";
import { buildNetlist } from "../io/netlist";

const GATES: Record<string, (xs: boolean[]) => boolean> = {
  and: (xs) => xs.every(Boolean),
  nand: (xs) => !xs.every(Boolean),
  or: (xs) => xs.some(Boolean),
  nor: (xs) => !xs.some(Boolean),
  xor: (xs) => xs.filter(Boolean).length % 2 === 1,
  xnor: (xs) => xs.filter(Boolean).length % 2 === 0,
  not: (xs) => !xs[0],
  buffer: (xs) => xs[0],
};

/**
 * Values of the output pins (by part id) for the given input pin values (by part id). Unknown
 * inputs are false.
 */
export function evaluateCombinational(doc: SchematicDocument, inputs: Readonly<Record<string, boolean>>): Record<string, boolean | undefined> {
  const nl = buildNetlist(doc);
  const netOf = new Map<string, string>();
  for (const n of nl.nets) for (const p of n.pins) netOf.set(`${p.componentId}|${p.pinId}`, n.id);
  const val = new Map<string, boolean>();
  const set = (comp: string, pin: string, v: boolean) => {
    const n = netOf.get(`${comp}|${pin}`);
    if (n) val.set(n, v);
  };
  for (const c of doc.components) {
    if (c.type === "input-pin") set(c.id, "out", !!inputs[c.id]);
    if (c.type === "constant") set(c.id, "out", String(c.props?.value ?? "1") === "1");
  }
  // settle: a gate's output is known once all its inputs are (at most one pass per gate level)
  const gates = doc.components.filter((c) => GATES[c.type]);
  for (let pass = 0; pass <= gates.length; pass++) {
    let changed = false;
    for (const c of gates) {
      const n = c.type === "not" || c.type === "buffer" ? 1 : Number(c.props?.inputs ?? 2);
      const xs: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const v = val.get(netOf.get(`${c.id}|in${i}`) ?? "");
        if (v === undefined) break;
        xs.push(v);
      }
      if (xs.length !== n) continue;
      const out = netOf.get(`${c.id}|out`);
      const y = GATES[c.type](xs);
      if (out && val.get(out) !== y) {
        val.set(out, y);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const res: Record<string, boolean | undefined> = {};
  for (const c of doc.components) if (c.type === "output-pin") res[c.id] = val.get(netOf.get(`${c.id}|in`) ?? "");
  return res;
}

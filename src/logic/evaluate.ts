/**
 * What a combinational drawing outputs for given inputs: the drawing is reduced to its stripped
 * circuit and simulated (see circuit.ts, simulate.ts), for checking a schematic against a truth
 * table.
 */
import type { SchematicDocument } from "../model/types";
import { extractCircuit } from "./circuit";
import { Simulator } from "./simulate";

/**
 * Values of the output pins (by part id) for the given input pin values (by part id). Unknown
 * inputs are false. An output that is unknown (it depends on state that was never set, on a
 * part that is not simulated, on a floating net or a short) or that oscillates is undefined.
 */
export function evaluateCombinational(doc: SchematicDocument, inputs: Readonly<Record<string, boolean>>): Record<string, boolean | undefined> {
  const c = extractCircuit(doc);
  const sim = new Simulator(c);
  for (const p of c.parts) if (p.type === "input-pin") sim.set(p.id, !!inputs[p.id]);
  sim.settle();
  const res: Record<string, boolean | undefined> = {};
  for (const p of c.parts) {
    if (p.type !== "output-pin") continue;
    const v = sim.read(p.id);
    res[p.id] = v === null ? undefined : v !== 0;
  }
  return res;
}

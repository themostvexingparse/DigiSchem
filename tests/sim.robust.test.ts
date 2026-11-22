/**
 * Robustness: random documents made of any parts in the library, with random properties and
 * random links between any of their pins (bidirectional ones, mismatched widths, a pin linked
 * to itself, stale links to pins that do not exist). Building the stripped circuit, checking it,
 * simulating it with random inputs and clocks, and the analyses must never throw or hang.
 */
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { listDefs } from "../src/model/registry";
import type { PropValue, SchematicDocument } from "../src/model/types";
import { extractCircuit, structuralKey } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { Simulator, STIMULI } from "../src/logic/simulate";
import { scanCircuit, stateTable, truthTable } from "../src/logic/analyze";
import { Rng } from "./helpers/sim-gen";

registerBuiltinComponents();

function randomProps(rng: Rng, type: string): Record<string, PropValue> {
  const def = listDefs().find((d) => d.type === type)!;
  const out: Record<string, PropValue> = { ...def.defaultProps };
  for (const p of def.props) {
    if (!rng.bool(0.5)) continue;
    if (p.kind === "bool") out[p.key] = rng.bool(0.5);
    else if (p.kind === "enum" && p.options?.length) out[p.key] = p.options[rng.int(0, p.options.length - 1)].value;
    // keep sizes small so memories and wide parts stay cheap
    else if (p.kind === "int") out[p.key] = rng.int(p.min ?? 1, Math.min(p.max ?? 8, (p.min ?? 1) + 5));
    else if (p.kind === "string" && p.key === "contents") out[p.key] = rng.bool(0.5) ? "1 2 3 FF 4*0" : "zz";
  }
  return out;
}

function randomDoc(seed: number): SchematicDocument {
  const rng = new Rng(seed);
  const defs = listDefs();
  const n = rng.int(3, 18);
  const components = Array.from({ length: n }, (_, i) => {
    const def = defs[rng.int(0, defs.length - 1)];
    return { id: `C${i}`, type: def.type, x: (i % 6) * 300, y: Math.floor(i / 6) * 300, rotation: 0 as const, props: randomProps(rng, def.type), label: rng.bool(0.3) ? `L${i}` : "" };
  });
  const pins = components.flatMap((c) => {
    const def = defs.find((d) => d.type === c.type)!;
    return def.geometry(c.props).pins.map((p) => `p:${c.id}|${p.id}`);
  });
  const links: [string, string][] = [];
  for (let k = rng.int(0, n * 3); k > 0 && pins.length; k--) links.push([pins[rng.int(0, pins.length - 1)], pins[rng.int(0, pins.length - 1)]]);
  if (rng.bool(0.2)) links.push([`p:C0|nonexistent`, pins[0] ?? "p:C0|x"]); // a stale link
  if (rng.bool(0.2)) links.push(["w:ghost", pins[0] ?? "p:C0|x"]); // a link to a wire that is gone
  return { format: "digischem", version: 1, name: `random ${seed}`, grid: 10, components, wires: [], texts: [], links };
}

describe("random documents never crash or hang the logic tools", () => {
  it("extract, key, check, simulate, scan, truth and state tables", { timeout: 120000 }, () => {
    const crashes: string[] = [];
    for (let seed = 1; seed <= 2000; seed++) {
      const doc = randomDoc(seed);
      try {
        structuralKey(doc);
        const c = extractCircuit(doc);
        checkCircuit(c);
        for (const timing of ["zero", "unit"] as const) {
          const sim = new Simulator(c, { timing, initial: seed % 2 ? "x" : "zero" });
          const rng = new Rng(seed * 7);
          for (let v = 0; v < 6; v++) {
            for (const p of c.parts) if (STIMULI.has(p.type)) sim.set(p.id, rng.int(0, 255));
            sim.settle();
            if (c.parts.some((p) => p.type === "clock")) sim.tick();
          }
          for (const p of c.parts) sim.read(p.id);
        }
        scanCircuit(c, { vectors: 8, maxInputBits: 6 });
        // these may refuse (state, loops, too many inputs) but must not crash otherwise
        for (const f of [() => truthTable(c, { maxInputBits: 8 }), () => stateTable(c, { maxInputBits: 8 })])
          try {
            f();
          } catch (e) {
            const m = String((e as Error).message);
            if (!/state|loop|too many|cannot be cut open|no input|not an input/.test(m)) throw e;
          }
      } catch (e) {
        crashes.push(`seed ${seed}: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`);
        if (crashes.length >= 5) break;
      }
    }
    expect(crashes).toEqual([]);
  });
});

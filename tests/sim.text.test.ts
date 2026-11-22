/** The stripped circuit printed as DSpec and built again is the same circuit, on random networks. */
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { circuitText, extractCircuit, type Circuit } from "../src/logic/circuit";
import { compareCircuits } from "../src/logic/analyze";
import { compileSpec } from "../src/spec/compile";
import { generateRandomXrefCircuit } from "./helpers/xref-gen";
import { generateRandomCombDag } from "./helpers/sim-gen";

registerBuiltinComponents();

const groups = (c: Circuit) =>
  c.nets
    .filter((n) => n.pins.length > 1)
    .map((n) => n.pins.map((p) => `${c.parts[p.part].name}.${c.parts[p.part].pins[p.pin].id}`).sort().join(" "))
    .sort();

describe("circuit text builds back to the same circuit", () => {
  it("random transistor, tri-state, pull and gate networks", { timeout: 120000 }, () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const c = extractCircuit(generateRandomXrefCircuit(seed).doc);
      const text = circuitText(c);
      const r = compileSpec(`@compact never
@route tunnel
${text}`, { keepOnError: true }); // (routing does not matter here)
      if (!r.doc) {
        bad.push(`seed ${seed}: did not compile: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`);
        continue;
      }
      const back = extractCircuit(r.doc);
      if (groups(back).join("\n") !== groups(c).join("\n")) bad.push(`seed ${seed}: different connections`);
      const eq = compareCircuits(c, back, { maxInputBits: 8 });
      if (!eq.equal) bad.push(`seed ${seed}: behaves differently: ${JSON.stringify(eq.mismatches[0] ?? eq.onlyA.concat(eq.onlyB))}`);
    }
    expect(bad).toEqual([]);
  });

  it("random gate networks", { timeout: 120000 }, () => {
    for (let seed = 1; seed <= 6; seed++) {
      const gen = generateRandomCombDag({ seed: seed + 40, gateCount: 30, inputCount: 5, outputCount: 3 });
      const c = extractCircuit(gen.doc);
      const r = compileSpec(`@compact never
@route tunnel
${circuitText(c)}`, { keepOnError: true });
      expect(r.doc, `seed ${seed}`).not.toBeNull();
      expect(groups(extractCircuit(r.doc!)), `seed ${seed}`).toEqual(groups(c));
      expect(compareCircuits(c, extractCircuit(r.doc!)).equal, `seed ${seed}`).toBe(true);
    }
  });
});

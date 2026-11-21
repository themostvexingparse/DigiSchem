import { describe, expect, it } from "vitest";
import { covers, evaluateSop, kmapText, literalCount, minimize, sopToDspec, sopToString, type Term } from "../src/logic/minimize";
import { compileSpec } from "../src/spec/compile";
import { sopToSchematic, sopsToSchematic } from "../src/logic/sop-schematic";
import { evaluateCombinational } from "../src/logic/evaluate";
import { connectionConflicts } from "../src/model/links";
import { registerBuiltinComponents } from "../src/components/library";
import { parseProject, serializeProject } from "../src/io/project";

registerBuiltinComponents();

const names4 = ["D", "C", "B", "A"]; // variable 0 = D (LSB) ... variable 3 = A (MSB)
const cost = (ts: readonly Term[], n: number) => ts.length * 1000 + ts.reduce((s, t) => s + literalCount(t, n), 0);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("boolean minimization", () => {
  it("solves the textbook four-variable example", () => {
    // f(A,B,C,D) = sum m(0,1,2,5,6,7,8,9,10,14)
    const r = minimize(4, [0, 1, 2, 5, 6, 7, 8, 9, 10, 14]);
    // B'C' + CD' + A'BD (B'D' is also prime but redundant)
    expect(sopToString(r.terms, names4)).toBe("CD' + B'C' + A'BD");
    for (let m = 0; m < 16; m++) expect(evaluateSop(r.terms, m)).toBe([0, 1, 2, 5, 6, 7, 8, 9, 10, 14].includes(m));
  });

  it("uses don't cares to make larger groups", () => {
    // BCD "greater than 4": 5..9 on, 10..15 cannot happen
    const r = minimize(4, [5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15]);
    expect(sopToString(r.terms, names4)).toBe("A + BD + BC");
  });

  it("handles constants", () => {
    expect(minimize(3, []).terms).toEqual([]);
    const all = minimize(3, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(all.terms).toEqual([{ value: 0, mask: 7 }]);
    expect(sopToString(all.terms, ["a", "b", "c"])).toBe("1");
  });

  it("is correct on random four-input functions, with and without don't cares", () => {
    const r = rng(7);
    for (let k = 0; k < 200; k++) {
      const on: number[] = [], dc: number[] = [];
      for (let m = 0; m < 16; m++) {
        const x = r();
        if (x < 0.45) on.push(m);
        else if (x < 0.55 && k % 2) dc.push(m);
      }
      const res = minimize(4, on, dc);
      for (let m = 0; m < 16; m++) if (!dc.includes(m)) expect(evaluateSop(res.terms, m)).toBe(on.includes(m));
      // every chosen term is a prime: dropping any literal would cover a 0
      for (const t of res.terms)
        for (let i = 0; i < 4; i++) {
          if (t.mask & (1 << i)) continue;
          const bigger = { value: t.value & ~(1 << i), mask: t.mask | (1 << i) };
          const zeros = Array.from({ length: 16 }, (_, m) => m).filter((m) => !on.includes(m) && !dc.includes(m));
          expect(zeros.some((m) => covers(bigger, m))).toBe(true);
        }
    }
  });

  it("finds a cheapest cover (checked by brute force on every three-input function)", () => {
    for (let f = 0; f < 256; f++) {
      const on = Array.from({ length: 8 }, (_, m) => m).filter((m) => f & (1 << m));
      const res = minimize(3, on);
      // brute force over every set of terms (3^3 = 27 possible terms)
      const all: Term[] = [];
      for (let mask = 0; mask < 8; mask++) for (let v = 0; v < 8; v++) if (!(v & mask)) all.push({ value: v, mask });
      const valid = all.filter((t) => Array.from({ length: 8 }, (_, m) => m).every((m) => !covers(t, m) || on.includes(m)));
      let best = Infinity;
      const pick = (i: number, chosen: Term[]) => {
        if (chosen.length > 4) return;
        if (on.every((m) => chosen.some((t) => covers(t, m)))) best = Math.min(best, cost(chosen, 3));
        for (let j = i; j < valid.length; j++) pick(j + 1, [...chosen, valid[j]]);
      };
      pick(0, []);
      expect(cost(res.terms, 3)).toBe(on.length ? best : 0);
    }
  }, 60000);

  it("draws a Karnaugh map in Gray-code order", () => {
    const r = minimize(4, [0, 2, 8, 10]); // the four corners: B'D'
    const text = kmapText(4, (m) => ([0, 2, 8, 10].includes(m) ? 1 : 0), names4, r.terms);
    expect(text.split("\n")[0]).toContain("00   01   11   10".replace(/ +/g, " ").split(" ")[0]);
    expect(text).toContain("A = B'D'");
  });

  it("turns a sum of products into a schematic that compiles", () => {
    const r = minimize(4, [0, 1, 2, 5, 6, 7, 8, 9, 10, 14]);
    const res = compileSpec(sopToDspec(r.terms, ["w0", "w1", "w2", "w3"], "f"));
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.doc!.components.filter((c) => c.type === "and").length).toBe(3);
  }, 60000);

  it("draws a sum of products as rails and gates that compute the function, with no conflicts", () => {
    const r = rng(11);
    const names = ["w0", "w1", "w2", "w3"];
    for (let k = 0; k < 60; k++) {
      const on = Array.from({ length: 16 }, (_, m) => m).filter(() => r() < 0.4);
      if (k === 0) on.splice(0, on.length); // constant 0
      if (k === 1) on.splice(0, on.length, ...Array.from({ length: 16 }, (_, m) => m)); // constant 1
      if (k === 2) on.splice(0, on.length, 8, 9, 10, 11, 12, 13, 14, 15); // a single literal
      const res = minimize(4, on);
      // the saved file must load back unchanged (ids of parts and wires share one namespace)
      const doc = parseProject(serializeProject(sopToSchematic(res.terms, names, "f")));
      expect(connectionConflicts(doc)).toEqual([]);
      for (let m = 0; m < 16; m++) {
        const ins = Object.fromEntries(names.map((nm, i) => [nm, !!(m & (1 << i))]));
        expect(evaluateCombinational(doc, ins).f, `function ${k}, input ${m}`).toBe(on.includes(m));
      }
    }
  });

  it("draws several functions sharing their products, and every output computes its own function", () => {
    const r = rng(23);
    const names = ["w0", "w1", "w2", "w3"];
    for (let k = 0; k < 30; k++) {
      const count = 2 + Math.floor(r() * 4);
      const fns = Array.from({ length: count }, (_, j) => {
        if (k === 0 && j === 0) return [] as number[]; // constant 0
        if (k === 0 && j === 1) return Array.from({ length: 16 }, (_, m) => m); // constant 1
        return Array.from({ length: 16 }, (_, m) => m).filter(() => r() < 0.4);
      });
      const outs = fns.map((on, j) => ({ name: `f${j}`, terms: minimize(4, on).terms }));
      const doc = parseProject(serializeProject(sopsToSchematic(outs, names)));
      expect(connectionConflicts(doc)).toEqual([]);
      // a product used by several outputs is built once
      const keys = new Set(outs.flatMap((o) => o.terms.filter((t) => literalCount(t, 4) > 1).map((t) => `${t.value & ~t.mask}/${t.mask}`)));
      expect(doc.components.filter((c) => c.type === "and").length).toBe(keys.size);
      for (let m = 0; m < 16; m++) {
        const ins = Object.fromEntries(names.map((nm, i) => [nm, !!(m & (1 << i))]));
        const got = evaluateCombinational(doc, ins);
        fns.forEach((on, j) => expect(got[`f${j}`], `set ${k}, output ${j}, input ${m}`).toBe(on.includes(m)));
      }
    }
  });
});

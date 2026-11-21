// Corrupted / hand-edited project files: parsing either fails with a ProjectError or yields a
// document the editor can work with (ops and netlist / export do not throw, ids unique).
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { parseProject, ProjectError, serializeProject } from "../src/io/project";
import { DocumentStore } from "../src/model/store";
import { buildNetlist, exportNetlistText } from "../src/io/netlist";
import { exportSvgString } from "../src/io/export";
import { deleteSelectionInStore, nudgeSelectionInStore, rotateSelectionInStore } from "../src/editor/doc-ops";
import { connectionConflicts } from "../src/model/links";
import { sprawled } from "./helpers/sprawl";

registerBuiltinComponents();

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const WEIRD: unknown[] = [null, -1, 0, 1.5, 1e309 /* Infinity → null in JSON */, "", "x", "12", true, [], {}, [1, 2], { x: 1 }, -0, 2 ** 53, "__proto__"];

/** Mutate a random location of a JSON value. */
function mutate(v: unknown, r: () => number, depth = 0): unknown {
  if (Array.isArray(v)) {
    if (v.length && r() < 0.8) {
      const i = Math.floor(r() * v.length);
      const out = [...v];
      const k = r();
      if (k < 0.1) out.splice(i, 1);
      else if (k < 0.2) out.push(structuredClone(v[i]));
      else out[i] = mutate(v[i], r, depth + 1);
      return out;
    }
    return WEIRD[Math.floor(r() * WEIRD.length)];
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length && r() < 0.85) {
      const k = keys[Math.floor(r() * keys.length)];
      const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
      const q = r();
      if (q < 0.1) delete out[k];
      else out[k] = mutate(out[k], r, depth + 1);
      return out;
    }
    return WEIRD[Math.floor(r() * WEIRD.length)];
  }
  return WEIRD[Math.floor(r() * WEIRD.length)];
}

describe("project file fuzz", () => {
  const base = JSON.parse(serializeProject(new DocumentStore(sprawled(3, 2, 3)).doc as never));
  const N = Number(process.env.FUZZ_FILES ?? 300);
  it(`${N} corrupted files parse safely`, () => {
    const r = rng(12345);
    const problems: string[] = [];
    for (let i = 0; i < N; i++) {
      let v: unknown = base;
      const muts = 1 + Math.floor(r() * 4);
      for (let m = 0; m < muts; m++) v = mutate(v, r);
      const text = JSON.stringify(v);
      let doc;
      try {
        doc = parseProject(text);
      } catch (e) {
        if (!(e instanceof ProjectError)) problems.push(`#${i} non-ProjectError ${(e as Error).stack?.slice(0, 300)} :: ${text.slice(0, 200)}`);
        continue;
      }
      try {
        const ids = [...doc.components, ...doc.wires, ...doc.texts].map((x) => x.id);
        if (new Set(ids).size !== ids.length) problems.push(`#${i} duplicate ids`);
        const s = new DocumentStore(doc);
        buildNetlist(s.doc as never);
        exportNetlistText(s.doc as never);
        exportSvgString(s.doc as never);
        connectionConflicts(s.doc as never);
        if (s.doc.components.length) {
          s.setSelection([s.doc.components[0].id]);
          nudgeSelectionInStore(s, 20, 10);
          rotateSelectionInStore(s);
          deleteSelectionInStore(s, { sweepOrphans: true });
        }
        parseProject(serializeProject(s.doc as never));
      } catch (e) {
        problems.push(`#${i} ${(e as Error).stack?.slice(0, 400)}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 600_000);
});

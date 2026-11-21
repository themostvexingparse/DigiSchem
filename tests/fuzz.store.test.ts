// Randomized edit sequences through the DocumentStore, checking invariants after every step:
//   - stored connections between surviving pins never change (except by deleting wires),
//   - undo / redo restore documents exactly, save / load round-trips exactly,
//   - ids are unique, links only name existing terminals, coordinates are finite grid points.
// FUZZ_STEPS / FUZZ_SEEDS / FUZZ_FILE env vars make longer runs (or run on a real project).
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import type { SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { parseProject, serializeProject } from "../src/io/project";
import { terminalsOf } from "../src/model/links";
import { getDef } from "../src/model/registry";
import { setComponentSizeInDoc } from "../src/editor/resize";
import { packSchematic, validateCompaction } from "../src/layout/pack";
import {
  keepWiresAttached,
  deleteSelectionInStore,
  duplicateSelectionInStore,
  mirrorSelectionInStore,
  nudgeSelectionInStore,
  rotateSelectionInStore,
} from "../src/editor/doc-ops";
import { sprawled } from "./helpers/sprawl";
import { pathOverlapsItself } from "../src/editor/wire-utils";

registerBuiltinComponents();

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** pin terminal -> canonical net representative (smallest pin in its net) */
function pinPartition(doc: SchematicDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of buildNetlist(doc).nets) {
    const pins = n.pins.map((p) => `${p.componentId}|${p.pinId}`).sort();
    for (const p of pins) out.set(p, pins[0]);
  }
  return out;
}

/** Pairs of surviving pins whose connectedness differs between two partitions. */
function partitionDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const common = [...a.keys()].filter((k) => b.has(k));
  const diffs: string[] = [];
  // group by a's rep; within a group all must share b's rep, and different groups must differ
  const byA = new Map<string, string[]>();
  for (const k of common) {
    const r = a.get(k)!;
    if (!byA.has(r)) byA.set(r, []);
    byA.get(r)!.push(k);
  }
  const seenB = new Map<string, string>();
  for (const [ra, ks] of byA) {
    const rb = new Set(ks.map((k) => b.get(k)!));
    if (rb.size > 1) diffs.push(`split: ${ks.join(",")}`);
    for (const r of rb) {
      if (seenB.has(r) && seenB.get(r) !== ra) diffs.push(`joined: ${ra} + ${seenB.get(r)}`);
      seenB.set(r, ra);
    }
  }
  return diffs;
}

/** JSON with sorted object keys (key order is not meaningful). */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );
}

/** Cosmetic issues counted over a run (reported, not failed on). */
const soft: Record<string, number> = { selfOverlap: 0, packApplied: 0, packNoGain: 0, packRejected: 0 };
const packReasons: string[] = [];

function checkDoc(doc: SchematicDocument, where: string): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const x of [...doc.components, ...doc.wires, ...doc.texts]) {
    if (ids.has(x.id)) errs.push(`${where}: duplicate id ${x.id}`);
    ids.add(x.id);
  }
  const terms = terminalsOf(doc);
  for (const [a, b] of doc.links ?? []) {
    if (!terms.has(a) || !terms.has(b)) errs.push(`${where}: dangling link ${a} ${b}`);
  }
  for (const w of doc.wires) {
    if (w.points.length < 2) errs.push(`${where}: wire ${w.id} has ${w.points.length} points`);
    for (const p of w.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) errs.push(`${where}: wire ${w.id} non-finite point`);
      else if (p.x % 10 !== 0 || p.y % 10 !== 0) errs.push(`${where}: wire ${w.id} off-grid point ${p.x},${p.y}`);
    }
    for (let i = 0; i + 1 < w.points.length; i++) {
      const p = w.points[i], q = w.points[i + 1];
      if (p.x !== q.x && p.y !== q.y) errs.push(`${where}: wire ${w.id} diagonal segment`);
    }
  }
  for (const c of doc.components) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) errs.push(`${where}: comp ${c.id} non-finite`);
    for (const wp of worldPins(c)) {
      if (wp.pos.x % 10 !== 0 || wp.pos.y % 10 !== 0) errs.push(`${where}: pin ${c.id}.${wp.pin.id} off-grid`);
    }
  }
  return errs;
}

type Op = "nudge" | "nudgeWithWires" | "rotate" | "mirror" | "delete" | "deleteWire" | "dup" | "undo" | "redo" | "prop" | "resize" | "pack";
const OPS: Op[] = ["nudge", "nudge", "nudge", "nudgeWithWires", "rotate", "mirror", "delete", "deleteWire", "dup", "undo", "redo", "prop", "prop", "resize"];
const PACK_EVERY = Number(process.env.FUZZ_PACK ?? 0); // also compact every N steps (slow)

interface Report {
  errors: string[];
  steps: number;
}

function runFuzz(start: SchematicDocument, seed: number, steps: number): Report {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const s = new DocumentStore(structuredClone(start));
  const errors: string[] = [];
  const log: string[] = [];
  for (let step = 0; step < steps && errors.length === 0; step++) {
    const doc = s.doc as SchematicDocument;
    const before = structuredClone(doc);
    const partBefore = pinPartition(before);
    const op: Op = doc.components.length === 0 ? "undo" : PACK_EVERY && step % PACK_EVERY === PACK_EVERY - 1 ? "pack" : pick(OPS);
    let desc: string = op;
    let allowJoin = false;
    let allowSplit = false;
    try {
      const comps = doc.components;
      const sel = () => {
        const n = 1 + Math.floor(r() * Math.min(3, comps.length));
        const ids = new Set<string>();
        for (let i = 0; i < n; i++) ids.add(pick(comps).id);
        return ids;
      };
      const delta = () => (Math.floor(r() * 21) - 10) * 10 * (r() < 0.3 ? 5 : 1);
      switch (op) {
        case "nudge": {
          const ids = sel();
          const dx = delta(), dy = delta();
          desc = `nudge ${[...ids]} by ${dx},${dy}`;
          s.setSelection(ids);
          nudgeSelectionInStore(s, dx, dy);
          break;
        }
        case "nudgeWithWires": {
          const ids = sel();
          for (const w of doc.wires) if (r() < 0.15) ids.add(w.id);
          const dx = delta(), dy = delta();
          desc = `nudge+wires ${[...ids]} by ${dx},${dy}`;
          s.setSelection(ids);
          nudgeSelectionInStore(s, dx, dy);
          break;
        }
        case "rotate": {
          const ids = sel();
          desc = `rotate ${[...ids]}`;
          s.setSelection(ids);
          rotateSelectionInStore(s);
          break;
        }
        case "mirror": {
          const ids = sel();
          desc = `mirror ${[...ids]}`;
          s.setSelection(ids);
          mirrorSelectionInStore(s);
          break;
        }
        case "delete": {
          const ids = new Set([pick(comps).id]);
          const sweep = r() < 0.5;
          desc = `delete ${[...ids]}${sweep ? " +sweep" : ""}`;
          s.setSelection(ids);
          deleteSelectionInStore(s, { sweepOrphans: sweep });
          break;
        }
        case "deleteWire": {
          if (doc.wires.length === 0) break;
          const id = pick(doc.wires).id;
          desc = `delete wire ${id}`;
          allowSplit = true;
          s.setSelection([id]);
          deleteSelectionInStore(s);
          break;
        }
        case "dup": {
          const ids = sel();
          desc = `duplicate ${[...ids]}`;
          allowJoin = true; // pasted parts connect by touch
          s.setSelection(ids);
          duplicateSelectionInStore(s);
          break;
        }
        case "prop": {
          // an int property (input count, bit width…) through the same path as the properties panel
          const cands = comps.filter((c) => getDef(c.type)?.props.some((p) => p.kind === "int"));
          if (!cands.length) break;
          const c = pick(cands);
          const pdef = pick(getDef(c.type)!.props.filter((p) => p.kind === "int"));
          const lo = pdef.min ?? 1, hi = Math.min(pdef.max ?? 8, lo + 8);
          const val = lo + Math.floor(r() * (hi - lo + 1));
          desc = `set ${c.id}.${pdef.key}=${val}`;
          allowJoin = true; // pins added by the change connect by touch
          s.update("prop", (d) => keepWiresAttached(d, new Set([c.id]), () => {
            const x = d.components.find((k) => k.id === c.id);
            if (x) x.props[pdef.key] = val;
          }));
          break;
        }
        case "resize": {
          const cands = comps.filter((c) => getDef(c.type)?.resizable);
          if (!cands.length) break;
          const c = pick(cands);
          const w = 20 + Math.floor(r() * 16) * 10, h = 20 + Math.floor(r() * 16) * 10;
          desc = `resize ${c.id} to ${w}x${h}`;
          s.update("resize", (d) => setComponentSizeInDoc(d, c.id, { w, h }));
          break;
        }
        case "pack": {
          const res = packSchematic(structuredClone(doc));
          const probs = validateCompaction(doc, res);
          desc = `pack (${probs.length} problems)`;
          if (probs.length) {
            soft.packRejected++;
            packReasons.push(probs[0]);
          } else if (!(res.qualityAfter.total < res.qualityBefore.total)) soft.packNoGain++;
          else soft.packApplied++;
          if (probs.length === 0 && res.qualityAfter.total < res.qualityBefore.total) {
            s.update("pack", (d) => {
              d.components = res.doc.components;
              d.wires = res.doc.wires;
              d.texts = res.doc.texts;
            });
          }
          break;
        }
        case "undo": {
          allowJoin = allowSplit = true;
          const can = s.canUndo();
          s.undo();
          if (can) {
            // redo then undo must land on the same document
            const a = JSON.stringify(s.doc);
            s.redo();
            s.undo();
            if (JSON.stringify(s.doc) !== a) errors.push(`step ${step}: redo+undo not identity`);
          }
          break;
        }
        case "redo": {
          allowJoin = allowSplit = true;
          s.redo();
          break;
        }
      }
    } catch (e) {
      errors.push(`step ${step} ${desc}: threw ${(e as Error).stack}`);
      break;
    }
    log.push(desc);
    const after = s.doc as SchematicDocument;
    errors.push(...checkDoc(after, `step ${step} ${desc}`));
    // a wire must never be left running over itself by an edit (pre-existing ones aside)
    if (op !== "undo" && op !== "redo") {
      const was = new Set(before.wires.filter((w) => pathOverlapsItself(w.points)).map((w) => w.id));
      for (const w of after.wires) {
        if (!was.has(w.id) && pathOverlapsItself(w.points)) {
          soft.selfOverlap++;
          if (process.env.FUZZ_STRICT) errors.push(`step ${step} ${desc}: wire ${w.id} now runs over itself ${JSON.stringify(w.points.map((p) => [p.x, p.y]))}`);
        }
      }
    }
    const diffs = partitionDiff(partBefore, pinPartition(after)).filter(
      (d) => !(allowJoin && d.startsWith("joined")) && !(allowSplit && d.startsWith("split")),
    );
    for (const d of diffs) errors.push(`step ${step} ${desc}: connectivity ${d}`);
    // save / load round trip
    try {
      const back = parseProject(serializeProject(after));
      const pa = pinPartition(after), pb = pinPartition(back);
      const rt = partitionDiff(pa, pb);
      if (rt.length || pa.size !== pb.size) errors.push(`step ${step}: save/load changed connectivity ${rt.slice(0, 3)}`);
      if (canon(back.wires) !== canon(after.wires)) errors.push(`step ${step}: save/load changed wires`);
      for (const c of after.components) {
        const bc = back.components.find((x) => x.id === c.id);
        if (canon(bc) !== canon(c)) errors.push(`step ${step}: save/load changed component ${JSON.stringify(c)} -> ${JSON.stringify(bc)}`);
      }
      if (back.components.length !== after.components.length) errors.push(`step ${step}: save/load changed component count`);
    } catch (e) {
      errors.push(`step ${step}: save/load threw ${(e as Error).message}`);
    }
    if (errors.length) {
      errors.push(`history: ${log.slice(-6).join(" ; ")}`);
      if (process.env.FUZZ_DUMP) writeFileSync(`${process.env.FUZZ_DUMP}/fail-${seed}.json`, JSON.stringify({ desc, before, after }));
    }
  }
  return { errors, steps };
}

const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 3);

describe("store fuzz: random edits keep every invariant", () => {
  afterAll(() => {
    if (process.env.FUZZ_STEPS) console.log("soft issues:", JSON.stringify(soft), packReasons.slice(0, 8));
  });
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`sprawled circuit, seed ${seed}`, () => {
      const rep = runFuzz(sprawled(seed, 3, 4), seed * 7919, STEPS);
      expect(rep.errors).toEqual([]);
    }, 600_000);
  }
  const file = process.env.FUZZ_FILE;
  if (file) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      it(`${file}, seed ${seed}`, () => {
        const rep = runFuzz(parseProject(readFileSync(file, "utf8")), seed * 104729, STEPS);
        expect(rep.errors).toEqual([]);
      }, 1_800_000);
    }
  }
});

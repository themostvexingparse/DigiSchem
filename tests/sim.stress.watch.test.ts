import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type PropValue, type SchematicDocument } from "../src/model/types";
import { effectiveProps, worldPins } from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { circuitText, extractCircuit } from "../src/logic/circuit";
import { watchCircuit } from "../src/logic/watch";
import {
  copySelectionFromDoc,
  deleteSelectionInStore,
  duplicateSelectionInStore,
  mirrorSelectionInStore,
  nudgeSelectionInStore,
  pasteClipboardIntoStore,
  rotateSelectionInStore,
  type ClipboardData,
} from "../src/editor/doc-ops";
import { RouteObstacles, safeRoute } from "../src/editor/safe-route";
import { dragWireSegmentPoints } from "../src/editor/wire-utils";
import { sprawled } from "./helpers/sprawl";

registerBuiltinComponents();

/** Deterministic seeded LCG PRNG (never Math.random). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[randInt(rng, xs.length)];
}

/** Pin partitions directly from buildNetlist (excluding pinless floating wires). */
function netlistPinPartitions(doc: SchematicDocument): string[] {
  return buildNetlist(doc)
    .nets.filter((n) => n.pins.length > 0)
    .map((n) => n.pins.map((p) => `${p.componentId}|${p.pinId}`).sort().join(" "))
    .sort();
}

const NON_SEMANTIC_PROPS = new Set(["label", "title"]);

/** Structural oracle: buildNetlist pin partitions + part ids, types, and semantic props. */
function structuralOracle(doc: SchematicDocument): string {
  const parts = doc.components
    .map((c) => {
      const all = effectiveProps(c);
      const sem: Record<string, PropValue> = {};
      for (const k of Object.keys(all).sort()) {
        if (!k.startsWith("_") && !NON_SEMANTIC_PROPS.has(k)) sem[k] = all[k];
      }
      return `${c.id}|${c.type}|${JSON.stringify(sem)}`;
    })
    .sort();
  return JSON.stringify({ parts, nets: netlistPinPartitions(doc) });
}

/** Build a cleanly routed schematic using safeRoute (like tests/editor.reroute.test.ts). */
function buildRoutedCircuit(): SchematicDocument {
  const d = emptyDocument("routed-watch");
  const C = (id: string, type: string, x: number, y: number, props: Record<string, PropValue> = {}, label = ""): ComponentInstance => ({
    id,
    type,
    x,
    y,
    rotation: 0,
    props,
    label,
  });
  d.components.push(
    C("a", "input-pin", 100, 100, { name: "A" }),
    C("b", "input-pin", 100, 200, { name: "B" }),
    C("c", "input-pin", 100, 320, { name: "C" }),
    C("g1", "and", 300, 120, { inputs: 2 }, "U1"),
    C("g2", "xor", 300, 280, { inputs: 2 }, "U2"),
    C("g3", "or", 520, 180, { inputs: 2 }, "U3"),
    C("y", "output-pin", 740, 190, { name: "Y" }),
  );
  const pin = (id: string, pid: string) =>
    worldPins(d.components.find((x) => x.id === id)!).find((q) => q.pin.id === pid)!.pos;
  const add = (id: string, from: [string, string], to: [string, string]) => {
    const pFrom = pin(...from);
    const sameNet = new Set(
      d.wires.filter((w) => w.points[0].x === pFrom.x && w.points[0].y === pFrom.y).map((w) => w.id),
    );
    const r = safeRoute(new RouteObstacles(d), pFrom, pin(...to), { sameNet });
    if (r) d.wires.push({ id, points: r });
  };
  add("w1", ["a", "out"], ["g1", "in0"]);
  add("w2", ["b", "out"], ["g1", "in1"]);
  add("w3", ["b", "out"], ["g2", "in0"]);
  add("w4", ["c", "out"], ["g2", "in1"]);
  add("w5", ["g1", "out"], ["g3", "in0"]);
  add("w6", ["g2", "out"], ["g3", "in1"]);
  add("w7", ["g3", "out"], ["y", "in"]);
  d.texts.push({ id: "t1", x: 100, y: 40, text: "note" });
  return d;
}

/** Build a routed circuit containing tunnels and a bus splitter. */
function buildTunnelSplitterCircuit(): SchematicDocument {
  const d = emptyDocument("tunnel-splitter-watch");
  const C = (id: string, type: string, x: number, y: number, props: Record<string, PropValue> = {}): ComponentInstance => ({
    id,
    type,
    x,
    y,
    rotation: 0,
    props,
  });
  d.components.push(
    C("busIn", "input-pin", 60, 120, { name: "BUS", width: 2 }),
    C("sp", "splitter", 220, 100, { width: 2, fanOut: 2 }),
    C("t1", "tunnel", 380, 100, { name: "SIG0" }),
    C("t2", "tunnel", 100, 300, { name: "SIG0" }),
    C("inv", "not", 260, 290, {}),
    C("out0", "output-pin", 440, 300, { name: "Y0" }),
    C("out1", "output-pin", 440, 140, { name: "Y1" }),
  );
  const pin = (id: string, pid: string) =>
    worldPins(d.components.find((x) => x.id === id)!).find((q) => q.pin.id === pid)!.pos;
  const add = (id: string, from: [string, string], to: [string, string]) => {
    const r = safeRoute(new RouteObstacles(d), pin(...from), pin(...to));
    if (r) d.wires.push({ id, points: r });
  };
  add("w1", ["busIn", "out"], ["sp", "bus"]);
  add("w2", ["sp", "b0"], ["t1", "net"]);
  add("w3", ["sp", "b1"], ["out1", "in"]);
  add("w4", ["t2", "net"], ["inv", "in0"]);
  add("w5", ["inv", "out"], ["out0", "in"]);
  return d;
}

describe("7. watchCircuit stress tests on real DocumentStore + doc-ops", () => {
  it("never fires on pure moves, rotations, mirrors, wire drags, label renames, text edits, or their undo/redo", () => {
    const rng = makeRng(0x770011);
    const store = new DocumentStore(sprawled(11, 2, 4));
    let calls = 0;
    const watch = watchCircuit(store, () => calls++);

    const initialPins = netlistPinPartitions(store.doc);
    const initialText = circuitText(watch.current().circuit);
    const initialBuilds = watch.builds;
    expect(initialBuilds).toBe(1);

    for (let step = 0; step < 60; step++) {
      const comps = store.doc.components;
      const op = randInt(rng, 7);

      if (op === 0 || op === 1) {
        // Nudge 1 or 2 random components
        const count = rng() < 0.7 ? 1 : 2;
        const chosen = new Set<string>();
        for (let k = 0; k < count; k++) chosen.add(pick(rng, comps).id);
        store.setSelection(chosen);
        const dx = (randInt(rng, 9) - 4) * 20;
        const dy = (randInt(rng, 9) - 4) * 20;
        if (dx !== 0 || dy !== 0) nudgeSelectionInStore(store, dx, dy);
      } else if (op === 2) {
        // Rotate 1 or 2 random components
        const count = rng() < 0.75 ? 1 : 2;
        const chosen = new Set<string>();
        for (let k = 0; k < count; k++) chosen.add(pick(rng, comps).id);
        store.setSelection(chosen);
        rotateSelectionInStore(store);
      } else if (op === 3) {
        // Mirror 1 or 2 random components
        const count = rng() < 0.75 ? 1 : 2;
        const chosen = new Set<string>();
        for (let k = 0; k < count; k++) chosen.add(pick(rng, comps).id);
        store.setSelection(chosen);
        mirrorSelectionInStore(store);
      } else if (op === 4) {
        // Drag a bent wire segment inside a gesture
        const bent = store.doc.wires.find(
          (w) =>
            w.points.length >= 4 &&
            (w.points[0].x !== w.points[w.points.length - 1].x || w.points[0].y !== w.points[w.points.length - 1].y),
        );
        if (bent) {
          const orig = bent.points.map((p) => ({ ...p }));
          store.beginGesture();
          for (let k = 1; k <= 2; k++) {
            store.update("drag segment", (d) => {
              const target = d.wires.find((x) => x.id === bent.id);
              if (target) target.points = dragWireSegmentPoints(orig, 1, { x: 10 * k, y: 10 * k }, true, true);
            });
          }
          store.endGesture();
        }
      } else if (op === 5) {
        // Undo or redo a non-structural edit
        if (rng() < 0.6 && store.canUndo()) store.undo();
        else if (store.canRedo()) store.redo();
      } else {
        // Add or edit a text note
        store.update("text", (d) => {
          if (d.texts.length === 0 || rng() < 0.5) {
            d.texts.push({ id: `tn_${step}`, x: step * 10, y: 20, text: `note ${step}` });
          } else {
            d.texts[0].text = `edited ${step}`;
          }
        });
      }

      expect(calls, `non-structural step=${step} op=${op}`).toBe(0);
      expect(watch.builds, `builds step=${step} op=${op}`).toBe(initialBuilds);
      // Editor connectivity invariant: pure geometric edits must never alter buildNetlist pin partitions.
      expect(netlistPinPartitions(store.doc), `connectivity step=${step} op=${op}`).toEqual(initialPins);
    }

    expect(circuitText(watch.current().circuit)).toBe(initialText);
    watch.dispose();
  });

  it("fires exactly when buildNetlist pin partitions or part types/props change across seeded random edit sequences", () => {
    const seeds = [
      { name: "routed", seed: 101, build: () => buildRoutedCircuit() },
      { name: "tunnel-splitter", seed: 202, build: () => buildTunnelSplitterCircuit() },
      { name: "sprawl-a", seed: 303, build: () => sprawled(7, 2, 4) },
      { name: "sprawl-b", seed: 404, build: () => sprawled(42, 3, 4) },
    ];

    for (const scenario of seeds) {
      const rng = makeRng(scenario.seed);
      const store = new DocumentStore(scenario.build());
      let calls = 0;
      const watch = watchCircuit(store, () => calls++);
      let prevOracle = structuralOracle(store.doc);
      let clipboard: ClipboardData | null = null;

      for (let step = 0; step < 50; step++) {
        const beforeCalls = calls;
        const beforePins = netlistPinPartitions(store.doc);
        const op = randInt(rng, 11);
        let isPureMoveOrTransform = false;

        if (op === 0) {
          // Nudge random component(s)
          if (store.doc.components.length > 0) {
            isPureMoveOrTransform = true;
            const c = pick(rng, store.doc.components);
            store.setSelection([c.id]);
            const dx = (randInt(rng, 7) - 3) * 20;
            const dy = (randInt(rng, 7) - 3) * 20;
            if (dx !== 0 || dy !== 0) nudgeSelectionInStore(store, dx, dy);
          }
        } else if (op === 1) {
          // Rotate random component(s)
          if (store.doc.components.length > 0) {
            isPureMoveOrTransform = true;
            const c = pick(rng, store.doc.components);
            store.setSelection([c.id]);
            rotateSelectionInStore(store);
          }
        } else if (op === 2) {
          // Mirror random component(s)
          if (store.doc.components.length > 0) {
            isPureMoveOrTransform = true;
            const c = pick(rng, store.doc.components);
            store.setSelection([c.id]);
            mirrorSelectionInStore(store);
          }
        } else if (op === 3) {
          // Duplicate a random component, wire, or small multi-selection
          const pool = [...store.doc.components.map((c) => c.id), ...store.doc.wires.map((w) => w.id)];
          if (pool.length > 0 && store.doc.components.length < 35) {
            const k = rng() < 0.7 ? 1 : 2;
            const sel = new Set<string>();
            for (let i = 0; i < k; i++) sel.add(pick(rng, pool));
            store.setSelection(sel);
            duplicateSelectionInStore(store);
          }
        } else if (op === 4) {
          // Copy selection into clipboard
          const pool = [...store.doc.components.map((c) => c.id), ...store.doc.wires.map((w) => w.id)];
          if (pool.length > 0) {
            isPureMoveOrTransform = true;
            const sel = new Set<string>([pick(rng, pool)]);
            if (pool.length > 1 && rng() < 0.5) sel.add(pick(rng, pool));
            clipboard = copySelectionFromDoc(store.doc, sel);
          }
        } else if (op === 5) {
          // Paste clipboard into store
          if (clipboard && store.doc.components.length < 35) {
            pasteClipboardIntoStore(store, clipboard, {
              x: (randInt(rng, 20) + 2) * 20,
              y: (randInt(rng, 20) + 2) * 20,
            });
          }
        } else if (op === 6) {
          // Delete a wire or component (keeping at least 2 components alive)
          if (rng() < 0.5 && store.doc.wires.length > 0) {
            const w = pick(rng, store.doc.wires);
            store.setSelection([w.id]);
            deleteSelectionInStore(store, { sweepOrphans: rng() < 0.5 });
          } else if (store.doc.components.length > 2) {
            const c = pick(rng, store.doc.components);
            store.setSelection([c.id]);
            deleteSelectionInStore(store, { sweepOrphans: rng() < 0.5 });
          }
        } else if (op === 7) {
          // Undo
          if (store.canUndo()) store.undo();
        } else if (op === 8) {
          // Redo
          if (store.canRedo()) store.redo();
        } else if (op === 9) {
          // Change a semantic property on a multi-input gate (inputs 2 <-> 3)
          const gates = store.doc.components.filter((c) =>
            c.type === "and" || c.type === "or" || c.type === "xor" || c.type === "nand",
          );
          if (gates.length > 0) {
            const g = pick(rng, gates);
            store.update("toggle inputs", (d) => {
              const target = d.components.find((x) => x.id === g.id);
              if (target) target.props.inputs = target.props.inputs === 3 ? 2 : 3;
            });
          }
        } else {
          // Non-structural label rename on a gate (not input-pin/output-pin props.name)
          const gates = store.doc.components.filter(
            (c) => c.type !== "input-pin" && c.type !== "output-pin" && c.type !== "tunnel",
          );
          if (gates.length > 0) {
            isPureMoveOrTransform = true;
            const g = pick(rng, gates);
            store.update("rename label", (d) => {
              const target = d.components.find((x) => x.id === g.id);
              if (target) target.label = `LBL_${step}`;
            });
          }
        }

        const nextOracle = structuralOracle(store.doc);
        const expectedChange = nextOracle !== prevOracle;
        const fired = calls - beforeCalls;
        const tag = `${scenario.name} step=${step} op=${op}`;

        if (isPureMoveOrTransform) {
          expect(netlistPinPartitions(store.doc), `${tag} pure move/transform changed connectivity`).toEqual(beforePins);
          expect(fired, `${tag} pure move/transform fired watchCircuit`).toBe(0);
        }
        expect(fired, `${tag} expectedChange=${expectedChange}`).toBe(expectedChange ? 1 : 0);

        if (expectedChange) {
          // Verify snapshot stays in lockstep with fresh extractCircuit
          const snap = watch.current();
          const fresh = extractCircuit(store.doc);
          expect(snap.circuit.key, `${tag} key`).toBe(fresh.key);
          expect(circuitText(snap.circuit), `${tag} text`).toBe(circuitText(fresh));
        }

        prevOracle = nextOracle;
      }

      watch.dispose();
    }
  });

  it("refreshes gate label renames lazily on current() without firing onChange or incrementing builds, and stops after dispose()", () => {
    const store = new DocumentStore(buildRoutedCircuit());
    let calls = 0;
    const watch = watchCircuit(store, () => calls++);

    // Build initial snapshot
    expect(watch.current().circuit.parts.some((p) => p.name === "U1")).toBe(true);
    expect(watch.builds).toBe(1);

    // Rename gate label: no callback, no extra build, lazy refresh on current()
    store.update("rename gate", (d) => {
      d.components.find((c) => c.id === "g1")!.label = "AND_TOP";
    });
    expect(calls).toBe(0);
    expect(watch.builds).toBe(1);
    expect(watch.current().circuit.parts.some((p) => p.name === "AND_TOP")).toBe(true);
    expect(watch.builds).toBe(1);

    // Undo rename: still no callback, current() reverts back to U1
    store.undo();
    expect(calls).toBe(0);
    expect(watch.current().circuit.parts.some((p) => p.name === "U1")).toBe(true);

    // Dispose stops all callbacks
    watch.dispose();
    store.setSelection(["g1"]);
    deleteSelectionInStore(store);
    expect(calls).toBe(0);
  });

  it("BUG-SEQ-6: renaming input-pin/output-pin via props.name should not fire watchCircuit or rebuild", () => {
    const store = new DocumentStore(buildRoutedCircuit());
    let calls = 0;
    const watch = watchCircuit(store, () => calls++);
    watch.current();
    const buildsBefore = watch.builds;

    store.update("rename input-pin", (d) => {
      d.components.find((c) => c.id === "a")!.props.name = "IN_ALPHA";
    });
    expect(calls).toBe(0);
    expect(watch.builds).toBe(buildsBefore);
    expect(watch.current().circuit.parts.some((p) => p.name === "IN_ALPHA")).toBe(true);
    watch.dispose();
  });
});

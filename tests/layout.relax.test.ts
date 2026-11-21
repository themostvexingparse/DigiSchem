import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compileSpec } from "../src/spec/compile";
import { relaxWires } from "../src/layout/relax-wires";
import { netSignature } from "../src/layout/realign";
import { connectionConflicts } from "../src/model/links";
import { worldPins } from "../src/model/geometry";
import type { Point, SchematicDocument } from "../src/model/types";

const bends = (d: SchematicDocument) => d.wires.reduce((n, w) => n + Math.max(0, w.points.length - 2), 0);
const pin = (d: SchematicDocument, id: string, name: string): Point =>
  worldPins(d.components.find((c) => c.id === id)!).find((p) => p.pin.name === name || p.pin.id === name)!.pos;

/** a drawing with fixed parts, built by the compiler, whose wires the test then redraws */
function build(src: string): SchematicDocument {
  const r = compileSpec("@layout manual\n@compact never\n" + src);
  expect(r.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
  return r.doc!;
}

describe("wire relaxation", () => {
  it("removes a jog that serves no purpose", () => {
    const d = build("part A input-pin at=0,0\npart Y output-pin at=300,0\nA -> Y");
    const a = pin(d, "A", "out"), y = pin(d, "Y", "in");
    d.wires[0].points = [a, { x: 120, y: a.y }, { x: 120, y: a.y + 60 }, { x: 200, y: a.y + 60 }, { x: 200, y: a.y }, y];
    const sig = netSignature(d);
    const r = relaxWires(d);
    expect(r.energyAfter).toBeLessThan(r.energyBefore);
    expect(d.wires[0].points).toEqual([a, y]);
    expect(netSignature(d)).toBe(sig);
  });

  it("pushes two wires running one cell apart away from each other", () => {
    const d = build("part A input-pin at=0,0\npart B input-pin at=0,100\npart X output-pin at=400,300\npart Y output-pin at=400,400\nA -> X\nB -> Y");
    const a = pin(d, "A", "out"), b = pin(d, "B", "out"), x = pin(d, "X", "in"), y = pin(d, "Y", "in");
    // both wires turn in neighbouring columns and run side by side
    d.links = undefined;
    d.wires = [
      { id: "wa", points: [a, { x: 200, y: a.y }, { x: 200, y: x.y }, x] },
      { id: "wb", points: [b, { x: 210, y: b.y }, { x: 210, y: y.y }, y] },
    ];
    const sig = netSignature(d);
    relaxWires(d);
    expect(Math.abs(d.wires[0].points[1].x - d.wires[1].points[1].x)).toBeGreaterThanOrEqual(30);
    expect(netSignature(d)).toBe(sig);
  });

  it("straightens a fan-out trunk drawn in two columns", () => {
    const outs = Array.from({ length: 6 }, (_, i) => `part L${i} output-pin at=300,${30 * i}`).join("\n");
    const d = build(`part A input-pin at=0,0\n${outs}\nnet F = A, L0..L5.in`);
    const a = pin(d, "A", "out");
    const l = Array.from({ length: 6 }, (_, i) => pin(d, `L${i}`, "in"));
    // a daisy chain: each LED's wire joins the stub of the one above; the lower half one column over
    d.links = undefined;
    d.wires = [{ id: "w0", points: [a, l[0]] }];
    for (let i = 1; i < 6; i++) {
      const tx = i < 3 ? 250 : 260;
      d.wires.push({ id: `w${i}`, points: [l[i], { x: tx, y: l[i].y }, { x: tx, y: l[i - 1].y }] });
    }
    const sig = netSignature(d);
    expect(sig).toContain("L5");
    relaxWires(d);
    const xs = new Set(d.wires.slice(1).map((w) => w.points[1].x));
    expect(xs.size).toBe(1);
    expect(netSignature(d)).toBe(sig);
  });

  it("never changes what a compiled example connects, and never adds bends when asked not to", () => {
    for (const f of ["examples/adder4.dspec", "examples/ripple-counter.dspec"]) {
      const r = compileSpec(readFileSync(f, "utf8").replace(/^@compact.*$/m, "") + "\n@compact never");
      const d = r.doc!;
      const sig = netSignature(d), b = bends(d), conflicts = connectionConflicts(d).length;
      relaxWires(d, { noNewBends: true });
      expect(netSignature(d)).toBe(sig);
      expect(bends(d)).toBeLessThanOrEqual(b);
      expect(connectionConflicts(d).length).toBeLessThanOrEqual(conflicts);
    }
  }, 60000);
});

describe("wire relaxation: bundles", () => {
  it("lays the jogs of parallel wires between two parts out as an even staircase", () => {
    const nets = Array.from({ length: 5 }, (_, i) => `S.out${i} -> T.in${i}`).join("\n");
    const d = build(`part S generic-block inputs=1 outputs=5 size=60x300 at=0,0\npart T generic-block inputs=5 outputs=1 size=60x400 at=400,0\n${nets}`);
    // scatter the jogs
    const xs0 = [150, 260, 180, 300, 220];
    d.wires.forEach((w, i) => {
      const a = w.points[0], b = w.points[w.points.length - 1];
      w.points = [a, { x: xs0[i], y: a.y }, { x: xs0[i], y: b.y }, b];
    });
    const sig = netSignature(d);
    relaxWires(d);
    const xs = d.wires.map((w) => w.points[1].x);
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    expect(new Set(steps).size).toBe(1);
    // wires going down: each one jogs left of the one above it (or in the same column)
    expect(steps[0]).toBeLessThanOrEqual(0);
    expect(netSignature(d)).toBe(sig);
  });
});

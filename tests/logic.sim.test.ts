import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import type { PropValue, SchematicDocument } from "../src/model/types";
import { DocumentStore } from "../src/model/store";
import { circuitText, extractCircuit, structuralKey } from "../src/logic/circuit";
import { checkCircuit } from "../src/logic/check";
import { Simulator } from "../src/logic/simulate";
import { compareCircuits, hazardScan, outputFunctions, scanCircuit, stateTable, truthTable, truthTableText } from "../src/logic/analyze";
import { watchCircuit } from "../src/logic/watch";
import { minimize, sopToDspec, sopToString } from "../src/logic/minimize";
import { sopToSchematic, sopsToSchematic } from "../src/logic/sop-schematic";
import { evaluateCombinational } from "../src/logic/evaluate";
import { compileSpec } from "../src/spec/compile";
import { emptyDocument, type ComponentInstance } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { nudgeSelectionInStore } from "../src/editor/doc-ops";
import { RouteObstacles, safeRoute } from "../src/editor/safe-route";
import { dragWireSegmentPoints } from "../src/editor/wire-utils";

registerBuiltinComponents();

type PartSpec = [id: string, type: string, props?: Record<string, PropValue>];

/** A document with parts spread out and nets given as pin lists (`A.out`), joined pin to pin. */
function mk(parts: PartSpec[], nets: string[][]): SchematicDocument {
  const links: [string, string][] = [];
  for (const net of nets) {
    const ts = net.map((r) => {
      const i = r.lastIndexOf(".");
      return `p:${r.slice(0, i)}|${r.slice(i + 1)}`;
    });
    for (let i = 1; i < ts.length; i++) links.push([ts[0], ts[i]]);
  }
  return {
    format: "digischem",
    version: 1,
    name: "t",
    grid: 10,
    components: parts.map(([id, type, props], i) => ({ id, type, x: (i % 6) * 200, y: Math.floor(i / 6) * 200, rotation: 0, props: props ?? {}, label: "" })),
    wires: [],
    texts: [],
    links,
  };
}

const sim = (doc: SchematicDocument) => new Simulator(extractCircuit(doc));
const kinds = (issues: { kind: string }[]) => issues.map((i) => i.kind);

describe("stripped circuit", () => {
  it("dissolves tunnels into the nets they join", () => {
    const doc = mk(
      [["A", "input-pin"], ["T1", "tunnel", { name: "X" }], ["T2", "tunnel", { name: "X" }], ["Y", "output-pin"]],
      [["A.out", "T1.net"], ["T2.net", "Y.in"]],
    );
    const c = extractCircuit(doc);
    expect(c.parts.map((p) => p.type)).toEqual(["input-pin", "output-pin"]);
    const a = c.parts[0].pins[0], y = c.parts[1].pins[0];
    expect(a.net).toBe(y.net);
    expect(a.bits).toEqual(y.bits);
    expect(c.nets[a.net].name).toBe("X");
  });

  it("joins a splitter's slices to its bus bit by bit", () => {
    const doc = mk(
      [["BUS", "input-pin", { width: 4 }], ["SP", "splitter", { width: 4, fanOut: 2 }], ["LO", "output-pin", { width: 2 }], ["HI", "output-pin", { width: 2 }]],
      [["BUS.out", "SP.bus"], ["SP.b0", "LO.in"], ["SP.b1", "HI.in"]],
    );
    const c = extractCircuit(doc);
    const bus = c.parts[0].pins[0].bits, lo = c.parts[2].pins[0].bits, hi = c.parts[3].pins[0].bits;
    expect(lo).toEqual(bus.slice(0, 2));
    expect(hi).toEqual(bus.slice(2, 4));
    const s = new Simulator(c);
    s.set("BUS", 0b1001);
    s.settle();
    expect(s.read("LO")).toBe(0b01);
    expect(s.read("HI")).toBe(0b10);
  });

  it("reports pins of different widths on one net", () => {
    const doc = mk([["A", "input-pin", { width: 4 }], ["Y", "output-pin"]], [["A.out", "Y.in"]]);
    expect(kinds(checkCircuit(extractCircuit(doc)))).toContain("width-mismatch");
  });

  it("has a key that ignores positions, rotation, size and labels but not connections or properties", () => {
    const doc = mk([["A", "input-pin"], ["G", "not"], ["Y", "output-pin"]], [["A.out", "G.in0"], ["G.out", "Y.in"]]);
    const k = structuralKey(doc);
    const moved = structuredClone(doc);
    moved.components[1].x += 70;
    moved.components[1].rotation = 90;
    moved.components[1].label = "inv";
    expect(structuralKey(moved)).toBe(k);
    const rewired = structuredClone(doc);
    rewired.links = rewired.links!.filter(([a]) => !a.includes("G|out"));
    expect(structuralKey(rewired)).not.toBe(k);
    const changed = structuredClone(doc);
    changed.components[1].type = "buf";
    expect(structuralKey(changed)).not.toBe(k);
  });

  it("prints as DSpec without positions or directives, and builds back to the same connections", () => {
    const r = minimize(3, [3, 5, 6, 7]);
    const doc = sopToSchematic(r.terms, ["cin", "b", "a"], "cout");
    const text = circuitText(extractCircuit(doc));
    expect(text).not.toMatch(/\bat=|\brot=|^@/m);
    expect(text).toMatch(/^part a input-pin$/m);
    const built = compileSpec(text);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // same circuit: same pin groups by part name
    const groups = (d: SchematicDocument) => {
      const c = extractCircuit(d);
      return c.nets.map((n) => n.pins.map((p) => `${c.parts[p.part].name}.${c.parts[p.part].pins[p.pin].id}`).sort().join(" ")).sort();
    };
    expect(groups(built.doc)).toEqual(groups(doc));
  });
});

describe("simulator", () => {
  it("agrees with the truth table on generated two-level circuits", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 10; t++) {
      const n = 3 + (t % 2);
      const fs = [0, 1, 2].map(() => Array.from({ length: 1 << n }, (_, m) => m).filter(() => rnd() < 0.5));
      const names = Array.from({ length: n }, (_, i) => `x${i}`);
      const doc = sopsToSchematic(fs.map((ms, k) => ({ name: `f${k}`, terms: minimize(n, ms).terms })), names);
      const c = extractCircuit(doc);
      expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
      const s = new Simulator(c);
      for (let m = 0; m < 1 << n; m++) {
        names.forEach((nm, i) => s.set(nm, (m >> i) & 1));
        const r = s.settle();
        expect(r.issues).toEqual([]);
        fs.forEach((ms, k) => expect(s.read(`f${k}`)).toBe(ms.includes(m) ? 1 : 0));
      }
    }
  });

  it("finds a floating input, statically and when simulating", () => {
    const doc = mk([["A", "input-pin"], ["G", "and"], ["Y", "output-pin"]], [["A.out", "G.in0"], ["G.out", "Y.in"]]);
    const c = extractCircuit(doc);
    const issues = checkCircuit(c);
    expect(issues[0]).toMatchObject({ kind: "floating-input", severity: "error", pins: ["G.in1"] });
    const s = new Simulator(c);
    s.set("A", 1);
    const r = s.settle();
    expect(s.read("Y")).toBe(null); // 1 AND X
    expect(kinds(r.issues)).toContain("floating");
    s.set("A", 0);
    s.settle();
    expect(s.read("Y")).toBe(0); // 0 AND anything
  });

  it("finds outputs shorted together, and contention only when they disagree", () => {
    const doc = mk(
      [["A", "input-pin"], ["B", "input-pin"], ["N1", "buf"], ["N2", "buf"], ["Y", "output-pin"]],
      [["A.out", "N1.in0"], ["B.out", "N2.in0"], ["N1.out", "N2.out", "Y.in"]],
    );
    const c = extractCircuit(doc);
    expect(kinds(checkCircuit(c))).toContain("multiple-drivers");
    const s = new Simulator(c);
    s.set("A", 1);
    s.set("B", 1);
    expect(s.settle().issues).toEqual([]);
    expect(s.read("Y")).toBe(1);
    s.set("B", 0);
    const r = s.settle();
    expect(r.issues[0]).toMatchObject({ kind: "contention" });
    expect(r.issues[0].message).toMatch(/N1\.out=1.*N2\.out=0/);
    expect(s.read("Y")).toBe(null);
  });

  it("finds a short written in DSpec source (the compiler only warns, the drawing is built)", () => {
    const r = compileSpec(["part A, B input-pin", "part N1, N2 buf", "part Y output-pin", "A -> N1", "B -> N2", "net s = N1.out, N2.out, Y.in"].join("\n"));
    expect(r.doc).not.toBeNull();
    const c = extractCircuit(r.doc!);
    expect(kinds(checkCircuit(c))).toContain("multiple-drivers");
    const s = new Simulator(c);
    s.set("A", 1);
    expect(kinds(s.settle().issues)).toEqual(["contention"]);
  });

  it("resolves tri-state buffers: contention, a pull-up, and a floating bus", () => {
    const doc = mk(
      [["A", "input-pin"], ["B", "input-pin"], ["EA", "input-pin"], ["EB", "input-pin"], ["TA", "tristate"], ["TB", "tristate"], ["Y", "output-pin"]],
      [["A.out", "TA.in"], ["B.out", "TB.in"], ["EA.out", "TA.en"], ["EB.out", "TB.en"], ["TA.out", "TB.out", "Y.in"]],
    );
    const c = extractCircuit(doc);
    expect(checkCircuit(c).filter((i) => i.severity === "error")).toEqual([]);
    const s = new Simulator(c);
    s.set("A", 1);
    s.set("EA", 1);
    expect(s.settle().issues).toEqual([]);
    expect(s.read("Y")).toBe(1);
    s.set("EB", 1); // B is 0
    expect(kinds(s.settle().issues)).toEqual(["contention"]);
    s.set("EA", 0);
    s.set("EB", 0);
    expect(kinds(s.settle().issues)).toEqual(["floating"]);

    const pulled = structuredClone(doc);
    pulled.components.push({ id: "PU", type: "pull-up", x: 0, y: 600, rotation: 0, props: {}, label: "" });
    pulled.links!.push(["p:PU|out", "p:Y|in"]);
    const s2 = sim(pulled);
    expect(s2.settle().issues).toEqual([]);
    expect(s2.read("Y")).toBe(1);
    s2.set("B", 0);
    s2.set("EB", 1); // a driven 0 beats the pull-up
    expect(s2.settle().issues).toEqual([]);
    expect(s2.read("Y")).toBe(0);
  });

  it("holds state in a latch of cross-coupled NOR gates", () => {
    const doc = mk(
      [["S", "input-pin"], ["R", "input-pin"], ["G1", "nor"], ["G2", "nor"], ["Q", "output-pin"]],
      [["R.out", "G1.in0"], ["G2.out", "G1.in1"], ["S.out", "G2.in0"], ["G1.out", "G2.in1", "Q.in"]],
    );
    const c = extractCircuit(doc);
    expect(kinds(checkCircuit(c))).toContain("feedback");
    const s = new Simulator(c);
    s.settle();
    expect(s.read("Q")).toBe(null); // never set
    s.set("S", 1);
    s.settle();
    expect(s.read("Q")).toBe(1);
    s.set("S", 0);
    s.settle();
    expect(s.read("Q")).toBe(1);
    s.set("R", 1);
    s.settle();
    expect(s.read("Q")).toBe(0);
    s.set("R", 0);
    expect(s.settle().stable).toBe(true);
    expect(s.read("Q")).toBe(0);
  });

  it("reports a ring of inverters as oscillating", () => {
    const doc = mk(
      [["N1", "not"], ["N2", "not"], ["N3", "nand"], ["EN", "input-pin"], ["Y", "output-pin"]],
      [["N1.out", "N2.in0"], ["N2.out", "N3.in0"], ["EN.out", "N3.in1"], ["N3.out", "N1.in0", "Y.in"]],
    );
    const s = sim(doc);
    s.set("EN", 0);
    expect(s.settle().stable).toBe(true);
    expect(s.read("Y")).toBe(1);
    s.set("EN", 1);
    const r = s.settle();
    expect(r.stable).toBe(false);
    expect(r.issues[0].kind).toBe("oscillation");
    expect(s.read("Y")).toBe(null);
    s.set("EN", 0); // stopping the ring settles again
    expect(s.settle().stable).toBe(true);
    expect(s.read("Y")).toBe(1);
  });

  it("clocks flip-flops on one clock together (a shift register shifts by one)", () => {
    const doc = mk(
      [["D", "input-pin"], ["CLK", "clock"], ["F1", "d-ff"], ["F2", "d-ff"], ["Q1", "output-pin"], ["Q2", "output-pin"]],
      [["D.out", "F1.d"], ["CLK.clk", "F1.clk", "F2.clk"], ["F1.q", "F2.d", "Q1.in"], ["F2.q", "Q2.in"]],
    );
    const s = new Simulator(extractCircuit(doc), { initial: "zero" });
    const tick = () => {
      s.set("CLK", 1);
      s.settle();
      s.set("CLK", 0);
      s.settle();
    };
    s.settle();
    s.set("D", 1);
    s.settle();
    tick();
    expect([s.read("Q1"), s.read("Q2")]).toEqual([1, 0]);
    s.set("D", 0);
    s.settle();
    tick();
    expect([s.read("Q1"), s.read("Q2")]).toEqual([0, 1]);
  });

  it("starts flip-flops unknown, and a reset makes them known", () => {
    const doc = mk(
      [["CLK", "clock"], ["RST", "input-pin"], ["C", "counter", { bits: 3, enable: false, carryOut: false }], ["Q", "output-pin", { width: 3 }]],
      [["CLK.clk", "C.clk"], ["RST.out", "C.rst"], ["C.q", "Q.in"]],
    );
    const s = sim(doc);
    const tick = () => {
      s.set("CLK", 1);
      s.settle();
      s.set("CLK", 0);
      s.settle();
    };
    s.settle();
    tick();
    expect(s.read("Q")).toBe(null);
    s.set("RST", 1);
    tick();
    expect(s.read("Q")).toBe(0);
    s.set("RST", 0);
    for (let i = 1; i <= 9; i++) {
      tick();
      expect(s.read("Q")).toBe(i % 8);
    }
  });

  it("evaluates a full adder part and a mux", () => {
    const doc = mk(
      [["A", "input-pin"], ["B", "input-pin"], ["CI", "input-pin"], ["FA", "full-adder"], ["M", "mux"], ["S", "output-pin"], ["Y", "output-pin"]],
      [["A.out", "FA.a", "M.d0"], ["B.out", "FA.b", "M.d1"], ["CI.out", "FA.cin", "M.s0"], ["FA.s", "S.in"], ["M.y", "Y.in"]],
    );
    const s = sim(doc);
    for (let m = 0; m < 8; m++) {
      const a = m & 1, b = (m >> 1) & 1, ci = (m >> 2) & 1;
      s.set("A", a);
      s.set("B", b);
      s.set("CI", ci);
      s.settle();
      expect(s.read("S")).toBe(a ^ b ^ ci);
      expect(s.read("Y")).toBe(ci ? b : a);
    }
  });
});

describe("truth tables and Karnaugh maps", () => {
  it("reads the minimal sum of products back off a drawing", () => {
    const names = ["cin", "b", "a"];
    const doc = sopToSchematic(minimize(3, [3, 5, 6, 7]).terms, names, "cout");
    const t = truthTable(extractCircuit(doc));
    expect(t.vars).toEqual(["cin", "b", "a"]); // inputs are drawn a, b, cin: a is the MSB
    const [f] = outputFunctions(t);
    expect(f.minterms).toEqual([3, 5, 6, 7]);
    expect(f.sop).toBe(sopToString(minimize(3, [3, 5, 6, 7]).terms, names));
    expect(f.kmap).toContain("a\\bcin");
    expect(truthTableText(t).split("\n")).toHaveLength(2 + 8);
  });

  it("recovers every output of a multi-output drawing", () => {
    const fs = [[1, 2, 4, 7, 9, 12], [0, 3, 5, 6, 15], [2, 3, 10, 11, 14]];
    const names = ["w0", "w1", "w2", "w3"];
    const doc = sopsToSchematic(fs.map((ms, k) => ({ name: `y${k}`, terms: minimize(4, ms).terms })), names);
    const t = truthTable(extractCircuit(doc));
    expect(t.vars).toEqual(names);
    expect(outputFunctions(t).map((f) => f.minterms)).toEqual(fs);
  });

  it("refuses an output that depends on state", () => {
    const doc = mk([["D", "input-pin"], ["CLK", "clock"], ["F", "d-ff"], ["Q", "output-pin"]], [["D.out", "F.d"], ["CLK.clk", "F.clk"], ["F.q", "Q.in"]]);
    expect(() => truthTable(extractCircuit(doc))).toThrow(/state/);
  });
});

describe("watching the document", () => {
  const base = () => sopToSchematic(minimize(3, [3, 5, 6, 7]).terms, ["cin", "b", "a"], "cout");

  it("rebuilds only when connections or parts change", () => {
    const store = new DocumentStore(base());
    const seen: string[] = [];
    const w = watchCircuit(store, () => seen.push("structure"));
    // moving a part and its wires, rotating, dragging a wire: nothing
    store.beginGesture();
    for (let i = 0; i < 5; i++)
      store.update("move", (d) => {
        d.components[0].x += 10;
        for (const wire of d.wires) for (const p of wire.points) p.y += 10;
      });
    store.endGesture();
    store.update("drag wire", (d) => {
      const wire = d.wires[d.wires.length - 1];
      wire.points = wire.points.map((p) => ({ x: p.x + 40, y: p.y }));
    });
    store.setSelection([store.doc.components[0].id]);
    expect(seen).toEqual([]);
    expect(w.builds).toBe(0);
    // splitting a wire in two (new ids) keeps the same connections: nothing
    store.update(
      "split",
      (d) => {
        const wire = d.wires[0];
        const id = wire.id;
        d.wires.push({ id: `${id}_b`, points: wire.points.map((p) => ({ ...p })) });
        d.links = [...d.links!, [`w:${id}`, `w:${id}_b`]];
      },
      { exact: true },
    );
    expect(seen).toEqual([]);
    // a rename does not run it; the names are fresh when the circuit is next asked for
    store.update("rename", (d) => {
      d.components.find((c) => c.type === "or")!.label = "carry";
    });
    expect(seen).toEqual([]);
    expect(w.builds).toBe(0);
    expect(w.current().circuit.parts.some((p) => p.name === "carry")).toBe(true);
    // a property that changes pins, a deleted part, an undo: rebuilds
    store.update("inputs", (d) => {
      d.components.find((c) => c.type === "or")!.props.inputs = 4;
    });
    store.update("delete", (d) => {
      const and = d.components.find((c) => c.type === "and")!;
      d.components = d.components.filter((c) => c !== and);
    });
    expect(w.current().issues.some((i) => i.kind === "floating-input")).toBe(true);
    store.undo();
    expect(seen).toEqual(["structure", "structure", "structure"]);
    w.dispose();
  });

  it("does nothing while parts and wires are dragged through the editor", () => {
    // the editor's own move path: moved parts drag their wires and re-route them
    const store = new DocumentStore(emptyDocument());
    const pin = (d: SchematicDocument, id: string, p: string) => worldPins(d.components.find((c) => c.id === id)!).find((q) => q.pin.id === p)!.pos;
    store.update("setup", (d) => {
      const C = (id: string, type: string, x: number, y: number): ComponentInstance => ({ id, type, x, y, rotation: 0, props: {} });
      d.components.push(C("a", "input-pin", 100, 100), C("b", "input-pin", 100, 200), C("g", "and", 300, 130), C("n", "not", 300, 300), C("o", "or", 500, 180), C("y", "output-pin", 700, 190));
      const add = (id: string, a: [string, string], b: [string, string]) => {
        const r = safeRoute(new RouteObstacles(d), pin(d, ...a), pin(d, ...b));
        if (r) d.wires.push({ id, points: r });
      };
      add("w1", ["a", "out"], ["g", "in0"]);
      add("w2", ["b", "out"], ["g", "in1"]);
      add("w3", ["g", "out"], ["o", "in0"]);
      add("w4", ["n", "out"], ["o", "in1"]);
      add("w5", ["o", "out"], ["y", "in"]);
    });
    let calls = 0;
    const w = watchCircuit(store, () => calls++);
    const before = circuitText(w.current().circuit);
    for (const id of ["g", "o", "n"]) {
      store.setSelection([id]);
      for (const [dx, dy] of [[0, 80], [-120, 0], [0, -200], [300, 100], [-120, -60]]) nudgeSelectionInStore(store, dx, dy);
    }
    // drag the middle segment of a bent wire, as the editor does (one gesture of small steps)
    const bent = store.doc.wires.find((x) => x.points.length >= 4);
    expect(bent).toBeDefined();
    if (bent) {
      const orig = bent.points.map((p) => ({ ...p }));
      store.beginGesture();
      for (let k = 1; k <= 4; k++)
        store.update("drag segment", (d) => {
          d.wires.find((x) => x.id === bent.id)!.points = dragWireSegmentPoints(orig, 1, { x: 10 * k, y: 10 * k }, true, true);
        });
      store.endGesture();
    }
    expect(calls).toBe(0);
    expect(w.builds).toBe(1);
    expect(circuitText(w.current().circuit)).toBe(before);
  });

  it("builds lazily without a listener", () => {
    const store = new DocumentStore(base());
    const w = watchCircuit(store);
    store.update("move", (d) => void (d.components[0].x += 10));
    expect(w.builds).toBe(0);
    const s = w.current();
    expect(w.builds).toBe(1);
    expect(w.current()).toBe(s);
    expect(evaluateCombinational(store.doc, { a: true, b: true, cin: false })).toEqual({ cout: true });
  });
});

describe("state tables", () => {
  // a 2-bit up counter with an enable: D0 = Q0 xor EN, D1 = Q1 xor (Q0 EN)
  const counter = () =>
    mk(
      [["EN", "input-pin"], ["CLK", "clock"], ["F0", "d-ff"], ["F1", "d-ff"], ["X0", "xor"], ["A", "and"], ["X1", "xor"], ["Y0", "output-pin"], ["Y1", "output-pin"]],
      [
        ["F0.q", "X0.in0", "A.in0", "Y0.in"], ["EN.out", "X0.in1", "A.in1"], ["X0.out", "F0.d"],
        ["F1.q", "X1.in0", "Y1.in"], ["A.out", "X1.in1"], ["X1.out", "F1.d"], ["CLK.clk", "F0.clk", "F1.clk"],
      ],
    );

  it("cuts the flip-flops open and gives the next-state equations", () => {
    const t = stateTable(extractCircuit(counter()));
    expect(t.state.map((p) => p.name)).toEqual(["F0_q", "F1_q"]);
    expect(t.vars).toEqual(["EN", "F1_q", "F0_q"]); // LSB first: F0_q is the most significant
    const f = outputFunctions(t);
    expect(f.map((x) => x.name)).toEqual(["F0_d", "F1_d", "Y0", "Y1"]);
    const eq = Object.fromEntries(f.map((x) => [x.name, x.sop]));
    expect(eq.F0_d).toBe(sopToString(minimize(3, [1, 3, 4, 6]).terms, t.vars));
    expect(eq.Y0).toBe("F0_q");
  });

  it("ticks the clock", () => {
    const s = new Simulator(extractCircuit(counter()), { initial: "zero" });
    s.set("EN", 1);
    s.settle();
    const seen: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push((s.read("Y1") ?? 9) * 2 + (s.read("Y0") ?? 9));
      s.tick();
    }
    expect(seen).toEqual([0, 1, 2, 3, 0]);
  });
});

describe("comparing circuits", () => {
  it("a drawing equals the DSpec it should implement, and a wrong gate is caught with a counterexample", () => {
    const names = ["cin", "b", "a"];
    const terms = minimize(3, [3, 5, 6, 7]).terms;
    const drawing = sopToSchematic(terms, names, "cout");
    const built = compileSpec(sopToDspec(terms, names, "cout"));
    expect(built.doc).not.toBeNull();
    const r = compareCircuits(extractCircuit(drawing), extractCircuit(built.doc!));
    expect(r).toMatchObject({ equal: true, mode: "exhaustive", tried: 8, mismatches: [] });
    const wrong = structuredClone(drawing);
    // (not OR -> XOR: ab xor ac xor bc is the majority function too)
    wrong.components.find((c) => c.type === "or")!.type = "and";
    const w = compareCircuits(extractCircuit(wrong), extractCircuit(built.doc!));
    expect(w.equal).toBe(false);
    expect(w.mismatches.length).toBeGreaterThan(0);
    const m = w.mismatches[0];
    expect(m.output).toBe("cout");
    expect([m.a, m.b]).toEqual([0, 1]);
  });

  it("compares circuits with state over random cycles", () => {
    const counter = (bug: boolean) =>
      mk(
        [["EN", "input-pin"], ["CLK", "clock"], ["F0", "d-ff"], ["F1", "d-ff"], ["X0", "xor"], ["A", bug ? "or" : "and"], ["X1", "xor"], ["Y0", "output-pin"], ["Y1", "output-pin"]],
        [
          ["F0.q", "X0.in0", "A.in0", "Y0.in"], ["EN.out", "X0.in1", "A.in1"], ["X0.out", "F0.d"],
          ["F1.q", "X1.in0", "Y1.in"], ["A.out", "X1.in1"], ["X1.out", "F1.d"], ["CLK.clk", "F0.clk", "F1.clk"],
        ],
      );
    const ok = compareCircuits(extractCircuit(counter(false)), extractCircuit(counter(false)), { cycles: 100 });
    expect(ok).toMatchObject({ equal: true, mode: "random", tried: 100 });
    const bad = compareCircuits(extractCircuit(counter(false)), extractCircuit(counter(true)), { cycles: 100 });
    expect(bad.equal).toBe(false);
    expect(bad.mismatches[0].output).toBe("Y1");
  });

  it("lists inputs and outputs only one side has", () => {
    const a = mk([["A", "input-pin"], ["Y", "output-pin"]], [["A.out", "Y.in"]]);
    const b = mk([["B", "input-pin"], ["Y", "output-pin"]], [["B.out", "Y.in"]]);
    const r = compareCircuits(extractCircuit(a), extractCircuit(b));
    expect(r.onlyA).toEqual(["A"]);
    expect(r.onlyB).toEqual(["B"]);
    expect(r.equal).toBe(false);
  });
});

describe("scanning a circuit for problems that depend on values", () => {
  it("finds the input combination where two tri-state buffers fight, and when the bus floats", () => {
    const doc = mk(
      [["A", "input-pin"], ["B", "input-pin"], ["EA", "input-pin"], ["EB", "input-pin"], ["TA", "tristate"], ["TB", "tristate"], ["Y", "output-pin"]],
      [["A.out", "TA.in"], ["B.out", "TB.in"], ["EA.out", "TA.en"], ["EB.out", "TB.en"], ["TA.out", "TB.out", "Y.in"]],
    );
    const r = scanCircuit(extractCircuit(doc));
    expect(r).toMatchObject({ mode: "exhaustive", tried: 16 });
    const short = r.findings.find((f) => f.kind === "contention")!;
    expect(short.count).toBe(2); // both enabled, A != B
    expect(short.example.EA && short.example.EB && short.example.A !== short.example.B).toBeTruthy();
    const float = r.findings.find((f) => f.kind === "floating")!;
    expect(float.count).toBe(4); // both disabled
    expect([float.example.EA, float.example.EB]).toEqual([0, 0]);
  });

  it("is quiet on a correct design", () => {
    const doc = sopToSchematic(minimize(3, [3, 5, 6, 7]).terms, ["cin", "b", "a"], "cout");
    expect(scanCircuit(extractCircuit(doc)).findings).toEqual([]);
  });
});

describe("hazards", () => {
  // F = AB + A'C, and with the consensus term BC
  const f = (consensus: boolean) =>
    mk(
      [["A", "input-pin"], ["B", "input-pin"], ["C", "input-pin"], ["N", "not"], ["G1", "and"], ["G2", "and"], ["G3", "and"], ["S", "or", { inputs: consensus ? 3 : 2 }], ["F", "output-pin"]],
      [
        ["A.out", "N.in0", "G1.in0"], ["B.out", "G1.in1", ...(consensus ? ["G3.in0"] : [])], ["N.out", "G2.in0"], ["C.out", "G2.in1", ...(consensus ? ["G3.in1"] : [])],
        ["G1.out", "S.in0"], ["G2.out", "S.in1"], ...(consensus ? [["G3.out", "S.in2"]] : []), ["S.out", "F.in"],
      ],
    );

  it("finds the static-1 hazard of AB + A'C when A changes with B = C = 1", () => {
    const hz = hazardScan(extractCircuit(f(false)));
    expect(hz.length).toBe(1);
    expect(hz[0]).toMatchObject({ output: "F", kind: "static-1", input: "A", count: 1 });
    expect(hz[0].from).toMatchObject({ B: 1, C: 1 });
    expect(hz[0].waveform).toMatch(/^10+1$/);
  });

  it("the consensus term BC removes it", () => {
    expect(hazardScan(extractCircuit(f(true)))).toEqual([]);
  });

  it("zero-delay simulation never glitches", () => {
    const s = new Simulator(extractCircuit(f(false)));
    s.set("A", 1);
    s.set("B", 1);
    s.set("C", 1);
    s.settle();
    s.set("A", 0);
    expect(s.settle().history).toBeUndefined();
    expect(s.read("F")).toBe(1);
  });
});

describe("watching builds from code", () => {
  const apply = (store: DocumentStore, source: string) => {
    const r = compileSpec(source, { previous: store.doc });
    expect(r.doc).not.toBeNull();
    // as the code dialog applies a build
    store.update(
      "Build from code",
      (d) => {
        d.name = r.doc!.name;
        d.grid = r.doc!.grid;
        d.components = r.doc!.components;
        d.wires = r.doc!.wires;
        d.texts = r.doc!.texts;
        d.links = r.doc!.links;
      },
      { exact: true },
    );
  };
  const src = (gate: string, extra = "") => `part A, B input-pin\npart G ${gate}\npart Y output-pin\nA -> G.in0\nB -> G.in1\nG -> Y\n${extra}`;

  it("rebuilding the same code (even laid out again) is not a structural change; a changed connection is", () => {
    const store = new DocumentStore();
    apply(store, src("and"));
    let calls = 0;
    const w = watchCircuit(store, () => calls++);
    apply(store, src("and"));
    apply(store, `@layout grid\n${src("and")}`);
    expect(calls).toBe(0);
    apply(store, src("or"));
    expect(calls).toBe(1);
    expect(w.current().circuit.parts.find((p) => p.name === "G")!.type).toBe("or");
    apply(store, src("or", "part C input-pin\n"));
    expect(calls).toBe(2);
    expect(w.current().issues.some((i) => i.kind === "unused-input")).toBe(true);
  });
});

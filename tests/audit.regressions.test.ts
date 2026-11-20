/**
 * Regression tests for the Gemini audit findings (AUDIT.md) that were validated and fixed.
 * Each test asserts the CORRECT behaviour for a scenario the audit proved broken.
 */
import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { DocumentStore } from "../src/model/store";
import { emptyDocument, type ComponentInstance, type Point, type SchematicDocument } from "../src/model/types";
import { documentBounds, junctionPoints, pointOnSegment, unconnectedPins, worldPins } from "../src/model/geometry";
import { buildNetlist, exportNetlistText } from "../src/io/netlist";
import { parseProjectWithWarnings, serializeProject } from "../src/io/project";
import { renderComponent, renderDocumentSvg } from "../src/render/svg";
import { getDef } from "../src/model/registry";
import {
  keepWiresAttached,
  mirrorSelectionInStore,
  nudgeSelectionInStore,
  rotateSelectionInDoc,
  rotateSelectionInStore,
} from "../src/editor/doc-ops";
import { normalizeDocWires } from "../src/editor/wire-utils";
import { RouteObstacles, repairWires, safeRoute } from "../src/editor/safe-route";

registerBuiltinComponents();

const pinPos = (c: ComponentInstance, id: string) => worldPins(c).find((p) => p.pin.id === id)!.pos;
const netOf = (doc: SchematicDocument, comp: string, pin: string) =>
  buildNetlist(doc).nets.find((n) => n.pins.some((p) => p.componentId === comp && p.pinId === pin))!;
/** No wire passes over a pin other than at its own two endpoints. */
function noWireOverForeignPin(doc: SchematicDocument): boolean {
  for (const w of doc.wires) {
    const ends = [w.points[0], w.points[w.points.length - 1]];
    for (const c of doc.components)
      for (const wp of worldPins(c)) {
        if (ends.some((e) => e.x === wp.pos.x && e.y === wp.pos.y)) continue;
        for (let i = 0; i + 1 < w.points.length; i++) if (pointOnSegment(wp.pos, w.points[i], w.points[i + 1])) return false;
      }
  }
  return true;
}

describe("AUD-01/02: transforms never short pins", () => {
  it("mirroring a wired NOT gate keeps input and output on separate nets (AUD-01 / T2)", () => {
    const store = new DocumentStore(emptyDocument());
    store.update("setup", (d) => {
      const inv: ComponentInstance = { id: "u1", type: "not", x: 200, y: 200, rotation: 0, props: {} };
      d.components.push(inv);
      d.wires.push({ id: "w_in", points: [{ x: 100, y: pinPos(inv, "in0").y }, pinPos(inv, "in0")] });
      d.wires.push({ id: "w_out", points: [pinPos(inv, "out"), { x: 380, y: pinPos(inv, "out").y }] });
    });
    store.setSelection(["u1"]);
    mirrorSelectionInStore(store);
    expect(netOf(store.doc, "u1", "in0").id).not.toBe(netOf(store.doc, "u1", "out").id);
    expect(noWireOverForeignPin(store.doc)).toBe(true);
  });

  it("rotating a wired 2-input gate keeps in0/in1 separate (AUD-01 / T1)", () => {
    const store = new DocumentStore(emptyDocument());
    store.update("setup", (d) => {
      const g: ComponentInstance = { id: "g", type: "and", x: 200, y: 200, rotation: 0, props: { inputs: 2 } };
      d.components.push(g);
      d.wires.push({ id: "w0", points: [{ x: 100, y: pinPos(g, "in0").y }, pinPos(g, "in0")] });
      d.wires.push({ id: "w1", points: [{ x: 100, y: pinPos(g, "in1").y }, pinPos(g, "in1")] });
    });
    store.setSelection(["g"]);
    for (let i = 0; i < 4; i++) {
      rotateSelectionInStore(store);
      expect(netOf(store.doc, "g", "in0").id).not.toBe(netOf(store.doc, "g", "in1").id);
      expect(noWireOverForeignPin(store.doc)).toBe(true);
    }
  });

  it("nudging a gate wired from vertically aligned sources does not short them (AUD-02 / T3)", () => {
    const store = new DocumentStore(emptyDocument());
    store.update("setup", (d) => {
      const g: ComponentInstance = { id: "g", type: "and", x: 200, y: 200, rotation: 0, props: { inputs: 2 } };
      const a: ComponentInstance = { id: "a", type: "input-pin", x: 0, y: 0, rotation: 0, props: {} };
      d.components.push(g);
      d.wires.push({ id: "wA", points: [{ x: 100, y: pinPos(g, "in0").y }, pinPos(g, "in0")] });
      d.wires.push({ id: "wB", points: [{ x: 100, y: pinPos(g, "in1").y }, pinPos(g, "in1")] });
      void a;
    });
    store.setSelection(["g"]);
    nudgeSelectionInStore(store, 0, 20);
    const [wA, wB] = store.doc.wires;
    // wA must not pass over wB's free end (100, in1.y) — that would join the two nets.
    const wBStart = wB.points[0];
    expect(wA.points.slice(1, -1).some((p) => p.x === wBStart.x && p.y === wBStart.y)).toBe(false);
    for (let i = 0; i + 1 < wA.points.length; i++) {
      const onSeg = pointOnSegment(wBStart, wA.points[i], wA.points[i + 1]);
      expect(onSeg && !(i === 0 && wA.points[0].x === wBStart.x && wA.points[0].y === wBStart.y)).toBe(false);
    }
  });

  it("re-routing avoids a straight feedback path through components (AUD-04 / T8)", () => {
    const doc = emptyDocument();
    const g1: ComponentInstance = { id: "g1", type: "and", x: 100, y: 100, rotation: 0, props: { inputs: 2 } };
    const g2: ComponentInstance = { id: "g2", type: "and", x: 200, y: 100, rotation: 0, props: { inputs: 2 } };
    doc.components.push(g1, g2);
    const obs = new RouteObstacles(doc);
    const r = safeRoute(obs, pinPos(g2, "out"), pinPos(g1, "in0"))!;
    expect(r).not.toBeNull();
    expect(obs.routeIsBad(r)).toBe(false);
    expect(r.length).toBeGreaterThan(2); // must detour, not cut straight back through the gates
  });
});

describe("AUD-03/24: store gestures", () => {
  it("replace() during a gesture leaves undo working (S1)", () => {
    const s = new DocumentStore();
    s.beginGesture();
    s.update("x", (d) => d.texts.push({ id: "t", x: 0, y: 0, text: "a" }));
    s.replace(emptyDocument());
    s.update("y", (d) => d.texts.push({ id: "u", x: 0, y: 0, text: "b" }));
    expect(s.canUndo()).toBe(true);
  });
  it("undo during a drag restores the pre-drag state and later moves start a new entry (S2)", () => {
    const s = new DocumentStore();
    s.update("add", (d) => d.texts.push({ id: "t", x: 0, y: 0, text: "a" }));
    s.beginGesture();
    s.update("move", (d) => (d.texts[0].x = 10));
    s.undo();
    expect(s.doc.texts[0].x).toBe(0);
    s.update("move", (d) => (d.texts[0].x = 20));
    s.undo();
    expect(s.doc.texts[0].x).toBe(0);
    expect(s.doc.texts).toHaveLength(1);
  });
  it("cancelGesture restores dirty flag and redo stack (S3)", () => {
    const s = new DocumentStore();
    s.update("add", (d) => d.texts.push({ id: "t", x: 0, y: 0, text: "a" }));
    s.undo();
    s.markSaved(null);
    s.beginGesture();
    s.update("noop-ish", (d) => d.texts.push({ id: "q", x: 0, y: 0, text: "q" }));
    s.cancelGesture();
    expect(s.dirty).toBe(false);
    expect(s.canRedo()).toBe(true);
  });
  it("no-op updates and zero-delta gestures create no history (AUD-16/24)", () => {
    const s = new DocumentStore();
    s.update("add", (d) => d.texts.push({ id: "t", x: 0, y: 0, text: "a" }));
    const depth = () => (s.canUndo() ? 1 : 0);
    s.undo();
    s.redo();
    s.update("same", (d) => (d.texts[0].x = 0));
    s.undo();
    expect(s.doc.texts).toHaveLength(0); // one undo removed the add: the no-op made no entry
    s.redo();
    s.beginGesture();
    s.update("drag", (d) => (d.texts[0].x = 10));
    s.update("drag", (d) => (d.texts[0].x = 0));
    s.endGesture();
    s.undo();
    expect(s.doc.texts).toHaveLength(0);
    void depth;
  });
});

describe("AUD-05/06/08: connectivity, junction dots and netlist agree", () => {
  it("normalizing keeps a shared 4-way crossing vertex (C5)", () => {
    const d = emptyDocument();
    d.wires.push({ id: "a", points: [{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 }] });
    d.wires.push({ id: "b", points: [{ x: 50, y: 0 }, { x: 50, y: 50 }, { x: 50, y: 100 }] });
    normalizeDocWires(d);
    expect(buildNetlist(d).nets).toHaveLength(1);
    expect(junctionPoints(d)).toEqual([{ x: 50, y: 50 }]);
  });
  it("overlapping collinear wires connect, with no false mid-wire dots (C3/C4)", () => {
    const d = emptyDocument();
    d.wires.push({ id: "w1", points: [{ x: 0, y: 50 }, { x: 200, y: 50 }] });
    d.wires.push({ id: "w2", points: [{ x: 50, y: 0 }, { x: 50, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 100 }] });
    expect(buildNetlist(d).nets).toHaveLength(1);
    const dots = junctionPoints(d).map((p) => `${p.x},${p.y}`).sort();
    expect(dots).toEqual(["120,50", "50,50"]);
  });
  it("a plain crossing does not connect and gets no dot", () => {
    const d = emptyDocument();
    d.wires.push({ id: "h", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] });
    d.wires.push({ id: "v", points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] });
    expect(buildNetlist(d).nets).toHaveLength(2);
    expect(junctionPoints(d)).toEqual([]);
  });
  it("a pin tapping a wire mid-segment gets a dot; abutting pins tapped by a wire too (C1/C2)", () => {
    const d = emptyDocument();
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: {} }; // out (80,30)
    d.components.push(g1);
    const out = pinPos(g1, "out");
    d.wires.push({ id: "w", points: [{ x: out.x, y: out.y - 40 }, { x: out.x, y: out.y + 40 }] });
    expect(junctionPoints(d)).toContainEqual(out);
    expect(unconnectedPins(d)).not.toContainEqual(out);
  });
  it("tunnels with default name join; netlist names CLK and Q' pins (C6 / AUD-23)", () => {
    const d = emptyDocument();
    d.components.push({ id: "t1", type: "tunnel", x: 0, y: 0, rotation: 0, props: {} });
    d.components.push({ id: "t2", type: "tunnel", x: 200, y: 0, rotation: 0, props: {} });
    expect(netOf(d, "t1", "net").id).toBe(netOf(d, "t2", "net").id);
    const ff = emptyDocument();
    ff.components.push({ id: "f", type: "d-ff", x: 0, y: 0, rotation: 0, props: { showQBar: true }, label: "FF1" });
    const txt = exportNetlistText(ff);
    expect(txt).not.toMatch(/FF1\.(,|$|\n)/);
    expect(txt).toMatch(/FF1\.CLK/);
  });
});

describe("AUD-07/09/12: moves, rotation identity, collapsed wires", () => {
  it("branch wires follow when the wire they tap moves (T9)", () => {
    const store = new DocumentStore(emptyDocument());
    store.update("setup", (d) => {
      const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 } };
      const g2: ComponentInstance = { id: "g2", type: "not", x: 160, y: 10, rotation: 0, props: {} };
      const g3: ComponentInstance = { id: "g3", type: "not", x: 160, y: 100, rotation: 0, props: {} };
      d.components.push(g1, g2, g3);
      d.wires.push({ id: "w_main", points: [pinPos(g1, "out"), pinPos(g2, "in0")] });
      d.wires.push({ id: "w_tap", points: [{ x: 120, y: 30 }, { x: 120, y: 120 }, pinPos(g3, "in0")] });
    });
    store.setSelection(["g1", "g2"]);
    nudgeSelectionInStore(store, 0, -20);
    expect(netOf(store.doc, "g1", "out").pins).toHaveLength(3);
    expect(store.doc.wires.find((w) => w.id === "w_main")!.points).toHaveLength(2); // stays straight
  });
  it("4 rotations and 2 mirrors are exact identities for every component (T5/T6)", () => {
    for (const def of ["not", "nand", "register", "register-file", "mux", "d-ff"]) {
      const d = emptyDocument();
      d.components.push({ id: "c", type: def, x: 100, y: 100, rotation: 0, props: {} });
      const sel = new Set(["c"]);
      for (let i = 0; i < 4; i++) rotateSelectionInDoc(d, sel);
      expect([d.components[0].x, d.components[0].y, d.components[0].rotation], def).toEqual([100, 100, 0]);
    }
    const store = new DocumentStore(emptyDocument());
    store.update("s", (d) => {
      d.components.push({ id: "n", type: "not", x: 100, y: 100, rotation: 0, props: {} });
      d.wires.push({ id: "w", points: [{ x: 100, y: 300 }, { x: 150, y: 300 }] });
    });
    store.setSelection(["n", "w"]);
    mirrorSelectionInStore(store);
    mirrorSelectionInStore(store);
    expect(store.doc.components[0].x).toBe(100);
    expect(store.doc.wires[0].points[0].x).toBe(100);
  });
  it("wires collapsed by a transform are removed, not left as 1-point zombies (T7)", () => {
    const d = emptyDocument();
    const ip: ComponentInstance = { id: "i", type: "input-pin", x: 100, y: 100, rotation: 0, props: { name: "A", width: 1 } };
    d.components.push(ip);
    const out = pinPos(ip, "out");
    d.wires.push({ id: "w", points: [out, { x: out.x + 30, y: out.y }] });
    keepWiresAttached(d, new Set(["i"]), () => {
      d.components[0].props.width = 8;
    });
    expect(d.wires.every((w) => w.points.length >= 2)).toBe(true);
  });
});

describe("AUD-10/11/22/27/29 rendering & export", () => {
  it("mirrored / 180° parts counter-transform their text so it stays readable (R3)", () => {
    const svg = renderComponent({ id: "t", type: "tunnel", x: 0, y: 0, rotation: 0, mirror: true, props: { name: "CLK" } });
    expect(svg).toMatch(/<text[^>]*transform="translate\([^"]*matrix\(-1 0 0 1/);
    const up = renderComponent({ id: "t", type: "tunnel", x: 0, y: 0, rotation: 0, props: { name: "CLK" } });
    expect(up).not.toMatch(/<text[^>]*transform=/);
  });
  it("document bounds include multi-line notes and labels (R1/R2)", () => {
    const d = emptyDocument();
    d.texts.push({ id: "n", x: 10, y: 20, text: "a\nb\nc\nd\ne\nf", fontSize: 14 });
    expect(documentBounds(d)!.h).toBeGreaterThan(14 * 6);
  });
  it("export grid dots are centered in their tile; degenerate content still has size (R4/R5)", () => {
    const d = emptyDocument();
    d.wires.push({ id: "w", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] });
    const svg = renderDocumentSvg(d, { grid: true, padding: 0 });
    expect(svg).toContain('<circle cx="5" cy="5"');
    expect(svg).not.toContain('height="0"');
  });
  it("labels avoid wires leaving top pins: below if bottom is free, else top-right corner (AUD-29)", () => {
    const ram = renderComponent({ id: "r", type: "ram", x: 0, y: 100, rotation: 0, props: {}, label: "MEM" });
    const yRam = Number(/class="ds-label" x="[^"]+" y="([^"]+)"/.exec(ram)![1]);
    expect(yRam).toBeGreaterThan(100 + getDef("ram")!.geometry({}).height);
    const fa = renderComponent({ id: "f", type: "full-adder", x: 0, y: 100, rotation: 0, props: {}, label: "FA1" });
    const m = /class="ds-label" x="([^"]+)" y="[^"]+" text-anchor="(\w+)"/.exec(fa)!;
    expect(m[2]).toBe("start");
    expect(Number(m[1])).toBeGreaterThan(getDef("full-adder")!.geometry({}).width);
  });
});

describe("AUD-19/28 IO & library", () => {
  it("non-10 grids are coerced so wires stay on pins; zero-length wires dropped (IO2)", () => {
    const d = emptyDocument();
    const g: ComponentInstance = { id: "g", type: "and", x: 100, y: 100, rotation: 0, props: {} };
    d.components.push(g);
    const out = pinPos(g, "out");
    d.wires.push({ id: "w", points: [out, { x: out.x + 40, y: out.y }] }, { id: "z", points: [{ x: 5, y: 5 }, { x: 5, y: 5 }] });
    const text = serializeProject(d).replace('"grid": 10', '"grid": 20');
    const { doc, warnings } = parseProjectWithWarnings(text);
    expect(doc.grid).toBe(10);
    expect(doc.wires[0].points[0]).toEqual(out);
    expect(doc.wires).toHaveLength(1);
    expect(warnings.some((w) => /grid/i.test(w))).toBe(true);
  });
  it("splitter never shows bit indices beyond the bus width (IO3)", () => {
    const g = getDef("splitter")!.geometry({ width: 4, fanOut: 8 });
    expect(g.pins.length).toBe(5); // 1 bus pin + 4 one-bit slices
  });
});

describe("repairWires", () => {
  it("leaves already-clean wires untouched", () => {
    const d = emptyDocument();
    d.wires.push({ id: "w", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    const before = JSON.stringify(d);
    repairWires(d, ["w"]);
    expect(JSON.stringify(d)).toBe(before);
  });
  it("re-routes a wire that runs over a foreign pin", () => {
    const d = emptyDocument();
    const g: ComponentInstance = { id: "g", type: "and", x: 100, y: 100, rotation: 0, props: {} };
    d.components.push(g);
    const in0 = pinPos(g, "in0"), in1 = pinPos(g, "in1");
    d.wires.push({ id: "w", points: [{ x: in0.x, y: in0.y - 40 }, { x: in0.x, y: in1.y }] as Point[] }); // runs down over in0 to in1
    repairWires(d, ["w"]);
    expect(noWireOverForeignPin(d)).toBe(true);
  });
});

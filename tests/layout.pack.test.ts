import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument, type ComponentInstance, type Point, type SchematicDocument } from "../src/model/types";
import {
  componentBounds,
  documentBounds,
  junctionPoints,
  labelBounds,
  pointOnSegment,
  rectsIntersect,
  SegmentIndex,
  textNoteBounds,
  worldPins,
} from "../src/model/geometry";
import { buildNetlist } from "../src/io/netlist";
import { RouteObstacles } from "../src/editor/safe-route";
import { normalizeWirePoints, pinExitVector, segmentIntersectsRect } from "../src/editor/wire-utils";
import { packSchematic, type PackOptions } from "../src/layout/pack";
import { validatePacking } from "../src/layout/validate";

registerBuiltinComponents();

function pinPos(c: ComponentInstance, pinId: string): Point {
  const wp = worldPins(c).find((p) => p.pin.id === pinId);
  if (!wp) throw new Error(`Pin ${pinId} not found on ${c.id} (${c.type})`);
  return { ...wp.pos };
}

function areaOf(doc: SchematicDocument): number {
  const b = documentBounds(doc);
  return b ? b.w * b.h : 0;
}

function canonicalNets(doc: SchematicDocument): string[] {
  return buildNetlist(doc).nets
    .map((n) => {
      const pins = n.pins.map((p) => `${p.componentId}:${p.pinId}`).sort().join(",");
      const wires = [...n.wires].sort().join(",");
      return `P[${pins}]|W[${wires}]`;
    })
    .sort();
}

function logicalJunctions(doc: SchematicDocument): string[] {
  const idx = new SegmentIndex(doc.wires);
  const pinsAt = new Map<string, string[]>();
  for (const c of doc.components) {
    for (const wp of worldPins(c)) {
      const k = `${wp.pos.x},${wp.pos.y}`;
      const list = pinsAt.get(k) ?? [];
      list.push(`${c.id}:${wp.pin.id}`);
      pinsAt.set(k, list);
    }
  }
  return junctionPoints(doc)
    .map((p) => {
      const ws = [...idx.wiresAt(p)].map((wi) => doc.wires[wi].id).sort().join(",");
      const ps = [...(pinsAt.get(`${p.x},${p.y}`) ?? [])].sort().join(",");
      return `W[${ws}]|P[${ps}]`;
    })
    .sort();
}

/**
 * Independently assert EVERY ONE of the 9 hard packing rules on (before, after),
 * in addition to `validatePacking(before, after, opts) === []`.
 */
function assertAllNineRules(
  before: SchematicDocument,
  after: SchematicDocument,
  opts: PackOptions = {},
): void {
  const grid = before.grid || 10;
  const compGapPx = (opts.componentGap ?? 2) * grid;

  // Validator agrees
  expect(validatePacking(before, after, opts)).toEqual([]);

  // Rule 1: Topology identical via buildNetlist
  expect(canonicalNets(after)).toEqual(canonicalNets(before));

  // Rule 2: Exact same wire point counts + normalizeWirePoints doesn't alter them
  expect(after.wires.length).toBe(before.wires.length);
  for (let i = 0; i < before.wires.length; i++) {
    const wb = before.wires[i];
    const wa = after.wires[i];
    expect(wa.id).toBe(wb.id);
    expect(wa.points.length).toBe(wb.points.length);
    if (JSON.stringify(normalizeWirePoints(wb.points)) === JSON.stringify(wb.points)) {
      expect(normalizeWirePoints(wa.points)).toEqual(wa.points);
    }
  }

  // Rule 3: Segment orientation, direction, turn direction, and length >= 1 grid
  for (let i = 0; i < before.wires.length; i++) {
    const pb = before.wires[i].points;
    const pa = after.wires[i].points;
    for (let s = 0; s + 1 < pb.length; s++) {
      const dx0 = pb[s + 1].x - pb[s].x;
      const dy0 = pb[s + 1].y - pb[s].y;
      const dx1 = pa[s + 1].x - pa[s].x;
      const dy1 = pa[s + 1].y - pa[s].y;
      if (dy0 === 0) {
        expect(dy1).toBe(0);
        expect(Math.sign(dx1)).toBe(Math.sign(dx0));
        expect(Math.abs(dx1)).toBeGreaterThanOrEqual(grid);
      } else {
        expect(dx1).toBe(0);
        expect(Math.sign(dy1)).toBe(Math.sign(dy0));
        expect(Math.abs(dy1)).toBeGreaterThanOrEqual(grid);
      }
    }
  }

  // Rule 4: Wire endpoints stay attached to the same pins / T-junctions
  const beforePinPos = new Map<string, Point>();
  const afterPinPos = new Map<string, Point>();
  for (let i = 0; i < before.components.length; i++) {
    for (const wp of worldPins(before.components[i])) {
      beforePinPos.set(`${before.components[i].id}:${wp.pin.id}`, wp.pos);
    }
    for (const wp of worldPins(after.components[i])) {
      afterPinPos.set(`${after.components[i].id}:${wp.pin.id}`, wp.pos);
    }
  }
  const beforeSegIdx = new SegmentIndex(before.wires);
  const afterSegIdx = new SegmentIndex(after.wires);
  for (let wi = 0; wi < before.wires.length; wi++) {
    const wb = before.wires[wi];
    const wa = after.wires[wi];
    for (const endIdx of [0, wb.points.length - 1]) {
      const epB = wb.points[endIdx];
      const epA = wa.points[endIdx];
      for (const [pk, posB] of beforePinPos) {
        if (posB.x === epB.x && posB.y === epB.y) {
          expect(afterPinPos.get(pk)).toEqual(epA);
        }
      }
      const hostBefore = [...beforeSegIdx.wiresAt(epB)].filter((x) => x !== wi).sort();
      const hostAfter = [...afterSegIdx.wiresAt(epA)].filter((x) => x !== wi).sort();
      expect(hostAfter).toEqual(hostBefore);
    }
  }

  // Rule 5: Components keep type, props, rotation, mirror, size, label; everything on 10-unit grid
  expect(after.components.length).toBe(before.components.length);
  for (let i = 0; i < before.components.length; i++) {
    const cb = before.components[i];
    const ca = after.components[i];
    expect(ca.id).toBe(cb.id);
    expect(ca.type).toBe(cb.type);
    expect(ca.rotation).toBe(cb.rotation);
    expect(Boolean(ca.mirror)).toBe(Boolean(cb.mirror));
    expect(ca.label).toBe(cb.label);
    expect(ca.props).toEqual(cb.props);
    expect(ca.size).toEqual(cb.size);
    expect(Math.abs(ca.x % grid)).toBe(0);
    expect(Math.abs(ca.y % grid)).toBe(0);
  }
  for (const w of after.wires) {
    for (const p of w.points) {
      expect(Math.abs(p.x % grid)).toBe(0);
      expect(Math.abs(p.y % grid)).toBe(0);
    }
  }
  for (const t of after.texts) {
    expect(Math.abs(t.x % grid)).toBe(0);
    expect(Math.abs(t.y % grid)).toBe(0);
  }

  // Rule 6: No overlaps (componentBounds + componentGap, labels, texts)
  const abuttingPairs = new Set<string>();
  for (let i = 0; i < before.components.length; i++) {
    const pinsI = worldPins(before.components[i]);
    for (let j = i + 1; j < before.components.length; j++) {
      const pinsJ = worldPins(before.components[j]);
      if (pinsI.some((a) => pinsJ.some((b) => a.pos.x === b.pos.x && a.pos.y === b.pos.y))) {
        abuttingPairs.add(`${i},${j}`);
      }
    }
  }
  const boundsA = after.components.map((c) => componentBounds(c));
  const labelsA = after.components.map((c) => labelBounds(c));
  const textsA = after.texts.map((t) => textNoteBounds(t));
  for (let i = 0; i < after.components.length; i++) {
    for (let j = i + 1; j < after.components.length; j++) {
      if (opts.ids && !opts.ids.has(after.components[i].id) && !opts.ids.has(after.components[j].id)) continue;
      if (abuttingPairs.has(`${i},${j}`)) continue;
      const a = boundsA[i];
      const b = boundsA[j];
      const sepX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const sepY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      expect(Math.max(sepX, sepY)).toBeGreaterThanOrEqual(compGapPx);
    }
    const lb = labelsA[i];
    if (lb) {
      for (let j = 0; j < after.components.length; j++) {
        expect(rectsIntersect(lb, boundsA[j])).toBe(false);
        if (j > i && labelsA[j]) expect(rectsIntersect(lb, labelsA[j]!)).toBe(false);
      }
      for (const w of after.wires) {
        for (let s = 0; s + 1 < w.points.length; s++) {
          expect(segmentIntersectsRect(w.points[s], w.points[s + 1], lb)).toBe(false);
        }
      }
    }
  }
  for (let i = 0; i < textsA.length; i++) {
    const tb = textsA[i];
    for (let j = 0; j < boundsA.length; j++) {
      expect(rectsIntersect(tb, boundsA[j])).toBe(false);
      if (labelsA[j]) expect(rectsIntersect(tb, labelsA[j]!)).toBe(false);
    }
    for (let j = i + 1; j < textsA.length; j++) {
      expect(rectsIntersect(tb, textsA[j])).toBe(false);
    }
    for (const w of after.wires) {
      for (let s = 0; s + 1 < w.points.length; s++) {
        expect(segmentIntersectsRect(w.points[s], w.points[s + 1], tb)).toBe(false);
      }
    }
  }

  // Rule 7: No accidental connections (routeIsBad) + identical logical junctions
  const obsB = new RouteObstacles(before);
  const obsA = new RouteObstacles(after);
  for (let i = 0; i < before.wires.length; i++) {
    const wb = before.wires[i];
    const wa = after.wires[i];
    if (!obsB.routeIsBad(wb.points, new Set([wb.id]))) {
      expect(obsA.routeIsBad(wa.points, new Set([wa.id]))).toBe(false);
    }
  }
  expect(logicalJunctions(after)).toEqual(logicalJunctions(before));

  // Rule 8: Relative component ordering + pin leg straight exit >= 1 grid
  const boundsB = before.components.map((c) => componentBounds(c));
  for (let i = 0; i < before.components.length; i++) {
    for (let j = i + 1; j < before.components.length; j++) {
      if (boundsB[i].x + boundsB[i].w <= boundsB[j].x) {
        expect(boundsA[i].x + boundsA[i].w).toBeLessThanOrEqual(boundsA[j].x);
      } else if (boundsB[j].x + boundsB[j].w <= boundsB[i].x) {
        expect(boundsA[j].x + boundsA[j].w).toBeLessThanOrEqual(boundsA[i].x);
      }
      if (boundsB[i].y + boundsB[i].h <= boundsB[j].y) {
        expect(boundsA[i].y + boundsA[i].h).toBeLessThanOrEqual(boundsA[j].y);
      } else if (boundsB[j].y + boundsB[j].h <= boundsB[i].y) {
        expect(boundsA[j].y + boundsA[j].h).toBeLessThanOrEqual(boundsA[i].y);
      }
    }
  }
  for (let wi = 0; wi < before.wires.length; wi++) {
    const wb = before.wires[wi];
    const wa = after.wires[wi];
    for (const [endIdx, adjIdx] of [
      [0, 1],
      [wb.points.length - 1, wb.points.length - 2],
    ]) {
      const epB = wb.points[endIdx];
      const apB = wb.points[adjIdx];
      for (const comp of before.components) {
        for (const wp of worldPins(comp)) {
          if (wp.pos.x === epB.x && wp.pos.y === epB.y) {
            const ev = pinExitVector(comp, wp.pin.side);
            if (Math.sign(apB.x - epB.x) === ev.x && Math.sign(apB.y - epB.y) === ev.y) {
              const epA = wa.points[endIdx];
              const apA = wa.points[adjIdx];
              expect(Math.sign(apA.x - epA.x)).toBe(ev.x);
              expect(Math.sign(apA.y - epA.y)).toBe(ev.y);
              expect(Math.abs(apA.x - epA.x) + Math.abs(apA.y - epA.y)).toBeGreaterThanOrEqual(grid);
            }
          }
        }
      }
    }
  }

  // Rule 9: Area never increases
  expect(areaOf(after)).toBeLessThanOrEqual(areaOf(before));
}

// ---------------------------------------------------------------------------
// Fixture builders (all built programmatically with real built-in components)
// ---------------------------------------------------------------------------

/** 1. Spread-out half adder: XOR + AND, 2 input pins, 2 output pins, bends + T-junctions. */
function makeHalfAdderDoc(): SchematicDocument {
  const doc = emptyDocument("Half Adder");
  const inA: ComponentInstance = { id: "inA", type: "input-pin", x: 0, y: 10, rotation: 0, props: { name: "A", width: 1 } };
  const inB: ComponentInstance = { id: "inB", type: "input-pin", x: 0, y: 230, rotation: 0, props: { name: "B", width: 1 } };
  const xorG: ComponentInstance = { id: "xor1", type: "xor", x: 320, y: 10, rotation: 0, props: { inputs: 2 }, label: "U1" };
  const andG: ComponentInstance = { id: "and1", type: "and", x: 320, y: 210, rotation: 0, props: { inputs: 2 }, label: "U2" };
  const outS: ComponentInstance = { id: "outS", type: "output-pin", x: 640, y: 20, rotation: 0, props: { name: "S", width: 1 } };
  const outC: ComponentInstance = { id: "outC", type: "output-pin", x: 640, y: 220, rotation: 0, props: { name: "C", width: 1 } };
  doc.components.push(inA, inB, xorG, andG, outS, outC);

  const aOut = pinPos(inA, "out");     // (50, 20)
  const bOut = pinPos(inB, "out");     // (50, 240)
  const xor0 = pinPos(xorG, "in0");    // (320, 20)
  const xor1 = pinPos(xorG, "in1");    // (320, 40)
  const xorY = pinPos(xorG, "out");    // (410, 30)
  const and0 = pinPos(andG, "in0");    // (320, 220)
  const and1 = pinPos(andG, "in1");    // (320, 240)
  const andY = pinPos(andG, "out");    // (400, 230)
  const sIn = pinPos(outS, "in");      // (640, 30)
  const cIn = pinPos(outC, "in");      // (640, 230)

  // Include bends, two T-junctions, and a plain wire crossing
  doc.wires.push(
    { id: "wA", points: [aOut, xor0] },
    { id: "wA_tap", points: [{ x: 200, y: aOut.y }, { x: 200, y: and0.y }, and0] },
    { id: "wB", points: [bOut, and1] },
    { id: "wB_tap", points: [{ x: 160, y: bOut.y }, { x: 160, y: xor1.y }, xor1] },
    { id: "wS", points: [xorY, sIn] },
    { id: "wC", points: [andY, cIn] },
  );
  return doc;
}

/** 2. Spread-out 4:1 MUX built from gates (2 NOT + 4 3-input AND + 1 4-input OR). */
function makeMux4to1GatesDoc(): SchematicDocument {
  const doc = emptyDocument("4:1 MUX from Gates");
  const d0: ComponentInstance = { id: "d0", type: "input-pin", x: 0, y: 20, rotation: 0, props: { name: "D0" } };
  const d1: ComponentInstance = { id: "d1", type: "input-pin", x: 0, y: 160, rotation: 0, props: { name: "D1" } };
  const d2: ComponentInstance = { id: "d2", type: "input-pin", x: 0, y: 300, rotation: 0, props: { name: "D2" } };
  const d3: ComponentInstance = { id: "d3", type: "input-pin", x: 0, y: 440, rotation: 0, props: { name: "D3" } };
  const s0: ComponentInstance = { id: "s0", type: "input-pin", x: 0, y: 600, rotation: 0, props: { name: "S0" } };
  const s1: ComponentInstance = { id: "s1", type: "input-pin", x: 0, y: 720, rotation: 0, props: { name: "S1" } };

  const not0: ComponentInstance = { id: "not0", type: "not", x: 180, y: 590, rotation: 0, props: {}, label: "N0" };
  const not1: ComponentInstance = { id: "not1", type: "not", x: 180, y: 710, rotation: 0, props: {}, label: "N1" };

  const and0: ComponentInstance = { id: "and0", type: "and", x: 480, y: 20, rotation: 0, props: { inputs: 3 }, label: "A0" };
  const and1: ComponentInstance = { id: "and1", type: "and", x: 480, y: 160, rotation: 0, props: { inputs: 3 }, label: "A1" };
  const and2: ComponentInstance = { id: "and2", type: "and", x: 480, y: 300, rotation: 0, props: { inputs: 3 }, label: "A2" };
  const and3: ComponentInstance = { id: "and3", type: "and", x: 480, y: 440, rotation: 0, props: { inputs: 3 }, label: "A3" };

  const or4: ComponentInstance = { id: "or4", type: "or", x: 800, y: 210, rotation: 0, props: { inputs: 4 }, label: "OR1" };
  const outY: ComponentInstance = { id: "outY", type: "output-pin", x: 1080, y: 240, rotation: 0, props: { name: "Y" } };

  doc.components.push(d0, d1, d2, d3, s0, s1, not0, not1, and0, and1, and2, and3, or4, outY);

  // Direct data wires into AND.in0
  for (const [idx, [din, ag]] of [
    [d0, and0],
    [d1, and1],
    [d2, and2],
    [d3, and3],
  ].entries()) {
    doc.wires.push({ id: `w_d${idx}`, points: [pinPos(din, "out"), pinPos(ag, "in0")] });
  }

  // Select lines S0 -> not0, S1 -> not1
  const s0Out = pinPos(s0, "out");
  const s1Out = pinPos(s1, "out");
  const n0In = pinPos(not0, "in0");
  const n1In = pinPos(not1, "in0");
  const n0Out = pinPos(not0, "out");
  const n1Out = pinPos(not1, "out");
  doc.wires.push(
    { id: "w_s0", points: [s0Out, n0In] },
    { id: "w_s1", points: [s1Out, n1In] },
  );

  // 4 vertical select rails: S0 (x=120), S1 (x=150), !S0 (x=340), !S1 (x=380)
  // S0 feeds and1.in1 and and3.in1 (T-junction on w_s0 + T-junction on vertical rail)
  const a1in1 = pinPos(and1, "in1");
  const a3in1 = pinPos(and3, "in1");
  doc.wires.push(
    { id: "w_s0_rail", points: [{ x: 120, y: s0Out.y }, { x: 120, y: a1in1.y }, a1in1] },
    { id: "w_s0_a3", points: [{ x: 120, y: a3in1.y }, a3in1] },
  );

  // S1 feeds and2.in2 and and3.in2
  const a2in2 = pinPos(and2, "in2");
  const a3in2 = pinPos(and3, "in2");
  doc.wires.push(
    { id: "w_s1_rail", points: [{ x: 150, y: s1Out.y }, { x: 150, y: a2in2.y }, a2in2] },
    { id: "w_s1_a3", points: [{ x: 150, y: a3in2.y }, a3in2] },
  );

  // !S0 feeds and0.in1 and and2.in1
  const a0in1 = pinPos(and0, "in1");
  const a2in1 = pinPos(and2, "in1");
  doc.wires.push(
    { id: "w_ns0_rail", points: [n0Out, { x: 340, y: n0Out.y }, { x: 340, y: a0in1.y }, a0in1] },
    { id: "w_ns0_a2", points: [{ x: 340, y: a2in1.y }, a2in1] },
  );

  // !S1 feeds and0.in2 and and1.in2
  const a0in2 = pinPos(and0, "in2");
  const a1in2 = pinPos(and1, "in2");
  doc.wires.push(
    { id: "w_ns1_rail", points: [n1Out, { x: 380, y: n1Out.y }, { x: 380, y: a0in2.y }, a0in2] },
    { id: "w_ns1_a1", points: [{ x: 380, y: a1in2.y }, a1in2] },
  );

  // AND outputs -> 4-input OR gate inputs (staggered vertical channels)
  const andGates = [and0, and1, and2, and3];
  const channels = [660, 680, 680, 660];
  for (let i = 0; i < 4; i++) {
    const from = pinPos(andGates[i], "out");
    const to = pinPos(or4, `in${i}`);
    const ch = channels[i];
    doc.wires.push({
      id: `w_and_or_${i}`,
      points: [from, { x: ch, y: from.y }, { x: ch, y: to.y }, to],
    });
  }

  doc.wires.push({ id: "w_out", points: [pinPos(or4, "out"), pinPos(outY, "in")] });
  return doc;
}

/** 3. Register + Adder accumulator feedback loop (wire going backwards with several bends). */
function makeRegisterAdderFeedbackDoc(): SchematicDocument {
  const doc = emptyDocument("Accumulator Feedback Loop");
  const clk: ComponentInstance = { id: "clk", type: "clock", x: 100, y: 280, rotation: 0, props: {} };
  const inInc: ComponentInstance = { id: "inc", type: "input-pin", x: 100, y: 360, rotation: 0, props: { name: "INC", width: 8 } };
  const reg: ComponentInstance = {
    id: "reg1",
    type: "register",
    x: 260,
    y: 160,
    rotation: 0,
    props: { width: 8, pinMode: "bus", enable: false, reset: false },
    label: "REG1",
  };
  const add: ComponentInstance = {
    id: "add1",
    type: "adder",
    x: 620,
    y: 160,
    rotation: 0,
    props: { width: 8, pinMode: "bus", carryIn: false, carryOut: false },
    label: "ADD1",
  };
  const outQ: ComponentInstance = { id: "outQ", type: "output-pin", x: 960, y: 180, rotation: 0, props: { name: "SUM", width: 8 } };
  doc.components.push(clk, inInc, reg, add, outQ);

  const regD = pinPos(reg, "d");
  const regClk = pinPos(reg, "clk");
  const regQ = pinPos(reg, "q");
  const addA = pinPos(add, "a");
  const addB = pinPos(add, "b");
  const addS = pinPos(add, "s");
  const clkOut = pinPos(clk, "clk");
  const incOut = pinPos(inInc, "out");
  const outIn = pinPos(outQ, "in");

  // Forward wire: reg.Q -> add.A (horizontal or Z-route)
  const wFwdPts: Point[] =
    regQ.y === addA.y
      ? [regQ, addA]
      : [regQ, { x: 480, y: regQ.y }, { x: 480, y: addA.y }, addA];

  // Clock -> reg.clk
  const wClkPts: Point[] = [clkOut, { x: 200, y: clkOut.y }, { x: 200, y: regClk.y }, regClk];

  // INC -> add.B
  const wIncPts: Point[] = [incOut, { x: 520, y: incOut.y }, { x: 520, y: addB.y }, addB];

  // Output wire: add.S -> outQ.in
  const wOutPts: Point[] =
    addS.y === outIn.y
      ? [addS, outIn]
      : [addS, { x: 860, y: addS.y }, { x: 860, y: outIn.y }, outIn];

  // Backward feedback loop: T-junction from wOut at x=820, up over both components to y=40,
  // left to x=160, down to regD.y, and right into reg.D!
  const fbTapX = 820;
  const wFbPts: Point[] = [
    { x: fbTapX, y: addS.y },
    { x: fbTapX, y: 40 },
    { x: 160, y: 40 },
    { x: 160, y: regD.y },
    regD,
  ];

  doc.wires.push(
    { id: "w_fwd", points: wFwdPts, width: 8 },
    { id: "w_clk", points: wClkPts },
    { id: "w_inc", points: wIncPts, width: 8 },
    { id: "w_out", points: wOutPts, width: 8 },
    { id: "w_fb", points: wFbPts, width: 8 },
  );
  return doc;
}

/** 4. Schematic with text notes (single & multi-line) and labels (above, below, corner). */
function makeNotesAndLabelsDoc(): SchematicDocument {
  const doc = emptyDocument("Notes and Labels");
  const inA: ComponentInstance = { id: "inA", type: "input-pin", x: 0, y: 120, rotation: 0, props: { name: "A" }, label: "INPUT_A" };
  const inB: ComponentInstance = { id: "inB", type: "input-pin", x: 0, y: 240, rotation: 0, props: { name: "B" }, label: "INPUT_B" };
  // full-adder has pins on top AND bottom -> "corner" label placement!
  const fa: ComponentInstance = { id: "fa1", type: "full-adder", x: 300, y: 120, rotation: 0, props: {}, label: "FA_UNIT" };
  // ground has pin on top only -> "below" label placement! Offset X so w_gnd has a real Z-bend.
  const gnd: ComponentInstance = { id: "gnd1", type: "ground", x: 400, y: 380, rotation: 0, props: {}, label: "VSS" };
  // output-pin has pin on left only -> "above" label placement; offset Y so w_s has a real Z-bend.
  const outS: ComponentInstance = { id: "outS", type: "output-pin", x: 640, y: 120, rotation: 0, props: { name: "SUM" }, label: "SUM_OUT" };
  doc.components.push(inA, inB, fa, gnd, outS);

  const aOut = pinPos(inA, "out");
  const bOut = pinPos(inB, "out");
  const faA = pinPos(fa, "a");
  const faB = pinPos(fa, "b");
  const faS = pinPos(fa, "s");
  const faCout = pinPos(fa, "cout");
  const gndPin = pinPos(gnd, "gnd");
  const sIn = pinPos(outS, "in");

  doc.wires.push(
    { id: "w_a", points: [aOut, { x: 180, y: aOut.y }, { x: 180, y: faA.y }, faA] },
    { id: "w_b", points: [bOut, { x: 220, y: bOut.y }, { x: 220, y: faB.y }, faB] },
    { id: "w_s", points: [faS, { x: 540, y: faS.y }, { x: 540, y: sIn.y }, sIn] },
    { id: "w_gnd", points: [faCout, { x: faCout.x, y: 320 }, { x: gndPin.x, y: 320 }, gndPin] },
  );

  doc.texts.push(
    { id: "t1", x: 40, y: 30, text: "1-Bit Full Adder Stage", fontSize: 16 },
    { id: "t2", x: 580, y: 360, text: "Notes:\nCin left open\nCout tied to GND", fontSize: 12 },
  );
  return doc;
}

/** 5. Rotated (90/180/270), mirrored, and resized parametric components. */
function makeTransformedComponentsDoc(): SchematicDocument {
  const doc = emptyDocument("Transformed Components");
  // Resized 3-input AND gate
  const andResized: ComponentInstance = {
    id: "and_big",
    type: "and",
    x: 40,
    y: 40,
    rotation: 0,
    props: { inputs: 3 },
    size: { w: 120, h: 100 },
    label: "BIG_AND",
  };
  // Mirrored NOT gate (input on right, output on left)
  const notMirrored: ComponentInstance = {
    id: "not_mir",
    type: "not",
    x: 440,
    y: 40,
    rotation: 0,
    mirror: true,
    props: {},
    label: "INV_M",
  };
  // 90-deg rotated OR gate (inputs on top, output on bottom)
  const orRot90: ComponentInstance = {
    id: "or_90",
    type: "or",
    x: 340,
    y: 360,
    rotation: 90,
    props: { inputs: 2 },
    label: "OR_90",
  };
  // 180-deg rotated resized MUX (selectBits: 2 -> 4 data pins + 2 select pins)
  const mux180: ComponentInstance = {
    id: "mux_180",
    type: "mux",
    x: 820,
    y: 440,
    rotation: 180,
    props: { selectBits: 2, dataWidth: 1, selectMode: "bits" },
    size: { w: 140, h: 140 },
    label: "MUX4",
  };

  doc.components.push(andResized, notMirrored, orRot90, mux180);

  // Connect and_big.out -> or_90.in0 (exits right from and_big, enters top of or_90)
  const pAndOut = pinPos(andResized, "out");
  const pOrIn0 = pinPos(orRot90, "in0");
  doc.wires.push({
    id: "w_and_or",
    points: [pAndOut, { x: pOrIn0.x, y: pAndOut.y }, pOrIn0],
  });

  // Connect not_mir.out (on its LEFT side since mirrored!) -> or_90.in1 (on top)
  const pNotOut = pinPos(notMirrored, "out");
  const pOrIn1 = pinPos(orRot90, "in1");
  doc.wires.push({
    id: "w_not_or",
    points: [pNotOut, { x: pOrIn1.x, y: pNotOut.y }, pOrIn1],
  });

  // Connect or_90.out (bottom) -> mux_180.d0 (right side since rotated 180!)
  const pOrOut = pinPos(orRot90, "out");
  const pMuxD0 = pinPos(mux180, "d0");
  doc.wires.push({
    id: "w_or_mux",
    points: [
      pOrOut,
      { x: pOrOut.x, y: 520 },
      { x: pMuxD0.x + 40, y: 520 },
      { x: pMuxD0.x + 40, y: pMuxD0.y },
      pMuxD0,
    ],
  });

  // Connect not_mir.in0 (right side) -> mux_180.y (left side since rotated 180!)
  const pNotIn = pinPos(notMirrored, "in0");
  const pMuxY = pinPos(mux180, "y");
  doc.wires.push({
    id: "w_mux_not",
    points: [pMuxY, { x: pMuxY.x - 40, y: pMuxY.y }, { x: pMuxY.x - 40, y: pNotIn.y }, pNotIn],
  });

  return doc;
}

/** 6. Already-tight fixture (exact componentGap=20, straight wire, zero slack). */
function makeAlreadyTightDoc(): SchematicDocument {
  const doc = emptyDocument("Already Tight");
  // and gate width = 80, height = 60, out at (80, 30)
  const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 10, rotation: 0, props: { inputs: 2 } };
  // not gate at x = 100 (exact 20px = 2 grid gap!), in0 at (100, 30)
  const g2: ComponentInstance = { id: "g2", type: "not", x: 100, y: 10, rotation: 0, props: {} };
  doc.components.push(g1, g2);
  doc.wires.push({ id: "w1", points: [pinPos(g1, "out"), pinPos(g2, "in0")] });
  return doc;
}

/** 7. Performance fixture: 200 components / 400 wires in a spread-out 10x20 grid. */
function makeLargePerfDoc(): SchematicDocument {
  const doc = emptyDocument("Large 200-Component Pipeline");
  const cols = 10;
  const rows = 20;
  const colStep = 240; // lots of wasted horizontal space (gate width = 80)
  const rowStep = 160; // lots of wasted vertical space (gate height = 60)

  const gridComps: ComponentInstance[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowArr: ComponentInstance[] = [];
    for (let c = 0; c < cols; c++) {
      const comp: ComponentInstance = {
        id: `g_${r}_${c}`,
        type: (r + c) % 2 === 0 ? "and" : "or",
        x: c * colStep,
        y: r * rowStep,
        rotation: 0,
        props: { inputs: 2 },
        label: `U${r * cols + c + 1}`,
      };
      doc.components.push(comp);
      rowArr.push(comp);
    }
    gridComps.push(rowArr);
  }

  // Create 400 wires:
  // - 180 primary bent wires connecting (r, c).out -> (r, c+1).in0 (9 * 20 = 180)
  // - 180 T-junction fanout wires tapping (r, c).out -> (r, c+1).in1 (180)
  // - 40 input/output tail wires on columns 0 and 9 (20 + 20 = 40)
  // Total = 400 wires!
  let wNum = 0;
  for (let r = 0; r < rows; r++) {
    const firstIn = pinPos(gridComps[r][0], "in0");
    doc.wires.push({
      id: `w_in_${wNum++}`,
      points: [{ x: firstIn.x - 60, y: firstIn.y }, firstIn],
    });

    for (let c = 0; c < cols - 1; c++) {
      const outP = pinPos(gridComps[r][c], "out");
      const in0 = pinPos(gridComps[r][c + 1], "in0");
      const in1 = pinPos(gridComps[r][c + 1], "in1");
      const midX = outP.x + 80;
      const tapX = outP.x + 40;
      doc.wires.push({
        id: `w_main_${wNum++}`,
        points: [outP, { x: midX, y: outP.y }, { x: midX, y: in0.y }, in0],
      });
      doc.wires.push({
        id: `w_tap_${wNum++}`,
        points: [{ x: tapX, y: outP.y }, { x: tapX, y: in1.y }, in1],
      });
    }

    const lastOut = pinPos(gridComps[r][cols - 1], "out");
    doc.wires.push({
      id: `w_out_${wNum++}`,
      points: [lastOut, { x: lastOut.x + 60, y: lastOut.y }],
    });
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("layout/packSchematic", () => {
  const spreadFixtures: { name: string; build: () => SchematicDocument; maxRatio: number }[] = [
    { name: "spread-out half adder (bends + T-junctions + crossing)", build: makeHalfAdderDoc, maxRatio: 0.45 },
    { name: "4:1 MUX built from gates", build: makeMux4to1GatesDoc, maxRatio: 0.55 },
    { name: "register + adder feedback loop", build: makeRegisterAdderFeedbackDoc, maxRatio: 0.55 },
    { name: "schematic with text notes and labels", build: makeNotesAndLabelsDoc, maxRatio: 0.65 },
    { name: "rotated / mirrored / resized components", build: makeTransformedComponentsDoc, maxRatio: 0.7 },
  ];

  for (const fx of spreadFixtures) {
    it(`packs ${fx.name} tightly while enforcing all 9 rules`, () => {
      const input = fx.build();
      const snapshot = JSON.stringify(input);

      const res = packSchematic(input, { realign: false }); // the 9 shape-preserving rules (realign has its own tests)

      // Input must never be mutated
      expect(JSON.stringify(input)).toBe(snapshot);

      // Area strictly decreases significantly and quality improves
      expect(res.areaBefore).toBe(areaOf(input));
      expect(res.areaAfter).toBeCloseTo(areaOf(res.doc), 6);
      expect(res.areaAfter).toBeLessThan(res.areaBefore * fx.maxRatio);
      expect(res.qualityAfter.total).toBeLessThanOrEqual(res.qualityBefore.total);
      expect(res.qualityAfter.total).toBeLessThan(res.qualityBefore.total);
      expect(res.passes).toBeGreaterThan(0);

      // All 9 rules individually asserted + validatePacking === []
      assertAllNineRules(input, res.doc);

      // Idempotence: packing twice gives same or smaller area/quality and remains valid
      const res2 = packSchematic(res.doc, { realign: false });
      expect(res2.areaAfter).toBeLessThanOrEqual(res.areaAfter);
      expect(res2.qualityAfter.total).toBeLessThanOrEqual(res.qualityAfter.total);
      assertAllNineRules(res.doc, res2.doc);
      assertAllNineRules(input, res2.doc);
    });
  }

  it("returns unchanged deep copy on an already-tight schematic (areaAfter === areaBefore)", () => {
    const input = makeAlreadyTightDoc();
    const snapshot = JSON.stringify(input);

    const res = packSchematic(input, { realign: false });

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(res.areaAfter).toBe(res.areaBefore);
    expect(res.passes).toBe(0);
    expect(res.doc).toEqual(input);
    expect(res.doc).not.toBe(input);
    assertAllNineRules(input, res.doc);
  });

  it("supports partial packing via opts.ids while treating other elements as fixed obstacles", () => {
    const doc = emptyDocument("Partial Pack");
    const fixedLeft: ComponentInstance = { id: "f1", type: "input-pin", x: 0, y: 10, rotation: 0, props: { name: "A" } };
    const movGate: ComponentInstance = { id: "m1", type: "and", x: 300, y: 10, rotation: 0, props: { inputs: 2 }, label: "U1" };
    const movOut: ComponentInstance = { id: "m2", type: "output-pin", x: 620, y: 20, rotation: 0, props: { name: "Y" } };
    const fixedBelow: ComponentInstance = { id: "f2", type: "not", x: 160, y: 200, rotation: 0, props: {}, label: "FIX" };
    doc.components.push(fixedLeft, movGate, movOut, fixedBelow);

    doc.wires.push(
      { id: "wm1", points: [pinPos(fixedLeft, "out"), pinPos(movGate, "in0")] },
      { id: "wm2", points: [pinPos(movGate, "out"), pinPos(movOut, "in")] },
    );

    const ids = new Set(["m1", "m2", "wm1", "wm2"]);
    const res = packSchematic(doc, { ids });

    expect(res.areaAfter).toBeLessThan(res.areaBefore);
    expect(validatePacking(doc, res.doc, { ids })).toEqual([]);
    assertAllNineRules(doc, res.doc, { ids });

    // Fixed components must not have moved at all
    const f1After = res.doc.components.find((c) => c.id === "f1")!;
    const f2After = res.doc.components.find((c) => c.id === "f2")!;
    expect({ x: f1After.x, y: f1After.y }).toEqual({ x: fixedLeft.x, y: fixedLeft.y });
    expect({ x: f2After.x, y: f2After.y }).toEqual({ x: fixedBelow.x, y: fixedBelow.y });
  });

  it("handles negative coordinates, empty documents, and custom componentGap/wireGap options", () => {
    const empty = emptyDocument("Empty");
    const emptyRes = packSchematic(empty);
    expect(emptyRes.areaBefore).toBe(0);
    expect(emptyRes.areaAfter).toBe(0);
    expect(emptyRes.passes).toBe(0);
    expect(validatePacking(empty, emptyRes.doc)).toEqual([]);

    // Shift half adder into negative coordinates and pack with larger gaps
    const neg = makeHalfAdderDoc();
    for (const c of neg.components) {
      c.x -= 800;
      c.y -= 500;
    }
    for (const w of neg.wires) {
      for (const p of w.points) {
        p.x -= 800;
        p.y -= 500;
      }
    }
    const opts: PackOptions = { componentGap: 3, wireGap: 2 };
    const negRes = packSchematic(neg, opts);
    expect(negRes.areaAfter).toBeLessThan(negRes.areaBefore);
    assertAllNineRules(neg, negRes.doc, opts);
  });

  it("packs 200 components / 400 wires in under 2 seconds with zero rule violations", () => {
    const doc = makeLargePerfDoc();
    expect(doc.components.length).toBe(200);
    expect(doc.wires.length).toBe(400);

    const t0 = performance.now();
    const res = packSchematic(doc, { timeBudgetMs: 1500, beamWidth: 0, realign: false }); // core pipeline speed (the UI runs the beam in a worker)
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(2000);
    expect(res.areaAfter).toBeLessThan(res.areaBefore * 0.45);
    expect(validatePacking(doc, res.doc)).toEqual([]);
    // Verify netlist preserved on all 200 components / 400 wires
    expect(canonicalNets(res.doc)).toEqual(canonicalNets(doc));
  });

  it("preserves direct pin-to-pin abutment while packing surrounding circuitry", () => {
    const doc = emptyDocument("Pin Abutment");
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 10, rotation: 0, props: { inputs: 2 }, label: "U1" };
    const g1Out = pinPos(g1, "out"); // (80, 30)
    // Abut g2.in0 directly onto g1.out (not.in0 is at local (0, 20))
    const g2: ComponentInstance = { id: "g2", type: "not", x: g1Out.x, y: g1Out.y - 20, rotation: 0, props: {}, label: "U2" };
    const g3: ComponentInstance = { id: "g3", type: "or", x: 480, y: 170, rotation: 0, props: { inputs: 2 }, label: "U3" };
    doc.components.push(g1, g2, g3);

    const g2Out = pinPos(g2, "out");
    const g3In0 = pinPos(g3, "in0");
    doc.wires.push({ id: "w1", points: [g2Out, { x: 320, y: g2Out.y }, { x: 320, y: g3In0.y }, g3In0] });

    const res = packSchematic(doc);
    expect(res.areaAfter).toBeLessThan(res.areaBefore);
    assertAllNineRules(doc, res.doc);
    // g1.out and g2.in0 must remain directly abutting
    const g1After = res.doc.components.find((c) => c.id === "g1")!;
    const g2After = res.doc.components.find((c) => c.id === "g2")!;
    expect(pinPos(g1After, "out")).toEqual(pinPos(g2After, "in0"));
  });

  it("preserves 4-way explicit crossing junctions and multiple T-junctions on one bus", () => {
    // 4-way junction
    const doc4 = emptyDocument("4-Way Junction");
    const inA: ComponentInstance = { id: "inA", type: "input-pin", x: 0, y: 90, rotation: 0, props: { name: "A" } };
    const outY: ComponentInstance = { id: "outY", type: "output-pin", x: 480, y: 90, rotation: 0, props: { name: "Y" } };
    const vcc: ComponentInstance = { id: "vcc", type: "vcc", x: 180, y: 0, rotation: 0, props: { label: "VDD" } };
    const gnd: ComponentInstance = { id: "gnd", type: "ground", x: 190, y: 260, rotation: 0, props: {} };
    doc4.components.push(inA, outY, vcc, gnd);
    doc4.wires.push(
      { id: "wH", points: [pinPos(inA, "out"), { x: 200, y: 100 }, pinPos(outY, "in")] },
      { id: "wV", points: [pinPos(vcc, "vcc"), { x: 200, y: 100 }, pinPos(gnd, "gnd")] },
    );

    const res4 = packSchematic(doc4);
    expect(res4.areaAfter).toBeLessThan(res4.areaBefore);
    assertAllNineRules(doc4, res4.doc);
    expect(junctionPoints(res4.doc)).toHaveLength(1);

    // Multi-T-junction clock distribution bus
    const docBus = emptyDocument("Clock Bus");
    const clk: ComponentInstance = { id: "clk", type: "clock", x: 0, y: 0, rotation: 0, props: {} };
    const r0: ComponentInstance = { id: "r0", type: "register", x: 180, y: 160, rotation: 0, props: { width: 4, enable: false, reset: false }, label: "R0" };
    const r1: ComponentInstance = { id: "r1", type: "register", x: 460, y: 160, rotation: 0, props: { width: 4, enable: false, reset: false }, label: "R1" };
    const r2: ComponentInstance = { id: "r2", type: "register", x: 740, y: 160, rotation: 0, props: { width: 4, enable: false, reset: false }, label: "R2" };
    docBus.components.push(clk, r0, r1, r2);
    const clkP = pinPos(clk, "clk");
    const c0 = pinPos(r0, "clk");
    const c1 = pinPos(r1, "clk");
    const c2 = pinPos(r2, "clk");
    docBus.wires.push(
      { id: "w_bus", points: [clkP, { x: 700, y: clkP.y }, { x: 700, y: c2.y }, c2] },
      { id: "w_tap0", points: [{ x: 140, y: clkP.y }, { x: 140, y: c0.y }, c0] },
      { id: "w_tap1", points: [{ x: 420, y: clkP.y }, { x: 420, y: c1.y }, c1] },
    );

    const resBus = packSchematic(docBus);
    expect(resBus.areaAfter).toBeLessThan(resBus.areaBefore);
    assertAllNineRules(docBus, resBus.doc);
    expect(junctionPoints(resBus.doc)).toHaveLength(2);
  });

  it("packs movable items on BOTH sides of a fixed obstacle (opts.ids with negative-cycle bracket)", () => {
    const doc = emptyDocument("Bracketed Partial Pack");
    const mLeft: ComponentInstance = { id: "mL", type: "input-pin", x: 0, y: 20, rotation: 0, props: { name: "L" } };
    const fMid: ComponentInstance = { id: "fM", type: "and", x: 300, y: 10, rotation: 0, props: { inputs: 2 }, label: "FIX" };
    const mRight: ComponentInstance = { id: "mR", type: "output-pin", x: 640, y: 20, rotation: 0, props: { name: "R" } };
    doc.components.push(mLeft, fMid, mRight);
    doc.wires.push(
      { id: "wL", points: [pinPos(mLeft, "out"), { x: 160, y: 30 }, { x: 160, y: 20 }, pinPos(fMid, "in0")] },
      { id: "wR", points: [pinPos(fMid, "out"), pinPos(mRight, "in")] },
    );

    const ids = new Set(["mL", "mR", "wL", "wR"]);
    const res = packSchematic(doc, { ids, realign: false });
    expect(res.areaAfter).toBeLessThan(res.areaBefore);
    assertAllNineRules(doc, res.doc, { ids });
    const fAfter = res.doc.components.find((c) => c.id === "fM")!;
    expect({ x: fAfter.x, y: fAfter.y }).toEqual({ x: 300, y: 10 }); // fixed obstacle never moves
    // Both left and right movable components pulled inward toward fMid
    expect(res.doc.components.find((c) => c.id === "mL")!.x).toBeGreaterThan(0);
    expect(res.doc.components.find((c) => c.id === "mR")!.x).toBeLessThan(640);
  });

  it("handles parametric high-pin-count components (6-input gate with 1-grid pin pitch under wireGap=2)", () => {
    const doc = emptyDocument("Parametric 6-Input Gate");
    const gate: ComponentInstance = { id: "g6", type: "and", x: 300, y: 40, rotation: 0, props: { inputs: 6 }, label: "AND6" };
    const out: ComponentInstance = { id: "out", type: "output-pin", x: 600, y: 70, rotation: 0, props: { name: "Y" } };
    doc.components.push(gate, out);

    // Wire all 6 adjacent pins (10px spacing!) from staggered vertical taps
    const pins = worldPins(gate).filter((p) => p.pin.dir === "in");
    expect(pins).toHaveLength(6);
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i].pos;
      doc.wires.push({ id: `wi_${i}`, points: [{ x: 40, y: p.y }, p] });
    }
    doc.wires.push({ id: "wo", points: [pinPos(gate, "out"), pinPos(out, "in")] });

    const opts: PackOptions = { componentGap: 2, wireGap: 2 };
    const res = packSchematic(doc, opts);
    expect(res.areaAfter).toBeLessThan(res.areaBefore);
    expect(res.qualityAfter.total).toBeLessThanOrEqual(res.qualityBefore.total);
    assertAllNineRules(doc, res.doc, opts);
  });

  it("aligns scattered same-type gates at slightly different heights into a row with equal spacing", () => {
    // 4 identical 2-input AND gates staggered vertically (overlapping Y ranges so Rule 8a allows
    // row alignment) and spaced unevenly horizontally, tapped cleanly off a shared top bus.
    const doc = emptyDocument("Scattered Same-Type Row");
    const inBus: ComponentInstance = { id: "inBus", type: "input-pin", x: 0, y: 10, rotation: 0, props: { name: "EN" } };
    const g0: ComponentInstance = { id: "g0", type: "and", x: 100, y: 80, rotation: 0, props: { inputs: 2 }, label: "A0" };
    const g1: ComponentInstance = { id: "g1", type: "and", x: 240, y: 100, rotation: 0, props: { inputs: 2 }, label: "A1" };
    const g2: ComponentInstance = { id: "g2", type: "and", x: 460, y: 90, rotation: 0, props: { inputs: 2 }, label: "A2" };
    const g3: ComponentInstance = { id: "g3", type: "and", x: 600, y: 110, rotation: 0, props: { inputs: 2 }, label: "A3" };
    doc.components.push(inBus, g0, g1, g2, g3);

    const busStart = pinPos(inBus, "out");
    const gates = [g0, g1, g2, g3];
    const lastTapX = pinPos(g3, "in0").x - 20;
    doc.wires.push({ id: "w_bus", points: [busStart, { x: lastTapX, y: busStart.y }, { x: lastTapX, y: pinPos(g3, "in0").y }, pinPos(g3, "in0")] });
    for (let i = 0; i < 3; i++) {
      const in0 = pinPos(gates[i], "in0");
      const tapX = in0.x - 20;
      doc.wires.push({
        id: `w_tap_${i}`,
        points: [{ x: tapX, y: busStart.y }, { x: tapX, y: in0.y }, in0],
      });
    }

    const res = packSchematic(doc);
    assertAllNineRules(doc, res.doc);
    expect(res.qualityAfter.total).toBeLessThan(res.qualityBefore.total);
    expect(res.qualityAfter.alignment).toBeLessThan(res.qualityBefore.alignment);

    // All 4 AND gates must end up row-aligned (identical top y) with equal consecutive horizontal gaps
    const packedGates = ["g0", "g1", "g2", "g3"]
      .map((id) => componentBounds(res.doc.components.find((c) => c.id === id)!))
      .sort((a, b) => a.x - b.x);
    expect(new Set(packedGates.map((b) => b.y)).size).toBe(1);
    const gaps = [
      packedGates[1].x - (packedGates[0].x + packedGates[0].w),
      packedGates[2].x - (packedGates[1].x + packedGates[1].w),
      packedGates[3].x - (packedGates[2].x + packedGates[2].w),
    ];
    expect(gaps[0]).toBe(gaps[1]);
    expect(gaps[1]).toBe(gaps[2]);
  });

  it("equalises non-minimal gaps for 3 same-type gates when outer span is held wide by fixed anchors", () => {
    // 3 identical 2-input AND gates staggered in Y and unevenly spaced in X, with fixed ground
    // anchors holding the outer horizontal span wide so the middle gate must center itself for
    // equal non-minimal gaps while all three snap into one horizontal row.
    const doc = emptyDocument("Anchored Row Equalization");
    const g0: ComponentInstance = { id: "g0", type: "and", x: 0, y: 60, rotation: 0, props: { inputs: 2 } };
    const g1: ComponentInstance = { id: "g1", type: "and", x: 120, y: 80, rotation: 0, props: { inputs: 2 } };
    const g2: ComponentInstance = { id: "g2", type: "and", x: 360, y: 70, rotation: 0, props: { inputs: 2 } };
    const botL: ComponentInstance = { id: "botL", type: "ground", x: 20, y: 200, rotation: 0, props: {} };
    const botR: ComponentInstance = { id: "botR", type: "ground", x: 400, y: 200, rotation: 0, props: {} };
    doc.components.push(g0, g1, g2, botL, botR);

    const g0In = pinPos(g0, "in0");
    const g2Out = pinPos(g2, "out");
    const bLPin = pinPos(botL, "gnd");
    const bRPin = pinPos(botR, "gnd");
    doc.wires.push(
      { id: "wL", points: [g0In, { x: g0In.x - 20, y: g0In.y }, { x: g0In.x - 20, y: bLPin.y - 30 }, { x: bLPin.x, y: bLPin.y - 30 }, bLPin] },
      { id: "wR", points: [g2Out, { x: g2Out.x + 20, y: g2Out.y }, { x: g2Out.x + 20, y: bRPin.y - 30 }, { x: bRPin.x, y: bRPin.y - 30 }, bRPin] },
    );

    const ids = new Set(["g0", "g1", "g2", "wL", "wR"]);
    const res = packSchematic(doc, { ids });
    assertAllNineRules(doc, res.doc, { ids });
    expect(res.qualityAfter.total).toBeLessThan(res.qualityBefore.total);

    const b0 = componentBounds(res.doc.components.find((c) => c.id === "g0")!);
    const b1 = componentBounds(res.doc.components.find((c) => c.id === "g1")!);
    const b2 = componentBounds(res.doc.components.find((c) => c.id === "g2")!);
    expect(b0.y).toBe(b1.y);
    expect(b1.y).toBe(b2.y);
    const gap01 = b1.x - (b0.x + b0.w);
    const gap12 = b2.x - (b1.x + b1.w);
    expect(gap01).toBe(gap12);
    // The anchor wires are movable, so the packer may legitimately pull the row to the tightest
    // EQUAL spacing (the minimum component gap) — equal and compact beats equal and wide.
    expect(gap01).toBeGreaterThanOrEqual(20);
  });

  it("reduces clutter on a fixture with a dense crossing cluster while preserving all 9 rules", () => {
    // 4 input pins on the left wired in reversed order to 4 AND gates on the right, with all 4
    // vertical routing lanes bunched 1 grid cell apart (x = 120, 130, 140, 150) forming a dense
    // crossing cluster.
    const doc = emptyDocument("Dense Crossing Cluster");
    const ins: ComponentInstance[] = [];
    const gates: ComponentInstance[] = [];
    for (let i = 0; i < 4; i++) {
      ins.push({ id: `in${i}`, type: "input-pin", x: 0, y: 20 + i * 80, rotation: 0, props: { name: `I${i}` } });
      gates.push({ id: `g${i}`, type: "and", x: 380, y: 10 + i * 80, rotation: 0, props: { inputs: 2 }, label: `U${i}` });
    }
    doc.components.push(...ins, ...gates);

    // Reverse routing: in0 -> g3, in1 -> g2, in2 -> g1, in3 -> g0 via tightly bunched lanes
    const lanes = [120, 130, 140, 150];
    for (let i = 0; i < 4; i++) {
      const from = pinPos(ins[i], "out");
      const to = pinPos(gates[3 - i], "in0");
      const laneX = lanes[i];
      doc.wires.push({
        id: `w_cross_${i}`,
        points: [from, { x: laneX, y: from.y }, { x: laneX, y: to.y }, to],
      });
    }

    const res = packSchematic(doc);
    assertAllNineRules(doc, res.doc);
    expect(res.qualityBefore.clutter).toBeGreaterThan(0);
    expect(res.qualityAfter.clutter).toBeLessThan(res.qualityBefore.clutter);
    expect(res.qualityAfter.total).toBeLessThan(res.qualityBefore.total);
  });
});

describe("layout/validatePacking catches deliberate rule violations", () => {
  it("flags Rule 1/4/7 when a wire detaches from a pin", () => {
    const before = makeAlreadyTightDoc();
    const after = structuredClone(before);
    after.wires[0].points[0].x += 10;
    const errs = validatePacking(before, after);
    expect(errs.some((e) => e.startsWith("Rule 1:"))).toBe(true);
    expect(errs.some((e) => e.startsWith("Rule 4:"))).toBe(true);
  });

  it("flags Rule 2 when a waypoint is added or collinearity introduced", () => {
    const before = makeAlreadyTightDoc();
    const after = structuredClone(before);
    after.wires[0].points.splice(1, 0, { x: 90, y: 30 });
    const errs = validatePacking(before, after);
    expect(errs.some((e) => e.startsWith("Rule 2:"))).toBe(true);
  });

  it("flags Rule 3 when a wire segment reverses direction or turns diagonal", () => {
    const before = makeHalfAdderDoc();
    const after = structuredClone(before);
    after.wires[0].points[1].y += 10;
    const errs = validatePacking(before, after);
    expect(errs.some((e) => e.startsWith("Rule 3:"))).toBe(true);
  });

  it("flags Rule 5 when component props/rotation change, coords leave grid, or fixed item moves", () => {
    const before = makeAlreadyTightDoc();
    const after = structuredClone(before);
    after.components[0].rotation = 90;
    after.components[1].x += 5;
    const errs = validatePacking(before, after);
    expect(errs.filter((e) => e.startsWith("Rule 5:")).length).toBeGreaterThanOrEqual(2);

    const afterFixedMoved = structuredClone(before);
    afterFixedMoved.components[0].x -= 10;
    const fixedErrs = validatePacking(before, afterFixedMoved, { ids: new Set(["g2"]) });
    expect(fixedErrs.some((e) => e.includes("fixed component"))).toBe(true);
  });

  it("flags Rule 6 when bodies violate componentGap, labels overlap wires, texts overlap bodies, or wires violate wireGap", () => {
    // Text overlaps body
    const beforeNotes = makeNotesAndLabelsDoc();
    const afterText = structuredClone(beforeNotes);
    afterText.texts[0].x = afterText.components[0].x;
    afterText.texts[0].y = afterText.components[0].y + 10;
    expect(validatePacking(beforeNotes, afterText).some((e) => e.startsWith("Rule 6:"))).toBe(true);

    // Body-body closer than componentGap=2 (20px)
    const beforeBodies = emptyDocument("Bodies");
    beforeBodies.components.push(
      { id: "a", type: "and", x: 0, y: 10, rotation: 0, props: { inputs: 2 } },
      { id: "b", type: "and", x: 200, y: 10, rotation: 0, props: { inputs: 2 } },
    );
    const afterClose = structuredClone(beforeBodies);
    afterClose.components[1].x = 90; // only 10px gap (< 20px)
    expect(validatePacking(beforeBodies, afterClose).some((e) => e.includes("componentGap"))).toBe(true);

    // Label overlaps wire
    const beforeLabel = emptyDocument("LabelWire");
    beforeLabel.components.push({ id: "g", type: "and", x: 0, y: 50, rotation: 0, props: { inputs: 2 }, label: "U1" });
    beforeLabel.wires.push({ id: "w", points: [{ x: 0, y: 0 }, { x: 80, y: 0 }] });
    const afterLabelHit = structuredClone(beforeLabel);
    afterLabelHit.wires[0].points[0].y = 30;
    afterLabelHit.wires[0].points[1].y = 30; // passes through U1 label at y=[20..36]
    expect(validatePacking(beforeLabel, afterLabelHit).some((e) => e.includes("label"))).toBe(true);

    // Parallel wires violate wireGap=2
    const beforePar = emptyDocument("ParWires");
    beforePar.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "w2", points: [{ x: 0, y: 40 }, { x: 100, y: 40 }] },
    );
    const afterPar = structuredClone(beforePar);
    afterPar.wires[1].points[0].y = 10;
    afterPar.wires[1].points[1].y = 10;
    expect(validatePacking(beforePar, afterPar, { wireGap: 2 }).some((e) => e.includes("wireGap"))).toBe(true);
  });

  it("flags Rule 7 when a wire creates an accidental connection or alters junction dots", () => {
    const before = emptyDocument("AccidentalShort");
    before.components.push({ id: "g", type: "and", x: 100, y: 10, rotation: 0, props: { inputs: 2 } });
    // Separate wire below gate
    before.wires.push({ id: "w", points: [{ x: 0, y: 100 }, { x: 200, y: 100 }] });
    const after = structuredClone(before);
    // Slide wire straight through the gate body and pins at y = 20
    after.wires[0].points[0].y = 20;
    after.wires[0].points[1].y = 20;
    const errs = validatePacking(before, after);
    expect(errs.some((e) => e.startsWith("Rule 7:"))).toBe(true);
  });

  it("flags Rule 8 when relative component ordering flips or a pin exit leg collapses", () => {
    const before = emptyDocument("Ordering");
    before.components.push(
      { id: "a", type: "and", x: 0, y: 10, rotation: 0, props: { inputs: 2 } },
      { id: "b", type: "and", x: 200, y: 10, rotation: 0, props: { inputs: 2 } },
    );
    const after = structuredClone(before);
    after.components[0].x = 200;
    after.components[1].x = 0;
    expect(validatePacking(before, after).some((e) => e.startsWith("Rule 8:"))).toBe(true);

    // Pin exit leg shortened below 1 grid
    const beforeLeg = emptyDocument("PinLeg");
    const g: ComponentInstance = { id: "g", type: "and", x: 0, y: 10, rotation: 0, props: { inputs: 2 } };
    beforeLeg.components.push(g);
    const outP = pinPos(g, "out");
    beforeLeg.wires.push({ id: "w", points: [outP, { x: outP.x + 40, y: outP.y }, { x: outP.x + 40, y: outP.y + 40 }] });
    const afterLeg = structuredClone(beforeLeg);
    afterLeg.wires[0].points[1].x = outP.x; // collapsed exit stub to 0
    afterLeg.wires[0].points[2].x = outP.x;
    expect(validatePacking(beforeLeg, afterLeg).some((e) => e.startsWith("Rule 8:"))).toBe(true);
  });

  it("flags Rule 9 when bounding-box area increases", () => {
    const before = makeAlreadyTightDoc();
    const after = structuredClone(before);
    after.components[1].x += 100;
    after.wires[0].points[1].x += 100;
    const errs = validatePacking(before, after);
    expect(errs.some((e) => e.startsWith("Rule 9:"))).toBe(true);
  });

  it("verifies pointOnSegment T-junction remains intact in half adder", () => {
    const before = makeHalfAdderDoc();
    const res = packSchematic(before);
    const wA = res.doc.wires.find((w) => w.id === "wA")!;
    const wATap = res.doc.wires.find((w) => w.id === "wA_tap")!;
    expect(pointOnSegment(wATap.points[0], wA.points[0], wA.points[1])).toBe(true);
  });
});

/**
 * Parametric logic gates (IEEE/ANSI distinctive shapes, Harris & Harris textbook style).
 *
 * Resizing: `_w` / `_h` are the requested TOTAL outline (pin legs included, as the editor's
 * corner handles measure it). The gate BODY scales to fill it — taller bodies spread the
 * inputs evenly along the back edge, wider bodies stretch the shape — while the input/output
 * legs keep their fixed length and every pin stays on the 10-unit grid.
 */
import type { ComponentDef, Geometry, PinDef } from "../../model/component-def";
import { GRID, SIZE_H, SIZE_W } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { BUBBLE_R, ceilEvenGrid, clampInt, distributeOnGrid, PIN_LEN, requestedSize, snapGrid } from "./helpers";

type GateKind = "and" | "or" | "xor" | "buf";

const MIN_BODY_W = 4 * GRID;

interface GateLayout {
  inputs: number;
  bodyW: number;
  bodyH: number;
  x0: number; // body back edge
  x1: number; // body front tip
  inYs: number[];
  geom: Geometry;
}

function gateLayout(kind: GateKind, props: Record<string, PropValue>, inverted: boolean): GateLayout {
  const inputs = kind === "buf" ? 1 : clampInt(props, "inputs", 2, 2, 16);
  const bubble = inverted ? GRID : 0; // bubble (2*BUBBLE_R) gets a full grid cell so the outline stays on grid
  const xorGap = kind === "xor" ? GRID : 0; // room for the XOR's extra back curve

  // Default body height: 2 grid cells per input (1 when there are many) with half-cell
  // margins — a 2-input gate is 40 tall with inputs at 10/30. Kept even so the output is on grid.
  const spacing = inputs <= 5 ? 2 * GRID : GRID;
  // (with 1-cell spacing, add a cell so the outer inputs never sit on the body's corners)
  const minBodyH = ceilEvenGrid(Math.max(4 * GRID, inputs * spacing + (spacing === GRID ? GRID : 0)));
  // Default body width follows textbook proportions (IEEE distinctive shapes):
  // AND ≈ as wide as tall (a "D"), OR/XOR ≈ 1.25× as wide as tall; capped for tall gates.
  const aspect = kind === "and" ? 1 : kind === "buf" ? 1 : 1.25;
  const maxDefaultW = kind === "and" ? 6 * GRID : 7 * GRID;
  const defaultW = kind === "buf" ? MIN_BODY_W : Math.min(maxDefaultW, Math.max(MIN_BODY_W, snapGrid(Math.min(minBodyH, 60) * aspect)));
  const resizable = kind !== "buf";
  const reqH = resizable ? requestedSize(props, SIZE_H) : undefined;
  const reqW = resizable ? requestedSize(props, SIZE_W) : undefined;
  const bodyH = reqH !== undefined ? Math.max(minBodyH, ceilEvenGrid(reqH)) : minBodyH;
  const legs = 2 * PIN_LEN + bubble + xorGap;
  // Resizing can grow the gate but never squash it below its default design.
  const bodyW = reqW !== undefined ? Math.max(defaultW, snapGrid(reqW - legs)) : defaultW;

  const x0 = PIN_LEN + xorGap;
  const x1 = x0 + bodyW;
  let inYs: number[];
  if (inputs === 1) inYs = [bodyH / 2];
  else if (bodyH > minBodyH) {
    // Even spacing with equal margins (≈ h/(n+1)), like a drawn gate — not pushed to the corners.
    const margin = Math.max(GRID, snapGrid(bodyH / (inputs + 1)));
    inYs = distributeOnGrid(inputs, margin, bodyH - margin);
  }
  else {
    const span = (inputs - 1) * spacing;
    const first = Math.max(GRID, snapGrid((bodyH - span) / 2));
    inYs = Array.from({ length: inputs }, (_, i) => first + i * spacing);
  }

  const pins: PinDef[] = inYs.map((y, i) => ({ id: `in${i}`, name: `I${i}`, x: 0, y, dir: "in", side: "left" }));
  const outX = x1 + bubble + PIN_LEN;
  pins.push({ id: "out", name: "Y", x: outX, y: bodyH / 2, dir: "out", side: "right", inverted });
  return { inputs, bodyW, bodyH, x0, x1, inYs, geom: { width: outX, height: bodyH, pins } };
}

function gateSymbol(kind: GateKind, props: Record<string, PropValue>, inverted: boolean): string {
  const L = gateLayout(kind, props, inverted);
  const { x0, x1, bodyW } = L;
  const h = L.bodyH;
  const midY = h / 2;

  let body: string;
  let inputEdgeX = (_y: number) => x0;

  if (kind === "and") {
    // Flat back, straight top/bottom, elliptical front that scales with the body.
    const rx = Math.min(h / 2, bodyW * 0.6);
    body = `<path class="ds-body" d="M${x0} 0 H${x1 - rx} A${rx} ${h / 2} 0 0 1 ${x1 - rx} ${h} H${x0} Z"/>`;
  } else if (kind === "buf") {
    const half = Math.min(2 * GRID, h / 2);
    body = `<path class="ds-body" d="M${x0} ${midY - half} L${x1} ${midY} L${x0} ${midY + half} Z"/>`;
  } else {
    // OR / XOR: concave back curve (depth grows gently with size), pointed front.
    const depth = Math.min(bodyW * 0.35, 6 + h * 0.15);
    const ctrl = x0 + bodyW * 0.65;
    body =
      `<path class="ds-body" d="M${x0} 0 Q${ctrl} 0 ${x1} ${midY} Q${ctrl} ${h} ${x0} ${h} ` +
      `Q${x0 + depth} ${midY} ${x0} 0 Z"/>`;
    // Point on the back curve at height y (quadratic is linear in t = y / h here).
    const curveX = (bx: number) => (y: number) => {
      const t = y / h;
      return +(bx + 2 * (1 - t) * t * depth).toFixed(2);
    };
    inputEdgeX = curveX(x0);
    if (kind === "xor") {
      const bx = x0 - GRID * 0.6;
      body = `<path class="ds-line" d="M${bx} 0 Q${bx + depth} ${midY} ${bx} ${h}"/>` + body;
      inputEdgeX = curveX(bx);
    }
  }

  let stubs = "";
  for (const p of L.geom.pins) {
    if (p.dir !== "in") continue;
    stubs += `<line class="ds-pin" x1="${p.x}" y1="${p.y}" x2="${inputEdgeX(p.y)}" y2="${p.y}"/>`;
  }
  const out = L.geom.pins.find((p) => p.id === "out")!;
  let outStart = x1;
  let bubble = "";
  if (inverted) {
    bubble = `<circle class="ds-bubble" cx="${x1 + BUBBLE_R}" cy="${midY}" r="${BUBBLE_R}"/>`;
    outStart = x1 + 2 * BUBBLE_R;
  }
  stubs += `<line class="ds-pin" x1="${outStart}" y1="${out.y}" x2="${out.x}" y2="${out.y}"/>`;
  return body + bubble + stubs;
}

function makeGate(type: string, name: string, kind: GateKind, inverted: boolean): ComponentDef {
  const isBuf = kind === "buf";
  return {
    type,
    name,
    category: "Gates",
    labelPrefix: "U",
    description: isBuf ? `${name} gate` : `${name} gate with configurable number of inputs`,
    props: isBuf ? [] : [{ key: "inputs", label: "Inputs", kind: "int", min: 2, max: 16 }],
    defaultProps: isBuf ? {} : { inputs: 2 },
    ...(isBuf ? {} : { resizable: "both" as const }),
    geometry: (props) => gateLayout(kind, props, inverted).geom,
    symbol: (props) => gateSymbol(kind, props, inverted),
  };
}

/**
 * Schmitt-trigger buffer / inverter: the buffer or NOT outline with the hysteresis glyph inside.
 * Same pins and size as the plain gate.
 */
function makeSchmitt(type: string, name: string, inverted: boolean): ComponentDef {
  return {
    type,
    name,
    category: "Gates",
    labelPrefix: "U",
    description: `${name}: switches cleanly on slow or noisy inputs (input hysteresis)`,
    props: [],
    defaultProps: {},
    geometry: (props) => gateLayout("buf", props, inverted).geom,
    symbol(props) {
      const L = gateLayout("buf", props, inverted);
      const cx = L.x0 + (L.x1 - L.x0) * 0.4, cy = L.bodyH / 2;
      // two offset steps: the classic hysteresis loop
      const glyph =
        `<path class="ds-thin" d="M${cx - 7} ${cy + 4} H${cx + 1} V${cy - 4} H${cx + 5}"/>` +
        `<path class="ds-thin" d="M${cx - 5} ${cy + 4} H${cx - 3} V${cy - 4} H${cx + 7}"/>`;
      return gateSymbol("buf", props, inverted) + glyph;
    },
  };
}

export const gateDefs: ComponentDef[] = [
  makeGate("and", "AND", "and", false),
  makeGate("nand", "NAND", "and", true),
  makeGate("or", "OR", "or", false),
  makeGate("nor", "NOR", "or", true),
  makeGate("xor", "XOR", "xor", false),
  makeGate("xnor", "XNOR", "xor", true),
  makeGate("buf", "Buffer", "buf", false),
  makeGate("not", "NOT", "buf", true),
  makeSchmitt("schmitt-buffer", "Schmitt-Trigger Buffer", false),
  makeSchmitt("schmitt-inverter", "Schmitt-Trigger Inverter", true),
];

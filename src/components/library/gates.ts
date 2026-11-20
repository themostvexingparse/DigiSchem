/**
 * Parametric logic gates (IEEE/ANSI & Harris & Harris textbook style).
 * When inputs > 5 (or pins extend beyond the gate core height), straight vertical
 * "wings" extend the gate's back edge so the body keeps crisp proportions, and
 * OR/XOR input stubs reach the exact concave curve or wing.
 */
import type { ComponentDef, Geometry, PinDef } from "../../model/component-def";
import { GRID, SIZE_H } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { BUBBLE_R, ceilEvenGrid, clampInt, distributeOnGrid, PIN_LEN, requestedSize, snapGrid } from "./helpers";

type GateKind = "and" | "or" | "xor" | "buf";

function gateGeometry(inputs: number, invertedOut: boolean, props?: Record<string, PropValue>): Geometry {
  const spacing = inputs <= 5 ? 2 * GRID : GRID;
  const rawH = Math.max(4 * GRID, (inputs + 1) * spacing);
  // Even multiple of GRID ensures midY = bodyH / 2 is always on the 10-unit grid.
  const minBodyH = ceilEvenGrid(rawH);
  const reqH = inputs > 1 ? requestedSize(props, SIZE_H) : undefined;
  const bodyH = reqH !== undefined ? Math.max(minBodyH, ceilEvenGrid(reqH)) : minBodyH;
  const bodyW = 4 * GRID;
  const pins: PinDef[] = [];
  const ys =
    bodyH > minBodyH && inputs >= 2
      ? distributeOnGrid(inputs, GRID, bodyH - GRID)
      : (() => {
          const span = (inputs - 1) * spacing;
          const firstY = Math.max(GRID, snapGrid((bodyH - span) / 2));
          return Array.from({ length: inputs }, (_, i) => firstY + i * spacing);
        })();
  for (let i = 0; i < inputs; i++) {
    pins.push({
      id: `in${i}`,
      name: `I${i}`,
      x: 0,
      y: ys[i],
      dir: "in",
      side: "left",
    });
  }
  const outX = PIN_LEN + bodyW + (invertedOut ? GRID : 0) + PIN_LEN;
  pins.push({
    id: "out",
    name: "Y",
    x: outX,
    y: bodyH / 2,
    dir: "out",
    side: "right",
    inverted: invertedOut,
  });
  return { width: outX, height: bodyH, pins };
}

function gateSymbol(kind: GateKind, props: Record<string, PropValue>, inverted: boolean): string {
  const inputs = kind === "buf" ? 1 : clampInt(props, "inputs", 2, 2, 16);
  const g = gateGeometry(inputs, inverted, props);
  const h = g.height;
  const x0 = PIN_LEN;
  const x1 = PIN_LEN + 4 * GRID;
  const midY = h / 2;

  // Keep the gate body at clean textbook proportions; extend back with vertical wings if taller.
  const coreH = inputs <= 2 ? 4 * GRID : 6 * GRID;
  const coreTop = midY - coreH / 2;
  const coreBot = midY + coreH / 2;

  const inPins = g.pins.filter((p) => p.dir === "in");
  const topPinY = inPins.length > 0 ? Math.min(...inPins.map((p) => p.y)) : coreTop;
  const botPinY = inPins.length > 0 ? Math.max(...inPins.map((p) => p.y)) : coreBot;

  let body: string;
  let wings = "";
  let inputEdgeX = (_y: number) => x0;

  if (kind === "and") {
    const ry = coreH / 2;
    const rx = Math.min(ry, 24);
    body = `<path class="ds-body" d="M${x0} ${coreTop} H${x1 - rx} A${rx} ${ry} 0 0 1 ${x1 - rx} ${coreBot} H${x0} Z"/>`;
    if (topPinY < coreTop) {
      wings += `<line class="ds-line" x1="${x0}" y1="${topPinY}" x2="${x0}" y2="${coreTop}"/>`;
    }
    if (botPinY > coreBot) {
      wings += `<line class="ds-line" x1="${x0}" y1="${coreBot}" x2="${x0}" y2="${botPinY}"/>`;
    }
  } else if (kind === "buf") {
    body = `<path class="ds-body" d="M${x0} ${midY - 2 * GRID} L${x1} ${midY} L${x0} ${midY + 2 * GRID} Z"/>`;
  } else {
    // OR / XOR: concave quadratic back from (x0, coreTop) via (x0+12, midY) to (x0, coreBot).
    // Because midY = (coreTop + coreBot) / 2, y(t) is linear in t = (y - coreTop) / coreH.
    const curveDepth = 12;
    body =
      `<path class="ds-body" d="M${x0} ${coreTop} ` +
      `Q${x0 + 26} ${coreTop} ${x1} ${midY} ` +
      `Q${x0 + 26} ${coreBot} ${x0} ${coreBot} ` +
      `Q${x0 + curveDepth} ${midY} ${x0} ${coreTop} Z"/>`;

    if (kind === "xor") {
      const xorX = x0 - 6;
      body = `<path class="ds-line" d="M${xorX} ${coreTop} Q${xorX + curveDepth} ${midY} ${xorX} ${coreBot}"/>` + body;
      inputEdgeX = (y: number) => {
        if (y < coreTop || y > coreBot) return xorX;
        const t = (y - coreTop) / coreH;
        return +(xorX + 2 * (1 - t) * t * curveDepth).toFixed(2);
      };
      if (topPinY < coreTop) {
        wings += `<line class="ds-line" x1="${xorX}" y1="${topPinY}" x2="${xorX}" y2="${coreTop}"/>`;
      }
      if (botPinY > coreBot) {
        wings += `<line class="ds-line" x1="${xorX}" y1="${coreBot}" x2="${xorX}" y2="${botPinY}"/>`;
      }
    } else {
      inputEdgeX = (y: number) => {
        if (y < coreTop || y > coreBot) return x0;
        const t = (y - coreTop) / coreH;
        return +(x0 + 2 * (1 - t) * t * curveDepth).toFixed(2);
      };
      if (topPinY < coreTop) {
        wings += `<line class="ds-line" x1="${x0}" y1="${topPinY}" x2="${x0}" y2="${coreTop}"/>`;
      }
      if (botPinY > coreBot) {
        wings += `<line class="ds-line" x1="${x0}" y1="${coreBot}" x2="${x0}" y2="${botPinY}"/>`;
      }
    }
  }

  let stubs = "";
  for (const p of inPins) {
    stubs += `<line class="ds-pin" x1="${p.x}" y1="${p.y}" x2="${inputEdgeX(p.y)}" y2="${p.y}"/>`;
  }

  const out = g.pins.find((p) => p.id === "out")!;
  let outStart = x1;
  let bubble = "";
  if (inverted) {
    bubble = `<circle class="ds-bubble" cx="${x1 + BUBBLE_R}" cy="${midY}" r="${BUBBLE_R}"/>`;
    outStart = x1 + 2 * BUBBLE_R;
  }
  stubs += `<line class="ds-pin" x1="${outStart}" y1="${out.y}" x2="${out.x}" y2="${out.y}"/>`;

  return wings + body + bubble + stubs;
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
    ...(isBuf ? {} : { resizable: "height" as const }),
    geometry: (props) => gateGeometry(isBuf ? 1 : clampInt(props, "inputs", 2, 2, 16), inverted, props),
    symbol: (props) => gateSymbol(kind, props, inverted),
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
];

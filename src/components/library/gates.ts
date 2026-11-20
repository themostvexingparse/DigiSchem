/**
 * REFERENCE IMPLEMENTATION — parametric gates.
 * Shows the pattern every component must follow: geometry() derives the pin list
 * from props, so changing a prop (e.g. number of inputs) adds/removes real,
 * connectable pins. symbol() draws to match geometry().
 */
import type { ComponentDef, Geometry, PinDef } from "../../model/component-def";
import { GRID, propNum } from "../../model/component-def";
import type { PropValue } from "../../model/types";

const PIN_LEN = 20;

type GateKind = "and" | "or" | "xor" | "buf";

/** Body height grows with input count; inputs spaced 2 grid units apart (1 when many). */
function gateGeometry(inputs: number, invertedOut: boolean): Geometry {
  const spacing = inputs <= 5 ? 2 * GRID : GRID;
  const bodyH = Math.max(4 * GRID, (inputs + 1) * spacing);
  const bodyW = 4 * GRID;
  const pins: PinDef[] = [];
  const firstY = (bodyH - (inputs - 1) * spacing) / 2;
  for (let i = 0; i < inputs; i++) {
    pins.push({ id: `in${i}`, name: `I${i}`, x: 0, y: snapGrid(firstY + i * spacing), dir: "in", side: "left" });
  }
  const outX = PIN_LEN + bodyW + (invertedOut ? GRID : 0) + PIN_LEN;
  pins.push({
    id: "out",
    name: "Y",
    x: outX,
    y: snapGrid(bodyH / 2),
    dir: "out",
    side: "right",
    inverted: invertedOut,
  });
  return { width: outX, height: snapGrid(bodyH), pins };
}

function snapGrid(v: number) {
  return Math.round(v / GRID) * GRID;
}

function gateSymbol(kind: GateKind, props: Record<string, PropValue>, inverted: boolean): string {
  const inputs = kind === "buf" ? 1 : propNum(props, "inputs", 2);
  const g = gateGeometry(inputs, inverted);
  const h = g.height;
  const x0 = PIN_LEN, x1 = PIN_LEN + 4 * GRID;
  const midY = h / 2;
  let body: string;
  let inputEdgeX = (_y: number) => x0; // where input stubs end
  if (kind === "and") {
    const r = h / 2;
    body = `<path class="ds-body" d="M${x0} 0 H${x1 - r} A${r} ${r} 0 0 1 ${x1 - r} ${h} H${x0} Z"/>`;
  } else if (kind === "buf") {
    body = `<path class="ds-body" d="M${x0} ${midY - 2 * GRID} L${x1} ${midY} L${x0} ${midY + 2 * GRID} Z"/>`;
  } else {
    // OR / XOR: concave back, pointed front.
    const back = `Q${x0 + 12} ${midY} ${x0} 0`;
    body = `<path class="ds-body" d="M${x0} 0 Q${x0 + 28} 0 ${x1} ${midY} Q${x0 + 28} ${h} ${x0} ${h} ${back} Z"/>`;
    inputEdgeX = (y: number) => {
      // approximate the concave back curve: quadratic from (x0,0) via (x0+12,mid) to (x0,h)
      const t = y / h;
      return x0 + 2 * (1 - t) * t * 12;
    };
    if (kind === "xor") {
      body = `<path class="ds-line" d="M${x0 - 6} 0 Q${x0 + 6} ${midY} ${x0 - 6} ${h}"/>` + body;
    }
  }
  let stubs = "";
  for (const p of g.pins) {
    if (p.dir === "in") {
      const endX = kind === "xor" ? Math.min(inputEdgeX(p.y), x0 - 4) : inputEdgeX(p.y);
      stubs += `<line class="ds-pin" x1="${p.x}" y1="${p.y}" x2="${endX}" y2="${p.y}"/>`;
    }
  }
  const out = g.pins.find((p) => p.id === "out")!;
  let outStart = x1;
  let bubble = "";
  if (inverted) {
    bubble = `<circle class="ds-bubble" cx="${x1 + GRID / 2}" cy="${midY}" r="${GRID / 2}"/>`;
    outStart = x1 + GRID;
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
    geometry: (props) => gateGeometry(isBuf ? 1 : Math.max(2, propNum(props, "inputs", 2)), inverted),
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


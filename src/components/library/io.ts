/**
 * I/O components: Input/Output pins, Clock source, Constant, Ground, VCC,
 * Probe/LED, Tunnel (net label), and Bus Splitter/Merger.
 */
import type { ComponentDef, Geometry, PinDef } from "../../model/component-def";
import { escapeXml, GRID, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { ceilEvenGrid, ceilGrid, clampInt, drawBusTick, snapGrid } from "./helpers";

function ioTextWidth(text: string, minW = 30): number {
  return ceilGrid(Math.max(minW, text.length * 6.8 + 16));
}

const inputPinDef: ComponentDef = {
  type: "input-pin",
  name: "Input Pin",
  category: "I/O",
  labelPrefix: "IN",
  description: "Primary circuit input terminal with configurable name and bus width",
  props: [
    { key: "name", label: "Name", kind: "string" },
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
  ],
  defaultProps: { name: "A", width: 1 },
  geometry(props): Geometry {
    const name = propStr(props, "name", "A");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const label = bitW > 1 ? `${name}[${bitW - 1}:0]` : name;
    const bodyW = ioTextWidth(label, 30);
    const totalW = bodyW + 20;
    return {
      width: totalW,
      height: 20,
      pins: [{ id: "out", name: name || "IN", x: totalW, y: 10, dir: "out", side: "right", width: bitW }],
    };
  },
  symbol(props): string {
    const name = propStr(props, "name", "A");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const label = bitW > 1 ? `${name}[${bitW - 1}:0]` : name;
    const g = this.geometry(props);
    const bodyW = g.width - 20;
    const tipX = bodyW + 8;
    const body = `<path class="ds-body" d="M0 2 H${bodyW} L${tipX} 10 L${bodyW} 18 H0 Z"/>`;
    const stub = `<line class="ds-pin" x1="${tipX}" y1="10" x2="${g.width}" y2="10"/>`;
    const tick = drawBusTick(tipX, 10, g.width, 10, bitW);
    const txt = `<text class="ds-text" x="${bodyW / 2}" y="13.5" text-anchor="middle">${escapeXml(label)}</text>`;
    return body + stub + tick + txt;
  },
};

const outputPinDef: ComponentDef = {
  type: "output-pin",
  name: "Output Pin",
  category: "I/O",
  labelPrefix: "OUT",
  description: "Primary circuit output terminal with configurable name and bus width",
  props: [
    { key: "name", label: "Name", kind: "string" },
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
  ],
  defaultProps: { name: "Y", width: 1 },
  geometry(props): Geometry {
    const name = propStr(props, "name", "Y");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const label = bitW > 1 ? `${name}[${bitW - 1}:0]` : name;
    const bodyW = ioTextWidth(label, 30);
    const totalW = 20 + bodyW;
    return {
      width: totalW,
      height: 20,
      pins: [{ id: "in", name: name || "OUT", x: 0, y: 10, dir: "in", side: "left", width: bitW }],
    };
  },
  symbol(props): string {
    const name = propStr(props, "name", "Y");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const label = bitW > 1 ? `${name}[${bitW - 1}:0]` : name;
    const g = this.geometry(props);
    const x0 = 12;
    const bodyX = 20;
    const body = `<path class="ds-body" d="M${x0} 10 L${bodyX} 2 H${g.width} V18 H${bodyX} Z"/>`;
    const stub = `<line class="ds-pin" x1="0" y1="10" x2="${x0}" y2="10"/>`;
    const tick = drawBusTick(0, 10, x0, 10, bitW);
    const txt = `<text class="ds-text" x="${(bodyX + g.width) / 2}" y="13.5" text-anchor="middle">${escapeXml(label)}</text>`;
    return body + stub + tick + txt;
  },
};

const clockDef: ComponentDef = {
  type: "clock",
  name: "Clock",
  category: "I/O",
  labelPrefix: "CLK",
  description: "Periodic clock signal generator",
  props: [{ key: "name", label: "Label", kind: "string" }],
  defaultProps: { name: "" },
  geometry(props): Geometry {
    // The optional name is drawn under the symbol: grow the outline to include it (pins unchanged).
    const named = propStr(props, "name", "").trim() !== "";
    return {
      width: 40,
      height: named ? 40 : 20,
      pins: [{ id: "clk", name: "CLK", x: 40, y: 10, dir: "out", side: "right", clock: true }],
    };
  },
  symbol(props): string {
    const name = propStr(props, "name", "");
    const body = `<rect class="ds-body" x="0" y="0" width="30" height="20"/>`;
    const wave = `<path class="ds-line" d="M5 14 H9 V6 H15 V14 H21 V6 H25"/>`;
    const stub = `<line class="ds-pin" x1="30" y1="10" x2="40" y2="10"/>`;
    const txt = name ? `<text class="ds-text" x="15" y="30" text-anchor="middle">${escapeXml(name)}</text>` : "";
    return body + wave + stub + txt;
  },
};

const constantDef: ComponentDef = {
  type: "constant",
  name: "Constant",
  category: "I/O",
  labelPrefix: "K",
  description: "Constant logic level (0, 1, or multi-bit constant value)",
  props: [
    { key: "value", label: "Value", kind: "string" },
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
  ],
  defaultProps: { value: "1", width: 1 },
  geometry(props): Geometry {
    const value = propStr(props, "value", "1");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const bodyW = ioTextWidth(value, 20);
    const stubLen = bitW > 1 ? 20 : 10;
    const totalW = bodyW + stubLen;
    return {
      width: totalW,
      height: 20,
      pins: [{ id: "out", name: value || "1", x: totalW, y: 10, dir: "out", side: "right", width: bitW }],
    };
  },
  symbol(props): string {
    const value = propStr(props, "value", "1");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const g = this.geometry(props);
    const stubLen = bitW > 1 ? 20 : 10;
    const bodyW = g.width - stubLen;
    const body = `<rect class="ds-body" x="0" y="2" width="${bodyW}" height="16" rx="3"/>`;
    const stub = `<line class="ds-pin" x1="${bodyW}" y1="10" x2="${g.width}" y2="10"/>`;
    const tick = drawBusTick(bodyW, 10, g.width, 10, bitW);
    const txt = `<text class="ds-title" x="${bodyW / 2}" y="14" text-anchor="middle">${escapeXml(value)}</text>`;
    return body + stub + tick + txt;
  },
};

const groundDef: ComponentDef = {
  type: "ground",
  name: "Ground (GND)",
  category: "I/O",
  labelPrefix: "GND",
  description: "Ground / logic 0 reference rail",
  props: [],
  defaultProps: {},
  geometry(): Geometry {
    return {
      width: 20,
      height: 20,
      pins: [{ id: "gnd", name: "GND", x: 10, y: 0, dir: "inout", side: "top" }],
    };
  },
  symbol(): string {
    return (
      `<line class="ds-pin" x1="10" y1="0" x2="10" y2="10"/>` +
      `<line class="ds-line" x1="2" y1="10" x2="18" y2="10"/>` +
      `<line class="ds-line" x1="5" y1="14" x2="15" y2="14"/>` +
      `<line class="ds-line" x1="8" y1="18" x2="12" y2="18"/>`
    );
  },
};

const vccDef: ComponentDef = {
  type: "vcc",
  name: "VCC / Power",
  category: "I/O",
  labelPrefix: "VCC",
  description: "Power supply / logic 1 rail",
  props: [{ key: "label", label: "Label", kind: "string" }],
  defaultProps: { label: "VDD" },
  geometry(): Geometry {
    return {
      width: 40,
      height: 30,
      pins: [{ id: "vcc", name: "VCC", x: 20, y: 30, dir: "out", side: "bottom" }],
    };
  },
  symbol(props): string {
    const label = propStr(props, "label", "VDD");
    return (
      `<line class="ds-pin" x1="20" y1="14" x2="20" y2="30"/>` +
      `<line class="ds-line" x1="10" y1="14" x2="30" y2="14"/>` +
      `<text class="ds-text" x="20" y="10" text-anchor="middle">${escapeXml(label)}</text>`
    );
  },
};

const probeDef: ComponentDef = {
  type: "probe",
  name: "Probe / LED",
  category: "I/O",
  labelPrefix: "LED",
  description: "Logic level indicator / LED probe",
  props: [{ key: "name", label: "Label", kind: "string" }],
  defaultProps: { name: "" },
  geometry(props): Geometry {
    // The optional name is drawn under the symbol: grow the outline to include it (pins unchanged).
    const named = propStr(props, "name", "").trim() !== "";
    return {
      width: 40,
      height: named ? 40 : 20,
      pins: [{ id: "in", name: "IN", x: 0, y: 10, dir: "in", side: "left" }],
    };
  },
  symbol(props): string {
    const name = propStr(props, "name", "");
    const stub = `<line class="ds-pin" x1="0" y1="10" x2="14" y2="10"/>`;
    const body = `<circle class="ds-body" cx="23" cy="10" r="8"/>`;
    const inner = `<circle class="ds-thin" cx="23" cy="10" r="4.5"/>`;
    const rays =
      `<line class="ds-thin" x1="31" y1="4" x2="35" y2="1"/>` +
      `<line class="ds-thin" x1="33" y1="8" x2="38" y2="6"/>`;
    const txt = name ? `<text class="ds-text" x="23" y="29" text-anchor="middle">${escapeXml(name)}</text>` : "";
    return stub + body + inner + rays + txt;
  },
};

const tunnelDef: ComponentDef = {
  type: "tunnel",
  name: "Tunnel / Net Label",
  category: "I/O",
  labelPrefix: "NET",
  description: "Named net connection tag (connects matching tunnel names across a schematic)",
  props: [
    { key: "name", label: "Net Name", kind: "string" },
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
  ],
  defaultProps: { name: "NET", width: 1 },
  geometry(props): Geometry {
    const name = propStr(props, "name", "NET");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const label = bitW > 1 ? `${name}[${bitW - 1}:0]` : name;
    const flagW = ioTextWidth(label, 30);
    const totalW = 10 + flagW;
    return {
      width: totalW,
      height: 20,
      pins: [{ id: "net", name: name || "NET", x: 0, y: 10, dir: "inout", side: "left", width: bitW }],
    };
  },
  symbol(props): string {
    const name = propStr(props, "name", "NET");
    const bitW = clampInt(props, "width", 1, 1, 32);
    const label = bitW > 1 ? `${name}[${bitW - 1}:0]` : name;
    const g = this.geometry(props);
    // Pointed flag tip directly at (0, 10) where the wire attaches.
    const body = `<path class="ds-body" d="M0 10 L10 2 H${g.width} V18 H10 Z"/>`;
    const txt = `<text class="ds-text" x="${(10 + g.width) / 2}" y="13.5" text-anchor="middle">${escapeXml(label)}</text>`;
    return body + txt;
  },
};

interface SliceInfo {
  lo: number;
  hi: number;
  width: number;
  label: string;
}

function computeSlices(totalWidth: number, fanOut: number): SliceInfo[] {
  const slices: SliceInfo[] = [];
  if (fanOut >= totalWidth) {
    // A W-bit bus splits into at most W one-bit slices; extra fan-out is ignored.
    for (let i = 0; i < totalWidth; i++) slices.push({ lo: i, hi: i, width: 1, label: String(i) });
    return slices;
  }
  const base = Math.floor(totalWidth / fanOut);
  const rem = totalWidth % fanOut;
  let cursor = 0;
  for (let i = 0; i < fanOut; i++) {
    const w = base + (i < rem ? 1 : 0);
    const lo = cursor;
    const hi = cursor + w - 1;
    cursor += w;
    slices.push({ lo, hi, width: w, label: w === 1 ? `${lo}` : `${hi}:${lo}` });
  }
  return slices;
}

function splitterGeometry(props: Record<string, PropValue>): Geometry {
  const busW = clampInt(props, "width", 4, 2, 32);
  // A W-bit bus cannot split into more than W slices.
  const fanOut = Math.min(clampInt(props, "fanOut", 4, 2, 32), busW);
  const slices = computeSlices(busW, fanOut);
  const spacing = fanOut <= 8 ? 2 * GRID : GRID;
  const rawH = Math.max(4 * GRID, (fanOut + 1) * spacing);
  const height = ceilEvenGrid(rawH);
  const span = (fanOut - 1) * spacing;
  const firstY = Math.max(GRID, snapGrid((height - span) / 2));
  const width = 60;

  const pins: PinDef[] = [
    {
      id: "bus",
      name: `[${busW - 1}:0]`,
      x: 0,
      y: height / 2,
      dir: "inout",
      side: "left",
      width: busW,
    },
  ];
  for (let i = 0; i < fanOut; i++) {
    const s = slices[i];
    pins.push({
      id: `b${i}`,
      name: s.label,
      x: width,
      y: firstY + i * spacing,
      dir: "inout",
      side: "right",
      width: s.width,
    });
  }
  return { width, height, pins };
}

const splitterDef: ComponentDef = {
  type: "splitter",
  name: "Bus Splitter / Merger",
  category: "I/O",
  labelPrefix: "SPL",
  description: "Splits a multi-bit bus into individual bits or slices (or merges them into a bus)",
  props: [
    { key: "width", label: "Bus Width", kind: "int", min: 2, max: 32 },
    { key: "fanOut", label: "Fan-Out", kind: "int", min: 2, max: 32 },
  ],
  defaultProps: { width: 4, fanOut: 4 },
  geometry: splitterGeometry,
  symbol(props): string {
    const g = splitterGeometry(props);
    const busPin = g.pins[0];
    const slicePins = g.pins.slice(1);
    const spineX = 20;
    const topY = slicePins[0].y;
    const botY = slicePins[slicePins.length - 1].y;

    let svg = "";
    // Bus stub into the spine
    svg += `<line class="ds-bus" x1="${busPin.x}" y1="${busPin.y}" x2="${spineX}" y2="${busPin.y}"/>`;
    svg += drawBusTick(busPin.x, busPin.y, spineX, busPin.y, busPin.width);
    // Thick vertical bus spine
    svg += `<line class="ds-bus" x1="${spineX}" y1="${Math.min(topY, busPin.y)}" x2="${spineX}" y2="${Math.max(botY, busPin.y)}"/>`;

    // Angled branches out to each slice pin
    for (const p of slicePins) {
      const kneeX = spineX + 10;
      const startY = p.y === busPin.y ? p.y : p.y > busPin.y ? p.y - 4 : p.y + 4;
      const lineClass = (p.width ?? 1) > 1 ? "ds-bus" : "ds-pin";
      svg += `<path class="${lineClass}" d="M${spineX} ${startY} L${kneeX} ${p.y} L${p.x} ${p.y}"/>`;
      svg += `<text class="ds-bus-text" x="${kneeX + 2}" y="${p.y - 2}">${escapeXml(p.name)}</text>`;
    }
    return svg;
  },
};

export const ioDefs: ComponentDef[] = [
  inputPinDef,
  outputPinDef,
  clockDef,
  constantDef,
  groundDef,
  vccDef,
  probeDef,
  tunnelDef,
  splitterDef,
];

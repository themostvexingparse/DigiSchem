/**
 * Second batch of library blocks: Bit Selector, Bit Counter, AOI / OAI compound gates, Gray Code
 * Converter, Bus Transceiver, Carry-Lookahead Generator, FIFO, LFSR, Clock Divider,
 * Synchronizer and Edge Detector.
 */
import type { ComponentDef, PropDef } from "../../model/component-def";
import { propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, formatWords, layoutBox, PIN_MODE_PROP, renderBox, type BoxLayout, type PinSpec } from "./helpers";

const bitsFor = (n: number) => Math.max(1, Math.ceil(Math.log2(n)));

function busOrBits(prefix: string, label: string, width: number, dir: "in" | "out", mode: string): PinSpec[] {
  if (mode === "bits") return Array.from({ length: width }, (_, i) => ({ id: `${prefix}${i}`, name: `${label}${i}`, dir, width: 1 }));
  return [{ id: prefix, name: label, dir, width }];
}

function boxDef(d: {
  type: string;
  name: string;
  category: string;
  prefix: string;
  description: string;
  props: ComponentDef["props"];
  defaults: ComponentDef["defaultProps"];
  layout: (props: Record<string, PropValue>) => BoxLayout;
}): ComponentDef {
  return {
    type: d.type,
    name: d.name,
    category: d.category,
    labelPrefix: d.prefix,
    description: d.description,
    props: d.props,
    defaultProps: d.defaults,
    resizable: "both",
    geometry: (props) => d.layout(props).geometry,
    symbol: (props) => renderBox(d.layout(props)),
  };
}

const EDGE_PROP: PropDef = {
  key: "edge",
  label: "Clock Edge",
  kind: "enum",
  options: [
    { value: "rising", label: "Rising Edge" },
    { value: "falling", label: "Falling Edge" },
  ],
};
const clk = (props: Record<string, PropValue>): PinSpec => ({ id: "clk", name: "CLK", dir: "in", clock: true, inverted: propStr(props, "edge", "rising") === "falling" });

// ---- Plexers ----------------------------------------------------------------------------------

const bitSelectorDef = boxDef({
  type: "bit-selector",
  name: "Bit Selector",
  category: "Plexers",
  prefix: "SEL",
  description: "Picks one bit of a bus: Y = D[S]",
  props: [{ key: "width", label: "Bus Width", kind: "int", min: 2, max: 32 }],
  defaults: { width: 8 },
  layout(props) {
    const w = clampInt(props, "width", 8, 2, 32);
    return layoutBox(
      {
        left: [{ id: "d", name: "D", dir: "in", width: w }],
        right: [{ id: "y", name: "Y", dir: "out" }],
        bottom: [{ id: "s", name: "S", dir: "in", width: bitsFor(w) }],
        title: "BIT",
        subtitle: `of ${w}`,
        minBodyW: 60,
        minBodyH: 70,
      },
      props,
    );
  },
});

const grayDef = boxDef({
  type: "gray-converter",
  name: "Gray Code Converter",
  category: "Plexers",
  prefix: "GRAY",
  description: "Converts binary to Gray code (G = B xor B>>1), or Gray code back to binary",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 2, max: 32 },
    PIN_MODE_PROP,
    {
      key: "direction",
      label: "Direction",
      kind: "enum",
      options: [
        { value: "toGray", label: "Binary to Gray" },
        { value: "toBinary", label: "Gray to binary" },
      ],
    },
  ],
  defaults: { width: 4, pinMode: "bits", direction: "toGray" },
  layout(props) {
    const w = clampInt(props, "width", 4, 2, 32);
    const mode = propStr(props, "pinMode", "bits");
    const toGray = propStr(props, "direction", "toGray") !== "toBinary";
    return layoutBox(
      {
        left: busOrBits("in", toGray ? "B" : "G", w, "in", mode),
        right: busOrBits("out", toGray ? "G" : "B", w, "out", mode),
        title: toGray ? "BIN→GRAY" : "GRAY→BIN",
        subtitle: `${w}-bit`,
        minBodyW: 80,
        minBodyH: 50,
      },
      props,
    );
  },
});

const transceiverDef = boxDef({
  type: "bus-transceiver",
  name: "Bus Transceiver",
  category: "Plexers",
  prefix: "XCVR",
  description: "Bidirectional bus buffer (like the 74245): DIR = 1 drives B from A, DIR = 0 drives A from B; OE' = 1 disconnects both",
  props: [{ key: "width", label: "Bus Width", kind: "int", min: 1, max: 32 }],
  defaults: { width: 8 },
  layout(props) {
    const w = clampInt(props, "width", 8, 1, 32);
    return layoutBox(
      {
        left: [{ id: "a", name: "A", dir: "inout", width: w }],
        right: [{ id: "b", name: "B", dir: "inout", width: w }],
        top: [{ id: "dir", name: "DIR", dir: "in" }],
        bottom: [{ id: "oe", name: "OE", dir: "in", inverted: true, overbar: true }],
        title: "A↔B",
        minBodyW: 70,
        minBodyH: 60,
      },
      props,
    );
  },
});

// ---- Gates ------------------------------------------------------------------------------------

const AOI: Record<string, { groups: string[][]; or: boolean }> = {
  aoi21: { groups: [["A", "B"], ["C"]], or: false },
  aoi22: { groups: [["A", "B"], ["C", "D"]], or: false },
  oai21: { groups: [["A", "B"], ["C"]], or: true },
  oai22: { groups: [["A", "B"], ["C", "D"]], or: true },
};

const aoiDef = boxDef({
  type: "aoi",
  name: "AND-OR-Invert / OR-AND-Invert",
  category: "Gates",
  prefix: "U",
  description: "Compound CMOS gates in one stage: AOI21 Y = (AB + C)', AOI22 Y = (AB + CD)', OAI21 Y = ((A + B)C)', OAI22 Y = ((A + B)(C + D))'",
  props: [
    {
      key: "kind",
      label: "Function",
      kind: "enum",
      options: [
        { value: "aoi21", label: "AOI21: (AB + C)'" },
        { value: "aoi22", label: "AOI22: (AB + CD)'" },
        { value: "oai21", label: "OAI21: ((A + B)C)'" },
        { value: "oai22", label: "OAI22: ((A + B)(C + D))'" },
      ],
    },
  ],
  defaults: { kind: "aoi22" },
  layout(props) {
    const kind = AOI[propStr(props, "kind", "aoi22")] ? propStr(props, "kind", "aoi22") : "aoi22";
    const k = AOI[kind];
    const left: PinSpec[] = k.groups.flat().map((n) => ({ id: n.toLowerCase(), name: n, dir: "in" as const }));
    const inner = k.or ? "+" : "";
    const outer = k.or ? "" : " + ";
    const terms = k.groups.map((g) => (g.length > 1 && k.or ? `(${g.join(inner)})` : g.join(inner)));
    return layoutBox(
      {
        left,
        right: [{ id: "y", name: "Y", dir: "out", inverted: true, overbar: false }],
        title: kind.toUpperCase(),
        subtitle: `(${terms.join(outer)})'`,
        minBodyW: 80,
        minBodyH: 50,
      },
      props,
    );
  },
});

// ---- Arithmetic -------------------------------------------------------------------------------

const bitCounterDef = boxDef({
  type: "bit-counter",
  name: "Bit Counter (Popcount)",
  category: "Arithmetic",
  prefix: "POP",
  description: "Counts how many input bits are 1",
  props: [{ key: "width", label: "Input Bits", kind: "int", min: 2, max: 32 }, PIN_MODE_PROP],
  defaults: { width: 8, pinMode: "bits" },
  layout(props) {
    const w = clampInt(props, "width", 8, 2, 32);
    const mode = propStr(props, "pinMode", "bits");
    return layoutBox(
      {
        left: busOrBits("a", "A", w, "in", mode),
        right: [{ id: "count", name: "N", dir: "out", width: bitsFor(w + 1) }],
        title: "Σ1",
        subtitle: "count",
        minBodyW: 60,
        minBodyH: 50,
      },
      props,
    );
  },
});

const claDef = boxDef({
  type: "carry-lookahead",
  name: "Carry-Lookahead Generator",
  category: "Arithmetic",
  prefix: "CLA",
  description: "4-bit carry-lookahead unit (like the 74182): carries C1 to C3 from propagate/generate inputs, plus block P and G",
  props: [],
  defaults: {},
  layout(props) {
    const left: PinSpec[] = [
      ...[0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, dir: "in" as const })),
      ...[0, 1, 2, 3].map((i) => ({ id: `g${i}`, name: `G${i}`, dir: "in" as const })),
    ];
    const right: PinSpec[] = [
      { id: "c1", name: "C1", dir: "out" },
      { id: "c2", name: "C2", dir: "out" },
      { id: "c3", name: "C3", dir: "out" },
      { id: "p", name: "P", dir: "out" },
      { id: "g", name: "G", dir: "out" },
    ];
    return layoutBox({ left, right, top: [{ id: "c0", name: "C0", dir: "in" }], title: "CLA", minBodyW: 70, minBodyH: 60 }, props);
  },
});

// ---- Memory -----------------------------------------------------------------------------------

const fifoDef = boxDef({
  type: "fifo",
  name: "FIFO Queue",
  category: "Memory",
  prefix: "FIFO",
  description: "First-in first-out buffer: WR stores DIN, RD removes the oldest word; FULL and EMPTY flags",
  props: [
    { key: "depth", label: "Depth (words)", kind: "int", min: 2, max: 4096 },
    { key: "width", label: "Data Width", kind: "int", min: 1, max: 32 },
    EDGE_PROP,
  ],
  defaults: { depth: 16, width: 8, edge: "rising" },
  layout(props) {
    const depth = clampInt(props, "depth", 16, 2, 4096);
    const w = clampInt(props, "width", 8, 1, 32);
    return layoutBox(
      {
        left: [{ id: "din", name: "DIN", dir: "in", width: w }, { id: "wr", name: "WR", dir: "in" }, { id: "rd", name: "RD", dir: "in" }, clk(props)],
        right: [{ id: "dout", name: "DOUT", dir: "out", width: w }, { id: "full", name: "FULL", dir: "out" }, { id: "empty", name: "EMPTY", dir: "out" }],
        bottom: [{ id: "rst", name: "RST", dir: "in" }],
        title: "FIFO",
        subtitle: `${depth}×${w}`,
        minBodyW: 90,
        minBodyH: 60,
      },
      props,
    );
  },
});

// ---- Sequential -------------------------------------------------------------------------------

const lfsrDef = boxDef({
  type: "lfsr",
  name: "LFSR (Pseudo-Random)",
  category: "Registers",
  prefix: "LFSR",
  description: "Linear-feedback shift register: steps through a pseudo-random sequence on each clock",
  props: [
    { key: "bits", label: "Bits", kind: "int", min: 2, max: 32 },
    PIN_MODE_PROP,
    { key: "enable", label: "Enable Pin (EN)", kind: "bool" },
    EDGE_PROP,
  ],
  defaults: { bits: 8, pinMode: "bits", enable: false, edge: "rising" },
  layout(props) {
    const bits = clampInt(props, "bits", 8, 2, 32);
    const mode = propStr(props, "pinMode", "bits");
    const left: PinSpec[] = [];
    if (propBool(props, "enable", false)) left.push({ id: "en", name: "EN", dir: "in" });
    left.push(clk(props));
    return layoutBox(
      { left, right: busOrBits("q", "Q", bits, "out", mode), bottom: [{ id: "rst", name: "RST", dir: "in" }], title: "LFSR", subtitle: `${bits}-bit`, minBodyW: 70, minBodyH: 60 },
      props,
    );
  },
});

const clockDividerDef = boxDef({
  type: "clock-divider",
  name: "Clock Divider",
  category: "Registers",
  prefix: "DIV",
  description: "Output clock runs N times slower than the input clock",
  props: [{ key: "divisor", label: "Divide By (N)", kind: "int", min: 2, max: 1000000 }, { key: "reset", label: "Reset Pin (RST)", kind: "bool" }],
  defaults: { divisor: 2, reset: true },
  layout(props) {
    const n = clampInt(props, "divisor", 2, 2, 1000000);
    return layoutBox(
      {
        left: [{ id: "clk", name: "CLK", dir: "in", clock: true }],
        right: [{ id: "out", name: "OUT", dir: "out" }],
        bottom: propBool(props, "reset", true) ? [{ id: "rst", name: "RST", dir: "in" }] : [],
        title: `÷${n}`,
        minBodyW: 70,
        minBodyH: propBool(props, "reset", true) ? 60 : 50,
      },
      props,
    );
  },
});

const synchronizerDef = boxDef({
  type: "synchronizer",
  name: "Synchronizer",
  category: "Registers",
  prefix: "SYNC",
  description: "Chain of flip-flops that brings an asynchronous input safely into a clock domain (avoids metastability)",
  props: [{ key: "stages", label: "Flip-Flop Stages", kind: "int", min: 2, max: 4 }, EDGE_PROP],
  defaults: { stages: 2, edge: "rising" },
  layout(props) {
    const n = clampInt(props, "stages", 2, 2, 4);
    return layoutBox(
      { left: [{ id: "d", name: "D", dir: "in" }, clk(props)], right: [{ id: "q", name: "Q", dir: "out" }], title: "SYNC", subtitle: `${n} stages`, minBodyW: 70, minBodyH: 50 },
      props,
    );
  },
});

const edgeDetectorDef = boxDef({
  type: "edge-detector",
  name: "Edge Detector",
  category: "Registers",
  prefix: "EDGE",
  description: "Outputs a one-clock pulse P when input D changes: on a rising edge, a falling edge, or both",
  props: [
    {
      key: "detect",
      label: "Detect",
      kind: "enum",
      options: [
        { value: "rising", label: "Rising (0 to 1)" },
        { value: "falling", label: "Falling (1 to 0)" },
        { value: "both", label: "Both" },
      ],
    },
  ],
  defaults: { detect: "rising" },
  layout(props) {
    const det = propStr(props, "detect", "rising");
    const sub = det === "both" ? "both" : det === "falling" ? "falling" : "rising";
    return layoutBox(
      { left: [{ id: "d", name: "D", dir: "in" }, { id: "clk", name: "CLK", dir: "in", clock: true }], right: [{ id: "p", name: "P", dir: "out" }], title: "EDGE", subtitle: sub, minBodyW: 70, minBodyH: 50 },
      props,
    );
  },
});

export const extraPlexerDefs: ComponentDef[] = [bitSelectorDef, grayDef, transceiverDef];
export const extraGateDefs: ComponentDef[] = [aoiDef];
export const extraArithDefs: ComponentDef[] = [bitCounterDef, claDef];
export const extraMemoryDefs: ComponentDef[] = [fifoDef];
export const extraSeqDefs: ComponentDef[] = [lfsrDef, clockDividerDef, synchronizerDef, edgeDetectorDef];

// ---- Third batch: decade counter, debouncer, dual-port RAM, stack, keypad ---------------------

const decadeCounterDef = boxDef({
  type: "decade-counter",
  name: "Decade Counter (BCD)",
  category: "Registers",
  prefix: "CNT",
  description: "Counts 0 to 9 in BCD and wraps; TC is 1 at 9 so digits can be chained (like the 74160)",
  props: [PIN_MODE_PROP, { key: "enable", label: "Enable Pin (EN)", kind: "bool" }, { key: "load", label: "Parallel Load", kind: "bool" }, EDGE_PROP],
  defaults: { pinMode: "bits", enable: true, load: false, edge: "rising" },
  layout(props) {
    const mode = propStr(props, "pinMode", "bits");
    const left: PinSpec[] = [];
    if (propBool(props, "load", false)) left.push(...busOrBits("d", "D", 4, "in", mode), { id: "ld", name: "LOAD", dir: "in" });
    if (propBool(props, "enable", true)) left.push({ id: "en", name: "EN", dir: "in" });
    left.push(clk(props));
    const right: PinSpec[] = [...busOrBits("q", "Q", 4, "out", mode), { id: "tc", name: "TC", dir: "out" }];
    return layoutBox({ left, right, bottom: [{ id: "rst", name: "RST", dir: "in" }], title: "BCD", subtitle: "0-9", minBodyW: 70, minBodyH: 60 }, props);
  },
});

const debouncerDef = boxDef({
  type: "debouncer",
  name: "Debouncer",
  category: "Registers",
  prefix: "DB",
  description: "Cleans up a bouncing push-button or switch signal: OUT changes only after IN has been steady for a while",
  props: [EDGE_PROP],
  defaults: { edge: "rising" },
  layout(props) {
    return layoutBox(
      { left: [{ id: "in", name: "IN", dir: "in" }, clk(props)], right: [{ id: "out", name: "OUT", dir: "out" }], title: "DEBOUNCE", subtitle: "switch filter", minBodyW: 100, minBodyH: 60 },
      props,
    );
  },
});

const dualPortRamDef = boxDef({
  type: "dual-port-ram",
  name: "Dual-Port RAM",
  category: "Memory",
  prefix: "RAM",
  description: "Memory with two independent ports: port A reads and writes, port B reads at the same time",
  props: [
    { key: "addressBits", label: "Address Bits", kind: "int", min: 1, max: 24 },
    { key: "dataWidth", label: "Data Width", kind: "int", min: 1, max: 32 },
    EDGE_PROP,
  ],
  defaults: { addressBits: 8, dataWidth: 8, edge: "rising" },
  layout(props) {
    const a = clampInt(props, "addressBits", 8, 1, 24);
    const w = clampInt(props, "dataWidth", 8, 1, 32);
    return layoutBox(
      {
        left: [
          { id: "addra", name: "ADDR A", dir: "in", width: a },
          { id: "dina", name: "DIN A", dir: "in", width: w },
          { id: "wea", name: "WE A", dir: "in" },
          { id: "addrb", name: "ADDR B", dir: "in", width: a },
          clk(props),
        ],
        right: [
          { id: "douta", name: "DOUT A", dir: "out", width: w },
          { id: "doutb", name: "DOUT B", dir: "out", width: w },
        ],
        title: "DUAL-PORT RAM",
        subtitle: `${formatWords(2 ** a)}×${w}`,
        minBodyW: 120,
        minBodyH: 60,
      },
      props,
    );
  },
});

const stackDef = boxDef({
  type: "stack",
  name: "Stack (LIFO)",
  category: "Memory",
  prefix: "STK",
  description: "Last-in first-out memory: PUSH stores DIN on top, POP removes the top word; TOP shows it",
  props: [
    { key: "depth", label: "Depth (words)", kind: "int", min: 2, max: 4096 },
    { key: "width", label: "Data Width", kind: "int", min: 1, max: 32 },
    EDGE_PROP,
  ],
  defaults: { depth: 16, width: 8, edge: "rising" },
  layout(props) {
    const depth = clampInt(props, "depth", 16, 2, 4096);
    const w = clampInt(props, "width", 8, 1, 32);
    return layoutBox(
      {
        left: [{ id: "din", name: "DIN", dir: "in", width: w }, { id: "push", name: "PUSH", dir: "in" }, { id: "pop", name: "POP", dir: "in" }, clk(props)],
        right: [{ id: "top", name: "TOP", dir: "out", width: w }, { id: "full", name: "FULL", dir: "out" }, { id: "empty", name: "EMPTY", dir: "out" }],
        bottom: [{ id: "rst", name: "RST", dir: "in" }],
        title: "STACK",
        subtitle: `${depth}×${w}`,
        minBodyW: 90,
        minBodyH: 60,
      },
      props,
    );
  },
});

function keypadLayout(props: Record<string, PropValue>): BoxLayout {
  const mode = propStr(props, "pinMode", "bus");
  return layoutBox({ right: [...busOrBits("k", "K", 4, "out", mode), { id: "valid", name: "VALID", dir: "out" }], minBodyW: 120, minBodyH: 100 }, props);
}

const KEYS = ["1", "2", "3", "A", "4", "5", "6", "B", "7", "8", "9", "C", "*", "0", "#", "D"];

const keypadDef: ComponentDef = {
  type: "keypad",
  name: "Hex Keypad (4×4)",
  category: "I/O",
  labelPrefix: "KP",
  description: "16-key keypad: K is the code of the pressed key and VALID is 1 while a key is held",
  props: [PIN_MODE_PROP],
  defaultProps: { pinMode: "bus" },
  resizable: "both",
  geometry: (props) => keypadLayout(props).geometry,
  symbol(props) {
    const L = keypadLayout(props);
    const size = Math.min(14, (L.bodyH - 20) / 4 - 3);
    let keys = "";
    KEYS.forEach((k, i) => {
      const x = L.bodyX + 8 + (i % 4) * (size + 3), y = L.bodyY + 10 + Math.floor(i / 4) * (size + 3);
      keys += `<rect class="ds-thin" x="${x}" y="${y}" width="${size}" height="${size}" rx="1.5"/>`;
      keys += `<text class="ds-text" x="${x + size / 2}" y="${y + size / 2 + 3.5}" text-anchor="middle">${k}</text>`;
    });
    return renderBox(L, keys);
  },
};

export const thirdBatchDefs = { seq: [decadeCounterDef, debouncerDef], memory: [dualPortRamDef, stackDef], io: [keypadDef] };

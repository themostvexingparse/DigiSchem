/**
 * Arithmetic components: Half Adder, Full Adder, N-bit Adder, N-bit Subtractor,
 * Comparator, V-notched ALU (Harris & Harris style), Shifter, and Multiplier.
 */
import type { ComponentDef, Geometry, PinDef } from "../../model/component-def";
import { escapeXml, GRID, propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import {
  ceilEvenGrid,
  clampInt,
  drawPinStub,
  layoutBox,
  PIN_LEN,
  PIN_MODE_PROP,
  renderBox,
  snapGrid,
  type PinSpec,
} from "./helpers";

function busOrBits(prefix: string, labelPrefix: string, width: number, dir: "in" | "out", mode: string): PinSpec[] {
  if (mode === "bits") {
    const out: PinSpec[] = [];
    for (let i = 0; i < width; i++) {
      out.push({ id: `${prefix}${i}`, name: `${labelPrefix}${i}`, dir, width: 1 });
    }
    return out;
  }
  return [{ id: prefix, name: labelPrefix, dir, width }];
}

const halfAdderLayout = () =>
  layoutBox({
    left: [
      { id: "a", name: "A", dir: "in" },
      { id: "b", name: "B", dir: "in" },
    ],
    right: [
      { id: "s", name: "S", dir: "out" },
      { id: "cout", name: "Cout", dir: "out" },
    ],
    title: "HA",
    minBodyW: 60,
    minBodyH: 60,
  });

const halfAdderDef: ComponentDef = {
  type: "half-adder",
  name: "Half Adder",
  category: "Arithmetic",
  labelPrefix: "HA",
  description: "1-bit half adder with Sum and Carry-out",
  props: [],
  defaultProps: {},
  geometry: () => halfAdderLayout().geometry,
  symbol: () => renderBox(halfAdderLayout()),
};

const fullAdderLayout = () =>
  layoutBox({
    left: [
      { id: "a", name: "A", dir: "in" },
      { id: "b", name: "B", dir: "in" },
    ],
    right: [{ id: "s", name: "S", dir: "out" }],
    top: [{ id: "cin", name: "Cin", dir: "in" }],
    bottom: [{ id: "cout", name: "Cout", dir: "out" }],
    title: "FA",
    minBodyW: 60,
    minBodyH: 60,
  });

const fullAdderDef: ComponentDef = {
  type: "full-adder",
  name: "Full Adder",
  category: "Arithmetic",
  labelPrefix: "FA",
  description: "1-bit full adder with Carry-in on top and Carry-out on bottom",
  props: [],
  defaultProps: {},
  geometry: () => fullAdderLayout().geometry,
  symbol: () => renderBox(fullAdderLayout()),
};

function adderLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const carryIn = propBool(props, "carryIn", true);
  const carryOut = propBool(props, "carryOut", true);

  const left = [...busOrBits("a", "A", width, "in", mode), ...busOrBits("b", "B", width, "in", mode)];
  const right = busOrBits("s", "S", width, "out", mode);
  const top: PinSpec[] = carryIn ? [{ id: "cin", name: "Cin", dir: "in" }] : [];
  const bottom: PinSpec[] = carryOut ? [{ id: "cout", name: "Cout", dir: "out" }] : [];

  return layoutBox({
    left,
    right,
    top,
    bottom,
    title: "+",
    subtitle: `${width}-bit`,
    minBodyW: 60,
    minBodyH: 60,
  });
}

const adderDef: ComponentDef = {
  type: "adder",
  name: "N-bit Adder",
  category: "Arithmetic",
  labelPrefix: "ADD",
  description: "Parametric N-bit binary adder with optional carry-in and carry-out",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
    PIN_MODE_PROP,
    { key: "carryIn", label: "Carry In (Cin)", kind: "bool" },
    { key: "carryOut", label: "Carry Out (Cout)", kind: "bool" },
  ],
  defaultProps: { width: 8, pinMode: "bus", carryIn: true, carryOut: true },
  geometry: (props) => adderLayout(props).geometry,
  symbol: (props) => renderBox(adderLayout(props)),
};

function subtractorLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const borrowIn = propBool(props, "borrowIn", false);
  const borrowOut = propBool(props, "borrowOut", true);

  const left = [...busOrBits("a", "A", width, "in", mode), ...busOrBits("b", "B", width, "in", mode)];
  const right = busOrBits("d", "D", width, "out", mode);
  const top: PinSpec[] = borrowIn ? [{ id: "bin", name: "Bin", dir: "in" }] : [];
  const bottom: PinSpec[] = borrowOut ? [{ id: "bout", name: "Bout", dir: "out" }] : [];

  return layoutBox({
    left,
    right,
    top,
    bottom,
    title: "SUB",
    subtitle: `${width}-bit`,
    minBodyW: 60,
    minBodyH: 60,
  });
}

const subtractorDef: ComponentDef = {
  type: "subtractor",
  name: "N-bit Subtractor",
  category: "Arithmetic",
  labelPrefix: "SUB",
  description: "Parametric N-bit binary subtractor with optional borrow-in and borrow-out",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
    PIN_MODE_PROP,
    { key: "borrowIn", label: "Borrow In (Bin)", kind: "bool" },
    { key: "borrowOut", label: "Borrow Out (Bout)", kind: "bool" },
  ],
  defaultProps: { width: 8, pinMode: "bus", borrowIn: false, borrowOut: true },
  geometry: (props) => subtractorLayout(props).geometry,
  symbol: (props) => renderBox(subtractorLayout(props)),
};

function comparatorLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const signed = propBool(props, "signed", false);
  const showEq = propBool(props, "showEq", true);
  const showLt = propBool(props, "showLt", true);
  const showGt = propBool(props, "showGt", true);

  const left = [...busOrBits("a", "A", width, "in", mode), ...busOrBits("b", "B", width, "in", mode)];
  const right: PinSpec[] = [];
  if (showGt) right.push({ id: "gt", name: "A>B", dir: "out" });
  if (showEq) right.push({ id: "eq", name: "A=B", dir: "out" });
  if (showLt) right.push({ id: "lt", name: "A<B", dir: "out" });

  return layoutBox({
    left,
    right,
    title: "CMP",
    subtitle: `${width}-bit${signed ? " S" : ""}`,
    minBodyW: 70,
    minBodyH: 60,
  });
}

const comparatorDef: ComponentDef = {
  type: "comparator",
  name: "Comparator",
  category: "Arithmetic",
  labelPrefix: "CMP",
  description: "N-bit magnitude comparator with toggleable A>B, A=B, A<B outputs",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
    PIN_MODE_PROP,
    { key: "signed", label: "Signed", kind: "bool" },
    { key: "showGt", label: "Show A>B", kind: "bool" },
    { key: "showEq", label: "Show A=B", kind: "bool" },
    { key: "showLt", label: "Show A<B", kind: "bool" },
  ],
  defaultProps: { width: 8, pinMode: "bus", signed: false, showGt: true, showEq: true, showLt: true },
  geometry: (props) => comparatorLayout(props).geometry,
  symbol: (props) => renderBox(comparatorLayout(props)),
};

interface AluLayout {
  geometry: Geometry;
  bodyX: number;
  bodyY: number;
  bodyW: number;
  bodyH: number;
  slope: number;
  notchDepth: number;
  notchHalfH: number;
  width: number;
}

function layoutAlu(props: Record<string, PropValue>): AluLayout {
  const dataW = clampInt(props, "width", 32, 1, 32);
  const opBits = clampInt(props, "opBits", 3, 1, 6);
  const opPinMode = propStr(props, "opPinMode", "bits");
  const flagN = propBool(props, "flagN", true);
  const flagZ = propBool(props, "flagZ", true);
  const flagC = propBool(props, "flagC", true);
  const flagV = propBool(props, "flagV", true);

  const opPinsSpec: PinSpec[] =
    opPinMode === "bus"
      ? [{ id: "f", name: "F", dir: "in", width: opBits }]
      : Array.from({ length: opBits }, (_, i) => ({ id: `f${i}`, name: `F${i}`, dir: "in" as const }));

  const rightSpecs: PinSpec[] = [{ id: "y", name: "Y", dir: "out", width: dataW }];
  if (flagN) rightSpecs.push({ id: "n", name: "N", dir: "out" });
  if (flagZ) rightSpecs.push({ id: "z", name: "Z", dir: "out" });
  if (flagC) rightSpecs.push({ id: "c", name: "C", dir: "out" });
  if (flagV) rightSpecs.push({ id: "v", name: "V", dir: "out" });

  const slope = 20;
  const rightSpacing = 2 * GRID;
  const rightSpan = (rightSpecs.length - 1) * rightSpacing;
  const flatRightH = Math.max(60, rightSpan + 20);
  const bodyH = ceilEvenGrid(Math.max(120, flatRightH + 2 * slope));

  const topSpacing = 20;
  const bodyW = ceilEvenGrid(Math.max(80, (opPinsSpec.length + 1) * topSpacing + 10));
  const bodyX = PIN_LEN;
  const bodyY = PIN_LEN;
  const totalW = bodyX + bodyW + PIN_LEN;
  const totalH = bodyY + bodyH;

  const pins: PinDef[] = [];

  // Left operand inputs A (upper lobe) and B (lower lobe)
  const notchHalfH = 14;
  const midY = bodyY + bodyH / 2;
  const yA = snapGrid(bodyY + (bodyH / 2 - notchHalfH) / 2);
  const yB = snapGrid(bodyY + bodyH - (bodyH / 2 - notchHalfH) / 2);
  pins.push({ id: "a", name: "A", x: 0, y: yA, dir: "in", side: "left", width: dataW });
  pins.push({ id: "b", name: "B", x: 0, y: yB, dir: "in", side: "left", width: dataW });

  // Top op-select pins (F0..Fk-1 or F)
  const opSpan = (opPinsSpec.length - 1) * topSpacing;
  const firstOpX = bodyX + Math.max(GRID, snapGrid((bodyW - opSpan) / 2));
  for (let i = 0; i < opPinsSpec.length; i++) {
    const op = opPinsSpec[i];
    pins.push({
      id: op.id,
      name: op.name,
      x: firstOpX + i * topSpacing,
      y: 0,
      dir: "in",
      side: "top",
      width: op.width,
    });
  }

  // Right outputs (Y + enabled flags) centered on the vertical right edge
  const firstRY = snapGrid(midY - rightSpan / 2);
  for (let i = 0; i < rightSpecs.length; i++) {
    const r = rightSpecs[i];
    pins.push({
      id: r.id,
      name: r.name,
      x: totalW,
      y: firstRY + i * rightSpacing,
      dir: "out",
      side: "right",
      width: r.width,
    });
  }

  return {
    geometry: { width: totalW, height: totalH, pins },
    bodyX,
    bodyY,
    bodyW,
    bodyH,
    slope,
    notchDepth: 16,
    notchHalfH,
    width: dataW,
  };
}

function renderAlu(props: Record<string, PropValue>): string {
  const layout = layoutAlu(props);
  const { geometry, bodyX, bodyY, bodyW, bodyH, slope, notchDepth, notchHalfH, width } = layout;
  const bodyRight = bodyX + bodyW;
  const bodyBottom = bodyY + bodyH;
  const midY = bodyY + bodyH / 2;

  // Classic Harris & Harris V-notched ALU polygon
  const path =
    `M${bodyX} ${bodyY} ` +
    `L${bodyRight} ${bodyY + slope} ` +
    `L${bodyRight} ${bodyBottom - slope} ` +
    `L${bodyX} ${bodyBottom} ` +
    `L${bodyX} ${midY + notchHalfH} ` +
    `L${bodyX + notchDepth} ${midY} ` +
    `L${bodyX} ${midY - notchHalfH} Z`;

  let svg = `<path class="ds-body" d="${path}"/>`;

  const topEdgeY = (x: number) => bodyY + ((x - bodyX) / bodyW) * slope;

  for (const pin of geometry.pins) {
    if (pin.side === "left") {
      svg += drawPinStub(pin, bodyX, pin.y);
      svg += `<text class="ds-text" x="${bodyX + 5}" y="${pin.y + 3.5}" text-anchor="start">${escapeXml(pin.name)}</text>`;
    } else if (pin.side === "right") {
      svg += drawPinStub(pin, bodyRight, pin.y);
      svg += `<text class="ds-text" x="${bodyRight - 5}" y="${pin.y + 3.5}" text-anchor="end">${escapeXml(pin.name)}</text>`;
    } else if (pin.side === "top") {
      const ey = +topEdgeY(pin.x).toFixed(2);
      svg += drawPinStub(pin, pin.x, ey);
      svg += `<text class="ds-text" x="${pin.x}" y="${ey + 11}" text-anchor="middle">${escapeXml(pin.name)}</text>`;
    }
  }

  const cx = bodyX + notchDepth + (bodyW - notchDepth) / 2 - 4;
  svg += `<text class="ds-title" x="${cx}" y="${midY - 1}" text-anchor="middle">ALU</text>`;
  svg += `<text class="ds-text" x="${cx}" y="${midY + 11}" text-anchor="middle">${width}-bit</text>`;

  return svg;
}

const aluDef: ComponentDef = {
  type: "alu",
  name: "ALU",
  category: "Arithmetic",
  labelPrefix: "ALU",
  description: "Textbook V-notched Arithmetic Logic Unit with configurable width, op-select bits, and N/Z/C/V flags",
  props: [
    { key: "width", label: "Data Width", kind: "int", min: 1, max: 32 },
    { key: "opBits", label: "Op-Select Bits", kind: "int", min: 1, max: 6 },
    {
      key: "opPinMode",
      label: "Op Pins",
      kind: "enum",
      options: [
        { value: "bits", label: "Individual (F0..Fn)" },
        { value: "bus", label: "Bus (F)" },
      ],
    },
    { key: "flagN", label: "Negative Flag (N)", kind: "bool" },
    { key: "flagZ", label: "Zero Flag (Z)", kind: "bool" },
    { key: "flagC", label: "Carry Flag (C)", kind: "bool" },
    { key: "flagV", label: "Overflow Flag (V)", kind: "bool" },
  ],
  defaultProps: {
    width: 32,
    opBits: 3,
    opPinMode: "bits",
    flagN: true,
    flagZ: true,
    flagC: true,
    flagV: true,
  },
  geometry: (props) => layoutAlu(props).geometry,
  symbol: renderAlu,
};

function shifterLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 2, 32);
  const shiftBits = clampInt(props, "shiftBits", 3, 1, 5);
  const mode = propStr(props, "pinMode", "bus");
  const kind = propStr(props, "mode", "universal");

  const left = busOrBits("a", "A", width, "in", mode);
  const right = busOrBits("y", "Y", width, "out", mode);
  const bottom: PinSpec[] = [];
  for (let i = 0; i < shiftBits; i++) {
    bottom.push({ id: `sh${i}`, name: `SH${i}`, dir: "in" });
  }
  const top: PinSpec[] = [];
  if (kind === "universal") {
    top.push({ id: "dir", name: "DIR", dir: "in" });
    top.push({ id: "arith", name: "AR", dir: "in" });
  }

  const titleMap: Record<string, string> = {
    lsl: "<< LSL",
    lsr: ">> LSR",
    asr: ">>> ASR",
    ror: "ROR",
    universal: "SHIFTER",
  };

  return layoutBox({
    left,
    right,
    top,
    bottom,
    title: titleMap[kind] ?? "SHIFTER",
    subtitle: `${width}-bit`,
    minBodyW: 80,
    minBodyH: 60,
  });
}

const shifterDef: ComponentDef = {
  type: "shifter",
  name: "Shifter",
  category: "Arithmetic",
  labelPrefix: "SHF",
  description: "Barrel shifter supporting logical/arithmetic/rotate or universal mode",
  props: [
    { key: "width", label: "Data Width", kind: "int", min: 2, max: 32 },
    { key: "shiftBits", label: "Shift Amount Bits", kind: "int", min: 1, max: 5 },
    PIN_MODE_PROP,
    {
      key: "mode",
      label: "Shift Mode",
      kind: "enum",
      options: [
        { value: "universal", label: "Universal (DIR/AR)" },
        { value: "lsl", label: "Logical Left (<<)" },
        { value: "lsr", label: "Logical Right (>>)" },
        { value: "asr", label: "Arithmetic Right (>>>)" },
        { value: "ror", label: "Rotate Right (ROR)" },
      ],
    },
  ],
  defaultProps: { width: 8, shiftBits: 3, pinMode: "bus", mode: "universal" },
  geometry: (props) => shifterLayout(props).geometry,
  symbol: (props) => renderBox(shifterLayout(props)),
};

function multiplierLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 2, 32);
  const mode = propStr(props, "pinMode", "bus");
  const signed = propBool(props, "signed", false);
  const fullProduct = propBool(props, "fullProduct", true);
  const prodW = fullProduct ? Math.min(64, 2 * width) : width;

  const left = [...busOrBits("a", "A", width, "in", mode), ...busOrBits("b", "B", width, "in", mode)];
  const right = busOrBits("p", "P", prodW, "out", mode);

  return layoutBox({
    left,
    right,
    title: "×",
    subtitle: `${width}×${width}${signed ? " S" : ""}`,
    minBodyW: 70,
    minBodyH: 60,
  });
}

const multiplierDef: ComponentDef = {
  type: "multiplier",
  name: "Multiplier",
  category: "Arithmetic",
  labelPrefix: "MUL",
  description: "N×N binary multiplier with full 2N-bit or truncated N-bit product output",
  props: [
    { key: "width", label: "Operand Width", kind: "int", min: 2, max: 32 },
    PIN_MODE_PROP,
    { key: "signed", label: "Signed", kind: "bool" },
    { key: "fullProduct", label: "Full 2N-bit Product", kind: "bool" },
  ],
  defaultProps: { width: 8, pinMode: "bus", signed: false, fullProduct: true },
  geometry: (props) => multiplierLayout(props).geometry,
  symbol: (props) => renderBox(multiplierLayout(props)),
};

export const arithmeticDefs: ComponentDef[] = [
  halfAdderDef,
  fullAdderDef,
  adderDef,
  subtractorDef,
  comparatorDef,
  aluDef,
  shifterDef,
  multiplierDef,
];

/**
 * More arithmetic and code-conversion blocks: Incrementer, Decrementer, Negator (two's
 * complement), Divider, Bit Extender, Parity Generator, and BCD to 7-Segment Decoder.
 */
import type { ComponentDef } from "../../model/component-def";
import { propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, layoutBox, PIN_MODE_PROP, renderBox, type BoxLayout, type PinSpec } from "./helpers";

function busOrBits(prefix: string, label: string, width: number, dir: "in" | "out", mode: string): PinSpec[] {
  if (mode === "bits") return Array.from({ length: width }, (_, i) => ({ id: `${prefix}${i}`, name: `${label}${i}`, dir, width: 1 }));
  return [{ id: prefix, name: label, dir, width }];
}

const WIDTH_PROP = { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 } as const;

/** One-operand N-bit block: A in, Y out, optional flag output at the bottom. */
function unaryLayout(props: Record<string, PropValue>, title: string, flag?: { id: string; name: string; key: string }): BoxLayout {
  const width = clampInt(props, "width", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const bottom: PinSpec[] = flag && propBool(props, flag.key, true) ? [{ id: flag.id, name: flag.name, dir: "out" }] : [];
  return layoutBox(
    { left: busOrBits("a", "A", width, "in", mode), right: busOrBits("y", "Y", width, "out", mode), bottom, title, subtitle: `${width}-bit`, minBodyW: 60, minBodyH: bottom.length ? 70 : 50 },
    props,
  );
}

function unaryDef(type: string, name: string, prefix: string, description: string, title: string, flag?: { id: string; name: string; key: string; label: string }): ComponentDef {
  return {
    type,
    name,
    category: "Arithmetic",
    labelPrefix: prefix,
    description,
    props: [WIDTH_PROP, PIN_MODE_PROP, ...(flag ? [{ key: flag.key, label: flag.label, kind: "bool" as const }] : [])],
    defaultProps: { width: 8, pinMode: "bus", ...(flag ? { [flag.key]: true } : {}) },
    resizable: "both",
    geometry: (props) => unaryLayout(props, title, flag).geometry,
    symbol: (props) => renderBox(unaryLayout(props, title, flag)),
  };
}

const incrementerDef = unaryDef("incrementer", "Incrementer", "INC", "Adds 1 to an N-bit value (Y = A + 1), with an optional carry-out", "+1", {
  id: "cout",
  name: "Cout",
  key: "carryOut",
  label: "Carry Out (Cout)",
});
const decrementerDef = unaryDef("decrementer", "Decrementer", "DEC", "Subtracts 1 from an N-bit value (Y = A - 1), with an optional borrow-out", "-1", {
  id: "bout",
  name: "Bout",
  key: "borrowOut",
  label: "Borrow Out (Bout)",
});
const negatorDef = unaryDef("negator", "Negator", "NEG", "Two's complement negation of an N-bit value (Y = -A)", "-A");

function dividerLayout(props: Record<string, PropValue>): BoxLayout {
  const width = clampInt(props, "width", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const left = [...busOrBits("a", "A", width, "in", mode), ...busOrBits("b", "B", width, "in", mode)];
  const right = [...busOrBits("q", "Q", width, "out", mode), ...busOrBits("r", "R", width, "out", mode)];
  return layoutBox({ left, right, title: "÷", subtitle: `${width}-bit`, minBodyW: 60, minBodyH: 60 }, props);
}

const dividerDef: ComponentDef = {
  type: "divider",
  name: "Divider",
  category: "Arithmetic",
  labelPrefix: "DIV",
  description: "Unsigned N-bit divider: quotient Q = A / B and remainder R = A mod B",
  props: [WIDTH_PROP, PIN_MODE_PROP],
  defaultProps: { width: 8, pinMode: "bus" },
  resizable: "both",
  geometry: (props) => dividerLayout(props).geometry,
  symbol: (props) => renderBox(dividerLayout(props)),
};

function extenderLayout(props: Record<string, PropValue>): BoxLayout {
  const inW = clampInt(props, "inWidth", 8, 1, 32);
  const outW = clampInt(props, "outWidth", 16, 1, 32);
  const mode = propStr(props, "mode", "sign");
  const sub = mode === "sign" ? "sign" : mode === "zero" ? "zero" : "ones";
  return layoutBox(
    {
      left: [{ id: "in", name: "A", dir: "in", width: inW }],
      right: [{ id: "out", name: "Y", dir: "out", width: outW }],
      title: "EXT",
      subtitle: `${inW}→${outW} ${sub}`,
      minBodyW: 60,
      minBodyH: 40,
    },
    props,
  );
}

const bitExtenderDef: ComponentDef = {
  type: "bit-extender",
  name: "Bit Extender",
  category: "Arithmetic",
  labelPrefix: "EXT",
  description: "Widens (or truncates) a bus: sign extension copies the top bit, zero extension adds 0s, or fill with ones",
  props: [
    { key: "inWidth", label: "Input Width", kind: "int", min: 1, max: 32 },
    { key: "outWidth", label: "Output Width", kind: "int", min: 1, max: 32 },
    {
      key: "mode",
      label: "Extension",
      kind: "enum",
      options: [
        { value: "sign", label: "Sign extend" },
        { value: "zero", label: "Zero extend" },
        { value: "one", label: "Fill with ones" },
      ],
    },
  ],
  defaultProps: { inWidth: 8, outWidth: 16, mode: "sign" },
  resizable: "both",
  geometry: (props) => extenderLayout(props).geometry,
  symbol: (props) => renderBox(extenderLayout(props)),
};

function parityLayout(props: Record<string, PropValue>): BoxLayout {
  const n = clampInt(props, "inputs", 8, 2, 16);
  const left: PinSpec[] = Array.from({ length: n }, (_, i) => ({ id: `in${i}`, name: `I${i}`, dir: "in" as const }));
  const right: PinSpec[] = [
    { id: "even", name: "EVEN", dir: "out" },
    { id: "odd", name: "ODD", dir: "out" },
  ];
  return layoutBox({ left, right, title: "PARITY", minBodyW: 80, minBodyH: 50 }, props);
}

const parityDef: ComponentDef = {
  type: "parity",
  name: "Parity Generator / Checker",
  category: "Arithmetic",
  labelPrefix: "PAR",
  description: "ODD is 1 when an odd number of inputs are 1 (the XOR of all inputs); EVEN is its inverse",
  props: [{ key: "inputs", label: "Inputs", kind: "int", min: 2, max: 16 }],
  defaultProps: { inputs: 8 },
  resizable: "both",
  geometry: (props) => parityLayout(props).geometry,
  symbol: (props) => renderBox(parityLayout(props)),
};

function bcd7Layout(props: Record<string, PropValue>): BoxLayout {
  const mode = propStr(props, "pinMode", "bits");
  const activeLow = propBool(props, "activeLow", false);
  const controls = propBool(props, "controls", false);
  const left: PinSpec[] =
    mode === "bus"
      ? [{ id: "bcd", name: "BCD", dir: "in", width: 4 }]
      : [3, 2, 1, 0].map((i) => ({ id: `bcd${i}`, name: `D${i}`, dir: "in" as const }));
  const right: PinSpec[] = ["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ id: s, name: s, dir: "out" as const, inverted: activeLow, overbar: false }));
  const bottom: PinSpec[] = controls
    ? [
        { id: "lt", name: "LT", dir: "in", inverted: true, overbar: true },
        { id: "bi", name: "BI", dir: "in", inverted: true, overbar: true },
      ]
    : [];
  return layoutBox({ left, right, bottom, title: "BCD/7SEG", minBodyW: 90, minBodyH: 60 }, props);
}

const bcd7Def: ComponentDef = {
  type: "bcd-7seg",
  name: "BCD to 7-Segment Decoder",
  category: "Plexers",
  labelPrefix: "DEC",
  description: "Turns a BCD digit (0 to 9) into segment signals a to g for a 7-segment display (like the 7447 / 7448). Active-low outputs drive a common-anode display; LT' lights every segment, BI' blanks them",
  props: [
    PIN_MODE_PROP,
    { key: "activeLow", label: "Active-Low Outputs", kind: "bool" },
    { key: "controls", label: "LT / BI Inputs", kind: "bool" },
  ],
  defaultProps: { pinMode: "bits", activeLow: false, controls: false },
  resizable: "both",
  geometry: (props) => bcd7Layout(props).geometry,
  symbol: (props) => renderBox(bcd7Layout(props)),
};

export const arithExtraDefs: ComponentDef[] = [incrementerDef, decrementerDef, negatorDef, dividerDef, bitExtenderDef, parityDef];
export const plexerExtraDefs: ComponentDef[] = [bcd7Def];

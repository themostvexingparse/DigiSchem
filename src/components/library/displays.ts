/**
 * Displays and manual inputs: 7-Segment Display, Hex Digit Display, LED Bar, Push Button and
 * DIP Switch.
 */
import type { ComponentDef, Geometry } from "../../model/component-def";
import { escapeXml, propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, layoutBox, PIN_MODE_PROP, renderBox, type BoxLayout, type PinSpec } from "./helpers";

// ---- seven-segment digit drawing -------------------------------------------------------------

/** Hexagonal segment between two points on one axis, thickness t. */
function segment(x1: number, y1: number, x2: number, y2: number, t: number): string {
  const h = t / 2;
  if (y1 === y2) {
    return `<path class="ds-line" d="M${x1} ${y1} L${x1 + h} ${y1 - h} L${x2 - h} ${y1 - h} L${x2} ${y1} L${x2 - h} ${y1 + h} L${x1 + h} ${y1 + h} Z"/>`;
  }
  return `<path class="ds-line" d="M${x1} ${y1} L${x1 + h} ${y1 + h} L${x1 + h} ${y2 - h} L${x1} ${y2} L${x1 - h} ${y2 - h} L${x1 - h} ${y1 + h} Z"/>`;
}

/** An "8." digit (segments a-g, optional decimal point) in the box x..x+w, y..y+h. */
function digitGlyph(x: number, y: number, w: number, h: number, dp: boolean): string {
  const t = Math.max(4, Math.min(7, w / 7));
  const g = 1.5; // gap between segments
  const xl = x, xr = x + w, yt = y, ym = y + h / 2, yb = y + h;
  let s = "";
  s += segment(xl + g, yt, xr - g, yt, t); // a
  s += segment(xr, yt + g, xr, ym - g, t); // b
  s += segment(xr, ym + g, xr, yb - g, t); // c
  s += segment(xl + g, yb, xr - g, yb, t); // d
  s += segment(xl, ym + g, xl, yb - g, t); // e
  s += segment(xl, yt + g, xl, ym - g, t); // f
  s += segment(xl + g, ym, xr - g, ym, t); // g
  if (dp) s += `<circle class="ds-line" cx="${xr + t + 2}" cy="${yb}" r="${t / 2 + 0.5}"/>`;
  return s;
}

const SEG_NAMES = ["a", "b", "c", "d", "e", "f", "g"];

function sevenSegLayout(props: Record<string, PropValue>): BoxLayout {
  const dp = propBool(props, "decimalPoint", true);
  const activeLow = propStr(props, "common", "cathode") === "anode";
  const left: PinSpec[] = SEG_NAMES.map((n) => ({ id: n, name: n, dir: "in" as const, inverted: activeLow, overbar: false }));
  if (dp) left.push({ id: "dp", name: "dp", dir: "in", inverted: activeLow, overbar: false });
  return layoutBox({ left, minBodyW: 90, minBodyH: 160 });
}

const sevenSegDef: ComponentDef = {
  type: "seven-segment",
  name: "7-Segment Display",
  category: "Displays",
  labelPrefix: "DISP",
  description: "Seven-segment display with one input per segment (a to g) and an optional decimal point",
  props: [
    { key: "decimalPoint", label: "Decimal Point (dp)", kind: "bool" },
    {
      key: "common",
      label: "Type",
      kind: "enum",
      options: [
        { value: "cathode", label: "Common cathode (segment on at 1)" },
        { value: "anode", label: "Common anode (segment on at 0)" },
      ],
    },
  ],
  defaultProps: { decimalPoint: true, common: "cathode" },
  geometry: (props) => sevenSegLayout(props).geometry,
  symbol(props) {
    const L = sevenSegLayout(props);
    const dp = propBool(props, "decimalPoint", true);
    const gx = L.bodyX + 34, gw = 34, gy = L.bodyY + 24, gh = L.bodyH - 48;
    return renderBox(L, digitGlyph(gx, gy, gw, gh, dp));
  },
};

function hexDisplayLayout(props: Record<string, PropValue>): BoxLayout {
  const mode = propStr(props, "pinMode", "bus");
  const dp = propBool(props, "decimalPoint", false);
  const left: PinSpec[] =
    mode === "bits"
      ? [0, 1, 2, 3].map((i) => ({ id: `d${i}`, name: `D${i}`, dir: "in" as const }))
      : [{ id: "d", name: "D", dir: "in", width: 4 }];
  if (dp) left.push({ id: "dp", name: "dp", dir: "in" });
  return layoutBox({ left, minBodyW: 80, minBodyH: 100 });
}

const hexDisplayDef: ComponentDef = {
  type: "hex-display",
  name: "Hex Digit Display",
  category: "Displays",
  labelPrefix: "HEX",
  description: "Shows a 4-bit value as one hexadecimal digit (0 to F), with an optional decimal point",
  props: [PIN_MODE_PROP, { key: "decimalPoint", label: "Decimal Point (dp)", kind: "bool" }],
  defaultProps: { pinMode: "bus", decimalPoint: false },
  geometry: (props) => hexDisplayLayout(props).geometry,
  symbol(props) {
    const L = hexDisplayLayout(props);
    const dp = propBool(props, "decimalPoint", false);
    const gx = L.bodyX + 34, gw = 26, gy = L.bodyY + 18, gh = L.bodyH - 36;
    return renderBox(L, digitGlyph(gx, gy, gw, gh, dp));
  },
};

function ledBarLayout(props: Record<string, PropValue>): BoxLayout {
  const n = clampInt(props, "count", 8, 2, 16);
  const left: PinSpec[] = Array.from({ length: n }, (_, i) => ({ id: `in${i}`, name: String(i), dir: "in" as const }));
  return layoutBox({ left, minBodyW: 50, minBodyH: 40 }, props);
}

const ledBarDef: ComponentDef = {
  type: "led-bar",
  name: "LED Bar",
  category: "Displays",
  labelPrefix: "BAR",
  description: "Row of LEDs, one per input, for watching several signals at once",
  props: [{ key: "count", label: "LEDs", kind: "int", min: 2, max: 16 }],
  defaultProps: { count: 8 },
  resizable: "both",
  geometry: (props) => ledBarLayout(props).geometry,
  symbol(props) {
    const L = ledBarLayout(props);
    const x = L.bodyX + L.bodyW - 26;
    let leds = "";
    for (const p of L.geometry.pins) {
      leds += `<rect class="ds-line" x="${x}" y="${p.y - 4}" width="16" height="8" rx="1.5"/>`;
    }
    return renderBox(L, leds);
  },
};

// ---- manual inputs ----------------------------------------------------------------------------

const pushButtonDef: ComponentDef = {
  type: "push-button",
  name: "Push Button",
  category: "I/O",
  labelPrefix: "BTN",
  description: "Momentary push button: outputs 1 while pressed (or 0 when set to active low)",
  props: [
    { key: "name", label: "Label", kind: "string" },
    { key: "activeLow", label: "Active Low", kind: "bool" },
  ],
  defaultProps: { name: "", activeLow: false },
  geometry(props): Geometry {
    const named = propStr(props, "name", "").trim() !== "";
    return {
      width: 40,
      height: named ? 40 : 30,
      pins: [{ id: "out", name: "OUT", x: 40, y: 20, dir: "out", side: "right", inverted: propBool(props, "activeLow", false) }],
    };
  },
  symbol(props): string {
    const name = propStr(props, "name", "");
    const low = propBool(props, "activeLow", false);
    const body = `<rect class="ds-body" x="2" y="10" width="20" height="20" rx="3"/>` + `<circle class="ds-line" cx="12" cy="20" r="5.5"/>`;
    const stub = low
      ? `<circle class="ds-bubble" cx="26" cy="20" r="4"/><line class="ds-pin" x1="30" y1="20" x2="40" y2="20"/>`
      : `<line class="ds-pin" x1="22" y1="20" x2="40" y2="20"/>`;
    const txt = name ? `<text class="ds-text" x="12" y="39" text-anchor="middle">${escapeXml(name)}</text>` : "";
    return body + stub + txt;
  },
};

function dipLayout(props: Record<string, PropValue>): BoxLayout {
  const n = clampInt(props, "count", 4, 1, 16);
  const right: PinSpec[] = Array.from({ length: n }, (_, i) => ({ id: `out${i}`, name: String(i), dir: "out" as const }));
  return layoutBox({ right, minBodyW: 50, minBodyH: 40 }, props);
}

const dipSwitchDef: ComponentDef = {
  type: "dip-switch",
  name: "DIP Switch",
  category: "I/O",
  labelPrefix: "SW",
  description: "Bank of on/off switches, one output each, for setting input values by hand",
  props: [{ key: "count", label: "Switches", kind: "int", min: 1, max: 16 }],
  defaultProps: { count: 4 },
  resizable: "both",
  geometry: (props) => dipLayout(props).geometry,
  symbol(props) {
    const L = dipLayout(props);
    const x = L.bodyX + 8;
    let sw = "";
    for (const p of L.geometry.pins) {
      // a slot with the slider in the "on" position (right)
      sw += `<rect class="ds-line" x="${x}" y="${p.y - 4}" width="20" height="8" rx="1"/>`;
      sw += `<rect class="ds-thin" x="${x + 11}" y="${p.y - 3}" width="8" height="6"/>`;
    }
    return renderBox(L, sw);
  },
};

export const displayDefs: ComponentDef[] = [sevenSegDef, hexDisplayDef, ledBarDef, pushButtonDef, dipSwitchDef];

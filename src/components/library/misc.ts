/**
 * Miscellaneous components: user-definable Generic Block / Subcircuit box,
 * Pull-Up Resistor, and Pull-Down Resistor.
 */
import type { ComponentDef, Geometry } from "../../model/component-def";
import { escapeXml, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, layoutBox, renderBox, type PinSpec } from "./helpers";

function parseNames(csv: string): string[] {
  if (!csv.trim()) return [];
  return csv.split(",").map((s) => s.trim());
}

function genericBlockLayout(props: Record<string, PropValue>) {
  const title = propStr(props, "title", "BLOCK");
  const inputs = clampInt(props, "inputs", 2, 0, 32);
  const outputs = clampInt(props, "outputs", 1, 0, 32);
  const inNames = parseNames(propStr(props, "inputNames", "A, B"));
  const outNames = parseNames(propStr(props, "outputNames", "Y"));

  const left: PinSpec[] = [];
  for (let i = 0; i < inputs; i++) {
    const name = inNames[i] || `I${i}`;
    left.push({ id: `in${i}`, name, dir: "in" });
  }
  const right: PinSpec[] = [];
  for (let i = 0; i < outputs; i++) {
    const name = outNames[i] || `O${i}`;
    right.push({ id: `out${i}`, name, dir: "out" });
  }

  return layoutBox(
    {
      left,
      right,
      title: title || "BLOCK",
      minBodyW: 80,
      minBodyH: 50,
    },
    props,
  );
}

const genericBlockDef: ComponentDef = {
  type: "generic-block",
  name: "Generic Block",
  category: "Misc",
  labelPrefix: "BLK",
  description: "Fully user-definable subcircuit / black-box block with custom title and named inputs/outputs",
  props: [
    { key: "title", label: "Title", kind: "string" },
    { key: "inputs", label: "Inputs", kind: "int", min: 0, max: 32 },
    { key: "outputs", label: "Outputs", kind: "int", min: 0, max: 32 },
    { key: "inputNames", label: "Input Names (CSV)", kind: "string" },
    { key: "outputNames", label: "Output Names (CSV)", kind: "string" },
  ],
  defaultProps: {
    title: "BLOCK",
    inputs: 2,
    outputs: 1,
    inputNames: "A, B",
    outputNames: "Y",
  },
  resizable: "both",
  geometry: (props) => genericBlockLayout(props).geometry,
  symbol: (props) => renderBox(genericBlockLayout(props)),
};

/** IEEE/ANSI zigzag resistor centered at x=20 from y=14 to y=36. */
const RESISTOR_ZIGZAG =
  `<path class="ds-line" d="M20 14 L20 16 L25 18 L15 22 L25 26 L15 30 L25 34 L20 36 L20 38"/>`;

const pullUpDef: ComponentDef = {
  type: "pull-up",
  name: "Pull-Up Resistor",
  category: "Misc",
  labelPrefix: "R",
  description: "Pull-up resistor connected to VCC/VDD",
  props: [{ key: "label", label: "Resistance", kind: "string" }],
  defaultProps: { label: "10k" },
  geometry(): Geometry {
    return {
      width: 60,
      height: 50,
      pins: [{ id: "out", name: "OUT", x: 20, y: 50, dir: "out", side: "bottom" }],
    };
  },
  symbol(props): string {
    const label = propStr(props, "label", "10k");
    return (
      `<line class="ds-line" x1="12" y1="6" x2="28" y2="6"/>` +
      `<line class="ds-line" x1="20" y1="6" x2="20" y2="14"/>` +
      RESISTOR_ZIGZAG +
      `<line class="ds-pin" x1="20" y1="38" x2="20" y2="50"/>` +
      (label ? `<text class="ds-text" x="30" y="29" text-anchor="start">${escapeXml(label)}</text>` : "")
    );
  },
};

const pullDownDef: ComponentDef = {
  type: "pull-down",
  name: "Pull-Down Resistor",
  category: "Misc",
  labelPrefix: "R",
  description: "Pull-down resistor connected to Ground",
  props: [{ key: "label", label: "Resistance", kind: "string" }],
  defaultProps: { label: "10k" },
  geometry(): Geometry {
    return {
      width: 60,
      height: 50,
      pins: [{ id: "out", name: "OUT", x: 20, y: 0, dir: "out", side: "top" }],
    };
  },
  symbol(props): string {
    const label = propStr(props, "label", "10k");
    return (
      `<line class="ds-pin" x1="20" y1="0" x2="20" y2="14"/>` +
      RESISTOR_ZIGZAG +
      `<line class="ds-line" x1="20" y1="38" x2="20" y2="42"/>` +
      `<line class="ds-line" x1="12" y1="42" x2="28" y2="42"/>` +
      `<line class="ds-line" x1="15" y1="45" x2="25" y2="45"/>` +
      `<line class="ds-line" x1="18" y1="48" x2="22" y2="48"/>` +
      (label ? `<text class="ds-text" x="30" y="29" text-anchor="start">${escapeXml(label)}</text>` : "")
    );
  },
};

export const miscDefs: ComponentDef[] = [genericBlockDef, pullUpDef, pullDownDef];

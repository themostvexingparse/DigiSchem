/**
 * Latch components: SR Latch (with optional active-low S'R' variant),
 * D Latch, and Gated SR Latch.
 */
import type { ComponentDef } from "../../model/component-def";
import { propBool } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, layoutBox, renderBox, type PinSpec } from "./helpers";

function srLatchLayout(props: Record<string, PropValue>) {
  const activeLow = propBool(props, "activeLow", false);
  const showQBar = propBool(props, "showQBar", true);

  const left: PinSpec[] = [
    { id: "s", name: "S", dir: "in", inverted: activeLow, overbar: activeLow },
    { id: "r", name: "R", dir: "in", inverted: activeLow, overbar: activeLow },
  ];
  const right: PinSpec[] = [{ id: "q", name: "Q", dir: "out" }];
  if (showQBar) {
    right.push({ id: "qn", name: "Q", dir: "out", inverted: true, overbar: true });
  }

  return layoutBox(
    {
      left,
      right,
      title: "SR",
      subtitle: "Latch",
      minBodyW: 60,
      minBodyH: 60,
    },
    props,
  );
}

const srLatchDef: ComponentDef = {
  type: "sr-latch",
  name: "SR Latch",
  category: "Latches",
  labelPrefix: "L",
  description: "Set-Reset latch with optional active-low S'/R' inputs and inverted Q output",
  props: [
    { key: "activeLow", label: "Active-Low (S'R')", kind: "bool" },
    { key: "showQBar", label: "Show Q' Output", kind: "bool" },
  ],
  defaultProps: { activeLow: false, showQBar: true },
  resizable: "both",
  geometry: (props) => srLatchLayout(props).geometry,
  symbol: (props) => renderBox(srLatchLayout(props)),
};

function dLatchLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 1, 1, 32);
  const activeLowEn = propBool(props, "activeLowEnable", false);
  const showQBar = propBool(props, "showQBar", true);

  const left: PinSpec[] = [
    { id: "d", name: "D", dir: "in", width },
    { id: "en", name: "EN", dir: "in", inverted: activeLowEn, overbar: activeLowEn },
  ];
  const right: PinSpec[] = [{ id: "q", name: "Q", dir: "out", width }];
  if (showQBar) {
    right.push({ id: "qn", name: "Q", dir: "out", width, inverted: true, overbar: true });
  }

  return layoutBox(
    {
      left,
      right,
      title: "D",
      subtitle: width > 1 ? `${width}-bit` : "Latch",
      minBodyW: 60,
      minBodyH: 60,
    },
    props,
  );
}

const dLatchDef: ComponentDef = {
  type: "d-latch",
  name: "D Latch",
  category: "Latches",
  labelPrefix: "L",
  description: "Level-sensitive transparent D latch with enable and optional Q' output",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
    { key: "activeLowEnable", label: "Active-Low Enable", kind: "bool" },
    { key: "showQBar", label: "Show Q' Output", kind: "bool" },
  ],
  defaultProps: { width: 1, activeLowEnable: false, showQBar: true },
  resizable: "both",
  geometry: (props) => dLatchLayout(props).geometry,
  symbol: (props) => renderBox(dLatchLayout(props)),
};

function gatedSrLatchLayout(props: Record<string, PropValue>) {
  const activeLowEn = propBool(props, "activeLowEnable", false);
  const showQBar = propBool(props, "showQBar", true);

  const left: PinSpec[] = [
    { id: "s", name: "S", dir: "in" },
    { id: "en", name: "EN", dir: "in", inverted: activeLowEn, overbar: activeLowEn },
    { id: "r", name: "R", dir: "in" },
  ];
  const right: PinSpec[] = [{ id: "q", name: "Q", dir: "out" }];
  if (showQBar) {
    right.push({ id: "qn", name: "Q", dir: "out", inverted: true, overbar: true });
  }

  return layoutBox(
    {
      left,
      right,
      title: "SR",
      subtitle: "Gated",
      minBodyW: 60,
      minBodyH: 70,
    },
    props,
  );
}

const gatedSrLatchDef: ComponentDef = {
  type: "gated-sr-latch",
  name: "Gated SR Latch",
  category: "Latches",
  labelPrefix: "L",
  description: "Level-enabled SR latch with enable pin and optional Q' output",
  props: [
    { key: "activeLowEnable", label: "Active-Low Enable", kind: "bool" },
    { key: "showQBar", label: "Show Q' Output", kind: "bool" },
  ],
  defaultProps: { activeLowEnable: false, showQBar: true },
  resizable: "both",
  geometry: (props) => gatedSrLatchLayout(props).geometry,
  symbol: (props) => renderBox(gatedSrLatchLayout(props)),
};

export const latchDefs: ComponentDef[] = [srLatchDef, dLatchDef, gatedSrLatchDef];

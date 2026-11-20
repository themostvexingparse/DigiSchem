/**
 * Flip-Flop components: D, JK, T, and SR edge-triggered flip-flops
 * with configurable clock edge, asynchronous set/reset, enable, and Q' output.
 */
import type { ComponentDef, PropDef } from "../../model/component-def";
import { propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { layoutBox, renderBox, type PinSpec } from "./helpers";

type FfKind = "d" | "jk" | "t" | "sr";

const ASYNC_OPTIONS = [
  { value: "none", label: "None" },
  { value: "active-high", label: "Active-High" },
  { value: "active-low", label: "Active-Low" },
];

const FF_PROPS: PropDef[] = [
  {
    key: "edge",
    label: "Clock Edge",
    kind: "enum",
    options: [
      { value: "rising", label: "Rising Edge" },
      { value: "falling", label: "Falling Edge" },
    ],
  },
  { key: "asyncReset", label: "Async Reset", kind: "enum", options: ASYNC_OPTIONS },
  { key: "asyncSet", label: "Async Set", kind: "enum", options: ASYNC_OPTIONS },
  { key: "enable", label: "Enable Pin (EN)", kind: "bool" },
  { key: "showQBar", label: "Show Q' Output", kind: "bool" },
];

const FF_DEFAULT_PROPS: Record<string, PropValue> = {
  edge: "rising",
  asyncReset: "none",
  asyncSet: "none",
  enable: false,
  showQBar: true,
};

function ffLayout(kind: FfKind, props: Record<string, PropValue>) {
  const falling = propStr(props, "edge", "rising") === "falling";
  const asyncReset = propStr(props, "asyncReset", "none");
  const asyncSet = propStr(props, "asyncSet", "none");
  const enable = propBool(props, "enable", false);
  const showQBar = propBool(props, "showQBar", true);

  const clkPin: PinSpec = { id: "clk", name: "", dir: "in", clock: true, inverted: falling };
  const left: PinSpec[] = [];
  if (kind === "d") {
    left.push({ id: "d", name: "D", dir: "in" });
    if (enable) left.push({ id: "en", name: "EN", dir: "in" });
    left.push(clkPin);
  } else if (kind === "t") {
    left.push({ id: "t", name: "T", dir: "in" });
    if (enable) left.push({ id: "en", name: "EN", dir: "in" });
    left.push(clkPin);
  } else if (kind === "jk") {
    left.push({ id: "j", name: "J", dir: "in" });
    left.push(clkPin);
    left.push({ id: "k", name: "K", dir: "in" });
    if (enable) left.push({ id: "en", name: "EN", dir: "in" });
  } else {
    left.push({ id: "s", name: "S", dir: "in" });
    left.push(clkPin);
    left.push({ id: "r", name: "R", dir: "in" });
    if (enable) left.push({ id: "en", name: "EN", dir: "in" });
  }

  const right: PinSpec[] = [{ id: "q", name: "Q", dir: "out" }];
  if (showQBar) {
    right.push({ id: "qn", name: "Q", dir: "out", inverted: true, overbar: true });
  }

  const top: PinSpec[] = [];
  if (asyncSet === "active-high" || asyncSet === "active-low") {
    const low = asyncSet === "active-low";
    top.push({ id: "set", name: "SET", dir: "in", inverted: low, overbar: low });
  }

  const bottom: PinSpec[] = [];
  if (asyncReset === "active-high" || asyncReset === "active-low") {
    const low = asyncReset === "active-low";
    bottom.push({ id: "rst", name: "RST", dir: "in", inverted: low, overbar: low });
  }

  return layoutBox({
    left,
    right,
    top,
    bottom,
    minBodyW: 60,
    minBodyH: 60,
  });
}

function makeFlipFlop(type: string, name: string, kind: FfKind): ComponentDef {
  return {
    type,
    name,
    category: "Flip-Flops",
    labelPrefix: "FF",
    description: `${name} with configurable clock edge, async set/reset, enable, and Q' output`,
    props: FF_PROPS,
    defaultProps: FF_DEFAULT_PROPS,
    geometry: (props) => ffLayout(kind, props).geometry,
    symbol: (props) => renderBox(ffLayout(kind, props)),
  };
}

export const flipflopDefs: ComponentDef[] = [
  makeFlipFlop("d-ff", "D Flip-Flop", "d"),
  makeFlipFlop("jk-ff", "JK Flip-Flop", "jk"),
  makeFlipFlop("t-ff", "T Flip-Flop", "t"),
  makeFlipFlop("sr-ff", "SR Flip-Flop", "sr"),
];

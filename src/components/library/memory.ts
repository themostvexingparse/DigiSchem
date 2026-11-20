/**
 * Memory components: RAM (separate or shared data port) and ROM.
 */
import type { ComponentDef, PinDir } from "../../model/component-def";
import { propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, formatWords, layoutBox, PIN_MODE_PROP, renderBox, type PinSpec } from "./helpers";

function expandMemPins(prefix: string, label: string, width: number, dir: PinDir, mode: string): PinSpec[] {
  if (mode === "bits") {
    return Array.from({ length: width }, (_, i) => ({
      id: `${prefix}${i}`,
      name: `${label}${i}`,
      dir,
      width: 1,
    }));
  }
  return [{ id: prefix, name: label, dir, width }];
}

function ramLayout(props: Record<string, PropValue>) {
  const addrBits = clampInt(props, "addressBits", 8, 1, 16);
  const dataW = clampInt(props, "dataWidth", 8, 1, 32);
  const dataPortMode = propStr(props, "dataPortMode", "separate");
  const mode = propStr(props, "pinMode", "bus");
  const chipSelect = propBool(props, "chipSelect", false);

  const left: PinSpec[] = [...expandMemPins("a", "A", addrBits, "in", mode)];
  if (dataPortMode === "separate") {
    left.push(...expandMemPins("wd", "WD", dataW, "in", mode));
  }
  left.push({ id: "clk", name: "CLK", dir: "in", clock: true });

  const top: PinSpec[] = [{ id: "we", name: "WE", dir: "in" }];
  if (dataPortMode === "shared") {
    top.push({ id: "oe", name: "OE", dir: "in" });
  }

  const right: PinSpec[] =
    dataPortMode === "separate"
      ? expandMemPins("rd", "RD", dataW, "out", mode)
      : expandMemPins("dq", "D", dataW, "inout", mode);

  const bottom: PinSpec[] = chipSelect ? [{ id: "cs", name: "CS", dir: "in" }] : [];

  return layoutBox(
    {
      left,
      right,
      top,
      bottom,
      title: "RAM",
      subtitle: `${formatWords(1 << addrBits)}×${dataW}`,
      minBodyW: 90,
      minBodyH: 80,
      tbSpacing: 30,
    },
    props,
  );
}

const ramDef: ComponentDef = {
  type: "ram",
  name: "RAM",
  category: "Memory",
  labelPrefix: "RAM",
  description: "Synchronous Random-Access Memory with separate or shared bidirectional data port",
  props: [
    { key: "addressBits", label: "Address Bits", kind: "int", min: 1, max: 16 },
    { key: "dataWidth", label: "Data Width", kind: "int", min: 1, max: 32 },
    {
      key: "dataPortMode",
      label: "Data Port",
      kind: "enum",
      options: [
        { value: "separate", label: "Separate WD / RD" },
        { value: "shared", label: "Shared Bidirectional D" },
      ],
    },
    PIN_MODE_PROP,
    { key: "chipSelect", label: "Chip Select (CS)", kind: "bool" },
  ],
  defaultProps: {
    addressBits: 8,
    dataWidth: 8,
    dataPortMode: "separate",
    pinMode: "bus",
    chipSelect: false,
  },
  resizable: "both",
  geometry: (props) => ramLayout(props).geometry,
  symbol: (props) => renderBox(ramLayout(props)),
};

function romLayout(props: Record<string, PropValue>) {
  const addrBits = clampInt(props, "addressBits", 8, 1, 16);
  const dataW = clampInt(props, "dataWidth", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const chipSelect = propBool(props, "chipSelect", false);

  const left: PinSpec[] = expandMemPins("a", "A", addrBits, "in", mode);
  const right: PinSpec[] = expandMemPins("d", "D", dataW, "out", mode);
  const bottom: PinSpec[] = chipSelect ? [{ id: "cs", name: "CS", dir: "in" }] : [];

  return layoutBox(
    {
      left,
      right,
      bottom,
      title: "ROM",
      subtitle: `${formatWords(1 << addrBits)}×${dataW}`,
      minBodyW: 80,
      minBodyH: 60,
    },
    props,
  );
}

const romDef: ComponentDef = {
  type: "rom",
  name: "ROM",
  category: "Memory",
  labelPrefix: "ROM",
  description: "Read-Only Memory block with configurable address width and data width",
  props: [
    { key: "addressBits", label: "Address Bits", kind: "int", min: 1, max: 16 },
    { key: "dataWidth", label: "Data Width", kind: "int", min: 1, max: 32 },
    PIN_MODE_PROP,
    { key: "chipSelect", label: "Chip Select (CS)", kind: "bool" },
  ],
  defaultProps: {
    addressBits: 8,
    dataWidth: 8,
    pinMode: "bus",
    chipSelect: false,
  },
  resizable: "both",
  geometry: (props) => romLayout(props).geometry,
  symbol: (props) => renderBox(romLayout(props)),
};

export const memoryDefs: ComponentDef[] = [ramDef, romDef];

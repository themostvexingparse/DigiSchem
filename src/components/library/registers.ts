/**
 * Register components: N-bit Register, Shift Register, Counter, and multi-port Register File.
 * All support bus vs individual-bit pin expansion so every pin is individually connectable.
 */
import type { ComponentDef } from "../../model/component-def";
import { propBool, propStr } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import { clampInt, layoutBox, PIN_MODE_PROP, renderBox, type PinSpec } from "./helpers";

function expandPins(prefix: string, label: string, width: number, dir: "in" | "out", mode: string): PinSpec[] {
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

function registerLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const enable = propBool(props, "enable", true);
  const reset = propBool(props, "reset", true);
  const falling = propStr(props, "edge", "rising") === "falling";

  const left: PinSpec[] = [...expandPins("d", "D", width, "in", mode)];
  if (enable) left.push({ id: "en", name: "EN", dir: "in" });
  left.push({ id: "clk", name: "CLK", dir: "in", clock: true, inverted: falling });

  const right: PinSpec[] = expandPins("q", "Q", width, "out", mode);
  const bottom: PinSpec[] = reset ? [{ id: "rst", name: "RST", dir: "in" }] : [];

  return layoutBox({
    left,
    right,
    bottom,
    title: "REG",
    subtitle: `${width}-bit`,
    minBodyW: 70,
    minBodyH: 60,
  });
}

const registerDef: ComponentDef = {
  type: "register",
  name: "N-bit Register",
  category: "Registers",
  labelPrefix: "REG",
  description: "Parametric N-bit synchronous register with bus or per-bit pins, enable, and reset",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
    PIN_MODE_PROP,
    { key: "enable", label: "Enable Pin (EN)", kind: "bool" },
    { key: "reset", label: "Reset Pin (RST)", kind: "bool" },
    {
      key: "edge",
      label: "Clock Edge",
      kind: "enum",
      options: [
        { value: "rising", label: "Rising Edge" },
        { value: "falling", label: "Falling Edge" },
      ],
    },
  ],
  defaultProps: { width: 8, pinMode: "bus", enable: true, reset: true, edge: "rising" },
  geometry: (props) => registerLayout(props).geometry,
  symbol: (props) => renderBox(registerLayout(props)),
};

function shiftRegisterLayout(props: Record<string, PropValue>) {
  const width = clampInt(props, "width", 8, 2, 32);
  const dir = propStr(props, "direction", "right");
  const parallelLoad = propBool(props, "parallelLoad", false);
  const parallelOut = propBool(props, "parallelOut", true);
  const mode = propStr(props, "pinMode", "bus");
  const reset = propBool(props, "reset", true);

  const left: PinSpec[] = [];
  if (dir === "bidirectional") {
    left.push({ id: "sil", name: "SIL", dir: "in" });
    left.push({ id: "sir", name: "SIR", dir: "in" });
    left.push({ id: "dir", name: "DIR", dir: "in" });
  } else {
    left.push({ id: "sin", name: "SI", dir: "in" });
  }
  if (parallelLoad) {
    left.push({ id: "load", name: "LOAD", dir: "in" });
    left.push(...expandPins("d", "D", width, "in", mode));
  }
  left.push({ id: "clk", name: "CLK", dir: "in", clock: true });

  const right: PinSpec[] = [{ id: "sout", name: "SO", dir: "out" }];
  if (parallelOut) {
    right.push(...expandPins("q", "Q", width, "out", mode));
  }

  const bottom: PinSpec[] = reset ? [{ id: "rst", name: "RST", dir: "in" }] : [];

  const dirTag = dir === "left" ? "<<" : dir === "bidirectional" ? "<->" : ">>";
  return layoutBox({
    left,
    right,
    bottom,
    title: "SHIFT",
    subtitle: `${width}-bit ${dirTag}`,
    minBodyW: 80,
    minBodyH: 60,
  });
}

const shiftRegisterDef: ComponentDef = {
  type: "shift-register",
  name: "Shift Register",
  category: "Registers",
  labelPrefix: "SREG",
  description: "N-bit serial/parallel shift register with configurable shift direction and parallel load",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 2, max: 32 },
    {
      key: "direction",
      label: "Shift Direction",
      kind: "enum",
      options: [
        { value: "right", label: "Shift Right (>>)" },
        { value: "left", label: "Shift Left (<<)" },
        { value: "bidirectional", label: "Bidirectional (<->)" },
      ],
    },
    { key: "parallelLoad", label: "Parallel Load", kind: "bool" },
    { key: "parallelOut", label: "Parallel Output", kind: "bool" },
    PIN_MODE_PROP,
    { key: "reset", label: "Reset Pin (RST)", kind: "bool" },
  ],
  defaultProps: {
    width: 8,
    direction: "right",
    parallelLoad: false,
    parallelOut: true,
    pinMode: "bus",
    reset: true,
  },
  geometry: (props) => shiftRegisterLayout(props).geometry,
  symbol: (props) => renderBox(shiftRegisterLayout(props)),
};

function counterLayout(props: Record<string, PropValue>) {
  const bits = clampInt(props, "bits", 4, 1, 32);
  const mode = propStr(props, "pinMode", "bus");
  const upDown = propBool(props, "upDown", false);
  const load = propBool(props, "load", false);
  const enable = propBool(props, "enable", true);
  const reset = propBool(props, "reset", true);
  const carryOut = propBool(props, "carryOut", true);

  const left: PinSpec[] = [];
  if (load) {
    left.push(...expandPins("d", "D", bits, "in", mode));
    left.push({ id: "load", name: "LOAD", dir: "in" });
  }
  if (enable) left.push({ id: "en", name: "EN", dir: "in" });
  if (upDown) left.push({ id: "ud", name: "U/D", dir: "in" });
  left.push({ id: "clk", name: "CLK", dir: "in", clock: true });

  const right: PinSpec[] = [...expandPins("q", "Q", bits, "out", mode)];
  if (carryOut) right.push({ id: "rco", name: "RCO", dir: "out" });

  const bottom: PinSpec[] = reset ? [{ id: "rst", name: "RST", dir: "in" }] : [];

  return layoutBox({
    left,
    right,
    bottom,
    title: "CNT",
    subtitle: `${bits}-bit`,
    minBodyW: 70,
    minBodyH: 60,
  });
}

const counterDef: ComponentDef = {
  type: "counter",
  name: "Counter",
  category: "Registers",
  labelPrefix: "CNT",
  description: "Parametric N-bit binary counter with optional up/down, parallel load, enable, reset, and carry-out",
  props: [
    { key: "bits", label: "Bit Width", kind: "int", min: 1, max: 32 },
    PIN_MODE_PROP,
    { key: "upDown", label: "Up/Down Pin", kind: "bool" },
    { key: "load", label: "Parallel Load", kind: "bool" },
    { key: "enable", label: "Enable Pin (EN)", kind: "bool" },
    { key: "reset", label: "Reset Pin (RST)", kind: "bool" },
    { key: "carryOut", label: "Carry Out (RCO)", kind: "bool" },
  ],
  defaultProps: {
    bits: 4,
    pinMode: "bus",
    upDown: false,
    load: false,
    enable: true,
    reset: true,
    carryOut: true,
  },
  geometry: (props) => counterLayout(props).geometry,
  symbol: (props) => renderBox(counterLayout(props)),
};

function registerFileLayout(props: Record<string, PropValue>) {
  const addrBits = clampInt(props, "addressBits", 5, 1, 6);
  const dataW = clampInt(props, "dataWidth", 32, 1, 32);
  const readPorts = clampInt(props, "readPorts", 2, 1, 4);
  const writePorts = clampInt(props, "writePorts", 1, 1, 2);
  const mode = propStr(props, "pinMode", "bus");

  const left: PinSpec[] = [];
  for (let i = 1; i <= readPorts; i++) {
    if (mode === "bits") {
      for (let b = 0; b < addrBits; b++) {
        left.push({ id: `ra${i}_${b}`, name: `RA${i}[${b}]`, dir: "in", width: 1 });
      }
    } else {
      left.push({ id: `ra${i}`, name: `RA${i}`, dir: "in", width: addrBits });
    }
  }
  for (let j = 1; j <= writePorts; j++) {
    if (mode === "bits") {
      for (let b = 0; b < addrBits; b++) {
        left.push({ id: `wa${j}_${b}`, name: `WA${j}[${b}]`, dir: "in", width: 1 });
      }
      for (let b = 0; b < dataW; b++) {
        left.push({ id: `wd${j}_${b}`, name: `WD${j}[${b}]`, dir: "in", width: 1 });
      }
    } else {
      left.push({ id: `wa${j}`, name: `WA${j}`, dir: "in", width: addrBits });
      left.push({ id: `wd${j}`, name: `WD${j}`, dir: "in", width: dataW });
    }
  }
  left.push({ id: "clk", name: "CLK", dir: "in", clock: true });

  const top: PinSpec[] = [];
  for (let j = 1; j <= writePorts; j++) {
    top.push({ id: `we${j}`, name: `WE${j}`, dir: "in" });
  }

  const right: PinSpec[] = [];
  for (let i = 1; i <= readPorts; i++) {
    if (mode === "bits") {
      for (let b = 0; b < dataW; b++) {
        right.push({ id: `rd${i}_${b}`, name: `RD${i}[${b}]`, dir: "out", width: 1 });
      }
    } else {
      right.push({ id: `rd${i}`, name: `RD${i}`, dir: "out", width: dataW });
    }
  }

  return layoutBox({
    left,
    right,
    top,
    title: "RegFile",
    subtitle: `${1 << addrBits}×${dataW}`,
    minBodyW: 100,
    minBodyH: 100,
  });
}

const registerFileDef: ComponentDef = {
  type: "register-file",
  name: "Register File",
  category: "Registers",
  labelPrefix: "RF",
  description: "Multi-port register file (MIPS/RISC-V style) with configurable read/write ports, address bits, and width",
  props: [
    { key: "addressBits", label: "Address Bits", kind: "int", min: 1, max: 6 },
    { key: "dataWidth", label: "Data Width", kind: "int", min: 1, max: 32 },
    { key: "readPorts", label: "Read Ports", kind: "int", min: 1, max: 4 },
    { key: "writePorts", label: "Write Ports", kind: "int", min: 1, max: 2 },
    PIN_MODE_PROP,
  ],
  defaultProps: {
    addressBits: 5,
    dataWidth: 32,
    readPorts: 2,
    writePorts: 1,
    pinMode: "bus",
  },
  geometry: (props) => registerFileLayout(props).geometry,
  symbol: (props) => renderBox(registerFileLayout(props)),
};

export const registerDefs: ComponentDef[] = [registerDef, shiftRegisterDef, counterDef, registerFileDef];

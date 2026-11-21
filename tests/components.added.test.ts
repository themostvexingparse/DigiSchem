// Components added for variety (displays, manual inputs, extra arithmetic, Schmitt gates, ring
// counter, CMOS switches): save/load, pin roles, and readable text.
import { describe, expect, it } from "vitest";
import { ALL_DEFS, registerBuiltinComponents } from "../src/components/library";
import { emptyDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { parseProject, serializeProject } from "../src/io/project";
import { connectionConflicts } from "../src/model/links";
import { getDef } from "../src/model/registry";

registerBuiltinComponents();

const ADDED = [
  "seven-segment", "hex-display", "led-bar", "push-button", "dip-switch",
  "schmitt-buffer", "schmitt-inverter", "bcd-7seg",
  "incrementer", "decrementer", "negator", "divider", "bit-extender", "parity",
  "ring-counter", "nmos", "pmos", "transmission-gate",
  "bit-selector", "gray-converter", "bus-transceiver", "aoi", "bit-counter", "carry-lookahead",
  "fifo", "lfsr", "clock-divider", "synchronizer", "edge-detector",
  "decade-counter", "debouncer", "dual-port-ram", "stack", "keypad",
];

describe("added components", () => {
  it("are all registered", () => {
    for (const t of ADDED) expect(getDef(t), t).toBeDefined();
  });

  it("survive save and load with their properties", () => {
    const doc = emptyDocument("added");
    let x = 0;
    for (const t of ADDED) {
      const def = getDef(t)!;
      doc.components.push({ id: `c_${t}`, type: t, x, y: 0, rotation: 0, props: { ...def.defaultProps }, label: `${def.labelPrefix}1` });
      x += def.geometry(def.defaultProps).width + 40;
    }
    const back = parseProject(serializeProject(doc));
    expect(back.components.map((c) => [c.type, c.props])).toEqual(doc.components.map((c) => [c.type, c.props]));
  });

  it("have sensible pin roles: displays only listen, sources only drive, transistor channels are bidirectional", () => {
    const dirs = (t: string) => getDef(t)!.geometry(getDef(t)!.defaultProps).pins.map((p) => p.dir);
    for (const t of ["seven-segment", "hex-display", "led-bar"]) expect(new Set(dirs(t)), t).toEqual(new Set(["in"]));
    for (const t of ["push-button", "dip-switch", "keypad"]) expect(new Set(dirs(t)), t).toEqual(new Set(["out"]));
    // a transceiver's buses are bidirectional: two of them on one bus are not two outputs
    expect(new Set(getDef("bus-transceiver")!.geometry({}).pins.filter((p) => p.id === "a" || p.id === "b").map((p) => p.dir))).toEqual(new Set(["inout"]));
    for (const t of ["nmos", "pmos"]) {
      const pins = getDef(t)!.geometry({}).pins;
      expect(pins.find((p) => p.id === "g")!.dir).toBe("in");
      expect(pins.filter((p) => p.dir === "inout").map((p) => p.id).sort()).toEqual(["d", "s"]);
    }
  });

  it("two transistors sharing a node is not flagged as two outputs wired together", () => {
    // a CMOS inverter: pMOS drain and nMOS drain on the output node
    const doc = emptyDocument("inv");
    doc.components.push({ id: "P", type: "pmos", x: 100, y: 0, rotation: 0, props: {}, label: "M1" });
    doc.components.push({ id: "N", type: "nmos", x: 100, y: 60, rotation: 0, props: {}, label: "M2" });
    const pd = worldPins(doc.components[0]).find((p) => p.pin.id === "d")!.pos;
    const nd = worldPins(doc.components[1]).find((p) => p.pin.id === "d")!.pos;
    expect(pd).toEqual(nd); // drawn touching: pMOS drain (bottom) meets nMOS drain (top)
    doc.links = [["p:N|d", "p:P|d"]];
    expect(connectionConflicts(doc).filter((c) => c.kind === "drivers")).toEqual([]);
  });

  it("no component text uses em dashes", () => {
    for (const def of ALL_DEFS) {
      const texts = [def.name, def.description ?? "", ...def.props.map((p) => p.label), ...def.props.flatMap((p) => p.options?.map((o) => o.label) ?? [])];
      for (const s of texts) expect(s, `${def.type}: "${s}"`).not.toMatch(/[—–]/);
    }
  });
});

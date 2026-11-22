/**
 * A test bench for one part: every input pin of the part is driven by its own input pin (a clock
 * part for clock pins) and every output pin feeds its own output pin, each named after the pin.
 */
import { registerBuiltinComponents } from "../../src/components/library";
import { getDef } from "../../src/model/registry";
import type { PropValue, SchematicDocument } from "../../src/model/types";
import { extractCircuit } from "../../src/logic/circuit";
import { Simulator, type SimOptions } from "../../src/logic/simulate";

export interface Bench {
  sim: Simulator;
  doc: SchematicDocument;
  /** set an input pin of the part (by pin id) */
  set(pin: string, v: number): void;
  /** read an output pin of the part (by pin id): a number, or null when X / Z */
  get(pin: string): number | null;
  settle(): ReturnType<Simulator["settle"]>;
  /** one full clock cycle on `clk` (up, settle, down, settle) */
  tick(): void;
}

export function bench(type: string, props: Record<string, PropValue> = {}, opts: SimOptions = {}): Bench {
  registerBuiltinComponents();
  const def = getDef(type);
  if (!def) throw new Error(`no type ${type}`);
  const all = { ...def.defaultProps, ...props };
  const pins = def.geometry(all).pins;
  const doc: SchematicDocument = {
    format: "digischem",
    version: 1,
    name: type,
    grid: 10,
    components: [{ id: "DUT", type, x: 400, y: 400, rotation: 0, props: all, label: "DUT" }],
    wires: [],
    texts: [],
    links: [],
  };
  pins.forEach((p, i) => {
    const id = `T_${p.id}`;
    const w = p.width ?? 1;
    if (p.dir === "out") {
      doc.components.push({ id, type: "output-pin", x: 0, y: i * 60, rotation: 0, props: { name: id, width: w }, label: "" });
      doc.links!.push([`p:DUT|${p.id}`, `p:${id}|in`]);
    } else if (p.clock) {
      doc.components.push({ id, type: "clock", x: 0, y: i * 60, rotation: 0, props: { name: id }, label: "" });
      doc.links!.push([`p:DUT|${p.id}`, `p:${id}|clk`]);
    } else {
      doc.components.push({ id, type: "input-pin", x: 0, y: i * 60, rotation: 0, props: { name: id, width: w }, label: "" });
      doc.links!.push([`p:DUT|${p.id}`, `p:${id}|out`]);
    }
  });
  const sim = new Simulator(extractCircuit(doc), opts);
  const clkPin = pins.find((p) => p.clock);
  return {
    sim,
    doc,
    set: (pin, v) => sim.set(`T_${pin}`, v),
    get: (pin) => sim.read(`T_${pin}`),
    settle: () => sim.settle(),
    tick: () => {
      if (!clkPin) throw new Error(`${type} has no clock`);
      // a falling-edge part is clocked by the 1 -> 0 change
      const falling = !!clkPin.inverted;
      sim.set(`T_${clkPin.id}`, falling ? 1 : 0);
      sim.settle();
      sim.set(`T_${clkPin.id}`, falling ? 0 : 1);
      sim.settle();
      sim.set(`T_${clkPin.id}`, falling ? 1 : 0);
      sim.settle();
    },
  };
}

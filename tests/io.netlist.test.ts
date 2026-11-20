import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { escapeXml, propStr, type ComponentDef } from "../src/model/component-def";
import { getDef, registerComponent } from "../src/model/registry";
import { worldPins } from "../src/model/geometry";
import { emptyDocument } from "../src/model/types";
import { buildNetlist, exportNetlistJson, exportNetlistText, type Net } from "../src/io/netlist";

registerBuiltinComponents();

// Test-only tunnel ComponentDef for netlist tunnel tests.
const testTunnelDef: ComponentDef = {
  type: "tunnel",
  name: "Tunnel",
  category: "I/O",
  labelPrefix: "T",
  props: [{ key: "name", label: "Name", kind: "string" }],
  defaultProps: { name: "NET" },
  geometry: () => ({
    width: 40,
    height: 20,
    pins: [{ id: "p", name: "P", x: 0, y: 10, dir: "inout", side: "left" }],
  }),
  symbol: (props) => {
    const name = propStr(props, "name", "NET");
    return `<rect class="ds-body" x="0" y="0" width="40" height="20"/><text class="ds-text" x="6" y="14">${escapeXml(name)}</text>`;
  },
};

if (!getDef("tunnel")) {
  registerComponent(testTunnelDef);
}

function findNetWithPin(nets: Net[], componentId: string, pinId: string): Net | undefined {
  return nets.find((n) => n.pins.some((p) => p.componentId === componentId && p.pinId === pinId));
}

describe("io/netlist", () => {
  it("connects wires meeting at a T-junction", () => {
    const doc = emptyDocument();
    doc.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "w2", points: [{ x: 50, y: 0 }, { x: 50, y: 60 }] },
    );

    const { nets } = buildNetlist(doc);
    expect(nets).toHaveLength(1);
    expect(nets[0].wires).toEqual(["w1", "w2"]);
  });

  it("does NOT connect crossing wires without a shared vertex or endpoint", () => {
    const doc = emptyDocument();
    doc.wires.push(
      { id: "w_horiz", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      { id: "w_vert", points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] },
    );

    const { nets } = buildNetlist(doc);
    expect(nets).toHaveLength(2);
    expect(nets.map((n) => n.wires)).toEqual([["w_horiz"], ["w_vert"]]);
  });

  it("connects crossing wires when they share an explicit vertex", () => {
    const doc = emptyDocument();
    doc.wires.push(
      { id: "w1", points: [{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 }] },
      { id: "w2", points: [{ x: 50, y: 0 }, { x: 50, y: 50 }, { x: 50, y: 100 }] },
    );

    const { nets } = buildNetlist(doc);
    expect(nets).toHaveLength(1);
    expect(nets[0].wires).toEqual(["w1", "w2"]);
  });

  it("joins component pins connected at wire endpoints and mid-segment", () => {
    const doc = emptyDocument();
    const andGate = {
      id: "g1",
      type: "and",
      x: 20,
      y: 20,
      rotation: 0 as const,
      props: { inputs: 2 },
      label: "U1",
    };
    const notGate1 = {
      id: "g2",
      type: "not",
      x: 160,
      y: 30,
      rotation: 0 as const,
      props: {},
      label: "U2",
    };
    const notGate2 = {
      id: "g3",
      type: "not",
      x: 120,
      y: 30,
      rotation: 0 as const,
      props: {},
      label: "U3",
    };
    doc.components.push(andGate, notGate1, notGate2);

    const andOut = worldPins(andGate).find((p) => p.pin.id === "out")!.pos; // (100, 50)
    const not1In = worldPins(notGate1).find((p) => p.pin.id === "in0")!.pos; // (160, 50)
    const not2In = worldPins(notGate2).find((p) => p.pin.id === "in0")!.pos; // (120, 50) — mid-segment!

    expect(andOut.y).toBe(not1In.y);
    expect(not2In.y).toBe(andOut.y);

    doc.wires.push({ id: "w_main", points: [andOut, not1In] });

    const { nets } = buildNetlist(doc);
    const sharedNet = findNetWithPin(nets, "g1", "out");
    expect(sharedNet).toBeDefined();
    expect(sharedNet!.wires).toEqual(["w_main"]);
    expect(sharedNet!.pins).toEqual([
      { componentId: "g1", pinId: "out" },
      { componentId: "g2", pinId: "in0" },
      { componentId: "g3", pinId: "in0" },
    ]);

    // Unconnected pins of g1 stay separate from the driven net
    const in0Net = findNetWithPin(nets, "g1", "in0");
    expect(in0Net).toBeDefined();
    expect(in0Net!.id).not.toBe(sharedNet!.id);
  });

  it("joins nets connected through tunnels with matching name prop and keeps distinct names separate", () => {
    const doc = emptyDocument();
    const g1 = {
      id: "g1",
      type: "and",
      x: 0,
      y: 0,
      rotation: 0 as const,
      props: { inputs: 2 },
      label: "U1",
    };
    const g2 = {
      id: "g2",
      type: "not",
      x: 300,
      y: 0,
      rotation: 0 as const,
      props: {},
      label: "U2",
    };
    // g1.out is at (80, 30); place tunnel t1 so its pin (0, 10) sits at (100, 30)
    const t1 = {
      id: "tun1",
      type: "tunnel",
      x: 100,
      y: 20,
      rotation: 0 as const,
      props: { name: "CLK" },
      label: "T1",
    };
    // g2.in0 is at (300, 20); place tunnel t2 so its pin sits at (260, 20)
    const t2 = {
      id: "tun2",
      type: "tunnel",
      x: 260,
      y: 10,
      rotation: 0 as const,
      props: { name: "CLK" },
      label: "T2",
    };
    // A third tunnel with a DIFFERENT name must not join CLK
    const t3 = {
      id: "tun3",
      type: "tunnel",
      x: 260,
      y: 100,
      rotation: 0 as const,
      props: { name: "RST" },
      label: "T3",
    };

    doc.components.push(g1, g2, t1, t2, t3);
    doc.wires.push(
      { id: "w_left", points: [{ x: 80, y: 30 }, { x: 100, y: 30 }] },
      { id: "w_right", points: [{ x: 260, y: 20 }, { x: 300, y: 20 }] },
    );

    const { nets } = buildNetlist(doc);
    const clkNet = findNetWithPin(nets, "g1", "out");
    expect(clkNet).toBeDefined();
    expect(clkNet!.name).toBe("CLK");
    expect(clkNet!.tunnels).toEqual(["CLK"]);
    expect(clkNet!.wires).toEqual(["w_left", "w_right"]);
    expect(clkNet!.pins).toContainEqual({ componentId: "g1", pinId: "out" });
    expect(clkNet!.pins).toContainEqual({ componentId: "g2", pinId: "in0" });
    expect(clkNet!.pins).toContainEqual({ componentId: "tun1", pinId: "p" });
    expect(clkNet!.pins).toContainEqual({ componentId: "tun2", pinId: "p" });

    const rstNet = findNetWithPin(nets, "tun3", "p");
    expect(rstNet).toBeDefined();
    expect(rstNet!.name).toBe("RST");
    expect(rstNet!.id).not.toBe(clkNet!.id);
  });

  it("connects direct pin-to-pin abutment, rotated/mirrored pins, and parametric multi-input gates", () => {
    const doc = emptyDocument();
    // 4-input AND gate at (0, 0) -> has 4 distinct input pins in0..in3 + out
    const and4 = {
      id: "g_and4",
      type: "and",
      x: 0,
      y: 0,
      rotation: 0 as const,
      props: { inputs: 4 },
      label: "U_AND4",
    };
    const and4Pins = worldPins(and4);
    expect(and4Pins.filter((p) => p.pin.dir === "in")).toHaveLength(4);
    const and4Out = and4Pins.find((p) => p.pin.id === "out")!.pos;

    // Place a NOT gate directly abutting and4.out with NO wire between them (not.in0 is at local (0, 20))
    const abutNot = {
      id: "g_not_abut",
      type: "not",
      x: and4Out.x,
      y: and4Out.y - 20,
      rotation: 0 as const,
      props: {},
      label: "U_INV",
    };
    // Place a rotated (90 deg) NOT gate and wire its transformed in0 to and4.in2
    const rotNot = {
      id: "g_not_rot",
      type: "not",
      x: 200,
      y: 100,
      rotation: 90 as const,
      props: {},
      label: "U_ROT",
    };
    const and4In2 = and4Pins.find((p) => p.pin.id === "in2")!.pos;
    const rotNotIn0 = worldPins(rotNot).find((p) => p.pin.id === "in0")!.pos;

    doc.components.push(and4, abutNot, rotNot);
    doc.wires.push({
      id: "w_rot",
      points: [and4In2, { x: rotNotIn0.x, y: and4In2.y }, rotNotIn0],
    });

    const { nets } = buildNetlist(doc);

    // Direct pin-to-pin abutment connects without any wire
    const abutNet = findNetWithPin(nets, "g_and4", "out");
    expect(abutNet).toBeDefined();
    expect(abutNet!.wires).toEqual([]);
    expect(abutNet!.pins).toEqual([
      { componentId: "g_and4", pinId: "out" },
      { componentId: "g_not_abut", pinId: "in0" },
    ]);

    // Rotated gate pin connects via wire to parametric pin in2
    const rotNet = findNetWithPin(nets, "g_and4", "in2");
    expect(rotNet).toBeDefined();
    expect(rotNet!.wires).toEqual(["w_rot"]);
    expect(rotNet!.pins).toContainEqual({ componentId: "g_not_rot", pinId: "in0" });
  });

  it("exports human-readable netlist text and valid netlist JSON", () => {
    const doc = emptyDocument("Simple Inverter Chain");
    doc.components.push(
      { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 }, label: "U1" },
      { id: "g2", type: "not", x: 120, y: 10, rotation: 0, props: {}, label: "U2" },
    );
    // g1.out at (80, 30), g2.in0 at (120, 30)
    doc.wires.push({ id: "w1", points: [{ x: 80, y: 30 }, { x: 120, y: 30 }] });

    const text = exportNetlistText(doc);
    const lines = text.split("\n");
    expect(lines.length).toBe(buildNetlist(doc).nets.length);
    expect(lines.some((line) => line.includes("U1.Y") && line.includes("U2.I0"))).toBe(true);

    const jsonStr = exportNetlistJson(doc);
    expect(JSON.parse(jsonStr)).toEqual(buildNetlist(doc));
  });
});

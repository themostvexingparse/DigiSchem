import { describe, expect, it } from "vitest";
import { ALL_DEFS, registerBuiltinComponents } from "../src/components/library";
import { GRID, SIZE_H, SIZE_W, type ComponentDef, type PinDef, type Side } from "../src/model/component-def";
import { effectiveProps, geometryOf, snap, worldPins } from "../src/model/geometry";
import { getDef } from "../src/model/registry";
import type { ComponentInstance, PropValue } from "../src/model/types";
import { renderComponent } from "../src/render/svg";

registerBuiltinComponents();

function assertWellFormedXml(fragment: string, context: string): void {
  const xml = `<g>${fragment}</g>`;
  const stack: string[] = [];
  let i = 0;

  while (i < xml.length) {
    if (xml[i] === "<") {
      const closeIdx = xml.indexOf(">", i + 1);
      expect(closeIdx, `${context}: unclosed '<' at offset ${i}`).toBeGreaterThan(i);
      const raw = xml.slice(i + 1, closeIdx);
      expect(raw.includes("<"), `${context}: nested '<' inside tag <${raw}>`).toBe(false);

      if (raw.startsWith("/")) {
        const tag = raw.slice(1).trim();
        const popped = stack.pop();
        expect(popped, `${context}: mismatched closing </${tag}> (expected </${popped}>)`).toBe(tag);
      } else {
        const selfClosing = raw.endsWith("/");
        const body = selfClosing ? raw.slice(0, -1).trim() : raw.trim();
        const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body);
        expect(nameMatch, `${context}: invalid tag name in <${raw}>`).not.toBeNull();
        const tag = nameMatch![1];

        let rest = body.slice(tag.length).trim();
        while (rest.length > 0) {
          const attrMatch = /^([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
          expect(attrMatch, `${context}: malformed attribute in <${raw}> near "${rest}"`).not.toBeNull();
          const attrVal = attrMatch![3] ?? attrMatch![4] ?? "";
          const badAmp = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(attrVal);
          expect(badAmp, `${context}: unescaped '&' in attribute "${attrVal}"`).toBe(false);
          rest = rest.slice(attrMatch![0].length).trim();
        }

        if (!selfClosing) stack.push(tag);
      }
      i = closeIdx + 1;
    } else {
      const nextTag = xml.indexOf("<", i);
      const text = nextTag === -1 ? xml.slice(i) : xml.slice(i, nextTag);
      expect(text.includes(">"), `${context}: stray '>' in text "${text}"`).toBe(false);
      const badAmp = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text);
      expect(badAmp, `${context}: unescaped '&' in text "${text}"`).toBe(false);
      i = nextTag === -1 ? xml.length : nextTag;
    }
  }

  expect(stack, `${context}: unclosed tags ${stack.join(", ")}`).toEqual([]);
}

function minSideSpacing(pins: PinDef[], side: Side): number {
  const list = pins.filter((p) => p.side === side);
  if (list.length < 2) return Infinity;
  const horizontal = side === "top" || side === "bottom";
  const sorted = [...list].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  let minD = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = horizontal ? sorted[i].x - sorted[i - 1].x : sorted[i].y - sorted[i - 1].y;
    minD = Math.min(minD, d);
  }
  return minD;
}

function assertStubsReachPins(svg: string, pins: PinDef[], ctx: string): void {
  for (const pin of pins) {
    const hitsLine =
      (svg.includes(`x1="${pin.x}"`) && svg.includes(`y1="${pin.y}"`)) ||
      (svg.includes(`x2="${pin.x}"`) && svg.includes(`y2="${pin.y}"`));
    const hitsPath = svg.includes(`${pin.x} ${pin.y}`);
    expect(
      hitsLine || hitsPath,
      `${ctx}: symbol missing stub endpoint for pin ${pin.id} at (${pin.x},${pin.y})`,
    ).toBe(true);
  }
}

describe("component resizability classification", () => {
  // Gates resize in both directions (corner handles): the body itself scales.
  const HEIGHT_ONLY = new Set<string>([]);
  const NON_RESIZABLE = new Set([
    "buf",
    "not",
    "tristate",
    "input-pin",
    "output-pin",
    "clock",
    "constant",
    "ground",
    "vcc",
    "probe",
    "tunnel",
    "splitter",
    "pull-up",
    "pull-down",
  ]);

  it("sets resizable flags accurately on every registered component", () => {
    for (const def of ALL_DEFS) {
      if (NON_RESIZABLE.has(def.type)) {
        expect(def.resizable, `${def.type} should not be resizable`).toBeUndefined();
      } else if (HEIGHT_ONLY.has(def.type)) {
        expect(def.resizable, `${def.type} should be height-resizable`).toBe("height");
      } else {
        expect(def.resizable, `${def.type} should be both-axis resizable`).toBe("both");
      }
    }
  });

  it("ignores size on non-resizable components", () => {
    for (const type of NON_RESIZABLE) {
      const def = getDef(type)!;
      const base: ComponentInstance = { id: "c", type, x: 0, y: 0, rotation: 0, props: { ...def.defaultProps } };
      const resized: ComponentInstance = { ...base, size: { w: 240, h: 200 } };
      expect(geometryOf(resized), `${type} should ignore size`).toEqual(geometryOf(base));
    }
  });
});

describe("resizable component sweep", () => {
  const RESIZABLE_DEFS: ComponentDef[] = ALL_DEFS.filter((d) => Boolean(d.resizable));
  const SIDES: Side[] = ["left", "right", "top", "bottom"];

  for (const def of RESIZABLE_DEFS) {
    it(`${def.type} (${def.resizable}) handles default, smaller, enlarged, and odd resize requests`, () => {
      const baseProps: Record<string, PropValue> = { ...def.defaultProps };
      const defG = def.geometry(baseProps);
      const defIds = defG.pins.map((p) => p.id);
      const defMinSpacing = new Map<Side, number>(SIDES.map((s) => [s, minSideSpacing(defG.pins, s)]));

      // 1. Requested size equal to computed default -> exact match
      const eqProps: Record<string, PropValue> = { ...baseProps };
      if (def.resizable !== "height") eqProps[SIZE_W] = defG.width;
      if (def.resizable !== "width") eqProps[SIZE_H] = defG.height;
      expect(def.geometry(eqProps), `${def.type} equal-to-default size`).toEqual(defG);

      // 2. Requested size smaller than minimum -> ignored (equals default)
      const smallerRequests: { w: number; h: number }[] = [
        { w: Math.max(10, defG.width - 20), h: Math.max(10, defG.height - 20) },
        { w: 10, h: 10 },
      ];
      for (const req of smallerRequests) {
        const smallProps: Record<string, PropValue> = { ...baseProps };
        if (def.resizable !== "height") smallProps[SIZE_W] = req.w;
        if (def.resizable !== "width") smallProps[SIZE_H] = req.h;
        expect(def.geometry(smallProps), `${def.type} smaller size ${JSON.stringify(req)}`).toEqual(defG);
      }

      // 3. Sweep enlarged & odd sizes
      const sizeSweeps: { w: number; h: number }[] = [
        { w: defG.width, h: defG.height },
        { w: defG.width + 40, h: defG.height + 40 },
        { w: defG.width + 100, h: defG.height + 100 },
        { w: defG.width + 60, h: defG.height },
        { w: defG.width, h: defG.height + 80 },
        { w: 135, h: 135 },
        { w: 225, h: 175 },
      ];

      for (const req of sizeSweeps) {
        const inst: ComponentInstance = {
          id: "t",
          type: def.type,
          x: 100,
          y: 100,
          rotation: 0,
          props: baseProps,
          size: req,
        };
        const eff = effectiveProps(inst);
        const g = def.geometry(eff);
        const ctx = `${def.type}(size=${JSON.stringify(req)})`;

        // Bounding box on grid and >= snapped request on resizable axes
        expect(g.width % GRID, `${ctx}: width on grid`).toBe(0);
        expect(g.height % GRID, `${ctx}: height on grid`).toBe(0);
        if (def.resizable !== "height") {
          expect(g.width, `${ctx}: width >= snap(${req.w})`).toBeGreaterThanOrEqual(snap(req.w));
        } else {
          expect(g.width, `${ctx}: height-only width unchanged`).toBe(defG.width);
        }
        if (def.resizable !== "width") {
          expect(g.height, `${ctx}: height >= snap(${req.h})`).toBeGreaterThanOrEqual(snap(req.h));
        } else {
          expect(g.height, `${ctx}: width-only height unchanged`).toBe(defG.height);
        }

        // Pin ids identical & in same order
        expect(g.pins.map((p) => p.id), `${ctx}: pin ids`).toEqual(defIds);

        // Pins on grid & at bounding edges
        for (const pin of g.pins) {
          expect(pin.x % GRID, `${ctx}: pin ${pin.id} x on grid`).toBe(0);
          expect(pin.y % GRID, `${ctx}: pin ${pin.id} y on grid`).toBe(0);
          if (pin.side === "left") expect(pin.x).toBeLessThanOrEqual(0);
          if (pin.side === "right") expect(pin.x).toBeGreaterThanOrEqual(g.width);
          if (pin.side === "top") expect(pin.y).toBeLessThanOrEqual(0);
          if (pin.side === "bottom") expect(pin.y).toBeGreaterThanOrEqual(g.height);
        }

        // Spacing >= existing minimum on every edge
        for (const side of SIDES) {
          const origMin = defMinSpacing.get(side)!;
          if (!Number.isFinite(origMin)) continue;
          const curMin = minSideSpacing(g.pins, side);
          expect(curMin, `${ctx}: ${side} pin spacing`).toBeGreaterThanOrEqual(origMin);
        }

        // Grid alignment preserved under rotations + mirror
        for (const mirror of [false, true]) {
          for (const rotation of [0, 90, 180, 270] as const) {
            const wpins = worldPins({ ...inst, rotation, mirror });
            for (const wp of wpins) {
              expect(Math.abs(wp.pos.x % GRID), `${ctx} rot=${rotation} mir=${mirror} x`).toBe(0);
              expect(Math.abs(wp.pos.y % GRID), `${ctx} rot=${rotation} mir=${mirror} y`).toBe(0);
            }
          }
        }

        // Symbol XML well-formed, no hardcoded colors, pin stubs end on exact pin coordinates
        const svg = def.symbol(eff);
        assertWellFormedXml(svg, ctx);
        expect(svg, `${ctx}: hardcoded color`).not.toMatch(/(?:fill|stroke)\s*=\s*["']#[0-9a-fA-F]{3,8}["']/);
        assertStubsReachPins(svg, g.pins, ctx);

        // Full renderer integration
        const rendered = renderComponent(inst);
        assertWellFormedXml(rendered, `${ctx}: renderComponent`);
      }
    });
  }
});

describe("component-specific resize geometry", () => {
  it("box components spread pins along enlarged edges and keep title centered", () => {
    const rf = getDef("register-file")!;
    const baseProps = { ...rf.defaultProps, writePorts: 2 };
    const defG = rf.geometry(baseProps);
    const bigProps = { ...baseProps, [SIZE_W]: defG.width + 100, [SIZE_H]: defG.height + 100 };
    const bigG = rf.geometry(bigProps);

    expect(bigG.width).toBe(defG.width + 100);
    expect(bigG.height).toBe(defG.height + 100);

    // Top pins WE1, WE2 spread wider
    const defTop = defG.pins.filter((p) => p.side === "top");
    const bigTop = bigG.pins.filter((p) => p.side === "top");
    expect(bigTop[1].x - bigTop[0].x).toBeGreaterThan(defTop[1].x - defTop[0].x);

    // Left pins spread taller
    const defLeft = defG.pins.filter((p) => p.side === "left");
    const bigLeft = bigG.pins.filter((p) => p.side === "left");
    const defSpan = defLeft[defLeft.length - 1].y - defLeft[0].y;
    const bigSpan = bigLeft[bigLeft.length - 1].y - bigLeft[0].y;
    expect(bigSpan).toBeGreaterThan(defSpan);

    // Title stays horizontally centered in the body
    const svg = rf.symbol(bigProps);
    const bodyMatch = /<rect class="ds-body" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(svg);
    expect(bodyMatch).not.toBeNull();
    const cx = Number(bodyMatch![1]) + Number(bodyMatch![3]) / 2;
    expect(svg).toContain(`<text class="ds-title" x="${cx}"`);
  });

  it("MUX and DEMUX spread data pins, widen trapezoid, and keep slanted bottom stubs exact", () => {
    for (const type of ["mux", "demux"] as const) {
      const def = getDef(type)!;
      for (const selectBits of [1, 2, 3]) {
        const base = { selectBits, dataWidth: 8, enable: true, selectMode: "bits" };
        const defG = def.geometry(base);
        const big = { ...base, [SIZE_W]: defG.width + 80, [SIZE_H]: defG.height + 100 };
        const bigG = def.geometry(big);
        const svg = def.symbol(big);

        expect(bigG.width).toBe(defG.width + 80);
        expect(bigG.height).toBe(defG.height + 100);

        // Data pins spread farther apart
        const dataSide: Side = type === "mux" ? "left" : "right";
        const defData = defG.pins.filter((p) => p.side === dataSide);
        const bigData = bigG.pins.filter((p) => p.side === dataSide);
        expect(bigData[bigData.length - 1].y - bigData[0].y).toBeGreaterThan(
          defData[defData.length - 1].y - defData[0].y,
        );

        // Bottom select/enable stubs start on exact slanted bottom edge
        const bodyX = 20;
        const bodyW = bigG.width - 40;
        const bodyH = bigG.height - 20;
        const slope = Math.min(20, Math.max(10, Math.floor((bodyH - 40) / 2)));
        const botPins = bigG.pins.filter((p) => p.side === "bottom");
        expect(botPins.length).toBe(selectBits + 1);
        for (const bp of botPins) {
          const t = (bp.x - bodyX) / bodyW;
          const ey = +(type === "mux" ? bodyH - t * slope : bodyH - (1 - t) * slope).toFixed(2);
          expect(svg, `${type} bottom stub for ${bp.id}`).toContain(
            `<line class="ds-pin" x1="${bp.x}" y1="${ey}" x2="${bp.x}" y2="${bp.y}"/>`,
          );
        }
      }
    }
  });

  it("ALU widens/heightens V-notched body, spreads pins, and keeps slanted top stubs exact", () => {
    const alu = getDef("alu")!;
    const base = { ...alu.defaultProps, opBits: 3, opPinMode: "bits" };
    const defG = alu.geometry(base);
    const big = { ...base, [SIZE_W]: defG.width + 80, [SIZE_H]: defG.height + 100 };
    const bigG = alu.geometry(big);
    const svg = alu.symbol(big);

    expect(bigG.width).toBe(defG.width + 80);
    expect(bigG.height).toBe(defG.height + 100);

    // Top op-select pins spread wider and stubs meet slanted top edge exactly
    const defTop = defG.pins.filter((p) => p.side === "top");
    const bigTop = bigG.pins.filter((p) => p.side === "top");
    expect(bigTop[bigTop.length - 1].x - bigTop[0].x).toBeGreaterThan(defTop[defTop.length - 1].x - defTop[0].x);

    const bodyX = 20;
    const bodyY = 20;
    const bodyW = bigG.width - 40;
    const slope = 20;
    for (const tp of bigTop) {
      const ey = +(bodyY + ((tp.x - bodyX) / bodyW) * slope).toFixed(2);
      expect(svg, `ALU top stub for ${tp.id}`).toContain(
        `<line class="ds-pin" x1="${tp.x}" y1="${ey}" x2="${tp.x}" y2="0"/>`,
      );
    }

    // Right flag pins spread taller
    const defRight = defG.pins.filter((p) => p.side === "right");
    const bigRight = bigG.pins.filter((p) => p.side === "right");
    expect(bigRight[bigRight.length - 1].y - bigRight[0].y).toBeGreaterThan(
      defRight[defRight.length - 1].y - defRight[0].y,
    );
  });

  it("gates scale their body when resized (taller spreads inputs, wider stretches the shape)", () => {
    for (const type of ["and", "nand", "or", "nor", "xor", "xnor"]) {
      const def = getDef(type)!;
      for (const inputs of [2, 3, 5]) {
        const base = { inputs };
        const defG = def.geometry(base);
        const tall = { ...base, [SIZE_H]: defG.height + 80 };
        const tallG = def.geometry(tall);
        const svg = def.symbol(tall);

        expect(tallG.width).toBe(defG.width);
        expect(tallG.height).toBe(defG.height + 80);

        const defIn = defG.pins.filter((p) => p.dir === "in");
        const tallIn = tallG.pins.filter((p) => p.dir === "in");
        expect(tallIn[tallIn.length - 1].y - tallIn[0].y).toBeGreaterThan(
          defIn[defIn.length - 1].y - defIn[0].y,
        );

        // Output stays vertically centered on grid
        const out = tallG.pins.find((p) => p.id === "out")!;
        expect(out.y).toBe(tallG.height / 2);
        expect(out.y % GRID).toBe(0);

        // The body fills the new height (no separate wing bars): its path reaches y = height.
        expect(svg, `${type}(inputs=${inputs}) body spans height`).toMatch(new RegExp(`class="ds-body" d="[^"]* ${tallG.height}[ "]`));

        // Wider request stretches the body; legs keep their length, outline stays on grid.
        const wide = def.geometry({ ...base, [SIZE_W]: defG.width + 60 });
        expect(wide.width).toBe(defG.width + 60);
        expect(wide.width % GRID).toBe(0);
        const wideOut = wide.pins.find((p) => p.id === "out")!;
        expect(wideOut.x).toBe(wide.width);
      }
    }
  });
});

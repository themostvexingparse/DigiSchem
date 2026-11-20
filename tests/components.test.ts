import { describe, expect, it } from "vitest";
import { ALL_DEFS, registerBuiltinComponents } from "../src/components/library";
import { layoutBox } from "../src/components/library/helpers";
import { CATEGORY_ORDER, getDef, listDefs } from "../src/model/registry";
import { GRID, type ComponentDef, type PinDef, type PropDef, type Side } from "../src/model/component-def";
import { emptyDocument, type PropValue } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { renderDocumentSvg } from "../src/render/svg";

registerBuiltinComponents();

/**
 * Minimal well-formed XML fragment checker (runs in Node without a DOM).
 * Verifies balanced open/close/self-closing tags, valid attribute quoting,
 * and absence of unescaped `<`, `>`, or bare `&` in text/attributes.
 */
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

        // Validate attributes: key="value" or key='value'
        let rest = body.slice(tag.length).trim();
        while (rest.length > 0) {
          const attrMatch = /^([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
          expect(attrMatch, `${context}: malformed attribute in <${raw}> near "${rest}"`).not.toBeNull();
          const attrVal = attrMatch![3] ?? attrMatch![4] ?? "";
          // Ensure no bare '&' (must be valid entity)
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

/** Generate representative prop combinations sweeping each prop's domain around defaults. */
function sweepProps(def: ComponentDef): Record<string, PropValue>[] {
  const configs: Record<string, PropValue>[] = [{ ...def.defaultProps }];
  const base = { ...def.defaultProps };

  for (const p of def.props) {
    if (p.kind === "int") {
      const min = p.min ?? 1;
      const max = p.max ?? 8;
      const mid = Math.round((min + max) / 2);
      for (const v of new Set([min, mid, Math.min(max, min + 2), max])) {
        configs.push({ ...base, [p.key]: v });
      }
    } else if (p.kind === "bool") {
      configs.push({ ...base, [p.key]: true });
      configs.push({ ...base, [p.key]: false });
    } else if (p.kind === "enum" && p.options) {
      for (const opt of p.options) {
        configs.push({ ...base, [p.key]: opt.value });
      }
    } else if (p.kind === "string") {
      // Include XML-special characters to guarantee proper escaping
      configs.push({ ...base, [p.key]: "" });
      configs.push({ ...base, [p.key]: `A&B<0>"1'` });
    }
  }

  // If the component supports pinMode: "bits", also sweep its int props in "bits" mode
  const pinModeProp = def.props.find((p) => p.key === "pinMode");
  if (pinModeProp) {
    const bitsBase = { ...base, pinMode: "bits" };
    configs.push(bitsBase);
    for (const p of def.props) {
      if (p.kind === "int") {
        const min = p.min ?? 1;
        const smallMax = Math.min(p.max ?? 8, 8);
        configs.push({ ...bitsBase, [p.key]: min });
        configs.push({ ...bitsBase, [p.key]: smallMax });
      }
    }
  }

  return configs;
}

/** True if a prop represents a count/bit-width that determines pin count (directly or in bits mode). */
function isCountProp(def: ComponentDef, p: PropDef): boolean {
  if (p.kind !== "int") return false;
  const max = p.max ?? 0;
  const min = p.min ?? 0;
  if (max <= min) return false;
  // Single-pin bus width props (e.g. input-pin width, tristate width, d-latch width) change pin.width, not pin count
  const busOnlyWidthTypes = new Set(["input-pin", "output-pin", "constant", "tunnel", "tristate", "d-latch"]);
  if (p.key === "width" && busOnlyWidthTypes.has(def.type)) return false;
  if (p.key === "dataWidth" && (def.type === "mux" || def.type === "demux")) return false;
  if (p.key === "width" && def.type === "alu") return false;
  if (p.key === "width" && def.type === "splitter") return false;
  return true;
}

describe("component library metadata & registration", () => {
  it("registers all expected families with unique kebab-case type ids", () => {
    expect(ALL_DEFS.length).toBeGreaterThanOrEqual(40);
    expect(listDefs().length).toBe(ALL_DEFS.length);

    const seen = new Set<string>();
    for (const def of ALL_DEFS) {
      expect(def.type).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(seen.has(def.type), `duplicate type id: ${def.type}`).toBe(false);
      seen.add(def.type);

      expect(def.name.length).toBeGreaterThan(0);
      expect(CATEGORY_ORDER).toContain(def.category);
      expect(def.labelPrefix && def.labelPrefix.length > 0).toBe(true);
      expect(def.description && def.description.length > 0).toBe(true);

      for (const p of def.props) {
        expect(def.defaultProps).toHaveProperty(p.key);
        if (p.kind === "int") {
          expect(typeof p.min).toBe("number");
          expect(typeof p.max).toBe("number");
          expect(p.max!).toBeGreaterThan(p.min!);
        }
        if (p.kind === "enum") {
          expect(p.options && p.options.length > 0).toBe(true);
        }
      }
    }
  });
});

describe("component library invariant sweep", () => {
  for (const def of ALL_DEFS) {
    it(`${def.type} satisfies geometry, pin, and XML invariants across prop sweep`, () => {
      const configs = sweepProps(def);

      for (const props of configs) {
        const ctx = `${def.type}(${JSON.stringify(props)})`;
        const g = def.geometry(props);

        // Positive, grid-aligned bounding box
        expect(g.width, `${ctx}: width`).toBeGreaterThan(0);
        expect(g.height, `${ctx}: height`).toBeGreaterThan(0);
        expect(g.width % GRID, `${ctx}: width on grid`).toBe(0);
        expect(g.height % GRID, `${ctx}: height on grid`).toBe(0);

        // Pin invariants
        const pinIds = new Set<string>();
        for (const pin of g.pins) {
          expect(pin.id.length, `${ctx}: empty pin id`).toBeGreaterThan(0);
          expect(pinIds.has(pin.id), `${ctx}: duplicate pin id "${pin.id}"`).toBe(false);
          pinIds.add(pin.id);

          // Exact 10-unit grid alignment
          expect(pin.x % GRID, `${ctx}: pin ${pin.id} x=${pin.x} not on grid`).toBe(0);
          expect(pin.y % GRID, `${ctx}: pin ${pin.id} y=${pin.y} not on grid`).toBe(0);

          // Pin sits at or outside the bounding edge matching its side
          if (pin.side === "left") expect(pin.x, `${ctx}: left pin ${pin.id}`).toBeLessThanOrEqual(0);
          if (pin.side === "right") expect(pin.x, `${ctx}: right pin ${pin.id}`).toBeGreaterThanOrEqual(g.width);
          if (pin.side === "top") expect(pin.y, `${ctx}: top pin ${pin.id}`).toBeLessThanOrEqual(0);
          if (pin.side === "bottom") expect(pin.y, `${ctx}: bottom pin ${pin.id}`).toBeGreaterThanOrEqual(g.height);
        }

        // Grid alignment preserved under all rotations and mirror
        for (const mirror of [false, true]) {
          for (const rotation of [0, 90, 180, 270] as const) {
            const wpins = worldPins({ id: "t", type: def.type, x: 100, y: 100, rotation, mirror, props });
            for (const wp of wpins) {
              expect(Math.abs(wp.pos.x % GRID), `${ctx} rot=${rotation} mir=${mirror} pin ${wp.pin.id} x`).toBe(0);
              expect(Math.abs(wp.pos.y % GRID), `${ctx} rot=${rotation} mir=${mirror} pin ${wp.pin.id} y`).toBe(0);
            }
          }
        }

        // Well-formed XML & no hardcoded colors
        const svg = def.symbol(props);
        expect(svg.length, `${ctx}: empty symbol`).toBeGreaterThan(0);
        assertWellFormedXml(svg, ctx);
        expect(svg, `${ctx}: hardcoded hex color`).not.toMatch(/(?:fill|stroke)\s*=\s*["']#[0-9a-fA-F]{3,8}["']/);
        expect(svg, `${ctx}: hardcoded rgb color`).not.toMatch(/(?:fill|stroke)\s*=\s*["']rgb\(/i);

        // Verify every pin's exact coordinate appears as an endpoint in the rendered SVG
        for (const pin of g.pins) {
          const hitsLine =
            (svg.includes(`x1="${pin.x}"`) && svg.includes(`y1="${pin.y}"`)) ||
            (svg.includes(`x2="${pin.x}"`) && svg.includes(`y2="${pin.y}"`));
          const hitsPath = svg.includes(`${pin.x} ${pin.y}`);
          expect(hitsLine || hitsPath, `${ctx}: symbol missing stub endpoint for pin ${pin.id} at (${pin.x},${pin.y})`).toBe(
            true,
          );
        }
      }
    });
  }

  it("renders a full schematic document containing every registered component", () => {
    const doc = emptyDocument("All Components");
    let x = 0;
    for (const def of ALL_DEFS) {
      doc.components.push({
        id: `c_${def.type}`,
        type: def.type,
        x,
        y: 0,
        rotation: 0,
        props: { ...def.defaultProps },
        label: `${def.labelPrefix}1`,
      });
      x += def.geometry(def.defaultProps).width + 40;
    }
    const svg = renderDocumentSvg(doc);
    expect(svg).toContain("<svg ");
    expect(svg).toContain("</svg>");
    // Strip XML declaration and check balanced XML for the complete rendered SVG
    const body = svg.replace(/^<\?xml[^?]*\?>\s*/, "");
    assertWellFormedXml(body, "full document SVG");
  });
});

describe("parametric count props change pin counts", () => {
  for (const def of ALL_DEFS) {
    const countProps = def.props.filter((p) => isCountProp(def, p));
    if (countProps.length === 0) continue;

    it(`${def.type} changes pin count when count props change`, () => {
      const hasPinMode = def.props.some((p) => p.key === "pinMode");
      for (const p of countProps) {
        const min = p.min!;
        const next = Math.min(p.max!, min + 1);
        const base: Record<string, PropValue> = { ...def.defaultProps };
        // Use individual-bit mode when checking width/address/data-bit expansion on bus-capable components
        if (hasPinMode && ["width", "bits", "addressBits", "dataWidth"].includes(p.key)) {
          base.pinMode = "bits";
        }
        // For shift-register / counter width, ensure parallel pins are visible if gated by a bool
        if (def.type === "shift-register" && p.key === "width") {
          base.parallelOut = true;
        }
        const g1 = def.geometry({ ...base, [p.key]: min });
        const g2 = def.geometry({ ...base, [p.key]: next });
        expect(
          g2.pins.length,
          `${def.type}: changing ${p.key} from ${min} to ${next} should change pin count`,
        ).not.toBe(g1.pins.length);
      }
    });
  }
});

describe("specific textbook component behaviors", () => {
  it("gates > 5 inputs draw vertical wing lines and OR/XOR stubs reach curved back", () => {
    const and8 = getDef("and")!;
    const svgAnd8 = and8.symbol({ inputs: 8 });
    expect(svgAnd8).toContain('class="ds-line"');

    const xor3 = getDef("xor")!;
    const gXor = xor3.geometry({ inputs: 3 });
    const midPin = gXor.pins.find((p) => p.id === "in1")!;
    // At midY, the XOR back curve reaches x = x0 - 6 + 6 = x0 (20)
    expect(xor3.symbol({ inputs: 3 })).toContain(`x1="0" y1="${midPin.y}" x2="20" y2="${midPin.y}"`);
  });

  it("MUX derives 2^n data inputs and n select pins", () => {
    const mux = getDef("mux")!;
    const g = mux.geometry({ selectBits: 3, dataWidth: 8, enable: true, selectMode: "bits" });
    const dataPins = g.pins.filter((p) => /^d\d+$/.test(p.id));
    const selPins = g.pins.filter((p) => /^s\d+$/.test(p.id));
    expect(dataPins).toHaveLength(8);
    expect(selPins).toHaveLength(3);
    expect(dataPins.every((p) => p.width === 8)).toBe(true);
    expect(g.pins.some((p) => p.id === "en")).toBe(true);
  });

  it("Register File creates all port pins and expands bits in bits mode", () => {
    const rf = getDef("register-file")!;
    const gBus = rf.geometry({ addressBits: 5, dataWidth: 32, readPorts: 3, writePorts: 2, pinMode: "bus" });
    const ids = new Set(gBus.pins.map((p) => p.id));
    for (const id of ["ra1", "ra2", "ra3", "rd1", "rd2", "rd3", "wa1", "wa2", "wd1", "wd2", "we1", "we2", "clk"]) {
      expect(ids.has(id), `missing register-file pin ${id}`).toBe(true);
    }

    const gBits = rf.geometry({ addressBits: 2, dataWidth: 4, readPorts: 2, writePorts: 1, pinMode: "bits" });
    // 2 read ports * 2 addr + 1 write * (2 addr + 4 data + 1 we) + 1 clk + 2 read ports * 4 data = 4 + 7 + 1 + 8 = 20
    expect(gBits.pins).toHaveLength(20);
  });

  it("Flip-flops reflect edge, async set/reset, enable, and Q' toggles", () => {
    const dff = getDef("d-ff")!;
    const g = dff.geometry({
      edge: "falling",
      asyncReset: "active-low",
      asyncSet: "active-high",
      enable: true,
      showQBar: true,
    });
    const clk = g.pins.find((p) => p.id === "clk")!;
    const rst = g.pins.find((p) => p.id === "rst")!;
    const set = g.pins.find((p) => p.id === "set")!;
    const qn = g.pins.find((p) => p.id === "qn")!;
    expect(clk.clock).toBe(true);
    expect(clk.inverted).toBe(true);
    expect(rst.inverted).toBe(true);
    expect(set.inverted).toBe(false);
    expect(qn.inverted).toBe(true);
    expect(g.pins.some((p) => p.id === "en")).toBe(true);
  });

  it("Tunnel has type id 'tunnel' and Generic Block parses custom comma-separated names", () => {
    const tunnel = getDef("tunnel");
    expect(tunnel).toBeDefined();
    expect(tunnel!.symbol({ name: "ALU_OUT", width: 16 })).toContain("ALU_OUT[15:0]");

    const blk = getDef("generic-block")!;
    const g = blk.geometry({
      title: "CTRL",
      inputs: 3,
      outputs: 2,
      inputNames: "Op, Funct, Zero",
      outputNames: "RegWrite, MemWrite",
    });
    expect(g.pins.map((p) => p.name)).toEqual(["Op", "Funct", "Zero", "RegWrite", "MemWrite"]);
  });

  it("RAM switches between separate and shared data ports", () => {
    const ram = getDef("ram")!;
    const sep = ram.geometry({ addressBits: 8, dataWidth: 16, dataPortMode: "separate", pinMode: "bus", chipSelect: true });
    expect(sep.pins.some((p) => p.id === "wd" && p.dir === "in")).toBe(true);
    expect(sep.pins.some((p) => p.id === "rd" && p.dir === "out")).toBe(true);
    expect(sep.pins.some((p) => p.id === "cs")).toBe(true);

    const shared = ram.geometry({ addressBits: 8, dataWidth: 16, dataPortMode: "shared", pinMode: "bus", chipSelect: false });
    expect(shared.pins.some((p) => p.id === "dq" && p.dir === "inout")).toBe(true);
    expect(shared.pins.some((p) => p.id === "oe")).toBe(true);
  });
});

/** Extract <text ...>label</text> positions from an SVG fragment for overlap assertions. */
function parseTextElements(svg: string): { text: string; x: number; y: number; anchor: string; cls: string }[] {
  const out: { text: string; x: number; y: number; anchor: string; cls: string }[] = [];
  const re = /<text\b([^>]*)>([^<]*)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const attrs = m[1];
    const text = m[2];
    const x = Number(/x="([^"]+)"/.exec(attrs)?.[1] ?? NaN);
    const y = Number(/y="([^"]+)"/.exec(attrs)?.[1] ?? NaN);
    const anchor = /text-anchor="([^"]+)"/.exec(attrs)?.[1] ?? "start";
    const cls = /class="([^"]+)"/.exec(attrs)?.[1] ?? "";
    out.push({ text, x, y, anchor, cls });
  }
  return out;
}

function textSpanX(t: { text: string; x: number; anchor: string; cls: string }): [number, number] {
  const charW = t.cls.includes("ds-title") ? 8 : 6;
  const w = t.text.length * charW;
  if (t.anchor === "middle") return [t.x - w / 2, t.x + w / 2];
  if (t.anchor === "end") return [t.x - w, t.x];
  return [t.x, t.x + w];
}

describe("pin spacing and label clearance invariants", () => {
  const SIDES: Side[] = ["left", "right", "top", "bottom"];

  for (const def of ALL_DEFS) {
    it(`${def.type} keeps same-side pins >= 10 apart and top/bottom pins >= 20 apart across prop sweep`, () => {
      const configs = sweepProps(def);

      for (const props of configs) {
        const ctx = `${def.type}(${JSON.stringify(props)})`;
        const g = def.geometry(props);
        const svg = def.symbol(props);
        const isBoxStyle = svg.includes('<rect class="ds-body"');

        for (const side of SIDES) {
          const sidePins: PinDef[] = g.pins.filter((p) => p.side === side);
          if (sidePins.length < 2) continue;

          const horizontal = side === "top" || side === "bottom";
          const sorted = [...sidePins].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));

          for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1];
            const b = sorted[i];
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            expect(dist, `${ctx}: pins ${a.id} and ${b.id} on ${side} too close (${dist})`).toBeGreaterThanOrEqual(GRID);

            if (horizontal) {
              const axisDist = b.x - a.x;
              if (isBoxStyle) {
                expect(
                  axisDist,
                  `${ctx}: box ${side} pins ${a.id} and ${b.id} must be >= 20 apart (got ${axisDist})`,
                ).toBeGreaterThanOrEqual(2 * GRID);
              }
              const minLabelDist = Math.max(a.name.length, b.name.length) * 6 + 4;
              expect(
                axisDist,
                `${ctx}: ${side} pin labels "${a.name}" and "${b.name}" need >= ${minLabelDist} clearance (got ${axisDist})`,
              ).toBeGreaterThanOrEqual(minLabelDist);
            }
          }
        }
      }
    });
  }

  it("MUX uses 20-unit data pin spacing for selectBits >= 3 and avoids title/Y overlap", () => {
    const mux = getDef("mux")!;
    for (const selectBits of [1, 2, 3, 4, 5]) {
      for (const extra of [
        { dataWidth: 1, enable: false },
        { dataWidth: 8, enable: true },
      ]) {
        const props = { selectBits, ...extra, selectMode: "bits" };
        const g = mux.geometry(props);
        const dataPins = g.pins.filter((p) => p.side === "left").sort((a, b) => a.y - b.y);
        expect(dataPins).toHaveLength(1 << selectBits);
        for (let i = 1; i < dataPins.length; i++) {
          expect(dataPins[i].y - dataPins[i - 1].y).toBe(20);
        }
        // First/last data pins stay at least 20 units clear of the top/bottom slanted edges
        const bodyH = g.height - 20;
        expect(dataPins[0].y).toBeGreaterThanOrEqual(20);
        expect(bodyH - dataPins[dataPins.length - 1].y).toBeGreaterThanOrEqual(20);

        const texts = parseTextElements(mux.symbol(props));
        const title = texts.find((t) => t.text === "MUX")!;
        const outY = texts.find((t) => t.text === "Y")!;
        expect(title).toBeDefined();
        expect(outY).toBeDefined();
        const [, titleRight] = textSpanX(title);
        const [yLeft] = textSpanX(outY);
        expect(yLeft, `MUX(${JSON.stringify(props)}): Y overlaps MUX title`).toBeGreaterThan(titleRight + 2);
      }
    }
  });

  it("DEMUX uses 20-unit output pin spacing and avoids D/DMUX title overlap", () => {
    const demux = getDef("demux")!;
    for (const selectBits of [1, 2, 3, 4, 5]) {
      for (const extra of [
        { dataWidth: 1, enable: false },
        { dataWidth: 8, enable: true },
      ]) {
        const props = { selectBits, ...extra, selectMode: "bits" };
        const g = demux.geometry(props);
        const outPins = g.pins.filter((p) => p.side === "right").sort((a, b) => a.y - b.y);
        expect(outPins).toHaveLength(1 << selectBits);
        for (let i = 1; i < outPins.length; i++) {
          expect(outPins[i].y - outPins[i - 1].y).toBe(20);
        }

        const texts = parseTextElements(demux.symbol(props));
        const title = texts.find((t) => t.text === "DMUX")!;
        const inD = texts.find((t) => t.text === "D")!;
        expect(title).toBeDefined();
        expect(inD).toBeDefined();
        const [, dRight] = textSpanX(inD);
        const [titleLeft] = textSpanX(title);
        expect(titleLeft, `DEMUX(${JSON.stringify(props)}): D overlaps DMUX title`).toBeGreaterThan(dRight + 2);
      }
    }
  });

  it("Register File with writePorts=2 spaces WE1 and WE2 at least 40 units apart", () => {
    const rf = getDef("register-file")!;
    const g = rf.geometry({ addressBits: 5, dataWidth: 32, readPorts: 2, writePorts: 2, pinMode: "bus" });
    const we1 = g.pins.find((p) => p.id === "we1")!;
    const we2 = g.pins.find((p) => p.id === "we2")!;
    expect(we1).toBeDefined();
    expect(we2).toBeDefined();
    expect(Math.hypot(we2.x - we1.x, we2.y - we1.y)).toBeGreaterThanOrEqual(40);
  });

  it("Shifter spaces shamt pins cleanly and widens the body to fit", () => {
    const shf = getDef("shifter")!;
    for (const shiftBits of [3, 5]) {
      const g = shf.geometry({ width: 8, shiftBits, pinMode: "bus", mode: "universal" });
      const shPins = g.pins.filter((p) => p.side === "bottom").sort((a, b) => a.x - b.x);
      expect(shPins).toHaveLength(shiftBits);
      for (let i = 1; i < shPins.length; i++) {
        // "SH0" is 3 chars -> 3*6 + 4 = 22 -> grid-snapped >= 30 (and >= 20)
        expect(shPins[i].x - shPins[i - 1].x).toBeGreaterThanOrEqual(22);
      }
      // Outermost shamt pins stay inside the body with room for labels
      expect(shPins[0].x).toBeGreaterThanOrEqual(40);
      expect(g.width - shPins[shPins.length - 1].x).toBeGreaterThanOrEqual(40);
    }
  });

  it("ALU spaces Y and N/Z/C/V flag outputs 20 units apart", () => {
    const alu = getDef("alu")!;
    const g = alu.geometry({
      width: 32,
      opBits: 3,
      opPinMode: "bits",
      flagN: true,
      flagZ: true,
      flagC: true,
      flagV: true,
    });
    const rightPins = g.pins.filter((p) => p.side === "right").sort((a, b) => a.y - b.y);
    expect(rightPins.map((p) => p.id)).toEqual(["y", "n", "z", "c", "v"]);
    for (let i = 1; i < rightPins.length; i++) {
      expect(rightPins[i].y - rightPins[i - 1].y).toBe(20);
    }
  });

  it("layoutBox grows spacing and body width when top/bottom pin labels are wide", () => {
    const layout = layoutBox({
      left: [{ id: "a", name: "A", dir: "in" }],
      right: [{ id: "y", name: "Y", dir: "out" }],
      top: [
        { id: "e0", name: "ENABLE0", dir: "in" },
        { id: "e1", name: "ENABLE1", dir: "in" },
      ],
      bottom: [
        { id: "s0", name: "SEL0", dir: "in" },
        { id: "s1", name: "SEL1", dir: "in" },
        { id: "s2", name: "SEL2", dir: "in" },
      ],
      minBodyW: 60,
    });
    const topPins = layout.geometry.pins.filter((p) => p.side === "top").sort((a, b) => a.x - b.x);
    const botPins = layout.geometry.pins.filter((p) => p.side === "bottom").sort((a, b) => a.x - b.x);
    // "ENABLE0" len 7 -> 7*6 + 4 = 46 -> >= 50
    expect(topPins[1].x - topPins[0].x).toBeGreaterThanOrEqual(46);
    // "SEL0" len 4 -> 4*6 + 4 = 28 -> >= 30
    expect(botPins[1].x - botPins[0].x).toBeGreaterThanOrEqual(28);
    expect(botPins[2].x - botPins[1].x).toBeGreaterThanOrEqual(28);
    expect(layout.bodyW).toBeGreaterThan(60);
  });
});

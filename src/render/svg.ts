/**
 * CORE CONTRACT — the ONE renderer. Both the live editor canvas and SVG/PNG
 * export use these functions, so what you see is what you export.
 */
import type { ComponentInstance, SchematicDocument, TextNote, Wire } from "../model/types";
import { escapeXml } from "../model/component-def";
import { getDef } from "../model/registry";
import { documentBounds, effectiveProps, geometryOf, labelAnchor, junctionPoints, svgTransform, type Rect } from "../model/geometry";

export interface Theme {
  name: string;
  background: string;
  ink: string;
  body: string;
  wire: string;
  bus: string;
  text: string;
  junction: string;
  grid: string;
}

export const LIGHT_THEME: Theme = {
  name: "light",
  background: "#ffffff",
  ink: "#1a1a1a",
  body: "#fffdf5",
  wire: "#1f5fbf",
  bus: "#0d3d80",
  text: "#1a1a1a",
  junction: "#1f5fbf",
  grid: "#c9d0db",
};

/** Monochrome theme suited for lab reports / printing. */
export const PRINT_THEME: Theme = {
  name: "print",
  background: "#ffffff",
  ink: "#000000",
  body: "#ffffff",
  wire: "#000000",
  bus: "#000000",
  text: "#000000",
  junction: "#000000",
  grid: "#e0e0e0",
};

export const DARK_THEME: Theme = {
  name: "dark",
  background: "#1b1e24",
  ink: "#d7dce4",
  body: "#262a33",
  wire: "#5fb3ff",
  bus: "#9fd0ff",
  text: "#d7dce4",
  junction: "#5fb3ff",
  grid: "#353b47",
};

export const THEMES: Record<string, Theme> = { light: LIGHT_THEME, print: PRINT_THEME, dark: DARK_THEME };

const FONT = `"Segoe UI",Arial,Helvetica,sans-serif`;

/** Concrete-color stylesheet (no CSS variables, so exports open cleanly in Inkscape/Illustrator). */
export function schematicCss(t: Theme): string {
  return [
    `.ds-body{fill:${t.body};stroke:${t.ink};stroke-width:2;stroke-linejoin:round}`,
    `.ds-line{fill:none;stroke:${t.ink};stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`,
    `.ds-thin{fill:none;stroke:${t.ink};stroke-width:1}`,
    `.ds-pin{fill:none;stroke:${t.ink};stroke-width:2;stroke-linecap:round}`,
    `.ds-bubble{fill:${t.background};stroke:${t.ink};stroke-width:2}`,
    `.ds-fill{fill:${t.ink};stroke:none}`,
    `.ds-text{fill:${t.text};font-family:${FONT};font-size:10px}`,
    `.ds-title{fill:${t.text};font-family:${FONT};font-size:12px;font-weight:600}`,
    `.ds-label{fill:${t.text};font-family:${FONT};font-size:11px;font-style:italic}`,
    `.ds-note{fill:${t.text};font-family:${FONT}}`,
    `.ds-wire{fill:none;stroke:${t.wire};stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`,
    `.ds-bus{fill:none;stroke:${t.bus};stroke-width:4;stroke-linecap:round;stroke-linejoin:round}`,
    `.ds-bus-text{fill:${t.bus};font-family:${FONT};font-size:9px}`,
    `.ds-junction{fill:${t.junction};stroke:none}`,
    `.ds-unknown{fill:${t.name === "dark" ? "#3a1e1e" : "#ffecec"};stroke:#d33;stroke-width:2;stroke-dasharray:4 3}`,
  ].join("\n");
}

/** A component as a <g> with data-id, positioned via transform. */
export function renderComponent(inst: ComponentInstance): string {
  const def = getDef(inst.type);
  const g = geometryOf(inst);
  const tf = svgTransform(inst, g);
  const inner = def
    ? def.symbol(effectiveProps(inst))
    : `<rect class="ds-unknown" x="0" y="0" width="${g.width}" height="${g.height}"/><text class="ds-text" x="4" y="14">?${escapeXml(inst.type)}</text>`;
  const label = inst.label ? renderLabel(inst) : "";
  return `<g class="ds-comp" data-id="${escapeXml(inst.id)}"><g transform="${tf}">${uprightText(inner, inst)}</g>${label}</g>`;
}

type M2 = [number, number, number, number]; // [a, b, c, d]: x' = a x + c y, y' = b x + d y
const mul = (m: M2, n: M2): M2 => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3]];
const ROT: Record<number, M2> = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
const FLIP_X: M2 = [-1, 0, 0, 1];

/**
 * Keep symbol text readable whatever the instance's rotation/mirror: each <text> gets a
 * counter-transform about its own glyph center so it ends up left-to-right (0°/180°) or
 * bottom-to-top (90°/270°), never mirrored or upside-down. text-anchor is swapped when the
 * reading direction reverses so the text keeps occupying the same side of its anchor.
 */
function uprightText(inner: string, inst: ComponentInstance): string {
  const rot = inst.rotation ?? 0;
  const t: M2 = inst.mirror ? mul(ROT[rot], FLIP_X) : ROT[rot];
  const desired: M2 = rot === 90 || rot === 270 ? ROT[270] : ROT[0];
  // counter C = T^-1 * D  (T is orthonormal: inverse = transpose)
  const tInv: M2 = [t[0], t[2], t[1], t[3]];
  const c = mul(tInv, desired);
  if (c[0] === 1 && c[1] === 0 && c[2] === 0 && c[3] === 1) return inner;
  // Reading direction in world before vs after: T*(1,0) vs D*(1,0)
  const reversed = t[0] * desired[0] + t[1] * desired[1] < 0;
  // Attribute names are matched after whitespace so `x=` never matches inside `dx=` etc.
  return inner.replace(/<text(\s[^>]*)?>/g, (whole, attrs: string = "") => {
    if (/\stransform=/.test(attrs)) return whole;
    const x = Number(/\sx="(-?[\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const y = Number(/\sy="(-?[\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const fs = /ds-title/.test(attrs) ? 12 : /ds-label/.test(attrs) ? 11 : 10;
    const cy = y - fs * 0.35; // approx. vertical glyph center (y is the baseline)
    let a = attrs;
    if (reversed) {
      const anchor = /text-anchor="(\w+)"/.exec(a)?.[1] ?? "start";
      const swapped = anchor === "start" ? "end" : anchor === "end" ? "start" : anchor;
      a = /text-anchor=/.test(a) ? a.replace(/text-anchor="\w+"/, `text-anchor="${swapped}"`) : `${a} text-anchor="${swapped}"`;
    }
    const tf = `translate(${x} ${cy}) matrix(${c[0]} ${c[1]} ${c[2]} ${c[3]} 0 0) translate(${-x} ${-cy})`;
    return `<text${a} transform="${tf}">`;
  });
}

/**
 * Labels are drawn upright in world space, centered above the body — or below it when
 * pins/wires leave from the top edge, so the label never sits on a wire.
 */
function renderLabel(inst: ComponentInstance): string {
  const a = labelAnchor(inst);
  return `<text class="ds-label" x="${a.x}" y="${a.y}" text-anchor="${a.anchor}">${escapeXml(inst.label!)}</text>`;
}

export function renderWire(w: Wire): string {
  if (w.points.length < 2) return "";
  const d = w.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  const isBus = (w.width ?? 1) > 1;
  let extra = "";
  if (isBus) {
    // Slash + width label at the midpoint of the first segment.
    const a = w.points[0], b = w.points[1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    extra = `<path class="ds-line" d="M${mx - 4} ${my + 6} L${mx + 4} ${my - 6}"/><text class="ds-bus-text" x="${mx + 5}" y="${my - 7}">${w.width}</text>`;
  }
  return `<g class="ds-wire-g" data-id="${escapeXml(w.id)}"><path class="${isBus ? "ds-bus" : "ds-wire"}" d="${d}"/>${extra}</g>`;
}

export function renderText(t: TextNote): string {
  const fs = t.fontSize ?? 14;
  const tspans = t.text
    .split("\n")
    .map((l, i) => `<tspan x="${t.x}" dy="${i === 0 ? 0 : fs * 1.25}">${l === "" ? "&#160;" : escapeXml(l)}</tspan>`)
    .join("");
  return `<text class="ds-note" data-id="${escapeXml(t.id)}" x="${t.x}" y="${t.y}" font-size="${fs}" xml:space="preserve">${tspans}</text>`;
}

export function renderJunctions(doc: SchematicDocument): string {
  return junctionPoints(doc)
    .map((p) => `<circle class="ds-junction" cx="${p.x}" cy="${p.y}" r="3.5"/>`)
    .join("");
}

/** Scene content (no <svg> wrapper): wires under components, junctions on top, then text. */
export function renderScene(doc: SchematicDocument): string {
  return [
    `<g class="ds-layer-wires">${doc.wires.map(renderWire).join("")}</g>`,
    `<g class="ds-layer-components">${doc.components.map(renderComponent).join("")}</g>`,
    `<g class="ds-layer-junctions">${renderJunctions(doc)}</g>`,
    `<g class="ds-layer-texts">${doc.texts.map(renderText).join("")}</g>`,
  ].join("");
}

export interface SvgExportOptions {
  theme?: Theme;
  /** Margin around content in world units. */
  padding?: number;
  /** Draw background rect (false = transparent). */
  background?: boolean;
  /** Draw grid dots. */
  grid?: boolean;
  /** Only export this region (world coords); default = document bounds. */
  region?: Rect;
}

/** Standalone SVG document string for the whole schematic. */
export function renderDocumentSvg(doc: SchematicDocument, opts: SvgExportOptions = {}): string {
  const theme = opts.theme ?? LIGHT_THEME;
  const pad = opts.padding ?? 20;
  const b = opts.region ?? documentBounds(doc) ?? { x: 0, y: 0, w: 200, h: 100 };
  // Degenerate (zero-width/height) content, e.g. a single straight wire with padding 0,
  // still yields a valid, visible image.
  const minSide = 10;
  const bw = Math.max(b.w, minSide - 2 * pad), bh = Math.max(b.h, minSide - 2 * pad);
  const vx = b.x - (bw - b.w) / 2 - pad, vy = b.y - (bh - b.h) / 2 - pad;
  const vw = bw + 2 * pad, vh = bh + 2 * pad;
  const bg = opts.background === false ? "" : `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${theme.background}"/>`;
  let grid = "";
  if (opts.grid) {
    const gs = doc.grid || 10;
    grid =
      // Dot centered in the tile (offset by half a cell) so it is not clipped into a quarter.
      `<defs><pattern id="ds-grid" x="${-gs / 2}" y="${-gs / 2}" width="${gs}" height="${gs}" patternUnits="userSpaceOnUse">` +
      `<circle cx="${gs / 2}" cy="${gs / 2}" r="0.9" fill="${theme.grid}"/></pattern></defs>` +
      `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="url(#ds-grid)"/>`;
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">` +
    `<title>${escapeXml(doc.name)}</title>` +
    `<style>${schematicCss(theme)}</style>` +
    bg + grid + renderScene(doc) +
    `</svg>\n`
  );
}

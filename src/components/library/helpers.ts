/**
 * Shared parametric layout and SVG drawing helpers for the DigiSchem component library.
 * All coordinates are in local space; all pin coordinates and bounding dimensions are
 * multiples of GRID (10) so rotation and mirroring preserve grid alignment.
 */
import type { Geometry, PinDef, PinDir, PropDef, Side } from "../../model/component-def";
import { escapeXml, GRID, propNum, SIZE_H, SIZE_W } from "../../model/component-def";
import type { PropValue } from "../../model/types";

export const PIN_LEN = 20;
export const BUBBLE_R = 4;

export function snapGrid(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function ceilGrid(v: number): number {
  return Math.ceil(v / GRID) * GRID;
}

export function ceilEvenGrid(v: number): number {
  return Math.ceil(v / (2 * GRID)) * (2 * GRID);
}

/** Read an optional requested resize dimension (`_w` / `_h`) from props, snapped to GRID. */
export function requestedSize(
  props: Record<string, PropValue> | undefined,
  key: string,
): number | undefined {
  if (!props || props[key] === undefined) return undefined;
  const n = propNum(props, key, NaN);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return snapGrid(n);
}

/**
 * Evenly distribute `count` pin coordinates on the 10-unit grid across `[lo, hi]`
 * (where `lo` and `hi` are multiples of GRID). Guarantees adjacent spacing is at
 * least `minSpacing` whenever `hi - lo >= (count - 1) * minSpacing` and `minSpacing`
 * is a multiple of GRID.
 */
export function distributeOnGrid(count: number, lo: number, hi: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [lo + snapGrid((hi - lo) / 2)];
  const steps = Math.round((hi - lo) / GRID);
  const denom = count - 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const offsetSteps = Math.floor((2 * steps * i + denom) / (2 * denom));
    out.push(lo + offsetSteps * GRID);
  }
  return out;
}

export function clampInt(
  props: Record<string, PropValue>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Math.round(propNum(props, key, fallback));
  return Math.max(min, Math.min(max, n));
}

export function formatWords(words: number): string {
  if (words >= 1024 && words % 1024 === 0) return `${words / 1024}K`;
  return String(words);
}

export const PIN_MODE_PROP: PropDef = {
  key: "pinMode",
  label: "Pin Mode",
  kind: "enum",
  options: [
    { value: "bus", label: "Bus (grouped)" },
    { value: "bits", label: "Individual bits" },
  ],
};

export interface PinSpec {
  id: string;
  name: string;
  dir: PinDir;
  inverted?: boolean;
  clock?: boolean;
  width?: number;
  /** Optional overbar on label text (e.g. Q-bar). Defaults to true when inverted is set. */
  overbar?: boolean;
}

export interface BoxSpec {
  left?: PinSpec[];
  right?: PinSpec[];
  top?: PinSpec[];
  bottom?: PinSpec[];
  title?: string;
  subtitle?: string;
  minBodyW?: number;
  minBodyH?: number;
  /** Force spacing on left/right sides (default: 20 when <= 8 pins, 10 when > 8). */
  sideSpacing?: number;
  /** Minimum spacing on top/bottom sides (always >= 20 and >= label-width clearance). */
  tbSpacing?: number;
  /** Pin stub length on sides that have pins (default: PIN_LEN = 20). */
  margin?: number;
}

export interface BoxLayout {
  geometry: Geometry;
  bodyX: number;
  bodyY: number;
  bodyW: number;
  bodyH: number;
  title?: string;
  subtitle?: string;
  hasTopPins: boolean;
  hasBottomPins: boolean;
  pinSpecs: Map<string, PinSpec>;
}

function estimateLabelWidth(p: PinSpec): number {
  const textW = p.name.length * 6.4;
  return textW + (p.clock ? 11 : 0) + 6;
}

/**
 * Minimum grid-aligned spacing between adjacent pins on a horizontal edge (top/bottom)
 * so labels are never closer than (label.length * 6 + 4) units apart.
 */
export function minEdgePinSpacing(pins: PinSpec[], minSpacing = 2 * GRID): number {
  let spacing = Math.max(2 * GRID, minSpacing);
  if (pins.length >= 2) {
    for (const p of pins) {
      spacing = Math.max(spacing, ceilGrid(p.name.length * 6 + 4));
    }
  }
  return spacing;
}

function horizontalEdgePad(pins: PinSpec[]): number {
  if (pins.length === 0) return GRID;
  const firstPad = Math.max(GRID, ceilGrid((pins[0].name.length * 6 + 4) / 2));
  const lastPad = Math.max(GRID, ceilGrid((pins[pins.length - 1].name.length * 6 + 4) / 2));
  return Math.max(firstPad, lastPad);
}

function horizontalEdgeNeedW(pins: PinSpec[], spacing: number): number {
  if (pins.length === 0) return 0;
  const edgePad = horizontalEdgePad(pins);
  return (pins.length - 1) * spacing + 2 * edgePad;
}

/**
 * Compute grid-aligned bounding box and pin coordinates for a rectangular IC / block.
 * Pin stubs extend outward from the body rectangle to the exact bounding box edge.
 * When `props` carries `_w` / `_h` resize requests, treats them as minimum total
 * local dimensions (width/height) and distributes pins evenly along enlarged edges.
 */
export function layoutBox(spec: BoxSpec, props?: Record<string, PropValue>): BoxLayout {
  const left = spec.left ?? [];
  const right = spec.right ?? [];
  const top = spec.top ?? [];
  const bottom = spec.bottom ?? [];
  const margin = spec.margin ?? PIN_LEN;

  const maxLR = Math.max(left.length, right.length);
  const sideSpacing = spec.sideSpacing ?? (maxLR <= 8 ? 2 * GRID : GRID);
  const minTB = Math.max(2 * GRID, spec.tbSpacing ?? 2 * GRID);
  const topSpacing = minEdgePinSpacing(top, minTB);
  const botSpacing = minEdgePinSpacing(bottom, minTB);

  const maxLeftW = left.reduce((m, p) => Math.max(m, estimateLabelWidth(p)), 0);
  const maxRightW = right.reduce((m, p) => Math.max(m, estimateLabelWidth(p)), 0);
  const titleW = spec.title ? spec.title.length * 7.8 + 16 : 0;
  const subW = spec.subtitle ? spec.subtitle.length * 6.4 + 16 : 0;
  const headerW = Math.max(titleW, subW);

  const topNeedW = horizontalEdgeNeedW(top, topSpacing);
  const botNeedW = horizontalEdgeNeedW(bottom, botSpacing);

  // Put title in top header strip when there are no top pins and enough height;
  // otherwise ensure center has room between left and right pin labels.
  const titleInHeader = Boolean(spec.title) && top.length === 0 && maxLR >= 2;
  const centerGap = titleInHeader ? 14 : Math.max(14, headerW);

  const minBodyW = spec.minBodyW ?? 60;
  const computedBodyW = ceilGrid(Math.max(minBodyW, maxLeftW + maxRightW + centerGap, headerW, topNeedW, botNeedW));

  const topHasClock = top.some((p) => p.clock);
  const botHasClock = bottom.some((p) => p.clock);
  const topPad = top.length > 0 ? (topHasClock ? 30 : 20) : titleInHeader ? (spec.subtitle ? 30 : 20) : 10;
  const botPad = bottom.length > 0 ? (botHasClock ? 30 : 20) : 10;
  const lrSpan = maxLR > 0 ? (maxLR - 1) * sideSpacing : 0;
  const minBodyH = spec.minBodyH ?? 40;
  const computedBodyH = ceilGrid(Math.max(minBodyH, topPad + lrSpan + botPad));

  const bodyX = left.length > 0 ? margin : 0;
  const rightMargin = right.length > 0 ? margin : 0;
  const bodyY = top.length > 0 ? margin : 0;
  const bottomMargin = bottom.length > 0 ? margin : 0;

  const reqW = requestedSize(props, SIZE_W);
  const reqH = requestedSize(props, SIZE_H);
  const bodyW = reqW !== undefined ? Math.max(computedBodyW, reqW - bodyX - rightMargin) : computedBodyW;
  const bodyH = reqH !== undefined ? Math.max(computedBodyH, reqH - bodyY - bottomMargin) : computedBodyH;
  const widened = bodyW > computedBodyW;
  const heightened = bodyH > computedBodyH;

  const width = bodyX + bodyW + rightMargin;
  const height = bodyY + bodyH + bottomMargin;

  const pins: PinDef[] = [];
  const pinSpecs = new Map<string, PinSpec>();

  const placeVertical = (list: PinSpec[], side: "left" | "right", x: number) => {
    if (list.length === 0) return;
    const availTop = bodyY + topPad;
    const availBot = bodyY + bodyH - botPad;
    const availH = availBot - availTop;
    const ys = heightened
      ? (() => {
          // Spread with equal margins (≈ availH/(n+1)) instead of pinning the outer pins to
          // the body corners; fall back to the full span if margins would crowd the pins.
          const n = list.length;
          const margin = snapGrid(availH / (n + 1));
          const lo = availTop + margin, hi = availBot - margin;
          return n > 1 && hi - lo >= (n - 1) * sideSpacing ? distributeOnGrid(n, lo, hi) : distributeOnGrid(n, availTop, availBot);
        })()
      : (() => {
          const span = (list.length - 1) * sideSpacing;
          const startY = availTop + snapGrid(Math.max(0, (availH - span) / 2));
          return Array.from({ length: list.length }, (_, i) => startY + i * sideSpacing);
        })();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      pinSpecs.set(p.id, p);
      pins.push({
        id: p.id,
        name: p.name,
        x,
        y: ys[i],
        dir: p.dir,
        side,
        inverted: p.inverted,
        clock: p.clock,
        width: p.width,
      });
    }
  };

  const placeHorizontal = (list: PinSpec[], side: "top" | "bottom", y: number, spacing: number) => {
    if (list.length === 0) return;
    const xs = widened
      ? list.length === 1
        ? [bodyX + snapGrid(bodyW / 2)]
        : (() => {
            const edgePad = horizontalEdgePad(list);
            return distributeOnGrid(list.length, bodyX + edgePad, bodyX + bodyW - edgePad);
          })()
      : (() => {
          const span = (list.length - 1) * spacing;
          const startX = bodyX + Math.max(GRID, snapGrid((bodyW - span) / 2));
          return Array.from({ length: list.length }, (_, i) => startX + i * spacing);
        })();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      pinSpecs.set(p.id, p);
      pins.push({
        id: p.id,
        name: p.name,
        x: xs[i],
        y,
        dir: p.dir,
        side,
        inverted: p.inverted,
        clock: p.clock,
        width: p.width,
      });
    }
  };

  placeVertical(left, "left", 0);
  placeVertical(right, "right", width);
  placeHorizontal(top, "top", 0, topSpacing);
  placeHorizontal(bottom, "bottom", height, botSpacing);

  return {
    geometry: { width, height, pins },
    bodyX,
    bodyY,
    bodyW,
    bodyH,
    title: spec.title,
    subtitle: spec.subtitle,
    hasTopPins: top.length > 0,
    hasBottomPins: bottom.length > 0,
    pinSpecs,
  };
}

/** Draw a bus slash tick + width number on a horizontal or vertical pin stub. */
export function drawBusTick(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number | undefined,
): string {
  if (!width || width <= 1) return "";
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const horizontal = Math.abs(y2 - y1) < Math.abs(x2 - x1);
  if (horizontal) {
    return (
      `<path class="ds-thin" d="M${mx - 2.5} ${my + 4} L${mx + 2.5} ${my - 4}"/>` +
      `<text class="ds-bus-text" x="${mx}" y="${my - 5}" text-anchor="middle">${width}</text>`
    );
  }
  return (
    `<path class="ds-thin" d="M${mx - 4} ${my + 2.5} L${mx + 4} ${my - 2.5}"/>` +
    `<text class="ds-bus-text" x="${mx + 5}" y="${my + 3}">${width}</text>`
  );
}

/**
 * Draw a single pin stub from the body edge (edgeX, edgeY) to the pin tip (pin.x, pin.y),
 * including optional inversion bubble and bus-width slash.
 */
export function drawPinStub(pin: PinDef, edgeX: number, edgeY: number): string {
  const dx = pin.x - edgeX;
  const dy = pin.y - edgeY;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return "";
  const ux = dx / len;
  const uy = dy / len;

  let out = "";
  let stubStartX = edgeX;
  let stubStartY = edgeY;
  if (pin.inverted) {
    const cx = edgeX + ux * BUBBLE_R;
    const cy = edgeY + uy * BUBBLE_R;
    out += `<circle class="ds-bubble" cx="${cx}" cy="${cy}" r="${BUBBLE_R}"/>`;
    stubStartX = edgeX + ux * (2 * BUBBLE_R);
    stubStartY = edgeY + uy * (2 * BUBBLE_R);
  }
  out += `<line class="ds-pin" x1="${stubStartX}" y1="${stubStartY}" x2="${pin.x}" y2="${pin.y}"/>`;
  if (pin.width && pin.width > 1) {
    out += drawBusTick(stubStartX, stubStartY, pin.x, pin.y, pin.width);
  }
  return out;
}

/** Draw the clock edge triangle marker inside the body edge at (edgeX, edgeY). */
export function drawClockTriangle(side: Side, edgeX: number, edgeY: number): string {
  switch (side) {
    case "left":
      return `<path class="ds-line" d="M${edgeX} ${edgeY - 5} L${edgeX + 8} ${edgeY} L${edgeX} ${edgeY + 5}"/>`;
    case "right":
      return `<path class="ds-line" d="M${edgeX} ${edgeY - 5} L${edgeX - 8} ${edgeY} L${edgeX} ${edgeY + 5}"/>`;
    case "top":
      return `<path class="ds-line" d="M${edgeX - 5} ${edgeY} L${edgeX} ${edgeY + 8} L${edgeX + 5} ${edgeY}"/>`;
    case "bottom":
      return `<path class="ds-line" d="M${edgeX - 5} ${edgeY} L${edgeX} ${edgeY - 8} L${edgeX + 5} ${edgeY}"/>`;
  }
}

/** Draw a pin's name text inside a rectangular box edge, with optional clock triangle and overbar. */
export function drawBoxPinLabel(
  pin: PinDef,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  overbar = false,
): string {
  const bodyRight = bodyX + bodyW;
  const bodyBottom = bodyY + bodyH;
  let out = "";
  const label = escapeXml(pin.name);
  const textW = pin.name.length * 5.8;

  if (pin.side === "left") {
    if (pin.clock) out += drawClockTriangle("left", bodyX, pin.y);
    const tx = bodyX + (pin.clock ? 11 : 4);
    const ty = pin.y + 3.5;
    if (pin.name) {
      out += `<text class="ds-text" x="${tx}" y="${ty}" text-anchor="start">${label}</text>`;
      if (overbar) out += `<line class="ds-thin" x1="${tx}" y1="${ty - 9}" x2="${tx + textW}" y2="${ty - 9}"/>`;
    }
  } else if (pin.side === "right") {
    if (pin.clock) out += drawClockTriangle("right", bodyRight, pin.y);
    const tx = bodyRight - (pin.clock ? 11 : 4);
    const ty = pin.y + 3.5;
    if (pin.name) {
      out += `<text class="ds-text" x="${tx}" y="${ty}" text-anchor="end">${label}</text>`;
      if (overbar) out += `<line class="ds-thin" x1="${tx - textW}" y1="${ty - 9}" x2="${tx}" y2="${ty - 9}"/>`;
    }
  } else if (pin.side === "top") {
    if (pin.clock) out += drawClockTriangle("top", pin.x, bodyY);
    const ty = bodyY + (pin.clock ? 17 : 12);
    if (pin.name) {
      out += `<text class="ds-text" x="${pin.x}" y="${ty}" text-anchor="middle">${label}</text>`;
      if (overbar) out += `<line class="ds-thin" x1="${pin.x - textW / 2}" y1="${ty - 9}" x2="${pin.x + textW / 2}" y2="${ty - 9}"/>`;
    }
  } else {
    if (pin.clock) out += drawClockTriangle("bottom", pin.x, bodyBottom);
    const ty = bodyBottom - (pin.clock ? 11 : 5);
    if (pin.name) {
      out += `<text class="ds-text" x="${pin.x}" y="${ty}" text-anchor="middle">${label}</text>`;
      if (overbar) out += `<line class="ds-thin" x1="${pin.x - textW / 2}" y1="${ty - 9}" x2="${pin.x + textW / 2}" y2="${ty - 9}"/>`;
    }
  }
  return out;
}

/** Render a complete rectangular component from a BoxLayout. */
export function renderBox(layout: BoxLayout, extraInner = ""): string {
  const { bodyX, bodyY, bodyW, bodyH, geometry, title, subtitle, hasTopPins, pinSpecs } = layout;
  const bodyRight = bodyX + bodyW;
  const bodyBottom = bodyY + bodyH;

  let svg = `<rect class="ds-body" x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}"/>`;

  if (extraInner) svg += extraInner;

  // Title & subtitle
  const cx = bodyX + bodyW / 2;
  const maxLR = Math.max(
    geometry.pins.filter((p) => p.side === "left").length,
    geometry.pins.filter((p) => p.side === "right").length,
  );
  const titleInHeader = Boolean(title) && !hasTopPins && maxLR >= 2;
  if (title) {
    if (titleInHeader) {
      svg += `<text class="ds-title" x="${cx}" y="${bodyY + 14}" text-anchor="middle">${escapeXml(title)}</text>`;
      if (subtitle) {
        svg += `<text class="ds-text" x="${cx}" y="${bodyY + 25}" text-anchor="middle">${escapeXml(subtitle)}</text>`;
      }
    } else {
      const cy = bodyY + bodyH / 2 + (subtitle ? -2 : 4);
      svg += `<text class="ds-title" x="${cx}" y="${cy}" text-anchor="middle">${escapeXml(title)}</text>`;
      if (subtitle) {
        svg += `<text class="ds-text" x="${cx}" y="${cy + 12}" text-anchor="middle">${escapeXml(subtitle)}</text>`;
      }
    }
  }

  // Pins, stubs, bubbles, clock triangles, labels
  for (const pin of geometry.pins) {
    let edgeX = pin.x;
    let edgeY = pin.y;
    if (pin.side === "left") edgeX = bodyX;
    else if (pin.side === "right") edgeX = bodyRight;
    else if (pin.side === "top") edgeY = bodyY;
    else edgeY = bodyBottom;

    svg += drawPinStub(pin, edgeX, edgeY);
    const spec = pinSpecs.get(pin.id);
    const showOverbar = spec?.overbar ?? false;
    svg += drawBoxPinLabel(pin, bodyX, bodyY, bodyW, bodyH, showOverbar);
  }

  return svg;
}

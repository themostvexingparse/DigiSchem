/**
 * Plexer components: MUX, DEMUX, Decoder, Priority Encoder, and Tri-State Buffer.
 * MUX and DEMUX feature classic textbook trapezoid bodies with stubs meeting slanted edges.
 */
import type { ComponentDef, Geometry, PinDef } from "../../model/component-def";
import { escapeXml, GRID, propBool, propStr, SIZE_H, SIZE_W } from "../../model/component-def";
import type { PropValue } from "../../model/types";
import {
  BUBBLE_R,
  ceilEvenGrid,
  clampInt,
  distributeOnGrid,
  drawBusTick,
  drawPinStub,
  layoutBox,
  minEdgePinSpacing,
  PIN_LEN,
  renderBox,
  requestedSize,
  snapGrid,
  type PinSpec,
} from "./helpers";

const SELECT_MODE_PROP = {
  key: "selectMode",
  label: "Select Pins",
  kind: "enum" as const,
  options: [
    { value: "bits", label: "Individual (S0..Sn)" },
    { value: "bus", label: "Bus (S)" },
  ],
};

interface TrapLayout {
  geometry: Geometry;
  bodyX: number;
  bodyW: number;
  bodyTop: number;
  bodyH: number;
  slope: number;
  isDemux: boolean;
}

function layoutMuxDemux(props: Record<string, PropValue>, isDemux: boolean): TrapLayout {
  const selectBits = clampInt(props, "selectBits", 1, 1, 5);
  const dataWidth = clampInt(props, "dataWidth", 1, 1, 32);
  const enable = propBool(props, "enable", false);
  const selectMode = propStr(props, "selectMode", "bits");
  const numChannels = 1 << selectBits;

  // Always use 20-unit spacing for data channels so labels stay well separated even for selectBits >= 3.
  const chSpacing = 2 * GRID;
  const rawBodyH = Math.max(8 * GRID, (numChannels + 1) * chSpacing);
  const computedBodyH = ceilEvenGrid(rawBodyH);

  const bottomPinsSpec: PinSpec[] = [];
  if (selectMode === "bus") {
    bottomPinsSpec.push({ id: "s", name: "S", dir: "in", width: selectBits });
  } else {
    for (let i = 0; i < selectBits; i++) {
      bottomPinsSpec.push({ id: `s${i}`, name: `S${i}`, dir: "in" });
    }
  }
  if (enable) {
    bottomPinsSpec.push({ id: "en", name: "EN", dir: "in" });
  }

  const botSpacing = minEdgePinSpacing(bottomPinsSpec, 2 * GRID);
  const title = isDemux ? "DMUX" : "MUX";
  const maxChLabelLen = String(numChannels - 1).length;
  const leftLabelW = (isDemux ? 1 : maxChLabelLen) * 6 + 12;
  const rightLabelW = (isDemux ? maxChLabelLen : 1) * 6 + 12;
  const titleW = title.length * 9 + 12;
  const subW = dataWidth > 1 ? `${dataWidth}-bit`.length * 6.4 + 12 : 0;
  const centerW = Math.max(titleW, subW);
  const botNeedW =
    bottomPinsSpec.length > 0 ? (bottomPinsSpec.length - 1) * botSpacing + 2 * 30 : 0;

  const computedBodyW = ceilEvenGrid(Math.max(80, leftLabelW + centerW + rightLabelW, botNeedW));
  const bodyX = PIN_LEN;
  const bodyTop = 0;

  const reqW = requestedSize(props, SIZE_W);
  const reqH = requestedSize(props, SIZE_H);
  const bodyW = reqW !== undefined ? Math.max(computedBodyW, reqW - 2 * PIN_LEN) : computedBodyW;
  // Keep bodyH an even multiple of GRID so midY = bodyH / 2 (Y or D pin) stays on GRID.
  const bodyH = reqH !== undefined ? Math.max(computedBodyH, ceilEvenGrid(reqH - PIN_LEN)) : computedBodyH;
  const slope = Math.min(20, Math.max(10, Math.floor((bodyH - 40) / 2)));

  const totalW = bodyX + bodyW + PIN_LEN;
  const totalH = bodyH + PIN_LEN;

  const pins: PinDef[] = [];
  const chYs =
    bodyH > computedBodyH
      ? distributeOnGrid(numChannels, 2 * GRID, bodyH - 2 * GRID)
      : (() => {
          const chSpan = (numChannels - 1) * chSpacing;
          const firstChY = Math.max(GRID, snapGrid((bodyH - chSpan) / 2));
          return Array.from({ length: numChannels }, (_, i) => firstChY + i * chSpacing);
        })();

  if (!isDemux) {
    for (let i = 0; i < numChannels; i++) {
      pins.push({
        id: `d${i}`,
        name: `${i}`,
        x: 0,
        y: chYs[i],
        dir: "in",
        side: "left",
        width: dataWidth,
      });
    }
    pins.push({
      id: "y",
      name: "Y",
      x: totalW,
      y: bodyH / 2,
      dir: "out",
      side: "right",
      width: dataWidth,
    });
  } else {
    pins.push({
      id: "d",
      name: "D",
      x: 0,
      y: bodyH / 2,
      dir: "in",
      side: "left",
      width: dataWidth,
    });
    for (let i = 0; i < numChannels; i++) {
      pins.push({
        id: `y${i}`,
        name: `${i}`,
        x: totalW,
        y: chYs[i],
        dir: "out",
        side: "right",
        width: dataWidth,
      });
    }
  }

  const botXs =
    bodyW > computedBodyW
      ? bottomPinsSpec.length === 1
        ? [bodyX + snapGrid(bodyW / 2)]
        : distributeOnGrid(bottomPinsSpec.length, bodyX + 30, bodyX + bodyW - 30)
      : (() => {
          const botSpan = (bottomPinsSpec.length - 1) * botSpacing;
          const firstBotX = bodyX + Math.max(GRID, snapGrid((bodyW - botSpan) / 2));
          return Array.from({ length: bottomPinsSpec.length }, (_, i) => firstBotX + i * botSpacing);
        })();
  for (let i = 0; i < bottomPinsSpec.length; i++) {
    const bp = bottomPinsSpec[i];
    pins.push({
      id: bp.id,
      name: bp.name,
      x: botXs[i],
      y: totalH,
      dir: "in",
      side: "bottom",
      width: bp.width,
    });
  }

  return {
    geometry: { width: totalW, height: totalH, pins },
    bodyX,
    bodyW,
    bodyTop,
    bodyH,
    slope,
    isDemux,
  };
}

function renderMuxDemux(props: Record<string, PropValue>, isDemux: boolean): string {
  const layout = layoutMuxDemux(props, isDemux);
  const { geometry, bodyX, bodyW, bodyTop, bodyH, slope } = layout;
  const bodyRight = bodyX + bodyW;
  const bodyBottom = bodyTop + bodyH;
  const dataWidth = clampInt(props, "dataWidth", 1, 1, 32);

  // Trapezoid path: MUX narrows left→right, DEMUX widens left→right.
  const d = !isDemux
    ? `M${bodyX} ${bodyTop} L${bodyRight} ${bodyTop + slope} L${bodyRight} ${bodyBottom - slope} L${bodyX} ${bodyBottom} Z`
    : `M${bodyX} ${bodyTop + slope} L${bodyRight} ${bodyTop} L${bodyRight} ${bodyBottom} L${bodyX} ${bodyBottom - slope} Z`;

  let svg = `<path class="ds-body" d="${d}"/>`;

  // Exact y on the slanted bottom edge at coordinate x
  const bottomEdgeY = (x: number): number => {
    const t = (x - bodyX) / bodyW;
    return !isDemux ? bodyBottom - t * slope : bodyBottom - (1 - t) * slope;
  };

  for (const pin of geometry.pins) {
    if (pin.side === "left") {
      svg += drawPinStub(pin, bodyX, pin.y);
      svg += `<text class="ds-text" x="${bodyX + 6}" y="${pin.y + 3.5}" text-anchor="start">${escapeXml(pin.name)}</text>`;
    } else if (pin.side === "right") {
      svg += drawPinStub(pin, bodyRight, pin.y);
      svg += `<text class="ds-text" x="${bodyRight - 6}" y="${pin.y + 3.5}" text-anchor="end">${escapeXml(pin.name)}</text>`;
    } else if (pin.side === "bottom") {
      const ey = +bottomEdgeY(pin.x).toFixed(2);
      svg += drawPinStub(pin, pin.x, ey);
      svg += `<text class="ds-text" x="${pin.x}" y="${ey - 4}" text-anchor="middle">${escapeXml(pin.name)}</text>`;
    }
  }

  const cx = bodyX + bodyW / 2;
  const cy = bodyTop + bodyH / 2;
  const title = isDemux ? "DMUX" : "MUX";
  if (bodyW >= 50) {
    svg += `<text class="ds-title" x="${cx}" y="${cy + (dataWidth > 1 ? -1 : 4)}" text-anchor="middle">${title}</text>`;
    if (dataWidth > 1) {
      svg += `<text class="ds-text" x="${cx}" y="${cy + 11}" text-anchor="middle">${dataWidth}-bit</text>`;
    }
  }

  return svg;
}

const muxDef: ComponentDef = {
  type: "mux",
  name: "Multiplexer (MUX)",
  category: "Plexers",
  labelPrefix: "MUX",
  description: "2^N-to-1 multiplexer with configurable select bits, bus width, and optional enable",
  props: [
    { key: "selectBits", label: "Select Bits", kind: "int", min: 1, max: 5 },
    { key: "dataWidth", label: "Data Width", kind: "int", min: 1, max: 32 },
    { key: "enable", label: "Enable Pin", kind: "bool" },
    SELECT_MODE_PROP,
  ],
  defaultProps: { selectBits: 1, dataWidth: 1, enable: false, selectMode: "bits" },
  resizable: "both",
  geometry: (props) => layoutMuxDemux(props, false).geometry,
  symbol: (props) => renderMuxDemux(props, false),
};

const demuxDef: ComponentDef = {
  type: "demux",
  name: "Demultiplexer (DEMUX)",
  category: "Plexers",
  labelPrefix: "DMUX",
  description: "1-to-2^N demultiplexer with configurable select bits, bus width, and optional enable",
  props: [
    { key: "selectBits", label: "Select Bits", kind: "int", min: 1, max: 5 },
    { key: "dataWidth", label: "Data Width", kind: "int", min: 1, max: 32 },
    { key: "enable", label: "Enable Pin", kind: "bool" },
    SELECT_MODE_PROP,
  ],
  defaultProps: { selectBits: 1, dataWidth: 1, enable: false, selectMode: "bits" },
  resizable: "both",
  geometry: (props) => layoutMuxDemux(props, true).geometry,
  symbol: (props) => renderMuxDemux(props, true),
};

function decoderLayout(props: Record<string, PropValue>) {
  const inputs = clampInt(props, "inputs", 2, 1, 5);
  const enable = propBool(props, "enable", true);
  const activeLow = propBool(props, "activeLowOutputs", false);
  const outputs = 1 << inputs;

  const left: PinSpec[] = [];
  for (let i = 0; i < inputs; i++) {
    left.push({ id: `a${i}`, name: `A${i}`, dir: "in" });
  }
  const right: PinSpec[] = [];
  for (let i = 0; i < outputs; i++) {
    right.push({ id: `y${i}`, name: `Y${i}`, dir: "out", inverted: activeLow, overbar: activeLow });
  }
  const bottom: PinSpec[] = enable ? [{ id: "en", name: "EN", dir: "in" }] : [];

  return layoutBox(
    {
      left,
      right,
      bottom,
      title: "DEC",
      subtitle: `${inputs}:${outputs}`,
      minBodyW: 60,
    },
    props,
  );
}

const decoderDef: ComponentDef = {
  type: "decoder",
  name: "Decoder",
  category: "Plexers",
  labelPrefix: "DEC",
  description: "N-to-2^N binary decoder with optional enable and active-low outputs",
  props: [
    { key: "inputs", label: "Input Bits", kind: "int", min: 1, max: 5 },
    { key: "enable", label: "Enable Pin", kind: "bool" },
    { key: "activeLowOutputs", label: "Active-Low Outputs", kind: "bool" },
  ],
  defaultProps: { inputs: 2, enable: true, activeLowOutputs: false },
  resizable: "both",
  geometry: (props) => decoderLayout(props).geometry,
  symbol: (props) => renderBox(decoderLayout(props)),
};

function encoderLayout(props: Record<string, PropValue>) {
  const outBits = clampInt(props, "outputBits", 2, 1, 5);
  const priority = propBool(props, "priority", true);
  const validOut = propBool(props, "validOut", true);
  const enable = propBool(props, "enable", false);
  const numIn = 1 << outBits;

  const left: PinSpec[] = [];
  for (let i = 0; i < numIn; i++) {
    left.push({ id: `d${i}`, name: `D${i}`, dir: "in" });
  }
  const right: PinSpec[] = [];
  for (let i = 0; i < outBits; i++) {
    right.push({ id: `y${i}`, name: `Y${i}`, dir: "out" });
  }
  if (validOut) {
    right.push({ id: "v", name: "V", dir: "out" });
  }
  const bottom: PinSpec[] = enable ? [{ id: "en", name: "EN", dir: "in" }] : [];

  return layoutBox(
    {
      left,
      right,
      bottom,
      title: priority ? "PRI ENC" : "ENC",
      subtitle: `${numIn}:${outBits}`,
      minBodyW: 70,
    },
    props,
  );
}

const encoderDef: ComponentDef = {
  type: "encoder",
  name: "Priority Encoder",
  category: "Plexers",
  labelPrefix: "ENC",
  description: "2^N-to-N binary or priority encoder with optional valid output and enable",
  props: [
    { key: "outputBits", label: "Output Bits", kind: "int", min: 1, max: 5 },
    { key: "priority", label: "Priority", kind: "bool" },
    { key: "validOut", label: "Valid (V) Pin", kind: "bool" },
    { key: "enable", label: "Enable Pin", kind: "bool" },
  ],
  defaultProps: { outputBits: 2, priority: true, validOut: true, enable: false },
  resizable: "both",
  geometry: (props) => encoderLayout(props).geometry,
  symbol: (props) => renderBox(encoderLayout(props)),
};

function tristateGeometry(props: Record<string, PropValue>): Geometry {
  const bitW = clampInt(props, "width", 1, 1, 32);
  const activeLow = propBool(props, "activeLowEnable", false);
  const invOut = propBool(props, "invertedOut", false);
  const outX = PIN_LEN + 40 + (invOut ? GRID : 0) + PIN_LEN;
  return {
    width: outX,
    height: 60,
    pins: [
      { id: "in", name: "A", x: 0, y: 40, dir: "in", side: "left", width: bitW },
      { id: "out", name: "Y", x: outX, y: 40, dir: "out", side: "right", width: bitW, inverted: invOut },
      { id: "en", name: "EN", x: 40, y: 0, dir: "in", side: "top", inverted: activeLow },
    ],
  };
}

const tristateDef: ComponentDef = {
  type: "tristate",
  name: "Tri-State Buffer",
  category: "Plexers",
  labelPrefix: "TRI",
  description: "Tri-state buffer with active-high or active-low enable and configurable bus width",
  props: [
    { key: "width", label: "Bit Width", kind: "int", min: 1, max: 32 },
    { key: "activeLowEnable", label: "Active-Low Enable", kind: "bool" },
    { key: "invertedOut", label: "Inverted Output", kind: "bool" },
  ],
  defaultProps: { width: 1, activeLowEnable: false, invertedOut: false },
  geometry: tristateGeometry,
  symbol(props): string {
    const g = tristateGeometry(props);
    const invOut = propBool(props, "invertedOut", false);
    const activeLow = propBool(props, "activeLowEnable", false);
    const x0 = PIN_LEN;
    const x1 = PIN_LEN + 40;
    const midY = 40;

    const inPin = g.pins[0];
    const outPin = g.pins[1];
    const enPin = g.pins[2];

    let svg = `<path class="ds-body" d="M${x0} ${midY - 20} L${x1} ${midY} L${x0} ${midY + 20} Z"/>`;

    // Input stub
    svg += `<line class="ds-pin" x1="${inPin.x}" y1="${midY}" x2="${x0}" y2="${midY}"/>`;
    svg += drawBusTick(inPin.x, midY, x0, midY, inPin.width);

    // Output stub + optional bubble
    let outStart = x1;
    if (invOut) {
      svg += `<circle class="ds-bubble" cx="${x1 + BUBBLE_R}" cy="${midY}" r="${BUBBLE_R}"/>`;
      outStart = x1 + 2 * BUBBLE_R;
    }
    svg += `<line class="ds-pin" x1="${outStart}" y1="${midY}" x2="${outPin.x}" y2="${midY}"/>`;
    svg += drawBusTick(outStart, midY, outPin.x, midY, outPin.width);

    // Enable stub descending to top edge midpoint (40, 30)
    const edgeY = 30;
    if (activeLow) {
      svg += `<circle class="ds-bubble" cx="${enPin.x}" cy="${edgeY - BUBBLE_R}" r="${BUBBLE_R}"/>`;
      svg += `<line class="ds-pin" x1="${enPin.x}" y1="${enPin.y}" x2="${enPin.x}" y2="${edgeY - 2 * BUBBLE_R}"/>`;
    } else {
      svg += `<line class="ds-pin" x1="${enPin.x}" y1="${enPin.y}" x2="${enPin.x}" y2="${edgeY}"/>`;
    }
    return svg;
  },
};

export const plexerDefs: ComponentDef[] = [muxDef, demuxDef, decoderDef, encoderDef, tristateDef];

/**
 * Switch-level CMOS parts (Harris & Harris chapter 1 style): nMOS and pMOS transistors and the
 * transmission gate. Drain/source pins are bidirectional, so they never count as outputs.
 */
import type { ComponentDef, Geometry } from "../../model/component-def";
import { BUBBLE_R } from "./helpers";

function mosDef(type: "nmos" | "pmos"): ComponentDef {
  const p = type === "pmos";
  // pMOS is drawn with its source on top (towards VDD), nMOS with its source at the bottom
  const topPin = p ? { id: "s", name: "S" } : { id: "d", name: "D" };
  const botPin = p ? { id: "d", name: "D" } : { id: "s", name: "S" };
  return {
    type,
    name: p ? "pMOS Transistor" : "nMOS Transistor",
    category: "Transistors",
    labelPrefix: "M",
    description: p
      ? "p-channel MOSFET switch: conducts between S and D when the gate G is 0"
      : "n-channel MOSFET switch: conducts between D and S when the gate G is 1",
    props: [],
    defaultProps: {},
    geometry(): Geometry {
      return {
        width: 40,
        height: 60,
        pins: [
          { id: "g", name: "G", x: 0, y: 30, dir: "in", side: "left", inverted: p },
          { ...topPin, x: 30, y: 0, dir: "inout", side: "top" },
          { ...botPin, x: 30, y: 60, dir: "inout", side: "bottom" },
        ],
      };
    },
    symbol(): string {
      const gate = p
        ? `<line class="ds-pin" x1="0" y1="30" x2="${16 - 2 * BUBBLE_R}" y2="30"/><circle class="ds-bubble" cx="${16 - BUBBLE_R}" cy="30" r="${BUBBLE_R}"/>`
        : `<line class="ds-pin" x1="0" y1="30" x2="16" y2="30"/>`;
      return (
        gate +
        `<line class="ds-line" x1="16" y1="18" x2="16" y2="42"/>` + // gate plate
        `<line class="ds-line" x1="22" y1="16" x2="22" y2="44"/>` + // channel
        `<line class="ds-line" x1="22" y1="20" x2="30" y2="20"/>` +
        `<line class="ds-pin" x1="30" y1="0" x2="30" y2="20"/>` +
        `<line class="ds-line" x1="22" y1="40" x2="30" y2="40"/>` +
        `<line class="ds-pin" x1="30" y1="40" x2="30" y2="60"/>` +
        `<text class="ds-text" x="34" y="13">${topPin.name}</text>` +
        `<text class="ds-text" x="34" y="54">${botPin.name}</text>`
      );
    },
  };
}

const transmissionGateDef: ComponentDef = {
  type: "transmission-gate",
  name: "Transmission Gate",
  category: "Transistors",
  labelPrefix: "TG",
  description: "nMOS and pMOS in parallel: passes A to B in both directions when EN = 1 (and EN' = 0)",
  props: [],
  defaultProps: {},
  geometry(): Geometry {
    return {
      width: 60,
      height: 60,
      pins: [
        { id: "a", name: "A", x: 0, y: 30, dir: "inout", side: "left" },
        { id: "b", name: "B", x: 60, y: 30, dir: "inout", side: "right" },
        { id: "en", name: "EN", x: 30, y: 0, dir: "in", side: "top" },
        { id: "enb", name: "EN'", x: 30, y: 60, dir: "in", side: "bottom", inverted: true },
      ],
    };
  },
  symbol(): string {
    return (
      `<path class="ds-body" d="M18 18 L42 30 L18 42 Z"/>` +
      `<path class="ds-line" d="M42 18 L18 30 L42 42 Z"/>` +
      `<line class="ds-pin" x1="0" y1="30" x2="18" y2="30"/>` +
      `<line class="ds-pin" x1="42" y1="30" x2="60" y2="30"/>` +
      `<line class="ds-pin" x1="30" y1="0" x2="30" y2="24"/>` +
      // EN' meets the triangles where they cross (y = 36); its bubble sits just below their corners
      `<line class="ds-line" x1="30" y1="36" x2="30" y2="42"/>` +
      `<circle class="ds-bubble" cx="30" cy="${42 + BUBBLE_R}" r="${BUBBLE_R}"/>` +
      `<line class="ds-pin" x1="30" y1="${42 + 2 * BUBBLE_R}" x2="30" y2="60"/>`
    );
  },
};

export const transistorDefs: ComponentDef[] = [mosDef("nmos"), mosDef("pmos"), transmissionGateDef];

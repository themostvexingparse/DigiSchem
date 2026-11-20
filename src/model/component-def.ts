/**
 * CORE CONTRACT — component definitions.
 *
 * Every component type (gate, latch, flip-flop, register, mux...) is a ComponentDef
 * registered with registerComponent(). Geometry is expressed in LOCAL coordinates:
 * origin (0,0) is the top-left of the body's bounding box, x→right, y→down,
 * unrotated, unmirrored. Pins MUST be at multiples of GRID (10) so they stay
 * on-grid after any rotation. Pin positions are where wires attach (the tip of
 * the pin stub, usually on the bounding box edge or GRID outside it).
 */
import type { PropValue } from "./types";

export const GRID = 10;

export type PinDir = "in" | "out" | "inout";
export type Side = "left" | "right" | "top" | "bottom";

export interface PinDef {
  id: string;
  /** Display name, e.g. "D", "CLK", "Q", "S0". Rendered by the symbol if desired. */
  name: string;
  x: number;
  y: number;
  dir: PinDir;
  side: Side;
  /** Draw inversion bubble (symbol responsibility, informational here). */
  inverted?: boolean;
  /** Clock input (triangle marker). */
  clock?: boolean;
  /** Bus width, default 1. */
  width?: number;
}

export interface PropDef {
  key: string;
  label: string;
  kind: "int" | "enum" | "bool" | "string";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export interface Geometry {
  /** Body bounding box in local coords (used for selection & hit testing). */
  width: number;
  height: number;
  pins: PinDef[];
}

export interface ComponentDef {
  type: string;
  /** Human name shown in the palette. */
  name: string;
  /** Palette category: "Gates" | "Plexers" | "Arithmetic" | "Latches" | "Flip-Flops" | "Registers" | "I/O" | ... */
  category: string;
  /** Short description / tooltip. */
  description?: string;
  /** Default label prefix for auto-labeling ("U", "FF", "REG", "MUX"...). */
  labelPrefix?: string;
  props: PropDef[];
  defaultProps: Record<string, PropValue>;
  geometry(props: Record<string, PropValue>): Geometry;
  /**
   * Returns an SVG fragment (string) drawn in LOCAL coordinates.
   * Use the shared CSS classes so themes and exports stay consistent:
   *   .ds-body   – filled body outline (stroke = ink, fill = body color)
   *   .ds-line   – plain stroked line, no fill
   *   .ds-pin    – pin stub line
   *   .ds-bubble – inversion bubble (circle, fill = background)
   *   .ds-text   – pin / body text (font-size ~9-11)
   *   .ds-title  – larger body title text
   * Do NOT include transforms for placement — the renderer handles that.
   * Escape any user text with escapeXml().
   */
  symbol(props: Record<string, PropValue>): string;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function propNum(props: Record<string, PropValue>, key: string, fallback: number): number {
  const v = props[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function propStr(props: Record<string, PropValue>, key: string, fallback: string): string {
  const v = props[key];
  return v === undefined || v === null ? fallback : String(v);
}

export function propBool(props: Record<string, PropValue>, key: string, fallback: boolean): boolean {
  const v = props[key];
  return typeof v === "boolean" ? v : v === undefined ? fallback : v === "true" || v === 1;
}

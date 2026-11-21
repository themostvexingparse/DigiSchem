/** CORE CONTRACT — component registry. */
import type { ComponentDef } from "./component-def";

const defs = new Map<string, ComponentDef>();

export function registerComponent(def: ComponentDef): void {
  if (defs.has(def.type)) throw new Error(`Component type already registered: ${def.type}`);
  defs.set(def.type, def);
}

export function getDef(type: string): ComponentDef | undefined {
  return defs.get(type);
}

export function listDefs(): ComponentDef[] {
  return [...defs.values()];
}

/** Palette category ordering. Unknown categories go last, alphabetically. */
export const CATEGORY_ORDER = [
  "I/O",
  "Displays",
  "Gates",
  "Plexers",
  "Arithmetic",
  "Latches",
  "Flip-Flops",
  "Registers",
  "Memory",
  "Transistors",
  "Misc",
];

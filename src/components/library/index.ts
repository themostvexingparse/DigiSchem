/** Registers every built-in component. Add new family files to ALL_DEFS. */
import { registerComponent } from "../../model/registry";
import type { ComponentDef } from "../../model/component-def";
import { gateDefs } from "./gates";

export const ALL_DEFS: ComponentDef[] = [...gateDefs];

let registered = false;
export function registerBuiltinComponents(): void {
  if (registered) return;
  registered = true;
  for (const d of ALL_DEFS) registerComponent(d);
}

/** Registers every built-in component. Add new family files to ALL_DEFS. */
import { registerComponent } from "../../model/registry";
import type { ComponentDef } from "../../model/component-def";
import { ioDefs } from "./io";
import { gateDefs } from "./gates";
import { plexerDefs } from "./plexers";
import { arithmeticDefs } from "./arithmetic";
import { latchDefs } from "./latches";
import { flipflopDefs } from "./flipflops";
import { registerDefs } from "./registers";
import { memoryDefs } from "./memory";
import { miscDefs } from "./misc";

export const ALL_DEFS: ComponentDef[] = [
  ...ioDefs,
  ...gateDefs,
  ...plexerDefs,
  ...arithmeticDefs,
  ...latchDefs,
  ...flipflopDefs,
  ...registerDefs,
  ...memoryDefs,
  ...miscDefs,
];

let registered = false;
export function registerBuiltinComponents(): void {
  if (registered) return;
  registered = true;
  for (const d of ALL_DEFS) registerComponent(d);
}

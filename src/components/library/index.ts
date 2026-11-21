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
import { displayDefs } from "./displays";
import { arithExtraDefs, plexerExtraDefs } from "./arith-extra";
import { transistorDefs } from "./transistors";

export const ALL_DEFS: ComponentDef[] = [
  ...ioDefs,
  ...displayDefs,
  ...gateDefs,
  ...plexerDefs,
  ...plexerExtraDefs,
  ...arithmeticDefs,
  ...arithExtraDefs,
  ...latchDefs,
  ...flipflopDefs,
  ...registerDefs,
  ...memoryDefs,
  ...miscDefs,
  ...transistorDefs,
];

let registered = false;
export function registerBuiltinComponents(): void {
  if (registered) return;
  registered = true;
  for (const d of ALL_DEFS) registerComponent(d);
}

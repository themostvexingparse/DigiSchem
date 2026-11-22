/**
 * Keeps a stripped circuit (and its static check) in step with the document being edited,
 * rebuilding it only after an edit that changes what is connected to what: adding or deleting
 * a part, a connection being made or broken, a property that changes pins or behaviour. Moving
 * parts, dragging or re-routing wires, rotating and resizing leave the structural key alone
 * and do nothing; a rename refreshes the names without counting as a change.
 *
 * Not hooked into the editor yet: call watchCircuit(store, ...) to use it.
 */
import type { DocumentStore } from "../model/store";
import type { SchematicDocument } from "../model/types";
import { extractCircuit, structuralKey, type Circuit } from "./circuit";
import { checkCircuit, type CheckIssue } from "./check";

export interface LogicSnapshot {
  circuit: Circuit;
  /** static check of the circuit */
  issues: CheckIssue[];
}

export type LogicChange = "structure" | "names";

export interface CircuitWatch {
  /** the circuit of the current document */
  current(): LogicSnapshot;
  /** how many times the circuit has been rebuilt (for tests and diagnostics) */
  readonly builds: number;
  dispose(): void;
}

function namesKey(doc: SchematicDocument): string {
  return doc.components.map((c) => `${c.id}\u0001${c.label ?? ""}\u0001${c.props?.name ?? ""}`).join("\u0002") + `\u0003${doc.name}`;
}

/**
 * Watch a store. `onChange` runs after each structural change (with "structure") and after a
 * rename (with "names"); it does not run for the document the watch starts with.
 */
export function watchCircuit(store: DocumentStore, onChange?: (s: LogicSnapshot, why: LogicChange) => void): CircuitWatch {
  let key = structuralKey(store.doc);
  let names = namesKey(store.doc);
  let snap: LogicSnapshot | null = null;
  let builds = 0;
  const build = () => {
    builds++;
    const circuit = extractCircuit(store.doc);
    snap = { circuit, issues: checkCircuit(circuit) };
    return snap;
  };
  const unsubscribe = store.subscribe((kind) => {
    if (kind === "selection") return;
    const k = structuralKey(store.doc);
    const nk = namesKey(store.doc);
    if (k === key && nk === names) return;
    const why: LogicChange = k === key ? "names" : "structure";
    key = k;
    names = nk;
    if (!onChange) {
      snap = null; // rebuilt when asked for
      return;
    }
    onChange(build(), why);
  });
  return {
    current: () => snap ?? build(),
    get builds() {
      return builds;
    },
    dispose: unsubscribe,
  };
}

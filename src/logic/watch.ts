/**
 * Keeps a stripped circuit (and its static check) in step with the document being edited,
 * rebuilding it only after an edit that changes what is connected to what: adding or deleting
 * a part, a connection being made or broken, a property that changes pins or behaviour. Moving
 * parts, dragging or re-routing wires, rotating and resizing leave the structural key alone
 * and do nothing. A rename does not run it either: the names are refreshed the next time the
 * circuit is asked for.
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
 * Watch a store. With `onChange`, the circuit is rebuilt and passed to it after each structural
 * change (not for the document the watch starts with); without, it is rebuilt when `current()`
 * is next called.
 */
export function watchCircuit(store: DocumentStore, onChange?: (s: LogicSnapshot) => void): CircuitWatch {
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
  let namesStale = false;
  const unsubscribe = store.subscribe((kind) => {
    if (kind === "selection") return;
    const k = structuralKey(store.doc);
    if (k === key) {
      // a rename: refresh lazily, it changes nothing about the circuit
      const nk = namesKey(store.doc);
      if (nk !== names) namesStale = true;
      return;
    }
    key = k;
    names = namesKey(store.doc);
    namesStale = false;
    snap = null;
    if (onChange) onChange(build());
  });
  const current = () => {
    if (snap && namesStale) {
      const fresh = extractCircuit(store.doc);
      snap = { circuit: fresh, issues: checkCircuit(fresh) };
      names = namesKey(store.doc);
      namesStale = false;
      return snap;
    }
    return snap ?? build();
  };
  return {
    current,
    get builds() {
      return builds;
    },
    dispose: unsubscribe,
  };
}

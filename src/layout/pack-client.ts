/**
 * Runs the packer in a Web Worker (falls back to the UI thread if workers are unavailable).
 */
import type { SchematicDocument } from "../model/types";
import { packSchematic, validateCompaction, type PackResult } from "./pack";

export interface PackOutcome {
  res: PackResult;
  /** Rule violations of the result (empty = valid). */
  problems: string[];
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (o: PackOutcome) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./pack.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; res?: PackResult; problems?: string[]; error?: string };
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok && m.res) p.resolve({ res: m.res, problems: m.problems ?? [] });
      else p.reject(new Error(m.error ?? "packer failed"));
    };
    worker.onerror = (e) => {
      // A worker that cannot start: fail the pending calls and fall back to the UI thread.
      for (const p of pending.values()) p.reject(new Error(e.message || "packer worker failed"));
      pending.clear();
      worker?.terminate();
      worker = null;
      workerBroken = true;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}
let workerBroken = false;

function packHere(doc: SchematicDocument, ids?: ReadonlySet<string>): PackOutcome {
  const opts = ids ? { ids } : {};
  const res = packSchematic(doc, opts);
  return { res, problems: validateCompaction(doc, res, opts) };
}

/** Pack `doc` (optionally only `ids`) off the UI thread. */
export async function packInBackground(doc: SchematicDocument, ids?: ReadonlySet<string>): Promise<PackOutcome> {
  const w = workerBroken ? null : getWorker();
  if (!w) return packHere(doc, ids);
  const id = nextId++;
  const snapshot = JSON.parse(JSON.stringify(doc)) as SchematicDocument;
  try {
    return await new Promise<PackOutcome>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, doc: snapshot, ids: ids ? [...ids] : undefined });
    });
  } catch (e) {
    if (workerBroken) return packHere(doc, ids); // the worker never started
    throw e;
  }
}

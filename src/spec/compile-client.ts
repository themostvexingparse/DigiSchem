/** Runs the DSpec compiler in a Web Worker (or on the UI thread when workers are unavailable). */
import type { SchematicDocument } from "../model/types";
import { compileSpec, type CompileResult } from "./compile";

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (r: CompileResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker || broken) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./compile.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; result?: CompileResult; error?: string };
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok && m.result) p.resolve(m.result);
      else p.reject(new Error(m.error ?? "compiler failed"));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "compiler worker failed"));
      pending.clear();
      worker?.terminate();
      worker = null;
      broken = true;
    };
    return worker;
  } catch {
    broken = true;
    return null;
  }
}

export async function compileInBackground(source: string, previous: SchematicDocument | null): Promise<CompileResult> {
  const w = getWorker();
  if (!w) return compileSpec(source, { previous });
  const id = nextId++;
  const prev = previous ? (JSON.parse(JSON.stringify(previous)) as SchematicDocument) : null;
  try {
    return await new Promise<CompileResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, source, previous: prev });
    });
  } catch (e) {
    if (broken) return compileSpec(source, { previous });
    throw e;
  }
}

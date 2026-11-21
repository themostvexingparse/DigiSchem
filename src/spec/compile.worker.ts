/**
 * Web Worker running the DSpec compiler off the UI thread (compaction can take seconds, and
 * "@compact each" runs it after every part). In: { id, source, previous? }. Out: { id, result }.
 */
import type { SchematicDocument } from "../model/types";
import { compileSpec } from "./compile";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; source: string; previous?: SchematicDocument | null }>) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (e) => {
  const { id, source, previous } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: compileSpec(source, { previous }) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};

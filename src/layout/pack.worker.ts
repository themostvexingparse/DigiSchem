/**
 * Web Worker running the layout packer off the UI thread (beam search can take seconds on big
 * schematics). Message in: { id, doc, ids? }. Message out: { id, ok, res?, problems?, error? }.
 */
import { registerBuiltinComponents } from "../components/library";
import type { SchematicDocument } from "../model/types";
import { packSchematic } from "./pack";
import { validatePacking } from "./validate";

registerBuiltinComponents();

interface PackRequest {
  id: number;
  doc: SchematicDocument;
  ids?: string[];
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PackRequest>) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (e) => {
  const { id, doc, ids } = e.data;
  try {
    const opts = ids ? { ids: new Set(ids) } : {};
    const res = packSchematic(doc, opts);
    const problems = validatePacking(doc, res.doc, opts);
    ctx.postMessage({ id, ok: true, res, problems });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};

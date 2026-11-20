/** CONTRACT (owned by io module): image export. STUB. */
import type { SchematicDocument } from "../model/types";
import { renderDocumentSvg, type SvgExportOptions } from "../render/svg";

export interface PngExportOptions extends SvgExportOptions {
  /** Pixels per world unit (1 = 100%). */
  scale?: number;
}

export function exportSvgString(doc: SchematicDocument, opts: SvgExportOptions = {}): string {
  return renderDocumentSvg(doc, opts);
}

export async function exportPngBlob(_doc: SchematicDocument, _opts: PngExportOptions = {}): Promise<Blob> {
  throw new Error("PNG export not implemented yet");
}

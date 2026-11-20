/**
 * SVG, PNG, JPEG, selection, and clipboard image export.
 */
import type { SchematicDocument } from "../model/types";
import { escapeXml } from "../model/component-def";
import { documentBounds, type Rect } from "../model/geometry";
import { renderDocumentSvg, type SvgExportOptions } from "../render/svg";

/** Maximum pixels along either axis when rasterizing to PNG/JPEG. */
export const MAX_RASTER_SIDE = 16384;
/** Maximum total pixel count (~268M px, safely below the 2^28 canvas cap). */
export const MAX_RASTER_PIXELS = 268_000_000;

export interface TitleBlockOptions {
  /** Override document title (defaults to `doc.name`). */
  title?: string;
  /** Override author (defaults to `doc.meta?.author`). */
  author?: string;
  /** Override course (defaults to `doc.meta?.course`). */
  course?: string;
  /** Override lab identifier (defaults to `doc.meta?.lab`). */
  lab?: string;
  /** Override date string (defaults to `doc.meta?.date` or today's YYYY-MM-DD). */
  date?: string;
}

export interface ExportSvgOptions extends SvgExportOptions {
  /** Render a schematic title block footer (pass `true` for doc defaults or custom fields). */
  titleBlock?: boolean | TitleBlockOptions;
}

export interface PngExportOptions extends ExportSvgOptions {
  /** Pixels per world unit (1 = 100%). Defaults to 2. */
  scale?: number;
}

export interface JpegExportOptions extends PngExportOptions {
  /** JPEG encoder quality in [0, 1]. Defaults to 0.92. */
  quality?: number;
}

const TITLE_BLOCK_HEIGHT = 44;
const TITLE_BLOCK_GAP = 10;
const TITLE_BLOCK_MIN_WIDTH = 320;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function metaField(meta: Record<string, string> | undefined, key: string): string | undefined {
  if (!meta) return undefined;
  if (meta[key] !== undefined && meta[key].trim() !== "") return meta[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(meta)) {
    if (k.toLowerCase() === lower && v.trim() !== "") return v;
  }
  return undefined;
}

function renderTitleBlockFragment(
  doc: SchematicDocument,
  tbOpt: boolean | TitleBlockOptions,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const custom: TitleBlockOptions = typeof tbOpt === "object" && tbOpt !== null ? tbOpt : {};
  const title = custom.title ?? doc.name;
  const author = custom.author ?? metaField(doc.meta, "author");
  const course = custom.course ?? metaField(doc.meta, "course");
  const lab = custom.lab ?? metaField(doc.meta, "lab");
  const date = custom.date ?? metaField(doc.meta, "date") ?? todayIsoDate();

  const row1Y = y + 15;
  const dividerY = y + Math.round(height / 2);
  const row2Y = y + height - 7;
  const leftX = x + 8;
  const rightX = x + width - 8;

  const leftBottom = author ? `Author: ${author}` : "";
  const courseLabParts: string[] = [];
  if (course) courseLabParts.push(`Course: ${course}`);
  if (lab) courseLabParts.push(`Lab: ${lab}`);
  const rightBottom = courseLabParts.join(" | ");

  const parts: string[] = [
    `<g class="ds-title-block">`,
    `<rect class="ds-body" x="${x}" y="${y}" width="${width}" height="${height}"/>`,
    `<line class="ds-thin" x1="${x}" y1="${dividerY}" x2="${x + width}" y2="${dividerY}"/>`,
    `<text class="ds-title" x="${leftX}" y="${row1Y}">${escapeXml(title)}</text>`,
    `<text class="ds-text" x="${rightX}" y="${row1Y}" text-anchor="end">${escapeXml(date)}</text>`,
  ];

  if (leftBottom) {
    parts.push(`<text class="ds-text" x="${leftX}" y="${row2Y}">${escapeXml(leftBottom)}</text>`);
  }
  if (rightBottom) {
    if (leftBottom) {
      parts.push(
        `<text class="ds-text" x="${rightX}" y="${row2Y}" text-anchor="end">${escapeXml(rightBottom)}</text>`,
      );
    } else {
      parts.push(`<text class="ds-text" x="${leftX}" y="${row2Y}">${escapeXml(rightBottom)}</text>`);
    }
  }

  parts.push(`</g>`);
  return parts.join("");
}

/**
 * Render the schematic document as a standalone SVG string, optionally with a title block footer.
 */
export function exportSvgString(doc: SchematicDocument, opts: ExportSvgOptions = {}): string {
  if (!opts.titleBlock) {
    return renderDocumentSvg(doc, opts);
  }

  const baseBounds: Rect = opts.region ?? documentBounds(doc) ?? { x: 0, y: 0, w: 200, h: 100 };
  // The title block needs its minimum width regardless of padding (large padding must not collapse it).
  const minContentW = Math.max(baseBounds.w, TITLE_BLOCK_MIN_WIDTH);
  const expandedRegion: Rect = {
    x: baseBounds.x,
    y: baseBounds.y,
    w: minContentW,
    h: baseBounds.h + TITLE_BLOCK_GAP + TITLE_BLOCK_HEIGHT,
  };

  const baseSvg = renderDocumentSvg(doc, { ...opts, region: expandedRegion });
  const tbY = baseBounds.y + baseBounds.h + TITLE_BLOCK_GAP;
  const titleBlockSvg = renderTitleBlockFragment(
    doc,
    opts.titleBlock,
    baseBounds.x,
    tbY,
    minContentW,
    TITLE_BLOCK_HEIGHT,
  );

  const closeIdx = baseSvg.lastIndexOf("</svg>");
  if (closeIdx === -1) return baseSvg + titleBlockSvg;
  return baseSvg.slice(0, closeIdx) + titleBlockSvg + baseSvg.slice(closeIdx);
}

/**
 * Build a sub-document containing only the selected components, wires, and text notes,
 * and render it as a standalone SVG string.
 */
export function exportSelectionSvg(
  doc: SchematicDocument,
  ids: Iterable<string>,
  opts: ExportSvgOptions = {},
): string {
  const selected = new Set(ids);
  const subDoc: SchematicDocument = {
    ...doc,
    components: doc.components.filter((c) => selected.has(c.id)),
    wires: doc.wires.filter((w) => selected.has(w.id)),
    texts: doc.texts.filter((t) => selected.has(t.id)),
  };
  return exportSvgString(subDoc, opts);
}

/**
 * Extract numeric width and height from an SVG document string.
 */
export function parseSvgDimensions(svg: string): { width: number; height: number } {
  const openTagMatch = svg.match(/<svg\b[^>]*>/);
  const openTag = openTagMatch ? openTagMatch[0] : "";

  const widthMatch = openTag.match(/\bwidth="([^"]+)"/);
  const heightMatch = openTag.match(/\bheight="([^"]+)"/);
  const w = widthMatch ? Number.parseFloat(widthMatch[1]) : NaN;
  const h = heightMatch ? Number.parseFloat(heightMatch[1]) : NaN;
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    return { width: w, height: h };
  }

  const vbMatch = openTag.match(/\bviewBox="([^"]+)"/);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0 && Number.isFinite(parts[3]) && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  return { width: 200, height: 100 };
}

/**
 * Compute capped integer raster dimensions and effective scale for a given SVG size.
 * Respects both `MAX_RASTER_SIDE` (16384 px) and `MAX_RASTER_PIXELS` (~268M px total).
 */
export function computeRasterDimensions(
  svgWidth: number,
  svgHeight: number,
  requestedScale = 2,
): { width: number; height: number; scale: number } {
  const w0 = Number.isFinite(svgWidth) && svgWidth > 0 ? svgWidth : 1;
  const h0 = Number.isFinite(svgHeight) && svgHeight > 0 ? svgHeight : 1;
  let scale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 2;

  if (w0 * scale > MAX_RASTER_SIDE) {
    scale = MAX_RASTER_SIDE / w0;
  }
  if (h0 * scale > MAX_RASTER_SIDE) {
    scale = Math.min(scale, MAX_RASTER_SIDE / h0);
  }
  if (w0 * scale * (h0 * scale) > MAX_RASTER_PIXELS) {
    scale = Math.min(scale, Math.sqrt(MAX_RASTER_PIXELS / (w0 * h0)));
  }

  const rawW = w0 * scale;
  const rawH = h0 * scale;
  let width = Math.max(1, Math.round(rawW));
  let height = Math.max(1, Math.round(rawH));

  if (width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE || width * height > MAX_RASTER_PIXELS) {
    width = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.floor(rawW)));
    height = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.floor(rawH)));
  }

  return { width, height, scale };
}

async function rasterizeSvg(
  svg: string,
  mimeType: "image/png" | "image/jpeg",
  requestedScale: number,
  fillBackground?: string,
  quality?: number,
): Promise<Blob> {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    throw new Error("Raster image export requires a browser DOM environment");
  }

  const { width: svgW, height: svgH } = parseSvgDimensions(svg);
  const { width, height } = computeRasterDimensions(svgW, svgH, requestedScale);

  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to decode SVG image for raster export"));
      el.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to acquire 2D canvas context");
    }

    if (fillBackground) {
      ctx.fillStyle = fillBackground;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mimeType, quality);
    });
    if (!blob) {
      throw new Error(`Canvas failed to encode ${mimeType} blob`);
    }
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Render the schematic to a PNG Blob at `opts.scale` pixels per world unit.
 * Honors transparent background when `opts.background === false`.
 */
export async function exportPngBlob(
  doc: SchematicDocument,
  opts: PngExportOptions = {},
): Promise<Blob> {
  const svg = exportSvgString(doc, opts);
  return rasterizeSvg(svg, "image/png", opts.scale ?? 2);
}

/**
 * Render the schematic to a JPEG Blob with a white background forced.
 */
export async function exportJpegBlob(
  doc: SchematicDocument,
  opts: JpegExportOptions = {},
): Promise<Blob> {
  const qualityRaw = opts.quality ?? 0.92;
  const quality = Number.isFinite(qualityRaw) ? Math.max(0, Math.min(1, qualityRaw)) : 0.92;
  // Render without an SVG background rect so the forced white canvas fill is always used.
  const svg = exportSvgString(doc, { ...opts, background: false });
  // JPEG has no alpha: fill with the theme background (dark themes stay readable).
  return rasterizeSvg(svg, "image/jpeg", opts.scale ?? 2, opts.theme?.background ?? "#ffffff", quality);
}

/**
 * Render the schematic as PNG and write it to the system clipboard via the Async Clipboard API.
 */
export async function copyPngToClipboard(
  doc: SchematicDocument,
  opts: PngExportOptions = {},
): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error("Clipboard image writing is not available in this environment");
  }
  const blob = await exportPngBlob(doc, opts);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

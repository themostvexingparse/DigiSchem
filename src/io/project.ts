/**
 * Project file (.dschem) serialization, validation, sanitization, and version migrations.
 */
import type {
  ComponentInstance,
  Point,
  PropValue,
  Rotation,
  SchematicDocument,
  TextNote,
  Wire,
} from "../model/types";
import { newId } from "../model/types";
import { GRID } from "../model/component-def";
import { snap } from "../model/geometry";

export const PROJECT_EXTENSION = "dschem";
export const PROJECT_FORMAT = "digischem" as const;
export const CURRENT_VERSION = 1 as const;

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
    Object.setPrototypeOf(this, ProjectError.prototype);
  }
}

export interface ParseProjectResult {
  doc: SchematicDocument;
  warnings: string[];
}

/**
 * A single forward migration step taking a raw parsed project object at version `v`
 * and returning an upgraded raw object at version `v + 1`.
 */
export type ProjectMigration = (
  raw: Record<string, unknown>,
  warnings: string[],
) => Record<string, unknown>;

/**
 * Forward migrations keyed by source format version (`MIGRATIONS[v]` upgrades v -> v+1).
 * Only version 1 currently exists; future schema revisions register their upgrade step here.
 */
export const MIGRATIONS: Record<number, ProjectMigration> = {};

/**
 * Apply sequential migrations from `fromVersion` up to `targetVersion`.
 * Exported so tests and callers can exercise migration pipelines explicitly.
 */
export function runMigrations(
  raw: Record<string, unknown>,
  fromVersion: number,
  targetVersion: number,
  migrations: Readonly<Record<number, ProjectMigration>>,
  warnings: string[],
): Record<string, unknown> {
  let current: Record<string, unknown> = { ...raw };
  let v = fromVersion;
  while (v < targetVersion) {
    const migrate = migrations[v];
    if (typeof migrate !== "function") {
      throw new ProjectError(
        `No migration available from project version ${v} to ${v + 1}`,
      );
    }
    current = migrate(current, warnings);
    v += 1;
    current.version = v;
  }
  return current;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeZero(n: number): number {
  return n === 0 ? 0 : n;
}

function coerceFiniteNumber(v: unknown): { value: number; coerced: boolean } | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? { value: normalizeZero(v), coerced: false } : null;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? { value: normalizeZero(n), coerced: true } : null;
  }
  return null;
}

function normalizeRotation(v: unknown, context: string, warnings: string[]): Rotation {
  if (v === undefined) {
    warnings.push(`${context}: missing rotation, defaulting to 0`);
    return 0;
  }
  const num = coerceFiniteNumber(v);
  if (!num) {
    warnings.push(`${context}: invalid rotation ${JSON.stringify(v)}, defaulting to 0`);
    return 0;
  }
  const rounded = Math.round(num.value / 90) * 90;
  const mod = normalizeZero(((rounded % 360) + 360) % 360) as Rotation;
  if (num.coerced || mod !== num.value) {
    warnings.push(`${context}: normalized rotation ${JSON.stringify(v)} to ${mod}`);
  }
  return mod;
}

function sortRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(rec).sort()) {
    out[key] = rec[key];
  }
  return out;
}

function canonicalPoint(p: Point): Point {
  return { x: normalizeZero(p.x), y: normalizeZero(p.y) };
}

function canonicalComponent(c: ComponentInstance): ComponentInstance {
  const out: ComponentInstance = {
    id: c.id,
    type: c.type,
    x: normalizeZero(c.x),
    y: normalizeZero(c.y),
    rotation: c.rotation,
    props: sortRecord(c.props),
  };
  if (c.mirror !== undefined) out.mirror = c.mirror;
  if (c.label !== undefined) out.label = c.label;
  // Re-order optional keys deterministically: id, type, x, y, rotation, mirror?, props, label?
  const ordered: ComponentInstance = {
    id: out.id,
    type: out.type,
    x: out.x,
    y: out.y,
    rotation: out.rotation,
    ...(out.mirror !== undefined ? { mirror: out.mirror } : {}),
    props: out.props,
    ...(out.label !== undefined ? { label: out.label } : {}),
    ...(c.size ? { size: { w: normalizeZero(c.size.w), h: normalizeZero(c.size.h) } } : {}),
  };
  return ordered;
}

function canonicalWire(w: Wire): Wire {
  return {
    id: w.id,
    points: w.points.map(canonicalPoint),
    ...(w.width !== undefined ? { width: w.width } : {}),
  };
}

function canonicalText(t: TextNote): TextNote {
  return {
    id: t.id,
    x: normalizeZero(t.x),
    y: normalizeZero(t.y),
    text: t.text,
    ...(t.fontSize !== undefined ? { fontSize: t.fontSize } : {}),
  };
}

function canonicalDocument(doc: SchematicDocument): SchematicDocument {
  const out: SchematicDocument = {
    format: PROJECT_FORMAT,
    version: CURRENT_VERSION,
    name: doc.name,
    grid: doc.grid,
    components: doc.components.map(canonicalComponent),
    wires: doc.wires.map(canonicalWire),
    texts: doc.texts.map(canonicalText),
    ...(doc.meta !== undefined ? { meta: sortRecord(doc.meta) } : {}),
    ...(doc.links !== undefined ? { links: canonicalLinks(doc.links) } : {}),
  };
  return out;
}

function canonicalLinks(links: readonly [string, string][]): [string, string][] {
  const set = new Map<string, [string, string]>();
  for (const [a, b] of links) {
    if (a === b) continue;
    const pair: [string, string] = a < b ? [a, b] : [b, a];
    set.set(`${pair[0]}\u0000${pair[1]}`, pair);
  }
  return [...set.values()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
}

/** Keep well-formed links whose wires / components exist (unknown pins are ignored by the netlist). */
function sanitizeLinks(raw: unknown, doc: SchematicDocument, warnings: string[]): [string, string][] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push("Invalid links field (expected array), connectivity will be read from the drawing");
    return undefined;
  }
  const wires = new Set(doc.wires.map((w) => w.id));
  const comps = new Set(doc.components.map((c) => c.id));
  const ok = (t: unknown): t is string =>
    typeof t === "string" &&
    ((t.startsWith("w:") && wires.has(t.slice(2))) || (t.startsWith("p:") && comps.has(t.slice(2, t.indexOf("|") < 0 ? undefined : t.indexOf("|")))));
  const out: [string, string][] = [];
  let dropped = 0;
  for (const e of raw) {
    if (Array.isArray(e) && e.length === 2 && ok(e[0]) && ok(e[1])) out.push([e[0], e[1]]);
    else dropped++;
  }
  if (dropped > 0) warnings.push(`links: dropped ${dropped} invalid connection(s)`);
  return canonicalLinks(out);
}

/**
 * Serialize a schematic document into pretty-printed JSON with stable key order.
 */
export function serializeProject(doc: SchematicDocument): string {
  return JSON.stringify(canonicalDocument(doc), null, 2) + "\n";
}

function claimUniqueId(
  rawId: unknown,
  prefix: string,
  context: string,
  usedIds: Set<string>,
  warnings: string[],
): string {
  let id: string;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    id = rawId;
  } else {
    id = generateUniqueId(prefix, usedIds);
    warnings.push(`${context}: missing or invalid id, generated "${id}"`);
    usedIds.add(id);
    return id;
  }
  if (usedIds.has(id)) {
    const replacement = generateUniqueId(prefix, usedIds);
    warnings.push(`${context}: duplicate id "${id}", regenerated as "${replacement}"`);
    usedIds.add(replacement);
    return replacement;
  }
  usedIds.add(id);
  return id;
}

function generateUniqueId(prefix: string, usedIds: Set<string>): string {
  let candidate = newId(prefix);
  while (usedIds.has(candidate)) {
    candidate = newId(prefix);
  }
  return candidate;
}

/** Largest coordinate magnitude accepted from a file. */
export const MAX_COORD = 1_000_000;
/** Largest body size (resized parts) accepted from a file. */
export const MAX_PART_SIZE = 10_000;

function snapCoord(
  rawVal: number,
  grid: number,
  axis: "x" | "y",
  context: string,
  warnings: string[],
): number {
  // The canvas is large but finite: absurd coordinates (a corrupted / hand-edited file) would
  // make every geometric search over the drawing explode.
  if (Math.abs(rawVal) > MAX_COORD) {
    const clamped = Math.sign(rawVal) * MAX_COORD;
    warnings.push(`${context}: clamped ${axis} from ${rawVal} to ${clamped}`);
    rawVal = clamped;
  }
  const snapped = normalizeZero(snap(rawVal, grid));
  if (snapped !== rawVal) {
    warnings.push(`${context}: snapped ${axis} from ${rawVal} to ${snapped} (grid ${grid})`);
  }
  return snapped;
}

function sanitizeProps(
  rawProps: unknown,
  context: string,
  warnings: string[],
): Record<string, PropValue> {
  if (rawProps === undefined) {
    warnings.push(`${context}: missing props, defaulting to {}`);
    return {};
  }
  if (!isPlainObject(rawProps)) {
    warnings.push(`${context}: invalid props (expected object), defaulting to {}`);
    return {};
  }
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(rawProps).sort()) {
    const val = rawProps[key];
    if (typeof val === "string" || typeof val === "boolean") {
      out[key] = val;
    } else if (typeof val === "number") {
      if (Number.isFinite(val)) {
        out[key] = normalizeZero(val);
      } else {
        warnings.push(`${context}: dropped non-finite numeric prop "${key}"`);
      }
    } else {
      warnings.push(`${context}: dropped unsupported prop "${key}"`);
    }
  }
  return out;
}

function sanitizeComponents(
  rawList: unknown,
  grid: number,
  usedIds: Set<string>,
  warnings: string[],
): ComponentInstance[] {
  if (rawList === undefined) {
    warnings.push("Missing components array, defaulting to []");
    return [];
  }
  if (!Array.isArray(rawList)) {
    warnings.push("Invalid components field (expected array), defaulting to []");
    return [];
  }
  const components: ComponentInstance[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    const ctx = `component[${i}]`;
    if (!isPlainObject(item)) {
      warnings.push(`${ctx}: dropped malformed component (expected object)`);
      continue;
    }
    if (typeof item.type !== "string" || item.type.trim().length === 0) {
      warnings.push(`${ctx}: dropped component with missing or invalid type`);
      continue;
    }
    const type = item.type.trim();
    if (type !== item.type) {
      warnings.push(`${ctx}: trimmed component type "${item.type}" to "${type}"`);
    }

    const xNum = coerceFiniteNumber(item.x);
    const yNum = coerceFiniteNumber(item.y);
    if (!xNum || !yNum) {
      warnings.push(`${ctx} (${type}): dropped component with invalid coordinates`);
      continue;
    }
    if (xNum.coerced) warnings.push(`${ctx} (${type}): coerced x from ${JSON.stringify(item.x)} to ${xNum.value}`);
    if (yNum.coerced) warnings.push(`${ctx} (${type}): coerced y from ${JSON.stringify(item.y)} to ${yNum.value}`);

    const x = snapCoord(xNum.value, grid, "x", `${ctx} (${type})`, warnings);
    const y = snapCoord(yNum.value, grid, "y", `${ctx} (${type})`, warnings);
    const rotation = normalizeRotation(item.rotation, `${ctx} (${type})`, warnings);
    const props = sanitizeProps(item.props, `${ctx} (${type})`, warnings);

    let mirror: boolean | undefined;
    if (item.mirror !== undefined) {
      if (typeof item.mirror === "boolean") {
        mirror = item.mirror;
      } else if (item.mirror === "true" || item.mirror === 1) {
        mirror = true;
        warnings.push(`${ctx} (${type}): coerced mirror to true`);
      } else if (item.mirror === "false" || item.mirror === 0) {
        mirror = false;
        warnings.push(`${ctx} (${type}): coerced mirror to false`);
      } else {
        warnings.push(`${ctx} (${type}): ignored invalid mirror value`);
      }
    }

    let label: string | undefined;
    if (item.label !== undefined) {
      if (typeof item.label === "string") {
        label = item.label;
      } else if (typeof item.label === "number" || typeof item.label === "boolean") {
        label = String(item.label);
        warnings.push(`${ctx} (${type}): coerced label to "${label}"`);
      } else {
        warnings.push(`${ctx} (${type}): ignored invalid label value`);
      }
    }

    let size: { w: number; h: number } | undefined;
    if (item.size !== undefined) {
      const sz = item.size as { w?: unknown; h?: unknown } | null;
      const w = coerceFiniteNumber(sz?.w);
      const h = coerceFiniteNumber(sz?.h);
      if (w && h && w.value > 0 && h.value > 0) {
        const fit = (v: number) => Math.min(MAX_PART_SIZE, Math.max(grid, Math.round(v / grid) * grid));
        size = { w: fit(w.value), h: fit(h.value) };
        if (size.w !== Math.round(w.value / grid) * grid || size.h !== Math.round(h.value / grid) * grid) {
          if (w.value > MAX_PART_SIZE || h.value > MAX_PART_SIZE) warnings.push(`${ctx} (${type}): clamped size to ${MAX_PART_SIZE}`);
        }
      } else {
        warnings.push(`${ctx} (${type}): ignored invalid size`);
      }
    }

    const id = claimUniqueId(item.id, "c", `${ctx} (${type})`, usedIds, warnings);
    const comp: ComponentInstance = {
      id,
      type,
      x,
      y,
      rotation,
      ...(mirror !== undefined ? { mirror } : {}),
      props,
      ...(label !== undefined ? { label } : {}),
      ...(size ? { size } : {}),
    };
    components.push(comp);
  }
  return components;
}

function sanitizeWires(
  rawList: unknown,
  grid: number,
  usedIds: Set<string>,
  warnings: string[],
  linkedIds: ReadonlySet<string> = new Set(),
): Wire[] {
  if (rawList === undefined) {
    warnings.push("Missing wires array, defaulting to []");
    return [];
  }
  if (!Array.isArray(rawList)) {
    warnings.push("Invalid wires field (expected array), defaulting to []");
    return [];
  }
  const wires: Wire[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    const ctx = `wire[${i}]`;
    if (!isPlainObject(item)) {
      warnings.push(`${ctx}: dropped malformed wire (expected object)`);
      continue;
    }
    if (!Array.isArray(item.points) || item.points.length < 2) {
      warnings.push(`${ctx}: dropped wire with fewer than 2 points`);
      continue;
    }

    const points: Point[] = [];
    let malformedPoint = false;
    for (let j = 0; j < item.points.length; j++) {
      const pt = item.points[j];
      if (!isPlainObject(pt)) {
        malformedPoint = true;
        break;
      }
      const xNum = coerceFiniteNumber(pt.x);
      const yNum = coerceFiniteNumber(pt.y);
      if (!xNum || !yNum) {
        malformedPoint = true;
        break;
      }
      if (xNum.coerced) warnings.push(`${ctx}.points[${j}]: coerced x from ${JSON.stringify(pt.x)} to ${xNum.value}`);
      if (yNum.coerced) warnings.push(`${ctx}.points[${j}]: coerced y from ${JSON.stringify(pt.y)} to ${yNum.value}`);

      const x = snapCoord(xNum.value, grid, "x", `${ctx}.points[${j}]`, warnings);
      const y = snapCoord(yNum.value, grid, "y", `${ctx}.points[${j}]`, warnings);
      points.push({ x, y });
    }
    if (malformedPoint) {
      warnings.push(`${ctx}: dropped wire containing malformed point`);
      continue;
    }

    let width: number | undefined;
    if (item.width !== undefined) {
      const wNum = coerceFiniteNumber(item.width);
      if (!wNum || wNum.value < 1) {
        warnings.push(`${ctx}: ignored invalid bus width ${JSON.stringify(item.width)}`);
      } else {
        const rounded = Math.round(wNum.value);
        if (wNum.coerced || rounded !== wNum.value) {
          warnings.push(`${ctx}: normalized bus width ${JSON.stringify(item.width)} to ${rounded}`);
        }
        width = rounded;
      }
    }

    // Drop zero-length segments / duplicate points; a wire that collapses is meaningless —
    // unless it carries stored connections (a pin moved onto its other end): those are kept as a
    // zero-length wire, exactly as the editor keeps them, so it can stretch back out.
    const cleaned: Point[] = [];
    for (const p of points) {
      const last = cleaned[cleaned.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) cleaned.push(p);
    }
    if (cleaned.length < 2) {
      if (typeof item.id === "string" && linkedIds.has(item.id)) {
        cleaned.push({ ...cleaned[0] });
      } else {
        warnings.push(`${ctx}: dropped zero-length wire`);
        continue;
      }
    }
    if (cleaned.some((p, j) => j > 0 && p.x !== cleaned[j - 1].x && p.y !== cleaned[j - 1].y)) {
      warnings.push(`${ctx}: wire has a diagonal segment (kept as drawn)`);
    }

    const id = claimUniqueId(item.id, "w", ctx, usedIds, warnings);
    wires.push({
      id,
      points: cleaned,
      ...(width !== undefined ? { width } : {}),
    });
  }
  return wires;
}

function sanitizeTexts(
  rawList: unknown,
  grid: number,
  usedIds: Set<string>,
  warnings: string[],
): TextNote[] {
  if (rawList === undefined) {
    warnings.push("Missing texts array, defaulting to []");
    return [];
  }
  if (!Array.isArray(rawList)) {
    warnings.push("Invalid texts field (expected array), defaulting to []");
    return [];
  }
  const texts: TextNote[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    const ctx = `text[${i}]`;
    if (!isPlainObject(item)) {
      warnings.push(`${ctx}: dropped malformed text note (expected object)`);
      continue;
    }

    const xNum = coerceFiniteNumber(item.x);
    const yNum = coerceFiniteNumber(item.y);
    if (!xNum || !yNum) {
      warnings.push(`${ctx}: dropped text note with invalid coordinates`);
      continue;
    }
    if (xNum.coerced) warnings.push(`${ctx}: coerced x from ${JSON.stringify(item.x)} to ${xNum.value}`);
    if (yNum.coerced) warnings.push(`${ctx}: coerced y from ${JSON.stringify(item.y)} to ${yNum.value}`);

    let text: string;
    if (typeof item.text === "string") {
      text = item.text;
    } else if (typeof item.text === "number" || typeof item.text === "boolean") {
      text = String(item.text);
      warnings.push(`${ctx}: coerced text value to "${text}"`);
    } else {
      warnings.push(`${ctx}: dropped text note with missing or invalid text`);
      continue;
    }

    const x = snapCoord(xNum.value, grid, "x", ctx, warnings);
    const y = snapCoord(yNum.value, grid, "y", ctx, warnings);

    let fontSize: number | undefined;
    if (item.fontSize !== undefined) {
      const fsNum = coerceFiniteNumber(item.fontSize);
      if (!fsNum || fsNum.value <= 0) {
        warnings.push(`${ctx}: ignored invalid fontSize ${JSON.stringify(item.fontSize)}`);
      } else {
        if (fsNum.coerced) {
          warnings.push(`${ctx}: coerced fontSize from ${JSON.stringify(item.fontSize)} to ${fsNum.value}`);
        }
        fontSize = fsNum.value;
      }
    }

    const id = claimUniqueId(item.id, "t", ctx, usedIds, warnings);
    texts.push({
      id,
      x,
      y,
      text,
      ...(fontSize !== undefined ? { fontSize } : {}),
    });
  }
  return texts;
}

function sanitizeMeta(
  rawMeta: unknown,
  warnings: string[],
): Record<string, string> | undefined {
  if (rawMeta === undefined) return undefined;
  if (!isPlainObject(rawMeta)) {
    warnings.push("Invalid meta field (expected object), ignoring metadata");
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const key of Object.keys(rawMeta).sort()) {
    const val = rawMeta[key];
    if (typeof val === "string") {
      out[key] = val;
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = String(val);
      warnings.push(`meta.${key}: coerced value to string`);
    } else {
      warnings.push(`meta.${key}: dropped non-primitive metadata value`);
    }
  }
  return out;
}

/**
 * Parse, migrate, validate, and sanitize a DigiSchem project JSON string,
 * returning both the sanitized document and any non-fatal warnings.
 * Throws ProjectError for invalid JSON, wrong format, or unsupported versions.
 */
export function parseProjectWithWarnings(text: string): ParseProjectResult {
  if (typeof text !== "string") {
    throw new ProjectError("Invalid project input: expected a JSON string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProjectError(`Invalid JSON in project file: ${detail}`);
  }

  if (!isPlainObject(parsed)) {
    throw new ProjectError("Invalid project file: root value must be a JSON object");
  }

  if (parsed.format !== PROJECT_FORMAT) {
    throw new ProjectError(
      `Not a DigiSchem project file (expected format "${PROJECT_FORMAT}", got ${JSON.stringify(parsed.format)})`,
    );
  }

  const rawVersion = parsed.version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
    throw new ProjectError(
      `Invalid project version: ${JSON.stringify(rawVersion)} (expected a positive integer)`,
    );
  }

  if (rawVersion > CURRENT_VERSION) {
    throw new ProjectError(
      `Unsupported project version ${rawVersion} (this version of DigiSchem supports up to version ${CURRENT_VERSION})`,
    );
  }

  const warnings: string[] = [];
  const migrated = runMigrations(parsed, rawVersion, CURRENT_VERSION, MIGRATIONS, warnings);

  let name = "Untitled";
  if (typeof migrated.name === "string" && migrated.name.trim().length > 0) {
    name = migrated.name;
  } else if (typeof migrated.name === "number" || typeof migrated.name === "boolean") {
    name = String(migrated.name);
    warnings.push(`Coerced document name to "${name}"`);
  } else {
    warnings.push('Missing or invalid document name, defaulting to "Untitled"');
  }

  let grid = GRID;
  if (migrated.grid === undefined) {
    warnings.push(`Missing grid size, defaulting to ${GRID}`);
  } else {
    const gNum = coerceFiniteNumber(migrated.grid);
    if (!gNum || gNum.value <= 0) {
      warnings.push(`Invalid grid size ${JSON.stringify(migrated.grid)}, defaulting to ${GRID}`);
    } else {
      if (gNum.coerced) {
        warnings.push(`Coerced grid size from ${JSON.stringify(migrated.grid)} to ${gNum.value}`);
      }
      grid = gNum.value;
    }
  }
  // Every component pin sits on the 10-unit grid; snapping a file to any other grid would
  // pull wire ends off their pins and silently disconnect the circuit.
  if (grid !== GRID) {
    warnings.push(`Unsupported grid size ${grid}; using ${GRID} (component pins are on a ${GRID}-unit grid)`);
    grid = GRID;
  }

  const usedIds = new Set<string>();
  const components = sanitizeComponents(migrated.components, grid, usedIds, warnings);
  const linkedWires = new Set<string>();
  if (Array.isArray(migrated.links)) {
    for (const e of migrated.links) {
      if (!Array.isArray(e)) continue;
      for (const t of e) if (typeof t === "string" && t.startsWith("w:")) linkedWires.add(t.slice(2));
    }
  }
  const wires = sanitizeWires(migrated.wires, grid, usedIds, warnings, linkedWires);
  const texts = sanitizeTexts(migrated.texts, grid, usedIds, warnings);
  const meta = sanitizeMeta(migrated.meta, warnings);

  const doc: SchematicDocument = {
    format: PROJECT_FORMAT,
    version: CURRENT_VERSION,
    name,
    grid,
    components,
    wires,
    texts,
    ...(meta !== undefined ? { meta } : {}),
  };
  const links = sanitizeLinks(migrated.links, doc, warnings);
  if (links !== undefined) doc.links = links;

  return { doc, warnings };
}

/**
 * Parse + validate + migrate a DigiSchem project JSON string.
 * Throws ProjectError with a clear message on fatal errors.
 */
export function parseProject(text: string): SchematicDocument {
  return parseProjectWithWarnings(text).doc;
}

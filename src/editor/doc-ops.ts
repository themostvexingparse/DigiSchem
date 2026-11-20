/**
 * Pure DOM-free document manipulation operations shared by Editor and UI panels
 * (rotate, mirror, delete, nudge, clipboard copy/paste, duplicate, placement).
 */
import type {
  ComponentInstance,
  Point,
  Rotation,
  SchematicDocument,
  TextNote,
  Wire,
} from "../model/types";
import { newId } from "../model/types";
import { GRID } from "../model/component-def";
import { getDef } from "../model/registry";
import {
  boundsOfPoints,
  componentBounds,
  geometryOf,
  snap,
  unionRect,
  type Rect,
} from "../model/geometry";
import type { DocumentStore } from "../model/store";
import {
  captureAttachedWires,
  nextAutoLabel,
  nextCopyLabel,
  normalizeDocWires,
  stretchWireForMove,
  textBounds,
} from "./wire-utils";

export interface ClipboardData {
  components: ComponentInstance[];
  wires: Wire[];
  texts: TextNote[];
  anchor: Point;
}

/** Rotate a point 90 degrees clockwise around (cx, cy) in SVG screen coordinates (+x right, +y down). */
export function rotatePointCW(p: Point, cx: number, cy: number): Point {
  return {
    x: cx - (p.y - cy),
    y: cy + (p.x - cx),
  };
}

/** Compute the combined bounding box of all selected items in `doc`. */
export function selectionBounds(doc: SchematicDocument, selection: ReadonlySet<string>): Rect | null {
  let r: Rect | null = null;
  for (const c of doc.components) {
    if (selection.has(c.id)) r = unionRect(r, componentBounds(c));
  }
  for (const w of doc.wires) {
    if (selection.has(w.id) && w.points.length > 0) r = unionRect(r, boundsOfPoints(w.points));
  }
  for (const t of doc.texts) {
    if (selection.has(t.id)) r = unionRect(r, textBounds(t));
  }
  return r;
}

/**
 * Rotate all selected items 90° CW about the selection's grid-snapped center.
 * Keeps all pins and wire vertices on the grid.
 */
export function rotateSelectionInDoc(doc: SchematicDocument, selection: ReadonlySet<string>): void {
  if (selection.size === 0) return;
  const bounds = selectionBounds(doc, selection);
  if (!bounds) return;
  const grid = doc.grid || GRID;
  const cx = snap(bounds.x + bounds.w / 2, grid);
  const cy = snap(bounds.y + bounds.h / 2, grid);

  for (const c of doc.components) {
    if (!selection.has(c.id)) continue;
    const nextPos = rotatePointCW({ x: c.x, y: c.y }, cx, cy);
    c.x = snap(nextPos.x, grid);
    c.y = snap(nextPos.y, grid);
    c.rotation = ((c.rotation + 90) % 360) as Rotation;
  }
  for (const w of doc.wires) {
    if (!selection.has(w.id)) continue;
    w.points = w.points.map((p) => {
      const rp = rotatePointCW(p, cx, cy);
      return { x: snap(rp.x, grid), y: snap(rp.y, grid) };
    });
  }
  for (const t of doc.texts) {
    if (!selection.has(t.id)) continue;
    const nextPos = rotatePointCW({ x: t.x, y: t.y }, cx, cy);
    t.x = snap(nextPos.x, grid);
    t.y = snap(nextPos.y, grid);
  }
  normalizeDocWires(doc);
}

/**
 * Set a single component's rotation to `targetRotation` while keeping its
 * bounding box centered about its grid-snapped center.
 */
export function setComponentRotationInDoc(
  doc: SchematicDocument,
  compId: string,
  targetRotation: Rotation,
): void {
  const comp = doc.components.find((c) => c.id === compId);
  if (!comp) return;
  const steps = (((targetRotation - comp.rotation) % 360) + 360) % 360 / 90;
  const sel = new Set([compId]);
  for (let i = 0; i < steps; i++) {
    rotateSelectionInDoc(doc, sel);
  }
}

/**
 * Mirror all selected items horizontally.
 * - Single component: flips horizontally in place keeping exact bounding box.
 * - Multi-selection: reflects horizontally about the selection's grid-snapped center.
 */
export function mirrorSelectionInDoc(doc: SchematicDocument, selection: ReadonlySet<string>): void {
  if (selection.size === 0) return;
  const grid = doc.grid || GRID;

  const selComps = doc.components.filter((c) => selection.has(c.id));
  const selWires = doc.wires.filter((w) => selection.has(w.id));
  const selTexts = doc.texts.filter((t) => selection.has(t.id));

  // Single component: flip horizontally in place with zero bounding-box drift.
  if (selComps.length === 1 && selWires.length === 0 && selTexts.length === 0) {
    const c = selComps[0];
    const g = geometryOf(c);
    c.mirror = !c.mirror || undefined;
    if (c.rotation === 90) {
      c.x = snap(c.x - g.height, grid);
      c.y = snap(c.y + g.width, grid);
      c.rotation = 270;
    } else if (c.rotation === 270) {
      c.x = snap(c.x + g.height, grid);
      c.y = snap(c.y - g.width, grid);
      c.rotation = 90;
    }
    return;
  }

  const bounds = selectionBounds(doc, selection);
  if (!bounds) return;
  const cx = snap(bounds.x + bounds.w / 2, grid);

  for (const c of selComps) {
    const g = geometryOf(c);
    c.mirror = !c.mirror || undefined;
    switch (c.rotation) {
      case 0:
        c.x = snap(2 * cx - c.x - g.width, grid);
        break;
      case 180:
        c.x = snap(2 * cx - c.x + g.width, grid);
        break;
      case 90:
        c.x = snap(2 * cx - c.x, grid);
        c.y = snap(c.y + g.width, grid);
        c.rotation = 270;
        break;
      case 270:
        c.x = snap(2 * cx - c.x, grid);
        c.y = snap(c.y - g.width, grid);
        c.rotation = 90;
        break;
    }
  }
  for (const w of selWires) {
    w.points = w.points.map((p) => ({ x: snap(2 * cx - p.x, grid), y: p.y }));
  }
  for (const t of selTexts) {
    const b = textBounds(t);
    t.x = snap(2 * cx - (t.x + b.w), grid);
  }
  normalizeDocWires(doc);
}

export function rotateSelectionInStore(store: DocumentStore): void {
  if (store.selection.size === 0) return;
  const sel = new Set(store.selection);
  store.update("Rotate", (draft) => rotateSelectionInDoc(draft, sel));
}

export function mirrorSelectionInStore(store: DocumentStore): void {
  if (store.selection.size === 0) return;
  const sel = new Set(store.selection);
  store.update("Mirror", (draft) => mirrorSelectionInDoc(draft, sel));
}

export function deleteSelectionInStore(store: DocumentStore): void {
  if (store.selection.size === 0) return;
  const sel = new Set(store.selection);
  store.update("Delete", (draft) => {
    draft.components = draft.components.filter((c) => !sel.has(c.id));
    draft.wires = draft.wires.filter((w) => !sel.has(w.id));
    draft.texts = draft.texts.filter((t) => !sel.has(t.id));
  });
}

/**
 * Nudge all selected items by `(dx, dy)` in one undo step, stretching any
 * unselected wires attached to moved component pins.
 */
export function nudgeSelectionInStore(store: DocumentStore, dx: number, dy: number): void {
  if (store.selection.size === 0 || (dx === 0 && dy === 0)) return;
  const sel = new Set(store.selection);
  const movedCompIds = new Set<string>();
  const selWireIds = new Set<string>();
  for (const c of store.doc.components) if (sel.has(c.id)) movedCompIds.add(c.id);
  for (const w of store.doc.wires) if (sel.has(w.id)) selWireIds.add(w.id);

  const attached = captureAttachedWires(store.doc, movedCompIds, selWireIds);

  store.update("Nudge", (draft) => {
    for (const c of draft.components) {
      if (sel.has(c.id)) {
        c.x += dx;
        c.y += dy;
      }
    }
    for (const w of draft.wires) {
      if (sel.has(w.id)) {
        for (const p of w.points) {
          p.x += dx;
          p.y += dy;
        }
      }
    }
    for (const t of draft.texts) {
      if (sel.has(t.id)) {
        t.x += dx;
        t.y += dy;
      }
    }
    for (const snapWire of attached) {
      const w = draft.wires.find((x) => x.id === snapWire.wireId);
      if (!w) continue;
      w.points = stretchWireForMove(
        snapWire.origPoints,
        snapWire.startAttached,
        snapWire.endAttached,
        { x: dx, y: dy },
        true,
      );
    }
    normalizeDocWires(draft);
  });
}

/** Copy selected items into a detached ClipboardData snapshot. */
export function copySelectionFromDoc(
  doc: SchematicDocument,
  selection: ReadonlySet<string>,
): ClipboardData | null {
  if (selection.size === 0) return null;
  const components = doc.components.filter((c) => selection.has(c.id)).map((c) => structuredClone(c));
  const wires = doc.wires.filter((w) => selection.has(w.id)).map((w) => structuredClone(w));
  const texts = doc.texts.filter((t) => selection.has(t.id)).map((t) => structuredClone(t));
  if (components.length === 0 && wires.length === 0 && texts.length === 0) return null;
  const bounds = selectionBounds(doc, selection)!;
  const grid = doc.grid || GRID;
  const anchor: Point = {
    x: snap(bounds.x + bounds.w / 2, grid),
    y: snap(bounds.y + bounds.h / 2, grid),
  };
  return { components, wires, texts, anchor };
}

/**
 * Paste `clip` into `store`, placing its center anchor at `targetCenter` (grid-snapped).
 * If `targetCenter` is omitted, offsets by (+2*grid, +2*grid) from the original anchor.
 * Returns the newly created IDs and selects them.
 */
export function pasteClipboardIntoStore(
  store: DocumentStore,
  clip: ClipboardData,
  targetCenter?: Point,
  label = "Paste",
): string[] {
  const grid = store.doc.grid || GRID;
  const dest: Point = targetCenter
    ? { x: snap(targetCenter.x, grid), y: snap(targetCenter.y, grid) }
    : { x: clip.anchor.x + 2 * grid, y: clip.anchor.y + 2 * grid };
  const dx = dest.x - clip.anchor.x;
  const dy = dest.y - clip.anchor.y;

  const newIds: string[] = [];
  store.update(label, (draft) => {
    for (const src of clip.components) {
      const c: ComponentInstance = structuredClone(src);
      c.id = newId("c");
      c.x = snap(c.x + dx, grid);
      c.y = snap(c.y + dy, grid);
      c.label = nextCopyLabel(draft, c);
      draft.components.push(c);
      newIds.push(c.id);
    }
    for (const src of clip.wires) {
      const w: Wire = structuredClone(src);
      w.id = newId("w");
      w.points = w.points.map((p) => ({ x: snap(p.x + dx, grid), y: snap(p.y + dy, grid) }));
      draft.wires.push(w);
      newIds.push(w.id);
    }
    for (const src of clip.texts) {
      const t: TextNote = structuredClone(src);
      t.id = newId("t");
      t.x = snap(t.x + dx, grid);
      t.y = snap(t.y + dy, grid);
      draft.texts.push(t);
      newIds.push(t.id);
    }
    normalizeDocWires(draft);
  });

  if (newIds.length > 0) {
    store.setSelection(newIds);
  }
  return newIds;
}

/** Duplicate the current selection offset by (2*grid, 2*grid). */
export function duplicateSelectionInStore(store: DocumentStore): string[] {
  const clip = copySelectionFromDoc(store.doc, store.selection);
  if (!clip) return [];
  return pasteClipboardIntoStore(store, clip, undefined, "Duplicate");
}

/** Compute a grid-snapped origin so a component's visual center sits near `worldCenter`. */
export function centeredOriginForPlacement(
  type: string,
  rotation: Rotation,
  mirror: boolean,
  worldCenter: Point,
  grid = GRID,
): Point {
  const def = getDef(type);
  const props = def ? { ...def.defaultProps } : {};
  const b0 = componentBounds({
    id: "",
    type,
    x: 0,
    y: 0,
    rotation,
    mirror: mirror || undefined,
    props,
  });
  const cx = b0.x + b0.w / 2;
  const cy = b0.y + b0.h / 2;
  return {
    x: snap(worldCenter.x - cx, grid),
    y: snap(worldCenter.y - cy, grid),
  };
}

/** Place a new component of `type` at `(x, y)` with auto-assigned label and select it. */
export function placeComponentInStore(
  store: DocumentStore,
  type: string,
  x: number,
  y: number,
  rotation: Rotation = 0,
  mirror = false,
): ComponentInstance | null {
  const def = getDef(type);
  if (!def) return null;
  const grid = store.doc.grid || GRID;
  let created: ComponentInstance | null = null;
  store.update(`Place ${def.name}`, (draft) => {
    const inst: ComponentInstance = {
      id: newId("c"),
      type: def.type,
      x: snap(x, grid),
      y: snap(y, grid),
      rotation,
      props: structuredClone(def.defaultProps),
    };
    if (mirror) inst.mirror = true;
    if (def.labelPrefix) {
      inst.label = nextAutoLabel(draft, def.labelPrefix);
    }
    draft.components.push(inst);
    created = inst;
  });
  if (created) {
    store.setSelection([(created as ComponentInstance).id]);
  }
  return created;
}

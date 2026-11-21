/**
 * CORE CONTRACT — document store with undo/redo.
 *
 * All document mutations go through store.update(label, mutator). The mutator
 * receives a deep-cloned draft and mutates it in place; the store records the
 * previous snapshot for undo. Selection is NOT part of undo history.
 *
 * For continuous gestures (dragging), call store.beginGesture() on mouse-down,
 * then store.update(...) as often as you like, then store.endGesture() — the
 * whole drag becomes a single undo step.
 */
import type { SchematicDocument } from "./types";
import { emptyDocument } from "./types";
import { inferLinks, maintainLinks } from "./links";
import { mergeWireSeams } from "./merge";

export type ChangeKind = "doc" | "selection" | "replace";
export type Listener = (kind: ChangeKind) => void;

const MAX_HISTORY = 200;

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class DocumentStore {
  private _doc: SchematicDocument;
  private undoStack: { label: string; doc: SchematicDocument }[] = [];
  private redoStack: { label: string; doc: SchematicDocument }[] = [];
  private listeners = new Set<Listener>();
  private gestureDepth = 0;
  private gestureRecorded = false;
  /** dirty flag + redo stack as they were when the outermost gesture began (restored on cancel). */
  private gesturePrevDirty = false;
  private gesturePrevRedo: { label: string; doc: SchematicDocument }[] = [];
  /** Selected ids (components, wires, texts share one id space). */
  private _selection = new Set<string>();
  /** True when the document has unsaved changes. */
  dirty = false;
  /** Absolute path of the project file on disk, if saved/opened. */
  filePath: string | null = null;
  /** What produced the current document: an edit, an automatic amendment, undo / redo, or a replace. */
  lastChange: "edit" | "amend" | "undo" | "redo" | "replace" = "replace";

  constructor(doc: SchematicDocument = emptyDocument()) {
    this._doc = withLinks(doc);
  }

  get doc(): Readonly<SchematicDocument> {
    return this._doc;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: ChangeKind) {
    for (const fn of this.listeners) fn(kind);
  }

  /** Apply a mutation as one undoable step (or part of the current gesture). */
  update(label: string, mutator: (draft: SchematicDocument) => void): void {
    const before = this._doc;
    const draft = clone(before);
    mutator(draft);
    // Connectivity is kept, never re-derived from an edited drawing (see model/links.ts).
    maintainLinks(before, draft);
    // Wires drawn end to end become one wire — but never mid-gesture (a drag tracks wires by id).
    if (this.gestureDepth === 0) mergeWireSeams(draft);
    // No-op edits (re-setting the same value, a drag back to its start) must not create
    // undo entries or mark the document dirty.
    if (JSON.stringify(draft) === JSON.stringify(before)) return;
    if (this.gestureDepth === 0 || !this.gestureRecorded) {
      this.undoStack.push({ label, doc: before });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      if (this.gestureDepth > 0) this.gestureRecorded = true;
    }
    this._doc = draft;
    this.dirty = true;
    this.lastChange = "edit";
    this.pruneSelection();
    this.emit("doc");
  }

  /**
   * Amend the CURRENT step (no new undo entry): automatic follow-ups of an edit — e.g. a wire that
   * could not be routed being restored once there is room — belong to the edit that caused them.
   */
  amend(mutator: (draft: SchematicDocument) => void): void {
    const before = this._doc;
    const draft = clone(before);
    mutator(draft);
    if (JSON.stringify(draft) === JSON.stringify(before)) return;
    maintainLinks(before, draft);
    this._doc = draft;
    this.dirty = true;
    if (this.lastChange !== "undo" && this.lastChange !== "redo") this.lastChange = "amend";
    this.pruneSelection();
    this.emit("doc");
  }

  beginGesture(): void {
    if (this.gestureDepth++ === 0) {
      this.gestureRecorded = false;
      this.gesturePrevDirty = this.dirty;
      this.gesturePrevRedo = this.redoStack;
    }
  }

  /** True while a gesture (drag / resize / text edit) is open. */
  inGesture(): boolean {
    return this.gestureDepth > 0;
  }

  private resetGesture(): void {
    this.gestureDepth = 0;
    this.gestureRecorded = false;
  }

  endGesture(): void {
    if (this.gestureDepth === 0) return;
    if (this.gestureDepth === 1 && this.gestureRecorded) {
      // Merge end-to-end seams the gesture left, as part of the same undo step.
      const merged = clone(this._doc);
      if (mergeWireSeams(merged) > 0) {
        this._doc = merged;
        this.pruneSelection();
        this.emit("doc");
      }
    }
    if (--this.gestureDepth === 0 && this.gestureRecorded) {
      // A gesture that ended where it started (e.g. dragged away and back) leaves no history.
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && JSON.stringify(top.doc) === JSON.stringify(this._doc)) {
        this.undoStack.pop();
        this.redoStack = this.gesturePrevRedo;
        this.dirty = this.gesturePrevDirty;
        this.emit("selection");
      }
      this.gestureRecorded = false;
    }
  }

  /** Abort the current gesture, restoring the document state from before it. */
  cancelGesture(): void {
    if (this.gestureDepth > 0) {
      if (this.gestureRecorded) {
        const prev = this.undoStack.pop();
        if (prev) this._doc = prev.doc;
        this.redoStack = this.gesturePrevRedo;
        this.dirty = this.gesturePrevDirty;
        this.pruneSelection();
        this.emit("doc");
      }
    }
    this.resetGesture();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    // Undo while a gesture is open finalizes the gesture first, so the pre-gesture
    // snapshot is what gets restored and later updates start a fresh history entry.
    this.resetGesture();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ label: prev.label, doc: this._doc });
    this._doc = prev.doc;
    this.dirty = true;
    this.lastChange = "undo";
    this.pruneSelection();
    this.emit("doc");
  }

  redo(): void {
    this.resetGesture();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ label: next.label, doc: this._doc });
    this._doc = next.doc;
    this.dirty = true;
    this.lastChange = "redo";
    this.pruneSelection();
    this.emit("doc");
  }

  /** Replace the whole document (open / new). Clears history. */
  replace(doc: SchematicDocument, filePath: string | null = null): void {
    this.resetGesture();
    this._doc = withLinks(doc);
    this.undoStack = [];
    this.redoStack = [];
    this._selection.clear();
    this.dirty = false;
    this.filePath = filePath;
    this.lastChange = "replace";
    this.emit("replace");
  }

  // ---- selection ----
  get selection(): ReadonlySet<string> {
    return this._selection;
  }

  setSelection(ids: Iterable<string>): void {
    this._selection = new Set(ids);
    this.emit("selection");
  }

  isSelected(id: string): boolean {
    return this._selection.has(id);
  }

  private pruneSelection() {
    if (this._selection.size === 0) return;
    const alive = new Set<string>();
    for (const c of this._doc.components) alive.add(c.id);
    for (const w of this._doc.wires) alive.add(w.id);
    for (const t of this._doc.texts) alive.add(t.id);
    for (const id of [...this._selection]) if (!alive.has(id)) this._selection.delete(id);
  }

  markSaved(filePath: string | null): void {
    this.dirty = false;
    if (filePath) this.filePath = filePath;
    this.emit("selection");
  }
}

/** A document with stored connectivity (inferred once from the drawing when it has none). */
function withLinks(doc: SchematicDocument): SchematicDocument {
  if (doc.links) return doc;
  return { ...doc, links: inferLinks(doc) };
}

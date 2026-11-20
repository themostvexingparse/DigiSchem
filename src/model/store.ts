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
  /** Selected ids (components, wires, texts share one id space). */
  private _selection = new Set<string>();
  /** True when the document has unsaved changes. */
  dirty = false;
  /** Absolute path of the project file on disk, if saved/opened. */
  filePath: string | null = null;

  constructor(doc: SchematicDocument = emptyDocument()) {
    this._doc = doc;
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
    if (this.gestureDepth === 0 || !this.gestureRecorded) {
      this.undoStack.push({ label, doc: before });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      if (this.gestureDepth > 0) this.gestureRecorded = true;
    }
    this._doc = draft;
    this.dirty = true;
    this.pruneSelection();
    this.emit("doc");
  }

  beginGesture(): void {
    if (this.gestureDepth++ === 0) this.gestureRecorded = false;
  }

  endGesture(): void {
    if (this.gestureDepth > 0) this.gestureDepth--;
  }

  /** Abort the current gesture, restoring the document state from before it. */
  cancelGesture(): void {
    if (this.gestureDepth > 0 && this.gestureRecorded) {
      const prev = this.undoStack.pop();
      if (prev) this._doc = prev.doc;
      this.emit("doc");
    }
    this.gestureDepth = 0;
    this.gestureRecorded = false;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ label: prev.label, doc: this._doc });
    this._doc = prev.doc;
    this.dirty = true;
    this.pruneSelection();
    this.emit("doc");
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ label: next.label, doc: this._doc });
    this._doc = next.doc;
    this.dirty = true;
    this.pruneSelection();
    this.emit("doc");
  }

  /** Replace the whole document (open / new). Clears history. */
  replace(doc: SchematicDocument, filePath: string | null = null): void {
    this._doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this._selection.clear();
    this.dirty = false;
    this.filePath = filePath;
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

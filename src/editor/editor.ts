/**
 * CONTRACT (owned by the editor module): interactive canvas.
 * The public API below is used by src/app and src/ui — keep signatures stable.
 * STUB: currently only renders the scene; interactions to be implemented.
 */
import type { DocumentStore } from "../model/store";
import { renderScene, schematicCss, LIGHT_THEME, type Theme } from "../render/svg";

export type Tool = "select" | "wire" | "text" | "pan";

export class Editor {
  readonly store: DocumentStore;
  private host: HTMLElement;
  private svg: SVGSVGElement;
  private theme: Theme = LIGHT_THEME;
  private listeners = new Set<() => void>();
  tool: Tool = "select";
  gridVisible = true;

  constructor(host: HTMLElement, store: DocumentStore) {
    this.host = host;
    this.store = store;
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.host.appendChild(this.svg);
    store.subscribe(() => this.render());
    this.render();
  }

  /** Notified when editor state (tool, zoom, placing) changes — for toolbar/status UI. */
  onStateChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setTool(tool: Tool): void { this.tool = tool; this.listeners.forEach((f) => f()); }
  /** Begin placing a new component of `type` (ghost follows the cursor, click to drop, Esc to cancel). */
  startPlacing(_type: string): void {}
  setTheme(theme: Theme): void { this.theme = theme; this.render(); }
  getTheme(): Theme { return this.theme; }
  setGridVisible(v: boolean): void { this.gridVisible = v; this.render(); }
  zoomToFit(): void {}
  zoomBy(_factor: number): void {}
  rotateSelection(): void {}
  mirrorSelection(): void {}
  deleteSelection(): void {}
  copySelection(): void {}
  cutSelection(): void {}
  paste(): void {}
  selectAll(): void {}
  duplicateSelection(): void {}
  /** Status text e.g. cursor coordinates and zoom. */
  statusText(): string { return ""; }

  private render() {
    this.svg.innerHTML = `<style>${schematicCss(this.theme)}</style>` + renderScene(this.store.doc);
  }
}

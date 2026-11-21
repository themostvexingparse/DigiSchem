/**
 * CONTRACT (owned by the editor module): interactive SVG schematic canvas.
 * Public API is used by src/main.ts, src/app/commands.ts, and src/ui/palette.ts.
 */
import type { DocumentStore } from "../model/store";
import type { ComponentInstance, Point, Rotation, SchematicDocument, TextNote, Wire } from "../model/types";
import { newId } from "../model/types";
import { escapeXml, GRID } from "../model/component-def";
import { getDef } from "../model/registry";
import {
  componentBounds,
  pointInRect,
  documentBounds,
  geometryOf,
  unconnectedPins,
  worldPins,
  type Rect,
  type WorldPin,
} from "../model/geometry";
import {
  LIGHT_THEME,
  renderComponent,
  renderScene,
  schematicCss,
  type Theme,
} from "../render/svg";
import {
  buildWirePreview,
  captureAttachedWires,
  dragWireSegmentPoints,
  findPinAt,
  followSegmentBranches,
  segmentBranches,
  type SegmentBranch,
  findSnapTarget,
  hitTestDocument,
  hitTestWire,
  isPointAnchored,
  itemsInRect,
  normalizeDocWires,
  normalizeWirePoints,
  pinExitHorizontal,
  pinExitVector,
  routePinAware,
  pointsEqual,
  snapToGrid,
  stretchWireForMove,
  textBounds,
  type AttachedWireSnapshot,
  type SnapTarget,
} from "./wire-utils";
import { connectionConflicts, type ConnectionConflict } from "../model/links";
import { badWireIds, restoreWires } from "./safe-route";
import { movedEndContacts, netWiresAt, RouteObstacles, repairSegmentDrop, repairWires, safeRoute, sameNetWires, trimToBranchPoints } from "./safe-route";
import { computeGuides, guidePeers, type GuideResult } from "./guides";
import { getSettings, onSettingsChange, updateSettings } from "../model/settings";
import {
  centeredOriginForPlacement,
  copySelectionFromDoc,
  deleteSelectionInStore,
  duplicateSelectionInStore,
  keepWiresAttached,
  mirrorSelectionInStore,
  nudgeSelectionInStore,
  pasteClipboardIntoStore,
  placeComponentInStore,
  rotateSelectionInStore,
  type ClipboardData,
} from "./doc-ops";
import {
  applyResizeDrag,
  hasSnappedResizeDelta,
  hitTestResizeHandle,
  resizeHandles,
  type ResizeCursor,
  type ResizeHandleId,
  type ResizeResult,
} from "./resize";

export type Tool = "select" | "wire" | "text" | "pan";

export const DRAG_TYPE_MIME = "application/x-digischem-type";
export const FOCUS_LABEL_EVENT = "digischem:focus-label";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

let activePaletteDragType: string | null = null;
export function setDraggedPaletteType(type: string | null): void {
  activePaletteDragType = type;
}
export function getDraggedPaletteType(): string | null {
  return activePaletteDragType;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function isEditableElement(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT") {
    const t = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(t);
  }
  // <select> keeps arrow keys for itself, but must not swallow the editor's letter/Ctrl shortcuts.
  return tag === "TEXTAREA" || el.isContentEditable;
}

type HoverState =
  | { kind: "resize-handle"; compId: string; handle: ResizeHandleId; cursor: ResizeCursor }
  | { kind: "pin"; pin: WorldPin }
  | { kind: "wire-snap"; pos: Point }
  | { kind: "component"; id: string }
  | { kind: "wire"; id: string; segIndex: number }
  | { kind: "text"; id: string }
  | null;

type Interaction =
  | {
      kind: "pan";
      startClient: Point;
      startPan: Point;
      pointerId: number;
    }
  | {
      kind: "marquee";
      startWorld: Point;
      currentWorld: Point;
      additive: boolean;
      initialSelection: Set<string>;
      pointerId: number;
    }
  | {
      kind: "move-selection";
      startWorldSnapped: Point;
      lastDelta: Point;
      origComponents: Map<string, Point>;
      origWires: Map<string, Point[]>;
      origTexts: Map<string, Point>;
      attachedWires: AttachedWireSnapshot[];
      moved: boolean;
      narrowToIdOnClick: string | null;
      pointerId: number;
      /** Electrical nets at drag start (so the router never mistakes a fresh short for a net). */
      netsBefore: Map<string, Set<string>>;
      /** Every wire's path at drag start (chain-following may edit wires outside the selection). */
      startWires: Map<string, Point[]>;
      /** Smart-guide anchor (component grabbed) and its same-type/same-size peers. */
      guide: { anchorOrig: Rect; peers: Rect[] } | null;
      guides: GuideResult | null;
    }
  | {
      kind: "drag-wire-segment";
      netsBefore: Map<string, Set<string>>;
      /** Wires attached to the dragged segment (they follow it). */
      branches: SegmentBranch[];
      wireId: string;
      segIndex: number;
      origPoints: Point[];
      isHorizontal: boolean;
      startAnchored: boolean;
      endAnchored: boolean;
      startWorldSnapped: Point;
      lastDelta: Point;
      moved: boolean;
      pointerId: number;
    }
  | {
      kind: "resize-component";
      compId: string;
      handle: ResizeHandleId;
      cursor: ResizeCursor;
      startWorldExact: Point;
      origComp: ComponentInstance;
      origWires: Wire[];
      lastResult: ResizeResult | null;
      moved: boolean;
      pointerId: number;
    }
  | {
      kind: "pending-pin-wire";
      pin: WorldPin;
      startClient: Point;
      pointerId: number;
    }
  | {
      kind: "pin-wire-drag";
      startPin: WorldPin;
      pointerId: number;
    };

export class Editor {
  readonly store: DocumentStore;
  private host: HTMLElement;
  private svg: SVGSVGElement;
  private styleEl: SVGStyleElement;
  private gridPatternEl: SVGPatternElement;
  private gridDotEl: SVGCircleElement;
  private bgRect: SVGRectElement;
  private viewportGroup: SVGGElement;
  private gridRect: SVGRectElement;
  private sceneGroup: SVGGElement;
  private unconnectedGroup: SVGGElement;
  private overlayGroup: SVGGElement;

  private theme: Theme = LIGHT_THEME;
  private listeners = new Set<() => void>();

  tool: Tool = "select";
  gridVisible = true;

  // Viewport transform: screen = world * zoom + pan
  private panX = 40;
  private panY = 40;
  private zoom = 1;

  // Cursor & hover state
  private cursorWorldExact: Point = { x: 0, y: 0 };
  private cursorWorldSnapped: Point = { x: 0, y: 0 };
  private hasCursor = false;
  private hover: HoverState = null;

  // Active tools / modes
  private placing: { type: string; rotation: Rotation; mirror: boolean } | null = null;
  private dragDropGhostType: string | null = null;
  private wireDraft: { points: Point[]; horizontalFirst: boolean; startExit?: Point | null; flipped?: boolean } | null = null;
  private interaction: Interaction | null = null;
  private spaceDown = false;
  private clipboard: ClipboardData | null = null;
  private activeTextEditor: HTMLTextAreaElement | null = null;

  // Cached scene geometry (rebuilt only on doc/replace changes for fast hover & hit testing)
  private cachedPins: WorldPin[] = [];
  private cachedCompBounds: { comp: ComponentInstance; bounds: Rect }[] = [];

  private gridPatternId = `ds-grid-${Math.random().toString(36).slice(2, 8)}`;

  constructor(host: HTMLElement, store: DocumentStore) {
    this.host = host;
    this.store = store;

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("tabindex", "0");
    this.svg.style.outline = "none";
    this.svg.style.display = "block";
    this.svg.style.touchAction = "none";

    this.styleEl = document.createElementNS(SVG_NS, "style");
    this.svg.appendChild(this.styleEl);

    const defs = document.createElementNS(SVG_NS, "defs");
    this.gridPatternEl = document.createElementNS(SVG_NS, "pattern");
    this.gridPatternEl.setAttribute("id", this.gridPatternId);
    this.gridPatternEl.setAttribute("patternUnits", "userSpaceOnUse");
    this.gridDotEl = document.createElementNS(SVG_NS, "circle");
    this.gridPatternEl.appendChild(this.gridDotEl);
    defs.appendChild(this.gridPatternEl);
    this.svg.appendChild(defs);

    this.bgRect = document.createElementNS(SVG_NS, "rect");
    this.bgRect.setAttribute("width", "100%");
    this.bgRect.setAttribute("height", "100%");
    this.svg.appendChild(this.bgRect);

    this.viewportGroup = document.createElementNS(SVG_NS, "g");
    this.viewportGroup.setAttribute("class", "ds-viewport");

    this.gridRect = document.createElementNS(SVG_NS, "rect");
    this.gridRect.setAttribute("fill", `url(#${this.gridPatternId})`);
    this.gridRect.setAttribute("pointer-events", "none");
    this.viewportGroup.appendChild(this.gridRect);

    this.sceneGroup = document.createElementNS(SVG_NS, "g");
    this.sceneGroup.setAttribute("class", "ds-scene");
    this.viewportGroup.appendChild(this.sceneGroup);

    this.unconnectedGroup = document.createElementNS(SVG_NS, "g");
    this.unconnectedGroup.setAttribute("class", "ds-unconnected");
    this.unconnectedGroup.setAttribute("pointer-events", "none");
    this.viewportGroup.appendChild(this.unconnectedGroup);

    this.overlayGroup = document.createElementNS(SVG_NS, "g");
    this.overlayGroup.setAttribute("class", "ds-overlay");
    this.overlayGroup.setAttribute("pointer-events", "none");
    this.viewportGroup.appendChild(this.overlayGroup);

    this.svg.appendChild(this.viewportGroup);
    this.host.appendChild(this.svg);

    this.applyTheme();
    this.updateViewport();
    this.rebuildScene();
    this.knownBad = badWireIds(this.store.doc as SchematicDocument);

    this.store.subscribe((kind) => {
      if (kind === "doc" || kind === "replace") {
        if (kind === "replace") {
          this.wireDraft = null;
          this.placing = null;
          this.interaction = null;
          this.closeTextEditor(false);
          // a freshly opened drawing: what is already unclean is not ours to re-route
          this.unrouted.clear();
          this.knownBad = badWireIds(this.store.doc as SchematicDocument);
        } else {
          this.scheduleRouteWatch();
        }
        this.rebuildScene();
        if (kind === "replace") this.emitState();
      } else {
        // Selection change only: never rebuild scene layer!
        this.renderOverlay();
      }
    });

    // Live-apply preference changes from the Settings dialog.
    this.gridVisible = getSettings().showGrid;
    this.updateGrid();
    onSettingsChange((s) => {
      if (s.showGrid !== this.gridVisible) this.setGridVisible(s.showGrid);
      this.rebuildScene();
    });

    this.installEvents();
  }

  /** Notified when editor state (tool, zoom, cursor, placing, theme) changes. */
  onStateChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitState(): void {
    this.listeners.forEach((f) => f());
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.placing = null;
    if (tool !== "wire") this.wireDraft = null;
    this.closeTextEditor(true);
    this.updateCursorStyle();
    this.renderOverlay();
    this.emitState();
  }

  /** Begin placing a new component of `type` (ghost follows the cursor, click to drop, Esc to cancel). */
  startPlacing(type: string): void {
    if (!getDef(type)) return;
    this.closeTextEditor(true);
    this.wireDraft = null;
    this.interaction = null;
    this.placing = { type, rotation: 0, mirror: false };
    this.svg.focus({ preventScroll: true });
    this.updateCursorStyle();
    this.renderOverlay();
    this.emitState();
  }

  /** Currently placing component type, or null if not in placement mode. */
  getPlacingType(): string | null {
    return this.placing?.type ?? null;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.applyTheme();
    this.renderOverlay();
    this.emitState();
  }

  getTheme(): Theme {
    return this.theme;
  }

  setGridVisible(v: boolean): void {
    this.gridVisible = v;
    if (getSettings().showGrid !== v) updateSettings({ showGrid: v }); // G key / toolbar persist too
    this.updateGrid();
    this.emitState();
  }

  zoomToFit(): void {
    const b = documentBounds(this.store.doc);
    const { w, h } = this.hostSize();
    if (!b) {
      this.zoom = 1;
      this.panX = 40;
      this.panY = 40;
    } else {
      const margin = 48;
      const bw = Math.max(b.w, 40);
      const bh = Math.max(b.h, 40);
      const fitZoom = Math.min((w - margin * 2) / bw, (h - margin * 2) / bh);
      this.zoom = clamp(fitZoom, MIN_ZOOM, 2);
      this.panX = w / 2 - (b.x + b.w / 2) * this.zoom;
      this.panY = h / 2 - (b.y + b.h / 2) * this.zoom;
    }
    this.updateViewport();
    this.renderOverlay();
    this.emitState();
  }

  /** Abandon transient editor state (placement ghost, wire draft, inline text editor). */
  cancelTransient(): void {
    this.placing = null;
    this.wireDraft = null;
    this.closeTextEditor(true);
    this.renderOverlay();
    this.emitState();
  }

  /** Current zoom factor (1 = 100%). */
  getZoom(): number {
    return this.zoom;
  }

  zoomBy(factor: number): void {
    const { w, h } = this.hostSize();
    this.zoomAtScreenPoint(w / 2, h / 2, factor);
  }

  rotateSelection(): void {
    if (this.placing) {
      this.placing.rotation = ((this.placing.rotation + 90) % 360) as Rotation;
      this.renderOverlay();
      this.emitState();
      return;
    }
    rotateSelectionInStore(this.store);
  }

  mirrorSelection(): void {
    if (this.placing) {
      this.placing.mirror = !this.placing.mirror;
      this.renderOverlay();
      this.emitState();
      return;
    }
    mirrorSelectionInStore(this.store);
  }

  deleteSelection(): void {
    deleteSelectionInStore(this.store, { sweepOrphans: getSettings().sweepOrphanWires });
  }

  copySelection(): void {
    const clip = copySelectionFromDoc(this.store.doc, this.store.selection);
    if (clip) this.clipboard = clip;
  }

  cutSelection(): void {
    this.copySelection();
    this.deleteSelection();
  }

  private lastWireClick: { t: number; x: number; y: number } | null = null;
  private lastPaste: { x: number; y: number; n: number } | null = null;
  paste(): void {
    if (!this.clipboard) return;
    let target = this.hasCursor ? { ...this.cursorWorldSnapped } : undefined;
    // Pasting again at the same spot (or right on top of the copied originals) would stack
    // copies exactly over each other — and geometric connectivity would short every pin.
    // Cascade each repeated paste by two grid cells instead.
    const g = this.grid();
    const base = target ?? this.clipboard.anchor;
    const same = this.lastPaste && this.lastPaste.x === base.x && this.lastPaste.y === base.y;
    const onAnchor = base.x === this.clipboard.anchor.x && base.y === this.clipboard.anchor.y;
    const n = same ? this.lastPaste!.n + 1 : onAnchor ? 1 : 0;
    this.lastPaste = { x: base.x, y: base.y, n };
    if (n > 0) target = { x: base.x + 2 * g * n, y: base.y + 2 * g * n };
    pasteClipboardIntoStore(this.store, this.clipboard, target);
  }

  selectAll(): void {
    const ids: string[] = [];
    for (const c of this.store.doc.components) ids.push(c.id);
    for (const w of this.store.doc.wires) ids.push(w.id);
    for (const t of this.store.doc.texts) ids.push(t.id);
    this.store.setSelection(ids);
  }

  duplicateSelection(): void {
    duplicateSelectionInStore(this.store);
  }

  /** Status text: cursor world coordinates, zoom %, tool, hint for active action. */
  statusText(): string {
    const coords = `(${this.cursorWorldSnapped.x}, ${this.cursorWorldSnapped.y})`;
    const zoomPct = `${Math.round(this.zoom * 100)}%`;

    let mode: string;
    let hint: string;
    const activeInter = this.interaction;
    if (activeInter?.kind === "resize-component") {
      const c = this.store.doc.components.find((x) => x.id === activeInter.compId);
      const g = c ? geometryOf(c) : null;
      mode = "Resize";
      hint = g ? `${g.width} × ${g.height} · Esc cancel` : "Drag to resize · Esc cancel";
    } else if (this.placing) {
      const def = getDef(this.placing.type);
      mode = `Place: ${def?.name ?? this.placing.type}`;
      hint = "Click to place (Shift: keep placing) · R rotate · M mirror · Esc cancel";
    } else if (this.wireDraft) {
      mode = "Wire";
      const dir = this.wireDraft.horizontalFirst ? "H→V" : "V→H";
      hint = `Click to bend · Click pin/wire or double-click to finish · / flip (${dir}) · Esc cancel`;
    } else if (this.spaceDown || this.tool === "pan") {
      mode = "Pan";
      hint = "Drag to pan · Scroll to zoom";
    } else if (this.tool === "wire") {
      mode = "Wire";
      hint = "Click a pin, wire, or grid point to start · Esc select";
    } else if (this.tool === "text") {
      mode = "Text";
      hint = "Click to add text note · Esc select";
    } else {
      mode = "Select";
      hint = "Click/drag to select · Drag pin to wire · Double-click to edit · Space+drag pan";
    }
    return `${coords}   |   ${zoomPct}   |   ${mode}   |   ${hint}`;
  }

  // ---- Coordinate & Viewport Helpers ----

  private grid(): number {
    return this.store.doc.grid || GRID;
  }

  private hostSize(): { w: number; h: number } {
    return {
      w: this.host.clientWidth || 800,
      h: this.host.clientHeight || 600,
    };
  }

  private clientToScreen(clientX: number, clientY: number): Point {
    const rect = this.svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private screenToWorld(sx: number, sy: number): Point {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  private worldToScreen(wx: number, wy: number): Point {
    return {
      x: wx * this.zoom + this.panX,
      y: wy * this.zoom + this.panY,
    };
  }

  private clientToWorld(clientX: number, clientY: number): Point {
    const s = this.clientToScreen(clientX, clientY);
    return this.screenToWorld(s.x, s.y);
  }

  private pinToleranceWorld(): number {
    return clamp(9 / this.zoom, 5, 16);
  }

  private wireToleranceWorld(): number {
    return clamp(7 / this.zoom, 4, 14);
  }

  private handleToleranceWorld(): number {
    return clamp(8 / this.zoom, 5, 12);
  }

  private singleSelectedResizable(): ComponentInstance | null {
    if (this.store.selection.size !== 1) return null;
    const [id] = this.store.selection;
    const comp = this.store.doc.components.find((c) => c.id === id);
    if (!comp) return null;
    return getDef(comp.type)?.resizable ? comp : null;
  }

  private zoomAtScreenPoint(sx: number, sy: number, factor: number): void {
    const oldZoom = this.zoom;
    const newZoom = clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (newZoom === oldZoom) return;
    const wx = (sx - this.panX) / oldZoom;
    const wy = (sy - this.panY) / oldZoom;
    this.zoom = newZoom;
    this.panX = sx - wx * newZoom;
    this.panY = sy - wy * newZoom;
    this.updateViewport();
    this.renderOverlay();
    this.emitState();
  }

  private applyTheme(): void {
    const accent = this.theme.name === "dark" ? "#5fa0ff" : this.theme.name === "print" ? "#2463d1" : "#2463d1";
    const accentSoft = this.theme.name === "dark" ? "rgba(95,160,255,0.22)" : "rgba(36,99,209,0.14)";
    const unconnStroke = this.theme.name === "dark" ? "#e07a5f" : "#c04040";
    this.styleEl.textContent =
      schematicCss(this.theme) +
      "\n" +
      [
        `.ds-sel-box{fill:${accentSoft};stroke:${accent};stroke-width:1.4;stroke-dasharray:5 3;vector-effect:non-scaling-stroke}`,
        `.ds-hover-box{fill:none;stroke:${accent};stroke-width:1.2;opacity:0.55;vector-effect:non-scaling-stroke}`,
        `.ds-sel-wire-halo{fill:none;stroke:${accent};stroke-width:7;stroke-linecap:round;stroke-linejoin:round;opacity:0.32}`,
        `.ds-sel-wire-core{fill:none;stroke:${accent};stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}`,
        `.ds-hover-wire{fill:none;stroke:${accent};stroke-width:5;stroke-linecap:round;stroke-linejoin:round;opacity:0.3}`,
        `.ds-wire-preview{fill:none;stroke:${accent};stroke-width:2;stroke-dasharray:6 3;stroke-linecap:round;stroke-linejoin:round}`,
        `.ds-wire-dot{fill:${accent};stroke:none}`,
        `.ds-pin-target{fill:${accentSoft};stroke:${accent};stroke-width:2;vector-effect:non-scaling-stroke}`,
        `.ds-pin-tag-bg{fill:${this.theme.background};stroke:${accent};stroke-width:1;opacity:0.92;vector-effect:non-scaling-stroke}`,
        `.ds-pin-tag-text{fill:${this.theme.text};font-family:"Segoe UI",Arial,sans-serif;font-size:10px;font-weight:600}`,
        `.ds-marquee{fill:${accentSoft};stroke:${accent};stroke-width:1.2;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}`,
        `.ds-unconn-pin{fill:${this.theme.background};stroke:${unconnStroke};stroke-width:1.3}`,
        `.ds-conflict{fill:rgba(220,38,38,0.12);stroke:#dc2626;stroke-width:2;vector-effect:non-scaling-stroke}`,
        `.ds-conflict-x{stroke:#dc2626;stroke-width:1.6;vector-effect:non-scaling-stroke}`,
        `.ds-unrouted{fill:none;stroke:#dc2626;stroke-width:5;stroke-dasharray:6 4;stroke-linecap:round;stroke-linejoin:round;opacity:0.55}`,
        `.ds-guide{stroke:#e0338a;stroke-width:1;stroke-dasharray:4 3;vector-effect:non-scaling-stroke;fill:none}`,
        `.ds-spacing{stroke:#e0338a;stroke-width:1.5;vector-effect:non-scaling-stroke;fill:none}`,
        `.ds-resize-handle{fill:${this.theme.background};stroke:${accent};stroke-width:1.5;vector-effect:non-scaling-stroke}`,
        `.ds-resize-handle-active{fill:${accent};stroke:${this.theme.background};stroke-width:1.5;vector-effect:non-scaling-stroke}`,
        `.ds-ghost{opacity:0.65}`,
      ].join("\n");
    this.bgRect.setAttribute("fill", this.theme.background);
    this.gridDotEl.setAttribute("fill", this.theme.grid);
    this.updateGrid();
  }

  private updateViewport(): void {
    this.viewportGroup.setAttribute("transform", `translate(${this.panX} ${this.panY}) scale(${this.zoom})`);
    this.updateGrid();
    this.repositionTextEditor();
  }

  private updateGrid(): void {
    if (!this.gridVisible) {
      this.gridRect.setAttribute("visibility", "hidden");
      return;
    }
    this.gridRect.setAttribute("visibility", "visible");

    const baseGrid = this.grid();
    let step = baseGrid;
    if (baseGrid * this.zoom < 5) {
      step = baseGrid * 5;
      if (step * this.zoom < 5) step = baseGrid * 10;
    }
    const half = step / 2;
    const dotR = clamp(1.0 / Math.pow(this.zoom, 0.7), 0.35, 3.2);

    this.gridPatternEl.setAttribute("x", String(-half));
    this.gridPatternEl.setAttribute("y", String(-half));
    this.gridPatternEl.setAttribute("width", String(step));
    this.gridPatternEl.setAttribute("height", String(step));
    this.gridDotEl.setAttribute("cx", String(half));
    this.gridDotEl.setAttribute("cy", String(half));
    this.gridDotEl.setAttribute("r", String(dotR));

    const { w, h } = this.hostSize();
    const minW = this.screenToWorld(-step, -step);
    const maxW = this.screenToWorld(w + step, h + step);
    this.gridRect.setAttribute("x", String(minW.x));
    this.gridRect.setAttribute("y", String(minW.y));
    this.gridRect.setAttribute("width", String(Math.max(1, maxW.x - minW.x)));
    this.gridRect.setAttribute("height", String(Math.max(1, maxW.y - minW.y)));
  }

  // ---- Scene & Overlay Rendering ----

  private rebuildScene(): void {
    const doc = this.store.doc;
    this.sceneGroup.innerHTML = renderScene(doc);

    // Cache bounds & world pins once per document change for fast hover / hit-testing
    this.cachedCompBounds = doc.components.map((comp) => ({
      comp,
      bounds: componentBounds(comp),
    }));
    this.cachedPins = doc.components.flatMap((comp) => worldPins(comp));

    // Render unconnected pin markers
    const unconn = getSettings().showUnconnectedPins ? unconnectedPins(doc) : [];
    // Connection conflicts: where the drawing disagrees with what is connected (the connections
    // themselves are kept — see model/links.ts). Red ring + cross at each point.
    const conflicts = this.connectionConflicts();
    this.unconnectedGroup.innerHTML =
      unconn.map((p) => `<circle class="ds-unconn-pin" cx="${p.x}" cy="${p.y}" r="2.5"/>`).join("") +
      conflicts
        .map((c) => `<g><title>${c.kind === "unintended" ? "Touching, but not connected" : c.kind === "drivers" ? "Two outputs drive this net" : "Connected, but not touching"}</title>` +
          `<circle class="ds-conflict" cx="${c.at.x}" cy="${c.at.y}" r="7"/>` +
          `<path class="ds-conflict-x" d="M${c.at.x - 3} ${c.at.y - 3}L${c.at.x + 3} ${c.at.y + 3}M${c.at.x + 3} ${c.at.y - 3}L${c.at.x - 3} ${c.at.y + 3}"/></g>`)
        .join("");

    if (!this.interaction && this.hasCursor) {
      this.updateHoverFromCursor();
      this.updateCursorStyle();
    }
    this.renderOverlay();
  }


  /** One drag frame (light) or the final drop (full repair) of a move-selection gesture. */
  private applyMoveFrame(draft: SchematicDocument, inter: Extract<Interaction, { kind: "move-selection" }>, delta: Point, light: boolean): void {
    for (const c of draft.components) {
      const orig = inter.origComponents.get(c.id);
      if (orig) {
        c.x = orig.x + delta.x;
        c.y = orig.y + delta.y;
      }
    }
    for (const w of draft.wires) {
      const origPts = inter.origWires.get(w.id);
      if (origPts) {
        w.points = origPts.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
      }
    }
    for (const t of draft.texts) {
      const orig = inter.origTexts.get(t.id);
      if (orig) {
        t.x = orig.x + delta.x;
        t.y = orig.y + delta.y;
      }
    }
    // Every other wire starts from its drag-start shape (a branch that the previous
    // frame had to follow along a chain is recomputed, not left behind).
    const kept = new Set(draft.wires.map((w) => w.id));
    for (const [id, pts0] of inter.startWires) {
      if (inter.origWires.has(id)) continue;
      const w = draft.wires.find((x) => x.id === id);
      if (w) w.points = pts0.map((p) => ({ ...p }));
      else if (!kept.has(id)) draft.wires.push({ id, points: pts0.map((p) => ({ ...p })) });
    }
    // keep the drag-start wire order (a wire restored after collapsing in an earlier
    // frame must not move to the end of the list)
    const rank = new Map([...inter.startWires.keys()].map((id, i) => [id, i]));
    draft.wires.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    for (const aw of inter.attachedWires) {
      const w = draft.wires.find((x) => x.id === aw.wireId);
      if (!w) continue;
      // Keep wire alive during intermediate drag; normalize on end
      w.points = stretchWireForMove(aw.origPoints, aw.startAttached, aw.endAttached, delta, true);
    }
    // Never let a stretched wire run over another pin/wire or through a body; keep
    // branch points fixed, following the chain only where one cannot survive.
    repairWires(draft, inter.attachedWires.map((aw) => aw.wireId), movedEndContacts(draft, inter.attachedWires), {
      improve: true,
      // drag frames: the quick repair only; the full one (other wires, re-attachment,
      // safety net) runs once on drop
      light,
      nets: inter.netsBefore,
      before: new Map(inter.attachedWires.map((aw) => [aw.wireId, aw.origPoints.map((p) => ({ ...p }))])),
    });
  }

  // ---- wires that could not be routed cleanly: warned about, and restored when possible ----
  /** Wires an edit left unclean (touching / on a part outline) — retried after every edit. */
  private unrouted = new Set<string>();
  /** Unclean wires as of the last check (anything unclean that is NOT new is the user's own). */
  private knownBad = new Set<string>();
  /** The waiting wires of each document state (restored with it by undo / redo). */
  private unroutedByDoc = new WeakMap<object, Set<string>>();
  private routeWatchQueued = false;
  private routeWatchRunning = false;
  private unroutedListeners = new Set<(added: number, total: number) => void>();

  /** Wires currently waiting for a clean route. */
  unroutedWires(): ReadonlySet<string> {
    return this.unrouted;
  }

  /** Called when the set of waiting wires changes: `added` new ones, `total` waiting. */
  onUnroutedChange(fn: (added: number, total: number) => void): () => void {
    this.unroutedListeners.add(fn);
    return () => this.unroutedListeners.delete(fn);
  }

  private scheduleRouteWatch(): void {
    if (this.routeWatchQueued || this.routeWatchRunning) return;
    this.routeWatchQueued = true;
    setTimeout(() => {
      this.routeWatchQueued = false;
      this.runRouteWatch();
    }, 0);
  }

  /**
   * After every finished edit: wires that became unclean join the waiting list (warned about);
   * every waiting wire is retried, and restored as soon as a clean route exists — as part of the
   * edit that made it possible (no extra undo step).
   */
  private runRouteWatch(): void {
    if (this.interaction || this.store.inGesture()) {
      this.scheduleRouteWatchLater();
      return;
    }
    this.routeWatchRunning = true;
    try {
      const doc = this.store.doc as SchematicDocument;
      const bad = badWireIds(doc);
      if (this.store.lastChange === "undo" || this.store.lastChange === "redo") {
        // Undo / redo restore a document exactly as it was: never "repair" history. The wires that
        // were waiting in that state are waiting again (retried after the next edit); anything
        // else unclean there is the baseline.
        const waiting = this.unroutedByDoc.get(doc) ?? new Set<string>();
        this.unrouted = new Set([...waiting].filter((id) => bad.has(id)));
        this.knownBad = new Set([...bad].filter((id) => !this.unrouted.has(id)));
        for (const fn of this.unroutedListeners) fn(0, this.unrouted.size);
        this.renderOverlay();
        return;
      }
      let added = 0;
      for (const id of bad) if (!this.knownBad.has(id) && !this.unrouted.has(id)) {
        this.unrouted.add(id);
        added++;
      }
      for (const id of [...this.unrouted]) if (!bad.has(id)) this.unrouted.delete(id);
      if (this.unrouted.size > 0) {
        let restored: string[] = [];
        this.store.amend((draft) => {
          restored = restoreWires(draft, this.unrouted);
        });
        for (const id of restored) this.unrouted.delete(id);
      }
      this.knownBad = badWireIds(this.store.doc as SchematicDocument);
      for (const id of [...this.unrouted]) if (!this.knownBad.has(id)) this.unrouted.delete(id);
      this.unroutedByDoc.set(this.store.doc, new Set(this.unrouted));
      for (const fn of this.unroutedListeners) fn(added, this.unrouted.size);
      this.renderOverlay();
    } finally {
      this.routeWatchRunning = false;
    }
  }

  private scheduleRouteWatchLater(): void {
    setTimeout(() => this.scheduleRouteWatch(), 120);
  }

  private conflictCache: { doc: unknown; list: ConnectionConflict[] } | null = null;
  /** Where the drawing disagrees with the stored connections (cached per document version). */
  connectionConflicts(): ConnectionConflict[] {
    const doc = this.store.doc;
    // Mid-drag the drawing is provisional (the full repair runs on drop): don't scan every frame.
    if (this.interaction && this.conflictCache) return this.interaction.kind === "move-selection" ? [] : this.conflictCache.list;
    if (this.conflictCache?.doc !== doc) this.conflictCache = { doc, list: connectionConflicts(doc as Parameters<typeof connectionConflicts>[0]) };
    return this.conflictCache.list;
  }

  /** True while a pointer interaction (drag, wiring, resize…) is in progress. */
  isBusy(): boolean {
    return this.interaction !== null;
  }

  private renderOverlay(): void {
    const doc = this.store.doc;
    const sel = this.store.selection;
    const parts: string[] = [];

    // 0. Wires waiting for a clean route: dashed red halo
    if (this.unrouted.size > 0 && !this.interaction) {
      for (const w of doc.wires) {
        if (!this.unrouted.has(w.id) || w.points.length < 2) continue;
        parts.push(`<polyline class="ds-unrouted" points="${w.points.map((p) => `${p.x},${p.y}`).join(" ")}"><title>No clean route yet — it will be restored automatically when there is room</title></polyline>`);
      }
    }

    // 1. Selection highlights
    if (sel.size > 0) {
      for (const { comp, bounds } of this.cachedCompBounds) {
        if (!sel.has(comp.id)) continue;
        parts.push(
          `<rect class="ds-sel-box" x="${bounds.x - 4}" y="${bounds.y - 4}" width="${bounds.w + 8}" height="${bounds.h + 8}" rx="3"/>`,
        );
      }
      for (const w of doc.wires) {
        if (!sel.has(w.id) || w.points.length < 2) continue;
        const d = w.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
        parts.push(`<path class="ds-sel-wire-halo" d="${d}"/>`);
        parts.push(`<path class="ds-sel-wire-core" d="${d}"/>`);
      }
      for (const t of doc.texts) {
        if (!sel.has(t.id)) continue;
        const b = textBounds(t);
        parts.push(
          `<rect class="ds-sel-box" x="${b.x - 3}" y="${b.y - 3}" width="${b.w + 6}" height="${b.h + 6}" rx="2"/>`,
        );
      }
    }

    // 1b. Resize handles when exactly ONE resizable component is selected (in select tool)
    if (this.tool === "select" && !this.placing && !this.dragDropGhostType && !this.wireDraft) {
      const resizableComp = this.singleSelectedResizable();
      if (resizableComp) {
        const handles = resizeHandles(resizableComp);
        const hs = clamp(4 / this.zoom, 2.5, 6);
        const activeHandleId =
          this.interaction?.kind === "resize-component" && this.interaction.compId === resizableComp.id
            ? this.interaction.handle
            : this.hover?.kind === "resize-handle" && this.hover.compId === resizableComp.id
              ? this.hover.handle
              : null;
        for (const h of handles) {
          const cls = h.id === activeHandleId ? "ds-resize-handle ds-resize-handle-active" : "ds-resize-handle";
          parts.push(
            `<rect class="${cls}" data-handle="${h.id}" x="${h.pos.x - hs}" y="${h.pos.y - hs}" width="${hs * 2}" height="${hs * 2}" rx="1"/>`,
          );
        }
      }
    }

    // 2. Hover highlights (when not in a blocking drag)
    if (this.hover && (!this.interaction || this.interaction.kind === "pin-wire-drag")) {
      if (this.hover.kind === "component" && !sel.has(this.hover.id)) {
        const hoverId = this.hover.id;
        const entry = this.cachedCompBounds.find((e) => e.comp.id === hoverId);
        if (entry) {
          const b = entry.bounds;
          parts.push(
            `<rect class="ds-hover-box" x="${b.x - 4}" y="${b.y - 4}" width="${b.w + 8}" height="${b.h + 8}" rx="3"/>`,
          );
        }
      } else if (this.hover.kind === "wire" && !sel.has(this.hover.id)) {
        const w = doc.wires.find((x) => x.id === (this.hover as { kind: "wire"; id: string }).id);
        if (w && w.points.length >= 2) {
          const d = w.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
          parts.push(`<path class="ds-hover-wire" d="${d}"/>`);
        }
      } else if (this.hover.kind === "text" && !sel.has(this.hover.id)) {
        const t = doc.texts.find((x) => x.id === (this.hover as { kind: "text"; id: string }).id);
        if (t) {
          const b = textBounds(t);
          parts.push(
            `<rect class="ds-hover-box" x="${b.x - 3}" y="${b.y - 3}" width="${b.w + 6}" height="${b.h + 6}" rx="2"/>`,
          );
        }
      } else if (this.hover.kind === "pin") {
        const wp = this.hover.pin;
        const r = clamp(5 / this.zoom, 3.5, 8);
        parts.push(`<circle class="ds-pin-target" cx="${wp.pos.x}" cy="${wp.pos.y}" r="${r}"/>`);
        const pinLabel = wp.pin.width && wp.pin.width > 1 ? `${wp.pin.name}[${wp.pin.width}]` : wp.pin.name;
        if (pinLabel) {
          const tx = wp.pos.x + 8;
          const ty = wp.pos.y - 8;
          const tw = Math.max(18, pinLabel.length * 6.5 + 8);
          parts.push(
            `<rect class="ds-pin-tag-bg" x="${tx - 3}" y="${ty - 11}" width="${tw}" height="15" rx="3"/>` +
              `<text class="ds-pin-tag-text" x="${tx + 1}" y="${ty}">${escapeXml(pinLabel)}</text>`,
          );
        }
      } else if (this.hover.kind === "wire-snap") {
        const pos = this.hover.pos;
        const r = clamp(4.5 / this.zoom, 3, 7);
        parts.push(`<circle class="ds-pin-target" cx="${pos.x}" cy="${pos.y}" r="${r}"/>`);
      }
    }

    // 2b. Smart guides while moving (alignment lines + equal-spacing bars)
    if (this.interaction?.kind === "move-selection" && this.interaction.guides) {
      const g = this.interaction.guides;
      const tick = 4 / Math.max(this.zoom, 0.25);
      for (const l of g.lines) {
        parts.push(`<line class="ds-guide" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}"/>`);
      }
      for (const b of g.spacings) {
        const horiz = b.y1 === b.y2;
        const t1 = horiz ? `M${b.x1} ${b.y1 - tick} V${b.y1 + tick}` : `M${b.x1 - tick} ${b.y1} H${b.x1 + tick}`;
        const t2 = horiz ? `M${b.x2} ${b.y2 - tick} V${b.y2 + tick}` : `M${b.x2 - tick} ${b.y2} H${b.x2 + tick}`;
        parts.push(`<path class="ds-spacing" d="M${b.x1} ${b.y1} L${b.x2} ${b.y2} ${t1} ${t2}"/>`);
      }
    }

    // 3. Wire draft preview
    if (this.wireDraft && this.wireDraft.points.length > 0) {
      const target = this.currentWireTargetPoint();
      const previewPts = this.routeDraftTo(target);
      if (previewPts.length >= 2) {
        const d = previewPts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
        parts.push(`<path class="ds-wire-preview" d="${d}"/>`);
      }
      for (const p of this.wireDraft.points) {
        parts.push(`<circle class="ds-wire-dot" cx="${p.x}" cy="${p.y}" r="2.8"/>`);
      }
    }

    // 4. Placement ghost (click-to-place or palette drag-over)
    const ghostType = this.placing?.type ?? this.dragDropGhostType;
    if (ghostType && this.hasCursor) {
      const def = getDef(ghostType);
      if (def) {
        const rot: Rotation = this.placing?.rotation ?? 0;
        const mir = this.placing?.mirror ?? false;
        const origin = centeredOriginForPlacement(ghostType, rot, mir, this.cursorWorldExact, this.grid());
        const ghostInst: ComponentInstance = {
          id: "__ghost__",
          type: ghostType,
          x: origin.x,
          y: origin.y,
          rotation: rot,
          mirror: mir || undefined,
          props: { ...def.defaultProps },
        };
        const gb = componentBounds(ghostInst);
        parts.push(`<g class="ds-ghost">${renderComponent(ghostInst)}</g>`);
        parts.push(
          `<rect class="ds-hover-box" x="${gb.x - 3}" y="${gb.y - 3}" width="${gb.w + 6}" height="${gb.h + 6}" rx="3"/>`,
        );
      }
    }

    // 5. Rubber-band marquee box
    if (this.interaction && this.interaction.kind === "marquee") {
      const a = this.interaction.startWorld;
      const b = this.interaction.currentWorld;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      parts.push(`<rect class="ds-marquee" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
    }

    this.overlayGroup.innerHTML = parts.join("");
  }

  private currentWireSnapTarget(): SnapTarget | null {
    return findSnapTarget(this.store.doc, this.cursorWorldExact, this.pinToleranceWorld(), this.cachedPins);
  }

  /** Exit vector of the pin under a snap target (null for wire junctions / free points). */
  private snapExit(t: SnapTarget | null): Point | null {
    if (!t || t.kind !== "pin") return null;
    const comp = this.store.doc.components.find((c) => c.id === t.pin.componentId);
    return comp ? pinExitVector(comp, t.pin.pin.side) : null;
  }

  /** Pin-aware route from the draft's committed points to `target`. */
  private routeDraftTo(target: Point, snapTarget: SnapTarget | null = this.currentWireSnapTarget()): Point[] {
    const draft = this.wireDraft!;
    const pts = draft.points;
    if (pts.length === 0) return [{ ...target }];
    const last = pts[pts.length - 1];
    const fromExit = pts.length === 1 ? (draft.startExit ?? null) : null;
    const toExit = snapTarget && pointsEqual(snapTarget.pos, target) ? this.snapExit(snapTarget) : null;
    let leg: Point[];
    if (!fromExit && !toExit) {
      leg = buildWirePreview([last], target, draft.horizontalFirst);
    } else {
      leg = routePinAware(last, fromExit, target, toExit, !!draft.flipped, this.store.doc.grid || 10);
    }
    // If the simple route would touch a pin/wire it isn't meant to, or cut through a
    // component, search for a clean one (only when the draft ends on a real target, so
    // free-space drafting stays predictable).
    if (snapTarget && leg.length >= 2) {
      const obs = this.routeObstacles();
      // The new wire is meant to join whatever nets it starts and ends on: those wires are
      // fine to touch (e.g. a second wire leaving an already-wired pin).
      const sameNet = netWiresAt(this.store.doc as Parameters<typeof normalizeDocWires>[0], [pts[0], target]);
      if (obs.routeIsBad(leg, sameNet)) {
        const safe = safeRoute(obs, last, target, { fromExit, toExit, prefer: leg, sameNet });
        if (safe) leg = safe;
      }
    }
    return normalizeWirePoints([...pts, ...leg.slice(1)]);
  }

  private obstacleCache: { doc: unknown; obs: RouteObstacles } | null = null;
  /** Route obstacles for the current document (cached until the document changes). */
  private routeObstacles(): RouteObstacles {
    const doc = this.store.doc;
    if (!this.obstacleCache || this.obstacleCache.doc !== doc) {
      this.obstacleCache = { doc, obs: new RouteObstacles(doc as Parameters<typeof normalizeDocWires>[0]) };
    }
    return this.obstacleCache.obs;
  }

  private currentWireTargetPoint(): Point {
    const snapTarget = this.currentWireSnapTarget();
    return snapTarget ? snapTarget.pos : this.cursorWorldSnapped;
  }

  private updateHoverFromCursor(): void {
    if (this.placing || this.dragDropGhostType || this.spaceDown || this.tool === "pan") {
      this.hover = null;
      return;
    }

    if (this.tool === "wire" || this.wireDraft !== null) {
      const snapTarget = this.currentWireSnapTarget();
      if (snapTarget?.kind === "pin") {
        this.hover = { kind: "pin", pin: snapTarget.pin };
      } else if (snapTarget?.kind === "wire") {
        this.hover = { kind: "wire-snap", pos: snapTarget.pos };
      } else {
        this.hover = null;
      }
      return;
    }

    if (this.tool === "select") {
      const resizableComp = this.singleSelectedResizable();
      if (resizableComp) {
        const handle = hitTestResizeHandle(resizableComp, this.cursorWorldExact, this.handleToleranceWorld());
        if (handle) {
          this.hover = {
            kind: "resize-handle",
            compId: resizableComp.id,
            handle: handle.id,
            cursor: handle.cursor,
          };
          return;
        }
      }
      const pin = findPinAt(this.store.doc, this.cursorWorldExact, this.pinToleranceWorld(), this.cachedPins);
      if (pin) {
        this.hover = { kind: "pin", pin };
        return;
      }
      const hit = hitTestDocument(
        this.store.doc,
        this.cursorWorldExact,
        this.wireToleranceWorld(),
        this.cachedCompBounds,
      );
      if (!hit) {
        this.hover = null;
      } else if (hit.kind === "component") {
        this.hover = { kind: "component", id: hit.id };
      } else if (hit.kind === "wire") {
        this.hover = { kind: "wire", id: hit.id, segIndex: hit.segmentIndex };
      } else {
        this.hover = { kind: "text", id: hit.id };
      }
      return;
    }

    this.hover = null;
  }

  private updateCursorStyle(): void {
    if (this.interaction?.kind === "pan") {
      this.svg.style.cursor = "grabbing";
      return;
    }
    if (this.spaceDown || this.tool === "pan") {
      this.svg.style.cursor = "grab";
      return;
    }
    if (this.interaction?.kind === "resize-component") {
      this.svg.style.cursor = this.interaction.cursor;
      return;
    }
    if (this.interaction?.kind === "drag-wire-segment") {
      this.svg.style.cursor = this.interaction.isHorizontal ? "ns-resize" : "ew-resize";
      return;
    }
    if (this.placing || this.tool === "wire" || this.tool === "text" || this.wireDraft) {
      this.svg.style.cursor = "crosshair";
      return;
    }
    if (this.hover?.kind === "resize-handle") {
      this.svg.style.cursor = this.hover.cursor;
      return;
    }
    if (this.hover?.kind === "pin") {
      this.svg.style.cursor = "crosshair";
      return;
    }
    if (this.hover?.kind === "wire" && this.store.selection.size === 1 && this.store.isSelected(this.hover.id)) {
      const w = this.store.doc.wires.find((x) => x.id === (this.hover as { kind: "wire"; id: string }).id);
      if (w && this.hover.segIndex + 1 < w.points.length) {
        const a = w.points[this.hover.segIndex];
        const b = w.points[this.hover.segIndex + 1];
        this.svg.style.cursor = a.y === b.y ? "ns-resize" : "ew-resize";
        return;
      }
    }
    if (this.hover?.kind === "component" || this.hover?.kind === "text") {
      this.svg.style.cursor = "move";
      return;
    }
    this.svg.style.cursor = "default";
  }

  // ---- Event Wiring ----

  private installEvents(): void {
    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.svg.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
    this.svg.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    this.svg.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener("contextmenu", (e) => {
      if (this.placing || this.wireDraft) {
        e.preventDefault();
        this.placing = null;
        this.wireDraft = null;
        this.updateCursorStyle();
        this.renderOverlay();
        this.emitState();
      }
    });
    // Prevent browser middle-click autoscroll
    this.svg.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.svg.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault();
    });

    // HTML5 drag & drop from palette
    this.svg.addEventListener("dragover", (e) => this.onDragOver(e));
    this.svg.addEventListener("dragleave", () => this.onDragLeave());
    this.svg.addEventListener("drop", (e) => this.onDrop(e));

    // Global keyboard shortcuts (never capture when focus is in an editable element)
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    window.addEventListener("blur", () => {
      if (this.spaceDown) {
        this.spaceDown = false;
        this.updateCursorStyle();
        this.emitState();
      }
    });

    // Keep grid covering visible viewport when container resizes
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.updateGrid());
      ro.observe(this.host);
    }
  }

  private updateCursorFromClient(clientX: number, clientY: number): boolean {
    const exact = this.clientToWorld(clientX, clientY);
    const snapped = snapToGrid(exact, this.grid());
    const changed = !this.hasCursor || !pointsEqual(snapped, this.cursorWorldSnapped);
    this.cursorWorldExact = exact;
    this.cursorWorldSnapped = snapped;
    this.hasCursor = true;
    return changed;
  }

  private onPointerDown(e: PointerEvent): void {
    // Ignore non-primary/non-middle buttons
    if (e.button !== 0 && e.button !== 1) return;

    const wasEditingText = this.activeTextEditor !== null;
    this.closeTextEditor(true);
    this.svg.focus({ preventScroll: true });
    this.updateCursorFromClient(e.clientX, e.clientY);
    // In the Text tool, a click while a note is being edited just finishes that note.
    if (wasEditingText && this.tool === "text" && e.button === 0) {
      e.preventDefault();
      return;
    }

    // 1. Pan: middle-drag, space+drag, or pan tool (a pending placement wins over the pan tool)
    if (e.button === 1 || this.spaceDown || (this.tool === "pan" && !this.placing)) {
      e.preventDefault();
      this.interaction = {
        kind: "pan",
        startClient: { x: e.clientX, y: e.clientY },
        startPan: { x: this.panX, y: this.panY },
        pointerId: e.pointerId,
      };
      this.capturePointer(e.pointerId);
      this.updateCursorStyle();
      return;
    }

    // 2. Placement mode
    if (this.placing) {
      e.preventDefault();
      const origin = centeredOriginForPlacement(
        this.placing.type,
        this.placing.rotation,
        this.placing.mirror,
        this.cursorWorldExact,
        this.grid(),
      );
      placeComponentInStore(
        this.store,
        this.placing.type,
        origin.x,
        origin.y,
        this.placing.rotation,
        this.placing.mirror,
      );
      if (!e.shiftKey) {
        this.placing = null;
      }
      this.updateHoverFromCursor();
      this.updateCursorStyle();
      this.renderOverlay();
      this.emitState();
      return;
    }

    // 3. Text tool
    if (this.tool === "text") {
      e.preventDefault();
      const noteId = newId("t");
      const pos = { ...this.cursorWorldSnapped };
      this.store.beginGesture(); // closed by the inline editor (commit = end, cancel = cancel)
      this.store.update("Add text note", (draft) => {
        draft.texts.push({ id: noteId, x: pos.x, y: pos.y, text: "Text", fontSize: 14 });
      });
      this.store.setSelection([noteId]);
      const created = this.store.doc.texts.find((t) => t.id === noteId);
      if (created) this.openTextEditor(created, true);
      return;
    }

    // 4. Wire tool
    if (this.tool === "wire") {
      e.preventDefault();
      const now = performance.now();
      const prev = this.lastWireClick;
      const isDouble = !!prev && now - prev.t < 400 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6;
      this.lastWireClick = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
      this.handleWireToolClick(isDouble);
      return;
    }

    // 5. Select tool
    this.handleSelectPointerDown(e);
  }

  private handleWireToolClick(isDoubleClick: boolean): void {
    const snapTarget = this.currentWireSnapTarget();
    const targetPt = snapTarget ? snapTarget.pos : this.cursorWorldSnapped;

    if (!this.wireDraft) {
      if (isDoubleClick) return;
      let horizFirst = true;
      if (snapTarget?.kind === "pin") {
        const comp = this.store.doc.components.find((c) => c.id === snapTarget.pin.componentId);
        if (comp) horizFirst = pinExitHorizontal(comp, snapTarget.pin.pin.side);
      }
      this.wireDraft = { points: [{ ...targetPt }], horizontalFirst: horizFirst, startExit: this.snapExit(snapTarget) };
      this.renderOverlay();
      this.emitState();
      return;
    }

    const last = this.wireDraft.points[this.wireDraft.points.length - 1];
    const nextPts = this.routeDraftTo(targetPt, snapTarget);

    // Double-click or clicking on the same last point finishes the wire
    if (isDoubleClick || pointsEqual(targetPt, last)) {
      this.commitWireDraft(nextPts);
      return;
    }

    // Clicking on a pin or existing wire (T-junction) finishes the wire
    if (snapTarget && nextPts.length >= 2) {
      this.commitWireDraft(nextPts);
      return;
    }

    // Otherwise commit the L-shaped segment bends and keep routing
    this.wireDraft.points = nextPts;
    this.renderOverlay();
    this.emitState();
  }

  private commitWireDraft(points: Point[]): void {
    let norm = normalizeWirePoints(points);
    this.wireDraft = null;
    if (norm.length >= 2) {
      // Split the connection at its best branch points: if the new wire starts/ends by running
      // along wires of the net it joins, trim that shared stretch so it branches off with a
      // T-junction instead of hiding on top of the existing wire.
      const doc = this.store.doc as Parameters<typeof normalizeDocWires>[0];
      const netIds = netWiresAt(doc, [norm[0], norm[norm.length - 1]]);
      const netWires = doc.wires.filter((w) => netIds.has(w.id));
      norm = normalizeWirePoints(trimToBranchPoints(norm, netWires));
    }
    if (norm.length >= 2) {
      const wireId = newId("w");
      this.store.update("Add wire", (draft) => {
        draft.wires.push({ id: wireId, points: norm });
        normalizeDocWires(draft);
      });
    }
    this.updateHoverFromCursor();
    this.updateCursorStyle();
    this.renderOverlay();
    this.emitState();
  }

  private handleSelectPointerDown(e: PointerEvent): void {
    const toggleMod = e.shiftKey || e.ctrlKey || e.metaKey;

    // Resize handle on the single selected resizable component takes priority
    if (!toggleMod) {
      const resizableComp = this.singleSelectedResizable();
      if (resizableComp) {
        const handle = hitTestResizeHandle(resizableComp, this.cursorWorldExact, this.handleToleranceWorld());
        if (handle) {
          e.preventDefault();
          this.store.beginGesture();
          this.interaction = {
            kind: "resize-component",
            compId: resizableComp.id,
            handle: handle.id,
            cursor: handle.cursor,
            startWorldExact: { ...this.cursorWorldExact },
            origComp: structuredClone(resizableComp),
            origWires: structuredClone(this.store.doc.wires),
            lastResult: null,
            moved: false,
            pointerId: e.pointerId,
          };
          this.capturePointer(e.pointerId);
          this.updateCursorStyle();
          this.renderOverlay();
          this.emitState();
          return;
        }
      }
    }

    // Dragging from any pin in select mode starts a wire (unless modifier held for selection toggle)
    if (!toggleMod) {
      let pin = findPinAt(this.store.doc, this.cursorWorldExact, this.pinToleranceWorld(), this.cachedPins);
      if (pin) {
        // A click on a short wire between two pins would otherwise always grab a pin:
        // prefer the wire when the cursor is on it and not right at the pin tip.
        const dPin = Math.hypot(this.cursorWorldExact.x - pin.pos.x, this.cursorWorldExact.y - pin.pos.y);
        const wireHit = hitTestWire(this.store.doc, this.cursorWorldExact, this.wireToleranceWorld());
        if (wireHit && dPin > Math.min(3, this.pinToleranceWorld() / 2)) pin = null;
      }
      if (pin) {
        e.preventDefault();
        this.interaction = {
          kind: "pending-pin-wire",
          pin,
          startClient: { x: e.clientX, y: e.clientY },
          pointerId: e.pointerId,
        };
        this.capturePointer(e.pointerId);
        return;
      }
    }

    const hit = hitTestDocument(
      this.store.doc,
      this.cursorWorldExact,
      this.wireToleranceWorld(),
      this.cachedCompBounds,
    );

    if (!hit) {
      // Empty space -> marquee rubber-band selection
      const initialSelection = new Set(this.store.selection);
      if (!toggleMod && this.store.selection.size > 0) {
        this.store.setSelection([]);
      }
      this.interaction = {
        kind: "marquee",
        startWorld: { ...this.cursorWorldExact },
        currentWorld: { ...this.cursorWorldExact },
        additive: toggleMod,
        initialSelection,
        pointerId: e.pointerId,
      };
      this.capturePointer(e.pointerId);
      this.renderOverlay();
      return;
    }

    // Toggle selection with Shift/Ctrl
    if (toggleMod) {
      const next = new Set(this.store.selection);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.add(hit.id);
      this.store.setSelection(next);
      return;
    }

    // Determine selection before starting drag
    let narrowToIdOnClick: string | null = null;
    if (!this.store.isSelected(hit.id)) {
      this.store.setSelection([hit.id]);
    } else if (this.store.selection.size > 1) {
      narrowToIdOnClick = hit.id;
    }

    // Single selected wire -> drag that segment perpendicular to itself
    if (hit.kind === "wire" && this.store.selection.size === 1) {
      const w = hit.wire;
      const a = w.points[hit.segmentIndex];
      const b = w.points[hit.segmentIndex + 1];
      if (a && b && (a.y === b.y || a.x === b.x)) {
        const startAnchored = isPointAnchored(this.store.doc, w.points[0], w.id);
        const endAnchored = isPointAnchored(this.store.doc, w.points[w.points.length - 1], w.id);
        // wires joined to this segment follow it — except at an anchored end, which stays put
        const p0 = w.points[0], pn = w.points[w.points.length - 1];
        const branches = segmentBranches(this.store.doc as SchematicDocument, w.id, a, b).filter((br) => {
          const e = br.atStart ? br.origPoints[0] : br.origPoints[br.origPoints.length - 1];
          return !((startAnchored && pointsEqual(e, p0)) || (endAnchored && pointsEqual(e, pn)));
        });
        this.store.beginGesture();
        this.interaction = {
          kind: "drag-wire-segment",
          netsBefore: sameNetWires(this.store.doc),
          branches,
          wireId: w.id,
          segIndex: hit.segmentIndex,
          origPoints: w.points.map((p) => ({ ...p })),
          isHorizontal: a.y === b.y,
          startAnchored,
          endAnchored,
          startWorldSnapped: { ...this.cursorWorldSnapped },
          lastDelta: { x: 0, y: 0 },
          moved: false,
          pointerId: e.pointerId,
        };
        this.capturePointer(e.pointerId);
        this.updateCursorStyle();
        return;
      }
    }

    // Begin moving the current selection
    const sel = this.store.selection;
    const origComponents = new Map<string, Point>();
    const origWires = new Map<string, Point[]>();
    const origTexts = new Map<string, Point>();
    const movedCompIds = new Set<string>();
    const selWireIds = new Set<string>();

    for (const c of this.store.doc.components) {
      if (sel.has(c.id)) {
        origComponents.set(c.id, { x: c.x, y: c.y });
        movedCompIds.add(c.id);
      }
    }
    for (const w of this.store.doc.wires) {
      if (sel.has(w.id)) {
        origWires.set(w.id, w.points.map((p) => ({ ...p })));
        selWireIds.add(w.id);
      }
    }
    for (const t of this.store.doc.texts) {
      if (sel.has(t.id)) {
        origTexts.set(t.id, { x: t.x, y: t.y });
      }
    }

    const attachedWires = captureAttachedWires(this.store.doc, movedCompIds, selWireIds);

    // Smart guides follow the component that was grabbed (or the only selected one).
    let guide: { anchorOrig: Rect; peers: Rect[] } | null = null;
    if (getSettings().showGuides) {
      const selComps = this.store.doc.components.filter((c) => movedCompIds.has(c.id));
      const grabbed =
        selComps.find((c) => pointInRect(this.cursorWorldExact, componentBounds(c))) ??
        (selComps.length === 1 ? selComps[0] : undefined);
      if (grabbed) {
        const peers = guidePeers(this.store.doc, grabbed, movedCompIds);
        if (peers.length > 0) guide = { anchorOrig: componentBounds(grabbed), peers };
      }
    }

    this.store.beginGesture();
    this.interaction = {
      kind: "move-selection",
      netsBefore: sameNetWires(this.store.doc),
      startWires: new Map(this.store.doc.wires.map((w) => [w.id, w.points.map((p) => ({ ...p }))])),
      guide,
      guides: null,
      startWorldSnapped: { ...this.cursorWorldSnapped },
      lastDelta: { x: 0, y: 0 },
      origComponents,
      origWires,
      origTexts,
      attachedWires,
      moved: false,
      narrowToIdOnClick,
      pointerId: e.pointerId,
    };
    this.capturePointer(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const snappedChanged = this.updateCursorFromClient(e.clientX, e.clientY);

    if (this.interaction) {
      switch (this.interaction.kind) {
        case "pan": {
          const dx = e.clientX - this.interaction.startClient.x;
          const dy = e.clientY - this.interaction.startClient.y;
          this.panX = this.interaction.startPan.x + dx;
          this.panY = this.interaction.startPan.y + dy;
          this.updateViewport();
          return;
        }
        case "marquee": {
          this.interaction.currentWorld = { ...this.cursorWorldExact };
          const a = this.interaction.startWorld;
          const b = this.interaction.currentWorld;
          const rect: Rect = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.abs(b.x - a.x),
            h: Math.abs(b.y - a.y),
          };
          const inBox = itemsInRect(this.store.doc, rect, this.cachedCompBounds);
          const nextSel = this.interaction.additive
            ? new Set([...this.interaction.initialSelection, ...inBox])
            : new Set(inBox);
          if (!setsEqual(nextSel, this.store.selection)) {
            this.store.setSelection(nextSel);
          }
          this.renderOverlay();
          if (snappedChanged) this.emitState();
          return;
        }
        case "move-selection": {
          const delta: Point = {
            x: this.cursorWorldSnapped.x - this.interaction.startWorldSnapped.x,
            y: this.cursorWorldSnapped.y - this.interaction.startWorldSnapped.y,
          };
          // Back on the exact start: never snap it away from there (guides would pull it onto a
          // nearby peer's line, so dropping a part where it came from would still move it).
          if (this.interaction.guide && !(delta.x === 0 && delta.y === 0)) {
            const st = getSettings();
            const snapDist = st.snapToGuides ? st.guideSnapCells * this.grid() : 0;
            const g = computeGuides(this.interaction.guide.anchorOrig, this.interaction.guide.peers, delta, snapDist);
            delta.x += g.adjust.x;
            delta.y += g.adjust.y;
            const changed = JSON.stringify(g) !== JSON.stringify(this.interaction.guides);
            this.interaction.guides = g;
            if (changed && pointsEqual(delta, this.interaction.lastDelta)) this.renderOverlay();
          } else if (this.interaction.guides) {
            this.interaction.guides = null;
            if (pointsEqual(delta, this.interaction.lastDelta)) this.renderOverlay();
          }
          if (!pointsEqual(delta, this.interaction.lastDelta)) {
            this.interaction.lastDelta = delta;
            this.interaction.moved = true;
            const inter = this.interaction;
            this.store.update("Move", (draft) => this.applyMoveFrame(draft, inter, delta, true));
          }
          if (snappedChanged) this.emitState();
          return;
        }
        case "drag-wire-segment": {
          const delta: Point = {
            x: this.cursorWorldSnapped.x - this.interaction.startWorldSnapped.x,
            y: this.cursorWorldSnapped.y - this.interaction.startWorldSnapped.y,
          };
          const effDelta: Point = this.interaction.isHorizontal ? { x: 0, y: delta.y } : { x: delta.x, y: 0 };
          if (!pointsEqual(effDelta, this.interaction.lastDelta)) {
            this.interaction.lastDelta = effDelta;
            this.interaction.moved = true;
            const inter = this.interaction;
            this.store.update("Move wire segment", (draft) => {
              const w = draft.wires.find((x) => x.id === inter.wireId);
              if (!w) return;
              w.points = dragWireSegmentPoints(
                inter.origPoints,
                inter.segIndex,
                effDelta,
                inter.startAnchored,
                inter.endAnchored,
                true,
              );
              followSegmentBranches(draft, inter.branches, effDelta);
            });
          }
          if (snappedChanged) this.emitState();
          return;
        }
        case "resize-component": {
          const worldDelta: Point = {
            x: this.cursorWorldExact.x - this.interaction.startWorldExact.x,
            y: this.cursorWorldExact.y - this.interaction.startWorldExact.y,
          };
          const grid = this.grid();
          if (
            !this.interaction.moved &&
            !hasSnappedResizeDelta(this.interaction.origComp, this.interaction.handle, worldDelta, grid)
          ) {
            if (snappedChanged) this.emitState();
            return;
          }
          const next = applyResizeDrag(
            this.interaction.origComp,
            this.interaction.handle,
            worldDelta,
            grid,
          );
          if (!this.interaction.moved && !this.interaction.origComp.size) {
            const orig = this.interaction.origComp;
            const origGeom = geometryOf(orig);
            const nextGeom = geometryOf({ ...orig, size: next.size });
            if (
              next.x === orig.x &&
              next.y === orig.y &&
              nextGeom.width === origGeom.width &&
              nextGeom.height === origGeom.height
            ) {
              if (snappedChanged) this.emitState();
              return;
            }
          }
          const prev = this.interaction.lastResult;
          if (
            !prev ||
            prev.x !== next.x ||
            prev.y !== next.y ||
            prev.size.w !== next.size.w ||
            prev.size.h !== next.size.h
          ) {
            this.interaction.lastResult = next;
            this.interaction.moved = true;
            const inter = this.interaction;
            this.store.update("Resize", (draft) => {
              const idx = draft.components.findIndex((c) => c.id === inter.compId);
              if (idx === -1) return;
              // Restore pre-drag component & wires before applying keepWiresAttached so
              // repeated drag ticks always route cleanly from the original geometry.
              draft.components[idx] = structuredClone(inter.origComp);
              draft.wires = structuredClone(inter.origWires);
              keepWiresAttached(draft, new Set([inter.compId]), () => {
                const c = draft.components[idx];
                c.x = next.x;
                c.y = next.y;
                c.size = { ...next.size };
              });
            });
            this.emitState();
          } else if (snappedChanged) {
            this.emitState();
          }
          return;
        }
        case "pending-pin-wire": {
          const distPx = Math.hypot(
            e.clientX - this.interaction.startClient.x,
            e.clientY - this.interaction.startClient.y,
          );
          if (distPx >= 4) {
            const pin = this.interaction.pin;
            const comp = this.store.doc.components.find((c) => c.id === pin.componentId);
            const horizFirst = comp ? pinExitHorizontal(comp, pin.pin.side) : true;
            this.wireDraft = {
              points: [{ ...pin.pos }],
              horizontalFirst: horizFirst,
              startExit: comp ? pinExitVector(comp, pin.pin.side) : null,
            };
            this.interaction = {
              kind: "pin-wire-drag",
              startPin: pin,
              pointerId: this.interaction.pointerId,
            };
            this.updateHoverFromCursor();
            this.updateCursorStyle();
            this.renderOverlay();
            this.emitState();
          }
          return;
        }
        case "pin-wire-drag": {
          this.updateHoverFromCursor();
          this.renderOverlay();
          if (snappedChanged) this.emitState();
          return;
        }
      }
    }

    // No active pointer drag: update hover + overlay (placement ghost, wire preview, pin highlight)
    this.updateHoverFromCursor();
    this.updateCursorStyle();
    this.renderOverlay();
    if (snappedChanged) this.emitState();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.interaction) return;
    const inter = this.interaction;
    this.interaction = null;
    this.releasePointer(e.pointerId);

    switch (inter.kind) {
      case "pan":
        break;
      case "marquee":
        break;
      case "move-selection":
        if (inter.moved) {
          // The drop: redo the last frame with the FULL repair (wires the part landed on are
          // re-routed, broken connections re-attached, safety net) — still one undo step.
          if (inter.attachedWires.length > 0) {
            this.store.update("Move", (draft) => {
              this.applyMoveFrame(draft, inter, inter.lastDelta, false);
              normalizeDocWires(draft);
            });
          }
        } else if (inter.narrowToIdOnClick) {
          this.store.setSelection([inter.narrowToIdOnClick]);
        }
        this.store.endGesture();
        break;
      case "drag-wire-segment":
        if (inter.moved) {
          this.store.update("Move wire segment", (draft) => {
            repairSegmentDrop(draft, inter.wireId, inter.branches, inter.netsBefore);
            normalizeDocWires(draft);
          });
        }
        this.store.endGesture();
        break;
      case "resize-component":
        if (inter.moved) {
          this.store.update("Resize", (draft) => normalizeDocWires(draft));
        }
        this.store.endGesture();
        break;
      case "pending-pin-wire":
        // User clicked a pin without dragging: select the owning component
        this.store.setSelection([inter.pin.componentId]);
        break;
      case "pin-wire-drag": {
        this.updateCursorFromClient(e.clientX, e.clientY);
        if (this.wireDraft) {
          const target = this.currentWireTargetPoint();
          const pts = this.routeDraftTo(target);
          this.commitWireDraft(pts);
        }
        break;
      }
    }

    this.updateHoverFromCursor();
    this.updateCursorStyle();
    this.renderOverlay();
    this.emitState();
  }

  private onPointerCancel(e: PointerEvent): void {
    if (!this.interaction) return;
    const inter = this.interaction;
    this.interaction = null;
    this.releasePointer(e.pointerId);

    if (
      inter.kind === "move-selection" ||
      inter.kind === "drag-wire-segment" ||
      inter.kind === "resize-component"
    ) {
      this.store.cancelGesture();
    } else if (inter.kind === "pin-wire-drag") {
      this.wireDraft = null;
    }
    this.updateHoverFromCursor();
    this.updateCursorStyle();
    this.renderOverlay();
    this.emitState();
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.tool !== "select" || this.placing || this.wireDraft) return;
    this.updateCursorFromClient(e.clientX, e.clientY);
    const resizableComp = this.singleSelectedResizable();
    if (resizableComp && hitTestResizeHandle(resizableComp, this.cursorWorldExact, this.handleToleranceWorld())) {
      return;
    }
    const hit = hitTestDocument(
      this.store.doc,
      this.cursorWorldExact,
      this.wireToleranceWorld(),
      this.cachedCompBounds,
    );
    if (!hit) return;

    if (hit.kind === "text") {
      e.preventDefault();
      this.store.setSelection([hit.id]);
      this.openTextEditor(hit.text, false);
    } else if (hit.kind === "component") {
      e.preventDefault();
      this.store.setSelection([hit.id]);
      window.dispatchEvent(new CustomEvent(FOCUS_LABEL_EVENT, { detail: { id: hit.id } }));
    }
  }

  /**
   * Wheel bindings (standard for design tools):
   *  - Ctrl+wheel, or a touchpad pinch (reported as a ctrl+wheel event) → zoom around cursor
   *  - wheel → pan vertically;  Shift+wheel or horizontal wheel/touchpad swipe → pan horizontally
   */
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 200 : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      const s = this.clientToScreen(e.clientX, e.clientY);
      // Pinch gestures send many small deltas; mouse wheels send ~100 per notch.
      const k = e.deltaMode === 0 && Math.abs(dy) < 50 ? 0.01 : 0.0018;
      const factor = Math.exp(-clamp(dy, -240, 240) * k);
      this.zoomAtScreenPoint(s.x, s.y, factor);
      return;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.panX -= dx;
    this.panY -= dy;
    this.updateViewport();
    this.updateCursorFromClient(e.clientX, e.clientY);
    this.renderOverlay();
    this.emitState();
  }

  // ---- HTML5 Drag & Drop from Palette ----

  private onDragOver(e: DragEvent): void {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes(DRAG_TYPE_MIME)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    this.dragDropGhostType = getDraggedPaletteType();
    const changed = this.updateCursorFromClient(e.clientX, e.clientY);
    this.renderOverlay();
    if (changed) this.emitState();
  }

  private onDragLeave(): void {
    if (this.dragDropGhostType) {
      this.dragDropGhostType = null;
      this.renderOverlay();
    }
  }

  private onDrop(e: DragEvent): void {
    const type = e.dataTransfer?.getData(DRAG_TYPE_MIME) || getDraggedPaletteType();
    this.dragDropGhostType = null;
    setDraggedPaletteType(null);
    if (!type || !getDef(type)) return;
    e.preventDefault();
    this.updateCursorFromClient(e.clientX, e.clientY);
    const origin = centeredOriginForPlacement(type, 0, false, this.cursorWorldExact, this.grid());
    placeComponentInStore(this.store, type, origin.x, origin.y, 0, false);
    this.svg.focus({ preventScroll: true });
    this.renderOverlay();
    this.emitState();
  }

  // ---- Inline Text Note Editor ----

  private openTextEditor(note: TextNote, isNew: boolean): void {
    this.closeTextEditor(true);
    const ta = document.createElement("textarea");
    ta.className = "ds-inline-text-editor";
    ta.value = note.text;
    ta.dataset.noteId = note.id;
    ta.dataset.isNew = isNew ? "1" : "0";
    this.activeTextEditor = ta;
    this.host.appendChild(ta);
    this.repositionTextEditor();

    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const val = ta.value;
      ta.remove();
      if (this.activeTextEditor === ta) this.activeTextEditor = null;
      if (isNew) {
        // The note was added inside a gesture: commit text into the same undo step,
        // or roll the whole creation back (Esc / empty text) leaving no trace.
        if (commit && val.trim() !== "") {
          if (val !== note.text) {
            this.store.update("Add text note", (draft) => {
              const target = draft.texts.find((t) => t.id === note.id);
              if (target) target.text = val;
            });
          }
          this.store.endGesture();
        } else {
          this.store.cancelGesture();
        }
      } else if (commit) {
        if (val.trim() === "") {
          this.store.update("Delete empty text", (draft) => {
            draft.texts = draft.texts.filter((t) => t.id !== note.id);
          });
        } else if (val !== note.text) {
          this.store.update("Edit text note", (draft) => {
            const target = draft.texts.find((t) => t.id === note.id);
            if (target) target.text = val;
          });
        }
      }
      this.svg.focus({ preventScroll: true });
    };
    // Disposal without touching the store (used when the document is replaced).
    this.disposeTextEditor = () => {
      finished = true;
      ta.remove();
      if (this.activeTextEditor === ta) this.activeTextEditor = null;
    };

    ta.addEventListener("blur", () => finish(true));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    });

    ta.focus();
    ta.select();
  }

  private repositionTextEditor(): void {
    const ta = this.activeTextEditor;
    if (!ta) return;
    const noteId = ta.dataset.noteId;
    const note = this.store.doc.texts.find((t) => t.id === noteId);
    if (!note) return;
    const fs = note.fontSize ?? 14;
    const topLeft = this.worldToScreen(note.x, note.y - fs);
    ta.style.left = `${Math.max(4, topLeft.x - 4)}px`;
    ta.style.top = `${Math.max(4, topLeft.y - 4)}px`;
    ta.style.fontSize = `${clamp(fs * this.zoom, 11, 48)}px`;
  }

  private disposeTextEditor: (() => void) | null = null;

  private closeTextEditor(commit: boolean): void {
    const ta = this.activeTextEditor;
    if (!ta) return;
    if (commit) {
      ta.blur();
    } else {
      // Disarm the blur handler first: removing a focused textarea fires blur, which
      // would otherwise commit the old note into the newly opened/replaced document.
      this.disposeTextEditor?.();
      this.disposeTextEditor = null;
    }
  }

  // ---- Keyboard Shortcuts ----

  private onKeyDown(e: KeyboardEvent): void {
    if (isEditableElement(e.target)) return;
    if (document.querySelector("dialog[open]")) return;

    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    // Global app shortcuts (Ctrl+N/O/S/E) are handled by src/app/commands.ts — do not touch!
    if (mod && (k === "n" || k === "o" || k === "s" || k === "e")) return;

    if (mod) {
      let handled = true;
      if (k === "a") {
        this.selectAll();
      } else if (k === "c") {
        this.copySelection();
      } else if (k === "x") {
        this.cutSelection();
      } else if (k === "v") {
        this.paste();
      } else if (k === "d") {
        this.duplicateSelection();
      } else if (k === "z") {
        this.wireDraft = null;
        if (e.shiftKey) this.store.redo();
        else this.store.undo();
      } else if (k === "y") {
        this.wireDraft = null;
        this.store.redo();
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
      return;
    }

    if (e.altKey) return;

    // Space hold for temporary pan
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.updateCursorStyle();
        this.emitState();
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (this.placing) {
        this.placing = null;
      } else if (this.wireDraft && this.interaction?.kind !== "pin-wire-drag") {
        this.wireDraft = null;
      } else if (this.interaction) {
        if (this.interaction.kind === "pin-wire-drag") this.wireDraft = null;
        if (this.interaction.kind === "marquee") this.store.setSelection(this.interaction.initialSelection);
        const inter = this.interaction;
        this.interaction = null;
        this.releasePointer(inter.pointerId);
        if (
          inter.kind === "move-selection" ||
          inter.kind === "drag-wire-segment" ||
          inter.kind === "resize-component"
        ) {
          this.store.cancelGesture();
        }
      } else if (this.tool !== "select") {
        this.tool = "select";
      } else if (this.store.selection.size > 0) {
        this.store.setSelection([]);
      }
      this.updateHoverFromCursor();
      this.updateCursorStyle();
      this.renderOverlay();
      this.emitState();
      return;
    }

    if (e.key === "/" && this.wireDraft) {
      e.preventDefault();
      this.wireDraft.horizontalFirst = !this.wireDraft.horizontalFirst;
      this.wireDraft.flipped = !this.wireDraft.flipped;
      this.renderOverlay();
      this.emitState();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (this.wireDraft && e.key === "Backspace") {
        if (this.wireDraft.points.length > 1) {
          this.wireDraft.points.pop();
        } else {
          this.wireDraft = null;
        }
        this.renderOverlay();
        this.emitState();
        return;
      }
      this.deleteSelection();
      return;
    }

    if (k === "r") {
      e.preventDefault();
      this.rotateSelection();
      return;
    }
    if (k === "m") {
      e.preventDefault();
      this.mirrorSelection();
      return;
    }
    if (k === "v") {
      e.preventDefault();
      this.setTool("select");
      return;
    }
    if (k === "w") {
      e.preventDefault();
      this.setTool("wire");
      return;
    }
    if (k === "t") {
      e.preventDefault();
      this.setTool("text");
      return;
    }
    if (k === "h") {
      e.preventDefault();
      this.setTool("pan");
      return;
    }
    if (k === "f") {
      e.preventDefault();
      this.zoomToFit();
      return;
    }
    if (k === "g") {
      e.preventDefault();
      this.setGridVisible(!this.gridVisible);
      return;
    }

    // Arrow keys nudge selection by one grid step
    const step = this.grid();
    if (e.key === "ArrowUp") {
      e.preventDefault();
      nudgeSelectionInStore(this.store, 0, -step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nudgeSelectionInStore(this.store, 0, step);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nudgeSelectionInStore(this.store, -step, 0);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nudgeSelectionInStore(this.store, step, 0);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === "Space" || e.key === " ") {
      if (this.spaceDown) {
        this.spaceDown = false;
        this.updateCursorStyle();
        this.emitState();
      }
    }
  }

  private capturePointer(pointerId: number): void {
    try {
      this.svg.setPointerCapture(pointerId);
    } catch {
      // Ignore synthetic events in headless environments
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      if (this.svg.hasPointerCapture(pointerId)) {
        this.svg.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore synthetic events
    }
  }
}

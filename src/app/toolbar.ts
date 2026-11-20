/**
 * Context-aware toolbar. Static groups (file, history, tools, view) plus a contextual
 * group whose content follows the selection: nothing / one component / several of the
 * same type / mixed / wires-only / text-only.
 */
import type { DocumentStore } from "../model/store";
import type { Editor, Tool } from "../editor/editor";
import { getDef } from "../model/registry";
import { THEMES } from "../render/svg";
import { ICONS } from "./icons";
import { showSettingsDialog, showShortcutsDialog } from "./dialogs";
import { getSettings, onSettingsChange, updateSettings } from "../model/settings";
import type { AppCommands } from "./commands";

interface Btn {
  icon?: string;
  label?: string;
  title: string;
  action: () => void;
  cls?: string;
}

function button(b: Btn): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `tb-btn${b.cls ? " " + b.cls : ""}${b.label ? "" : " icon-only"}`;
  el.title = b.title;
  el.setAttribute("aria-label", b.title);
  el.innerHTML = (b.icon ?? "") + (b.label ? `<span>${b.label}</span>` : "");
  el.addEventListener("click", () => b.action());
  return el;
}

function group(...children: HTMLElement[]): HTMLDivElement {
  const g = document.createElement("div");
  g.className = "tb-group";
  g.append(...children);
  return g;
}

export interface SelectionSummary {
  components: { id: string; type: string; label?: string }[];
  wires: number;
  texts: number;
}

export function summarizeSelection(store: DocumentStore): SelectionSummary {
  const sel = store.selection;
  const doc = store.doc;
  return {
    components: doc.components.filter((c) => sel.has(c.id)).map((c) => ({ id: c.id, type: c.type, label: c.label })),
    wires: doc.wires.filter((w) => sel.has(w.id)).length,
    texts: doc.texts.filter((t) => sel.has(t.id)).length,
  };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Human description of the selection for the contextual chip. */
export function describeSelection(s: SelectionSummary): string {
  const nc = s.components.length;
  if (nc === 0 && s.wires === 0 && s.texts === 0) return "";
  if (nc === 1 && s.wires === 0 && s.texts === 0) {
    const c = s.components[0];
    const name = getDef(c.type)?.name ?? c.type;
    return c.label ? `${name} · ${c.label}` : name;
  }
  if (nc > 1 && s.wires === 0 && s.texts === 0) {
    const types = new Set(s.components.map((c) => c.type));
    if (types.size === 1) return `${nc} × ${getDef([...types][0])?.name ?? [...types][0]}`;
    return `${nc} components (${types.size} types)`;
  }
  if (nc === 0 && s.texts === 0) return s.wires === 1 ? "Wire" : plural(s.wires, "wire");
  if (nc === 0 && s.wires === 0) return s.texts === 1 ? "Text note" : plural(s.texts, "text note");
  const parts: string[] = [];
  if (nc) parts.push(plural(nc, "component"));
  if (s.wires) parts.push(plural(s.wires, "wire"));
  if (s.texts) parts.push(plural(s.texts, "note"));
  return parts.join(", ");
}

export function mountToolbar(host: HTMLElement, cmds: AppCommands, editor: Editor, store: DocumentStore): void {
  host.innerHTML = "";
  const brand = document.createElement("span");
  brand.className = "brand";
  // New logo mark (assets/logo/logo-mark.svg) + name
  brand.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" role="img" aria-label="DigiSchem">
  <g fill="none" stroke="#2463d1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 9H5M2 15H5"/>
    <path d="M15 12H19"/>
    <path d="M22 7H19V17H22"/>
  </g>
  <path d="M5 6H9A6 6 0 0 1 9 18H5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="19" cy="12" r="1.75" fill="#2463d1"/>
</svg><span>DigiSchem</span>`;

  // --- File
  const exportBtn = button({ icon: ICONS.export, label: "Export", title: "Export image or netlist", action: () => toggleExportMenu() });
  const exportMenu = document.createElement("div");
  exportMenu.className = "tb-menu";
  exportMenu.hidden = true;
  const menuItem = (label: string, hint: string, fn: () => void) => {
    const it = document.createElement("button");
    it.type = "button";
    it.innerHTML = `<span>${label}</span><kbd>${hint}</kbd>`;
    it.addEventListener("click", () => { exportMenu.hidden = true; fn(); });
    exportMenu.appendChild(it);
  };
  menuItem("SVG image…", "Ctrl+E", () => cmds.showExportDialog("svg"));
  menuItem("PNG image…", "Ctrl+Shift+E", () => cmds.showExportDialog("png"));
  menuItem("Netlist (.txt)", "", () => void cmds.exportNetlist());
  const exportWrap = document.createElement("div");
  exportWrap.className = "tb-menu-wrap";
  exportWrap.append(exportBtn, exportMenu);
  const toggleExportMenu = () => { exportMenu.hidden = !exportMenu.hidden; };
  document.addEventListener("pointerdown", (e) => {
    if (!exportWrap.contains(e.target as Node)) exportMenu.hidden = true;
  });

  const fileGroup = group(
    button({ icon: ICONS.newFile, title: "New schematic (Ctrl+N)", action: () => cmds.newDocument() }),
    button({ icon: ICONS.open, title: "Open project (Ctrl+O)", action: () => void cmds.open() }),
    button({ icon: ICONS.save, title: "Save project (Ctrl+S)", action: () => void cmds.save() }),
    button({ icon: ICONS.saveAs, title: "Save project as… (Ctrl+Shift+S)", action: () => void cmds.save(true) }),
    exportWrap,
  );

  // --- History
  const undoBtn = button({ icon: ICONS.undo, title: "Undo (Ctrl+Z)", action: () => { editor.cancelTransient(); store.undo(); } });
  const redoBtn = button({ icon: ICONS.redo, title: "Redo (Ctrl+Y)", action: () => { editor.cancelTransient(); store.redo(); } });
  const historyGroup = group(undoBtn, redoBtn);

  // --- Tools
  const toolDefs: [Tool, string, string, string][] = [
    ["select", ICONS.select, "Select", "Select / move (V)"],
    ["wire", ICONS.wire, "Wire", "Draw wire (W)"],
    ["text", ICONS.text, "Text", "Add text note (T)"],
    ["pan", ICONS.pan, "Pan", "Pan the view (H) — or Space+drag / middle-drag in any tool"],
  ];
  const toolBtns = toolDefs.map(([tool, icon, label, title]) => {
    const b = button({ icon, label, title, action: () => editor.setTool(tool), cls: "tool" });
    b.dataset.tool = tool;
    return b;
  });
  const toolsGroup = group(...toolBtns);
  toolsGroup.classList.add("segmented");

  // --- Contextual (selection)
  const ctxGroup = document.createElement("div");
  ctxGroup.className = "tb-group tb-context";

  // --- View
  const zoomLabel = document.createElement("button");
  zoomLabel.type = "button";
  zoomLabel.className = "tb-zoom";
  zoomLabel.title = "Reset zoom to 100%";
  zoomLabel.addEventListener("click", () => editor.zoomBy(1 / editor.getZoom()));
  const gridBtn = button({ icon: ICONS.grid, title: "Toggle grid (G)", action: () => updateSettings({ showGrid: !getSettings().showGrid }) });
  const panelBtn = button({
    icon: ICONS.panelRight,
    title: "Show / hide the properties panel (P)",
    action: () => updateSettings({ showPropertiesPanel: !getSettings().showPropertiesPanel }),
  });
  const syncGrid = () => {
    gridBtn.classList.toggle("on", getSettings().showGrid);
    panelBtn.classList.toggle("on", getSettings().showPropertiesPanel);
  };
  onSettingsChange(syncGrid);
  syncGrid();
  const themeSel = document.createElement("select");
  themeSel.title = "Canvas theme";
  themeSel.innerHTML = `<option value="light">Light</option><option value="dark">Dark</option><option value="print">Print</option>`;
  themeSel.addEventListener("change", () => {
    editor.setTheme(THEMES[themeSel.value]);
    document.documentElement.dataset.theme = themeSel.value === "dark" ? "dark" : "light";
  });
  const viewGroup = group(
    button({ icon: ICONS.zoomOut, title: "Zoom out", action: () => editor.zoomBy(1 / 1.25) }),
    zoomLabel,
    button({ icon: ICONS.zoomIn, title: "Zoom in", action: () => editor.zoomBy(1.25) }),
    button({ icon: ICONS.fit, title: "Zoom to fit (F)", action: () => editor.zoomToFit() }),
    button({ icon: ICONS.compact, title: "Compact layout — selection, or whole schematic (Ctrl+Shift+L)", action: () => cmds.compactLayout() }),
    gridBtn,
    themeSel,
    panelBtn,
    button({ icon: ICONS.settings, title: "Settings", action: () => showSettingsDialog() }),
    button({ icon: ICONS.help, title: "Keyboard shortcuts (?)", action: () => showShortcutsDialog() }),
  );
  viewGroup.classList.add("tb-right");

  host.append(brand, fileGroup, historyGroup, toolsGroup, ctxGroup, viewGroup);

  // ---- state sync
  let lastCtxKey = "";
  const renderContext = () => {
    const s = summarizeSelection(store);
    const key = JSON.stringify([s.components.map((c) => c.id + (c.label ?? "")), s.wires, s.texts]);
    if (key === lastCtxKey) return;
    lastCtxKey = key;
    ctxGroup.innerHTML = "";
    const desc = describeSelection(s);
    if (!desc) {
      ctxGroup.hidden = true;
      return;
    }
    ctxGroup.hidden = false;
    const chip = document.createElement("span");
    chip.className = "tb-chip";
    chip.textContent = desc;
    chip.title = desc;
    ctxGroup.appendChild(chip);
    const hasComps = s.components.length > 0;
    if (hasComps) {
      ctxGroup.append(
        button({ icon: ICONS.rotate, title: "Rotate 90° clockwise (R)", action: () => editor.rotateSelection() }),
        button({ icon: ICONS.mirror, title: "Mirror horizontally (M)", action: () => editor.mirrorSelection() }),
      );
      const types = new Set(s.components.map((c) => c.type));
      if (types.size === 1) {
        const type = [...types][0];
        const total = store.doc.components.filter((c) => c.type === type).length;
        if (total > s.components.length) {
          ctxGroup.append(
            button({
              label: `Select all ${total}`,
              title: `Select every ${getDef(type)?.name ?? type} in the schematic`,
              action: () => store.setSelection(store.doc.components.filter((c) => c.type === type).map((c) => c.id)),
            }),
          );
        }
      }
    }
    ctxGroup.append(
      button({ icon: ICONS.duplicate, title: "Duplicate (Ctrl+D)", action: () => editor.duplicateSelection() }),
      button({ icon: ICONS.trash, title: "Delete (Del)", action: () => editor.deleteSelection(), cls: "danger" }),
    );
  };

  const sync = () => {
    for (const b of toolBtns) b.classList.toggle("active", editor.tool === b.dataset.tool);
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    zoomLabel.textContent = `${Math.round(editor.getZoom() * 100)}%`;
    renderContext();
  };
  store.subscribe(sync);
  editor.onStateChange(sync);
  sync();
}

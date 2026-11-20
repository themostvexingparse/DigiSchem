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
  brand.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 280 832 464" width="36" height="20" role="img" aria-label="DigiSchem">
  <g fill="none" stroke-width="64" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="currentColor"><path d="M216 336H326A176 176 0 0 1 326 688H216Z"/><path d="M132 444H216M132 580H216"/><path d="M502 512H548"/></g>
    <path d="M798.9 303.0 L794.8 305.6 L790.6 308.2 L786.4 310.8 L782.1 313.4 L777.8 316.1 L773.5 318.7 L769.2 321.3 L764.9 323.9 L760.5 326.5 L756.2 329.1 L752.0 331.7 L747.7 334.4 L743.5 337.0 L739.3 339.6 L735.2 342.2 L731.2 344.8 L727.2 347.4 L723.3 350.0 L719.5 352.6 L715.8 355.2 L712.1 357.9 L708.6 360.5 L705.2 363.1 L701.9 365.7 L698.7 368.3 L695.6 370.9 L692.7 373.5 L690.0 376.1 L687.3 378.8 L684.9 381.4 L682.5 384.0 L680.4 386.6 L678.4 389.2 L676.5 391.8 L674.9 394.4 L673.4 397.1 L672.1 399.7 L670.9 402.3 L670.0 404.9 L669.2 407.5 L668.6 410.1 L668.2 412.7 L668.0 415.3 L668.0 418.0 L668.2 420.6 L668.5 423.2 L669.1 425.8 L669.8 428.4 L670.7 431.0 L671.8 433.6 L673.0 436.2 L674.5 438.9 L676.1 441.5 L677.9 444.1 L679.8 446.7 L681.9 449.3 L684.2 451.9 L686.6 454.5 L689.2 457.1 L692.0 459.8 L694.8 462.4 L697.8 465.0 L701.0 467.6 L704.3 470.2 L707.6 472.8 L711.1 475.4 L714.7 478.0 L718.5 480.7 L722.3 483.3 L726.1 485.9 L730.1 488.5 L734.1 491.1 L738.2 493.7 L742.4 496.3 L746.6 498.9 L750.8 501.6 L755.1 504.2 L759.4 506.8 L763.7 509.4 L768.0 512.0 L772.3 514.6 L776.6 517.2 L780.9 519.8 L785.2 522.5 L789.4 525.1 L793.6 527.7 L797.8 530.3 L801.9 532.9 L805.9 535.5 L809.9 538.1 L813.7 540.7 L817.5 543.4 L821.3 546.0 L824.9 548.6 L828.4 551.2 L831.7 553.8 L835.0 556.4 L838.2 559.0 L841.2 561.6 L844.0 564.2 L846.8 566.9 L849.4 569.5 L851.8 572.1 L854.1 574.7 L856.2 577.3 L858.1 579.9 L859.9 582.5 L861.5 585.1 L863.0 587.8 L864.2 590.4 L865.3 593.0 L866.2 595.6 L866.9 598.2 L867.5 600.8 L867.8 603.4 L868.0 606.0 L868.0 608.7 L867.8 611.3 L867.4 613.9 L866.8 616.5 L866.0 619.1 L865.1 621.7 L863.9 624.3 L862.6 627.0 L861.1 629.6 L859.5 632.2 L857.6 634.8 L855.6 637.4 L853.5 640.0 L851.1 642.6 L848.7 645.2 L846.0 647.9 L843.3 650.5 L840.4 653.1 L837.3 655.7 L834.1 658.3 L830.8 660.9 L827.4 663.5 L823.9 666.1 L820.2 668.8 L816.5 671.4 L812.7 674.0 L808.8 676.6 L804.8 679.2 L800.8 681.8 L796.7 684.4 L792.5 687.0 L788.3 689.7 L784.0 692.3 L779.8 694.9 L775.5 697.5 L771.1 700.1 L766.8 702.7 L762.5 705.3 L758.2 707.9 L753.9 710.6 L749.6 713.2 L745.4 715.8 L741.2 718.4 L737.1 721.0" stroke="#2463d1"/>
  </g>
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

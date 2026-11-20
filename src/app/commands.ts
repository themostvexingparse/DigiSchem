/** App-level commands: file operations, export, toolbar and global shortcuts. Owned by the shell. */
import type { DocumentStore } from "../model/store";
import { emptyDocument } from "../model/types";
import type { Editor, Tool } from "../editor/editor";
import { THEMES } from "../render/svg";
import { PROJECT_EXTENSION, parseProject, serializeProject } from "../io/project";
import { exportPngBlob, exportSvgString } from "../io/export";
import { openText, saveBinary, saveText } from "../platform/files";

const PROJECT_FILTER = [{ name: "DigiSchem Project", extensions: [PROJECT_EXTENSION, "json"] }];

function baseName(path: string | null, fallback: string): string {
  if (!path) return fallback;
  const n = path.split(/[\\/]/).pop() ?? fallback;
  return n.replace(/\.[^.]+$/, "");
}

export function notify(msg: string, isError = false): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isError ? "show error" : "show";
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => (el!.className = ""), isError ? 6000 : 2500);
}

export class AppCommands {
  constructor(private store: DocumentStore, private editor: Editor) {}

  private confirmDiscard(): boolean {
    return !this.store.dirty || confirm("Discard unsaved changes?");
  }

  newDocument() {
    if (!this.confirmDiscard()) return;
    this.store.replace(emptyDocument());
  }

  async open() {
    if (!this.confirmDiscard()) return;
    try {
      const f = await openText(PROJECT_FILTER);
      if (!f) return;
      const doc = parseProject(f.contents);
      this.store.replace(doc, f.path);
      this.editor.zoomToFit();
      notify(`Opened ${baseName(f.path, "project")}`);
    } catch (e) {
      notify(`Open failed: ${(e as Error).message ?? e}`, true);
    }
  }

  async save(forceDialog = false) {
    try {
      const name = `${baseName(this.store.filePath, this.store.doc.name)}.${PROJECT_EXTENSION}`;
      const path = await saveText(
        serializeProject(this.store.doc),
        name,
        PROJECT_FILTER,
        forceDialog ? null : this.store.filePath,
      );
      if (!path) return;
      this.store.markSaved(path);
      notify(`Saved ${baseName(path, "project")}`);
    } catch (e) {
      notify(`Save failed: ${(e as Error).message ?? e}`, true);
    }
  }

  async exportSvg(opts: { theme: string; background: boolean; grid: boolean }) {
    try {
      const svg = exportSvgString(this.store.doc, {
        theme: THEMES[opts.theme],
        background: opts.background,
        grid: opts.grid,
      });
      const p = await saveText(svg, `${baseName(this.store.filePath, this.store.doc.name)}.svg`, [
        { name: "SVG image", extensions: ["svg"] },
      ]);
      if (p) notify(`Exported ${p}`);
    } catch (e) {
      notify(`SVG export failed: ${(e as Error).message ?? e}`, true);
    }
  }

  async exportPng(opts: { theme: string; background: boolean; grid: boolean; scale: number }) {
    try {
      const blob = await exportPngBlob(this.store.doc, {
        theme: THEMES[opts.theme],
        background: opts.background,
        grid: opts.grid,
        scale: opts.scale,
      });
      const p = await saveBinary(blob, `${baseName(this.store.filePath, this.store.doc.name)}.png`, [
        { name: "PNG image", extensions: ["png"] },
      ]);
      if (p) notify(`Exported ${p}`);
    } catch (e) {
      notify(`PNG export failed: ${(e as Error).message ?? e}`, true);
    }
  }

  /** Small modal for export settings. */
  showExportDialog(kind: "svg" | "png") {
    const dlg = document.createElement("dialog");
    dlg.className = "export-dialog";
    dlg.innerHTML = `
      <form method="dialog">
        <h3>Export ${kind.toUpperCase()}</h3>
        <label>Style <select name="theme">
          <option value="light">Color (light)</option>
          <option value="print">Monochrome (print)</option>
          <option value="dark">Dark</option>
        </select></label>
        <label><input type="checkbox" name="background" checked> Background</label>
        <label><input type="checkbox" name="grid"> Grid dots</label>
        ${kind === "png" ? `<label>Scale <select name="scale">
          <option value="1">1×</option><option value="2" selected>2×</option>
          <option value="3">3×</option><option value="4">4×</option><option value="6">6×</option>
        </select></label>` : ""}
        <menu><button value="cancel">Cancel</button><button value="ok" class="primary">Export</button></menu>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => {
      const f = dlg.querySelector("form")!;
      const data = new FormData(f);
      const ok = dlg.returnValue === "ok";
      dlg.remove();
      if (!ok) return;
      const opts = {
        theme: String(data.get("theme") ?? "light"),
        background: data.get("background") === "on",
        grid: data.get("grid") === "on",
        scale: Number(data.get("scale") ?? 2),
      };
      if (kind === "svg") void this.exportSvg(opts);
      else void this.exportPng(opts);
    });
    dlg.showModal();
  }
}

interface ToolbarItem {
  label: string;
  title: string;
  action: () => void;
  tool?: Tool;
}

export function mountToolbar(host: HTMLElement, cmds: AppCommands, editor: Editor, store: DocumentStore) {
  const groups: ToolbarItem[][] = [
    [
      { label: "New", title: "New schematic (Ctrl+N)", action: () => cmds.newDocument() },
      { label: "Open", title: "Open project (Ctrl+O)", action: () => void cmds.open() },
      { label: "Save", title: "Save project (Ctrl+S)", action: () => void cmds.save() },
      { label: "Save As", title: "Save project as (Ctrl+Shift+S)", action: () => void cmds.save(true) },
    ],
    [
      { label: "SVG", title: "Export SVG (Ctrl+E)", action: () => cmds.showExportDialog("svg") },
      { label: "PNG", title: "Export PNG (Ctrl+Shift+E)", action: () => cmds.showExportDialog("png") },
    ],
    [
      { label: "Undo", title: "Undo (Ctrl+Z)", action: () => store.undo() },
      { label: "Redo", title: "Redo (Ctrl+Y)", action: () => store.redo() },
    ],
    [
      { label: "Select", title: "Select / move (V)", action: () => editor.setTool("select"), tool: "select" },
      { label: "Wire", title: "Draw wire (W)", action: () => editor.setTool("wire"), tool: "wire" },
      { label: "Text", title: "Add text note (T)", action: () => editor.setTool("text"), tool: "text" },
    ],
    [
      { label: "Rotate", title: "Rotate selection (R)", action: () => editor.rotateSelection() },
      { label: "Mirror", title: "Mirror selection (M)", action: () => editor.mirrorSelection() },
      { label: "Delete", title: "Delete selection (Del)", action: () => editor.deleteSelection() },
    ],
    [
      { label: "Fit", title: "Zoom to fit (F)", action: () => editor.zoomToFit() },
      { label: "−", title: "Zoom out", action: () => editor.zoomBy(1 / 1.25) },
      { label: "+", title: "Zoom in", action: () => editor.zoomBy(1.25) },
    ],
  ];
  host.innerHTML = `<span class="brand">DigiSchem</span>`;
  const toolButtons: [HTMLButtonElement, Tool][] = [];
  for (const g of groups) {
    const div = document.createElement("div");
    div.className = "tb-group";
    for (const it of g) {
      const b = document.createElement("button");
      b.textContent = it.label;
      b.title = it.title;
      b.onclick = it.action;
      if (it.tool) toolButtons.push([b, it.tool]);
      div.appendChild(b);
    }
    host.appendChild(div);
  }
  const themeSel = document.createElement("select");
  themeSel.title = "Canvas theme";
  themeSel.innerHTML = `<option value="light">Light</option><option value="dark">Dark</option><option value="print">Print</option>`;
  themeSel.onchange = () => {
    editor.setTheme(THEMES[themeSel.value]);
    document.documentElement.dataset.theme = themeSel.value === "dark" ? "dark" : "light";
  };
  const grp = document.createElement("div");
  grp.className = "tb-group";
  grp.appendChild(themeSel);
  host.appendChild(grp);

  const sync = () => {
    for (const [b, t] of toolButtons) b.classList.toggle("active", editor.tool === t);
  };
  editor.onStateChange(sync);
  sync();
}

/** Global shortcuts for file operations. Editing shortcuts are handled by the Editor. */
export function installGlobalShortcuts(cmds: AppCommands) {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === "n") cmds.newDocument();
    else if (k === "o") void cmds.open();
    else if (k === "s") void cmds.save(e.shiftKey);
    else if (k === "e") cmds.showExportDialog(e.shiftKey ? "png" : "svg");
    else handled = false;
    if (handled) e.preventDefault();
  });
}

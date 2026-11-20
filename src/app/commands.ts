/** App-level commands: file operations, export, toolbar and global shortcuts. Owned by the shell. */
import type { DocumentStore } from "../model/store";
import { emptyDocument } from "../model/types";
import type { Editor } from "../editor/editor";
import { THEMES } from "../render/svg";
import { exportNetlistText } from "../io/netlist";
import { PROJECT_EXTENSION, parseProject, serializeProject } from "../io/project";
import { exportPngBlob, exportSvgString } from "../io/export";
import { openText, saveBinary, saveText } from "../platform/files";
import { showShortcutsDialog } from "./dialogs";

const PROJECT_FILTER = [{ name: "DigiSchem Project", extensions: [PROJECT_EXTENSION, "json"] }];

function baseName(path: string | null, fallback: string): string {
  const raw = path ? (path.split(/[\\/]/).pop() ?? fallback).replace(/\.[^.]+$/, "") : fallback;
  // Names like "4:1 MUX" or "D/JK Flip-Flop" contain characters Windows forbids in file names.
  // eslint-disable-next-line no-control-regex
  const safe = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "");
  return safe || "Untitled";
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

  async exportNetlist() {
    try {
      const text = exportNetlistText(this.store.doc) || "(empty schematic)";
      const p = await saveText(`${text}\n`, `${baseName(this.store.filePath, this.store.doc.name)}-netlist.txt`, [
        { name: "Text netlist", extensions: ["txt"] },
      ]);
      if (p) notify(`Exported ${p}`);
    } catch (e) {
      notify(`Netlist export failed: ${(e as Error).message ?? e}`, true);
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

/** Global shortcuts for file operations. Editing shortcuts are handled by the Editor. */
export function installGlobalShortcuts(cmds: AppCommands) {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio"].includes((t as HTMLInputElement).type)))) return;
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    showShortcutsDialog();
  });
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    // Don't open/replace documents or stack dialogs behind an open modal dialog.
    if (document.querySelector("dialog[open]")) return;
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

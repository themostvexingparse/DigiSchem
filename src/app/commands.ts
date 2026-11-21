/** App-level commands: file operations, export, toolbar and global shortcuts. Owned by the shell. */
import type { DocumentStore } from "../model/store";
import { emptyDocument } from "../model/types";
import type { Editor } from "../editor/editor";
import { THEMES } from "../render/svg";
import { exportNetlistText } from "../io/netlist";
import { PROJECT_EXTENSION, parseProjectWithWarnings, serializeProject } from "../io/project";
import { exportPngBlob, exportSvgString } from "../io/export";
import { openText, saveBinary, saveText } from "../platform/files";
import { showShortcutsDialog } from "./dialogs";
import { packInBackground } from "../layout/pack-client";
import { worldPins } from "../model/geometry";
import type { SchematicDocument } from "../model/types";

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
  private compacting = false;

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
      const { doc, warnings } = parseProjectWithWarnings(f.contents);
      this.store.replace(doc, f.path);
      this.editor.zoomToFit();
      // Anything the loader had to repair or drop is worth knowing about (details in the console).
      const serious = warnings.filter((w) => /dropped|clamped|duplicate|renamed|invalid|unsupported/i.test(w));
      if (serious.length > 0) {
        console.warn(`Opened ${f.path} with ${warnings.length} repair(s):\n` + warnings.join("\n"));
        notify(`Opened ${baseName(f.path, "project")}. ${serious.length} problem${serious.length > 1 ? "s" : ""} in the file were repaired (e.g. ${serious[0]})`, true);
      } else {
        notify(`Opened ${baseName(f.path, "project")}`);
      }
    } catch (e) {
      notify(`Open failed: ${(e as Error).message ?? e}`, true);
    }
  }

  async save(forceDialog = false) {
    try {
      const name = `${baseName(this.store.filePath, this.store.doc.name)}.${PROJECT_EXTENSION}`;
      const saved = this.store.doc;
      const path = await saveText(
        serializeProject(saved),
        name,
        PROJECT_FILTER,
        forceDialog ? null : this.store.filePath,
      );
      if (!path) return;
      // Edits made while the dialog was open / the file was being written are NOT saved.
      if (this.store.doc === saved) this.store.markSaved(path);
      else this.store.filePath = path;
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

  /**
   * Compact the layout with the packer: the selection (plus wires attached to it) if any,
   * otherwise the whole schematic. The packer preserves connectivity, wire shapes and
   * component order; its result is re-validated before being applied as one undo step.
   */
  compactLayout() {
    const doc = this.store.doc;
    const sel = this.store.selection;
    let ids: Set<string> | undefined;
    if (sel.size > 0) {
      ids = new Set(sel);
      const pinKeys = new Set<string>();
      for (const c of doc.components) if (sel.has(c.id)) for (const wp of worldPins(c)) pinKeys.add(`${wp.pos.x},${wp.pos.y}`);
      for (const w of doc.wires) {
        const ends = [w.points[0], w.points[w.points.length - 1]];
        if (ends.some((e) => e && pinKeys.has(`${e.x},${e.y}`))) ids.add(w.id);
      }
    }
    if (this.compacting) {
      notify("Compaction is already running…");
      return;
    }
    this.compacting = true;
    const before = doc as SchematicDocument;
    const t0 = performance.now();
    notify(sel.size > 0 ? "Compacting selection… (searching layouts)" : "Compacting layout… (searching layouts)");
    packInBackground(before, ids)
      .then(async ({ res, problems }) => {
        // a mouse gesture in progress (e.g. the mouse held on a part) must end first: the result
        // would otherwise land inside the drag and be partly undone by it
        for (let i = 0; i < 600 && (this.editor.isBusy() || this.store.inGesture()); i++) await new Promise((r) => setTimeout(r, 50));
        if (this.store.doc !== before) {
          notify("The schematic changed while compacting. Run Compact layout again.", true);
          return;
        }
        if (problems.length > 0) {
          notify(`Compaction skipped: the result broke a layout rule (${problems[0]})`, true);
          return;
        }
        if (!(res.qualityAfter.total < res.qualityBefore.total)) {
          notify("Already tidy. Nothing to improve without changing wire shapes or order.");
          return;
        }
        this.store.update(sel.size > 0 ? "Compact selection" : "Compact layout", (d) => {
          d.components = res.doc.components;
          d.wires = res.doc.wires;
          d.texts = res.doc.texts;
        });
        const pct = Math.round(100 * (1 - res.areaAfter / res.areaBefore));
        const parts = [pct > 0 ? `${pct}% less area` : "same area"];
        if (res.qualityAfter.spacing < res.qualityBefore.spacing || res.qualityAfter.alignment < res.qualityBefore.alignment) parts.push("aligned & evenly spaced");
        if (res.qualityAfter.clutter < res.qualityBefore.clutter) parts.push("less clutter");
        if (res.conflictsFixed) parts.push(`${res.conflictsFixed} wire conflict${res.conflictsFixed > 1 ? "s" : ""} cleaned up`);
        if (res.realignedParts.length > 0) parts.push(`${res.realignedParts.length} part${res.realignedParts.length > 1 ? "s" : ""} moved back into line or clear of an overlap`);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        notify(`Compacted in ${secs}s: ${parts.join(", ")} (Ctrl+Z to undo)`);
      })
      .catch((e) => notify(`Compaction failed: ${(e as Error).message ?? e}`, true))
      .finally(() => {
        this.compacting = false;
      });
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
    else if (k === "l" && e.shiftKey) cmds.compactLayout();
    else handled = false;
    if (handled) e.preventDefault();
  });
}

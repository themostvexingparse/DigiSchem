/**
 * The Code dialog: write a schematic as DSpec text and build it, or read the current schematic
 * as code. Building replaces the drawing as one undoable step; parts that keep their name keep
 * their place (the current drawing is the "previous" build).
 */
import type { DocumentStore } from "../model/store";
import type { Editor } from "../editor/editor";
import type { SchematicDocument } from "../model/types";
import type { Diagnostic } from "../spec/parser";
import { compileInBackground } from "../spec/compile-client";
import { decompileDoc } from "../spec/decompile";
import { DSPEC_GUIDE, DSPEC_TEMPLATE } from "../spec/guide";
import { referenceText } from "../spec/reference";
import { netSignature } from "../layout/realign";
import { openText, saveText } from "../platform/files";
import { modal } from "./dialogs";
import { notify } from "./commands";

const DSPEC_FILTER = [{ name: "DSpec source", extensions: ["dspec", "txt"] }];
let draft: string | null = null; // text left in the dialog (kept while the app runs)
let lastDiagnostics: Diagnostic[] = [];
let lastBuilt: string | null = null;

/** The source the dialog starts with: the code the drawing was built from, if still accurate. */
function initialSource(doc: SchematicDocument): { text: string; note: string } {
  const src = doc.meta?.dspec;
  if (src && doc.meta?.dspecNets === netSignature(doc)) return { text: src, note: "The code this schematic was built from." };
  if (doc.components.length) return { text: decompileDoc(doc), note: src ? "The drawing changed since it was built, so this is the drawing read back as code." : "The current schematic, read as code." };
  return { text: DSPEC_TEMPLATE, note: "An example to start from." };
}

export function showCodeDialog(store: DocumentStore, editor: Editor, preset?: { text: string; build?: boolean }): void {
  const body = document.createElement("div");
  body.className = "code-dlg";
  const bar = document.createElement("div");
  bar.className = "code-bar";
  const mk = (label: string, title: string, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    if (primary) b.className = "primary";
    bar.appendChild(b);
    return b;
  };
  const buildBtn = mk("Build", "Draw the schematic from this code (Ctrl+Enter). Undo restores the previous drawing.", true);
  const readBtn = mk("Read from schematic", "Replace the text with the current schematic, written as code");
  const openBtn = mk("Open…", "Open a .dspec file");
  const saveBtn = mk("Save…", "Save this code as a .dspec file");
  const guideBtn = mk("Copy guide for AI", "Copy the language guide and the component list, to paste into a chat with an AI model");
  const status = document.createElement("span");
  status.className = "code-status";
  bar.appendChild(status);

  const ta = document.createElement("textarea");
  ta.className = "code-text";
  ta.spellcheck = false;
  ta.wrap = "off";
  const init = preset ? { text: preset.text, note: "" } : draft !== null ? { text: draft, note: "Your unsaved code from before." } : initialSource(store.doc as SchematicDocument);
  ta.value = init.text;
  status.textContent = init.note;

  const list = document.createElement("ul");
  list.className = "code-diags";
  const showDiags = (ds: Diagnostic[]) => {
    list.innerHTML = "";
    for (const d of ds) {
      const li = document.createElement("li");
      li.className = d.severity;
      li.textContent = `Line ${d.line}: ${d.severity}: ${d.message}`;
      li.title = "Go to this line";
      li.addEventListener("click", () => selectLine(d.line));
      list.appendChild(li);
    }
  };
  const selectLine = (line: number) => {
    const lines = ta.value.split("\n");
    const start = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    ta.scrollTop = Math.max(0, (line - 4) * 18);
  };
  if (!preset) showDiags(lastDiagnostics);

  body.append(bar, ta, list);
  const dlg = modal("Code (DSpec)", body);
  dlg.classList.add("code-dialog");
  let builtOk = false;
  dlg.addEventListener("close", () => {
    draft = builtOk && ta.value === lastBuilt ? null : ta.value;
  });

  let busy = false;
  const build = async () => {
    if (busy) return;
    busy = true;
    buildBtn.disabled = true;
    status.textContent = "Building…";
    try {
      const r = await compileInBackground(ta.value, store.doc as SchematicDocument);
      lastDiagnostics = r.diagnostics;
      showDiags(r.diagnostics);
      const nErr = r.diagnostics.filter((d) => d.severity === "error").length;
      const nWarn = r.diagnostics.filter((d) => d.severity === "warning").length;
      if (!r.doc) {
        status.textContent = `${nErr} error${nErr === 1 ? "" : "s"}: nothing was changed.`;
        if (r.diagnostics[0]) selectLine(r.diagnostics.find((d) => d.severity === "error")!.line);
        return;
      }
      const built = r.doc;
      store.update(
        "Build from code",
        (d) => {
          d.name = built.name;
          d.components = built.components;
          d.wires = built.wires;
          d.texts = built.texts;
          d.links = built.links;
          d.meta = { ...(d.meta ?? {}), ...(built.meta ?? {}) };
        },
        { exact: true },
      );
      editor.zoomToFit();
      const s = r.stats;
      const summary = `Built ${s.parts} parts, ${s.nets} nets, ${s.wires} wires${s.tunnels ? `, ${s.tunnels} net labels` : ""} in ${(s.ms.total / 1000).toFixed(1)} s`;
      builtOk = true;
      lastBuilt = ta.value;
      if (nWarn) {
        status.textContent = `${summary}. ${nWarn} warning${nWarn === 1 ? "" : "s"} below.`;
      } else {
        notify(summary);
        dlg.close();
      }
    } catch (e) {
      status.textContent = `Build failed: ${(e as Error).message}`;
    } finally {
      busy = false;
      buildBtn.disabled = false;
    }
  };

  buildBtn.addEventListener("click", () => void build());
  readBtn.addEventListener("click", () => {
    ta.value = decompileDoc(store.doc as SchematicDocument);
    showDiags([]);
    status.textContent = "The current schematic, read as code.";
  });
  openBtn.addEventListener("click", async () => {
    const f = await openText(DSPEC_FILTER);
    if (!f) return;
    ta.value = f.contents;
    showDiags([]);
    status.textContent = `Opened ${f.path.split(/[\\/]/).pop()}`;
  });
  saveBtn.addEventListener("click", async () => {
    const name = `${(store.doc.name || "schematic").replace(/[^A-Za-z0-9 _-]/g, "")}.dspec`;
    const p = await saveText(ta.value, name, DSPEC_FILTER);
    if (p) status.textContent = `Saved ${p.split(/[\\/]/).pop()}`;
  });
  guideBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${DSPEC_GUIDE}\n${referenceText()}`);
      status.textContent = "Guide and component list copied.";
    } catch {
      status.textContent = "Could not copy to the clipboard.";
    }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void build();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
    }
    e.stopPropagation(); // editor shortcuts must not fire while typing
  });
  ta.focus();
  if (preset?.build) void build();
}

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./platform/files";
import { registerBuiltinComponents } from "./components/library";
import { DocumentStore } from "./model/store";
import { emptyDocument } from "./model/types";
import { Editor } from "./editor/editor";
import { mountPalette } from "./ui/palette";
import { mountProperties } from "./ui/properties";
import { AppCommands, installGlobalShortcuts, notify } from "./app/commands";
import { mountToolbar } from "./app/toolbar";
import { getSettings, onSettingsChange, updateSettings } from "./model/settings";

registerBuiltinComponents();

const store = new DocumentStore(emptyDocument());
const editor = new Editor(document.getElementById("canvas")!, store);
const cmds = new AppCommands(store, editor);

mountToolbar(document.getElementById("toolbar")!, cmds, editor, store);
mountPalette(document.getElementById("palette")!, editor);
mountProperties(document.getElementById("properties")!, store);
installGlobalShortcuts(cmds);

const status = document.getElementById("statusbar")!;
let lastConflicts = 0;
const updateStatus = () => {
  const name = store.filePath ? store.filePath.split(/[\\/]/).pop() : store.doc.name;
  const nConf = editor.connectionConflicts().length;
  const nUnrouted = editor.unroutedWires().size;
  status.textContent = `${name}${store.dirty ? " •" : ""}   |   ${store.doc.components.length} components, ${store.doc.wires.length} wires   |   ${editor.statusText()}${nConf > 0 ? `   |   ⚠ ${nConf} connection conflict${nConf > 1 ? "s" : ""} (connections kept)` : ""}${nUnrouted > 0 ? `   |   ⚠ ${nUnrouted} wire${nUnrouted > 1 ? "s" : ""} waiting for a clean route` : ""}`;
  status.classList.toggle("has-conflicts", nConf > 0 || nUnrouted > 0);
  // Warn once when an edit (not each drag frame) leaves NEW conflicts.
  if (!editor.isBusy()) {
    if (nConf > lastConflicts) {
      notify(
        `⚠ ${nConf} place${nConf > 1 ? "s" : ""} where the drawing touches or misses differently from the circuit's connections. ` +
          "Nothing was connected or disconnected — move the parts apart to clean up the drawing (red rings).",
        true,
      );
    }
    lastConflicts = nConf;
  }
  document.title = `${name}${store.dirty ? " •" : ""} — DigiSchem`;
};
store.subscribe(updateStatus);
editor.onUnroutedChange((added, total) => {
  updateStatus();
  if (added > 0) {
    notify(
      `⚠ ${added} wire${added > 1 ? "s" : ""} could not be routed without touching other wires or a part's outline ` +
        `(dashed red). ${total > 1 || added > 1 ? "They" : "It"} will be restored automatically as soon as there is room.`,
      true,
    );
  }
});
editor.onStateChange(updateStatus);
updateStatus();

// Browser dev build: the standard leave-page warning (the desktop app uses the prompt below).
if (!isTauri()) {
  window.addEventListener("beforeunload", (e) => {
    if (store.dirty) e.preventDefault();
  });
}

// Desktop app: `beforeunload` doesn't fire on window close, so ask before discarding work.
if (isTauri()) {
  void getCurrentWindow().onCloseRequested(async (event) => {
    if (!store.dirty) return;
    const discard = await ask("You have unsaved changes. Close DigiSchem and discard them?", {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Discard and close",
      cancelLabel: "Keep editing",
    });
    if (!discard) event.preventDefault();
  });
}

// Right-hand properties panel: toggled from the toolbar / P key, remembered between sessions.
const appEl = document.getElementById("app")!;
const applyPanel = () => {
  appEl.classList.toggle("no-props", !getSettings().showPropertiesPanel);
  // The canvas just changed size: keep the view stable and redraw.
  window.dispatchEvent(new Event("resize"));
};
onSettingsChange(applyPanel);
applyPanel();
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "p" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio"].includes((t as HTMLInputElement).type)))) return;
  if (document.querySelector("dialog[open]")) return;
  e.preventDefault();
  updateSettings({ showPropertiesPanel: !getSettings().showPropertiesPanel });
});

// Exposed for debugging in devtools.
(window as any).digischem = { store, editor };

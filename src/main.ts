import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./platform/files";
import { registerBuiltinComponents } from "./components/library";
import { DocumentStore } from "./model/store";
import { emptyDocument } from "./model/types";
import { Editor } from "./editor/editor";
import { mountPalette } from "./ui/palette";
import { mountProperties } from "./ui/properties";
import { AppCommands, installGlobalShortcuts } from "./app/commands";
import { mountToolbar } from "./app/toolbar";

registerBuiltinComponents();

const store = new DocumentStore(emptyDocument());
const editor = new Editor(document.getElementById("canvas")!, store);
const cmds = new AppCommands(store, editor);

mountToolbar(document.getElementById("toolbar")!, cmds, editor, store);
mountPalette(document.getElementById("palette")!, editor);
mountProperties(document.getElementById("properties")!, store);
installGlobalShortcuts(cmds);

const status = document.getElementById("statusbar")!;
const updateStatus = () => {
  const name = store.filePath ? store.filePath.split(/[\\/]/).pop() : store.doc.name;
  status.textContent = `${name}${store.dirty ? " •" : ""}   |   ${store.doc.components.length} components, ${store.doc.wires.length} wires   |   ${editor.statusText()}`;
  document.title = `${name}${store.dirty ? " •" : ""} — DigiSchem`;
};
store.subscribe(updateStatus);
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

// Exposed for debugging in devtools.
(window as any).digischem = { store, editor };

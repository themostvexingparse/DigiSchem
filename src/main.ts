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
  const name = store.filePath ? store.filePath.split(/[\/]/).pop() : store.doc.name;
  status.textContent = `${name}${store.dirty ? " •" : ""}   |   ${store.doc.components.length} components, ${store.doc.wires.length} wires   |   ${editor.statusText()}`;
  document.title = `${name}${store.dirty ? " •" : ""} — DigiSchem`;
};
store.subscribe(updateStatus);
editor.onStateChange(updateStatus);
updateStatus();

window.addEventListener("beforeunload", (e) => {
  if (store.dirty) e.preventDefault();
});

// Exposed for debugging in devtools.
(window as any).digischem = { store, editor };

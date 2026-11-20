/** CONTRACT (owned by editor/ui module): component palette. STUB. */
import type { Editor } from "../editor/editor";
import { listDefs } from "../model/registry";

export function mountPalette(host: HTMLElement, editor: Editor): void {
  host.innerHTML = "";
  for (const def of listDefs()) {
    const b = document.createElement("button");
    b.textContent = def.name;
    b.onclick = () => editor.startPlacing(def.type);
    host.appendChild(b);
  }
}

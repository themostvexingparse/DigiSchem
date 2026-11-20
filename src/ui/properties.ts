/** CONTRACT (owned by editor/ui module): properties inspector for the selection. STUB. */
import type { DocumentStore } from "../model/store";

export function mountProperties(host: HTMLElement, store: DocumentStore): void {
  const render = () => {
    host.textContent = `${store.selection.size} selected`;
  };
  store.subscribe(render);
  render();
}

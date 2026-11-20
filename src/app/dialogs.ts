/** Settings and keyboard-shortcut dialogs. */
import { getSettings, updateSettings, type Settings } from "../model/settings";

function modal(title: string, body: HTMLElement, footer?: HTMLElement): HTMLDialogElement {
  const dlg = document.createElement("dialog");
  dlg.className = "app-dialog";
  const h = document.createElement("h3");
  h.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dlg-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", () => dlg.close());
  const head = document.createElement("header");
  head.append(h, close);
  dlg.append(head, body);
  if (footer) dlg.append(footer);
  dlg.addEventListener("close", () => dlg.remove());
  // Click on the backdrop closes the dialog.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export function showSettingsDialog(): void {
  const s = getSettings();
  const body = document.createElement("div");
  body.className = "settings-list";

  const toggle = (key: BoolKey, label: string, hint: string) => {
    const row = document.createElement("label");
    row.className = "settings-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s[key];
    cb.addEventListener("change", () => updateSettings({ [key]: cb.checked } as Partial<Settings>));
    const text = document.createElement("span");
    text.innerHTML = `<b></b><small></small>`;
    text.querySelector("b")!.textContent = label;
    text.querySelector("small")!.textContent = hint;
    row.append(cb, text);
    body.appendChild(row);
  };

  const section = (name: string) => {
    const h = document.createElement("h4");
    h.textContent = name;
    body.appendChild(h);
  };

  section("Editing");
  toggle("sweepOrphanWires", "Delete orphaned wires", "Deleting a component also removes wires left dangling from its pins.");
  toggle("showGuides", "Alignment & spacing guides", "While moving a part, show guides to other parts of the same type and size.");
  toggle("snapToGuides", "Snap to guides", "Pull the part onto an alignment / equal-spacing guide when it is close.");

  section("Canvas");
  toggle("showGrid", "Show grid", "Dotted 10-unit grid (also toggled with G).");
  toggle("showUnconnectedPins", "Mark unconnected pins", "Small red circles on pins with nothing attached.");

  modal("Settings", body);
}

const SHORTCUTS: [string, string][] = [
  ["V / W / T / H", "Select · Wire · Text · Pan tool"],
  ["Drag from a pin", "Draw a wire (select tool)"],
  ["/ (while wiring)", "Flip the wire's bend direction"],
  ["Esc", "Cancel placing / wiring / dragging"],
  ["R / M", "Rotate 90° / Mirror selection"],
  ["Del / Backspace", "Delete selection"],
  ["Ctrl+C / X / V / D", "Copy · Cut · Paste · Duplicate"],
  ["Ctrl+A", "Select all"],
  ["Ctrl+Z / Ctrl+Y", "Undo / Redo"],
  ["Arrow keys", "Nudge selection by one grid cell"],
  ["Shift (while placing)", "Keep placing copies"],
  ["Space+drag / middle-drag", "Pan the view"],
  ["Mouse wheel", "Zoom around the cursor"],
  ["F / G", "Zoom to fit · Toggle grid"],
  ["Ctrl+N / O / S", "New · Open · Save (Ctrl+Shift+S: Save as)"],
  ["Ctrl+E / Ctrl+Shift+E", "Export SVG / PNG"],
  ["?", "This help"],
];

export function showShortcutsDialog(): void {
  const body = document.createElement("table");
  body.className = "shortcut-table";
  for (const [k, d] of SHORTCUTS) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = d;
    tr.append(th, td);
    body.appendChild(tr);
  }
  modal("Keyboard shortcuts", body);
}

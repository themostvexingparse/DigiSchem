/**
 * CONTRACT (owned by editor/ui module): searchable, categorized component palette
 * with SVG symbol thumbnails, click-to-place, and HTML5 drag-to-canvas.
 */
import "./ui.css";
import type { ComponentDef } from "../model/component-def";
import { CATEGORY_ORDER, listDefs } from "../model/registry";
import { schematicCss } from "../render/svg";
import {
  DRAG_TYPE_MIME,
  setDraggedPaletteType,
  type Editor,
} from "../editor/editor";

function sortCategories(categories: string[]): string[] {
  const orderIndex = new Map<string, number>();
  CATEGORY_ORDER.forEach((cat, idx) => orderIndex.set(cat, idx));
  return [...categories].sort((a, b) => {
    const ia = orderIndex.get(a);
    const ib = orderIndex.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.localeCompare(b);
  });
}

function buildThumbnailSvg(def: ComponentDef): string {
  const props = { ...def.defaultProps };
  const g = def.geometry(props);
  let minX = 0;
  let minY = 0;
  let maxX = g.width;
  let maxY = g.height;
  for (const p of g.pins) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(20, maxX - minX);
  const h = Math.max(20, maxY - minY);
  const pad = Math.max(8, Math.max(w, h) * 0.14);
  const vx = minX - pad;
  const vy = minY - pad;
  const vw = w + pad * 2;
  const vh = h + pad * 2;
  const inner = def.symbol(props);
  return `<svg class="ds-pal-thumb" viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

function scopedThumbnailCss(editor: Editor): string {
  return schematicCss(editor.getTheme()).replace(/^\./gm, ".ds-pal-thumb .");
}

export function mountPalette(host: HTMLElement, editor: Editor): void {
  host.innerHTML = "";

  const root = document.createElement("div");
  root.className = "ds-pal";

  // Theme-synced schematic CSS scoped strictly to palette thumbnails
  const styleEl = document.createElement("style");
  let lastThemeName = editor.getTheme().name;
  styleEl.textContent = scopedThumbnailCss(editor);
  root.appendChild(styleEl);

  // Search box
  const search = document.createElement("input");
  search.type = "search";
  search.className = "ds-pal-search";
  search.placeholder = "Search components…";
  search.setAttribute("aria-label", "Search components");
  root.appendChild(search);

  const listEl = document.createElement("div");
  listEl.className = "ds-pal-list";
  root.appendChild(listEl);

  host.appendChild(root);

  const collapsed = new Set<string>();
  const itemButtons = new Map<string, HTMLElement>();

  const syncActiveHighlight = () => {
    const placingType = editor.getPlacingType();
    for (const [type, btn] of itemButtons) {
      btn.classList.toggle("active", type === placingType);
    }
    const currentTheme = editor.getTheme().name;
    if (currentTheme !== lastThemeName) {
      lastThemeName = currentTheme;
      styleEl.textContent = scopedThumbnailCss(editor);
    }
  };

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    const allDefs = listDefs();
    const filtered = q
      ? allDefs.filter(
          (d) =>
            d.name.toLowerCase().includes(q) ||
            (d.description?.toLowerCase().includes(q) ?? false) ||
            d.type.toLowerCase().includes(q) ||
            d.category.toLowerCase().includes(q),
        )
      : allDefs;

    listEl.innerHTML = "";
    itemButtons.clear();

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ds-pal-empty";
      empty.textContent = "No matching components";
      listEl.appendChild(empty);
      return;
    }

    const byCat = new Map<string, ComponentDef[]>();
    for (const d of filtered) {
      const list = byCat.get(d.category);
      if (list) list.push(d);
      else byCat.set(d.category, [d]);
    }

    const sortedCats = sortCategories([...byCat.keys()]);
    for (const cat of sortedCats) {
      const defs = byCat.get(cat)!;
      const isOpen = q.length > 0 || !collapsed.has(cat);

      const section = document.createElement("section");
      section.className = "ds-pal-cat";

      const hdr = document.createElement("button");
      hdr.type = "button";
      hdr.className = "ds-pal-cat-hdr";
      hdr.setAttribute("aria-expanded", String(isOpen));
      hdr.innerHTML =
        `<span class="ds-pal-cat-left"><span class="ds-pal-chev">${isOpen ? "▾" : "▸"}</span><span></span></span>` +
        `<span class="ds-pal-count">${defs.length}</span>`;
      hdr.querySelector(".ds-pal-cat-left span:last-child")!.textContent = cat;
      hdr.onclick = () => {
        if (collapsed.has(cat)) collapsed.delete(cat);
        else collapsed.add(cat);
        renderList();
      };
      section.appendChild(hdr);

      if (isOpen) {
        const grid = document.createElement("div");
        grid.className = "ds-pal-grid";

        for (const def of defs) {
          const item = document.createElement("div");
          item.setAttribute("role", "button");
          item.tabIndex = 0;
          item.className = "ds-pal-item";
          item.draggable = true;
          item.title = def.description ? `${def.name}: ${def.description}` : def.name;
          item.innerHTML = `${buildThumbnailSvg(def)}<span class="ds-pal-name"></span>`;
          item.querySelector(".ds-pal-name")!.textContent = def.name;

          item.onclick = () => {
            item.blur();
            editor.startPlacing(def.type);
          };
          item.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              item.blur();
              editor.startPlacing(def.type);
            }
          });

          item.addEventListener("dragstart", (e) => {
            if (!e.dataTransfer) return;
            e.dataTransfer.setData(DRAG_TYPE_MIME, def.type);
            e.dataTransfer.setData("text/plain", def.type);
            e.dataTransfer.effectAllowed = "copy";
            setDraggedPaletteType(def.type);
          });

          item.addEventListener("dragend", () => {
            setDraggedPaletteType(null);
          });

          itemButtons.set(def.type, item);
          grid.appendChild(item);
        }
        section.appendChild(grid);
      }

      listEl.appendChild(section);
    }

    syncActiveHighlight();
  };

  search.addEventListener("input", renderList);
  editor.onStateChange(syncActiveHighlight);
  renderList();
}

/**
 * The component catalog for DSpec, generated from the live library (so it can never go stale):
 * every type with its properties (ranges, options, defaults) and its pins at default settings.
 */
import { registerBuiltinComponents } from "../components/library";
import { CATEGORY_ORDER, listDefs } from "../model/registry";
import type { ComponentDef } from "../model/component-def";
import { TYPE_ALIASES } from "./resolve";

export interface CatalogEntry {
  type: string;
  name: string;
  category: string;
  description: string;
  props: { key: string; kind: string; default: unknown; min?: number; max?: number; options?: string[] }[];
  pins: { id: string; name: string; dir: string; width: number }[];
  resizable: boolean;
}

function sortedDefs(): ComponentDef[] {
  registerBuiltinComponents();
  const rank = (c: string) => (CATEGORY_ORDER.indexOf(c) === -1 ? 99 : CATEGORY_ORDER.indexOf(c));
  return listDefs().sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
}

export function catalog(): CatalogEntry[] {
  return sortedDefs().map((d) => ({
    type: d.type,
    name: d.name,
    category: d.category,
    description: d.description ?? "",
    props: d.props.map((p) => ({
      key: p.key,
      kind: p.kind,
      default: d.defaultProps[p.key],
      ...(p.min !== undefined ? { min: p.min, max: p.max } : {}),
      ...(p.options ? { options: p.options.map((o) => o.value) } : {}),
    })),
    pins: d.geometry(d.defaultProps).pins.map((p) => ({ id: p.id, name: p.name, dir: p.dir, width: p.width ?? 1 })),
    resizable: !!d.resizable,
  }));
}

/** Plain-text catalog (one block per type), compact enough to paste into a model's context. */
export function referenceText(): string {
  const out: string[] = ["DSpec component catalog (generated from the DigiSchem library)", ""];
  let cat = "";
  for (const e of catalog()) {
    if (e.category !== cat) {
      cat = e.category;
      out.push(`## ${cat}`);
    }
    out.push(`${e.type}: ${e.name}. ${e.description}`);
    if (e.props.length) {
      out.push(
        "  props: " +
          e.props
            .map((p) => {
              const range = p.options ? p.options.join("|") : p.min !== undefined ? `${p.min}..${p.max}` : p.kind;
              return `${p.key}=${range} (default ${JSON.stringify(p.default)})`;
            })
            .join(", "),
      );
    }
    out.push("  pins: " + e.pins.map((p) => `${p.id}(${p.dir}${p.width > 1 ? `, ${p.width} bits` : ""})${p.name && p.name.toLowerCase() !== p.id ? ` "${p.name}"` : ""}`).join(", "));
  }
  out.push("", "Type aliases: " + Object.entries(TYPE_ALIASES).map(([a, t]) => `${a}=${t}`).join(", "));
  out.push("Pins listed are for default props; count props (inputs, width with pinMode=bits, ...) add or remove pins.");
  return out.join("\n") + "\n";
}

/**
 * Schematic -> DSpec. Lets a person (or a model) read an existing drawing as code, edit it and
 * build it again. Parts keep their positions (at=...) and the header turns compaction off, so
 * building the result reproduces the layout; wires are re-routed from the nets.
 */
import { getDef } from "../model/registry";
import { registerBuiltinComponents } from "../components/library";
import type { PropValue, SchematicDocument } from "../model/types";
import { buildNetlist } from "../io/netlist";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(["part", "net", "text", "group"]);
const NAMED_TERMINALS = new Set(["input-pin", "output-pin", "tunnel"]);

function fmt(v: PropValue): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return /^[A-Za-z0-9_.+]+$/.test(v) && !/^(true|false|on|off|yes|no)$/i.test(v) ? v : JSON.stringify(v);
}

export function decompileDoc(doc: SchematicDocument): string {
  registerBuiltinComponents();
  const used = new Set<string>();
  const nameOf = new Map<string, string>();
  const counters = new Map<string, number>();
  const take = (want: string): string | null => {
    if (!NAME_RE.test(want) || KEYWORDS.has(want.toLowerCase()) || used.has(want)) return null;
    used.add(want);
    return want;
  };
  for (const c of doc.components) {
    const def = getDef(c.type);
    const label = c.label?.trim() ?? "";
    const nm = NAMED_TERMINALS.has(c.type) ? String(c.props.name ?? "").trim() : "";
    // generated ids (c_mwotv1o3tc6ih) are not names anyone wants to read
    const humanId = !/^[a-z]+_[a-z0-9]{8,}$/.test(c.id);
    let n = take(label) ?? (nm ? take(nm) : null) ?? (humanId ? take(c.id) : null);
    if (!n) {
      const prefix = (def?.labelPrefix ?? "U").replace(/[^A-Za-z0-9_]/g, "") || "U";
      let k = counters.get(prefix) ?? 1;
      while (!(n = take(`${prefix}${k}`))) k++;
      counters.set(prefix, k + 1);
    }
    nameOf.set(c.id, n);
  }
  const lines: string[] = [];
  lines.push(`# Read from "${doc.name}". Positions are kept; wires are re-routed from the nets.`);
  lines.push(`@name ${JSON.stringify(doc.name)}`);
  lines.push("@layout manual");
  lines.push("@compact never");
  lines.push("");
  for (const c of doc.components) {
    const def = getDef(c.type);
    const n = nameOf.get(c.id)!;
    const bits: string[] = [`part ${n} ${c.type}`];
    for (const [k, v] of Object.entries(c.props)) {
      if (k.startsWith("_")) continue;
      if (def && def.defaultProps[k] === v && !(k === "name" && NAMED_TERMINALS.has(c.type))) continue;
      if (k === "name" && NAMED_TERMINALS.has(c.type) && v === n) continue;
      bits.push(`${k}=${fmt(v)}`);
    }
    bits.push(`at=${c.x},${c.y}`);
    if (c.rotation) bits.push(`rot=${c.rotation}`);
    if (c.mirror) bits.push("mirror");
    if (c.size && def?.resizable) bits.push(`size=${c.size.w}x${c.size.h}`);
    const label = c.label ?? "";
    const defaultLabel = NAMED_TERMINALS.has(c.type) ? "" : n;
    if (label !== defaultLabel && !def?.props.some((p) => p.key === "label")) bits.push(`label=${JSON.stringify(label)}`);
    lines.push(bits.join(" "));
  }
  const nets = buildNetlist(doc).nets.filter((nt) => nt.pins.length >= 2);
  if (nets.length) lines.push("");
  const netNames = new Set<string>();
  nets.forEach((nt, i) => {
    let name = (nt.tunnels[0] ?? "").replace(/[^A-Za-z0-9_]/g, "_");
    if (!NAME_RE.test(name)) name = `N${i + 1}`;
    for (let k = 2; netNames.has(name); k++) name = `${name}_${k}`;
    netNames.add(name);
    const refs = nt.pins.map((p) => `${nameOf.get(p.componentId)}.${p.pinId}`);
    lines.push(`net ${name} = ${refs.join(", ")}`);
  });
  for (const t of doc.texts) lines.push(`text ${JSON.stringify(t.text)} at=${t.x},${t.y}${t.fontSize ? ` size=${t.fontSize}` : ""}`);
  return lines.join("\n") + "\n";
}

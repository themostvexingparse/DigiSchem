/**
 * DSpec name resolution: component types (with friendly aliases), properties (checked against
 * the component's PropDefs) and pins (by id, display name, or bus bit index).
 */
import type { ComponentDef, PropDef } from "../model/component-def";
import { getDef, listDefs } from "../model/registry";
import type { ComponentInstance, PropValue, Rotation } from "../model/types";
import { worldPins, type WorldPin } from "../model/geometry";
import type { Attr, Value } from "./parser";

/** Common names people (and models) use for library types. */
export const TYPE_ALIASES: Record<string, string> = {
  input: "input-pin",
  in: "input-pin",
  output: "output-pin",
  out: "output-pin",
  inv: "not",
  inverter: "not",
  buffer: "buf",
  dff: "d-ff",
  "d-flip-flop": "d-ff",
  jkff: "jk-ff",
  tff: "t-ff",
  srff: "sr-ff",
  led: "probe",
  gnd: "ground",
  power: "vcc",
  label: "tunnel",
  "net-label": "tunnel",
  register8: "register",
  "7seg": "seven-segment",
  "7-segment": "seven-segment",
  button: "push-button",
  switch: "dip-switch",
  "schmitt": "schmitt-buffer",
  tgate: "transmission-gate",
  popcount: "bit-counter",
};

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** "did you mean X?" (or "") for `word` among `options`. */
export function suggest(word: string, options: readonly string[]): string {
  const w = word.toLowerCase();
  let best = "", bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(w, o.toLowerCase()) - (o.toLowerCase().startsWith(w) || w.startsWith(o.toLowerCase()) ? 1 : 0);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(w.length / 3)) ? ` Did you mean "${best}"?` : "";
}

export function resolveType(name: string): { def: ComponentDef } | { error: string } {
  const key = name.toLowerCase();
  const def = getDef(key) ?? getDef(TYPE_ALIASES[key] ?? "");
  if (def) return { def };
  const all = [...listDefs().map((d) => d.type), ...Object.keys(TYPE_ALIASES)];
  return { error: `unknown component type "${name}".${suggest(name, all)} Run "dspec reference" for the list.` };
}

function valueText(v: Value): string {
  return v.kind === "pair" ? `${v.a},${v.b}` : String(v.v);
}

/** Convert one attribute to a prop value for `pd`, or explain why not. */
export function propValue(pd: PropDef, v: Value | null): { value: PropValue } | { error: string } {
  if (pd.kind === "bool") {
    if (v === null) return { value: true };
    const t = valueText(v).toLowerCase();
    if (["true", "yes", "on", "1"].includes(t)) return { value: true };
    if (["false", "no", "off", "0"].includes(t)) return { value: false };
    return { error: `${pd.key} is on/off: write ${pd.key}=true or ${pd.key}=false` };
  }
  if (v === null) return { error: `${pd.key} needs a value, e.g. ${pd.key}=${pd.kind === "int" ? pd.min ?? 1 : pd.options?.[0]?.value ?? "..."}` };
  if (pd.kind === "int") {
    if (v.kind !== "num" || !Number.isInteger(v.v)) return { error: `${pd.key} must be a whole number${pd.min !== undefined ? ` from ${pd.min} to ${pd.max}` : ""}` };
    if ((pd.min !== undefined && v.v < pd.min) || (pd.max !== undefined && v.v > pd.max)) return { error: `${pd.key}=${v.v} is out of range (${pd.min} to ${pd.max})` };
    return { value: v.v };
  }
  if (pd.kind === "enum") {
    const t = valueText(v);
    const opt = pd.options?.find((o) => o.value.toLowerCase() === t.toLowerCase());
    if (!opt) return { error: `${pd.key}=${t} is not an option. Options: ${pd.options?.map((o) => o.value).join(", ")}` };
    return { value: opt.value };
  }
  return { value: valueText(v) };
}

export interface ResolvedPart {
  inst: ComponentInstance;
  def: ComponentDef;
  at: { x: number; y: number } | null;
  errors: { message: string; loc: { line: number; col: number } }[];
}

const RESERVED = new Set(["at", "rot", "rotation", "mirror", "size", "label"]);
const NAMED_TERMINALS = new Set(["input-pin", "output-pin", "tunnel"]);

/** Build the instance for `part NAME TYPE attrs`. */
export function resolvePart(name: string, def: ComponentDef, attrs: Attr[]): ResolvedPart {
  const errors: ResolvedPart["errors"] = [];
  const props: Record<string, PropValue> = {};
  let at: { x: number; y: number } | null = null;
  let rotation: Rotation = 0;
  let mirror = false;
  let size: { w: number; h: number } | undefined;
  let label = name;
  for (const a of attrs) {
    const key = a.key;
    // a component's own "label" property (VCC's rail name, a resistor's value) wins over the part label
    const ownLabel = key.toLowerCase() === "label" && def.props.some((p) => p.key === "label");
    if (RESERVED.has(key.toLowerCase()) && !ownLabel) {
      const k = key.toLowerCase();
      if (k === "at") {
        if (!a.value || a.value.kind !== "pair") errors.push({ message: "at needs X,Y in grid units of 10, e.g. at=120,40", loc: a.loc });
        else if (a.value.a % 10 !== 0 || a.value.b % 10 !== 0) errors.push({ message: `at=${a.value.a},${a.value.b} is off the 10-unit grid (use multiples of 10)`, loc: a.loc });
        else at = { x: a.value.a, y: a.value.b };
      } else if (k === "rot" || k === "rotation") {
        const n = a.value?.kind === "num" ? a.value.v : NaN;
        if (![0, 90, 180, 270].includes(n)) errors.push({ message: "rot must be 0, 90, 180 or 270 (degrees clockwise)", loc: a.loc });
        else rotation = n as Rotation;
      } else if (k === "mirror") {
        const r = propValue({ key: "mirror", label: "", kind: "bool" }, a.value);
        if ("error" in r) errors.push({ message: r.error, loc: a.loc });
        else mirror = r.value === true;
      } else if (k === "size") {
        const m = a.value ? /^(\d+)x(\d+)$/i.exec(valueText(a.value)) : null;
        if (!m) errors.push({ message: "size is WIDTHxHEIGHT in units of 10, e.g. size=80x60", loc: a.loc });
        else if (!def.resizable) errors.push({ message: `${def.type} cannot be resized`, loc: a.loc });
        else size = { w: Math.round(Number(m[1]) / 10) * 10, h: Math.round(Number(m[2]) / 10) * 10 };
      } else if (k === "label") {
        label = a.value ? valueText(a.value) : "";
      }
      continue;
    }
    const pd = def.props.find((p) => p.key.toLowerCase() === key.toLowerCase());
    if (!pd) {
      const keys = def.props.map((p) => p.key);
      errors.push({
        message: keys.length
          ? `${def.type} has no property "${key}".${suggest(key, keys)} Properties: ${keys.join(", ")}`
          : `${def.type} has no properties (only at, rot, mirror, label${def.resizable ? ", size" : ""})`,
        loc: a.loc,
      });
      continue;
    }
    const r = propValue(pd, a.value);
    if ("error" in r) errors.push({ message: r.error, loc: a.loc });
    else props[pd.key] = r.value;
  }
  // Terminals show their name inside the symbol: it defaults to the part name, and the part
  // label stays empty so the name is not drawn twice.
  if (NAMED_TERMINALS.has(def.type)) {
    if (props.name === undefined) props.name = name;
    if (!attrs.some((a) => a.key.toLowerCase() === "label")) label = "";
  }
  const inst: ComponentInstance = { id: name, type: def.type, x: at?.x ?? 0, y: at?.y ?? 0, rotation, props };
  if (label) inst.label = label;
  if (mirror) inst.mirror = true;
  if (size) inst.size = size;
  return { inst, def, at, errors };
}

/** Pin label as people write it: "Q'" for an inverted output named Q. */
function pinAliases(wp: WorldPin): string[] {
  const out = [wp.pin.id];
  const nm = wp.pin.name?.trim();
  if (nm) {
    out.push(nm);
    if (wp.pin.inverted) out.push(`${nm}'`, `~${nm}`, `n${nm}`, `${nm}_n`, `${nm}n`);
  }
  return out.map((s) => s.toLowerCase());
}

export type PinPick = { pin: WorldPin } | { error: string };

/**
 * Find a pin of `inst` by what the user wrote. `want`: when no pin is written, which one a bare
 * part name means: its only pin, its only output ("src"), or its only input ("dst").
 */
export function resolvePin(inst: ComponentInstance, written: string | null, want: "src" | "dst" | "any"): PinPick {
  const pins = worldPins(inst);
  const list = () => pins.map((p) => p.pin.id).join(", ");
  if (written === null) {
    if (pins.length === 1) return { pin: pins[0] };
    const outs = pins.filter((p) => p.pin.dir === "out");
    const ins = pins.filter((p) => p.pin.dir === "in");
    if (want === "src" && outs.length === 1) return { pin: outs[0] };
    if (want === "dst" && ins.length === 1) return { pin: ins[0] };
    return { error: `${inst.id} has ${pins.length} pins (${list()}): write which one, e.g. ${inst.id}.${(want === "dst" ? ins : outs)[0]?.pin.id ?? pins[0]?.pin.id}` };
  }
  const w = written.toLowerCase();
  // bit index: q[2] -> q2
  const bit = /^(.+)\[(\d+)\]$/.exec(w);
  const tries = bit ? [`${bit[1]}${bit[2]}`] : [w];
  for (const t of tries) {
    const byId = pins.find((p) => p.pin.id.toLowerCase() === t);
    if (byId) return { pin: byId };
  }
  for (const t of tries) {
    const byName = pins.filter((p) => pinAliases(p).includes(t));
    if (byName.length === 1) return { pin: byName[0] };
    if (byName.length > 1) return { error: `${inst.id}.${written} is ambiguous: pins ${byName.map((p) => p.pin.id).join(", ")} are all called that. Use the pin id.` };
  }
  if (bit && pins.some((p) => p.pin.id.toLowerCase() === bit[1] && (p.pin.width ?? 1) > 1)) {
    return { error: `${inst.id}.${bit[1]} is one bus pin; set pinMode=bits on ${inst.id} to reach single bits` };
  }
  return { error: `${inst.id} (${inst.type}) has no pin "${written}".${suggest(written, pins.map((p) => p.pin.id))} Pins: ${list()}` };
}

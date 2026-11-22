/**
 * The stripped circuit: what a schematic IS, with everything about how it is DRAWN removed.
 *
 * A SchematicDocument (or the DSpec it was built from) carries positions, rotations, sizes,
 * wire routes, labels and compiler directives. None of that changes what the circuit does. The
 * Circuit keeps only the parts (type and the properties that matter) and which pins are joined,
 * down to single bits: tunnels are dissolved into the nets they join, and a splitter's slices
 * are joined bit by bit to its bus, so every bit of every bus is one node. Simulation, static
 * checks (contention, floating inputs) and truth tables all work on this form.
 *
 * Connectivity comes from the document's stored links (what the user connected), not from the
 * drawing, so an accidental overlap never joins anything. `structuralKey` is the cheap test for
 * "did the connections change"; moving parts or re-drawing wires never changes it.
 */
import { registerBuiltinComponents } from "../components/library";
import type { PinDir } from "../model/component-def";
import { effectiveProps, geometryOf } from "../model/geometry";
import { getDef } from "../model/registry";
import type { PropValue, SchematicDocument } from "../model/types";
import { buildNetlist } from "../io/netlist";
import { partNames } from "../spec/decompile";

export interface CircuitPin {
  id: string;
  /** display name on the symbol (D, CLK, Q...) */
  name: string;
  dir: PinDir;
  width: number;
  /** active-low input (or complemented output) */
  inverted: boolean;
  clock: boolean;
  /** the node of each bit, least significant first */
  bits: number[];
  /** the net this pin is on (index into Circuit.nets), or -1 when it is not connected */
  net: number;
}

export interface CircuitPart {
  /** the component id in the document */
  id: string;
  /** readable unique name (label, terminal name, or a generated U1, FF2...) */
  name: string;
  type: string;
  /** effective properties, without the drawing-only ones (size, label text, title) */
  props: Record<string, PropValue>;
  pins: CircuitPin[];
}

export interface CircuitNet {
  /** readable unique name: a tunnel's name, else the driving pin's (`G1_out`), else the first pin's */
  name: string;
  width: number;
  /** member pins as `part index, pin index` */
  pins: { part: number; pin: number }[];
  /** tunnel names that joined this net */
  tunnels: string[];
}

export interface CircuitIssue {
  kind: "width-mismatch";
  net: number;
  message: string;
}

export interface Circuit {
  name: string;
  /** every part except tunnels, in document order */
  parts: CircuitPart[];
  /** nets with at least one pin */
  nets: CircuitNet[];
  /** number of bit nodes */
  nodes: number;
  /** problems found while building (more come from checkCircuit) */
  issues: CircuitIssue[];
  /** equal for two documents exactly when they have the same parts and the same connections */
  key: string;
}

/** Properties that only change how a part is drawn. */
const DRAWING_PROPS = new Set(["label", "title"]);
/**
 * Properties that only name things: a rename is not a structural change. (A tunnel's name is
 * different: tunnels with the same name are connected.)
 */
const NAME_PROPS = new Set(["name", "inputNames", "outputNames"]);

function keyProps(c: SchematicDocument["components"][number]): Record<string, PropValue> {
  const p = semanticProps(c);
  if (c.type === "tunnel") return p;
  const out: Record<string, PropValue> = {};
  for (const k of Object.keys(p)) if (!NAME_PROPS.has(k)) out[k] = p[k];
  return out;
}

function semanticProps(c: SchematicDocument["components"][number]): Record<string, PropValue> {
  const all = effectiveProps(c);
  const out: Record<string, PropValue> = {};
  for (const k of Object.keys(all).sort()) if (!k.startsWith("_") && !DRAWING_PROPS.has(k)) out[k] = all[k];
  return out;
}

/** Splitter slices (the same rule as the library's splitter). */
export function splitterSlices(width: number, fanOut: number): { lo: number; width: number }[] {
  const out: { lo: number; width: number }[] = [];
  // the library's splitter rounds and clamps its properties the same way
  width = Math.max(2, Math.min(32, Math.round(width)));
  const n = Math.min(Math.max(2, Math.min(32, Math.round(Number.isFinite(fanOut) ? fanOut : 4))), width);
  if (n >= width) {
    for (let i = 0; i < width; i++) out.push({ lo: i, width: 1 });
    return out;
  }
  const base = Math.floor(width / n), rem = width % n;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const w = base + (i < rem ? 1 : 0);
    out.push({ lo, width: w });
    lo += w;
  }
  return out;
}

/**
 * The cheap structural fingerprint: each part's id, type and meaningful properties, and the
 * groups of pins the links join (wires are only the means of joining, so a wire being split,
 * merged, re-routed or renamed does not change it). Positions, rotations, sizes, labels and
 * names (other than tunnel names, which connect) are not part of it.
 */
export function structuralKey(doc: SchematicDocument): string {
  registerBuiltinComponents();
  const parts = doc.components
    .map((c) => `${c.id}\u0001${c.type}\u0001${JSON.stringify(keyProps(c))}`)
    .sort();
  const groups = doc.links ? pinGroupsFromLinks(doc.links) : pinGroupsFromNetlist(doc);
  return parts.join("\u0002") + "\u0003" + groups.join("\u0002");
}

function pinGroupsFromLinks(links: readonly (readonly [string, string])[]): string[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    for (let p = parent.get(r); p !== undefined && p !== r; p = parent.get(r)) r = p;
    for (let c = x; c !== r; ) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const [a, b] of links) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const t of parent.keys()) {
    if (!t.startsWith("p:")) continue;
    const r = find(t);
    const g = groups.get(r);
    if (g) g.push(t);
    else groups.set(r, [t]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort().join(" ")).sort();
}

function pinGroupsFromNetlist(doc: SchematicDocument): string[] {
  return buildNetlist(doc, "geometric")
    .nets.map((n) => n.pins.map((p) => `p:${p.componentId}|${p.pinId}`).sort())
    .filter((g) => g.length > 1)
    .map((g) => g.join(" "))
    .sort();
}

/** Build the stripped circuit of a document. */
export function extractCircuit(doc: SchematicDocument): Circuit {
  registerBuiltinComponents();
  const names = partNames(doc);
  const netlist = buildNetlist(doc);
  const netOfPin = new Map<string, number>();
  netlist.nets.forEach((n, i) => {
    for (const p of n.pins) netOfPin.set(`${p.componentId}|${p.pinId}`, i);
  });

  // ---- parts (tunnels dissolve into their nets) -----------------------------------------------
  const parts: CircuitPart[] = [];
  for (const c of doc.components) {
    if (c.type === "tunnel" || !getDef(c.type)) continue;
    const g = geometryOf(c);
    parts.push({
      id: c.id,
      name: names.get(c.id) ?? c.id,
      type: c.type,
      props: semanticProps(c),
      pins: g.pins.map((p) => ({
        id: p.id,
        name: p.name,
        dir: p.dir,
        width: Math.max(1, p.width ?? 1),
        inverted: !!p.inverted,
        clock: !!p.clock,
        bits: [],
        net: -1,
      })),
    });
  }

  // ---- nets: only those with a part pin; renumbered --------------------------------------------
  const nets: CircuitNet[] = [];
  const netIndex = new Map<number, number>();
  const issues: CircuitIssue[] = [];
  parts.forEach((part, pi) =>
    part.pins.forEach((pin, k) => {
      const raw = netOfPin.get(`${part.id}|${pin.id}`);
      if (raw === undefined) return;
      let ni = netIndex.get(raw);
      if (ni === undefined) {
        ni = nets.length;
        netIndex.set(raw, ni);
        nets.push({ name: "", width: 1, pins: [], tunnels: netlist.nets[raw].tunnels });
      }
      nets[ni].pins.push({ part: pi, pin: k });
      pin.net = ni;
    }),
  );
  // A net only a single pin is on is an unconnected pin, unless tunnels make it a named net.
  for (const part of parts) for (const pin of part.pins) if (pin.net >= 0 && nets[pin.net].pins.length < 2 && !nets[pin.net].tunnels.length) pin.net = -2;
  const keep = nets.map((n) => n.pins.length >= 2 || n.tunnels.length > 0);
  const renum = new Map<number, number>();
  const kept: CircuitNet[] = [];
  nets.forEach((n, i) => {
    if (keep[i]) {
      renum.set(i, kept.length);
      kept.push(n);
    }
  });
  for (const part of parts) for (const pin of part.pins) pin.net = pin.net >= 0 ? renum.get(pin.net)! : -1;

  // ---- bit nodes: a node per bit of every net, then splitters join slices to their bus ---------
  const pinOf = (r: { part: number; pin: number }) => parts[r.part].pins[r.pin];
  const netBase: number[] = [];
  let nodes = 0;
  kept.forEach((n, ni) => {
    const widths = n.pins.map((r) => pinOf(r).width);
    n.width = Math.max(1, ...widths);
    if (new Set(widths).size > 1) {
      const list = n.pins.map((r) => `${parts[r.part].name}.${pinOf(r).id}[${pinOf(r).width}]`).join(", ");
      issues.push({ kind: "width-mismatch", net: ni, message: `pins of different widths are joined: ${list}` });
    }
    netBase.push(nodes);
    nodes += n.width;
  });
  for (const part of parts)
    for (const pin of part.pins) {
      if (pin.net >= 0) pin.bits = Array.from({ length: pin.width }, (_, b) => netBase[pin.net] + b);
      else {
        pin.bits = Array.from({ length: pin.width }, (_, b) => nodes + b);
        nodes += pin.width;
      }
    }
  const parent = Array.from({ length: nodes }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const part of parts) {
    if (part.type !== "splitter") continue;
    const bus = part.pins.find((p) => p.id === "bus");
    if (!bus) continue;
    const slices = splitterSlices(bus.width, Number(part.props.fanOut ?? 4));
    slices.forEach((s, i) => {
      const pin = part.pins.find((p) => p.id === `b${i}`);
      if (!pin) return;
      for (let b = 0; b < Math.min(s.width, pin.width); b++) {
        const x = find(pin.bits[b]), y = find(bus.bits[s.lo + b]);
        if (x !== y) parent[x] = y;
      }
    });
  }
  const compact = new Map<number, number>();
  for (let i = 0; i < nodes; i++) {
    const r = find(i);
    if (!compact.has(r)) compact.set(r, compact.size);
  }
  for (const part of parts) for (const pin of part.pins) pin.bits = pin.bits.map((b) => compact.get(find(b))!);

  // ---- net names ---------------------------------------------------------------------------------
  const used = new Set<string>();
  const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
  kept.forEach((n) => {
    const driver = n.pins.find((r) => pinOf(r).dir === "out") ?? n.pins[0];
    let base = n.tunnels.length ? ident(n.tunnels[0]) : driver ? ident(`${parts[driver.part].name}_${pinOf(driver).id}`) : "n";
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
    used.add(name);
    n.name = name;
  });

  return { name: doc.name, parts, nets: kept, nodes: compact.size, issues, key: structuralKey(doc) };
}

const NAMED = new Set(["input-pin", "output-pin"]);

function fmt(v: PropValue): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return /^[A-Za-z0-9_.+]+$/.test(v) && !/^(true|false|on|off|yes|no)$/i.test(v) ? v : JSON.stringify(v);
}

/**
 * The circuit as plain text in DSpec syntax: `part` lines with only the properties that differ
 * from the defaults, and `net` lines listing the pins each net joins. No positions, no labels,
 * no directives. Building it with the compiler gives a drawing with the same connections.
 */
export function circuitText(c: Circuit): string {
  const lines: string[] = [`# ${c.name}: parts and connections only`];
  for (const p of c.parts) {
    const def = getDef(p.type);
    const bits = [`part ${p.name} ${p.type}`];
    for (const [k, v] of Object.entries(p.props)) {
      if (k === "name" && NAMED.has(p.type) && v === p.name) continue;
      if (def && def.defaultProps[k] === v && !(k === "name" && NAMED.has(p.type))) continue;
      bits.push(`${k}=${fmt(v)}`);
    }
    lines.push(bits.join(" "));
  }
  const nets = c.nets.filter((n) => n.pins.length >= 2);
  if (nets.length) lines.push("");
  for (const n of [...nets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
    lines.push(`net ${n.name} = ${n.pins.map((r) => `${c.parts[r.part].name}.${c.parts[r.part].pins[r.pin].id}`).join(", ")}`);
  return lines.join("\n") + "\n";
}

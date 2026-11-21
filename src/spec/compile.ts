/**
 * DSpec compiler: spec text -> SchematicDocument (see docs/SPEC-LANGUAGE.md).
 *
 * Pipeline: parse -> directives -> resolve parts -> build nets -> electrical checks -> place ->
 * add parts one at a time (routing and compacting as the @compact mode says) -> verify.
 * The result's connections are exactly the spec's: the drawing (geometric contacts) and the
 * stored links both have to equal the spec netlist, or the compile reports an error.
 */
import { registerBuiltinComponents } from "../components/library";
import { worldPins } from "../model/geometry";
import { canonicalLinks, connectionConflicts, driverTerms } from "../model/links";
import { effectiveProps } from "../model/geometry";
import type { ComponentInstance, SchematicDocument, TextNote } from "../model/types";
import { buildNetlist } from "../io/netlist";
import { packSchematic, validateCompaction } from "../layout/pack";
import { netSignature } from "../layout/realign";
import { parseSpec, type Attr, type Diagnostic, type Loc, type RefNode, type Statement } from "./parser";
import { resolvePart, resolvePin, resolveType, suggest } from "./resolve";
import { collides, moveToFreeSpot, neighborSpot, placeParts, type PlaceItem } from "./place";
import { routeNet, type NetState } from "./route";

export type CompactMode = "never" | "end" | "each" | "every" | "group";

export interface Settings {
  compact: CompactMode;
  every: number;
  layout: "flow" | "grid" | "manual";
  route: "clean" | "direct" | "tunnel";
  fallback: "tunnel" | "direct" | "error";
  gapPart: number;
  gapWire: number;
  colGap: number;
  rowGap: number;
  budgetMs: number;
  strict: boolean;
  warnUnconnected: boolean;
  reuse: boolean;
  name: string;
}

export const DEFAULT_SETTINGS: Settings = {
  compact: "end",
  every: 5,
  layout: "flow",
  route: "clean",
  fallback: "tunnel",
  gapPart: 2,
  gapWire: 1,
  colGap: 6,
  rowGap: 3,
  budgetMs: 1500,
  strict: false,
  warnUnconnected: true,
  reuse: true,
  name: "Untitled",
};

export interface CompileOptions {
  /** A previous build: parts with the same name and type keep their place (unless at=... is given). */
  previous?: SchematicDocument | null;
  /** Called between phases, e.g. to report progress. */
  onPhase?: (phase: string) => void;
}

export interface CompileStats {
  parts: number;
  nets: number;
  wires: number;
  tunnels: number;
  compactions: number;
  compactionsApplied: number;
  ms: { total: number; place: number; route: number; compact: number; verify: number };
}

export interface CompileResult {
  doc: SchematicDocument | null;
  diagnostics: Diagnostic[];
  stats: CompileStats;
}

interface PartDecl {
  name: string;
  loc: Loc;
  typeLoc: Loc;
  type: string;
  attrs: Attr[];
  settings: Settings;
  group: string | null;
}

interface NetDecl {
  name: string | null;
  refs: RefNode[];
  arrow: boolean;
  loc: Loc;
  settings: Settings;
}

type Event = { kind: "part"; index: number } | { kind: "groupEnd"; settings: Settings };

const DIRECTIVES = ["compact", "layout", "route", "fallback", "gap", "spacing", "budget", "name", "strict", "warn", "reuse"];

function word(a: Attr | undefined): string | null {
  if (!a) return null;
  if (a.value === null) return a.key.toLowerCase();
  return null;
}

function attrNum(a: Attr): number | null {
  return a.value?.kind === "num" ? a.value.v : null;
}

/** Apply one directive to `s` (a copy is returned). */
function applyDirective(s0: Settings, name: string, args: Attr[], err: (m: string, loc: Loc) => void, loc: Loc): Settings {
  const s = { ...s0 };
  const first = word(args[0]);
  const oneOf = <T extends string>(opts: readonly T[], what: string): T | null => {
    if (first && (opts as readonly string[]).includes(first)) return first as T;
    err(`@${name} takes one of: ${opts.join(", ")}${what}`, args[0]?.loc ?? loc);
    return null;
  };
  switch (name) {
    case "compact": {
      if (args[0]?.key.toLowerCase() === "every") {
        const n = args[0].value ? attrNum(args[0]) : args[1] ? Number(args[1].key) : NaN;
        if (!n || n < 1 || !Number.isInteger(n)) err("@compact every=N needs a whole number of parts, e.g. @compact every=5", args[0].loc);
        else {
          s.compact = "every";
          s.every = n;
        }
        break;
      }
      const m = oneOf(["never", "end", "each", "group", "every"] as const, " (every=N)");
      if (m) s.compact = m;
      break;
    }
    case "layout": {
      const m = oneOf(["flow", "grid", "manual"] as const, "");
      if (m) s.layout = m;
      break;
    }
    case "route": {
      const m = oneOf(["clean", "direct", "tunnel"] as const, "");
      if (m) s.route = m;
      break;
    }
    case "fallback": {
      const m = oneOf(["tunnel", "direct", "error"] as const, "");
      if (m) s.fallback = m;
      break;
    }
    case "gap":
    case "spacing": {
      for (const a of args) {
        const n = attrNum(a);
        const k = a.key.toLowerCase();
        const keys = name === "gap" ? ["part", "wire"] : ["col", "row"];
        if (!keys.includes(k) || n === null || n < 0 || n > 40 || !Number.isInteger(n)) {
          err(`@${name} takes ${keys.map((x) => `${x}=N`).join(" ")} (grid cells, 0 to 40)`, a.loc);
          continue;
        }
        if (k === "part") s.gapPart = n;
        else if (k === "wire") s.gapWire = n;
        else if (k === "col") s.colGap = n;
        else s.rowGap = n;
      }
      break;
    }
    case "budget": {
      const a = args[0];
      const n = a ? (a.value ? attrNum(a) : Number(a.key)) : null;
      if (!n || n < 50 || n > 60000) err("@budget ms=N sets the compaction time per run (50 to 60000 ms)", a?.loc ?? loc);
      else s.budgetMs = n;
      break;
    }
    case "name": {
      const a = args[0];
      if (!a) err('@name needs a name, e.g. @name "Full adder"', loc);
      else s.name = a.value?.kind === "str" ? a.value.v : a.key;
      break;
    }
    case "strict":
    case "reuse": {
      const v = first ?? "on";
      if (!["on", "off", "true", "false"].includes(v)) err(`@${name} on or @${name} off`, args[0]?.loc ?? loc);
      else if (name === "strict") s.strict = v === "on" || v === "true";
      else s.reuse = v === "on" || v === "true";
      break;
    }
    case "warn": {
      for (const a of args) {
        if (a.key.toLowerCase() !== "unconnected" || !a.value) {
          err("@warn unconnected=on|off", a.loc);
          continue;
        }
        const v = a.value.kind === "word" || a.value.kind === "str" ? a.value.v.toLowerCase() : String(a.value.kind === "num" ? a.value.v : "");
        s.warnUnconnected = v === "on" || v === "true" || v === "1";
      }
      break;
    }
    default:
      err(`unknown directive @${name}.${suggest(name, DIRECTIVES)} Directives: ${DIRECTIVES.map((d) => "@" + d).join(", ")}`, loc);
  }
  return s;
}

class UF {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = x;
    while (this.p.has(r)) r = this.p.get(r)!;
    let c = x;
    while (this.p.has(c) && this.p.get(c) !== r) {
      const n = this.p.get(c)!;
      this.p.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function compileSpec(source: string, opts: CompileOptions = {}): CompileResult {
  registerBuiltinComponents();
  const t0 = now();
  const diags: Diagnostic[] = [];
  const stats: CompileStats = { parts: 0, nets: 0, wires: 0, tunnels: 0, compactions: 0, compactionsApplied: 0, ms: { total: 0, place: 0, route: 0, compact: 0, verify: 0 } };
  const error = (message: string, loc: Loc) => diags.push({ severity: "error", message, line: loc.line, col: loc.col });
  const warn = (message: string, loc: Loc) => diags.push({ severity: "warning", message, line: loc.line, col: loc.col });
  const note = (message: string, loc: Loc) => diags.push({ severity: "note", message, line: loc.line, col: loc.col });
  const done = (doc: SchematicDocument | null): CompileResult => {
    stats.ms.total = Math.round(now() - t0);
    const sev = { error: 0, warning: 1, note: 2 };
    diags.sort((a, b) => a.line - b.line || a.col - b.col || sev[a.severity] - sev[b.severity]);
    return { doc: diags.some((d) => d.severity === "error") ? null : doc, diagnostics: diags, stats };
  };

  // ---- 1. parse + directives -------------------------------------------------------------
  const parsed = parseSpec(source);
  diags.push(...parsed.diagnostics);
  const parts: PartDecl[] = [];
  const netDecls: NetDecl[] = [];
  const texts: { text: string; attrs: Attr[]; loc: Loc }[] = [];
  const events: Event[] = [];
  let settings = { ...DEFAULT_SETTINGS };
  const walk = (list: Statement[], group: string | null) => {
    for (const st of list) {
      if (st.kind === "directive") settings = applyDirective(settings, st.name, st.args, error, st.loc);
      else if (st.kind === "part") {
        for (const n of st.names) {
          events.push({ kind: "part", index: parts.length });
          parts.push({ name: n.name, loc: n.loc, typeLoc: st.typeLoc, type: st.type, attrs: st.attrs, settings, group });
        }
      } else if (st.kind === "net") netDecls.push({ name: st.name, refs: st.refs, arrow: st.arrow, loc: st.loc, settings });
      else if (st.kind === "text") texts.push({ text: st.text, attrs: st.attrs, loc: st.loc });
      else if (st.kind === "group") {
        const saved = settings;
        walk(st.body, st.name);
        events.push({ kind: "groupEnd", settings });
        settings = saved; // directives inside a group stay inside it
      }
    }
  };
  walk(parsed.statements, null);
  const final = settings;

  // ---- 2. parts ---------------------------------------------------------------------------
  const insts = new Map<string, { inst: ComponentInstance; decl: PartDecl; at: boolean }>();
  const broken = new Set<string>(); // declared, but the declaration had an error (no follow-on errors)
  for (const p of parts) {
    if (insts.has(p.name)) {
      error(`part ${p.name} is declared twice (first on line ${insts.get(p.name)!.decl.loc.line})`, p.loc);
      continue;
    }
    const t = resolveType(p.type);
    if ("error" in t) {
      error(t.error, p.typeLoc);
      broken.add(p.name);
      continue;
    }
    const r = resolvePart(p.name, t.def, p.attrs);
    for (const e of r.errors) error(e.message, e.loc);
    if (p.settings.layout === "manual" && !r.at) error(`@layout manual: part ${p.name} needs at=X,Y`, p.loc);
    insts.set(p.name, { inst: r.inst, decl: p, at: !!r.at });
  }

  // ---- 3. nets ----------------------------------------------------------------------------
  const uf = new UF();
  const netName = new Map<string, string>(); // root terminal -> declared name
  const termLoc = new Map<string, Loc>();
  const netSettings = new Map<string, Settings>();
  const allTerms: string[] = [];
  const pinsUsedBy = new Map<string, string>(); // term -> first named net using it
  for (const nd of netDecls) {
    const terms: string[] = [];
    nd.refs.forEach((ref, i) => {
      const part = insts.get(ref.part);
      if (!part) {
        if (!broken.has(ref.part)) error(`unknown part "${ref.part}".${suggest(ref.part, [...insts.keys()])}`, ref.loc);
        return;
      }
      const want = nd.arrow ? (i === 0 ? "src" : "dst") : "any";
      const r = resolvePin(part.inst, ref.pin, want);
      if ("error" in r) {
        error(r.error, ref.loc);
        return;
      }
      const t = `p:${ref.part}|${r.pin.pin.id}`;
      terms.push(t);
      if (!termLoc.has(t)) {
        termLoc.set(t, ref.loc);
        allTerms.push(t);
      }
    });
    if (nd.name) {
      const anchor = `net:${nd.name}`;
      terms.push(anchor);
      for (const t of terms) if (t !== anchor && pinsUsedBy.has(t) && pinsUsedBy.get(t) !== nd.name) {
        warn(`${t.slice(2).replace("|", ".")} is in nets ${pinsUsedBy.get(t)} and ${nd.name}, so they are one net`, nd.loc);
      }
      for (const t of terms) if (t !== anchor && !pinsUsedBy.has(t)) pinsUsedBy.set(t, nd.name);
    }
    if (terms.length === 0) continue;
    for (const t of terms) uf.union(terms[0], t);
    for (const t of terms) if (!netSettings.has(t)) netSettings.set(t, nd.settings);
    if (nd.name) netName.set(`net:${nd.name}`, nd.name);
  }
  // group terminals by root
  const groups = new Map<string, string[]>();
  const groupNames = new Map<string, string[]>();
  const groupLoc = new Map<string, Loc>();
  for (const t of allTerms) {
    const r = uf.find(t);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(t);
  }
  for (const [anchor, name] of netName) {
    const r = uf.find(anchor);
    (groupNames.get(r) ?? groupNames.set(r, []).get(r)!).push(name);
  }
  for (const nd of netDecls) for (const ref of nd.refs) {
    const part = insts.get(ref.part);
    if (!part) continue;
    const r = resolvePin(part.inst, ref.pin, "any");
    if ("pin" in r) {
      const root = uf.find(`p:${ref.part}|${r.pin.pin.id}`);
      if (!groupLoc.has(root)) groupLoc.set(root, nd.loc);
    }
  }
  if (diags.some((d) => d.severity === "error")) return done(null);

  // doc with all parts at the origin (for electrical checks and placement)
  const docParts = [...insts.values()].map((x) => x.inst);
  const scratch: SchematicDocument = { format: "digischem", version: 1, name: final.name, grid: 10, components: docParts, wires: [], texts: [] };
  const drivers = driverTerms(scratch);
  const nets: NetState[] = [];
  const usedNames = new Set<string>();
  const netOfTerm = new Map<string, NetState>();
  for (const [root, terms] of groups) {
    const names = groupNames.get(root) ?? [];
    const drv = terms.filter((t) => drivers.has(t));
    const pins = [...drv, ...terms.filter((t) => !drivers.has(t))];
    let name = names[0] ?? `${pins[0].slice(2).replace("|", "_")}`;
    const base = name;
    for (let k = 2; usedNames.has(name); k++) name = `${base}_${k}`;
    usedNames.add(name);
    const s = netSettings.get(terms[0]) ?? final;
    const loc = groupLoc.get(root) ?? termLoc.get(terms[0])!;
    const state: NetState = { name, pins, attached: new Set(), wires: [], mode: s.route, fallback: s.fallback, tunneled: false, tunnelName: name, counter: 0, tunnels: [], failed: false };
    nets.push(state);
    for (const t of pins) netOfTerm.set(t, state);
    // electrical checks
    const sev = s.strict ? error : warn;
    if (drv.length > 1) {
      sev(`net ${name} has ${drv.length} outputs driving it (${drv.map((t) => t.slice(2).replace("|", ".")).join(", ")}). Outputs fight when they disagree; drive a net from one output, or use a multiplexer or tristate buffers`, loc);
    }
    if (pins.length === 1) sev(`net ${name} connects only one pin (${pins[0].slice(2).replace("|", ".")})`, loc);
  }
  stats.parts = docParts.length;
  stats.nets = nets.length;
  // tunnel names the user placed: same-named tunnels are one net
  const userTunnelNames = new Set(docParts.filter((c) => c.type === "tunnel").map((c) => String(effectiveProps(c).name ?? "").trim()));
  for (const n of nets) {
    let tn = n.name;
    for (let k = 2; userTunnelNames.has(tn); k++) tn = `${n.name}_${k}`;
    n.tunnelName = tn;
  }
  // unconnected inputs
  for (const { inst, decl } of insts.values()) {
    if (!decl.settings.warnUnconnected) continue;
    const loose = worldPins(inst).filter((wp) => wp.pin.dir === "in" && !netOfTerm.has(`p:${inst.id}|${wp.pin.id}`)).map((wp) => wp.pin.id);
    if (loose.length) note(`${inst.id}: input${loose.length > 1 ? "s" : ""} ${loose.join(", ")} not connected`, decl.loc);
  }

  // ---- 4. placement ----------------------------------------------------------------------
  opts.onPhase?.("place");
  let tp = now();
  const prev = final.reuse ? opts.previous ?? null : null;
  const items: PlaceItem[] = [];
  for (const { inst, decl, at } of insts.values()) {
    let fixed = at;
    const old = prev?.components.find((c) => c.id === inst.id && c.type === inst.type);
    if (!at && old) {
      inst.x = old.x;
      inst.y = old.y;
      if (!decl.attrs.some((a) => ["rot", "rotation"].includes(a.key.toLowerCase()))) inst.rotation = old.rotation;
      fixed = true;
    }
    items.push({ inst, fixed, mode: decl.settings.layout });
  }
  placeParts(items, nets.map((n) => n.pins), { colGap: final.colGap, rowGap: final.rowGap });
  const pinned = new Set(items.filter((it) => it.fixed).map((it) => it.inst.id));
  stats.ms.place = Math.round(now() - tp);

  // ---- 5. build: add parts in order, route + compact as directed ----------------------------
  const doc: SchematicDocument = { format: "digischem", version: 1, name: final.name, grid: 10, components: [], wires: [], texts: [], links: [] };
  let links: [string, string][] = [];
  const ctx: import("./route").RouteContext = {
    doc,
    links,
    onWarn: (n: NetState, m: string) => warn(m, groupLocOf(n)),
    onError: (n: NetState, m: string) => error(m, groupLocOf(n)),
  };
  const netLoc = new Map(nets.map((n) => [n, termLoc.get(n.pins[0])!]));
  function groupLocOf(n: NetState): Loc {
    return netLoc.get(n) ?? { line: 1, col: 1 };
  }
  const routeAll = () => {
    const tr = now();
    ctx.doc = doc;
    ctx.links = links;
    for (const n of nets) routeNet(ctx, n);
    stats.ms.route += Math.round(now() - tr);
  };
  /** `roomy`: an intermediate pass in an incremental mode, leaving lanes for wires still to come */
  const compactNow = (s: Settings, roomy = false) => {
    routeAll();
    const tc = now();
    stats.compactions++;
    doc.links = canonicalLinks(links);
    const before = JSON.parse(JSON.stringify(doc)) as SchematicDocument;
    // parts placed with at=... or kept from the previous build are pinned: pack only the rest
    // (and the wires of their nets)
    let ids: Set<string> | undefined;
    if (pinned.size) {
      const free = doc.components.filter((c) => !pinned.has(c.id)).map((c) => c.id);
      if (!free.length) {
        stats.ms.compact += Math.round(now() - tc);
        return;
      }
      ids = new Set(free);
      for (const n of nets) if (n.pins.some((t) => ids!.has(t.slice(2, t.indexOf("|"))))) for (const w of n.wires) ids.add(w);
      for (const n of nets) for (const t of n.tunnels) ids.add(t);
    }
    const popts = { componentGap: s.gapPart + (roomy ? 2 : 0), wireGap: s.gapWire + (roomy ? 1 : 0), timeBudgetMs: s.budgetMs, ...(ids ? { ids } : {}) };
    try {
      const res = packSchematic(before, popts);
      const problems = validateCompaction(before, res, popts);
      if (!problems.length && res.qualityAfter.total < res.qualityBefore.total && verify(res.doc).length === 0) {
        doc.components = res.doc.components;
        doc.wires = res.doc.wires;
        links = canonicalLinks(res.doc.links ?? links);
        refreshNetWires();
        stats.compactionsApplied++;
      }
    } catch (e) {
      warn(`compaction failed and was skipped: ${(e as Error).message}`, { line: 1, col: 1 });
    }
    stats.ms.compact += Math.round(now() - tc);
  };
  /** after compaction, wire ids of each net from the links (the packer may merge wires) */
  const refreshNetWires = () => {
    const u = new UF();
    for (const [a, b] of links) u.union(a, b);
    const byRoot = new Map<string, string[]>();
    for (const w of doc.wires) {
      const r = u.find(`w:${w.id}`);
      (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(w.id);
    }
    for (const n of nets) n.wires = n.pins.length ? (byRoot.get(u.find(n.pins[0])) ?? []) : [];
  };
  /**
   * In a compacted layout a new part may have no room for its wires: route its nets now, and if
   * any pin cannot be reached cleanly, undo that and try the part a little farther out.
   */
  const findRoutableSpot = (inst: ComponentInstance, s: Settings) => {
    const mine = nets.filter((n) => n.pins.some((t) => t.startsWith(`p:${inst.id}|`)) && !n.tunneled && n.mode !== "tunnel");
    if (!mine.length) return;
    const x0 = inst.x, y0 = inst.y;
    const offsets: [number, number][] = [[0, 0]];
    for (const k of [2, 4]) offsets.push([2 * k, 0], [0, 2 * k], [0, -2 * k]);
    for (const [dx, dy] of offsets) {
      inst.x = x0 + dx * 10;
      inst.y = y0 + dy * 10;
      if ((dx || dy) && collides({ ...doc, components: doc.components.filter((c) => c !== inst) }, inst, s.gapPart)) continue;
      const snap = { wires: JSON.stringify(doc.wires), links: links.slice(), nets: mine.map((n) => ({ n, attached: new Set(n.attached), wires: n.wires.slice(), counter: n.counter })) };
      ctx.doc = doc;
      ctx.links = links;
      ctx.probe = true;
      for (const n of mine) {
        n.failed = false;
        routeNet(ctx, n);
      }
      ctx.probe = false;
      const ok = mine.every((n) => !n.failed);
      // keep the routes only if they all worked; otherwise roll back and try the next spot
      doc.wires = JSON.parse(snap.wires);
      links.splice(0, links.length, ...snap.links);
      for (const { n, attached, wires, counter } of snap.nets) {
        n.attached = attached;
        n.wires = wires;
        n.counter = counter;
        n.failed = false;
      }
      if (ok) return;
    }
    inst.x = x0;
    inst.y = y0;
  };
  // When compaction runs: "each" after every part; "every=N" after every N parts (and once more
  // at the end for the rest); "group" when a group closes; "end" once after the last part.
  let sinceCompact = 0;
  let needEnd = false;
  let lastMode: Settings | null = null;
  let incremental = false;
  for (const ev of events) {
    if (ev.kind === "groupEnd") {
      if (ev.settings.compact === "group" && sinceCompact > 0) {
        compactNow(ev.settings, true);
        incremental = true;
        sinceCompact = 0;
        needEnd = false;
      }
      continue;
    }
    const decl = parts[ev.index];
    const entry = insts.get(decl.name);
    if (!entry || entry.decl !== decl) continue;
    const inst = entry.inst;
    const isFixed = items.find((it) => it.inst === inst)!.fixed;
    if (!isFixed && stats.compactionsApplied > 0) {
      // the layout was compacted since the plan was made: go next to the connected parts
      const spot = neighborSpot(doc, inst, nets.map((n) => n.pins), decl.settings.colGap);
      if (spot) {
        inst.x = spot.x;
        inst.y = spot.y;
      }
    }
    if (!isFixed && doc.components.length) moveToFreeSpot(doc, inst, decl.settings.gapPart);
    doc.components.push(inst);
    if (!isFixed && stats.compactionsApplied > 0) findRoutableSpot(inst, decl.settings);
    sinceCompact++;
    const s = decl.settings;
    lastMode = s;
    if (s.compact === "each" || (s.compact === "every" && sinceCompact >= s.every)) {
      compactNow(s, true);
      incremental = true;
      sinceCompact = 0;
      needEnd = false;
    } else if (s.compact === "end") needEnd = true;
  }
  // incremental passes left room for wires still to come: one final pass with the real gaps
  if ((sinceCompact > 0 && (needEnd || lastMode?.compact === "every")) || (incremental && final.compact !== "never")) compactNow(final.compact === "never" ? lastMode! : final);
  routeAll();
  doc.links = canonicalLinks(links);

  // texts
  for (const t of texts) {
    const at = t.attrs.find((a) => a.key.toLowerCase() === "at");
    const size = t.attrs.find((a) => a.key.toLowerCase() === "size");
    for (const a of t.attrs) if (!["at", "size"].includes(a.key.toLowerCase())) error(`text takes at=X,Y and size=N, not ${a.key}`, a.loc);
    let x = 0, y = 0;
    if (at?.value?.kind === "pair") {
      x = at.value.a;
      y = at.value.b;
    } else {
      const top = doc.components.length ? Math.min(...doc.components.map((c) => c.y)) : 0;
      y = top - 40 - 20 * texts.indexOf(t);
      x = doc.components.length ? Math.min(...doc.components.map((c) => c.x)) : 0;
    }
    const note_: TextNote = { id: `text_${texts.indexOf(t) + 1}`, x, y, text: t.text };
    if (size?.value?.kind === "num") note_.fontSize = size.value.v;
    doc.texts.push(note_);
  }

  // ---- 6. verify --------------------------------------------------------------------------
  const tv = now();
  for (const m of verify(doc)) error(m, { line: 1, col: 1 });
  stats.ms.verify = Math.round(now() - tv);
  stats.wires = doc.wires.length;
  stats.tunnels = nets.reduce((s, n) => s + n.tunnels.length, 0);
  doc.meta = { generator: "dspec", dspec: source, dspecNets: netSignature(doc) };
  return done(doc);

  /** The drawing and the links must both connect exactly what the spec connects. */
  function verify(d: SchematicDocument): string[] {
    const out: string[] = [];
    const spec = new Map<string, string>(); // pin term -> net
    for (const n of nets) for (const t of n.pins) spec.set(t, n.name);
    for (const n of nets) for (const id of n.tunnels) spec.set(`p:${id}|net`, n.name);
    // user tunnels with the same name join nets
    const tunnelUf = new UF();
    for (const c of d.components) {
      if (c.type !== "tunnel" || c.id.startsWith("T_")) continue;
      const nm = String(effectiveProps(c).name ?? "").trim();
      const t = `p:${c.id}|net`;
      if (nm && spec.has(t)) tunnelUf.union(`tn:${nm}`, `net:${spec.get(t)}`);
    }
    const specNet = (t: string) => (spec.has(t) ? tunnelUf.find(`net:${spec.get(t)}`) : null);
    for (const mode of ["logical", "geometric"] as const) {
      const nl = buildNetlist(d, mode);
      const seen = new Map<string, string>(); // spec net -> doc net id
      for (const dn of nl.nets) {
        const members = dn.pins.map((p) => `p:${p.componentId}|${p.pinId}`);
        const specs = new Set(members.map(specNet));
        if (specs.size > 1 || (specs.has(null) && members.length > 1)) {
          out.push(`${mode === "logical" ? "stored connections" : "drawing"} joins ${members.slice(0, 6).map((t) => t.slice(2).replace("|", ".")).join(", ")}, which the spec keeps apart (please report this)`);
          continue;
        }
        const sn = [...specs][0];
        if (!sn) continue;
        if (seen.has(sn) && seen.get(sn) !== dn.id) out.push(`${mode === "logical" ? "stored connections" : "drawing"} splits net ${sn.replace(/^net:/, "")} (please report this)`);
        seen.set(sn, dn.id);
      }
    }
    for (const c of connectionConflicts({ ...d, links: d.links ?? canonicalLinks(links) })) {
      if (c.kind === "drivers") continue; // reported as an electrical warning already
      out.push(`${c.kind === "unintended" ? "drawing touches but does not connect" : "connected but not drawn touching"}: ${c.a} and ${c.b} at ${c.at.x},${c.at.y} (please report this)`);
    }
    return out;
  }
}

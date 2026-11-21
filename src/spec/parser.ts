/**
 * DSpec parser: source text -> statements. Line based; see docs/SPEC-LANGUAGE.md.
 *
 *   # comment                         // comment
 *   @directive arg key=value ...      (state: applies to the statements after it)
 *   part NAME[,NAME|A0..A3] TYPE [key=value ...]     (at=X,Y rot=90 mirror size=WxH label="..")
 *   net NAME = REF, REF, ...          (named net; several lines with one name are one net)
 *   net REF, REF, ...                 (anonymous net)
 *   REF -> REF, REF ...               (same as an anonymous net, read "drives")
 *   text "..." at=X,Y [size=N]
 *   group NAME {   ...   }             (directives inside are local to the group)
 *
 * A line ending in "," or "->" continues on the next line.
 */

export interface Loc {
  line: number;
  col: number;
}

export type Value = { kind: "num"; v: number } | { kind: "str"; v: string } | { kind: "word"; v: string } | { kind: "pair"; a: number; b: number };

export interface Attr {
  key: string;
  value: Value | null; // null: a bare flag such as `mirror`
  loc: Loc;
}

export interface RefNode {
  part: string;
  pin: string | null;
  loc: Loc;
}

export type Statement =
  | { kind: "directive"; name: string; args: Attr[]; loc: Loc }
  | { kind: "part"; names: { name: string; loc: Loc }[]; type: string; typeLoc: Loc; attrs: Attr[]; loc: Loc }
  | { kind: "net"; name: string | null; refs: RefNode[]; arrow: boolean; loc: Loc }
  | { kind: "text"; text: string; attrs: Attr[]; loc: Loc }
  | { kind: "group"; name: string; body: Statement[]; loc: Loc };

export interface Diagnostic {
  severity: "error" | "warning" | "note";
  message: string;
  line: number;
  col: number;
}

type Tok =
  | { t: "word"; v: string; loc: Loc }
  | { t: "str"; v: string; loc: Loc }
  | { t: "sym"; v: "=" | "," | "->" | "{" | "}"; loc: Loc };

class SyntaxError_ extends Error {
  constructor(message: string, readonly loc: Loc) {
    super(message);
  }
}

function tokenizeLine(text: string, line: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) break;
    const loc = { line, col: i + 1 };
    if (c === '"') {
      let s = "";
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          const e = text[i + 1];
          s += e === "n" ? "\n" : e;
          i += 2;
        } else s += text[i++];
      }
      if (i >= n) throw new SyntaxError_("unterminated string (missing closing \")", loc);
      i++;
      out.push({ t: "str", v: s, loc });
      continue;
    }
    if (c === "-" && text[i + 1] === ">") {
      out.push({ t: "sym", v: "->", loc });
      i += 2;
      continue;
    }
    if (c === "=" || c === "," || c === "{" || c === "}") {
      out.push({ t: "sym", v: c, loc });
      i++;
      continue;
    }
    let w = "";
    while (i < n) {
      const d = text[i];
      if (d === " " || d === "\t" || d === "\r" || d === '"' || d === "=" || d === "," || d === "{" || d === "}" || d === "#") break;
      if (d === "-" && text[i + 1] === ">") break;
      if (d === "/" && text[i + 1] === "/") break;
      w += d;
      i++;
    }
    out.push({ t: "word", v: w, loc });
  }
  return out;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** "F0..F3" -> F0 F1 F2 F3 (the second prefix may be left out: "F0..3"). */
export function expandRange(word: string): string[] | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*?)(\d+)\.\.(?:([A-Za-z_][A-Za-z0-9_]*?))?(\d+)$/.exec(word);
  if (!m) return null;
  const [, p1, a, p2, b] = m;
  if (p2 && p2 !== p1) return null;
  const lo = Number(a), hi = Number(b);
  if (Math.abs(hi - lo) > 256) return null;
  const step = hi >= lo ? 1 : -1;
  const out: string[] = [];
  for (let k = lo; step > 0 ? k <= hi : k >= hi; k += step) out.push(`${p1}${k}`);
  return out;
}

function parseRefs(toks: Tok[], start: number): { refs: RefNode[]; end: number } {
  const refs: RefNode[] = [];
  let i = start;
  for (;;) {
    const t = toks[i];
    if (!t || t.t !== "word") throw new SyntaxError_(`expected a pin reference such as U1.in0${t ? `, found "${t.v}"` : ""}`, t?.loc ?? toks[i - 1]?.loc ?? { line: 0, col: 0 });
    // A range of parts with one pin: F0..F3.clk
    const dot = t.v.indexOf(".");
    let partPart = t.v, pin: string | null = null;
    const rangeM = /^([A-Za-z_][A-Za-z0-9_]*?\d+\.\.[A-Za-z_]*\d+)(?:\.(.+))?$/.exec(t.v);
    if (rangeM) {
      partPart = rangeM[1];
      pin = rangeM[2] ?? null;
    } else if (dot > 0) {
      partPart = t.v.slice(0, dot);
      pin = t.v.slice(dot + 1);
    }
    const parts = expandRange(partPart) ?? [partPart];
    for (const p of parts) {
      if (!NAME_RE.test(p)) throw new SyntaxError_(`"${p}" is not a valid part name (letters, digits and _ only, not starting with a digit)`, t.loc);
      if (pin !== null && pin === "") throw new SyntaxError_(`missing pin name after "${p}."`, t.loc);
      refs.push({ part: p, pin, loc: t.loc });
    }
    i++;
    if (toks[i]?.t === "sym" && toks[i].v === ",") {
      i++;
      continue;
    }
    return { refs, end: i };
  }
}

function parseValue(toks: Tok[], i: number): { value: Value; end: number } {
  const t = toks[i];
  if (!t || t.t === "sym") throw new SyntaxError_("expected a value after =", t?.loc ?? toks[i - 1].loc);
  if (t.t === "str") return { value: { kind: "str", v: t.v }, end: i + 1 };
  // X,Y pair (at=100,200)
  if (/^-?\d+$/.test(t.v) && toks[i + 1]?.t === "sym" && toks[i + 1].v === "," && toks[i + 2]?.t === "word" && /^-?\d+$/.test((toks[i + 2] as { v: string }).v)) {
    return { value: { kind: "pair", a: Number(t.v), b: Number((toks[i + 2] as { v: string }).v) }, end: i + 3 };
  }
  if (/^-?\d+(\.\d+)?$/.test(t.v)) return { value: { kind: "num", v: Number(t.v) }, end: i + 1 };
  return { value: { kind: "word", v: t.v }, end: i + 1 };
}

function parseAttrs(toks: Tok[], i: number): Attr[] {
  const attrs: Attr[] = [];
  while (i < toks.length) {
    const t = toks[i];
    if (t.t === "str") {
      attrs.push({ key: t.v, value: { kind: "str", v: t.v }, loc: t.loc }); // a bare string (e.g. @name "Adder")
      i++;
      continue;
    }
    if (t.t !== "word") throw new SyntaxError_(`expected key=value, found "${t.v}"`, t.loc);
    if (toks[i + 1]?.t === "sym" && toks[i + 1].v === "=") {
      const { value, end } = parseValue(toks, i + 2);
      attrs.push({ key: t.v, value, loc: t.loc });
      i = end;
    } else {
      attrs.push({ key: t.v, value: null, loc: t.loc });
      i++;
    }
  }
  return attrs;
}

function parseStatement(toks: Tok[]): Statement | { kind: "open"; name: string; loc: Loc } | { kind: "close"; loc: Loc } {
  const t0 = toks[0];
  const loc = t0.loc;
  if (t0.t === "sym" && t0.v === "}") {
    if (toks.length > 1) throw new SyntaxError_("nothing may follow } on the same line", toks[1].loc);
    return { kind: "close", loc };
  }
  if (t0.t !== "word") throw new SyntaxError_(`a statement cannot start with "${t0.v}"`, loc);
  if (t0.v.startsWith("@")) {
    const name = t0.v.slice(1);
    if (!name) throw new SyntaxError_("missing directive name after @", loc);
    return { kind: "directive", name: name.toLowerCase(), args: parseAttrs(toks, 1), loc };
  }
  switch (t0.v) {
    case "part": {
      const nameTok = toks[1];
      if (!nameTok || nameTok.t !== "word") throw new SyntaxError_("expected a part name after 'part'", nameTok?.loc ?? loc);
      const names: { name: string; loc: Loc }[] = [];
      let i = 1;
      for (;;) {
        const t = toks[i];
        if (!t || t.t !== "word") throw new SyntaxError_("expected a part name", t?.loc ?? loc);
        for (const n of expandRange(t.v) ?? [t.v]) {
          if (!NAME_RE.test(n)) throw new SyntaxError_(`"${n}" is not a valid part name (letters, digits and _ only, not starting with a digit)`, t.loc);
          names.push({ name: n, loc: t.loc });
        }
        i++;
        if (toks[i]?.t === "sym" && toks[i].v === ",") {
          i++;
          continue;
        }
        break;
      }
      const typeTok = toks[i];
      if (!typeTok || typeTok.t !== "word") throw new SyntaxError_(`expected a component type after the part name, e.g. "part ${names[0].name} and"`, typeTok?.loc ?? loc);
      return { kind: "part", names, type: typeTok.v, typeLoc: typeTok.loc, attrs: parseAttrs(toks, i + 1), loc };
    }
    case "net": {
      // net NAME = refs   |   net refs
      if (toks[1]?.t === "word" && toks[2]?.t === "sym" && toks[2].v === "=") {
        const name = toks[1].v;
        if (!NAME_RE.test(name)) throw new SyntaxError_(`"${name}" is not a valid net name`, toks[1].loc);
        const { refs, end } = parseRefs(toks, 3);
        if (end < toks.length) throw new SyntaxError_(`unexpected "${toks[end].v}" (separate pins with commas)`, toks[end].loc);
        return { kind: "net", name, refs, arrow: false, loc };
      }
      const { refs, end } = parseRefs(toks, 1);
      if (end < toks.length) throw new SyntaxError_(`unexpected "${toks[end].v}" (separate pins with commas)`, toks[end].loc);
      return { kind: "net", name: null, refs, arrow: false, loc };
    }
    case "text": {
      const s = toks[1];
      if (!s || s.t !== "str") throw new SyntaxError_('expected a quoted string after text, e.g. text "Lab 3" at=0,-40', s?.loc ?? loc);
      return { kind: "text", text: s.v, attrs: parseAttrs(toks, 2), loc };
    }
    case "group": {
      const n = toks[1];
      if (!n || n.t !== "word" || !NAME_RE.test(n.v)) throw new SyntaxError_("expected a group name, e.g. group adder {", n?.loc ?? loc);
      if (!(toks[2]?.t === "sym" && toks[2].v === "{") || toks.length > 3) throw new SyntaxError_('a group line is "group NAME {" and the body starts on the next line', toks[2]?.loc ?? n.loc);
      return { kind: "open", name: n.v, loc };
    }
  }
  // REF -> REFS
  const left = parseRefs(toks, 0);
  const arrow = toks[left.end];
  if (arrow?.t === "sym" && arrow.v === "->") {
    const right = parseRefs(toks, left.end + 1);
    if (right.end < toks.length) throw new SyntaxError_(`unexpected "${toks[right.end].v}"`, toks[right.end].loc);
    if (left.refs.length !== 1) throw new SyntaxError_("put one pin on the left of ->, e.g. U1.out -> U2.in0, U3.in1", loc);
    return { kind: "net", name: null, refs: [...left.refs, ...right.refs], arrow: true, loc };
  }
  throw new SyntaxError_(`unknown statement "${t0.v}". Statements are: part, net, text, group, @directive, or A.pin -> B.pin`, loc);
}

export interface ParseResult {
  statements: Statement[];
  diagnostics: Diagnostic[];
}

export function parseSpec(source: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const root: Statement[] = [];
  const stack: { name: string; body: Statement[]; loc: Loc }[] = [];
  const lines = source.split("\n");
  let pending: Tok[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    let toks: Tok[];
    try {
      toks = tokenizeLine(lines[ln], ln + 1);
    } catch (e) {
      if (e instanceof SyntaxError_) diagnostics.push({ severity: "error", message: e.message, ...e.loc });
      pending = [];
      continue;
    }
    toks = [...pending, ...toks];
    pending = [];
    if (toks.length === 0) continue;
    const last = toks[toks.length - 1];
    if (last.t === "sym" && (last.v === "," || last.v === "->") && ln + 1 < lines.length) {
      pending = toks; // continues on the next line
      continue;
    }
    try {
      const st = parseStatement(toks);
      const body = stack.length ? stack[stack.length - 1].body : root;
      if (st.kind === "open") stack.push({ name: st.name, body: [], loc: st.loc });
      else if (st.kind === "close") {
        const g = stack.pop();
        if (!g) throw new SyntaxError_("} without a matching group", st.loc);
        (stack.length ? stack[stack.length - 1].body : root).push({ kind: "group", name: g.name, body: g.body, loc: g.loc });
      } else body.push(st);
    } catch (e) {
      if (e instanceof SyntaxError_) diagnostics.push({ severity: "error", message: e.message, ...e.loc });
      else throw e;
    }
  }
  for (const g of stack) diagnostics.push({ severity: "error", message: `group ${g.name} is never closed (missing })`, ...g.loc });
  return { statements: root, diagnostics };
}

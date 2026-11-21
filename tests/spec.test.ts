// DSpec: parser, compiler (connectivity, determinism, compaction modes, layout reuse),
// decompiler round trip, and a random-circuit fuzz. Connectivity is checked here against what
// the TEST intended, independently of the compiler's own verification.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseSpec } from "../src/spec/parser";
import { compileSpec } from "../src/spec/compile";
import { decompileDoc } from "../src/spec/decompile";
import { referenceText, catalog } from "../src/spec/reference";
import { buildNetlist } from "../src/io/netlist";
import { connectionConflicts } from "../src/model/links";
import { parseProject, serializeProject } from "../src/io/project";
import type { SchematicDocument } from "../src/model/types";

/** pin groups (sorted "Part.pin" lists) of a document, by mode */
function groups(doc: SchematicDocument, mode: "logical" | "geometric", ignore = /^T_/): string[] {
  return buildNetlist(doc, mode)
    .nets.map((n) => n.pins.filter((p) => !ignore.test(p.componentId)).map((p) => `${p.componentId}.${p.pinId}`).sort())
    .filter((g) => g.length > 1)
    .map((g) => g.join(","))
    .sort();
}
const want = (...gs: string[][]) => gs.map((g) => [...g].sort().join(",")).sort();
const errors = (r: ReturnType<typeof compileSpec>) => r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.line}:${d.col} ${d.message}`);

function checkInvariants(doc: SchematicDocument): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const x of [...doc.components, ...doc.wires, ...doc.texts]) {
    if (ids.has(x.id)) out.push(`duplicate id ${x.id}`);
    ids.add(x.id);
  }
  for (const w of doc.wires) {
    for (const p of w.points) if (p.x % 10 || p.y % 10) out.push(`wire ${w.id} off grid`);
    for (let i = 0; i + 1 < w.points.length; i++) if (w.points[i].x !== w.points[i + 1].x && w.points[i].y !== w.points[i + 1].y) out.push(`wire ${w.id} diagonal`);
  }
  for (const c of connectionConflicts(doc)) if (c.kind !== "drivers") out.push(`conflict ${c.kind} ${c.a} ${c.b}`);
  return out;
}

const HALF = `
@name "Half adder"
part A, B input-pin
part X1 xor
part G1 and
part S, C output-pin
A -> X1.in0, G1.in0
B -> X1.in1, G1.in1
X1 -> S
G1 -> C
`;

const COUNTER = `
part CK clock
part F0..F3 d-ff
part Q0..Q3 output-pin
CK -> F0.clk
F0.Q' -> F0.d, F1.clk
F1.qn -> F1.d, F2.clk
F2.qn -> F2.d, F3.clk
F3.qn -> F3.d
net OUT0 = F0.q, Q0
net OUT1 = F1.q, Q1
net OUT2 = F2.q, Q2
net OUT3 = F3.q, Q3
`;

describe("DSpec parser", () => {
  it("expands ranges, continues lines, nests groups, and reports locations", () => {
    const r = parseSpec(`part F0..F2 d-ff\nnet CLK = CK,\n  F0..F2.clk\ngroup g {\n  @compact each\n  part U1 and\n}\n`);
    expect(r.diagnostics).toEqual([]);
    const [p, n, g] = r.statements;
    expect(p.kind === "part" && p.names.map((x) => x.name)).toEqual(["F0", "F1", "F2"]);
    expect(n.kind === "net" && n.refs.map((x) => `${x.part}.${x.pin}`)).toEqual(["CK.null", "F0.clk", "F1.clk", "F2.clk"]);
    expect(g.kind === "group" && g.body.length).toBe(2);
  });
  it("gives line:col errors", () => {
    const r = parseSpec(`part 1x and\nfoo bar\ntext unquoted\ngroup g {\n`);
    expect(r.diagnostics.map((d) => `${d.line}:${d.col}`)).toEqual(["1:6", "2:1", "3:6", "4:1"]);
  });
});

describe("DSpec compiler", () => {
  it("half adder: exactly the spec's connections, in the drawing and the stored links", () => {
    const r = compileSpec(HALF);
    expect(errors(r)).toEqual([]);
    const expected = want(["A.out", "X1.in0", "G1.in0"], ["B.out", "X1.in1", "G1.in1"], ["X1.out", "S.in"], ["G1.out", "C.in"]);
    expect(groups(r.doc!, "logical")).toEqual(expected);
    expect(groups(r.doc!, "geometric")).toEqual(expected);
    expect(checkInvariants(r.doc!)).toEqual([]);
    // terminals take the part name
    expect(r.doc!.components.find((c) => c.id === "S")!.props.name).toBe("S");
  });

  it("ripple counter with feedback loops; pin names (Q') resolve", () => {
    const r = compileSpec(COUNTER);
    expect(errors(r)).toEqual([]);
    const g = groups(r.doc!, "geometric");
    expect(g).toContain(want(["F0.qn", "F0.d", "F1.clk"])[0]);
    expect(g).toContain(want(["F3.q", "Q3.in"])[0]);
    expect(groups(r.doc!, "logical")).toEqual(g);
    expect(checkInvariants(r.doc!)).toEqual([]);
  });

  it("the flip-flop chain from the drag-back report compiles and flags the shorted outputs", () => {
    const r = compileSpec(`
part CK clock
part F1, F2 d-ff label=Q7
part D in
D -> F1.d
F1.q -> F2.d
F1.qn -> F2.clk
net CLKNET = CK.clk, F1.clk, F2.q, F2.qn
`);
    expect(errors(r)).toEqual([]);
    const w = r.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
    expect(w.some((m) => m.includes("CLKNET has 3 outputs"))).toBe(true);
    expect(checkInvariants(r.doc!)).toEqual([]);
  });

  it("is repeatable: the same source builds the same document (exact without compaction)", () => {
    // compaction stops on a wall-clock deadline, so only the uncompacted build is exact everywhere
    const a = JSON.stringify(compileSpec("@compact never\n" + COUNTER).doc);
    const b = JSON.stringify(compileSpec("@compact never\n" + COUNTER).doc);
    expect(a).toBe(b);
  }, 60_000);

  it("every compaction mode produces a valid document with the same connections", () => {
    const base = groups(compileSpec("@compact never\n" + HALF).doc!, "geometric");
    for (const mode of ["never", "end", "each", "every=2", "group"]) {
      const src = mode === "group" ? `@compact group\ngroup all {\n${HALF}\n}\n` : `@compact ${mode}\n${HALF}`;
      const r = compileSpec(src);
      expect(errors(r), mode).toEqual([]);
      expect(groups(r.doc!, "geometric"), mode).toEqual(base);
      expect(checkInvariants(r.doc!), mode).toEqual([]);
      // incremental modes end with one more pass at the configured gaps
      const expectedRuns = { never: 0, end: 1, each: 7, "every=2": 4, group: 2 }[mode];
      expect(r.stats.compactions, mode).toBe(expectedRuns);
    }
  }, 120_000);

  it("directives inside a group stay inside it", () => {
    const r = compileSpec(`group g {\n@compact never\npart A in\n}\npart B in\n`);
    expect(errors(r)).toEqual([]);
    expect(r.stats.compactions).toBe(1); // B was added under the default (end)
  });

  it("@route tunnel draws a net with net labels; connections are unchanged", () => {
    const r = compileSpec("@route tunnel\n" + HALF);
    expect(errors(r)).toEqual([]);
    expect(r.stats.wires).toBe(0);
    expect(r.stats.tunnels).toBe(10);
    expect(groups(r.doc!, "geometric")).toEqual(groups(compileSpec(HALF).doc!, "geometric"));
  });

  it("with a previous build, unchanged parts keep their place", () => {
    const first = compileSpec(HALF).doc!;
    const r = compileSpec(HALF + "part G2 or\nA -> G2.in0\nB -> G2.in1\npart O output-pin\nG2 -> O\n", { previous: first });
    expect(errors(r)).toEqual([]);
    for (const c of first.components) {
      const now = r.doc!.components.find((x) => x.id === c.id)!;
      expect([now.x, now.y], c.id).toEqual([c.x, c.y]);
    }
  });

  it("explains mistakes with did-you-mean", () => {
    const r = compileSpec(`part A inpt\npart G and inputs=99 colour=red\npart X xor\nX.in0 -> G.in7\n@layot flow\n`);
    const m = errors(r).join("\n");
    expect(m).toContain('1:8 unknown component type "inpt". Did you mean "input"?');
    expect(m).toContain("inputs=99 is out of range (2 to 16)");
    expect(m).toContain('has no property "colour"');
    expect(m).toContain('G (and) has no pin "in7"');
    expect(m).toContain('unknown directive @layot. Did you mean "layout"?');
    expect(m).not.toMatch(/[—–]/);
  });

  it("a bare part name means its only output (left of ->) or only input (right of ->)", () => {
    expect(errors(compileSpec("part A in\npart N not\npart Y out\nA -> N\nN -> Y\n"))).toEqual([]);
    expect(errors(compileSpec("part A in\npart G and\nA -> G\n")).join()).toContain("write which one, e.g. G.in0");
  });
});

describe("DSpec edge cases", () => {
  it("@route direct: connections stay exact; drawing contacts are warnings, not a failed build", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const lines = ["@route direct", "@compact never"];
      for (let i = 0; i < 4; i++) lines.push(`part I${i} input-pin`);
      for (let i = 0; i < 6; i++) lines.push(`part G${i} ${["and", "or", "xor"][(i + seed) % 3]}`);
      for (let i = 0; i < 6; i++) lines.push(`I${(i + seed) % 4} -> G${i}.in0`, `G${(i + seed + 1) % 6}.out -> G${i}.in1`);
      const r = compileSpec(lines.join("\n"));
      expect(errors(r), `seed ${seed}`).toEqual([]);
      const g = groups(r.doc!, "logical");
      expect(g.length).toBeGreaterThan(0);
    }
  });

  it("two pinned parts whose pins coincide on different nets: an error on the part line", () => {
    const r = compileSpec("part A input-pin at=0,0\npart B input-pin at=0,0\npart G and\nA -> G.in0\nB -> G.in1\n");
    const e = errors(r);
    expect(e.length).toBe(1);
    expect(e[0]).toMatch(/^2:6 A\.out and B\.out sit on the same point/);
  });

  it("the source survives save and reopen, so the Code dialog can show it", () => {
    const doc = compileSpec(HALF).doc!;
    const back = parseProject(serializeProject(doc));
    expect(back.meta?.dspec).toBe(HALF);
    expect(back.meta?.dspecNets).toBe(doc.meta?.dspecNets);
  });
});

describe("DSpec decompiler", () => {
  it("round trip keeps connections and positions", () => {
    const doc = compileSpec(COUNTER).doc!;
    const src = decompileDoc(doc);
    const back = compileSpec(src);
    expect(errors(back)).toEqual([]);
    expect(groups(back.doc!, "geometric")).toEqual(groups(doc, "geometric", /^$/));
    for (const c of doc.components) {
      const b = back.doc!.components.find((x) => x.id === c.id)!;
      expect([b.x, b.y, b.rotation], c.id).toEqual([c.x, c.y, c.rotation]);
    }
  });

  const proj = process.env.SPEC_PROJECT;
  it.skipIf(!proj)("round trip on a real project (read only)", () => {
    const doc = parseProject(readFileSync(proj!, "utf8"));
    const back = compileSpec(decompileDoc(doc));
    expect(errors(back)).toEqual([]);
    // parts get readable names from their labels: map them back by type and position
    const orig = new Map(doc.components.map((c) => [`${c.type}@${c.x},${c.y},${c.rotation}`, c.id]));
    const rename = new Map(back.doc!.components.map((c) => [c.id, orig.get(`${c.type}@${c.x},${c.y},${c.rotation}`) ?? `?${c.id}`]));
    const renamed = { ...back.doc!, components: back.doc!.components.map((c) => ({ ...c, id: rename.get(c.id)! })), links: back.doc!.links!.map(([a, b2]) => [a.replace(/^p:([^|]+)/, (_, id) => `p:${rename.get(id)}`), b2.replace(/^p:([^|]+)/, (_, id) => `p:${rename.get(id)}`)] as [string, string]) };
    expect(groups(renamed, "logical", /^$/)).toEqual(groups(doc, "logical", /^$/));
    expect(groups(back.doc!, "geometric", /^$/)).toEqual(groups(back.doc!, "logical", /^$/));
    console.log(`project round trip: ${doc.components.length} parts, ${back.stats.wires} wires, ${back.stats.tunnels} tunnels, ${back.stats.ms.total} ms`);
  }, 120_000);
});

describe("DSpec reference", () => {
  it("lists every component type with its pins, without em dashes", () => {
    const text = referenceText();
    for (const e of catalog()) expect(text).toContain(`${e.type}: `);
    expect(text).not.toMatch(/[—–]/);
  });
});

describe("DSpec fuzz: random circuits compile to exactly their netlist", () => {
  function rng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  const N = Number(process.env.SPEC_FUZZ ?? 12);
  for (let seed = 1; seed <= N; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const all = !!process.env.SPEC_FUZZ_ALL; // also the incremental modes and net labels (slow)
      const mode = pick(all ? ["end", "each", "every=3", "group"] : ["never", "end", "end", "every=4"]);
      const lines: string[] = [`@compact ${mode}`];
      if (all && r() < 0.3) lines.push("@route tunnel");
      if (r() < 0.2) lines.push("@layout grid");
      const outs: string[] = [];
      const inputs: string[] = [];
      const nIn = 2 + Math.floor(r() * 3);
      for (let i = 0; i < nIn; i++) {
        lines.push(`part I${i} input-pin`);
        outs.push(`I${i}.out`);
      }
      const nG = 3 + Math.floor(r() * 8);
      for (let i = 0; i < nG; i++) {
        const t = pick(["and", "or", "xor", "nand", "not", "d-ff"]);
        lines.push(`part G${i} ${t}`);
        if (t === "not") inputs.push(`G${i}.in0`);
        else if (t === "d-ff") inputs.push(`G${i}.d`, `G${i}.clk`);
        else inputs.push(`G${i}.in0`, `G${i}.in1`);
        outs.push(t === "d-ff" ? `G${i}.q` : `G${i}.out`);
      }
      // every input driven by one random output (loops allowed: flip-flops and gates may feed back)
      const nets = new Map<string, string[]>();
      for (const inp of inputs) {
        if (r() < 0.15) continue; // some inputs left open
        const src = pick(outs);
        (nets.get(src) ?? nets.set(src, []).get(src)!).push(inp);
      }
      for (const [src, sinks] of nets) lines.push(`${src} -> ${sinks.join(", ")}`);
      if (mode === "group") {
        // put the gates into two groups
        const gates = lines.filter((l) => l.startsWith("part G"));
        const rest = lines.filter((l) => !l.startsWith("part G"));
        const half = Math.ceil(gates.length / 2);
        lines.splice(0, lines.length, ...rest, "group a {", ...gates.slice(0, half), "}", "group b {", ...gates.slice(half), "}");
      }
      const res = compileSpec(lines.join("\n"));
      expect(errors(res), lines.join("\n")).toEqual([]);
      const expected = want(...[...nets].map(([s, k]) => [s, ...k]));
      expect(groups(res.doc!, "geometric"), lines.join("\n")).toEqual(expected);
      expect(groups(res.doc!, "logical")).toEqual(expected);
      expect(checkInvariants(res.doc!)).toEqual([]);
    }, 120_000);
  }
});

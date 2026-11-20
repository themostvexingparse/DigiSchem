/**
 * Generates sample schematics for testing "Compact layout" by hand.
 *   npx vite-node scripts/gen-compaction-samples.ts
 * Writes samples/compaction/*.dschem and prints, per sample, what the packer achieves.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../src/model/types";
import { worldPins } from "../src/model/geometry";
import { RouteObstacles, safeRoute } from "../src/editor/safe-route";
import { serializeProject } from "../src/io/project";
import { centerOfMass, packSchematic, validateCompaction } from "../src/layout/pack";
import { sprawled } from "../tests/helpers/sprawl";

registerBuiltinComponents();
const OUT = "samples/compaction";

// ---------------------------------------------------------------------------------------------
type C = ComponentInstance;
const comp = (id: string, type: string, x: number, y: number, props: Record<string, unknown> = {}, label?: string): C => ({
  id, type, x, y, rotation: 0, props, ...(label ? { label } : {}),
});
const pin = (c: C, id: string) => {
  const p = worldPins(c).find((q) => q.pin.id === id);
  if (!p) throw new Error(`${c.type} has no pin ${id}`);
  return p.pos;
};

class Builder {
  d: SchematicDocument;
  unrouted: string[] = [];
  private n = 0;
  constructor(name: string) {
    this.d = emptyDocument(name);
  }
  add(...cs: C[]) {
    this.d.components.push(...cs);
    return cs[0];
  }
  /** Route a wire with the editor's router (wires already on the same pin count as the same net). */
  wire(a: C, p: string, b: C, q: string) {
    const from = pin(a, p), to = pin(b, q);
    const at = (pt: { x: number; y: number }) =>
      this.d.wires.filter((w) => w.points.some((v) => v.x === pt.x && v.y === pt.y)).map((w) => w.id);
    const sameNet = new Set([...at(from), ...at(to)]);
    const r = safeRoute(new RouteObstacles(this.d), from, to, { sameNet });
    if (r) this.d.wires.push({ id: `w${this.n++}`, points: r });
    else this.unrouted.push(`${a.id}.${p} -> ${b.id}.${q}`);
  }
  /** A wire drawn by hand through explicit waypoints. */
  path(...pts: { x: number; y: number }[]) {
    this.d.wires.push({ id: `w${this.n++}`, points: pts });
  }
  note(x: number, y: number, text: string, fontSize?: number) {
    this.d.texts.push({ id: `t${this.d.texts.length}`, x, y, text, ...(fontSize ? { fontSize } : {}) });
  }
}

// ---------------------------------------------------------------------------------------------
const samples: { file: string; what: string; build: () => Builder; selectHint?: string }[] = [];

samples.push({
  file: "01-scattered-inverters",
  what: "Five identical NOT gates at uneven heights and slightly different x. Expect them to end up in one column with equal gaps.",
  build: () => {
    const b = new Builder("Scattered inverters");
    const ys = [0, 150, 210, 420, 500];
    const xs = [300, 330, 290, 320, 300];
    ys.forEach((y, i) => {
      const inp = b.add(comp(`i${i}`, "input-pin", 0, y + 10, { name: `A${i}` }, `A${i}`));
      const n = b.add(comp(`n${i}`, "not", xs[i], y, {}, `N${i}`));
      const o = b.add(comp(`o${i}`, "output-pin", 640, y + 10, { name: `Y${i}` }, `Y${i}`));
      b.wire(inp, "out", n, "in0");
      b.wire(n, "out", o, "in");
    });
    return b;
  },
});

samples.push({
  file: "02-crossing-cluster",
  what: "Four inputs wired in reverse order to four AND gates through tightly bunched vertical lanes (hand-drawn). The crossings can't be removed (order is preserved), but the cluster should spread out (less clutter) while getting smaller.",
  build: () => {
    const b = new Builder("Crossing cluster");
    const ins: C[] = [], gates: C[] = [];
    for (let i = 0; i < 4; i++) {
      ins.push(b.add(comp(`in${i}`, "input-pin", 0, 20 + i * 100, { name: `I${i}` }, `I${i}`)));
      gates.push(b.add(comp(`g${i}`, "and", 460, 10 + i * 100, { inputs: 2 }, `U${i}`)));
    }
    const lanes = [140, 150, 160, 170];
    for (let i = 0; i < 4; i++) {
      const from = pin(ins[i], "out"), to = pin(gates[3 - i], "in0");
      b.path(from, { x: lanes[i], y: from.y }, { x: lanes[i], y: to.y }, to);
    }
    return b;
  },
});

samples.push({
  file: "03-ripple-carry-adder",
  what: "4-bit ripple-carry adder from full adders spread far apart; the carry chain runs bottom-to-top between stages. Expect a tight row of adders with short carry wires.",
  build: () => {
    const b = new Builder("4-bit ripple-carry adder");
    const fa: C[] = [];
    for (let i = 0; i < 4; i++) fa.push(b.add(comp(`fa${i}`, "full-adder", 300 + i * 320, 200 + (i % 2) * 120, {}, `FA${i}`)));
    const cin = b.add(comp("cin", "constant", 200, 60, { value: "0" }, "C0"));
    b.wire(cin, "out", fa[0], "cin");
    for (let i = 0; i < 4; i++) {
      const a = b.add(comp(`a${i}`, "input-pin", 40 + i * 20, 520 + i * 80, { name: `A${i}` }, `A${i}`));
      const bb = b.add(comp(`b${i}`, "input-pin", 40 + i * 20, 560 + i * 80, { name: `B${i}` }, `B${i}`));
      b.wire(a, "out", fa[i], "a");
      b.wire(bb, "out", fa[i], "b");
      const s = b.add(comp(`s${i}`, "output-pin", 1700, 100 + i * 90, { name: `S${i}` }, `S${i}`));
      b.wire(fa[i], "s", s, "in");
      if (i < 3) b.wire(fa[i], "cout", fa[i + 1], "cin");
    }
    const co = b.add(comp("cout", "output-pin", 1700, 520, { name: "COUT" }, "COUT"));
    b.wire(fa[3], "cout", co, "in");
    return b;
  },
});

samples.push({
  file: "04-sync-counter",
  what: "3-bit synchronous counter: D flip-flops with XOR/AND next-state logic, feedback wires running right-to-left, and one clock net branching to every flip-flop (junctions). Expect feedback loops and the clock tree to stay intact.",
  build: () => {
    const b = new Builder("3-bit synchronous counter");
    const clk = b.add(comp("clk", "clock", 0, 700, { name: "CLK" }, "CLK"));
    const ff = [0, 1, 2].map((i) => b.add(comp(`ff${i}`, "d-ff", 700, 80 + i * 260, {}, `Q${i}`)));
    const inv = b.add(comp("inv", "not", 380, 60, {}, "N0"));
    const x1 = b.add(comp("x1", "xor", 400, 340, { inputs: 2 }, "X1"));
    const a2 = b.add(comp("a2", "and", 200, 560, { inputs: 2 }, "A2"));
    const x2 = b.add(comp("x2", "xor", 420, 600, { inputs: 2 }, "X2"));
    b.wire(ff[0], "q", inv, "in0");
    b.wire(inv, "out", ff[0], "d");
    b.wire(ff[0], "q", x1, "in0");
    b.wire(ff[1], "q", x1, "in1");
    b.wire(x1, "out", ff[1], "d");
    b.wire(ff[0], "q", a2, "in0");
    b.wire(ff[1], "q", a2, "in1");
    b.wire(a2, "out", x2, "in0");
    b.wire(ff[2], "q", x2, "in1");
    b.wire(x2, "out", ff[2], "d");
    for (const f of ff) b.wire(clk, "clk", f, "clk");
    ff.forEach((f, i) => {
      const p = b.add(comp(`p${i}`, "probe", 1100, 90 + i * 260, { name: `Q${i}` }, `Q${i}`));
      b.wire(f, "q", p, "in");
    });
    return b;
  },
});

samples.push({
  file: "05-datapath",
  what: "Single-cycle-style datapath: register file, ALU, operand MUX and result register on 32-bit buses, with a write-back bus looping from the register to the register file and a shared clock. Mixed part sizes; expect a compact left-to-right flow with no bus overlaps.",
  build: () => {
    const b = new Builder("Datapath");
    const rf = b.add(comp("rf", "register-file", 400, 200, { addressBits: 5, dataWidth: 32, readPorts: 2, writePorts: 1 }, "RF"));
    const mux = b.add(comp("mux", "mux", 900, 420, { selectBits: 1, dataWidth: 32 }, "BSEL"));
    const alu = b.add(comp("alu", "alu", 1250, 160, { width: 32, opBits: 3 }, "ALU"));
    const reg = b.add(comp("reg", "register", 1700, 160, { width: 32, enable: true, reset: true }, "RES"));
    const clk = b.add(comp("clk", "clock", 0, 900, { name: "CLK" }, "CLK"));
    const ra1 = b.add(comp("ra1", "input-pin", 0, 230, { name: "RA1", width: 5 }, "RA1"));
    const ra2 = b.add(comp("ra2", "input-pin", 0, 300, { name: "RA2", width: 5 }, "RA2"));
    const wa = b.add(comp("wa", "input-pin", 0, 370, { name: "WA", width: 5 }, "WA"));
    const we = b.add(comp("we", "input-pin", 300, 40, { name: "WE" }, "WE"));
    const imm = b.add(comp("imm", "input-pin", 600, 620, { name: "IMM", width: 32 }, "IMM"));
    const bsel = b.add(comp("bsel", "input-pin", 700, 760, { name: "BSEL" }, "BSEL"));
    const ops = [0, 1, 2].map((i) => b.add(comp(`op${i}`, "input-pin", 1000 + i * 30, 20 + i * 40, { name: `OP${i}` }, `OP${i}`)));
    const en = b.add(comp("en", "constant", 1520, 210, { value: "1" }, "EN"));
    const rst = b.add(comp("rst", "input-pin", 1600, 700, { name: "RST" }, "RST"));
    const res = b.add(comp("res", "output-pin", 2100, 210, { name: "RESULT", width: 32 }, "RESULT"));
    const zf = b.add(comp("zf", "probe", 1600, 40, { name: "Z" }, "Z"));
    b.wire(ra1, "out", rf, "ra1");
    b.wire(ra2, "out", rf, "ra2");
    b.wire(wa, "out", rf, "wa1");
    b.wire(we, "out", rf, "we1");
    b.wire(rf, "rd1", alu, "a");
    b.wire(rf, "rd2", mux, "d0");
    b.wire(imm, "out", mux, "d1");
    b.wire(bsel, "out", mux, "s0");
    b.wire(mux, "y", alu, "b");
    ops.forEach((o, i) => b.wire(o, "out", alu, `f${i}`));
    b.wire(alu, "z", zf, "in");
    b.wire(alu, "y", reg, "d");
    b.wire(en, "out", reg, "en");
    b.wire(rst, "out", reg, "rst");
    b.wire(reg, "q", res, "in");
    b.wire(reg, "q", rf, "wd1");
    b.wire(clk, "clk", rf, "clk");
    b.wire(clk, "clk", reg, "clk");
    return b;
  },
});

samples.push({
  file: "06-annotated-lab",
  what: "A small sprawled gate circuit with a title, notes, a named clock and named probes. Text notes must move with the layout and must not overlap parts or wires after compaction.",
  build: () => {
    const b = new Builder("Annotated lab");
    const src = sprawled(11, 2, 3);
    b.d.components.push(...src.components);
    b.d.wires.push(...src.wires);
    b.note(0, -80, "Lab 3 — combinational block", 20);
    b.note(420, 980, "Note: inputs I0..I5 come from the switch bank.");
    b.note(1100, -40, "Outputs drive the LED probes.");
    const clk = b.add(comp("clkA", "clock", 60, 1050, { name: "CLK_A" }, "CLK_A"));
    const pr = b.add(comp("prA", "probe", 900, 1100, { name: "HEARTBEAT" }, "HB"));
    b.wire(clk, "clk", pr, "in");
    return b;
  },
});

samples.push({
  file: "07-large-sprawl",
  what: "Large stress test: 90 parts / ~130 wires over 6 gate stages. Exercises the beam search; compaction takes a few seconds (runs in the background — the editor stays usable).",
  build: () => {
    const b = new Builder("Large sprawl");
    const src = sprawled(4, 6, 10);
    b.d.components.push(...src.components);
    b.d.wires.push(...src.wires);
    return b;
  },
});

samples.push({
  file: "08-off-center",
  what: "A medium circuit placed far from the origin (around x≈4000, y≈3000). Zoom to fit (F), compact, and check the circuit stays where it was on screen — the centre of mass is preserved — instead of jumping towards the top-left.",
  build: () => {
    const b = new Builder("Off-centre circuit");
    const src = sprawled(2, 3, 5);
    for (const c of src.components) b.d.components.push({ ...c, x: c.x + 4000, y: c.y + 3000 });
    for (const w of src.wires) b.d.wires.push({ ...w, points: w.points.map((p) => ({ x: p.x + 4000, y: p.y + 3000 })) });
    return b;
  },
});

samples.push({
  file: "09-already-tight",
  what: "A circuit that has already been compacted. Compact layout should report 'Already tidy' (or make only a negligible change) — it must never make a good layout worse.",
  build: () => {
    const b = new Builder("Already tight");
    let d = sprawled(1, 3, 4);
    for (let i = 0; i < 4; i++) {
      const r = packSchematic(d, { timeBudgetMs: 1500 });
      if (!(r.qualityAfter.total < r.qualityBefore.total - 1e-6)) break;
      d = r.doc;
    }
    b.d.components.push(...d.components);
    b.d.wires.push(...d.wires);
    return b;
  },
});

samples.push({
  file: "10-partial-selection",
  what: "Two separate circuits: a tidy one on the left and a sprawled one on the right. Select ONLY the right circuit (drag a box around it) and compact: the left circuit must not move at all, and the right one should tighten in place.",
  selectHint: "select the right-hand circuit",
  build: () => {
    const b = new Builder("Partial selection");
    let left = sprawled(5, 2, 3);
    left = packSchematic(left, { timeBudgetMs: 800 }).doc;
    const right = sprawled(6, 3, 4);
    const tag = (id: string, s: string) => `${s}_${id}`;
    for (const c of left.components) b.d.components.push({ ...c, id: tag(c.id, "L") });
    for (const w of left.wires) b.d.wires.push({ ...w, id: tag(w.id, "L") });
    for (const c of right.components) b.d.components.push({ ...c, id: tag(c.id, "R"), x: c.x + 1600 });
    for (const w of right.wires) b.d.wires.push({ ...w, id: tag(w.id, "R"), points: w.points.map((p) => ({ x: p.x + 1600, y: p.y })) });
    b.note(0, -60, "Tidy — must not move");
    b.note(1600, -60, "Select me, then Compact layout (Ctrl+Shift+L)");
    return b;
  },
});

// ---------------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const rows: string[] = [];
const readme: string[] = [
  "# Compaction test cases",
  "",
  "Open each file in DigiSchem (Ctrl+O), press **F** to fit, then run **Compact layout** (toolbar",
  "button with four inward arrows, or **Ctrl+Shift+L**). **Ctrl+Z** undoes it in one step.",
  "",
  "With nothing selected the whole schematic is compacted; with a selection, only the selected",
  "parts (and wires attached to them) move.",
  "",
  "Regenerate with `npx vite-node scripts/gen-compaction-samples.ts`.",
  "",
  "| File | What it tests | Parts / wires | Expected (packer run here) |",
  "|---|---|---|---|",
];
for (const s of samples) {
  const b = s.build();
  const d = b.d;
  const path = `${OUT}/${s.file}.dschem`;
  writeFileSync(path, serializeProject(d));
  let ids: Set<string> | undefined;
  if (s.selectHint) {
    ids = new Set(d.components.filter((c) => c.id.startsWith("R_")).map((c) => c.id));
    for (const w of d.wires) if (w.id.startsWith("R_")) ids.add(w.id);
  }
  const t = performance.now();
  const r = packSchematic(d, ids ? { ids } : {});
  const ms = Math.round(performance.now() - t);
  const viol = validateCompaction(d, r, ids ? { ids } : {});
  const c0 = centerOfMass(d, ids), c1 = centerOfMass(r.doc, ids);
  const shift = c0 && c1 ? Math.round(Math.hypot(c1.x - c0.x, c1.y - c0.y)) : 0;
  const improved = r.qualityAfter.total < r.qualityBefore.total - 1e-6;
  const pct = Math.round((100 * r.areaAfter) / r.areaBefore);
  const expect = improved
    ? `area → ${pct}% · score ${Math.round(r.qualityBefore.total)} → ${Math.round(r.qualityAfter.total)} · centre moved ${shift}px · ${(ms / 1000).toFixed(1)}s`
    : "Already tidy (no change)";
  rows.push(`${s.file.padEnd(24)} ${String(d.components.length).padStart(3)}c ${String(d.wires.length).padStart(3)}w unrouted=${b.unrouted.length} violations=${viol.length} | ${expect}`);
  if (b.unrouted.length) rows.push(`   unrouted: ${b.unrouted.join(", ")}`);
  readme.push(`| \`${s.file}.dschem\` | ${s.what} | ${d.components.length} / ${d.wires.length} | ${expect} |`);
}
writeFileSync(`${OUT}/README.md`, readme.join("\n") + "\n");
console.log(rows.join("\n"));

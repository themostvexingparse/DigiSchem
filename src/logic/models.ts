/**
 * Behaviour of each component type for the simulator (simulate.ts), with X (unknown) handled
 * the way hardware would: an AND with one input at 0 is 0 whatever the others are, an adder with
 * an unknown input bit has unknown outputs, a flip-flop clocked with an unknown D holds X.
 *
 * A model reads its inputs and drives its outputs through PartIO; stateful parts keep what they
 * remember in `st`. Control inputs are read with `active`, which applies the pin's polarity (an
 * active-low reset drawn with a bubble is active at 0; a falling-edge clock is active at 0), so
 * one model covers every polarity a part's properties can give it.
 *
 * Types without a model (memories, shifters, ALU, generic blocks, transistors...) drive X on
 * their outputs and are reported as not simulated.
 */
import type { CircuitPart, CircuitPin } from "./circuit";
import type { Bit } from "./simulate";

const B0 = 0 as Bit, B1 = 1 as Bit, BX = 2 as Bit;

/** A value to drive: a number (LSB = bit 0), bits, or all-X / all-Z. */
export type Drive = number | bigint | boolean | readonly Bit[] | "X" | "Z";

export interface PartIO {
  readonly part: CircuitPart;
  readonly initial: "x" | "zero";
  has(pin: string): boolean;
  prop(key: string): string | number | boolean | undefined;
  pinInfo(pin: string): CircuitPin | undefined;
  /** the bits on an input (Z reads as X) */
  bits(pin: string): Bit[];
  bit(pin: string): Bit;
  /** 1 when a control input is asserted (its polarity applied), `absent` when the pin does not exist */
  active(pin: string, absent?: Bit): Bit;
  /** a bus read from one bus pin, or from its bit pins prefix0, prefix1, ... */
  bus(prefix: string): Bit[];
  busWidth(prefix: string): number;
  drive(pin: string, v: Drive): void;
  driveBus(prefix: string, v: Drive): void;
}

export type Model = (io: PartIO, st: Record<string, any>) => void;

// ---- bit logic -----------------------------------------------------------------------------------

const not = (a: Bit): Bit => (a === BX ? BX : ((1 - a) as Bit));
const and = (xs: readonly Bit[]): Bit => (xs.includes(B0) ? B0 : xs.every((x) => x === B1) ? B1 : BX);
const or = (xs: readonly Bit[]): Bit => (xs.includes(B1) ? B1 : xs.every((x) => x === B0) ? B0 : BX);
const xor = (xs: readonly Bit[]): Bit => (xs.includes(BX) ? BX : ((xs.reduce((s: number, x) => s + x, 0) % 2) as Bit));
const known = (xs: readonly Bit[]) => xs.every((x) => x !== BX);

/** Bits (LSB first) as an unsigned bigint; null when any bit is unknown. */
function big(xs: readonly Bit[]): bigint | null {
  let v = 0n;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] === BX) return null;
    v = (v << 1n) | BigInt(xs[i]);
  }
  return v;
}

const signed = (v: bigint, w: number) => BigInt.asIntN(w, v);

/** For an unknown select: the value every possible choice agrees on, bit by bit. */
function merge(options: readonly (readonly Bit[])[]): Bit[] {
  const w = Math.max(0, ...options.map((o) => o.length));
  return Array.from({ length: w }, (_, b) => {
    const vs = new Set(options.map((o) => o[b] ?? BX));
    return vs.size === 1 ? [...vs][0] : BX;
  });
}

/** The indices a partly unknown select value could stand for. */
function candidates(sel: readonly Bit[]): number[] {
  let out = [0];
  sel.forEach((s, i) => {
    if (s === BX) out = out.flatMap((v) => [v, v | (1 << i)]);
    else if (s === B1) out = out.map((v) => v | (1 << i));
  });
  return out;
}

function count(io: PartIO, prefix: string): number {
  let n = 0;
  while (io.has(`${prefix}${n}`)) n++;
  return n;
}

const gate = (f: (xs: Bit[]) => Bit): Model => (io) => {
  const xs: Bit[] = [];
  for (let i = 0; io.has(`in${i}`); i++) xs.push(io.bit(`in${i}`));
  io.drive("out", [f(xs)]);
};

// ---- state ---------------------------------------------------------------------------------------

function initState(io: PartIO, w: number): Bit[] {
  return new Array<Bit>(w).fill(io.initial === "zero" ? B0 : BX);
}

/**
 * Clock edge seen since the last evaluation: 1 for an edge, 0 for none, X when the clock went
 * through an unknown value (the part might or might not have been clocked).
 */
function edge(io: PartIO, st: Record<string, any>, pin = "clk"): Bit {
  const now = io.active(pin, B0);
  const prev: Bit | undefined = st.prevClk;
  st.prevClk = now;
  if (prev === undefined || prev === now) return B0;
  if (prev === B0 && now === B1) return B1;
  if ((prev === BX && now === B1) || (prev === B0 && now === BX)) return BX;
  return B0;
}

/** Bitwise: `next` where `cond` is 1, `cur` where 0, and where unknown, agreement or X. */
function choose(cond: Bit, next: readonly Bit[], cur: readonly Bit[]): Bit[] {
  if (cond === B1) return [...next];
  if (cond === B0) return [...cur];
  return cur.map((c, i) => (c === next[i] ? c : BX));
}

/** Async set/reset (both asserted: unknown), applied over `q`. */
function asyncSR(io: PartIO, q: Bit[]): Bit[] {
  const r = io.active("rst", B0), s = io.has("set") ? io.active("set", B0) : B0;
  if (r === B0 && s === B0) return q;
  if (r === B1 && s === B0) return q.map(() => B0);
  if (s === B1 && r === B0) return q.map(() => B1);
  return q.map(() => BX);
}

const flipflop = (next: (io: PartIO, q: Bit) => Bit): Model => (io, st) => {
  st.q ??= initState(io, 1);
  const e = edge(io, st);
  const en = io.active("en");
  if (e !== B0) {
    const n = [next(io, st.q[0])];
    st.q = choose(e === B1 ? en : en === B0 ? B0 : BX, n, st.q);
  }
  // async inputs (only flip-flops with asyncReset / asyncSet have these pins)
  if (io.has("rst") || io.has("set")) st.q = asyncSR(io, st.q);
  io.drive("q", st.q);
  io.drive("qn", st.q.map(not));
};

function srNext(s: Bit, r: Bit, q: Bit): Bit {
  if (s === B0 && r === B0) return q;
  if (s === B1 && r === B0) return B1;
  if (s === B0 && r === B1) return B0;
  return BX;
}

/** SR latch outputs while S and R are both asserted, as the gate latch it stands for. */
function srLatch(io: PartIO, st: Record<string, any>, enabled: Bit): void {
  st.q ??= initState(io, 1);
  const s = and([io.active("s"), enabled]), r = and([io.active("r"), enabled]);
  if (s === B1 && r === B1) {
    st.q = [BX]; // released from S = R = 1 it could go either way
    const both = io.pinInfo("s")?.inverted ? B1 : B0; // NAND latch: both 1; NOR latch: both 0
    io.drive("q", [both]);
    io.drive("qn", [both]);
    return;
  }
  // an unknown S or R: the next state is known only if both of its possible values give the same
  const pick = (x: Bit, alt: Bit) => (x === BX ? alt : x);
  const n0 = srNext(pick(s, B0), pick(r, B0), st.q[0]), n1 = srNext(pick(s, B1), pick(r, B1), st.q[0]);
  st.q = [n0 === n1 ? n0 : BX];
  io.drive("q", st.q);
  io.drive("qn", st.q.map(not));
}

// ---- arithmetic helper: all outputs X when any input is unknown ---------------------------------

const arith = (inputs: string[], f: (io: PartIO, v: Record<string, bigint>) => Record<string, bigint | boolean>, outputs: string[]): Model => (io) => {
  const v: Record<string, bigint> = {};
  let ok = true;
  for (const p of inputs) {
    if (!io.has(p) && !io.has(`${p}0`)) continue;
    const x = big(io.bus(p));
    if (x === null) ok = false;
    else v[p] = x;
  }
  if (!ok) {
    for (const p of outputs) io.driveBus(p, "X");
    return;
  }
  const r = f(io, v);
  for (const p of outputs) if (p in r) io.driveBus(p, r[p]);
};

const SEGMENTS = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70, 0x7f, 0x7b]; // abcdefg, a = bit 6

export const MODELS: Record<string, Model> = {
  // ---- sources ----
  constant: (io) => {
    const raw = String(io.prop("value") ?? "1").trim();
    let v: bigint | null = null;
    try {
      v = /^-?\d+$/.test(raw) ? BigInt(raw) : /^0[xXbBoO][0-9a-fA-F]+$/.test(raw) ? BigInt(raw) : null;
    } catch {
      v = null;
    }
    io.drive("out", v === null ? "X" : v);
  },
  ground: (io) => io.drive("gnd", 0),
  vcc: (io) => io.drive("vcc", 1),
  "pull-up": (io) => io.drive("out", 1),
  "pull-down": (io) => io.drive("out", 0),

  // ---- gates ----
  and: gate(and),
  nand: gate((xs) => not(and(xs))),
  or: gate(or),
  nor: gate((xs) => not(or(xs))),
  xor: gate(xor),
  xnor: gate((xs) => not(xor(xs))),
  buf: gate((xs) => xs[0]),
  not: gate((xs) => not(xs[0])),
  "schmitt-buffer": gate((xs) => xs[0]),
  "schmitt-inverter": gate((xs) => not(xs[0])),
  aoi: (io) => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((p) => io.bit(p));
    const kind = String(io.prop("kind") ?? "aoi22");
    const y =
      kind === "aoi21" ? or([and([a, b]), c]) : kind === "aoi22" ? or([and([a, b]), and([c, d])]) : kind === "oai21" ? and([or([a, b]), c]) : and([or([a, b]), or([c, d])]);
    io.drive("y", [not(y)]);
  },
  parity: (io) => {
    const xs: Bit[] = [];
    for (let i = 0; io.has(`in${i}`); i++) xs.push(io.bit(`in${i}`));
    const odd = xor(xs);
    io.drive("odd", [odd]);
    io.drive("even", [not(odd)]);
  },

  // ---- plexers ----
  mux: (io) => {
    const en = io.active("en");
    const n = count(io, "d");
    const data = Array.from({ length: n }, (_, i) => io.bits(`d${i}`));
    const options = candidates(io.bus("s")).map((i) => data[i] ?? data[0].map(() => BX));
    const y = merge(options);
    io.drive("y", en === B1 ? y : en === B0 ? 0 : y.map((b) => (b === B0 ? B0 : BX)));
  },
  demux: (io) => {
    const en = io.active("en");
    const d = io.bits("d");
    const cands = candidates(io.bus("s"));
    const n = count(io, "y");
    for (let i = 0; i < n; i++) {
      const hit = cands.includes(i);
      const sure = hit && cands.length === 1;
      const v = d.map((b) => and([b, en, sure ? B1 : hit ? BX : B0]));
      io.drive(`y${i}`, v);
    }
  },
  decoder: (io) => {
    const en = io.active("en");
    const cands = candidates(io.bus("a"));
    const low = !!io.prop("activeLowOutputs");
    for (let i = 0; io.has(`y${i}`); i++) {
      const hit = cands.includes(i) ? (cands.length === 1 ? B1 : BX) : B0;
      const v = and([hit, en]);
      io.drive(`y${i}`, [low ? not(v) : v]);
    }
  },
  encoder: (io) => {
    const en = io.active("en");
    const d = Array.from({ length: count(io, "d") }, (_, i) => io.bit(`d${i}`));
    const w = io.busWidth("y");
    if (en === B0) {
      io.driveBus("y", 0);
      io.drive("v", 0);
      return;
    }
    if (!known(d) || en === BX) {
      io.driveBus("y", "X");
      io.drive("v", [en === BX ? BX : or(d)]);
      return;
    }
    let y = 0;
    if (io.prop("priority") !== false) for (let i = d.length - 1; i >= 0; i--) {
      if (d[i] === B1) {
        y = i;
        break;
      }
    }
    else d.forEach((b, i) => (y |= b === B1 ? i : 0));
    io.driveBus("y", y & ((1 << w) - 1));
    io.drive("v", d.includes(B1) ? 1 : 0);
  },
  tristate: (io) => {
    const en = io.active("en");
    const a = io.bits("in");
    const y = io.prop("invertedOut") ? a.map(not) : a;
    io.drive("out", en === B1 ? y : en === B0 ? "Z" : "X");
  },
  "bus-transceiver": (io) => {
    const oe = io.active("oe");
    const dir = io.bit("dir");
    if (oe === B0) {
      io.drive("a", "Z");
      io.drive("b", "Z");
    } else if (oe === BX || dir === BX) {
      io.drive("a", "X");
      io.drive("b", "X");
    } else if (dir === B1) {
      io.drive("b", io.bits("a"));
      io.drive("a", "Z");
    } else {
      io.drive("a", io.bits("b"));
      io.drive("b", "Z");
    }
  },
  "bit-selector": (io) => {
    const d = io.bits("d");
    io.drive("y", merge(candidates(io.bus("s")).map((i) => [d[i] ?? BX])));
  },
  "bcd-7seg": (io) => {
    const low = !!io.prop("activeLow");
    const lt = io.active("lt", B0), bi = io.active("bi", B0);
    const v = big(io.bus("bcd"));
    const segs = "abcdefg".split("");
    const put = (bits: Bit[]) => segs.forEach((s, i) => io.drive(s, [low ? not(bits[i]) : bits[i]]));
    if (bi === B1) return put(segs.map(() => B0));
    if (lt === B1) return put(segs.map(() => B1));
    if (v === null || lt === BX || bi === BX) return put(segs.map(() => BX));
    const code = Number(v) < 10 ? SEGMENTS[Number(v)] : 0;
    put(segs.map((_, i) => ((code >> (6 - i)) & 1) as Bit));
  },
  "gray-converter": (io) => {
    const x = io.bus("in");
    const toGray = io.prop("direction") !== "toBinary";
    const w = x.length;
    const y: Bit[] = new Array(w);
    if (toGray) for (let i = 0; i < w; i++) y[i] = i === w - 1 ? x[i] : xor([x[i], x[i + 1]]);
    else for (let i = w - 1; i >= 0; i--) y[i] = i === w - 1 ? x[i] : xor([x[i], y[i + 1]]);
    io.driveBus("out", y);
  },

  // ---- arithmetic ----
  "half-adder": (io) => {
    const a = io.bit("a"), b = io.bit("b");
    io.drive("s", [xor([a, b])]);
    io.drive("cout", [and([a, b])]);
  },
  "full-adder": (io) => {
    const a = io.bit("a"), b = io.bit("b"), c = io.bit("cin");
    io.drive("s", [xor([a, b, c])]);
    io.drive("cout", [or([and([a, b]), and([a, c]), and([b, c])])]);
  },
  adder: arith(["a", "b", "cin"], (io, v) => {
    const w = io.busWidth("s");
    const sum = v.a + v.b + (v.cin ?? 0n);
    return { s: sum, cout: sum >> BigInt(w) > 0n };
  }, ["s", "cout"]),
  subtractor: arith(["a", "b", "bin"], (_io, v) => {
    const d = v.a - v.b - (v.bin ?? 0n);
    return { d, bout: d < 0n };
  }, ["d", "bout"]),
  comparator: arith(["a", "b"], (io, v) => {
    const w = io.busWidth("a");
    const s = !!io.prop("signed");
    const a = s ? signed(v.a, w) : v.a, b = s ? signed(v.b, w) : v.b;
    return { gt: a > b, eq: a === b, lt: a < b };
  }, ["gt", "eq", "lt"]),
  incrementer: arith(["a"], (io, v) => {
    const w = io.busWidth("a");
    return { y: v.a + 1n, cout: v.a + 1n >> BigInt(w) > 0n };
  }, ["y", "cout"]),
  decrementer: arith(["a"], (_io, v) => ({ y: v.a - 1n, bout: v.a === 0n }), ["y", "bout"]),
  negator: arith(["a"], (_io, v) => ({ y: -v.a }), ["y"]),
  multiplier: arith(["a", "b"], (io, v) => {
    const w = io.busWidth("a");
    const s = !!io.prop("signed");
    return { p: s ? signed(v.a, w) * signed(v.b, w) : v.a * v.b };
  }, ["p"]),
  divider: (io) => {
    const a = big(io.bus("a")), b = big(io.bus("b"));
    if (a === null || b === null || b === 0n) {
      io.driveBus("q", "X");
      io.driveBus("r", "X");
      return;
    }
    io.driveBus("q", a / b);
    io.driveBus("r", a % b);
  },
  "bit-extender": (io) => {
    const x = io.bits("in");
    const w = io.pinInfo("out")?.width ?? x.length;
    const mode = String(io.prop("mode") ?? "sign");
    const fill = mode === "sign" ? (x[x.length - 1] ?? BX) : mode === "one" ? B1 : B0;
    io.drive("out", Array.from({ length: w }, (_, i) => (i < x.length ? x[i] : fill)));
  },
  "bit-counter": arith(["a"], (io) => {
    const xs = io.bus("a");
    return { count: BigInt(xs.filter((b) => b === B1).length) };
  }, ["count"]),

  // ---- latches ----
  "sr-latch": (io, st) => srLatch(io, st, B1),
  "gated-sr-latch": (io, st) => srLatch(io, st, io.active("en")),
  "d-latch": (io, st) => {
    const w = io.pinInfo("q")?.width ?? 1;
    st.q ??= initState(io, w);
    st.q = choose(io.active("en"), io.bits("d"), st.q);
    io.drive("q", st.q);
    io.drive("qn", (st.q as Bit[]).map(not));
  },

  // ---- flip-flops ----
  "d-ff": flipflop((io) => io.bit("d")),
  "t-ff": flipflop((io, q) => xor([io.bit("t"), q])),
  "jk-ff": flipflop((io, q) => {
    const j = io.bit("j"), k = io.bit("k");
    // Q+ = JQ' + K'Q
    return or([and([j, not(q)]), and([not(k), q])]);
  }),
  "sr-ff": flipflop((io, q) => srNext(io.bit("s"), io.bit("r"), q)),

  // ---- registers and counters (reset is synchronous) ----
  register: (io, st) => {
    const w = io.busWidth("q");
    st.q ??= initState(io, w);
    const e = edge(io, st);
    if (e !== B0) {
      const rst = io.active("rst", B0);
      const next = rst === B1 ? new Array<Bit>(w).fill(B0) : rst === B0 ? io.bus("d") : io.bus("d").map((b) => (b === B0 ? B0 : BX));
      const load = or([rst, io.active("en")]);
      st.q = choose(e === B1 ? load : load === B0 ? B0 : BX, next, st.q);
    }
    io.driveBus("q", st.q);
  },
  counter: (io, st) => {
    const w = io.busWidth("q");
    st.q ??= initState(io, w);
    const up = () => (io.has("ud") ? io.bit("ud") : B1);
    const e = edge(io, st);
    if (e !== B0) {
      const rst = io.active("rst", B0), load = io.active("load", B0), en = io.active("en"), u = up();
      const q = big(st.q);
      let next: Bit[];
      if (rst === B1) next = new Array<Bit>(w).fill(B0);
      else if (rst === BX || load === BX) next = new Array<Bit>(w).fill(BX);
      else if (load === B1) next = io.bus("d");
      else if (en === B0) next = st.q;
      else if (q === null || en === BX || u === BX) next = new Array<Bit>(w).fill(BX);
      else next = bitsOf(u === B1 ? q + 1n : q - 1n, w);
      st.q = e === B1 ? next : (st.q as Bit[]).map((c: Bit, i: number) => (c === next[i] ? c : BX));
    }
    const q = big(st.q);
    if (io.has("rco")) {
      const u = up();
      const tc = q === null || u === BX ? BX : (u === B1 ? q === (1n << BigInt(w)) - 1n : q === 0n) ? B1 : B0;
      io.drive("rco", [and([tc, io.active("en")])]);
    }
    io.driveBus("q", st.q);
  },
};

function bitsOf(v: bigint, w: number): Bit[] {
  let x = BigInt.asUintN(w, v);
  const out: Bit[] = [];
  for (let i = 0; i < w; i++) {
    out.push(Number(x & 1n) as Bit);
    x >>= 1n;
  }
  return out;
}

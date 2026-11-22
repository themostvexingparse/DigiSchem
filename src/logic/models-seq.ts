/**
 * Models of the larger blocks: shift registers and other counters, clocked helpers
 * (synchronizer, edge detector, debouncer, clock divider), memories, the register file, FIFO and
 * stack, the ALU, the shifter and the carry-lookahead unit. See models.ts for the conventions.
 *
 * Where the component library does not pin down a behaviour, the choice made here is written
 * next to the model (and in docs/Logic-Tools.md). Resets are synchronous, as for the register
 * and counter. Memories read combinationally (the output follows the address) and write on the
 * clock edge; their words start unknown (or 0 with `initial: "zero"`). FIFO and stack start
 * empty.
 */
import type { Bit } from "./simulate";
import type { Model, PartIO } from "./models";

const B0 = 0 as Bit, B1 = 1 as Bit, BX = 2 as Bit;

const not = (a: Bit): Bit => (a === BX ? BX : ((1 - a) as Bit));
const and = (xs: readonly Bit[]): Bit => (xs.includes(B0) ? B0 : xs.every((x) => x === B1) ? B1 : BX);
const or = (xs: readonly Bit[]): Bit => (xs.includes(B1) ? B1 : xs.every((x) => x === B0) ? B0 : BX);
const xor = (xs: readonly Bit[]): Bit => (xs.includes(BX) ? BX : ((xs.reduce((s: number, x) => s + x, 0) % 2) as Bit));
const allX = (w: number): Bit[] => new Array<Bit>(w).fill(BX);
const zeros = (w: number): Bit[] => new Array<Bit>(w).fill(B0);

function big(xs: readonly Bit[]): bigint | null {
  let v = 0n;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] === BX) return null;
    v = (v << 1n) | BigInt(xs[i]);
  }
  return v;
}

function bitsOf(v: bigint, w: number): Bit[] {
  let x = BigInt.asUintN(w, v);
  const out: Bit[] = [];
  for (let i = 0; i < w; i++) {
    out.push(Number(x & 1n) as Bit);
    x >>= 1n;
  }
  return out;
}

function initState(io: PartIO, w: number): Bit[] {
  return new Array<Bit>(w).fill(io.initial === "zero" ? B0 : BX);
}

/** Rising edge of the (polarity-applied) clock since the last evaluation: 1, 0, or X if unsure. */
function edge(io: PartIO, st: Record<string, any>, pin = "clk"): Bit {
  const now = io.active(pin, B0);
  const prev: Bit | undefined = st.prevClk;
  // a clock that has never had a value (its net still undriven at power-up) has no edges yet
  if (prev === undefined) {
    if (now !== BX) st.prevClk = now;
    return B0;
  }
  st.prevClk = now;
  if (prev === now) return B0;
  if (prev === B0 && now === B1) return B1;
  if ((prev === BX && now === B1) || (prev === B0 && now === BX)) return BX;
  return B0;
}

/** Bitwise `next` where cond is 1, `cur` where 0, and where unknown, agreement or X. */
function choose(cond: Bit, next: readonly Bit[], cur: readonly Bit[]): Bit[] {
  if (cond === B1) return [...next];
  if (cond === B0) return [...cur];
  return cur.map((c, i) => (c === next[i] ? c : BX));
}

/**
 * A clocked update: on an edge, the state becomes `next()` (computed from the inputs before the
 * edge), when unsure whether there was an edge, the bits that would change become X.
 */
function clocked(io: PartIO, st: Record<string, any>, next: () => Bit[], key = "q"): void {
  const e = edge(io, st);
  if (e === B0) return;
  st[key] = choose(e, next(), st[key]);
}

/** The value of a synchronous reset / load / enable choice chain, bit by bit, with X handling. */
function pick(cond: Bit, a: readonly Bit[], b: readonly Bit[]): Bit[] {
  return choose(cond, a, b);
}

/** Maximal-length Fibonacci LFSR taps (1-based bit positions, from Xilinx XAPP052). */
const LFSR_TAPS: Record<number, number[]> = {
  2: [2, 1], 3: [3, 2], 4: [4, 3], 5: [5, 3], 6: [6, 5], 7: [7, 6], 8: [8, 6, 5, 4], 9: [9, 5], 10: [10, 7],
  11: [11, 9], 12: [12, 6, 4, 1], 13: [13, 4, 3, 1], 14: [14, 5, 3, 1], 15: [15, 14], 16: [16, 15, 13, 4],
  17: [17, 14], 18: [18, 11], 19: [19, 6, 2, 1], 20: [20, 17], 21: [21, 19], 22: [22, 21], 23: [23, 18],
  24: [24, 23, 22, 17], 25: [25, 22], 26: [26, 6, 2, 1], 27: [27, 5, 2, 1], 28: [28, 25], 29: [29, 27],
  30: [30, 6, 4, 1], 31: [31, 28], 32: [32, 22, 2, 1],
};

/** Steady samples a debouncer needs before its output follows the input. */
export const DEBOUNCE_SAMPLES = 4;

type Memory = Map<number, Bit[]>;

function memRead(io: PartIO, mem: Memory, addr: readonly Bit[], w: number): Bit[] {
  const a = big(addr);
  if (a === null) return allX(w);
  return [...(mem.get(Number(a)) ?? initState(io, w))];
}

function memWrite(mem: Memory, addr: readonly Bit[], data: readonly Bit[], we: Bit, w: number, init: Bit[] = allX(w)): void {
  if (we === B0) return;
  const a = big(addr);
  if (a === null) {
    // unknown address: any word might have been written; those already known become unsure
    for (const [k, v] of mem) if (k >= 0) mem.set(k, v.map((b, i) => (b === data[i] ? b : BX)));
    // every unwritten word could have been written too: it keeps the bits the data agrees with
    mem.set(-1, (mem.get(-1) ?? init).map((b, i) => (b === data[i] ? b : BX)));
    return;
  }
  const k = Number(a);
  if (we === B1) mem.set(k, [...data]);
  else {
    const cur = mem.get(k) ?? mem.get(-1) ?? init;
    mem.set(k, cur.map((b, i) => (b === data[i] ? b : BX)));
  }
}

function memReadAny(io: PartIO, mem: Memory, addr: readonly Bit[], w: number): Bit[] {
  const a = big(addr);
  if (a !== null && !mem.has(Number(a)) && mem.has(-1)) return [...mem.get(-1)!];
  return memRead(io, mem, addr, w);
}

/**
 * ROM contents: words separated by spaces, commas or new lines, from address 0. A word is hex
 * (`FF`), or `0x..`, `0b..`, `0d..` (decimal); `N*word` repeats it N times (N in decimal). Words
 * past the list read 0. Returns null when a word cannot be read.
 */
export function parseRomContents(text: string): bigint[] | null {
  const out: bigint[] = [];
  for (const tok of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(?:(\d+)\*)?(.+)$/.exec(tok)!;
    const n = m[1] ? Number(m[1]) : 1;
    const w = m[2];
    let v: bigint;
    try {
      if (/^0[xX][0-9a-fA-F]+$/.test(w) || /^0[bB][01]+$/.test(w)) v = BigInt(w);
      else if (/^0[dD]\d+$/.test(w)) v = BigInt(w.slice(2));
      else if (/^[0-9a-fA-F]+$/.test(w)) v = BigInt(`0x${w}`);
      else return null;
    } catch {
      return null;
    }
    if (n > 1 << 16) return null;
    for (let i = 0; i < n; i++) out.push(v);
  }
  return out;
}

export const SEQ_MODELS: Record<string, Model> = {
  /**
   * Shift register. "right" moves bits toward bit 0 and SI enters at the top bit, SO is bit 0;
   * "left" moves toward the top bit, SI enters at bit 0, SO is the top bit. Bidirectional: DIR = 1
   * shifts right (input SIL, entering at the top), DIR = 0 shifts left (input SIR, entering at bit
   * 0). Priority: reset, then parallel load, then shift.
   */
  "shift-register": (io, st) => {
    const w = io.busWidth("q") || io.busWidth("d") || Number(io.prop("width") ?? 8);
    st.q ??= initState(io, w);
    const dirProp = String(io.prop("direction") ?? "right");
    const goesRight = (): Bit => (dirProp === "right" ? B1 : dirProp === "left" ? B0 : io.bit("dir"));
    clocked(io, st, () => {
      const q: Bit[] = st.q;
      const right = [...q.slice(1), dirProp === "bidirectional" ? io.bit("sil") : io.bit("sin")];
      const left = [dirProp === "bidirectional" ? io.bit("sir") : io.bit("sin"), ...q.slice(0, -1)];
      const shifted = pick(goesRight(), right, left);
      const loaded = io.has("load") ? pick(io.active("load", B0), io.bus("d"), shifted) : shifted;
      return pick(io.active("rst", B0), zeros(w), loaded);
    });
    const q: Bit[] = st.q;
    io.driveBus("q", q);
    const r = goesRight();
    io.drive("sout", [r === B1 ? q[0] : r === B0 ? q[w - 1] : q[0] === q[w - 1] ? q[0] : BX]);
  },

  /** Ring counter: RST loads 0...01 and the 1 moves up a bit per clock. Johnson: RST clears; the top bit is fed back inverted. */
  "ring-counter": (io, st) => {
    let w = 0;
    while (io.has(`q${w}`)) w++;
    st.q ??= initState(io, w);
    const johnson = io.prop("mode") === "johnson";
    clocked(io, st, () => {
      const q: Bit[] = st.q;
      const step = pick(io.active("en"), [johnson ? not(q[w - 1]) : q[w - 1], ...q.slice(0, -1)], q);
      const start = johnson ? zeros(w) : [B1, ...zeros(w - 1)];
      return pick(io.active("rst", B0), start, step);
    });
    (st.q as Bit[]).forEach((b, i) => io.drive(`q${i}`, [b]));
  },

  /** LFSR (Fibonacci, XOR feedback, maximal-length taps). RST loads 1, since all zeros would lock it. */
  lfsr: (io, st) => {
    const w = io.busWidth("q");
    st.q ??= initState(io, w);
    clocked(io, st, () => {
      const q: Bit[] = st.q;
      const fb = xor((LFSR_TAPS[w] ?? [w, 1]).map((t) => q[t - 1]));
      const step = pick(io.active("en"), [fb, ...q.slice(0, -1)], q);
      return pick(io.active("rst", B0), [B1, ...zeros(w - 1)], step);
    });
    io.driveBus("q", st.q);
  },

  /** OUT is high for the second half of every N input clocks (for odd N, the shorter half). RST restarts the count. */
  "clock-divider": (io, st) => {
    const n = Math.max(2, Math.round(Number(io.prop("divisor") ?? 2)));
    if (st.count === undefined) st.count = io.initial === "zero" ? 0 : null;
    const e = edge(io, st);
    if (e !== B0) {
      const rst = io.active("rst", B0);
      if (e === BX || rst === BX) st.count = null;
      else if (rst === B1) st.count = 0;
      else if (st.count !== null) st.count = (st.count + 1) % n;
    }
    io.drive("out", [st.count === null ? BX : st.count >= n - Math.floor(n / 2) ? B1 : B0]);
  },

  /** A chain of `stages` flip-flops: Q is D delayed by that many clocks. */
  synchronizer: (io, st) => {
    const n = Math.max(1, Math.round(Number(io.prop("stages") ?? 2)));
    st.q ??= initState(io, n);
    clocked(io, st, () => [io.bit("d"), ...(st.q as Bit[]).slice(0, -1)]);
    io.drive("q", [(st.q as Bit[])[n - 1]]);
  },

  /** P is 1 for the clock after D (sampled on each clock) rose, fell, or either, as `detect` says. */
  "edge-detector": (io, st) => {
    st.q ??= initState(io, 2); // [last sample, pulse]
    const detect = String(io.prop("detect") ?? "rising");
    clocked(io, st, () => {
      const d = io.bit("d"), prev = (st.q as Bit[])[0];
      const rise = and([d, not(prev)]), fall = and([not(d), prev]);
      return [d, detect === "rising" ? rise : detect === "falling" ? fall : or([rise, fall])];
    });
    io.drive("p", [(st.q as Bit[])[1]]);
  },

  /** OUT follows IN once IN has been the same for DEBOUNCE_SAMPLES clocks in a row. */
  debouncer: (io, st) => {
    st.out ??= initState(io, 1);
    st.run ??= 0;
    st.last ??= BX;
    const e = edge(io, st);
    if (e === B1) {
      const d = io.bit("in");
      st.run = d === st.last && d !== BX ? st.run + 1 : 1;
      st.last = d;
      if (d !== BX && st.run >= DEBOUNCE_SAMPLES) st.out = [d];
    } else if (e === BX) {
      st.out = [BX];
      st.run = 0;
      st.last = BX;
    }
    io.drive("out", st.out);
  },

  /** BCD counter 0..9 that wraps; TC = 1 at 9 (while enabled, so digits chain). Priority: reset, load, count. */
  "decade-counter": (io, st) => {
    st.q ??= initState(io, 4);
    clocked(io, st, () => {
      const q: Bit[] = st.q;
      const v = big(q);
      const inc = v === null ? allX(4) : bitsOf(v >= 9n ? 0n : v + 1n, 4);
      const counted = pick(io.active("en"), inc, q);
      const loaded = io.has("ld") ? pick(io.active("ld", B0), io.bus("d"), counted) : counted;
      return pick(io.active("rst", B0), zeros(4), loaded);
    });
    const v = big(st.q);
    io.driveBus("q", st.q);
    io.drive("tc", [and([v === null ? BX : v === 9n ? B1 : B0, io.active("en")])]);
  },

  /** ROM: D shows the word at A from the `contents` list (X if the list cannot be read); CS low disconnects D. */
  rom: (io, st) => {
    const w = io.busWidth("d");
    const text = String(io.prop("contents") ?? "");
    if (st.text !== text) {
      st.text = text;
      st.words = parseRomContents(text);
    }
    const cs = io.active("cs");
    const a = big(io.bus("a"));
    const words: bigint[] | null = st.words;
    const word = words === null || a === null ? allX(w) : bitsOf(words[Number(a)] ?? 0n, w);
    io.driveBus("d", cs === B1 ? word : cs === B0 ? "Z" : "X");
  },

  /** RAM: reads follow the address; WE (and CS) write WD (or the shared D bus) on the clock edge. Shared port: D is driven when OE (and CS) and not WE. */
  ram: (io, st) => {
    const shared = io.prop("dataPortMode") === "shared";
    const w = shared ? io.busWidth("dq") : io.busWidth("rd");
    st.mem ??= new Map<number, Bit[]>();
    const cs = io.active("cs");
    const addr = io.bus("a");
    const e = edge(io, st);
    if (e !== B0) {
      const data = shared ? io.bus("dq") : io.bus("wd");
      memWrite(st.mem, addr, data, and([e, io.active("we", B0), cs]), w, initState(io, w));
    }
    const word = memReadAny(io, st.mem, addr, w);
    if (shared) {
      const drive = and([io.active("oe", B0), cs, not(io.active("we", B0))]);
      io.driveBus("dq", drive === B1 ? word : drive === B0 ? "Z" : "X");
    } else io.driveBus("rd", cs === B1 ? word : cs === B0 ? "Z" : "X");
  },

  /** Dual-port RAM: port A writes DIN A on the clock edge when WE A; both ports read combinationally. */
  "dual-port-ram": (io, st) => {
    const w = io.busWidth("douta");
    st.mem ??= new Map<number, Bit[]>();
    const e = edge(io, st);
    if (e !== B0) memWrite(st.mem, io.bus("addra"), io.bus("dina"), and([e, io.active("wea", B0)]), w, initState(io, w));
    io.driveBus("douta", memReadAny(io, st.mem, io.bus("addra"), w));
    io.driveBus("doutb", memReadAny(io, st.mem, io.bus("addrb"), w));
  },

  /** Register file: register 0 always reads 0 (MIPS / RISC-V); writes on the clock edge, reads follow the address. */
  "register-file": (io, st) => {
    let rp = 0, wp = 0;
    while (io.has(`ra${rp + 1}`) || io.has(`ra${rp + 1}_0`)) rp++;
    while (io.has(`we${wp + 1}`)) wp++;
    const w = io.busWidth("rd1", "_");
    st.mem ??= new Map<number, Bit[]>();
    const e = edge(io, st);
    if (e !== B0)
      for (let j = 1; j <= wp; j++) memWrite(st.mem, io.bus(`wa${j}`, "_"), io.bus(`wd${j}`, "_"), and([e, io.active(`we${j}`, B0)]), w, initState(io, w));
    for (let i = 1; i <= rp; i++) {
      const a = io.bus(`ra${i}`, "_");
      const v = big(a);
      io.driveBus(`rd${i}`, v === 0n ? zeros(w) : memReadAny(io, st.mem, a, w), "_");
    }
  },

  /** FIFO: on each clock, RST empties it; WR adds DIN unless full; RD removes the oldest word unless empty. DOUT shows the oldest word (X when empty). */
  fifo: (io, st) => {
    const depth = Math.max(2, Math.round(Number(io.prop("depth") ?? 16)));
    const w = io.busWidth("dout");
    st.items ??= [] as Bit[][];
    st.unsure ??= false;
    const e = edge(io, st);
    if (e !== B0) {
      const rst = io.active("rst", B0), wr = io.active("wr", B0), rd = io.active("rd", B0);
      if (e === B1 && rst === B1) {
        st.items = [];
        st.unsure = false;
      } else if (e === BX || rst === BX || wr === BX || rd === BX) st.unsure = true;
      else if (rst === B1) {
        st.items = [];
        st.unsure = false;
      } else {
        const items: Bit[][] = st.items;
        const wasFull = items.length >= depth, wasEmpty = items.length === 0;
        if (rd === B1 && !wasEmpty) items.shift();
        if (wr === B1 && !wasFull) items.push(io.bus("din"));
      }
    }
    const items: Bit[][] = st.items;
    io.driveBus("dout", st.unsure || !items.length ? allX(w) : items[0]);
    io.drive("full", [st.unsure ? BX : items.length >= depth ? B1 : B0]);
    io.drive("empty", [st.unsure ? BX : items.length === 0 ? B1 : B0]);
  },

  /** Stack: on each clock, RST empties it; PUSH stores DIN unless full; POP removes the top unless empty (both: replace the top). TOP shows the top word (X when empty). */
  stack: (io, st) => {
    const depth = Math.max(2, Math.round(Number(io.prop("depth") ?? 16)));
    const w = io.busWidth("top");
    st.items ??= [] as Bit[][];
    st.unsure ??= false;
    const e = edge(io, st);
    if (e !== B0) {
      const rst = io.active("rst", B0), push = io.active("push", B0), pop = io.active("pop", B0);
      if (e === B1 && rst === B1) {
        st.items = [];
        st.unsure = false;
      } else if (e === BX || rst === BX || push === BX || pop === BX) st.unsure = true;
      else if (rst === B1) {
        st.items = [];
        st.unsure = false;
      } else {
        const items: Bit[][] = st.items;
        if (pop === B1 && items.length) items.pop();
        if (push === B1 && items.length < depth) items.push(io.bus("din"));
      }
    }
    const items: Bit[][] = st.items;
    io.driveBus("top", st.unsure || !items.length ? allX(w) : items[items.length - 1]);
    io.drive("full", [st.unsure ? BX : items.length >= depth ? B1 : B0]);
    io.drive("empty", [st.unsure ? BX : items.length === 0 ? B1 : B0]);
  },

  /**
   * ALU, with the operation codes of Harris and Harris (the V-shaped textbook ALU):
   * 3 or more op bits, F[2:0]: 000 A AND B, 001 A OR B, 010 A + B, 011 unused (X),
   * 100 A AND NOT B, 101 A OR NOT B, 110 A - B, 111 set-less-than (signed); higher op bits must be 0.
   * 2 op bits: 00 A + B, 01 A - B, 10 A AND B, 11 A OR B. 1 op bit: 0 A + B, 1 A - B.
   * N is the top bit of Y, Z is Y = 0; C and V are the carry and signed overflow of the adder
   * (0 for logic operations).
   */
  alu: (io, st) => {
    void st;
    const w = io.busWidth("y");
    const a = big(io.bus("a")), b = big(io.bus("b"));
    const fbits = io.has("f") ? io.bits("f") : io.bus("f");
    const f = big(fbits);
    const flags = (y: Bit[], c: Bit, v: Bit) => {
      io.driveBus("y", y);
      io.drive("n", [y[w - 1] ?? BX]);
      io.drive("z", [y.includes(BX) ? BX : y.includes(B1) ? B0 : B1]);
      io.drive("c", [c]);
      io.drive("v", [v]);
    };
    if (a === null || b === null || f === null) return flags(allX(w), BX, BX);
    const n = fbits.length;
    const mask = (1n << BigInt(w)) - 1n;
    let op: string;
    if (n >= 3) {
      if (f >> 3n !== 0n) return flags(allX(w), BX, BX);
      op = ["and", "or", "add", "", "andn", "orn", "sub", "slt"][Number(f & 7n)];
    } else if (n === 2) op = ["add", "sub", "and", "or"][Number(f)];
    else op = f === 0n ? "add" : "sub";
    const sgn = (x: bigint) => BigInt.asIntN(w, x);
    const addsub = (sub: boolean) => {
      const bb = sub ? ~b & mask : b;
      const sum = a + bb + (sub ? 1n : 0n);
      const y = sum & mask;
      const c = (sum >> BigInt(w)) & 1n;
      const v = (sgn(a) >= 0n) === (sgn(bb) >= 0n) && (sgn(y) >= 0n) !== (sgn(a) >= 0n);
      return { y, c: Number(c) as Bit, v: (v ? B1 : B0) as Bit };
    };
    switch (op) {
      case "and": return flags(bitsOf(a & b, w), B0, B0);
      case "or": return flags(bitsOf(a | b, w), B0, B0);
      case "andn": return flags(bitsOf(a & ~b, w), B0, B0);
      case "orn": return flags(bitsOf((a | ~b) & mask, w), B0, B0);
      case "add": {
        const r = addsub(false);
        return flags(bitsOf(r.y, w), r.c, r.v);
      }
      case "sub": {
        const r = addsub(true);
        return flags(bitsOf(r.y, w), r.c, r.v);
      }
      case "slt": return flags(bitsOf(sgn(a) < sgn(b) ? 1n : 0n, w), B0, B0);
      default: return flags(allX(w), BX, BX);
    }
  },

  /**
   * Shifter by SH (unsigned). Universal mode: DIR = 0 shifts left, DIR = 1 shifts right, and AR = 1
   * makes a right shift arithmetic (copies the sign bit). A shift of the width or more gives all
   * zeros (or all sign bits for an arithmetic right shift); a rotation goes round.
   */
  shifter: (io) => {
    const x = io.bus("a");
    const w = x.length;
    let k = 0;
    const sh: Bit[] = [];
    while (io.has(`sh${k}`)) sh.push(io.bit(`sh${k++}`));
    const amount = big(sh);
    const mode = String(io.prop("mode") ?? "universal");
    const dir = mode === "universal" ? io.bit("dir") : mode === "lsl" ? B0 : B1;
    const arith = mode === "universal" ? io.bit("arith") : mode === "asr" ? B1 : B0;
    if (amount === null || dir === BX || (dir === B1 && arith === BX && mode !== "ror")) return io.driveBus("y", allX(w));
    const s = Number(amount);
    const out: Bit[] = new Array(w);
    for (let i = 0; i < w; i++) {
      if (mode === "ror") out[i] = x[(i + s) % w];
      else if (dir === B0) out[i] = i - s >= 0 ? x[i - s] : B0;
      else out[i] = i + s < w ? x[i + s] : arith === B1 ? x[w - 1] : B0;
    }
    io.driveBus("y", out);
  },

  /** 4-bit carry-lookahead generator (active-high P and G). */
  "carry-lookahead": (io) => {
    const p = [0, 1, 2, 3].map((i) => io.bit(`p${i}`)), g = [0, 1, 2, 3].map((i) => io.bit(`g${i}`));
    const c0 = io.bit("c0");
    const c1 = or([g[0], and([p[0], c0])]);
    const c2 = or([g[1], and([p[1], g[0]]), and([p[1], p[0], c0])]);
    const c3 = or([g[2], and([p[2], g[1]]), and([p[2], p[1], g[0]]), and([p[2], p[1], p[0], c0])]);
    io.drive("c1", [c1]);
    io.drive("c2", [c2]);
    io.drive("c3", [c3]);
    io.drive("p", [and(p)]);
    io.drive("g", [or([g[3], and([p[3], g[2]]), and([p[3], p[2], g[1]]), and([p[3], p[2], p[1], g[0]])])]);
  },
};

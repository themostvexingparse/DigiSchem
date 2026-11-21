/**
 * Two-level boolean minimization (sum of products), exact for the small functions schematics
 * deal with (up to about 8 inputs).
 *
 *  1. Prime implicants by Quine-McCluskey: group terms by their number of 1 bits, combine terms
 *     that differ in one bit, repeat until nothing combines. This is the Karnaugh-map method
 *     done mechanically: a prime implicant is a largest rectangle of 1s (and don't cares) that
 *     fits in the map.
 *  2. Cover: essential primes first (the only rectangle covering some 1), then the cheapest set
 *     of the remaining primes that covers every other 1, found exactly by branch and bound.
 *     Cost: fewest terms, then fewest literals.
 *
 * A term is { value, mask }: bits set in `mask` are don't-care positions (the variable is absent
 * from the product); the other bits of `value` say whether the variable appears plain (1) or
 * complemented (0). Bit i of a minterm is variable i, with variable 0 the least significant.
 */

export interface Term {
  value: number;
  mask: number;
}

export interface MinimizeResult {
  /** number of input variables */
  n: number;
  /** the minimal cover (sum of products) */
  terms: Term[];
  /** every prime implicant */
  primes: Term[];
  /** primes that are the only cover of some minterm */
  essential: Term[];
}

const popcount = (x: number) => {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
};

/** number of literals in a term */
export function literalCount(t: Term, n: number): number {
  return n - popcount(t.mask);
}

/** does the term cover minterm m? */
export function covers(t: Term, m: number): boolean {
  return (m & ~t.mask) === (t.value & ~t.mask);
}

/** Minimize f(x) = 1 on `minterms`, don't care on `dontCares`, 0 elsewhere. */
export function minimize(n: number, minterms: readonly number[], dontCares: readonly number[] = []): MinimizeResult {
  if (n < 0 || n > 16) throw new Error(`minimize: ${n} inputs is out of range (0..16)`);
  const size = 1 << n;
  for (const m of [...minterms, ...dontCares]) if (!Number.isInteger(m) || m < 0 || m >= size) throw new Error(`minimize: minterm ${m} is out of range for ${n} inputs`);
  const ones = [...new Set(minterms)].sort((a, b) => a - b);
  const dc = new Set(dontCares.filter((m) => !ones.includes(m)));
  if (!ones.length) return { n, terms: [], primes: [], essential: [] };

  // 1. prime implicants
  let level = new Map<string, Term>();
  for (const m of [...ones, ...dc]) level.set(`${m}/0`, { value: m, mask: 0 });
  const primes: Term[] = [];
  while (level.size) {
    const next = new Map<string, Term>();
    const used = new Set<string>();
    const list = [...level.entries()];
    // terms can only combine if they have the same mask and differ in exactly one other bit
    const byMask = new Map<number, [string, Term][]>();
    for (const e of list) (byMask.get(e[1].mask) ?? byMask.set(e[1].mask, []).get(e[1].mask)!).push(e);
    for (const group of byMask.values()) {
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i][1], b = group[j][1];
          const diff = (a.value ^ b.value) & ~a.mask;
          if (popcount(diff) !== 1) continue;
          const t = { value: a.value & ~diff, mask: a.mask | diff };
          next.set(`${t.value & ~t.mask}/${t.mask}`, { value: t.value & ~t.mask, mask: t.mask });
          used.add(group[i][0]);
          used.add(group[j][0]);
        }
    }
    for (const [k, t] of list) if (!used.has(k)) primes.push(t);
    level = next;
  }
  // a prime that covers only don't cares is never needed
  const useful = primes.filter((p) => ones.some((m) => covers(p, m)));

  // 2. cover
  const essential: Term[] = [];
  for (const m of ones) {
    const cov = useful.filter((p) => covers(p, m));
    if (cov.length === 1 && !essential.includes(cov[0])) essential.push(cov[0]);
  }
  const left = ones.filter((m) => !essential.some((p) => covers(p, m)));
  const rest = useful.filter((p) => !essential.includes(p));
  const cost = (ts: readonly Term[]) => ts.length * 1000 + ts.reduce((s, t) => s + literalCount(t, n), 0);
  let best: Term[] | null = null;
  // branch and bound: take the uncovered minterm with the fewest options, try each prime covering it
  const search = (chosen: Term[], uncovered: number[]) => {
    if (best && cost(chosen) >= cost(best)) return;
    if (!uncovered.length) {
      best = chosen.slice();
      return;
    }
    let pick = uncovered[0], opts = rest.filter((p) => covers(p, pick));
    for (const m of uncovered) {
      const o = rest.filter((p) => covers(p, m));
      if (o.length < opts.length) {
        pick = m;
        opts = o;
      }
    }
    opts.sort((a, b) => literalCount(a, n) - literalCount(b, n));
    for (const p of opts) {
      chosen.push(p);
      search(chosen, uncovered.filter((m) => !covers(p, m)));
      chosen.pop();
    }
  };
  search([], left);
  const terms = sortTerms([...essential, ...(best ?? [])], n);
  return { n, terms, primes: sortTerms(useful, n), essential: sortTerms(essential, n) };
}

/** larger rectangles first, then by value: a stable, readable order */
function sortTerms(ts: Term[], n: number): Term[] {
  return ts.slice().sort((a, b) => literalCount(a, n) - literalCount(b, n) || b.mask - a.mask || a.value - b.value);
}

/** Evaluate a sum of products at minterm m. */
export function evaluateSop(terms: readonly Term[], m: number): boolean {
  return terms.some((t) => covers(t, m));
}

/**
 * A term as text, e.g. "w3'w2w0" (names[i] is variable i; a ' marks a complement). The empty
 * product (every variable a don't care) is "1".
 */
export function termToString(t: Term, names: readonly string[], sep = ""): string {
  const lits: string[] = [];
  for (let i = names.length - 1; i >= 0; i--) {
    if (t.mask & (1 << i)) continue;
    lits.push(t.value & (1 << i) ? names[i] : `${names[i]}'`);
  }
  return lits.length ? lits.join(sep) : "1";
}

/** A whole sum of products as text ("0" if it has no terms). */
export function sopToString(terms: readonly Term[], names: readonly string[], sep = ""): string {
  return terms.length ? terms.map((t) => termToString(t, names, sep)).join(" + ") : "0";
}

/** Gray-code order of k bits: 0, 1, 3, 2 for k = 2 (adjacent entries differ in one bit). */
function gray(k: number): number[] {
  return Array.from({ length: 1 << k }, (_, i) => i ^ (i >> 1));
}

/**
 * A Karnaugh map as text for 2 to 4 inputs: rows are the high variables, columns the low ones,
 * both in Gray-code order, so neighbouring cells differ in one variable. `f(m)` gives the cell:
 * 1, 0 or "x" for don't care. Each 1 is followed by the letters of the chosen terms covering it.
 */
export function kmapText(n: number, f: (m: number) => 0 | 1 | "x", names: readonly string[], terms: readonly Term[] = []): string {
  if (n < 2 || n > 4) throw new Error("kmapText: 2 to 4 inputs");
  const colBits = Math.ceil(n / 2), rowBits = n - colBits;
  const cols = gray(colBits), rows = gray(rowBits);
  const bin = (v: number, k: number) => v.toString(2).padStart(k, "0");
  const rowName = names.slice(colBits).reverse().join(""), colName = names.slice(0, colBits).reverse().join("");
  const letter = (i: number) => String.fromCharCode(65 + i);
  const cell = (m: number) => {
    const v = f(m);
    const by = terms.map((t, i) => (covers(t, m) ? letter(i) : "")).join("");
    return v === 1 ? `1${by}` : String(v);
  };
  const w = Math.max(4, ...rows.flatMap((r) => cols.map((c) => cell((r << colBits) | c).length))) + 1;
  const head = `${rowName}\\${colName}`;
  const hw = Math.max(head.length, rowBits) + 1;
  const lines = [head.padEnd(hw) + "|" + cols.map((c) => bin(c, colBits).padStart(w)).join("")];
  lines.push("-".repeat(hw) + "+" + "-".repeat(w * cols.length));
  for (const r of rows) lines.push(bin(r, rowBits).padEnd(hw) + "|" + cols.map((c) => cell((r << colBits) | c).padStart(w)).join(""));
  if (terms.length) lines.push("", ...terms.map((t, i) => `  ${letter(i)} = ${termToString(t, names)}`));
  return lines.join("\n");
}

/**
 * DSpec source for a two-level AND-OR circuit of a sum of products: one input pin per variable
 * (named `names[i]`), a NOT gate per variable used complemented, an AND gate per product of two
 * or more literals, an OR gate if there are two or more products, and the output pin `out`.
 */
export function sopToDspec(terms: readonly Term[], names: readonly string[], out: string, title = out): string {
  const n = names.length;
  const L: string[] = [`@name "${title}"`, ""];
  const used = new Set<number>(), inverted = new Set<number>();
  for (const t of terms)
    for (let i = 0; i < n; i++) {
      if (t.mask & (1 << i)) continue;
      used.add(i);
      if (!(t.value & (1 << i))) inverted.add(i);
    }
  // inputs MSB first
  for (let i = n - 1; i >= 0; i--) L.push(`part ${names[i]} input-pin`);
  L.push(`part ${out} output-pin`, "");
  for (let i = n - 1; i >= 0; i--) if (inverted.has(i)) L.push(`part N_${names[i]} not label="${names[i]}'"`);
  const lit = (i: number, plain: boolean) => (plain ? names[i] : `N_${names[i]}`);
  // each term's signal: an input, an inverter output, an AND gate, or a constant
  const sigs: string[] = [];
  terms.forEach((t, k) => {
    const lits: string[] = [];
    for (let i = n - 1; i >= 0; i--) if (!(t.mask & (1 << i))) lits.push(lit(i, !!(t.value & (1 << i))));
    if (lits.length === 0) {
      L.push(`part ONE constant value="1" label=""`);
      sigs.push("ONE");
    } else if (lits.length === 1) sigs.push(lits[0]);
    else {
      L.push(`part P${k} and inputs=${lits.length} label="${termToString(t, names)}"`);
      lits.forEach((s, j) => L.push(`${s} -> P${k}.in${j}`));
      sigs.push(`P${k}`);
    }
  });
  if (!terms.length) {
    L.push(`part ZERO constant value="0" label=""`, `ZERO -> ${out}`);
  } else if (sigs.length === 1) L.push(`${sigs[0]} -> ${out}`);
  else {
    L.push(`part SUM or inputs=${sigs.length}`);
    sigs.forEach((s, j) => L.push(`${s} -> SUM.in${j}`));
    L.push(`SUM -> ${out}`);
  }
  for (const i of inverted) L.push(`${names[i]} -> N_${names[i]}`);
  // keep unused inputs on the drawing (they are part of the interface) without warnings
  if (used.size < n) L.splice(1, 0, "@warn unconnected=off");
  return L.join("\n") + "\n";
}

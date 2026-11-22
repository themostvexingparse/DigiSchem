/** Graph helpers for the logic modules. */

/** Strongly connected components (Tarjan, iterative), in reverse topological order: a component comes before every component that points to it. */
export function stronglyConnected(succ: readonly number[][]): number[][] {
  const n = succ.length;
  const index = new Array<number>(n).fill(-1), low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const out: number[][] = [];
  let next = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue;
    const work: [number, number][] = [[root, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i === 0) {
        index[v] = low[v] = next++;
        stack.push(v);
        onStack[v] = true;
      }
      if (i < succ[v].length) {
        top[1]++;
        const w = succ[v][i];
        if (index[w] < 0) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    }
  }
  return out;
}

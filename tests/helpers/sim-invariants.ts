/** Internal consistency checks of a Simulator after a settle (see tests/sim.invariants.test.ts). */
import { BX, BZ, type Bit, type Simulator } from "../../src/logic/simulate";

/** Every problem with the simulator's internal state, as text (empty when consistent). */
export function invariants(sim: Simulator): string[] {
  const s = sim as any;
  const out: string[] = [];
  const n: number = s.values.length;
  // groups from scratch: conducting switches, never through a rail
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const sw of s.switches) if (sw.on === 1 && !s.supplyNode[sw.a] && !s.supplyNode[sw.b]) parent[find(sw.a)] = find(sw.b);
  const want = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    want.set(r, [...(want.get(r) ?? []), i]);
  }
  for (const members of want.values()) {
    const roots = new Set(members.map((m) => s.root[m]));
    if (roots.size !== 1) out.push(`nodes ${members.join(",")} should be one group but have roots ${[...roots].join(",")}`);
    const r = s.root[members[0]];
    if (members.length > 1) {
      const got: number[] = s.members.get(r) ?? [];
      if ([...got].sort((a, b) => a - b).join() !== [...members].sort((a, b) => a - b).join()) out.push(`group ${r} lists ${got.join(",")}, should be ${members.join(",")}`);
    } else if (s.members.has(r) && s.members.get(r).length > 1) out.push(`node ${members[0]} is alone but group ${r} lists ${s.members.get(r).join(",")}`);
  }
  for (const [r, l] of s.members as Map<number, number[]>) for (const m of l) if (s.root[m] !== r) out.push(`group ${r} lists ${m} whose root is ${s.root[m]}`);
  // unknown-switch lists
  for (let i = 0; i < n; i++) {
    const wantU = s.switches.filter((sw: any) => sw.on === BX && (sw.a === i || sw.b === i)).length;
    const gotU = (s.unsure.get(i) ?? []).length;
    if (wantU !== gotU) out.push(`node ${i} has ${gotU} unknown switches listed, should be ${wantU}`);
  }
  // floating candidates and fixed point
  for (let i = 0; i < n; i++) {
    const shouldZ = s.values[i] === BZ && s.readers[i].length > 0;
    if (shouldZ !== s.zSet.has(i)) out.push(`node ${i}: floating set says ${s.zSet.has(i)}, value ${s.values[i]}`);
    if (s.forcedX.has(i)) continue;
    const v: Bit = s.resolve(i).value;
    if (v !== s.values[i]) out.push(`node ${i} holds ${s.values[i]} but resolves to ${v}`);
  }
  return out;
}


// Larger, hand-drawn-looking circuits for packer benchmarking (seeded, deterministic).
import { emptyDocument, type ComponentInstance, type SchematicDocument } from "../../src/model/types";
import { worldPins } from "../../src/model/geometry";
import { RouteObstacles, safeRoute } from "../../src/editor/safe-route";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pin = (c: ComponentInstance, id: string) => worldPins(c).find((p) => p.pin.id === id)!.pos;

/** `stages` columns of `perStage` gates, sprawled with random gaps/jitter, wired stage to stage. */
export function sprawled(seed: number, stages = 4, perStage = 6): SchematicDocument {
  const r = rng(seed);
  const d = emptyDocument(`sprawl-${seed}`);
  const types = ["and", "or", "xor", "nand"];
  const cols: ComponentInstance[][] = [];
  const ins: ComponentInstance[] = [];
  let y = 0;
  for (let i = 0; i < perStage * 2; i++) {
    y += 60 + Math.floor(r() * 6) * 20;
    const c: ComponentInstance = { id: `in${i}`, type: "input-pin", x: 0, y, rotation: 0, props: { name: `I${i}` }, label: `I${i}` };
    ins.push(c);
  }
  d.components.push(...ins);
  let x = 200;
  for (let s = 0; s < stages; s++) {
    x += 260 + Math.floor(r() * 8) * 20;
    const col: ComponentInstance[] = [];
    let gy = 0;
    for (let i = 0; i < perStage; i++) {
      gy += 140 + Math.floor(r() * 8) * 20;
      const c: ComponentInstance = {
        id: `g${s}_${i}`, type: types[Math.floor(r() * types.length)],
        x: x + Math.floor(r() * 4) * 20, y: gy, rotation: 0, props: { inputs: 2 }, label: `U${s}${i}`,
      };
      col.push(c);
    }
    cols.push(col);
    d.components.push(...col);
  }
  const outs: ComponentInstance[] = [];
  x += 300;
  cols[stages - 1].forEach((g, i) => {
    const o: ComponentInstance = { id: `out${i}`, type: "output-pin", x, y: g.y + 10 + Math.floor(r() * 3) * 20, rotation: 0, props: { name: `Y${i}` }, label: `Y${i}` };
    outs.push(o);
  });
  d.components.push(...outs);

  let wi = 0;
  const failed: string[] = [];
  const add = (a: ComponentInstance, p: string, b: ComponentInstance, q: string) => {
    // A driver feeding several gates: let the new wire touch its own net.
    const from = pin(a, p);
    const sameNet = new Set(d.wires.filter((w) => w.points[0].x === from.x && w.points[0].y === from.y).map((w) => w.id));
    const route = safeRoute(new RouteObstacles(d), from, pin(b, q), { sameNet });
    if (route) d.wires.push({ id: `w${wi++}`, points: route });
    else failed.push(`${a.id}.${p}->${b.id}.${q}`);
  };
  // inputs → stage 0 (each gate gets two distinct inputs, mostly nearby)
  cols[0].forEach((g, i) => {
    add(ins[(2 * i) % ins.length], "out", g, "in0");
    add(ins[(2 * i + 1) % ins.length], "out", g, "in1");
  });
  for (let s = 1; s < stages; s++) {
    cols[s].forEach((g, i) => {
      const a = cols[s - 1][i];
      const b = cols[s - 1][(i + 1 + Math.floor(r() * 2)) % perStage];
      add(a, "out", g, "in0");
      if (b !== a) add(b, "out", g, "in1");
    });
  }
  cols[stages - 1].forEach((g, i) => add(g, "out", outs[i], "in"));
  (d as any)._failed = failed;
  return d;
}

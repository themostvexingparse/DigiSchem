import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument, type ComponentInstance, type Point } from "../src/model/types";
import { componentBounds, worldPins } from "../src/model/geometry";
import {
  computeEventClutter,
  DEFAULT_QUALITY_WEIGHTS,
  layoutQuality,
} from "../src/layout/quality";

registerBuiltinComponents();

function pinPos(c: ComponentInstance, pinId: string): Point {
  const wp = worldPins(c).find((p) => p.pin.id === pinId);
  if (!wp) throw new Error(`Pin ${pinId} not found on ${c.id} (${c.type})`);
  return { ...wp.pos };
}

describe("layout/quality — default weights & invariants", () => {
  it("satisfies overlap = componentCollision = Infinity > crossing > junction > 0", () => {
    expect(DEFAULT_QUALITY_WEIGHTS.overlap).toBe(Infinity);
    expect(DEFAULT_QUALITY_WEIGHTS.componentCollision).toBe(Infinity);
    expect(DEFAULT_QUALITY_WEIGHTS.crossing).toBeGreaterThan(DEFAULT_QUALITY_WEIGHTS.junction);
    expect(DEFAULT_QUALITY_WEIGHTS.junction).toBeGreaterThan(0);
    expect(DEFAULT_QUALITY_WEIGHTS.clutter).toBeGreaterThan(0);
    expect(DEFAULT_QUALITY_WEIGHTS.clutterRadius).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_QUALITY_WEIGHTS.clutterRadius).toBeLessThanOrEqual(6);
    expect(DEFAULT_QUALITY_WEIGHTS.area).toBeGreaterThan(0);
    expect(DEFAULT_QUALITY_WEIGHTS.area).toBeLessThan(DEFAULT_QUALITY_WEIGHTS.junction);
  });

  it("returns all zeros on an empty document (no NaN from 0 * Infinity)", () => {
    const q = layoutQuality(emptyDocument("Empty"));
    expect(q).toEqual({
      area: 0,
      crossings: 0,
      overlaps: 0,
      componentCollisions: 0,
      junctions: 0,
      bends: 0,
      clutter: 0,
      alignment: 0,
      spacing: 0,
      total: 0,
    });
  });
});

describe("layout/quality — individual terms", () => {
  it("penalises collinear segment overlaps between two different wires with +Infinity", () => {
    const clean = emptyDocument("CleanParallel");
    clean.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "w2", points: [{ x: 0, y: 20 }, { x: 100, y: 20 }] },
    );
    const qClean = layoutQuality(clean);
    expect(qClean.overlaps).toBe(0);
    expect(Number.isFinite(qClean.total)).toBe(true);

    const overlapping = emptyDocument("CollinearOverlap");
    overlapping.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "w2", points: [{ x: 40, y: 0 }, { x: 140, y: 0 }] },
    );
    const qOverlap = layoutQuality(overlapping);
    expect(qOverlap.overlaps).toBe(Infinity);
    expect(qOverlap.total).toBe(Infinity);

    // Merely meeting end-to-end (shared endpoint, zero overlap stretch) is NOT an overlap
    const endToEnd = emptyDocument("EndToEnd");
    endToEnd.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 60, y: 0 }] },
      { id: "w2", points: [{ x: 60, y: 0 }, { x: 120, y: 0 }] },
    );
    expect(layoutQuality(endToEnd).overlaps).toBe(0);
  });

  it("penalises component collisions and componentGap violations with +Infinity (while allowing pin abutment)", () => {
    const g1: ComponentInstance = { id: "g1", type: "and", x: 0, y: 0, rotation: 0, props: { inputs: 2 } };
    const b1 = componentBounds(g1);

    // Valid spacing: gap === 20 (2 grid cells)
    const okDoc = emptyDocument("OkGap");
    okDoc.components.push(
      g1,
      { id: "g2", type: "and", x: b1.x + b1.w + 20, y: 0, rotation: 0, props: { inputs: 2 } },
    );
    expect(layoutQuality(okDoc).componentCollisions).toBe(0);
    expect(Number.isFinite(layoutQuality(okDoc).total)).toBe(true);

    // Too close: gap === 10 (< componentGap 20)
    const tooClose = emptyDocument("TooClose");
    tooClose.components.push(
      g1,
      { id: "g2", type: "and", x: b1.x + b1.w + 10, y: 0, rotation: 0, props: { inputs: 2 } },
    );
    expect(layoutQuality(tooClose).componentCollisions).toBe(Infinity);
    expect(layoutQuality(tooClose).total).toBe(Infinity);

    // Body overlap
    const overlapDoc = emptyDocument("BodyOverlap");
    overlapDoc.components.push(
      g1,
      { id: "g2", type: "and", x: 20, y: 10, rotation: 0, props: { inputs: 2 } },
    );
    expect(layoutQuality(overlapDoc).componentCollisions).toBe(Infinity);
    expect(layoutQuality(overlapDoc).total).toBe(Infinity);

    // Clean direct pin-to-pin abutment (out -> in0 at exact same point) is legal
    const abutDoc = emptyDocument("PinAbutment");
    const outP = pinPos(g1, "out");
    const notProbe: ComponentInstance = { id: "n1", type: "not", x: 0, y: 0, rotation: 0, props: {} };
    const notInOff = pinPos(notProbe, "in0");
    const n1: ComponentInstance = {
      id: "n1",
      type: "not",
      x: outP.x - notInOff.x,
      y: outP.y - notInOff.y,
      rotation: 0,
      props: {},
    };
    abutDoc.components.push(g1, n1);
    expect(layoutQuality(abutDoc).componentCollisions).toBe(0);
  });

  it("penalises 1 plain crossing more than 1 junction dot (with identical bounding box)", () => {
    const crossDoc = emptyDocument("OneCrossing");
    crossDoc.wires.push(
      { id: "wH", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      { id: "wV", points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] },
    );

    const juncDoc = emptyDocument("OneJunction");
    juncDoc.wires.push(
      { id: "wH", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      // T-junction at (50, 50) plus bounding corners matching crossDoc (100x100)
      { id: "wV", points: [{ x: 50, y: 50 }, { x: 50, y: 100 }] },
      { id: "wTop", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
    );

    const qCross = layoutQuality(crossDoc);
    const qJunc = layoutQuality(juncDoc);

    expect(qCross.crossings).toBe(DEFAULT_QUALITY_WEIGHTS.crossing);
    expect(qCross.junctions).toBe(0);
    expect(qJunc.crossings).toBe(0);
    expect(qJunc.junctions).toBe(DEFAULT_QUALITY_WEIGHTS.junction);
    expect(qCross.crossings).toBeGreaterThan(qJunc.junctions);
    expect(qCross.total).toBeGreaterThan(qJunc.total);
  });

  it("scores 4 clustered events strictly worse (higher clutter) than 4 spread-out events (superlinear)", () => {
    // 4 crossings tightly clustered in a 2x2 grid (10px apart) inside a 400x400 box
    const clustered = emptyDocument("ClusteredCrossings");
    clustered.wires.push(
      { id: "h1", points: [{ x: 0, y: 100 }, { x: 400, y: 100 }] },
      { id: "h2", points: [{ x: 0, y: 110 }, { x: 400, y: 110 }] },
      { id: "v1", points: [{ x: 100, y: 0 }, { x: 100, y: 400 }] },
      { id: "v2", points: [{ x: 110, y: 0 }, { x: 110, y: 400 }] },
    );

    // 4 crossings spread 200px (20 grid cells) apart inside the EXACT same 400x400 box
    const spread = emptyDocument("SpreadCrossings");
    spread.wires.push(
      { id: "h1", points: [{ x: 0, y: 100 }, { x: 400, y: 100 }] },
      { id: "h2", points: [{ x: 0, y: 300 }, { x: 400, y: 300 }] },
      { id: "v1", points: [{ x: 100, y: 0 }, { x: 100, y: 400 }] },
      { id: "v2", points: [{ x: 300, y: 0 }, { x: 300, y: 400 }] },
    );

    const qClust = layoutQuality(clustered);
    const qSpread = layoutQuality(spread);

    expect(qClust.crossings).toBe(4 * DEFAULT_QUALITY_WEIGHTS.crossing);
    expect(qSpread.crossings).toBe(4 * DEFAULT_QUALITY_WEIGHTS.crossing);
    expect(qClust.area).toBe(qSpread.area);
    expect(qClust.clutter).toBeGreaterThan(0);
    expect(qSpread.clutter).toBe(0);
    expect(qClust.total).toBeGreaterThan(qSpread.total);

    // Superlinearity check: 1 cluster of 4 events costs strictly MORE than 2 isolated clusters of 2 events
    const twoPairs: Point[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 },
      { x: 200, y: 0 }, { x: 210, y: 0 },
    ];
    const oneCluster4: Point[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 },
      { x: 0, y: 10 }, { x: 10, y: 10 },
    ];
    expect(computeEventClutter(oneCluster4, 10, 5)).toBeGreaterThan(
      computeEventClutter(twoPairs, 10, 5),
    );
  });

  it("rewards aligned same-type same-size components over misaligned ones (and ignores different types/sizes)", () => {
    const aligned = emptyDocument("Aligned");
    aligned.components.push(
      { id: "a1", type: "and", x: 0, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "a2", type: "and", x: 120, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "a3", type: "and", x: 240, y: 40, rotation: 0, props: { inputs: 2 } },
    );

    const misaligned = emptyDocument("Misaligned");
    misaligned.components.push(
      { id: "a1", type: "and", x: 0, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "a2", type: "and", x: 120, y: 50, rotation: 0, props: { inputs: 2 } },
      { id: "a3", type: "and", x: 240, y: 60, rotation: 0, props: { inputs: 2 } },
    );

    const qAligned = layoutQuality(aligned);
    const qMisaligned = layoutQuality(misaligned);

    expect(qAligned.alignment).toBeLessThan(0);
    expect(qMisaligned.alignment).toBe(0);
    expect(qAligned.total).toBeLessThan(qMisaligned.total);

    // Different types or different sizes should NOT get same-type alignment reward
    const mixed = emptyDocument("Mixed");
    mixed.components.push(
      { id: "a1", type: "and", x: 0, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "o1", type: "or", x: 120, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "a3", type: "and", x: 240, y: 40, rotation: 0, props: { inputs: 4 } },
    );
    expect(layoutQuality(mixed).alignment).toBe(0);
  });

  it("rewards equal consecutive gaps over uneven gaps for 3 same-type gates in a row (same total bbox)", () => {
    // Both have outer gates at x=0 and x=240 (identical bounding box and alignment!)
    const equal = emptyDocument("EqualGaps");
    equal.components.push(
      { id: "g1", type: "and", x: 0, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "g2", type: "and", x: 120, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "g3", type: "and", x: 240, y: 40, rotation: 0, props: { inputs: 2 } },
    );

    const uneven = emptyDocument("UnevenGaps");
    uneven.components.push(
      { id: "g1", type: "and", x: 0, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "g2", type: "and", x: 90, y: 40, rotation: 0, props: { inputs: 2 } },
      { id: "g3", type: "and", x: 240, y: 40, rotation: 0, props: { inputs: 2 } },
    );

    const qEq = layoutQuality(equal);
    const qUn = layoutQuality(uneven);

    expect(qEq.area).toBe(qUn.area);
    expect(qEq.alignment).toBe(qUn.alignment);
    expect(qEq.spacing).toBeLessThan(0);
    expect(qUn.spacing).toBeGreaterThan(0);
    expect(qEq.total).toBeLessThan(qUn.total);
  });
});

describe("overlaps judged against baseline nets", () => {
  it("same baseline net → finite sameNetOverlap; different baseline nets → Infinity (a new short)", () => {
    const d = emptyDocument("ov");
    d.wires.push(
      { id: "w1", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "w2", points: [{ x: 40, y: 0 }, { x: 140, y: 0 }] },
    );
    const same = layoutQuality(d, { baselineNets: new Map([["w1", 0], ["w2", 0]]) });
    expect(same.overlaps).toBe(DEFAULT_QUALITY_WEIGHTS.sameNetOverlap);
    expect(Number.isFinite(same.total)).toBe(true);
    expect(DEFAULT_QUALITY_WEIGHTS.sameNetOverlap).toBeGreaterThan(DEFAULT_QUALITY_WEIGHTS.crossing);
    const diff = layoutQuality(d, { baselineNets: new Map([["w1", 0], ["w2", 1]]) });
    expect(diff.overlaps).toBe(Infinity);
    expect(diff.total).toBe(Infinity);
  });
});

describe("clutter near component pins costs more", () => {
  it("the same crossing pair costs more next to a gate's pins than far away", () => {
    registerBuiltinComponents();
    const mk = (ox: number) => {
      const d = emptyDocument("pin-clutter");
      d.components.push({ id: "g", type: "and", x: 400, y: 0, rotation: 0, props: { inputs: 2 } });
      // two vertical wires crossing one horizontal wire, 20 apart, ending `ox` left of in0 (400,10)
      d.wires.push(
        { id: "h", points: [{ x: 300 - ox, y: 20 }, { x: 400 - ox + 60, y: 20 }] },
        { id: "v1", points: [{ x: 390 - ox, y: -20 }, { x: 390 - ox, y: 60 }] },
        { id: "v2", points: [{ x: 380 - ox, y: -20 }, { x: 380 - ox, y: 60 }] },
      );
      return layoutQuality(d);
    };
    const near = mk(0), far = mk(600);
    expect(near.crossings).toBe(far.crossings);
    expect(near.clutter).toBeGreaterThan(far.clutter * 1.5);
  });
});

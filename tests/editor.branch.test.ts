import { describe, expect, it } from "vitest";
import { trimToBranchPoints } from "../src/editor/safe-route";

describe("trimToBranchPoints (split a new connection at its branch point)", () => {
  const net = [{ points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }] }];

  it("drops the stretch running on the existing wire and starts at the T-junction", () => {
    // new wire from the shared pin (0,0) runs along the net to x=200, then turns down
    const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 400, y: 100 }];
    expect(trimToBranchPoints(pts, net)).toEqual([{ x: 200, y: 0 }, { x: 200, y: 100 }, { x: 400, y: 100 }]);
  });

  it("branches mid-segment when the overlap ends inside a segment", () => {
    const pts = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 60 }];
    // shared up to x=300 (end of the net's horizontal run), then continues alone
    expect(trimToBranchPoints(pts, net)).toEqual([{ x: 300, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 60 }]);
  });

  it("trims both ends and leaves non-overlapping wires untouched", () => {
    const both = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -80 }, { x: 300, y: -80 }, { x: 300, y: 0 }, { x: 300, y: 150 }];
    expect(trimToBranchPoints(both, net)).toEqual([{ x: 100, y: 0 }, { x: 100, y: -80 }, { x: 300, y: -80 }, { x: 300, y: 0 }]);
    const clean = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }];
    expect(trimToBranchPoints(clean, net)).toEqual(clean);
  });

  it("never collapses a wire that lies entirely on the net", () => {
    const dup = [{ x: 0, y: 0 }, { x: 300, y: 0 }];
    expect(trimToBranchPoints(dup, net)).toEqual(dup);
  });
});

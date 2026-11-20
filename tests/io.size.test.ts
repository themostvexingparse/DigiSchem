import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { parseProject, parseProjectWithWarnings, serializeProject } from "../src/io/project";
import { emptyDocument } from "../src/model/types";
import { effectiveProps } from "../src/model/geometry";

registerBuiltinComponents();

describe("component size (resize) persistence", () => {
  it("round-trips size through save/open", () => {
    const d = emptyDocument();
    d.components.push({ id: "r", type: "register", x: 0, y: 0, rotation: 0, props: {}, size: { w: 120, h: 200 } });
    const back = parseProject(serializeProject(d));
    expect(back.components[0].size).toEqual({ w: 120, h: 200 });
  });
  it("snaps and validates size", () => {
    const d = emptyDocument();
    d.components.push({ id: "r", type: "register", x: 0, y: 0, rotation: 0, props: {}, size: { w: 123, h: 196 } });
    d.components.push({ id: "s", type: "register", x: 0, y: 0, rotation: 0, props: {}, size: { w: -5, h: 0 } as never });
    const { doc, warnings } = parseProjectWithWarnings(serializeProject(d));
    expect(doc.components[0].size).toEqual({ w: 120, h: 200 });
    expect(doc.components[1].size).toBeUndefined();
    expect(warnings.some((w) => /invalid size/.test(w))).toBe(true);
  });
  it("effectiveProps only passes _w/_h for resizable defs", () => {
    expect(effectiveProps({ type: "not", props: {}, size: { w: 100, h: 100 } })._w).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { emptyDocument, type SchematicDocument } from "../src/model/types";
import {
  CURRENT_VERSION,
  MIGRATIONS,
  PROJECT_EXTENSION,
  ProjectError,
  parseProject,
  parseProjectWithWarnings,
  runMigrations,
  serializeProject,
  type ProjectMigration,
} from "../src/io/project";

describe("io/project", () => {
  it("exports expected extension and version constants", () => {
    expect(PROJECT_EXTENSION).toBe("dschem");
    expect(CURRENT_VERSION).toBe(1);
    expect(MIGRATIONS).toBeTypeOf("object");
  });

  it("round-trips empty and populated documents with strict equality", () => {
    const empty = emptyDocument("Blank Sheet");
    expect(parseProject(serializeProject(empty))).toEqual(empty);

    const doc: SchematicDocument = {
      format: "digischem",
      version: 1,
      name: "4-Bit Adder",
      grid: 10,
      components: [
        {
          id: "c_and1",
          type: "and",
          x: 40,
          y: 20,
          rotation: 0,
          props: { inputs: 3 },
          label: "U1",
        },
        {
          id: "c_not1",
          type: "not",
          x: 160,
          y: 40,
          rotation: 90,
          mirror: true,
          props: {},
          label: "U2",
        },
      ],
      wires: [
        {
          id: "w1",
          points: [
            { x: 120, y: 50 },
            { x: 160, y: 50 },
            { x: 160, y: 40 },
          ],
        },
        {
          id: "w_bus",
          points: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
          ],
          width: 8,
        },
      ],
      texts: [
        {
          id: "t1",
          x: 20,
          y: 120,
          text: "Carry out\nStage 1",
          fontSize: 16,
        },
      ],
      meta: {
        author: "Ada Lovelace",
        course: "EE201",
        lab: "Lab 3",
      },
    };

    const json = serializeProject(doc);
    // Pretty-printed JSON with 2-space indentation
    expect(json).toContain('\n  "format": "digischem"');
    const { doc: parsed, warnings } = parseProjectWithWarnings(json);
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(doc);
  });

  it("serializes with deterministic stable key order regardless of input key insertion order", () => {
    const docA: SchematicDocument = {
      format: "digischem",
      version: 1,
      name: "OrderTest",
      grid: 10,
      components: [
        {
          label: "U1",
          props: { zProp: true, aProp: 4, mProp: "bus" },
          rotation: 180,
          y: 30,
          x: 10,
          type: "mux",
          id: "c1",
        },
      ],
      wires: [{ width: 4, points: [{ y: 20, x: 10 }, { y: 20, x: 50 }], id: "w1" }],
      texts: [{ fontSize: 12, text: "hi", y: 10, x: 10, id: "t1" }],
      meta: { lab: "Lab 1", author: "Grace", course: "CS150" },
    };

    const docB: SchematicDocument = {
      meta: { course: "CS150", lab: "Lab 1", author: "Grace" },
      texts: [{ id: "t1", x: 10, y: 10, text: "hi", fontSize: 12 }],
      wires: [{ id: "w1", points: [{ x: 10, y: 20 }, { x: 50, y: 20 }], width: 4 }],
      components: [
        {
          id: "c1",
          type: "mux",
          x: 10,
          y: 30,
          rotation: 180,
          props: { aProp: 4, mProp: "bus", zProp: true },
          label: "U1",
        },
      ],
      grid: 10,
      name: "OrderTest",
      version: 1,
      format: "digischem",
    };

    expect(serializeProject(docA)).toBe(serializeProject(docB));
  });

  it("preserves unknown component types so future/plugin files round-trip", () => {
    const doc: SchematicDocument = {
      format: "digischem",
      version: 1,
      name: "Custom Parts",
      grid: 10,
      components: [
        {
          id: "custom1",
          type: "quantum_alu_9000",
          x: 50,
          y: 60,
          rotation: 270,
          props: { qubits: 16, mode: "entangled", active: true },
          label: "Q1",
        },
      ],
      wires: [],
      texts: [],
    };

    const { doc: parsed, warnings } = parseProjectWithWarnings(serializeProject(doc));
    expect(warnings).toEqual([]);
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0]).toEqual(doc.components[0]);
  });

  it("throws ProjectError with clear messages for invalid JSON, wrong format, and unsupported versions", () => {
    expect(() => parseProject("{not valid json")).toThrow(ProjectError);
    expect(() => parseProject("{not valid json")).toThrow(/Invalid JSON/i);

    expect(() => parseProject("[]")).toThrow(ProjectError);
    expect(() => parseProject("null")).toThrow(ProjectError);
    expect(() => parseProject('"hello"')).toThrow(ProjectError);

    expect(() => parseProject(JSON.stringify({ format: "kicad", version: 1 }))).toThrow(ProjectError);
    expect(() => parseProject(JSON.stringify({ format: "kicad", version: 1 }))).toThrow(/Not a DigiSchem/i);

    expect(() => parseProject(JSON.stringify({ format: "digischem", version: 0 }))).toThrow(ProjectError);
    expect(() => parseProject(JSON.stringify({ format: "digischem", version: "1" }))).toThrow(ProjectError);
    expect(() => parseProject(JSON.stringify({ format: "digischem", version: 1.5 }))).toThrow(ProjectError);

    expect(() => parseProject(JSON.stringify({ format: "digischem", version: 99 }))).toThrow(ProjectError);
    expect(() => parseProject(JSON.stringify({ format: "digischem", version: 99 }))).toThrow(/Unsupported project version 99/i);
  });

  it("sanitizes coordinates, rotations, numeric strings, duplicate ids, and drops malformed entries", () => {
    const dirty = {
      format: "digischem",
      version: 1,
      name: "",
      grid: "20",
      components: [
        null,
        { id: "bad_type", type: "", x: 0, y: 0, rotation: 0, props: {} },
        { id: "bad_xy", type: "and", x: "nope", y: 10, rotation: 0, props: {} },
        {
          id: "dup_id",
          type: "and",
          x: "26", // coerced to 26 -> snapped to 20 (grid 20)
          y: 34, // snapped to 40 (grid 20)
          rotation: -90, // normalized to 270
          mirror: "true",
          props: { inputs: 4, nested: { bad: 1 }, nanVal: Number.NaN },
          label: 42,
        },
        {
          id: "dup_id", // duplicate id -> regenerated
          type: "not",
          x: 11, // snapped to 20
          y: -12, // snapped to -20
          rotation: 45, // normalized to 90
          props: "not-an-object",
        },
      ],
      wires: [
        "not-a-wire",
        { id: "short_wire", points: [{ x: 0, y: 0 }] },
        { id: "bad_pt_wire", points: [{ x: 0, y: 0 }, { x: "bad", y: 10 }] },
        {
          id: "dup_id", // duplicate id across components & wires -> regenerated
          points: [
            { x: "9", y: 21 }, // -> (0, 20)
            { x: 52, y: 21 }, // -> (60, 20)
          ],
          width: "4.4", // -> 4
        },
      ],
      texts: [
        42,
        { id: "bad_text", x: 0, y: 0, text: null },
        {
          id: "dup_id", // duplicate id -> regenerated
          x: 19, // -> 20
          y: 61, // -> 60
          text: "Note",
          fontSize: "14",
        },
      ],
      meta: {
        author: "Student",
        year: 2026,
        ignoredObj: { a: 1 },
      },
    };

    const { doc, warnings } = parseProjectWithWarnings(JSON.stringify(dirty));

    expect(doc.name).toBe("Untitled");
    expect(doc.grid).toBe(20);
    expect(doc.components).toHaveLength(2);
    expect(doc.wires).toHaveLength(1);
    expect(doc.texts).toHaveLength(1);

    // Coordinates snapped to doc.grid (20) & rotations forced into {0, 90, 180, 270}
    const [c0, c1] = doc.components;
    expect(c0.x).toBe(20);
    expect(c0.y).toBe(40);
    expect(c0.rotation).toBe(270);
    expect(c0.mirror).toBe(true);
    expect(c0.props).toEqual({ inputs: 4 });
    expect(c0.label).toBe("42");

    expect(c1.x).toBe(20);
    expect(c1.y).toBe(-20);
    expect(c1.rotation).toBe(90);
    expect(c1.props).toEqual({});

    const [w0] = doc.wires;
    expect(w0.points).toEqual([
      { x: 0, y: 20 },
      { x: 60, y: 20 },
    ]);
    expect(w0.width).toBe(4);

    const [t0] = doc.texts;
    expect(t0.x).toBe(20);
    expect(t0.y).toBe(60);
    expect(t0.fontSize).toBe(14);

    // Every surviving entity has a unique ID across components, wires, and texts
    const allIds = [c0.id, c1.id, w0.id, t0.id];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(c0.id).toBe("dup_id");
    expect(c1.id).not.toBe("dup_id");
    expect(w0.id).not.toBe("dup_id");
    expect(t0.id).not.toBe("dup_id");

    // Metadata coerced and invalid entries dropped
    expect(doc.meta).toEqual({ author: "Student", year: "2026" });

    // Warnings were recorded for the sanitized issues
    expect(warnings.length).toBeGreaterThanOrEqual(10);
  });

  it("runs sequential version migrations via the migration scaffold", () => {
    const warnings: string[] = [];
    const customMigrations: Record<number, ProjectMigration> = {
      1: (raw, w) => {
        w.push("migrated v1->v2");
        return { ...raw, name: `${String(raw.name)} (v2)` };
      },
      2: (raw, w) => {
        w.push("migrated v2->v3");
        return { ...raw, grid: 20 };
      },
    };

    const rawV1: Record<string, unknown> = {
      format: "digischem",
      version: 1,
      name: "Demo",
      grid: 10,
      components: [],
      wires: [],
      texts: [],
    };

    const upgraded = runMigrations(rawV1, 1, 3, customMigrations, warnings);
    expect(upgraded.version).toBe(3);
    expect(upgraded.name).toBe("Demo (v2)");
    expect(upgraded.grid).toBe(20);
    expect(warnings).toEqual(["migrated v1->v2", "migrated v2->v3"]);

    // Missing migration step throws ProjectError
    expect(() => runMigrations(rawV1, 1, 4, customMigrations, [])).toThrow(ProjectError);
    expect(() => runMigrations(rawV1, 1, 4, customMigrations, [])).toThrow(/No migration available/i);
  });
});

/**
 * CORE CONTRACT — DigiSchem document model.
 * Frozen: changes here require coordination across all modules.
 *
 * Coordinates are world units. 1 grid cell = doc.grid units (default 10).
 * All pins and wire vertices must lie on grid points.
 */

export interface Point {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export type PropValue = number | string | boolean;

/** A placed component. `type` refers to a ComponentDef registered in the registry. */
export interface ComponentInstance {
  id: string;
  type: string;
  /** World position of the component's local origin (0,0). Always grid aligned. */
  x: number;
  y: number;
  /** Clockwise rotation about the local origin. */
  rotation: Rotation;
  /** Mirror horizontally (in local space, before rotation). */
  mirror?: boolean;
  /** Type-specific properties (input count, bit width, ...). See ComponentDef.props. */
  props: Record<string, PropValue>;
  /** Optional user label drawn near the component (e.g. "U1", "A", "CLK"). */
  label?: string;
}

/**
 * A wire is an orthogonal polyline (each consecutive pair of points shares x or y).
 * Connectivity is GEOMETRIC: wires connect to pins and to each other where
 * an endpoint coincides with a pin position, another wire's vertex, or lies on
 * another wire's segment (T-junction).
 */
export interface Wire {
  id: string;
  points: Point[];
  /** Optional bus width annotation (>1 draws a thick bus line with a slash label). */
  width?: number;
}

export interface TextNote {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize?: number;
}

export interface SchematicDocument {
  format: "digischem";
  /** File format version. Bump + add a migration in io/project.ts when changing. */
  version: 1;
  name: string;
  grid: number;
  components: ComponentInstance[];
  wires: Wire[];
  texts: TextNote[];
  /** Free-form metadata (author, course, lab number...). */
  meta?: Record<string, string>;
}

export function emptyDocument(name = "Untitled"): SchematicDocument {
  return { format: "digischem", version: 1, name, grid: 10, components: [], wires: [], texts: [] };
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${idCounter.toString(36)}`;
}

/** CONTRACT (owned by io module): project file (.dschem) serialization. STUB. */
import type { SchematicDocument } from "../model/types";

export const PROJECT_EXTENSION = "dschem";

export class ProjectError extends Error {}

export function serializeProject(doc: SchematicDocument): string {
  return JSON.stringify(doc, null, 2);
}

/** Parse + validate + migrate. Throws ProjectError with a user-readable message. */
export function parseProject(text: string): SchematicDocument {
  const d = JSON.parse(text);
  if (d?.format !== "digischem") throw new ProjectError("Not a DigiSchem project file");
  return d as SchematicDocument;
}

// Plain-language explanations of connection conflicts (see model/links.ts), naming the parts and
// pins involved. Used for the canvas tooltips and the toast shown when an edit creates conflicts.
import type { ConnectionConflict } from "../model/links";
import type { SchematicDocument } from "../model/types";
import { getDef } from "../model/registry";
import { worldPins } from "../model/geometry";

/** "U3 (AND Gate), pin Y", "a wire", ... for a `p:comp|pin` or `w:id` terminal. */
export function terminalName(doc: SchematicDocument, t: string): string {
  if (t.startsWith("w:")) return "a wire";
  const bar = t.indexOf("|");
  const compId = t.slice(2, bar), pinId = t.slice(bar + 1);
  const comp = doc.components.find((c) => c.id === compId);
  if (!comp) return "a pin";
  const def = getDef(comp.type);
  const pin = worldPins(comp).find((w) => w.pin.id === pinId)?.pin;
  const label = comp.label?.trim();
  const part = label && def ? `${label} (${def.name})` : label || def?.name || comp.type;
  let pinName = pin?.name?.trim() || pin?.id || pinId;
  if (pin?.inverted && pin.dir === "out" && pinName && !pinName.endsWith("'")) pinName += "'";
  return `${part}, pin ${pinName}`;
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export const CONFLICT_TITLE: Record<ConnectionConflict["kind"], string> = {
  drivers: "Two outputs wired together",
  unintended: "Touching, but not connected",
  broken: "Connected, but not touching",
};

/** Multi-line tooltip text for one conflict marker. */
export function describeConflict(doc: SchematicDocument, c: ConnectionConflict): string {
  const a = terminalName(doc, c.a), b = terminalName(doc, c.b);
  switch (c.kind) {
    case "drivers":
      return (
        `${CONFLICT_TITLE.drivers}\n` +
        `${cap(b)} and ${a} are outputs on the same net.\n` +
        "Each output tries to set the net's value. When one says 0 and the other says 1, the value " +
        "is undefined, and in real hardware this is a short circuit (bus contention).\n" +
        "Fix: drive each net from one output only. To share a line, use a multiplexer, or tristate " +
        "buffers with only one enabled at a time."
      );
    case "unintended":
      return (
        `${CONFLICT_TITLE.unintended}\n` +
        `${cap(a)} and ${b} touch in the drawing, but the circuit does not connect them.\n` +
        "Fix: move them apart so the drawing matches the circuit. To connect them, draw a wire between them."
      );
    case "broken":
      return (
        `${CONFLICT_TITLE.broken}\n` +
        `${cap(a)} and ${b} are connected in the circuit, but the drawing no longer shows it.\n` +
        "Fix: drag the wire back onto the pin, or delete the wire to disconnect them."
      );
  }
}

/** One-paragraph toast text for a set of new conflicts. */
export function summarizeConflicts(list: readonly ConnectionConflict[]): string {
  const n = (k: ConnectionConflict["kind"]) => list.filter((c) => c.kind === k).length;
  const parts: string[] = [];
  const d = n("drivers"), u = n("unintended"), b = n("broken");
  if (d) parts.push(`${d === 1 ? "an output is" : `${d} outputs are`} wired to another output, so the value there is undefined (a short circuit in real hardware)`);
  if (u) parts.push(`${u === 1 ? "a part or wire touches something" : `${u} parts or wires touch things`} without being connected`);
  if (b) parts.push(`${b === 1 ? "a connection is" : `${b} connections are`} no longer drawn touching`);
  const text = parts.join("; ");
  return `⚠ ${cap(text)}. Red rings mark the spots; hover one for details.`;
}

# File Format

A schematic is saved as a `.dschem` file: plain JSON, readable and easy to diff.

```json
{
  "format": "digischem",
  "version": 1,
  "name": "3-bit synchronous counter",
  "grid": 10,
  "components": [
    { "id": "ff0", "type": "d-ff", "x": 700, "y": 80, "rotation": 0, "props": {}, "label": "Q0" },
    { "id": "x1", "type": "xor", "x": 400, "y": 340, "rotation": 0, "props": { "inputs": 2 }, "label": "X1" }
  ],
  "wires": [
    { "id": "w1", "points": [{ "x": 500, "y": 370 }, { "x": 700, "y": 370 }] }
  ],
  "texts": [
    { "id": "t1", "x": 0, "y": -40, "text": "Lab 3: counter", "fontSize": 14 }
  ],
  "links": [["p:ff0|d", "w:w1"], ["p:x1|out", "w:w1"]],
  "meta": { "author": "...", "course": "...", "lab": "..." }
}
```

## Fields

| Field | Meaning |
|---|---|
| `format`, `version` | Always `"digischem"` and the format version (currently 1). A file from a newer version is refused with a clear message. |
| `name` | The document name. |
| `grid` | The grid size; always 10 (every pin sits on this grid). |
| `components` | Parts: `id`, `type` (see [Components](Components.md)), `x`, `y` (the top-left corner of the unrotated part), `rotation` (0, 90, 180, 270, clockwise), optional `mirror`, `props`, `label`, and `size` for resized parts. |
| `wires` | Orthogonal polylines: a list of points, each segment horizontal or vertical. An optional `width` marks a bus. |
| `texts` | Text notes with a position and an optional font size. |
| `links` | The stored connections (below). |
| `meta` | Free-form strings: author, course, lab. A schematic built from DSpec also stores its source here, so the Code dialog can show it again. |

Ids are unique across components, wires and texts together.

## Connections

Connectivity is stored separately from the drawing, in `links`: a sorted list of pairs of
**terminals**. A terminal is a wire, `w:<wireId>`, or a pin, `p:<componentId>|<pinId>`. Two
terminals in one pair are connected, and connection is transitive: a net is everything reachable
through the pairs.

The editor maintains the links: drawing a wire onto a pin or another wire connects them, and
moving things never changes them. The drawing is then checked against the links, and every place
where the two disagree is shown (see
[Using the Editor](Using-the-Editor.md#connection-checks)). This is what lets DigiSchem tell a
deliberate connection from two wires that happen to touch.

`links` is optional. A file without it (an older file, or one written by another program) is
read by geometry: a wire end on a pin or on another wire connects to it.

## Files the editor reads

| Extension | Contents |
|---|---|
| `.dschem` | A schematic (this format). |
| `.dspec` | DSpec source; opening it builds the schematic (see [DSpec Language](DSpec-Language.md)). |

When loading, damaged values are repaired where possible instead of failing the whole file: a
duplicate id is renamed, a coordinate off the grid is snapped to it, an invalid rotation becomes
0, an unsupported property or a malformed link is dropped. Each repair is reported as a warning.

## Exports

| Export | Contents |
|---|---|
| SVG | A vector picture: color, monochrome (for printing) or dark; optional background and grid dots. |
| PNG | The same picture as an image, at 1× to 6× scale. |
| Netlist | A text list of every net and the pins on it. |

The SVG and PNG exports use the same renderer as the canvas, so they look exactly like the screen.

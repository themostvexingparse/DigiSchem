# Using the Editor

The window has three parts: the **palette** of components on the left, the **canvas** in the
middle, and the **properties panel** on the right (toggle it with **P**). The toolbar along the
top has file commands, undo and redo, view controls, **Compact layout**, **Code**, **Settings**
and the shortcut list.

## Placing parts

Click a part in the palette, then click on the canvas to place it. Hold **Shift** while placing to
keep placing copies; **Esc** stops. Every part snaps to the 10-unit grid.

Select a part and press **R** to rotate it 90° clockwise or **M** to mirror it. Parts that can be
resized show a handle on their corner: drag it to make the body larger. The pins spread out
evenly over the new size.

## Wiring

- With the select tool (**V**), drag from a pin to another pin, or to a point on a wire, to draw
  a wire. The **wire tool** (**W**) draws wires from anywhere.
- While drawing, **/** flips the direction of the bend.
- A wire that ends on another wire joins it with a junction dot.
- Moving a part drags its wires along and re-routes them around anything they would otherwise
  touch.
- Drag the middle of a wire segment to move just that segment.

## Selecting and editing

| Action | How |
|---|---|
| Select | Click, or drag a box on empty canvas; Shift+click adds to the selection |
| Select all | Ctrl+A |
| Move | Drag, or use the arrow keys to nudge by one grid cell |
| Copy, cut, paste, duplicate | Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D |
| Delete | Del or Backspace |
| Undo, redo | Ctrl+Z, Ctrl+Y |

While you move parts, **guides** show when a part lines up with its neighbours or sits at an
equal spacing, and the part snaps onto them (both can be turned off in Settings).

## Text notes

The text tool (**T**) places a note. Double-click a note to edit it.

## The properties panel

With nothing selected, the panel shows the **document**: its name and fields for author, course
and lab, which are saved in the file. With a part selected, it shows the part's **label** and its
**properties**: number of inputs, bit width, select bits, edge, initial value and so on. Changing
a property changes the part's pins immediately (see [Components](Components.md)).

## Connection checks

DigiSchem stores what connects to what separately from the drawing (see
[File Format](File-Format.md#connections)). When the two disagree, the place is marked with a red
ring, and hovering over it explains the problem in plain words:

| Marker | Meaning | Fix |
|---|---|---|
| **Touching, but not connected** | Two things touch in the drawing, but the circuit does not connect them | Move them apart, or draw a wire if they should be connected |
| **Connected, but not touching** | The circuit connects two things, but the drawing no longer shows it | Drag the wire back onto the pin, or delete it |
| **Two outputs wired together** | Two outputs drive the same net (bus contention: a short circuit in real hardware) | Drive each net from one output; use a multiplexer or tristate buffers to share a line |

Unconnected pins can be shown with a small marker (Settings).

## Compact layout

**Ctrl+Shift+L** (or the toolbar button with four inward arrows) tightens the layout of the whole
schematic, or only of the selected parts. It runs in the background and is one undo step. See
[Layout and Routing](Layout-and-Routing.md) for what it does.

## Writing a schematic as code

**Ctrl+K** opens the **Code** dialog:

- **Build** (Ctrl+Enter) compiles the DSpec text and replaces the drawing (one undo step).
  Errors are listed under the text; click one to jump to its line.
- **Read from schematic** writes the current drawing as DSpec.
- **Open…** and **Save…** read and write `.dspec` files. **Ctrl+O** also opens `.dspec` files
  directly and builds them.
- **Copy guide for AI** copies the language guide and the full component list, ready to paste
  into a conversation with a language model.

See [DSpec Language](DSpec-Language.md).

## Export

**Ctrl+E** exports SVG, **Ctrl+Shift+E** exports PNG, and the **Export** menu also writes a text
netlist. Pictures can be in color, monochrome (for printing) or dark, with or without a
background and grid dots; PNGs at 1× to 6× scale.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Delete orphaned wires | on | Deleting a part also removes wires left dangling from its pins |
| Alignment & spacing guides | on | While moving a part, show guides to other parts of the same type and size |
| Snap to guides | on | Pull the part onto a guide when it is close |
| Advanced re-routing search (experimental) | off | Choose the new routes of moved wires with a deeper search: fewer crossings when many wires move, up to 25 ms per step |
| Show grid | on | Dotted 10-unit grid (also **G**) |
| Mark unconnected pins | on | Small red circles on pins with nothing attached |

The properties panel is shown or hidden with **P**. Settings are saved between sessions.

## Keyboard shortcuts

Press **?** in the editor to see this list.

| Keys | Action |
|---|---|
| V / W / T / H | Select, wire, text or pan tool |
| Drag from a pin | Draw a wire (select tool) |
| / (while wiring) | Flip the wire's bend direction |
| Esc | Cancel placing, wiring or dragging |
| R / M | Rotate 90° / mirror the selection |
| Del / Backspace | Delete the selection |
| Ctrl+C / X / V / D | Copy, cut, paste, duplicate |
| Ctrl+A | Select all |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Arrow keys | Nudge the selection by one grid cell |
| Shift (while placing) | Keep placing copies |
| Space+drag / middle-drag | Pan the view |
| Wheel / Shift+wheel | Scroll vertically / horizontally |
| Ctrl+wheel / pinch | Zoom around the cursor |
| Ctrl + / Ctrl − / Ctrl+0 | Zoom in, zoom out, 100% |
| F / G / P | Zoom to fit, toggle the grid, toggle the properties panel |
| Ctrl+N / O / S | New, open, save (Ctrl+Shift+S: save as) |
| Ctrl+E / Ctrl+Shift+E | Export SVG / PNG |
| Ctrl+Shift+L | Compact layout (the selection, or the whole schematic) |
| Ctrl+K | Code: write or read the schematic as DSpec (Ctrl+Enter builds) |
| ? | Show the shortcuts |

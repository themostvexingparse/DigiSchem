# DSpec: schematics as code

DSpec is a small text language for DigiSchem schematics. You list the parts and what connects
to what. The compiler places the parts, routes the wires, compacts the layout, and then checks
that the drawing connects exactly what the text says. It is meant for two kinds of authors:
people who would rather type a circuit than draw it, and language models, which can read, write
and edit schematics as text.

```dspec
@name "Half adder"
part A, B input-pin
part X1 xor
part G1 and
part S, C output-pin

A -> X1.in0, G1.in0
B -> X1.in1, G1.in1
X1 -> S
G1 -> C
```

Files use the `.dspec` extension. More examples are in `examples/`.

## Why a new language

Several existing tools describe circuits as text:

| Tool | What it is | Why it does not fit here |
|---|---|---|
| Structural Verilog / VHDL | Hardware description languages | They describe behaviour and hierarchy, not a drawing. Module instantiation is verbose, and nothing in them says where a part goes or how the layout should be tidied. |
| Yosys JSON + netlistsvg | Netlist to SVG with automatic layout (ELK) | Output is a picture, not an editable schematic. It has its own symbol set and no compaction control. |
| SKiDL (Python), atopile | Netlists for PCB design | Built around footprints and nets for board layout, with no schematic placement. A full programming language is more than a model needs. |
| tscircuit (React/TSX) | Circuits as JSX components | It needs a JavaScript toolchain and a framework to evaluate. Its layout is aimed at PCBs. |

None of them drives DigiSchem's own component library, router, packer and connection checks, so
DSpec is designed for them. It borrows the parts that models already write reliably:
instance-then-connect from structural netlists, `PART.PIN` references, and `->` for "drives".

## Design principles

1. **Semi-stateless.** Parts and connections are declarations. Their meaning does not depend on
   where they are in the file, so any line can be moved, deleted or appended without changing
   what the others mean. That makes edits by people and by models safe: there is no "current
   part" or cursor. Only directives (`@...`) carry state. Each one applies from the line it is
   on until it is changed again or its group ends.
2. **Connections are exact.** The output connects exactly the pins the text connects. The
   compiler checks this twice, against the drawing (what touches what) and against the stored
   connections. If either differs, the build fails rather than producing a wrong schematic.
   Routing quality can never change the circuit: a net that cannot be drawn cleanly is drawn
   with net labels instead.
3. **Deterministic.** The same text gives the same document, byte for byte. Part ids are the part
   names, and wire ids come from net names.
4. **Helpful errors.** Every problem has a line and column, names what is wrong, and suggests a fix
   ("Did you mean "xor"?", the list of a part's pins, a property's valid range).
5. **Layout is the compiler's job, but you can steer it.** Placement is automatic by default.
   `at=X,Y` pins a part, directives choose the layout style and when compaction runs, and
   rebuilding keeps the parts you did not change where they were.

## Statements

One statement per line. `#` or `//` starts a comment. A line ending in `,` or `->` continues on
the next line.

### part

```dspec
part NAME TYPE [prop=value ...] [at=X,Y] [rot=0|90|180|270] [mirror] [size=WxH] [label="..."]
part A, B input-pin            # several parts at once
part F0..F3 d-ff edge=falling  # a range: F0, F1, F2, F3
```

- `NAME`: letters, digits and `_`, not starting with a digit. It becomes the part's id and
  label.
- `TYPE`: a library type (`and`, `d-ff`, `mux`, ...) or an alias (`input`, `output`, `dff`,
  `inv`, `led`, `7seg`, ...). `dspec reference` lists them all.
- Properties are checked against the component: unknown keys, values out of range and invalid
  options are errors. Booleans accept `true/false/on/off/yes/no`; a bare key such as `mirror`
  means true.
- `at=X,Y` puts the part's origin there. Coordinates are multiples of 10. A part with `at=` is
  pinned, and placement and compaction never move it.
- `size=WxH` asks for a larger body on resizable parts.
- `input-pin`, `output-pin` and `tunnel` show a name inside the symbol. It defaults to the part
  name, and their label stays empty so the name is not drawn twice.
- `vcc`, `pull-up` and `pull-down` have their own `label` property (the rail name, the
  resistance). For them `label=` sets that property.

### Connections

```dspec
net CLK = CK, F0..F3.clk     # a named net
net U1.out, U2.in0           # an anonymous net
U1.out -> U2.in0, U3.in1     # the first pin drives the rest (same as an anonymous net)
```

- Lines that use the same net name are one net, and so are nets that share a pin. If a pin
  appears in two named nets, you get a warning that they are now one net.
- `PART.PIN` can use the pin id (`in0`, `out`, `d`, `clk`, `q`, `qn`, ...) or the pin's display
  name (`D`, `Q`, `CLK`). Inverted outputs also accept `Q'`, `~Q` or `nQ`. Matching is
  case-insensitive.
- A bare `PART` is allowed when it is unambiguous: the part's only pin, or, next to `->`, its only
  output (on the left) or only input (on the right).
- `PART.d[2]` is bit 2. The part needs `pinMode=bits` so that each bit is its own pin.
- `F0..F3.clk` means the `clk` pin of each of F0, F1, F2 and F3.

### text and group

```dspec
text "Lab 3: counter" at=0,-60 size=14

group stage1 {
  @compact never      # stays inside the group
  part U1, U2 and
  U1 -> U2.in0
}
```

Groups organise the text and scope directives. With `@compact group`, compaction runs each time a
group closes.

## Directives

| Directive | Values (default first) | Meaning |
|---|---|---|
| `@compact` | `end`, `each`, `every=N`, `group`, `never` | When layout compaction runs (see below). |
| `@layout` | `flow`, `grid`, `manual` | Automatic placement style. `manual`: every part needs `at=`. |
| `@route` | `clean`, `tunnel`, `direct` | How the nets that follow are drawn. |
| `@fallback` | `tunnel`, `direct`, `error` | What happens when `clean` cannot route a pin. |
| `@gap` | `part=2 wire=1` | Compaction clearances, in grid cells. |
| `@spacing` | `col=6 row=3` | Automatic placement spacing, in grid cells (column gaps also widen for the nets that cross them). |
| `@budget` | `ms=1500` | Compaction time per run. |
| `@name` | `"Title"` | Document name. |
| `@strict` | `off`, `on` | Turns warnings into errors. |
| `@warn` | `unconnected=on` | Notes for inputs that are not connected. |
| `@reuse` | `on`, `off` | Keep unchanged parts where the previous build put them. |

### Compaction modes

Compaction runs DigiSchem's layout packer, the same one as the **Compact layout** button. Each
run is kept only if the packer's own validator accepts it and the result still connects exactly
what the spec says.

- `end` (default): once, after every part has been placed and routed.
- `each`: after every part is added. Each addition places the part, routes every net that now
  has two or more placed pins, then compacts. A part added after the layout has been compacted
  goes next to the parts it connects to, and if its wires cannot be routed it is tried a little
  farther out.
- `every=N`: after every N parts, and once more at the end.
- `group`: whenever a `group { }` closes.
- `never`: keep the automatic placement as it is (fastest; good for drafts).

The incremental modes (`each`, `every=N`, `group`) compact with slightly wider gaps, to leave
room for wires still to come, and finish with one pass at the configured gaps. Their result
depends on the order of the parts in the file. The other modes do not.

Measured on `examples/adder4.dspec` (34 parts, 29 nets):

| Mode | Time | Compaction runs | Net labels needed | Layout score (lower is better) |
|---|---|---|---|---|
| `never` | 0.5 s | 0 | 0 | (not compacted) |
| `end` | 2.3 s | 1 | 0 | 661 |
| `group` | 7.5 s | 5 | 0 | 1021 |
| `every=5` | 6.4 s | 7 | 3 | 1343 |
| `each` | 20.6 s | 35 | 6 | (labels overlap wires) |

For a whole circuit, `end` is both the fastest compacting mode and the best result. The
incremental modes are useful when the text is built up step by step and each step should
already look tidy, for example a model adding one block at a time with the user watching.

## What the compiler does

1. **Parse** the text. Syntax errors are reported per line, and the remaining lines are still
   checked.
2. **Resolve** types, properties and pins.
3. **Build the nets** (union of all connection statements) and run the electrical checks: two
   or more outputs on one net (warning; tristate buffers and pull resistors are allowed), nets
   with a single pin, and unconnected inputs (notes).
4. **Place.** `flow` puts parts in columns by signal depth: inputs on the left, outputs in the
   last column. Feedback loops are broken where a walk from the inputs closes them. Each column
   is ordered to reduce crossings, each part is lined up with the pin that drives it (so chains
   come out straight), and each column gap gets a lane for every net that crosses it.
5. **Route** each net as a tree. The first pin (an output, when there is one) is the root, and
   every other pin joins the nearest point already drawn for the net (a pin, a corner, or a
   T-junction on a wire). Joins use the editor's clean router, so no wire touches or runs along
   anything it does not connect. A net that cannot be drawn cleanly is drawn with tunnels (net
   labels) on each of its pins instead.
6. **Compact** as the `@compact` mode says.
7. **Verify**: the drawing and the stored connections must both equal the spec netlist, and
   there must be no drawing conflicts. Otherwise the build fails with an error.

The document stores its source (`meta.dspec`), so the Code dialog can show the text a schematic
was built from, as long as the drawing has not been edited since.

## Using it

### In the app

**Code** in the toolbar (Ctrl+K) opens the editor. **Build** (Ctrl+Enter) replaces the drawing
as one undoable step. Errors are listed under the text; click one to jump to its line.
**Read from schematic** writes the current drawing as code. **Open… / Save…** read and write
`.dspec` files, and **Open** (Ctrl+O) also accepts `.dspec` files and builds them. **Copy guide
for AI** copies the language guide and the full component list, ready to paste into a chat with
a model.

### Command line

```
npm run dspec:build                       # bundles dist-cli/dspec.js
node dist-cli/dspec.js compile in.dspec -o out.dschem [--svg out.svg] [--previous old.dschem] [--json] [--no-compact]
node dist-cli/dspec.js check in.dspec [--json]       # diagnostics only, no compaction
node dist-cli/dspec.js decompile in.dschem [-o out.dspec]
node dist-cli/dspec.js render in.dschem [-o out.svg]
node dist-cli/dspec.js reference [--json]           # every component: props, ranges, pins
```

Diagnostics are printed as `file:line:col: severity: message`, or as JSON with `--json`. The exit
code is 0 on success, 1 on compile errors, and 2 for usage or file errors.

### With a language model

A workable loop:
1. Give the model the output of `dspec reference` and the guide (the **Copy guide for AI**
   button does both).
2. Let it write or edit a `.dspec` file. To change an existing schematic, `decompile` it first.
3. Run `dspec check`, which is fast and does no compaction, and feed the diagnostics back until
   it is clean.
4. Run `dspec compile --svg` and let the model look at the picture if it can read images.
5. Pass `--previous` with the last build, so that a small edit does not rearrange the drawing.

## Limits

- The router does not treat part labels as obstacles, so a wire can run through a label (for
  example a flip-flop's feedback loop over its name).
- In the incremental modes the layout depends on the order of the parts in the file, and a
  tightly compacted layout can force some nets onto net labels.
- `decompile` keeps parts, properties, positions and connections, but not the exact wire shapes;
  rebuilding re-routes the wires.
- There is no hierarchy (sub-circuits as reusable blocks) yet. Groups only organise the text and
  the compaction.

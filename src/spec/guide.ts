/** The DSpec cheat sheet: short enough to paste into a model's context with the catalog. */
export const DSPEC_GUIDE = `DSpec: a text language for DigiSchem schematics. You list parts and connections; the
compiler places the parts, routes the wires, compacts the layout and checks the result.

LINES (one statement per line; "#" or "//" starts a comment; a line ending in "," or "->" continues)
  part NAME TYPE [prop=value ...] [at=X,Y] [rot=0|90|180|270] [mirror] [size=WxH] [label="..."]
      several at once: part A, B input-pin      ranges: part F0..F3 d-ff
  net NAME = REF, REF, ...      named net (lines with the same name are one net)
  net REF, REF, ...             anonymous net
  REF -> REF, REF, ...          the first pin drives the rest (same as a net)
  text "Lab 3" at=0,-60 [size=14]
  group NAME {  ...  }          directives inside stay inside; "@compact group" compacts at "}"
  @directive ...                takes effect from that line on

REFS
  PART.PIN    pin by id (in0, out, d, clk, q, qn) or by its name (D, Q, CLK, Q' for the inverted Q)
  PART        when unambiguous: the part's only pin; left of -> its only output; right of -> its only input
  PART.d[2]   bit 2 (the part needs pinMode=bits)         F0..F3.clk  the clk pin of F0, F1, F2, F3

DIRECTIVES
  @compact end|each|every=N|group|never   when to run layout compaction (default end).
        each = after every part (slow, most compact); every=N = after every N parts and at the end;
        group = when each group closes; end = once at the end; never = keep the automatic placement
  @layout flow|grid|manual    flow (default): columns by signal flow, inputs left, outputs right;
                              grid: rows in source order; manual: every part needs at=X,Y
  @route clean|tunnel|direct  clean (default): wires never touch what they do not connect;
                              tunnel: draw the nets that follow with net labels instead of wires;
                              direct: straight L-shaped wires, may cross (fast drafts)
  @fallback tunnel|direct|error   what to do when a clean route cannot be found (default tunnel)
  @gap part=2 wire=1          compaction clearances in grid cells
  @spacing col=6 row=3        automatic placement spacing in grid cells
  @budget ms=1500             compaction time per run
  @name "Title"   @strict on (warnings become errors)   @warn unconnected=off   @reuse off

RULES
  - Order does not matter for meaning: parts and nets can be listed in any order, and any line can be
    added, removed or moved without changing the others. Only directives depend on position.
  - Names: letters, digits and _; not starting with a digit. Coordinates and sizes are multiples of 10.
  - at=X,Y pins a part: placement and compaction never move it. Rebuilding with the previous
    drawing keeps unchanged parts where they were (turn off with @reuse off).
  - Input and output pins (input-pin, output-pin, tunnel) are named after the part unless name= is given.
  - The result always connects exactly what the spec says. Two outputs on one net is a warning.

EXAMPLE
  @name "Half adder"
  part A, B input-pin
  part X1 xor
  part G1 and
  part S, C output-pin
  A -> X1.in0, G1.in0
  B -> X1.in1, G1.in1
  X1 -> S
  G1 -> C
`;

export const DSPEC_TEMPLATE = `# DSpec: list the parts and how they connect, then Build (Ctrl+Enter).
# "Copy guide for AI" copies the language guide and the full component list.
@name "Half adder"
@compact end

part A, B input-pin
part X1 xor
part G1 and
part S, C output-pin

A -> X1.in0, G1.in0
B -> X1.in1, G1.in1
X1 -> S
G1 -> C
`;

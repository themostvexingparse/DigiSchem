# Layout and Routing

Three mechanisms decide where wires and parts go:

1. the **router** finds a path for a new or moved wire;
2. **compaction** moves parts closer together;
3. **wire relaxation** tidies the wires of a finished layout without moving any part.

All three share one rule: a wire may only touch what it connects. Every result is checked against
the stored connections before it is kept.

## The router

`src/editor/safe-route.ts`

A route is legal if it does not pass over a pin it does not connect, does not run through a part
or along its outline, does not end or bend on another wire, and does not share a vertex with a
wire of another net. Among legal routes, the router picks the cheapest. Costs are measured in
**grid cells of wire length**:

| Cost | Weight (`ROUTE_WEIGHTS`) | Meaning |
|---|---|---|
| Length | 1 per cell | Every cell of wire |
| Bend | 15 | A route may be up to 15 cells longer to avoid one bend |
| Crossing | 25 | A route may be up to 25 cells longer to avoid crossing another wire |
| Running along a wire | 4 per cell | Collinear with a wire of the same net (it would hide it) |
| Blocking a pin | 30 per cell | Passing through the cell right in front of another pin, which is that pin's only way out |

The weights were balanced on a set of circuits: against the earlier 60 / 40, 25 / 15 gives shorter
wires with no more crossings; lower values start trading clean routes for net labels.

The router first tries simple shapes (L, Z and U shapes over nearby channels) and falls back to
a maze search over the grid. When nothing legal exists, DSpec draws the net with net labels
(tunnels) instead, or reports an error, depending on `@fallback`.

## Compaction

`src/layout/pack.ts`, `src/layout/quality.ts`

**Compact layout** (Ctrl+Shift+L) moves parts to make the schematic smaller and more regular.
Wire shapes are kept: a wire stretches and shrinks with the parts it joins, so the result never
gains a bend or a new contact. Every candidate layout is scored, and only strict improvements are
kept. The score balances forces that pull against each other:

- **Pull**: a weak cost on the area of the drawing draws parts together.
- **Push back**:
  - crossings and junction dots cost a little each, and bunched together they cost much more
    (a superlinear clutter term), so compaction does not crowd them;
  - parallel wires running one or two grid cells apart cost per cell of side-by-side run
    (`WIRE_CROWDING`: 0.6 and 0.15), so compaction stops squeezing wires together once the area
    it would save is worth less than the crowding it causes;
  - parts may not come closer than the part gap (2 cells by default), and wires may not overlap.
- **Order**: parts of the same type and size are rewarded for lining up in rows and columns and
  for equal spacing.

The search alternates one-dimensional compaction along each axis with several strategies, then
polishes the best layout with alignment snaps, spacing equalisation and local moves, within a
time budget (1.5 s plus 25 ms per part, at most 4 s). A beam search explores several candidates
at once. Before all this, parts that drifted out of line with their peers are moved back, with
their wires re-routed. The last stage relaxes the wires (below).

On the test circuits the crowding term cut the length of wires running one cell apart from 264
to 41 grid cells, while total wire length, bends and crossings also went down.

## Wire relaxation

`src/layout/relax-wires.ts`

After routing (in DSpec) and after compaction (in the editor), the wires are relaxed like a
molecule settling: parts stay where they are, and each wire moves until the forces on it
balance. The energy, in cells of wire length:

| Force | Weight (`RELAX_WEIGHTS`) | Effect |
|---|---|---|
| Tension | 1 per cell, 15 per bend | Wires want to be short and straight |
| Parallel repulsion | 3 per cell at 1 cell apart, 1 at 2 cells | Wires running side by side push apart |
| Crowded crossing | +12 within 1 cell of a bend, wire end or pin; +4 within 2 | Crossings move away from corners and pins |
| Crossing | 25 | As in the router |
| Near miss | 6 | A wire end or bend stopping one cell short of another wire |
| Junction crowding | 10 at 1 cell, 3 at 2 cells | Junction dots move apart |
| Blocking a pin | 30 per cell | Wires leave the cell in front of pins they do not connect |
| Step in a trunk | 15 | Two pieces of one net continuing each other one or two cells offset |
| Bundle kink | 4 per cell | See below |

The relaxer repeatedly takes the single move that lowers the energy most:

- **Slide a segment** sideways by up to 8 cells. The rest of its straight run (other segments of
  the same net on the same line, end to end) slides with it, and wires branching off it follow.
- **Re-route a wire** between its fixed ends with the router.
- **Lay out a bundle** (below) in one move.

A move is taken only if it touches nothing new: every wire still connects exactly what it
connected, no wire touches a pin, a part or a wire it is not joined to, and no wire enters a
keep-out area. Inside Compact layout no move may add a bend, since compaction promises not to.

### Bundles

Wires running between the same two parts with one jog each (like the outputs of a register
going to a display driver) form a **bundle**. A jog that is off the straight line through its
neighbours' jogs costs energy, like a bond angle, so a bundle settles into an even diagonal
staircase or one aligned column. The bundle move tries every even step and start position at
once, in the order that keeps the wires from crossing: going down, each wire jogs left of the one
above it; going up, the other way round.

## DSpec layout rules

On top of the above, the DSpec compiler keeps inputs and outputs on the outside: no wire may run
to the left of the leftmost input or to the right of the rightmost output. Nets are routed
shortest first, so local connections get the straight paths. See
[DSpec Language](DSpec-Language.md#what-the-compiler-does).

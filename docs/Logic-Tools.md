# Logic Tools

`src/logic/` holds TypeScript modules for working with the logic of a circuit. They do not depend
on the editor's user interface, so they can be used from tests, scripts, or new features.

| Module | What it does |
|---|---|
| `minimize.ts` | Exact two-level boolean minimization, with Karnaugh map text |
| `sop-schematic.ts` | Draws a sum of products as a two-level AND-OR schematic |
| `circuit.ts` | Reduces a drawing to its stripped circuit: parts and connections, nothing about the layout |
| `simulate.ts`, `models.ts` | A four-valued (0, 1, X, Z) simulator that finds shorts, floating inputs and oscillation |
| `check.ts` | Static checks on the stripped circuit |
| `analyze.ts` | Truth tables and Karnaugh maps read off a circuit by simulating it |
| `watch.ts` | Keeps the stripped circuit up to date with the document, rebuilding only on structural edits |
| `evaluate.ts` | Computes what a combinational drawing outputs, for checking it against a truth table |

The simulator and the checks are not shown in the editor yet; they are the base for that.

![cout = b·cin + a·cin + a·b, drawn by sopToSchematic](images/majority.svg)

## Minimizing a function

```ts
import { minimize, sopToString, kmapText } from "./src/logic/minimize";

// variable 0 is the least significant bit of a minterm
const names = ["cin", "b", "a"];
const r = minimize(3, [3, 5, 6, 7]);         // the carry out of a full adder
sopToString(r.terms, names);                  // "bcin + acin + ab"
```

`minimize(n, minterms, dontCares?)` returns:

| Field | Contents |
|---|---|
| `terms` | The minimal sum of products: fewest terms, then fewest literals |
| `primes` | Every prime implicant (every largest group of 1s and don't cares on the map) |
| `essential` | The primes that are the only cover of some 1 |

A term is `{ value, mask }`: bits set in `mask` are variables left out of the product, and the
other bits of `value` say whether each variable appears plain (1) or complemented (0).

### How it works

This is the Karnaugh map method done mechanically (Quine-McCluskey):

1. **Prime implicants.** Start from the minterms and don't cares. Combine any two terms that
   differ in exactly one variable into a term without that variable, and repeat until nothing
   combines. The terms that never combined are the primes: on a Karnaugh map, the largest
   rectangles of 1s (and don't cares) that fit.
2. **Essential primes.** A 1 covered by only one prime makes that prime essential; it is always
   in the answer.
3. **Cheapest cover.** The remaining 1s are covered with the cheapest set of the remaining primes,
   found exactly by branch and bound (always branching on the 1 with the fewest options).

The result is exact: on all 256 functions of three variables it matches a brute-force search
over every set of terms. It handles up to 16 variables, though the cover search is meant for the
small functions schematics deal with (up to about 8).

### Karnaugh maps

```ts
kmapText(3, (m) => ([3, 5, 6, 7].includes(m) ? 1 : 0), names, r.terms);
```

```
a\bcin |   00   01   11   10
-------+--------------------
0      |    0    0   1A    0
1      |    0   1B 1ABC   1C

  A = bcin
  B = acin
  C = ab
```

The low half of the variables label the columns and the high half the rows, both in Gray-code
order, so neighbouring cells differ in one variable. Each 1 is followed by the letters of the
chosen terms that cover it (the cell a = b = cin = 1 is covered by all three). Cells can also be `"x"` for don't care.

## Drawing a function

```ts
import { sopToSchematic } from "./src/logic/sop-schematic";

const doc = sopToSchematic(r.terms, names, "cout");   // a SchematicDocument
```

The drawing (as in the picture above):

- inputs across the top, most significant first, each dropping a vertical rail;
- a NOT gate beside each rail that is needed complemented, dropping the complement rail;
- one AND gate per product of two or more literals, each input tapping straight off a rail;
- an OR gate if there are two or more products, with the AND outputs reaching it in a staircase
  that never crosses itself;
- the expression as a caption.

Wires are placed exactly rather than routed, so the drawing is the same every time, and it
stores its connections, so it opens in the editor with no conflicts. A function that is always 0
or always 1 becomes a constant.

`sopToDspec(terms, names, out)` in `minimize.ts` produces DSpec source for the same circuit
instead, for the compiler to place and route.

### Several outputs at once

```ts
import { sopsToSchematic } from "./src/logic/sop-schematic";

const doc = sopsToSchematic(
  [
    { name: "sum", terms: minimize(3, [1, 2, 4, 7]).terms },
    { name: "cout", terms: minimize(3, [3, 5, 6, 7]).terms, label: "carry" },
  ],
  ["cin", "b", "a"],
);
```

Several functions of the same inputs become one schematic: the input rails across the top, one
column of AND gates, an OR gate per output on the right, and the output pins in a column in the
order given. A product that several outputs need is built **once**, and its AND output drops
down a vertical lane of its own and branches off to every OR gate that uses it. This is the
usual way to draw a decoder, such as a hexadecimal to seven-segment decoder, where neighbouring
segments share products.

## The stripped circuit

```ts
import { extractCircuit, circuitText } from "./src/logic/circuit";

const c = extractCircuit(doc);
circuitText(c);
```

```
# cout = bcin + acin + ab: parts and connections only
part a input-pin
part b input-pin
part cin input-pin
part bcin and
part acin and
part ab and
part SUM or inputs=3
part cout output-pin

net SUM_out = SUM.out, cout.in
net a_out = a.out, acin.in0, ab.in0
net ab_out = ab.out, SUM.in2
...
```

A drawing carries positions, rotations, sizes, wire routes and labels, and DSpec source carries
compiler directives. None of that changes what the circuit does. `extractCircuit` keeps only:

- the parts, with their type and the properties that change pins or behaviour;
- the nets, read from the stored connections (not from where wires happen to lie);
- a node for every **bit**: tunnels are dissolved into the nets they join, and a splitter's
  slices are joined bit by bit to its bus, so a bus and the wires split off it share nodes.

`circuitText` prints it in DSpec syntax with no `at=`, `rot=` or `@` lines. Building that text
with the compiler gives a drawing with the same connections. Pins of different widths on one net
are reported in `c.issues`.

`structuralKey(doc)` is the cheap fingerprint behind all this: the parts (id, type, meaningful
properties) and the groups of pins the connections join. Moving a part, dragging or re-routing a
wire, splitting or merging wires, rotating, resizing and relabelling leave it unchanged.

### Following the document

```ts
import { watchCircuit } from "./src/logic/watch";

const watch = watchCircuit(store, (snap) => { /* snap.circuit, snap.issues */ });
watch.current();
```

`watchCircuit` rebuilds the circuit and its check only after a structural edit: a part added or
deleted, a connection made or broken, a property such as a gate's input count changed, or an undo
of one. Dragging parts or wires (including the re-routing a move causes) and renaming do
nothing; after a rename, `current()` returns the circuit with the new names. Without a callback
it rebuilds lazily, when `current()` is called.

DSpec source goes through the compiler first (`compileSpec`). The compiler only warns about
two outputs on one net, so a short written in DSpec still reaches the checks below.

## Simulating

```ts
import { Simulator } from "./src/logic/simulate";

const sim = new Simulator(c);
sim.set("a", 1);
const r = sim.settle();   // { waves, stable, issues }
sim.read("cout");         // 1, or null when X or Z
```

Every bit holds 0, 1, X (unknown) or Z (undriven). Part outputs drive strongly, tri-state
outputs drive Z when disabled, and pull-up and pull-down resistors drive weakly. A net takes its
strong drivers' value, else the pull's, else Z. The issues `settle` reports:

| Issue | When |
|---|---|
| `contention` | outputs on one net drive different values (a short); the net reads X |
| `floating` | an input reads a net nothing drives; it reads X |
| `oscillation` | the circuit does not settle (a ring of inverters, a latch released from S = R = 1); the nodes still changing are held at X |
| `unmodelled` | a part the simulator has no model for; its outputs read X |

Settling runs in waves of one gate delay, and every part evaluated in a wave reads the values of
the wave before. So flip-flops on one clock all sample their inputs before any of them changes,
as in hardware, and a latch built from two NOR gates holds its state.

Inputs are set by part id or name: input pins, clocks, push buttons, DIP switches and keypads.
A clock cycle is `set("CLK", 1); settle(); set("CLK", 0); settle()`.

Flip-flops, latches, registers and counters start at X, so a design without a reset reads X until
something sets it; `new Simulator(c, { initial: "zero" })` starts them at 0 instead. Register and
counter resets are synchronous, flip-flop set and reset are asynchronous, and a control pin drawn
with a bubble is active low.

Simulated: gates and compound gates, plexers, decoders and encoders, tri-state buffers and bus
transceivers, the BCD to 7-segment decoder, adders, subtractors, comparators, multipliers,
dividers and the other arithmetic parts, latches, flip-flops, registers and counters. Not yet:
memories, shift registers and the other sequential blocks, the ALU, the shifter, generic blocks
and transistors.

## Checking a circuit

```ts
import { checkCircuit } from "./src/logic/check";

checkCircuit(c); // [{ kind, severity, pins, message }, ...]
```

The static check needs no input values:

| Kind | Severity | Meaning |
|---|---|---|
| `floating-input` | error | an input pin that is not connected, or whose net nothing drives |
| `multiple-drivers` | error | two outputs on one net (shorted whenever they differ) |
| `width-mismatch` | error | pins of different widths joined |
| `possible-contention` | warning | an output shares a net with tri-state outputs |
| `feedback` | info | a combinational loop (normal for a latch built from gates) |
| `unmodelled` | info | a part the simulator does not model |
| `unused-input` | info | an input connected to nothing |

## Truth tables and Karnaugh maps from a drawing

```ts
import { truthTable, outputFunctions, truthTableText } from "./src/logic/analyze";

const t = truthTable(c);              // every input combination, simulated
for (const f of outputFunctions(t)) {
  f.minterms;                         // [3, 5, 6, 7]
  f.sop;                              // "bcin + acin + ab"
  f.kmap;                             // Karnaugh map text (2 to 4 inputs)
}
```

The table comes from simulating every combination of the input pins, so it is what the drawing
computes, whatever parts it uses. By default the inputs are the input pins in document order,
the first being the most significant; `truthTable(c, { inputs: ["a", "b", "cin"] })` picks and
orders them, and `outputs` picks the outputs. Rows where an output is X or Z are listed in
`unknown` and shown as `x` on the map. A circuit whose outputs depend on flip-flops, latches or
parts that are not simulated is refused, since its table would describe one state rather than a
function.

## Checking a drawing

```ts
import { evaluateCombinational } from "./src/logic/evaluate";

evaluateCombinational(doc, { a: true, b: true, cin: false }); // { cout: true }
```

A shortcut over the simulator: it returns the value of each output pin by part id for the given
input pins, or `undefined` for an output that is X or Z (it depends on state never set, on a part
that is not simulated, on a floating net or a short) or that oscillates. Looping over every input
combination checks a schematic against its truth table.

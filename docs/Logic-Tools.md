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

How a change settles:

- Parts without state are evaluated **in signal order**, so each one is evaluated once its inputs
  are final (a change to one input of a 5,000-gate circuit costs about one evaluation per
  affected gate).
- A **feedback loop** (parts that feed each other, such as a latch built from two NOR gates) runs
  in waves: every part of the loop reads the values of the wave before. A loop that keeps changing
  is reported as oscillating and the nodes still changing are held at X. A loop left at X while
  everything feeding it is known is tried once from a set value, which tells a latch that was
  never set (it stays X) from a ring of inverters with no stable state (reported as oscillating).
- **Parts with state** (flip-flops, latches, registers, counters, memories) that saw a change are
  evaluated all together once the logic before them has settled. So flip-flops on one clock all
  sample their inputs before any of them changes, as in hardware, and a flip-flop clocked by
  another's output (a ripple counter) sees its edge in the next step.

Inputs are set by part id or name: input pins, clocks, push buttons (1 = pressed; an active-low
button outputs 0 while pressed), DIP switches and keypads. A clock cycle is
`set("CLK", 1); settle(); set("CLK", 0); settle()`. A clock whose net has never had a value has no
edge, so nothing is clocked by power-up.

Flip-flops, latches, registers, counters and memory words start at X, so a design without a reset
reads X until something sets it; `new Simulator(c, { initial: "zero" })` starts them at 0 instead.
Where an output depends on unknown inputs, it is still known when every value of the unknowns gives
the same result (an AND with a 0 input, a priority encoder whose highest input is 1, a JK flip-flop
with J = 1 and K = 0). For parts without state this is exact whenever at most four input bits are
unknown: the part is evaluated for every way of filling them in, and an output bit is known if all
the tries agree (so a XOR of a floating net with itself is 0). A known value is never claimed that
some filling-in would contradict; the tests check this for every part.

**Transistors** are simulated at switch level: while an nMOS, pMOS or transmission gate conducts,
the nets on its two channel pins are one net. Supplies and inputs (VDD, ground, constants, input
pins) are ideal sources: a net switched onto one takes its value, the rail itself never changes,
and two nets switched onto the same rail stay separate. A switch whose control is X may or may not
conduct, and a net is X if it could change its value. CMOS gates built from transistors simulate
and get truth tables; a short from VDD to ground through them is reported as contention, and
switches with unknown controls between nets at different values as a possible short.

Every part is simulated except the generic block. A ROM reads its `contents` property: hex words
from address 0 separated by spaces or commas (`0x`, `0b` and `0d` prefixes also work, and `4*FF`
repeats a word); addresses past the list read 0. Where the library does not fix a behaviour, the simulator chooses:

| Part | Behaviour |
|---|---|
| register, counter, shift register, ring and Johnson counter, LFSR, decade counter, clock divider | reset is synchronous (flip-flop set and reset are asynchronous) |
| shift register | `right` moves bits toward bit 0, SI entering at the top bit; bidirectional: DIR = 1 shifts right with SIL, DIR = 0 left with SIR; reset, then load, then shift |
| ring counter / Johnson | reset loads 0...01 / 0...0 |
| LFSR | Fibonacci, XOR feedback, maximal-length taps; reset loads 1 |
| decade counter | counts 0 to 9; TC = (Q = 9) AND EN |
| clock divider | OUT is high for the later floor(N/2) of every N input clocks |
| synchronizer, edge detector, debouncer | Q is D after `stages` clocks; P pulses for one clock; OUT follows IN after 4 equal samples |
| RAM, dual-port RAM, register file | read combinationally, write on the clock edge; register 0 of the register file reads 0 |
| FIFO, stack | start empty; DOUT / TOP read X when empty |
| ALU | Harris and Harris codes: F = 000 AND, 001 OR, 010 ADD, 100 A AND NOT B, 101 A OR NOT B, 110 SUB, 111 SLT; with 2 op bits ADD, SUB, AND, OR; flags N, Z, and C and V from the adder |
| shifter | universal mode: DIR = 0 left, DIR = 1 right, AR = 1 arithmetic |

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

### Problems that depend on values

```ts
import { scanCircuit } from "./src/logic/analyze";

scanCircuit(c).findings;
// [{ kind: "contention", pins: [...], count: 2, example: { A: 1, B: 0, EA: 1, EB: 1 }, ... },
//  { kind: "floating", ..., example: { EA: 0, EB: 0, ... } }]
```

The static check cannot see a short that only happens when two tri-state buffers are enabled
together, or a bus that floats when every driver is released. `scanCircuit` runs the circuit
through its inputs (every combination for a circuit without clocks and up to 12 input bits;
otherwise 256 seeded random inputs, ticking the clocks after each) and returns each distinct
contention, floating input or oscillation with how often it happened and the first input values
that showed it.

### Hazards

```ts
import { hazardScan } from "./src/logic/analyze";

hazardScan(c);
// [{ output: "F", kind: "static-1", input: "A", from: { A: 1, B: 1, C: 1 }, waveform: "101", count: 1 }]
```

The simulator normally evaluates parts in signal order, so a change never glitches. With
`new Simulator(c, { timing: "unit" })` every part takes one gate delay instead and all of them
switch together, so paths of unequal length make glitches appear as they would in hardware, and
`settle()` returns each changed node's `history`. `hazardScan` uses that on a combinational
circuit: from every input combination (up to 10 input bits) it changes each input bit once and
reports every output that goes through more than the one expected change, as a static-1 hazard
(should stay 1, dips to 0), a static-0 hazard, or a dynamic hazard, with the input values that
show it. For `AB + A'C` it finds the static-1 hazard when A changes with B = C = 1; adding the
consensus term `BC` removes it.

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

### State tables

```ts
import { stateTable, outputFunctions } from "./src/logic/analyze";

const t = stateTable(c);          // present state and inputs -> flip-flop inputs and outputs
outputFunctions(t);               // F0_d = ..., F1_d = ..., Y = ...: the next-state equations
```

For a synchronous circuit, `stateTable` cuts every flip-flop (and latch or register) open: its Q
output becomes an input of the table, the present state (`F0_q`), and each of its other inputs
except the clock becomes an output (`F0_d`, or `F0_j` and `F0_k`); Q' is computed from Q. The
table's inputs are the present state, most significant first, followed by the circuit's inputs.
`outputFunctions` then gives the minimal next-state (excitation) and output equations with their
Karnaugh maps, which is how a finite state machine's logic is designed or checked.

`sim.tick()` runs one clock cycle on every clock part (or `sim.tick("CLK")` on one).

### Comparing two circuits

```ts
import { compareCircuits } from "./src/logic/analyze";

const r = compareCircuits(extractCircuit(drawing), extractCircuit(compileSpec(source).doc!));
r.equal;          // true when they compute the same thing
r.mismatches;     // [{ inputs: { a: 1, b: 1, cin: 0 }, output: "cout", a: 0, b: 1, cycle: 0 }, ...]
```

Checks a drawing against a reference (another drawing, or the DSpec it should implement). Inputs
and outputs are matched by name, and names only one side has are listed in `onlyA` and `onlyB`.
Circuits without state are compared on every input combination (up to `maxInputBits`, 16 by
default); circuits with state are run side by side from 0 on seeded random inputs for `cycles`
clock cycles (500 by default), with the inputs named in `resets` held at 1 for the first two.
Each mismatch is a counterexample: the inputs, the output and both values.

## Checking a drawing

```ts
import { evaluateCombinational } from "./src/logic/evaluate";

evaluateCombinational(doc, { a: true, b: true, cin: false }); // { cout: true }
```

A shortcut over the simulator: it returns the value of each output pin by part id for the given
input pins, or `undefined` for an output that is X or Z (it depends on state never set, on a part
that is not simulated, on a floating net or a short) or that oscillates. Looping over every input
combination checks a schematic against its truth table.

# Compaction test cases

Open each file in DigiSchem (Ctrl+O), press **F** to fit, then run **Compact layout** (toolbar
button with four inward arrows, or **Ctrl+Shift+L**). **Ctrl+Z** undoes it in one step.

With nothing selected the whole schematic is compacted; with a selection, only the selected
parts (and wires attached to them) move.

Regenerate with `npx vite-node scripts/gen-compaction-samples.ts`.

| File | What it tests | Parts / wires | Expected (packer run here) |
|---|---|---|---|
| `01-scattered-inverters.dschem` | Five identical NOT gates at uneven heights and slightly different x. Expect them to end up in one column with equal gaps. | 15 / 10 | area → 20% · score 79 → -177 · centre moved 6px · 0.3s |
| `02-crossing-cluster.dschem` | Four inputs wired in reverse order to four AND gates through tightly bunched vertical lanes (hand-drawn). The crossings can't be removed (order is preserved), but the cluster should spread out (less clutter) while getting smaller. | 8 / 4 | area → 26% · score 91 → 14 · centre moved 3px · 0.4s |
| `03-ripple-carry-adder.dschem` | 4-bit ripple-carry adder from full adders spread far apart; the carry chain runs bottom-to-top between stages. Expect a tight row of adders with short carry wires. | 18 / 17 | area → 33% · score 756 → 228 · centre moved 4px · 0.8s |
| `04-sync-counter.dschem` | 3-bit synchronous counter: D flip-flops with XOR/AND next-state logic, feedback wires running right-to-left, and one clock net branching to every flip-flop (junctions). Expect feedback loops and the clock tree to stay intact. | 11 / 16 | area → 24% · score 980 → 682 · centre moved 4px · 0.5s |
| `05-datapath.dschem` | Single-cycle-style datapath: register file, ALU, operand MUX and result register on 32-bit buses, with a write-back bus looping from the register to the register file and a shared clock. Mixed part sizes; expect a compact left-to-right flow with no bus overlaps. | 18 / 20 | area → 33% · score 1321 → 612 · centre moved 5px · 1.1s |
| `06-annotated-lab.dschem` | A small sprawled gate circuit with a title, notes, a named clock and named probes. Text notes must move with the layout and must not overlap parts or wires after compaction. | 17 / 15 | area → 14% · score 973 → 242 · centre moved 1px · 1.1s |
| `07-large-sprawl.dschem` | Large stress test: 90 parts / ~130 wires over 6 gate stages. Exercises the beam search; compaction takes a few seconds (runs in the background — the editor stays usable). | 90 / 129 | area → 40% · score 7699 → 5836 · centre moved 4px · 5.6s |
| `08-off-center.dschem` | A medium circuit placed far from the origin (around x≈4000, y≈3000). Zoom to fit (F), compact, and check the circuit stays where it was on screen — the centre of mass is preserved — instead of jumping towards the top-left. | 30 / 34 | area → 25% · score 1588 → 1017 · centre moved 6px · 0.8s |
| `09-already-tight.dschem` | A circuit that has already been compacted. Compact layout should report 'Already tidy' (or make only a negligible change) — it must never make a good layout worse. | 24 / 28 | Already tidy (no change) |
| `10-partial-selection.dschem` | Two separate circuits: a tidy one on the left and a sprawled one on the right. Select ONLY the right circuit (drag a box around it) and compact: the left circuit must not move at all, and the right one should tighten in place. | 39 / 43 | area → 39% · score 2357 → 1990 · centre moved 30px · 2.9s |

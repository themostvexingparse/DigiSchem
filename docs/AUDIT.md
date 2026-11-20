# DigiSchem Correctness & Design Audit

Audited against the full repository (`ARCHITECTURE.md`, `src/model/*`, `src/render/svg.ts`, `src/components/library/*`, `src/editor/*`, `src/ui/*`, `src/io/*`, `src/app/*`, `src/main.ts`, `src/platform/files.ts`, `src-tauri/src/lib.rs`).

Runnable proof tests demonstrating verified defects are preserved in:
- `tests/audit-transforms.test.ts`
- `tests/audit-connectivity.test.ts`
- `tests/audit-store-io.test.ts`

All issues are ordered by severity (`critical` → `major` → `minor`).

---

## Critical

### AUD-01. Rotating or mirroring a wired component silently shorts its pins together  (severity: critical)
- **Scenario**:
  1. Place a 2-input `and` gate at `(200, 200)` with straight horizontal wires `w0` into `in0` and `w1` into `in1` from `x = 100`. Select only the gate and press `R` (Rotate 90° CW). `in0` moves to `(250, 180)` and `in1` moves to `(230, 180)`. `keepWiresAttached` stretches `w0` to `[(100, 220), (100, 180), (250, 180)]`, passing directly over `in1` at `(230, 180)` and overlapping `w1`, silently shorting `in0`, `in1`, `w0`, and `w1` onto one net.
  2. Place a `not` gate (or `buf`, 3-input gate, `register`, or any component where an input pin and output pin share the same `y`) with horizontal wires `w_in` on `in0` and `w_out` on `out`. Select the component and press `M` (Mirror) or `R` twice (180°). `in0` and `out` swap X positions on the same horizontal line; `keepWiresAttached` stretches `w_in` across `out` and `w_out` across `in0`, shorting the gate's input directly to its output.
- **Evidence**:
  - `src/editor/doc-ops.ts:69-76` (`keepWiresAttached`) unconditionally calls `stretchWireStart` from the wire's old geometry with no awareness of the transformed component's new pin exit vectors or body bounding box.
  - `src/editor/wire-utils.ts:210-228` (`stretchWireStart`) inserts a single L-bend at the opposite endpoint's X/Y, sending the final segment straight along the rotated/mirrored component's pin edge or through its body.
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T1` and `BUG-T2`.
- **Proposed fix**:
  In `keepWiresAttached` (`src/editor/doc-ops.ts:64-76`), capture each pin's new `pinExitVector(comp, wp.pin.side)` alongside its new world position. When a pin moves onto a different side or across the component's body, re-route the final leg from the last unaffected vertex (or opposite endpoint) using a body-avoiding pin-aware route (`routePinAware` with a component bounding-box detour when the straight/L/Z segment crosses `componentBounds(comp)` or any other pin on `doc`), rather than blindly calling `stretchWireStart`.
- **Confidence**: high

---

### AUD-02. Moving/nudging components, resizing parametric components, or dragging wire segments creates pin-edge jogs that short adjacent nets  (severity: critical)
- **Scenario**:
  1. **Move/nudge**: Place two vertically aligned `input-pin` components `A` (pin at `(100, 220)`) and `B` (pin at `(100, 240)`) wired via straight horizontal 2-point wires `wA`, `wB` to an `and` gate's `in0`, `in1`. Select the `and` gate and nudge/drag it down by 20 units (`dy = +20`). `wA` becomes `[(100, 220), (100, 240), (200, 240)]`, running vertically along `x = 100` directly over `B`'s output pin `(100, 240)` and `wB`'s start point, silently shorting `A` and `B` together.
  2. **Parametric resize**: Wire `EN` and `CLK` on an `8-bit` / `4-bit` `register` (in `bus` mode) from aligned points at `x = 40`. Switch `Pin Mode` to `Individual bits` (`bits`) in the Properties panel. `EN` shifts down past `CLK`'s old Y; `keepWiresAttached` stretches `w_en` vertically down `x = 40` straight over `w_clk`'s fixed endpoint, shorting `EN` and `CLK`.
  3. **Wire segment drag**: Select a 2-point horizontal wire `[(100, 220), (200, 220)]` connected to `and.in0` (with `in1` at `(200, 240)`) and drag the segment down by 20 units. `dragWireSegmentPoints` produces `[(100, 220), (100, 240), (200, 240), (200, 220)]`, placing a vertical stub directly on the gate's input pin edge over `in1` and shorting `in0` to `in1`.
- **Evidence**:
  - `src/editor/wire-utils.ts:210-225` (`stretchWireStart` for 2-point wires) places the perpendicular jog at `p1.x` / `p1.y` (directly on the fixed endpoint's pin column/row).
  - `src/editor/wire-utils.ts:390-400` (`dragWireSegmentPoints`) prepends/appends the original anchor immediately adjacent to the shifted segment, creating a perpendicular turn right at the pin tip.
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T3`, `BUG-T4`, and `BUG-T11`.
- **Proposed fix**:
  1. In `stretchWireStart` (`src/editor/wire-utils.ts:210-228`), when stretching a 2-point horizontal wire perpendicular to itself (with `|newStart.x - p1.x| >= 2 * grid`), insert a Z-bend at the snapped midpoint `mx = snap((newStart.x + p1.x) / 2, grid)` (`[newStart, {x: mx, y: newStart.y}, {x: mx, y: p1.y}, p1]`) instead of turning at `p1.x` (and symmetrically `my` for vertical wires). This keeps both ends exiting horizontally along their pin stubs.
  2. In `dragWireSegmentPoints` (`src/editor/wire-utils.ts:357-401`), when dragging segment `0` or `n-2` perpendicular to an anchored endpoint that lies on a component pin whose `pinExitVector` is parallel to the dragged segment, preserve a minimum exit stub (`1 * grid` or `2 * grid` along the pin exit vector) before turning perpendicular instead of turning directly at the pin tip.
- **Confidence**: high

---

### AUD-03. `DocumentStore` leaks `gestureDepth` (permanently breaking Undo) and corrupts undo history on mid-drag actions  (severity: critical)
- **Scenario**:
  1. **New/Open during drag**: While a drag gesture is active (`store.beginGesture()` has incremented `gestureDepth` to `1`), trigger `Ctrl+N` / `Ctrl+O` (`store.replace()`). `replace()` clears `undoStack` and `redoStack` and emits `"replace"` (clearing `editor.interaction = null`), but never resets `gestureDepth` or `gestureRecorded`. In the new document, `gestureDepth === 1` and `gestureRecorded === true` permanently — every subsequent `store.update()` skips pushing to `undoStack`, so `canUndo()` stays `false` for the entire rest of the session.
  2. **Middle-click pan during drag**: Hold left mouse button to drag a component (`beginGesture()`), then press middle mouse button to pan. `onPointerDown` overwrites `this.interaction = { kind: "pan", ... }` without ending or cancelling the active gesture; on `pointerup`, `endGesture()` is never called, permanently leaking `gestureDepth`.
  3. **`startPlacing` / `setTool` during drag**: Calling `editor.startPlacing(type)` sets `this.interaction = null` without cancelling the gesture; calling `editor.setTool(...)` leaves `this.interaction` running.
  4. **`Ctrl+Z` during drag**: Pressing `Ctrl+Z` while dragging calls `store.undo()` without aborting the drag gesture. `undo()` pops the pre-drag snapshot and pushes the mid-drag state onto `redoStack`, leaving `gestureDepth = 1, gestureRecorded = true`. Moving the mouse 1 grid step calls `store.update()` which overwrites `_doc` without pushing to `undoStack` and without clearing `redoStack`; the subsequent `Ctrl+Z` skips right past the pre-drag state and undoes an earlier unrelated edit.
- **Evidence**:
  - `src/model/store.ts:60-65` (skips pushing to `undoStack` whenever `gestureDepth > 0 && gestureRecorded`).
  - `src/model/store.ts:98-127` (`undo()`, `redo()`, and `replace()` never reset `gestureDepth` or `gestureRecorded`).
  - `src/editor/editor.ts:296-301` (`startPlacing` overwrites `this.interaction = null`), `src/editor/editor.ts:285-293` (`setTool` ignores `this.interaction`), `src/editor/editor.ts:883-903` (`onPointerDown` overwrites `this.interaction`), `src/editor/editor.ts:1525-1531` (`Ctrl+Z`/`Ctrl+Y` run during active `this.interaction`).
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-S1` and `BUG-S2`.
- **Proposed fix**:
  1. In `DocumentStore.replace()` (`src/model/store.ts:119-127`), reset `this.gestureDepth = 0; this.gestureRecorded = false;`.
  2. In `DocumentStore.undo()` and `redo()`, guard or auto-finalize any active gesture (`this.gestureDepth = 0; this.gestureRecorded = false;`).
  3. Add a centralized `Editor.abortInteraction(commit = false)` helper that releases pointer capture, ends/cancels any `move-selection`/`drag-wire-segment` gesture, and clears `this.interaction` (and `wireDraft` if `pin-wire-drag`). Call it at the start of `setTool()`, `startPlacing()`, `onKeyDown` before `Ctrl+Z`/`Ctrl+Y`/`Delete`/`R`/`M`/`Arrow*`, and guard `onPointerDown` to ignore secondary pointer-downs while `this.interaction !== null` (and check `e.pointerId === this.interaction.pointerId` in `onPointerMove`/`onPointerUp`/`onPointerCancel`).
- **Confidence**: high

---

### AUD-04. `routePinAware` collapses escape stubs on same-Y feedback loops and routes across adjacent pins at 1-grid separation  (severity: critical)
- **Scenario**:
  1. **Same-Y feedback loop**: Draw a wire from a right-facing output back to a left-facing input on the same horizontal line — e.g. Gate 2 `out` at `(300, 120)` back to Gate 1 `in0` at `(100, 120)`, or a Flip-Flop/Register `Q` back to `D`. `routePinAware` creates escape stubs `a = (320, 120)` and `b = (80, 120)`, then hits `if (a.x === b.x || a.y === b.y) mid = [a, b]`. Concatenating `[(300, 120), (320, 120), (80, 120), (100, 120)]` and passing it to `normalizeWirePoints` folds both escape stubs away completely, returning `[(300, 120), (100, 120)]` — a straight line right through both component bodies and shorting every intermediate pin on `y = 120`.
  2. **1-grid pin separation**: Draw a wire from a right-facing pin at `(200, 210)` to a left-facing pin at `(210, 230)` (e.g. two components placed 1 grid cell apart where `(210, 210)` is another input pin). `mx = snap((200 + 210) / 2, 10)` rounds up to `210 === b.x`, producing `[(200, 210), (210, 210), (210, 230)]` which runs vertically down the target pin edge directly over `(210, 210)`, shorting it.
- **Evidence**:
  - `src/editor/wire-utils.ts:154-185` (`routePinAware`). Line 167 treats `a.y === b.y` as a straight horizontal connection even when `head.length > 1` or `tail.length > 1` requires a perpendicular U-detour around the pin. Line 171 rounds `mx` onto `b.x` whenever `|b.x - a.x| === grid`.
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T8`.
- **Proposed fix**:
  In `routePinAware` (`src/editor/wire-utils.ts:166-185`):
  1. When `a.y === b.y` (or `a.x === b.x`) and either `head.length > 1` or `tail.length > 1` caused a backtrack along the same line (i.e. `(b.x - a.x) * fromExit.x < 0` or `(a.x - b.x) * toExit.x < 0`), route a perpendicular U-detour offset by `detour = (flip ? 1 : -1) * 3 * grid` (or past the component bounds) instead of `mid = [a, b]`.
  2. In the Z-route branch (`startH === endH`), if `Math.abs(b.x - a.x) <= grid` (for `startH`) or `Math.abs(b.y - a.y) <= grid` (for `!startH`), either step out to a safe channel using `stub` or route around rather than collapsing `mx` onto `a.x` or `b.x`.
- **Confidence**: high

---

### AUD-05. `normalizeDocWires` silently destroys 4-way crossing junctions on any unrelated edit  (severity: critical)
- **Scenario**:
  A schematic contains a 4-way wire junction formed by two crossing wires sharing an explicit collinear vertex: `w1 = [(0, 50), (50, 50), (100, 50)]` and `w2 = [(50, 0), (50, 50), (50, 100)]` (explicitly supported and tested in `src/io/netlist.ts:6-8` and `tests/io.netlist.test.ts:63-73`). The user then draws, nudges, rotates, mirrors, or pastes an unrelated item elsewhere in the schematic. Every one of those operations runs `normalizeDocWires(draft)` over the entire document, stripping the collinear vertex `(50, 50)` from both `w1` and `w2`. Without the shared vertex, both `junctionPoints` and `buildNetlist` treat `w1` and `w2` as an unconnected crossover, silently disconnecting the circuit.
- **Evidence**:
  - `src/editor/wire-utils.ts:45-68, 78-88` (`normalizeWirePoints` merges all collinear points; `normalizeDocWires` applies it to every wire in `doc.wires`).
  - Called globally from `src/editor/editor.ts:1003, 1304, 1313` and `src/editor/doc-ops.ts:141, 225, 300, 367`.
  - Demonstrated by `tests/audit-connectivity.test.ts`: `BUG-C5`.
- **Proposed fix**:
  In `normalizeDocWires(doc)`, first build a set of protected vertex keys (any grid point appearing as a vertex in ≥ 2 distinct wires, or where another wire's endpoint meets it). Pass `protectedKeys` to `normalizeWirePoints` so collinear merging never drops an interior vertex that is shared with another wire (while still collapsing fold-backs/duplicates). Alternatively, normalize only the newly modified wires instead of mutating untouched wires across the whole document.
- **Confidence**: high

---

### AUD-06. `buildNetlist` disconnects overlapping collinear wires and ignores `tunnel` default names  (severity: critical)
- **Scenario**:
  1. **Overlapping middle segment**: Wire `w1 = [(0, 50), (200, 50)]` runs horizontally. Wire `w2 = [(50, 0), (50, 50), (120, 50), (120, 100)]` overlaps `w1` along its middle segment from `(50, 50)` to `(120, 50)` (70 units of visually identical, completely merged blue wire). Because neither wire's endpoints lie on the other wire and they share no vertex coordinates, `buildNetlist` puts `w1` and `w2` on **2 separate disconnected nets** (and `junctionPoints` renders no dots at `(50, 50)` or `(120, 50)`).
  2. **Tunnel default props**: A `tunnel` component stored with `props: {}` renders as `"NET"` on the canvas (via `renderComponent` merging `def.defaultProps`), but `buildNetlist` reads `propStr(ip.component.props, "name", "")` without merging `def.defaultProps`, treating its name as `""` and failing to join it with other `"NET"` tunnels.
- **Evidence**:
  - `src/io/netlist.ts:142-155` only tests `a.endpoints` against `b.segments`, never interior vertices or overlapping collinear segment intervals.
  - `src/io/netlist.ts:191` reads `ip.component.props` directly instead of `{ ...getDef("tunnel")?.defaultProps, ...ip.component.props }`.
  - Demonstrated by `tests/audit-connectivity.test.ts`: `BUG-C4` and `BUG-C6`.
- **Proposed fix**:
  1. In `src/io/netlist.ts:140-155`, test collinear segment interval overlap (for two horizontal segments with equal `y` where `max(minX1, minX2) <= min(maxX1, maxX2)`, and symmetrically for vertical segments with equal `x`), as well as any interior vertex of wire `a` lying on a segment of wire `b` (orthogonal crossings without a shared vertex still remain disconnected, whereas collinear overlaps and T-contacts connect). Indexing segments by row `y` (horizontal) and column `x` (vertical) simultaneously makes this check O(W log W) instead of O(W²).
  2. At `src/io/netlist.ts:191`, resolve the tunnel name using `const def = getDef(ip.component.type); const props = def ? { ...def.defaultProps, ...ip.component.props } : ip.component.props; const name = propStr(props, "name", "").trim();`.
- **Confidence**: high

---

### AUD-07. Moving connected components or dragging a wire segment silently disconnects T-junction branch wires  (severity: critical)
- **Scenario**:
  Wire `w_main` connects `G1.out` `(80, 30)` to `G2.in0` `(160, 30)`. Branch wire `w_tap = [(120, 30), (120, 120), (160, 120)]` taps off `w_main` at T-junction `(120, 30)` to feed `G3.in0`.
  - If the user selects `G1` and `G2` and drags/nudges them up by 20 units, `w_main` translates rigidly to `y = 10`, leaving `w_tap` floating at `(120, 30)` and silently disconnecting `G3`.
  - Similarly, if the user selects `w_main` and drags its horizontal segment up by 20 units, `dragWireSegmentPoints` only preserves `w_main`'s endpoints `(80, 30)` and `(160, 30)`, detaching `w_tap` at `(120, 30)`.
- **Evidence**:
  - `src/editor/wire-utils.ts:297-327` (`captureAttachedWires`) only inspects wires touching pins of moved components, ignoring wires T-junctioned onto moved or translated wires.
  - `src/editor/editor.ts:1075-1100` (`drag-wire-segment`) only tracks `startAnchored` and `endAnchored` of the dragged wire, ignoring any other wire whose endpoint lies on the dragged segment.
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T9`.
- **Proposed fix**:
  1. Extend `captureAttachedWires` (and `move-selection` / `nudgeSelectionInStore`) to also capture unselected wires whose endpoints lie on any segment of a selected wire OR a both-ends-attached wire that translates rigidly, stretching those T-junction endpoints by `delta`.
  2. In `drag-wire-segment`, find all other wires with endpoints lying on the dragged segment `(origPoints[segIndex], origPoints[segIndex + 1])` and stretch their attached endpoint by `effDelta` inside the same drag gesture.
- **Confidence**: high

---

## Major

### AUD-08. `junctionPoints` misses real junctions and draws false junction dots on straight/duplicate wires  (severity: major)
- **Scenario**:
  1. **Missing dot on mid-segment pin tap**: Wire `w1 = [(80, 30), (200, 30)]` connects `G1.out` to `G3.in0` passing directly over `G2.in0` at `(120, 30)`. `buildNetlist` connects all 3 pins and `unconnectedPins` clears the marker, yet `junctionPoints` draws **no dot** at `(120, 30)` because `"120,30"` is not in `arms`.
  2. **Missing dot on 2-pin abutment + wire**: `G1.out` and `G2.in0` abut at `(80, 30)` and wire `w1` taps off `(80, 30)` (3 arms). Because `pinSet` is a `Set<string>`, both pins count as only `1` arm (`1 + 1 = 2 < 3`), omitting the junction dot.
  3. **False dots on collinear overlap & duplicate wires**: Drawing a collinear overlapping wire `[(50, 50), (100, 50)]` over `[(0, 50), (100, 50)]` draws a junction dot in the middle of a straight line at `(50, 50)`. Drawing a duplicate wire between two pins spawns junction dots on both pins.
  4. **Wrong dot location on L-wire overlapping a bus**: `w_bus = [(50, 0), (50, 150)]` with `w_l = [(0, 50), (50, 50), (50, 100)]` omits the dot at the real T-junction `(50, 50)` (an interior vertex of `w_l`) and places a false dot on the straight line at `(50, 100)`.
- **Evidence**:
  - `src/model/geometry.ts:139-175`: uses `pinSet` (`Set`, deduplicating coincident pins), only checks `arms.has(k)` for pins (missing mid-segment pin taps), only checks `endpoints` against segments (missing interior vertices), and counts raw segment incidences rather than distinct cardinal wire directions.
  - Demonstrated by `tests/audit-connectivity.test.ts`: `BUG-C1`, `BUG-C2`, and `BUG-C3`.
- **Proposed fix**:
  Replace arm counting in `junctionPoints` (`src/model/geometry.ts:139-175`) with direction-bitmask + pin-count evaluation:
  1. Build a `Map<string, number>` of `pinCount` per grid point (counting multiple abutting pins).
  2. Collect all candidate points: every wire vertex and every pin position.
  3. For each candidate point `p`, compute a 4-bit mask of distinct cardinal directions (`N`, `S`, `E`, `W`) in which any non-zero orthogonal wire segment leaves `p` (a segment strictly containing `p` contributes both opposite directions; a segment ending at `p` contributes the single direction toward its other endpoint). Deduplicating by 4-bit direction mask automatically ignores duplicate/overlapping collinear segments.
  4. Emit `p` iff `popcount(dirMask) + (pinCount.get(key(p)) ?? 0) >= 3` (excluding plain 2-pin abutment with `dirMask === 0` unless `pinCount >= 3`).
- **Confidence**: high

---

### AUD-09. 4× rotation and 2× multi-select mirror do not return to identity — components walk +20 to +40 units per cycle  (severity: major)
- **Scenario**:
  1. Select any component whose bounding box width or height is an odd multiple of `GRID = 10` — **20 of the 46 built-in components** at default props (`not`, `nand`, `nor`, `xnor`, `input-pin`, `output-pin`, `vcc`, `tunnel`, `decoder`, `subtractor`, `comparator`, `multiplier`, `register`, `shift-register`, `counter`, `register-file`, `ram`, `generic-block`, `pull-up`, `pull-down`). Press `R` 4 times (or use Properties Rotation `0° → 180° → 0°`). Instead of returning to `(100, 100)`, `not`/`nand`/etc. drift to `(120, 100)` (+20), and `register` (`110×110`) drifts to `(140, 100)` (+40).
  2. Select a `not` gate (`width = 90`) together with a wire (any multi-selection with odd-grid width) and press `M` twice. Instead of returning to `(100, 100)`, the selection drifts to `(120, 100)` (+20).
- **Evidence**:
  - `src/editor/doc-ops.ts:118-119`: `cx = snap(bounds.x + bounds.w / 2, grid)` uses `Math.round`, which always rounds half-grid centers (`*.5 * grid`) toward `+∞`, accumulating `+grid` drift every 180° (and `+2*grid` per 360°, or `+4*grid` when both `w` and `h` are odd multiples of `grid`).
  - `src/editor/doc-ops.ts:194-224`: `mirrorSelectionInDoc` computes `cx = snap(bounds.x + bounds.w / 2, grid)` and then `2 * cx - x`. Because `2 * (bounds.x + bounds.w / 2) = 2 * bounds.x + bounds.w` is already an exact multiple of `grid`, snapping `cx` unnecessarily forces `2 * cx` to a multiple of `2 * grid` and shifts odd-width selections right by `+10` on every mirror.
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T5` and `BUG-T6`.
- **Proposed fix**:
  1. For `mirrorSelectionInDoc` (`src/editor/doc-ops.ts:194-224`), replace `2 * cx` with `const twoCx = snap(2 * bounds.x + bounds.w, grid);` and compute `twoCx - c.x - g.width`, `twoCx - p.x`, etc. This preserves exact grid alignment and makes `mirror² === identity` with zero drift.
  2. For single-component rotation (`rotateSelectionInDoc` / `setComponentRotationInDoc`), either store/derive a consistent top-left bounding-box mapping that keeps the bounding box centered without monotonic rounding bias (e.g. for 90° steps alternate `Math.floor`/`Math.ceil` by rotation parity `(rot / 90) % 2`, or map `bounds` center using exact `cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2` and snap the final translation delta by parity so `R^4 === I` for every `(w, h)`). Verify `R^4 === I` across all 46 component defs.
- **Confidence**: high

---

### AUD-10. Mirroring or 180°-rotating components renders embedded text backwards or upside-down (36 of 46 components)  (severity: major)
- **Scenario**:
  Place a `tunnel` (whose pin is on the left, flag pointing right) and press `M` (Mirror) to attach it to the left side of a flip-flop so the flag points left. Because `svgTransform` applies `translate(width 0) scale(-1 1)` to the entire component `<g>`, the net name `"CLK"` inside `<text>` renders mirror-imaged backwards. Pressing `R` twice (180°) renders `"CLK"` upside-down. The same affects 36 of 46 built-in components (`input-pin`, `output-pin`, `constant`, `vcc`, `tunnel`, `mux`, `demux`, `decoder`, `encoder`, `alu`, `adder`, `d-ff`, `register`, `ram`, `rom`, `generic-block`, etc.).
- **Evidence**:
  - `src/model/geometry.ts:44-50` (`svgTransform`) and `src/render/svg.ts:85-94` (`renderComponent`) wrap the entire output of `def.symbol(props)` in `<g transform="${tf}">` without counter-transforming `<text>` elements or separating geometry from upright text rendering.
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-R3`.
- **Proposed fix**:
  In `renderComponent` (`src/render/svg.ts:85-94`), when `inst.mirror` or `inst.rotation === 180` (or `90`/`270`), either:
  - Post-process `<text x="..." y="..." ...>` elements inside `inner` to inject a counter-transform around `(x, y)` (e.g. for `mirror`: `transform="translate(2*x 0) scale(-1 1)"` and swap `text-anchor="start"` ↔ `"end"`; for `rotation === 180`: `rotate(180 x y)` and adjust baseline), **or**
  - Add an optional `labels(props)` / upright-text helper on `ComponentDef` (or pass transform orientation to `symbol(props)` / `renderBox`) so text is always drawn upright and left-to-right in world space.
- **Confidence**: high

---

### AUD-11. `documentBounds` clips multi-line `TextNote`s and long component labels in exports; `clock`/`probe` draw names outside their bounding box  (severity: major)
- **Scenario**:
  1. Add a 6-line `TextNote` (e.g. a truth table) with `fontSize = 14` at `(10, 20)`. Its last line renders at `y = 107.5`, but `documentBounds()` ignores `\n` and reports `h = 14 * 1.3 = 18.2` (bottom `y = 24.2`). Even with default export `padding = 20`, the exported SVG/PNG `viewBox` ends at `y = 44.2`, **completely clipping lines 3–6** (and colliding with `titleBlock` if enabled). Meanwhile `w` uses the full string length across all lines, inflating horizontal whitespace.
  2. Give a component on the edge of the canvas a long label (e.g. `"ANALOG_REFERENCE_GROUND"` on a `ground` of width `20`). `documentBounds()` ignores `inst.label`, so both ends of the label are clipped even with default `padding = 20`.
  3. Set the `Label` (`name`) prop on a `clock` or `probe` component: `symbol()` renders the text at `y = 30` / `y = 29`, outside `geometry().height = 20`, so the selection highlight cuts across the text, hit-testing misses it, and exports with tight padding clip it.
- **Evidence**:
  - `src/model/geometry.ts:93-102` (`documentBounds`) computes `{ w: Math.max(fs, t.text.length * fs * 0.6), h: fs * 1.3 }` without splitting on `"\n"` (unlike `textBounds` in `src/editor/wire-utils.ts:459-466`) and never includes `inst.label` bounds.
  - `src/components/library/io.ts:98-112` (`clockDef`) and `src/components/library/io.ts:210-227` (`probeDef`) return `height: 20` while placing `<text>` at `y="30"` and `y="29"`.
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-R1` and `BUG-R2`.
- **Proposed fix**:
  1. In `documentBounds` (`src/model/geometry.ts:93-102`), compute multi-line text bounds by splitting on `"\n"` (`maxLen = max(line.length)`, `h = (lines.length - 1) * fs * 1.25 + fs * 1.35`) and union an estimated label rect for every component with `c.label` (`y: minY - 18, h: 16`, centered at `cx` with width `c.label.length * 7 + 8`).
  2. In `clockDef` and `probeDef` (`src/components/library/io.ts`), increase `geometry(props).height` to `30` (or `40` on grid) when `name` is non-empty, or display `name` inside the body / via the component's `label`.
- **Confidence**: high

---

### AUD-12. `keepWiresAttached` leaves corrupt 1-point zombie wires in `doc.wires`  (severity: major)
- **Scenario**:
  Place an `input-pin` (`name: "A", width: 1`, `totalW = 50`, `out` at `(150, 110)`) wired via a 30px wire `[(150, 110), (180, 110)]` to an `and` gate's `in0` at `(180, 110)`. Change the `input-pin` `Bit Width` from `1` to `8` (`"A[7:0]"` grows `totalW` to `80`, moving `out` to `(180, 110)`). `keepWiresAttached` calls `a.wire.points = normalizeWirePoints([(180, 110), (180, 110)])`, setting `w.points = [{ x: 180, y: 110 }]` (1 point) and leaving `w` inside `doc.wires`. The invisible, unselectable 1-point wire inflates wire counts, causes `unconnectedPins` (`geometry.ts:180`) to treat `(180, 110)` as permanently wired even if components move away, and triggers sanitization warnings on save/reopen.
- **Evidence**:
  - `src/editor/doc-ops.ts:75`: assigns `a.wire.points = normalizeWirePoints(pts)` without filtering out wires with `points.length < 2`.
  - `src/editor/doc-ops.ts:232, 240`: `rotateSelectionInDoc`/`mirrorSelectionInDoc` call `normalizeDocWires` *before* `keepWiresAttached` stretches wires; `src/ui/properties.ts:185, 198, 251` never call `normalizeDocWires` at all.
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T7`.
- **Proposed fix**:
  Call `normalizeDocWires(doc)` at the end of `keepWiresAttached` (`src/editor/doc-ops.ts:76`) so any wire collapsed to `< 2` points during rotation, mirroring, or parametric editing is immediately removed from `doc.wires`.
- **Confidence**: high

---

### AUD-13. `exportJpegBlob` with `DARK_THEME` forces a white background under pale text/lines  (severity: major)
- **Scenario**:
  Call `exportJpegBlob(doc, { theme: DARK_THEME })`. Line 305 strips the SVG's dark background rect (`background: false`) and line 306 fills the raster canvas with hardcoded `"#ffffff"`. Because `DARK_THEME` uses pale grey `#d7dce4` for text and component strokes and `#1b1e24` for inversion-bubble fills, the resulting JPEG renders unreadable light-grey text and strokes on pure white.
- **Evidence**:
  - `src/io/export.ts:304-306`:
    ```ts
    const svg = exportSvgString(doc, { ...opts, background: false });
    return rasterizeSvg(svg, "image/jpeg", opts.scale ?? 2, "#ffffff", quality);
    ```
  - `src/render/svg.ts:47-57` (`DARK_THEME.ink = "#d7dce4"`, `DARK_THEME.text = "#d7dce4"`, `DARK_THEME.background = "#1b1e24"`).
- **Proposed fix**:
  In `exportJpegBlob` (`src/io/export.ts:304-306`), fill the canvas with the selected theme's background color (`const bg = opts.background === false ? "#ffffff" : (opts.theme?.background ?? "#ffffff");`) instead of hardcoding `"#ffffff"`.
- **Confidence**: high

---

### AUD-14. O(W²) `junctionPoints` and O(P×W) `unconnectedPins` run on every 10px drag step (plus 3× redundant snap scans per mouse pixel)  (severity: major)
- **Scenario**:
  In a lab schematic with 500–1,000 wires (e.g. a multi-bit CPU datapath or register file with individual-bit pins), dragging a single component calls `store.update("Move", ...)` on every 10px cursor movement. Each move deep-clones the entire document (`structuredClone`), rebuilds the entire SVG DOM via `sceneGroup.innerHTML = renderScene(doc)`, and executes:
  - `junctionPoints(doc)`: O(W × S) nested loop calling `Math.hypot` via `distToSegment`.
  - `unconnectedPins(doc)`: O(P × S) nested loop calling `Math.hypot`.
  - Measured in Node/V8: at 500 wires (1,500 segments, 750 pins), `junctionPoints` (28.7 ms) + `unconnectedPins` (25.5 ms) = **54.2 ms per single 10px drag step** before cloning/DOM reparsing (< 15 FPS); at 1,000 wires, **207.6 ms per drag step** (< 5 FPS) and `buildNetlist` takes **254.1 ms**.
  - Additionally, during plain wire-draft mouse movement (`onPointerMove`), `updateHoverFromCursor()` (`editor.ts:748`), `renderOverlay()` → `currentWireTargetPoint()` (`editor.ts:662`), and `routeDraftTo()`'s default parameter (`editor.ts:724`) invoke `currentWireSnapTarget()` **3 separate times on every single mouse pixel**, and `onPointerMove` replaces `overlayGroup.innerHTML` even when hover state did not change.
- **Evidence**:
  - `src/model/geometry.ts:159-164` (`junctionPoints`), `src/model/geometry.ts:189-191` (`unconnectedPins`), `src/io/netlist.ts:142-184` (`buildNetlist`).
  - `src/editor/editor.ts:566-584, 662-663, 724, 748, 1189-1216, 1283-1286`.
  - Demonstrated by `tests/audit-connectivity.test.ts`: `PERF-1`.
- **Proposed fix**:
  1. Index axis-aligned segments by coordinate in `Map<number, [number, number][]>` (`horizByY` and `vertByX`) inside `junctionPoints`, `unconnectedPins`, and `buildNetlist`, replacing `distToSegment`/`Math.hypot` with exact integer interval checks (`x >= minX && x <= maxX`). This reduces complexity from O(W²) to O(W) on typical schematics.
  2. In `Editor.renderOverlay()` (`editor.ts:662-663`), compute `const snapTarget = this.currentWireSnapTarget()` once (or reuse the result from `updateHoverFromCursor`) and pass it explicitly into `routeDraftTo(target, snapTarget)`. Skip `renderOverlay()` on idle `pointermove` when `hover` has not changed and no draft/ghost/marquee is active.
  3. During `move-selection` drags, consider transforming the dragged elements via SVG overlay / `transform` preview and committing once on `pointerup` (or throttling/incremental SVG updates).
- **Confidence**: high

---

### AUD-15. Short wires between pins (10px at any zoom; 20px at zoom ≤ 0.8) cannot be clicked/selected in Select mode  (severity: major)
- **Scenario**:
  Place two components 1 grid cell apart (`and.out` at `(80, 30)`, `not.in0` at `(90, 30)`) connected by a 10px wire `[(80, 30), (90, 30)]`. Switch to Select tool and try to click the wire to delete it or change its bus width. At **every zoom level** (even `MAX_ZOOM = 8`), `pinToleranceWorld()` returns `clamp(9 / zoom, 5, 16) >= 5`. Every point on the 10px wire is within distance `<= 5` of one of the two pins, and `findPinAt` runs *before* `hitTestDocument`, capturing the click as `pending-pin-wire` and selecting the component instead of the wire. At `zoom <= 0.8` (`tol >= 11.25`), 20px wires become unclickable too, and on small components like `ground` (`20×20`), a radius-16 pin zone at 50% zoom covers ~80% of the body, preventing users from dragging it.
- **Evidence**:
  - `src/editor/editor.ts:476-478` (`pinToleranceWorld` lower bound is `5`, upper bound `16`) and `src/editor/editor.ts:1016-1029` (`findPinAt` unconditionally preempts `hitTestDocument` in Select mode).
  - Demonstrated by `tests/audit-connectivity.test.ts`: `BUG-C7`.
- **Proposed fix**:
  1. Reduce `pinToleranceWorld()` (e.g. `clamp(6 / this.zoom, 3, 9)` in Select mode, keeping a wider snap radius only in Wire mode / active wire drafting).
  2. In `handleSelectPointerDown`, if `cursorWorldExact` is closer to a wire segment's interior (distance from nearest pin `> 3` world units and `distToSegment <= wireToleranceWorld()`) than to a pin center, select the wire instead of starting `pending-pin-wire`.
- **Confidence**: high

---

### AUD-16. Properties panel number inputs push duplicate no-op undo entries on every edit  (severity: major)
- **Scenario**:
  Select an `and` gate (2 inputs) and click the up-spinner on `Inputs` in the Properties panel once (changing `2 → 3`), or type `4` and press Enter/Tab. The browser fires `input` (calling `store.update("Set Inputs", ...)` — undo step #1) and then `change` (calling `applyProp(3)` again even though `c.props.inputs` is already `3` — undo step #2, a no-op). Pressing `Ctrl+Z` once appears to do nothing; the user must press `Ctrl+Z` twice to undo a single parameter change. Clicking into a number field, clearing/typing invalid text, and blurring also triggers `change` → `applyProp(fallback)`, pushing a no-op undo entry and setting `store.dirty = true`. The same bug affects wire `Bus width` and text `Font size`.
- **Evidence**:
  - `src/ui/properties.ts:275-291` (component `int` props), `src/ui/properties.ts:375-384` (wire `Bus width`), `src/ui/properties.ts:461-470` (text `Font size`) all attach both `input` and `change` listeners calling `store.update(...)` unconditionally without checking whether the value actually changed.
- **Proposed fix**:
  In `applyProp`, `applyWidth`, and `applySize` (`src/ui/properties.ts`), compare the incoming value against the current stored value (`cur.props[pdef.key]`, `w.width ?? 1`, `t.fontSize ?? 14`) and return early without calling `store.update(...)` if unchanged.
- **Confidence**: high

---

### AUD-17. `Ctrl+C` → `Ctrl+V` without moving the cursor (or pasting twice) stacks copies directly on top of originals, shorting all pins  (severity: major)
- **Scenario**:
  Select a component (or subcircuit) on the canvas, leave the mouse stationary, and press `Ctrl+C` then `Ctrl+V` — or move the cursor to a spot and press `Ctrl+V` twice to create two copies. Because `this.hasCursor` is `true`, `Editor.paste()` passes `this.cursorWorldSnapped` directly as `targetCenter` to `pasteClipboardIntoStore`, placing the copy at `dx = 0, dy = 0` directly on top of the original (or previous paste). Because connectivity is geometric, every pin of the stacked copy coincides with every pin of the original, silently shorting all of their nets together while hiding the duplicate underneath.
- **Evidence**:
  - `src/editor/editor.ts:390-394`:
    ```ts
    paste(): void {
      if (!this.clipboard) return;
      const target = this.hasCursor ? this.cursorWorldSnapped : undefined;
      pasteClipboardIntoStore(this.store, this.clipboard, target);
    }
    ```
  - `src/editor/doc-ops.ts:335-339` only applies the `(+2*grid, +2*grid)` offset when `targetCenter` is `undefined`.
- **Proposed fix**:
  Track `lastPasteTarget: Point | null` and `pasteCascadeCount` on `Editor` (reset whenever `copySelection()` runs or `cursorWorldSnapped` moves). When pasting at the same snapped coordinate as `clip.anchor` or `lastPasteTarget`, offset the paste target by `(+2 * grid * count, +2 * grid * count)` (or check for exact coordinate overlap with existing components in `store.doc` and cascade by `+2 * grid`).
- **Confidence**: high

---

### AUD-18. Inline Text Note editor fails to cancel new notes on `Escape`, requires 2 undos, spawns duplicates on click-away, and can dirty a replaced document  (severity: major)
- **Scenario**:
  1. **Cannot cancel with `Escape`**: Select the Text tool (`T`), click the canvas (creates `{ text: "Text" }`, opens inline `<textarea>` with `"Text"` selected), and press `Escape` to cancel. `finish(false)` checks `if (isNew && val.trim() === "")`, which is `false` because `val === "Text"`, leaving the unwanted `"Text"` note on the canvas.
  2. **2 undos for 1 text note**: Click with Text tool (undo step #1: `"Add text note"`), type `"CLK"`, press `Ctrl+Enter` (undo step #2: `"Edit text note"`). Pressing `Ctrl+Z` reverts the text to `"Text"` instead of removing the note.
  3. **Click-away spawns a second note**: While in Text tool with the inline textarea open, click empty canvas to finish typing. `onPointerDown` closes the active editor (`editor.ts:887`) and immediately falls through to line 934, spawning a brand-new `"Text"` note at the click point.
  4. **Dangling blur on `store.replace()`**: Pressing `Ctrl+N`/`Ctrl+O` while editing a text note calls `closeTextEditor(false)` → `ta.remove()` without disarming the `blur` listener (`finished` stays `false`). In Chromium/WebView2, removing a focused `<textarea>` fires `blur`, triggering `finish(true)` → `store.update(...)` on the newly opened/blank document and marking it dirty.
- **Evidence**:
  - `src/editor/editor.ts:887, 934-945, 1423-1499`.
- **Proposed fix**:
  1. Do not insert the `TextNote` into `store` until the user commits non-empty text (render/position the floating `<textarea>` from pending `{ x, y }` state and issue a single `store.update("Add text note", ...)` on commit). That automatically fixes `Escape` cancellation (0 undo steps, nothing left behind) and 1-step undo.
  2. In `onPointerDown`, if `this.activeTextEditor` was open, commit/close it and `return` early when `this.tool === "text"` so clicking outside dismisses the editor instead of spawning another note.
  3. Store a `cancelTextEditor` closure on `Editor` that sets `finished = true` before `ta.remove()` inside `closeTextEditor(false)`.
- **Confidence**: high

---

### AUD-19. `parseProject` accepts non-10 `grid` values that silently snap wires off component pins, and preserves zero-length / diagonal wires  (severity: major)
- **Scenario**:
  1. **Grid mismatch disconnects circuits**: All built-in components define pins at multiples of `GRID = 10` (`src/model/component-def.ts:13`), e.g. a 2-input `and` gate at `(100, 100)` has `out` at `(180, 130)`. `parseProject` accepts any positive finite `grid` (including `grid: 20`, `15`, or `0.5`). Opening a file with `grid: 20` snaps the wire endpoint `(180, 130)` to `(180, 140)`, silently disconnecting it from `and.out` at `(180, 130)`. A file with `grid: 0.5` also causes `Editor.updateGrid` to render an extreme density of pattern dots.
  2. **Zero-length & diagonal wires**: `sanitizeWires` only checks `points.length >= 2`. A wire `[{x: 10, y: 10}, {x: 10, y: 10}]` (or two points that snap to the same grid point) and diagonal wires `[{x: 0, y: 0}, {x: 50, y: 50}]` pass with zero warnings; diagonal wires cannot be segment-dragged (`dragWireSegmentPoints` returns unchanged) and snap off-wire in `findSnapTarget`.
- **Evidence**:
  - `src/io/project.ts:380-410, 584-597`.
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-IO2`.
- **Proposed fix**:
  1. Clamp/validate `doc.grid` in `parseProject` to divisors of `GRID` or enforce `GRID = 10` (emitting a warning when coercing an incompatible grid, or avoid snapping wire/component coordinates to a coarser grid than `GRID = 10`).
  2. In `sanitizeWires`, run `normalizeWirePoints` (dropping wires that collapse to `< 2` points with a warning) and warn/orthogonalize any non-axis-aligned segment.
- **Confidence**: high

---

### AUD-20. Keyboard shortcuts lock up after clicking Properties checkboxes/selects or Toolbar Theme; global shortcuts fire behind modal dialogs; Toolbar Undo/Redo leaves stale `wireDraft`  (severity: major)
- **Scenario**:
  1. **Focus trap on non-text controls**: Toggle any checkbox in the Properties panel (`Mirror`, `Enable Pin`, `Carry In`) or change any `<select>` (`Rotation`, `Pin Mode`, or the Toolbar `Theme` dropdown). Because `isEditableElement` returns `true` for all `<input>` (including `type="checkbox"`) and `<select>` elements, focus remains on that control and **all canvas shortcuts (`R`, `M`, `W`, `V`, `Delete`, `Space`, `Ctrl+Z`, `Ctrl+Y`, Arrow keys) silently stop working** until the user clicks the canvas.
  2. **Global shortcuts ignore modals**: Press `Ctrl+E` to open the Export `<dialog>`, then press `Ctrl+E` again (or `Ctrl+N`/`Ctrl+O`). `installGlobalShortcuts` does not check `document.querySelector("dialog[open]")`, stacking duplicate export dialogs or discarding the document behind the modal.
  3. **Toolbar Undo/Redo leaves stale `wireDraft`**: Start drawing a wire (`wireDraft !== null`), then click the Toolbar **Undo** or **Redo** button. Unlike `Ctrl+Z` in `Editor.onKeyDown` (`editor.ts:1526`), the toolbar button calls `store.undo()` directly without clearing `editor.wireDraft`, leaving a stale wire preview attached to deleted/moved pins.
- **Evidence**:
  - `src/editor/editor.ts:86-90` (`isEditableElement` checks `tag === "INPUT" || ... || tag === "SELECT"` regardless of `input.type`).
  - `src/app/commands.ts:167-168` (`action: () => store.undo()`), `src/app/commands.ts:201-207` (`themeSel`), `src/app/commands.ts:221-233` (`installGlobalShortcuts` missing `dialog[open]` check).
- **Proposed fix**:
  1. In `isEditableElement` (`src/editor/editor.ts:86-90`), exclude non-text `<input>` types (`checkbox`, `radio`, `button`, `range`) so toggling checkboxes does not hijack `Ctrl+Z`/`R`/`W`/`Delete`/`Space`; blur `<select>` elements in `properties.ts` and `commands.ts` (`themeSel.onchange`) after selection, or allow `Ctrl+Z`/`Ctrl+Y` globally outside text inputs.
  2. In `installGlobalShortcuts` (`src/app/commands.ts:222`), return early if `document.querySelector("dialog[open]")` is present.
  3. In `Editor`'s `store.subscribe` handler (`src/editor/editor.ts:256-265`), or by routing Toolbar Undo/Redo through `editor.undo()`/`editor.redo()`, clear `this.wireDraft = null` when an external undo/redo fires.
- **Confidence**: high

---

## Minor

### AUD-21. Properties panel Mirror checkbox flips vertically when rotated 90°/270°, contradicting `M` / toolbar Mirror  (severity: minor)
- **Scenario**:
  Place an `and` gate, rotate it to `90°`, and check the `Mirror` box in the Properties panel. Because `mirror` in `localToWorld` is applied in local X *before* rotation, setting `c.mirror = true` alone flips the gate **vertically** (top-to-bottom in world space). By contrast, pressing `M` or clicking the toolbar `Mirror` button calls `mirrorSelectionInDoc`, which flips **horizontally** and swaps `rotation` `90 ↔ 270`. Worse, pressing `M` on a `90°` gate sets `mirror = true, rotation = 270`; unchecking `Mirror` in Properties then leaves the gate at `270°` (rotated 180° from where the user started).
- **Evidence**:
  - `src/ui/properties.ts:192-204` mutates `c.mirror = checked || undefined` directly instead of calling `mirrorSelectionInDoc`.
  - `src/editor/doc-ops.ts:176-189` (`mirrorSelectionInDoc` adjusts `x, y` and swaps `90 ↔ 270`).
  - Demonstrated by `tests/audit-transforms.test.ts`: `BUG-T10`.
- **Proposed fix**:
  Either invoke `mirrorSelectionInDoc(draft, new Set([compId]))` from `mirrorChk.addEventListener("change", ...)` in `src/ui/properties.ts:194-204` so both UI entry points perform identical horizontal world-space mirroring, or label the Properties checkbox explicitly as `"Flip Local X"` and provide a `"Mirror Horizontal"` button consistent with the toolbar.
- **Confidence**: high

---

### AUD-22. Exported SVG `grid: true` clips 75% of every grid dot  (severity: minor)
- **Scenario**:
  Export any schematic to SVG or PNG with `Grid dots` enabled (`grid: true`). `renderDocumentSvg` defines `<pattern id="ds-grid" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.9" .../></pattern>`. Because SVG `<pattern>` tiles clip to `[0, width] × [0, height]`, centering the circle at `(0, 0)` clips away three-quarters of every dot, rendering tiny quarter-circle wedges in browsers and Inkscape.
- **Evidence**:
  - `src/render/svg.ts:166-172` (contrast with the correct half-tile offset in `src/editor/editor.ts:544-553`).
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-R4`.
- **Proposed fix**:
  In `src/render/svg.ts:167-171`, mirror the editor's pattern coordinates:
  ```ts
  const gs = doc.grid || 10;
  const half = gs / 2;
  grid =
    `<defs><pattern id="ds-grid" x="${-half}" y="${-half}" width="${gs}" height="${gs}" patternUnits="userSpaceOnUse">` +
    `<circle cx="${half}" cy="${half}" r="0.9" fill="${theme.grid}"/></pattern></defs>` +
    `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="url(#ds-grid)"/>`;
  ```
- **Confidence**: high

---

### AUD-23. Flip-Flop `CLK` pin has an empty `name` (`FF1.` in netlist, missing hover tooltip) and `Q'` shares `"Q"` with `Q`  (severity: minor)
- **Scenario**:
  Place a `d-ff` (or `jk-ff`, `t-ff`, `sr-ff`) labeled `FF1` with `showQBar: true`, and export netlist text (`exportNetlistText`) or hover over its pins on the canvas:
  1. The `clk` pin has `name: ""`. `exportNetlistText` resolves `map.get("clk") ?? "clk"` to `""` (since `""` is not nullish), outputting `FF1.` with a trailing dot and blank pin name, and canvas pin hover (`editor.ts:644`) displays no tooltip.
  2. Both `q` and `qn` (on all 4 flip-flops and all 3 latches) have `name: "Q"`, so `exportNetlistText` outputs identical `FF1.Q` tokens for both `Q` and `Q'`, and canvas hover displays `"Q"` for `Q'`.
- **Evidence**:
  - `src/components/library/flipflops.ts:49, 73`, `src/components/library/latches.ts:20, 59, 99`.
  - `src/io/netlist.ts:295, 299` (`map.get(pinId) ?? pinId`), `src/editor/editor.ts:643-644`.
  - Demonstrated by `tests/audit-connectivity.test.ts`: `BUG-C6`.
- **Proposed fix**:
  1. In `src/io/netlist.ts:299`, fall back to `pinId` when `pin.name` is empty (`const n = map.get(pinId); return n && n.trim() ? n : pinId;`), and append `'` (or `_n`) when `pin.inverted` creates a duplicate name on the same component (or give `PinDef` `name: "Q'"` / `name: "CLK"` and use a separate `symbolLabel` override in `PinSpec` where the symbol draws only the clock triangle or an overbarred `"Q"`).
  2. In `src/editor/editor.ts:643`, fall back to `wp.pin.id.toUpperCase()` when `wp.pin.name` is empty and append `'` when `wp.pin.inverted` and `wp.pin.id === "qn"`.
- **Confidence**: high

---

### AUD-24. `cancelGesture()` leaves `store.dirty = true` and `redoStack` wiped; 0-delta drags record no-op undo steps  (severity: minor)
- **Scenario**:
  1. Open or save a schematic (`store.dirty === false`) with a redo entry available. Drag a component and press `Escape` to cancel the drag. `cancelGesture()` restores the original document, but `store.dirty` remains `true` (triggering a spurious "Discard unsaved changes?" prompt on close/new) and `redoStack` remains permanently cleared.
  2. Drag a component 10px right and back 10px left to its exact starting coordinates (`delta = (0, 0)`), then release. Because `inter.moved` became `true`, `onPointerUp` commits a no-op `"Move"` entry on `undoStack` and sets `dirty = true`.
- **Evidence**:
  - `src/model/store.ts:60-68, 80-89` (`update` clears `redoStack` and sets `dirty = true` immediately on the first gesture frame; `cancelGesture` restores neither).
  - `src/editor/editor.ts:1185-1187, 1300-1316` (`onPointerUp` does not cancel the gesture when `lastDelta` returns to `{x: 0, y: 0}`).
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-S3`.
- **Proposed fix**:
  1. In `DocumentStore.beginGesture()`, snapshot `gesturePrevDirty = this.dirty` and `gesturePrevRedo = this.redoStack` (only replacing `redoStack` on `endGesture()` or restoring both on `cancelGesture()`).
  2. In `Editor.onPointerUp` (`move-selection` and `drag-wire-segment`), if `inter.lastDelta.x === 0 && inter.lastDelta.y === 0`, call `this.store.cancelGesture()` instead of `this.store.endGesture()`.
- **Confidence**: high

---

### AUD-25. Wire-tool double-click uses `PointerEvent.detail` (always `0`); `Escape` during `pin-wire-drag`/`marquee` leaks interaction state  (severity: minor)
- **Scenario**:
  1. **Wire tool double-click**: In Wire tool (`W`), `onPointerDown` calls `this.handleWireToolClick(e.detail >= 2)`. Per the W3C Pointer Events specification (and Chromium/WebView2), `PointerEvent.detail` on `pointerdown` is always `0`, so `isDoubleClick` is always `false`. Double-clicking only finishes a wire by coincidence when click 2 lands on the exact same snapped grid point (`pointsEqual(targetPt, last)`): a 1-grid jitter between clicks fails to finish the wire, and the `if (isDoubleClick) return;` guard on line 963 is dead code, so rapid double/triple clicks immediately start an unwanted new wire.
  2. **`Escape` during `pin-wire-drag` or `marquee`**: While holding left mouse button during a pin-wire drag in Select mode, press `Escape`. `editor.ts:1556` hits `else if (this.wireDraft)` and clears `this.wireDraft = null`, leaving `this.interaction` stuck in `"pin-wire-drag"` with pointer capture still held. Pressing `Escape` during a `"marquee"` drag clears `this.interaction` without restoring `inter.initialSelection` and without calling `releasePointer(inter.pointerId)`.
- **Evidence**:
  - `src/editor/editor.ts:948-952, 958-982` (`e.detail >= 2` on `PointerEvent`).
  - `src/editor/editor.ts:1552-1568` (`Escape` branches).
- **Proposed fix**:
  1. Track the timestamp and screen coordinates of the previous `pointerdown` in Wire tool (`now - lastWireClickTime < 350 && hypot(dx, dy) < 6`) — or finish drafts in `onDoubleClick` — instead of reading `PointerEvent.detail`.
  2. In the `Escape` handler (`src/editor/editor.ts:1552-1568`), always clear and release pointer capture on `this.interaction` when clearing `this.wireDraft` during `pin-wire-drag`, and restore `this.store.setSelection(inter.initialSelection)` when cancelling `"marquee"`.
- **Confidence**: high

---

### AUD-26. Windows path handling fails in status bar/title and unsanitized `doc.name` breaks native Save filenames  (severity: minor)
- **Scenario**:
  1. Open or save `C:\Users\student\Documents\lab3.dschem` in the Windows Tauri desktop app. `src/main.ts:22` runs `store.filePath.split(/[\/]/).pop()` (missing escaped backslash `\\`), displaying the full raw path `C:\Users\student\Documents\lab3.dschem • — DigiSchem` in both the status bar and window title instead of `lab3.dschem`.
  2. Rename a new unsaved document in the Properties panel to a typical course title like `"4:1 MUX"`, `"2:4 Decoder"`, or `"D/JK Flip-Flop"` (or clear it to `""`), and press `Ctrl+S` or Export SVG/PNG. `baseName(null, this.store.doc.name)` returns the raw string unsanitized (`"4:1 MUX.dschem"`, `"D/JK Flip-Flop.svg"`, or `".dschem"`), containing Windows-illegal characters (`:`, `/`) that fail or misbehave in Tauri's native Save dialog.
- **Evidence**:
  - `src/main.ts:22` (`split(/[\/]/)` vs `split(/[\\/]/)` in `src/app/commands.ts:14`).
  - `src/app/commands.ts:12-16, 59, 81, 98`.
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-IO4`.
- **Proposed fix**:
  1. Change `src/main.ts:22` to `store.filePath.split(/[\\/]/).pop()`.
  2. In `baseName` (`src/app/commands.ts:12-16`), sanitize characters forbidden in Windows/macOS/Linux filenames (`/[<>:"/\\|?*\x00-\x1f]/g` → `_`), trim whitespace/trailing dots, and fall back to `"Untitled"` if empty.
- **Confidence**: high

---

### AUD-27. SVG export edge cases: zero-height/width 1D wire SVG at `padding: 0`, collapsed `titleBlock` width, and low-contrast dark-theme `.ds-unknown`  (severity: minor)
- **Scenario**:
  1. Export a document containing a single horizontal wire `[(0, 50), (100, 50)]` with `padding: 0`. `documentBounds` has `h = 0`, so `renderDocumentSvg` emits `width="100" height="0" viewBox="0 50 100 0"` (invisible/invalid SVG, and `parseSvgDimensions` rejects `h <= 0` and falls back to `{ width: 200, height: 100 }`).
  2. Call `exportSvgString(doc, { titleBlock: true, padding: 200 })` on a narrow schematic (`baseBounds.w = 20`). `TITLE_BLOCK_MIN_WIDTH - 2 * pad = 320 - 400 = -80`, so `minContentW` collapses to `20px` and the title block text overflows outside the 20px box.
  3. Open a file containing an unknown component type in `DARK_THEME`: `.ds-unknown` uses hardcoded light-pink `fill:#ffecec` while `.ds-text` uses light-grey `#d7dce4`, making `?type` nearly invisible.
- **Evidence**:
  - `src/render/svg.ts:80, 162-175`, `src/io/export.ts:122, 176-187`.
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-R5`, `BUG-IO1`, and `SCAN`.
- **Proposed fix**:
  1. In `renderDocumentSvg`, clamp `vw = Math.max(10, b.w + 2 * pad)` and `vh = Math.max(10, b.h + 2 * pad)` (centering around `b` when expanding 0-dimension axes).
  2. In `exportSvgString` (`src/io/export.ts:122`), use `const minContentW = Math.max(baseBounds.w, TITLE_BLOCK_MIN_WIDTH);` (independent of `pad`, or sized to fit the actual title/metadata text widths).
  3. In `schematicCss(t)` (`src/render/svg.ts:80`), style `.ds-unknown` using theme-appropriate contrast (e.g. dark fill `#3a1e1e` in `DARK_THEME`) or give the `?type` text a dedicated dark-ink class.
- **Confidence**: high

---

### AUD-28. Bus Splitter generates impossible bit-index labels when `fanOut > width`  (severity: minor)
- **Scenario**:
  Place a `splitter` (`Bus Splitter / Merger`) and set `Bus Width = 4`, `Fan-Out = 8` (e.g. increasing Fan-Out before increasing Bus Width). The bus pin is `[3:0]` (4 bits), yet `computeSlices` creates 8 output pins labeled `"0", "1", "2", "3", "4", "5", "6", "7"` (while clamping internal `lo/hi` to `3`).
- **Evidence**:
  - `src/components/library/io.ts:274-279`: sets `const bit = Math.min(i, totalWidth - 1)` but uses `label: String(i)` instead of `String(bit)` or clamping `fanOut` to `totalWidth`.
  - Demonstrated by `tests/audit-store-io.test.ts`: `BUG-IO3`.
- **Proposed fix**:
  Clamp effective `fanOut` to `Math.min(fanOut, busW)` in `splitterGeometry` (`src/components/library/io.ts:296`), since a bus of width `W` cannot meaningfully split into more than `W` 1-bit slices (or if bit-replication is intended, label each replicated pin with `String(bit)` so the displayed index matches the actual bit).
- **Confidence**: high

---

### AUD-29. Component labels collide with top-facing pins/wires, and blank lines in multi-line `TextNote`s collapse in SVG/Inkscape  (severity: minor)
- **Scenario**:
  1. Place any component with top pins (`full-adder`, `adder`, `subtractor`, `alu`, `register-file`, `ram`, `tristate`, `ground`, `pull-down`, or a rotated component with pins facing up) and wire its top pin vertically upward. `renderLabel` always places the label at `(cx, minY - 6)` — directly on top of the vertical wire exiting the top pin.
  2. Create a `TextNote` containing a blank line (`"Section 1\n\nSection 2"`). `renderText` emits `<tspan x="10" dy="17.5"></tspan>` for the empty line; in SVG 1.1 / browsers / Inkscape, an empty `<tspan>` does not advance vertical position, collapsing the blank line.
- **Evidence**:
  - `src/render/svg.ts:97-105` (`renderLabel` ignores pin sides).
  - `src/render/svg.ts:121-128` (`renderText` emits empty `<tspan>` for blank lines).
- **Proposed fix**:
  1. In `renderLabel` (`src/render/svg.ts:97-105`), inspect the component's world-space pin sides; if any pin lies on the top edge (`wp.pos.y === minY`), place the label below the body (`maxY + 14`) if the bottom is clear, or offset to the top-left corner away from top pin X coordinates.
  2. In `renderText` (`src/render/svg.ts:123-126`), render a non-breaking space (`&#160;`) inside empty lines (`l === "" ? "&#160;" : escapeXml(l)`) and add `xml:space="preserve"` so blank lines and indented truth tables survive in browsers and Inkscape.
- **Confidence**: high

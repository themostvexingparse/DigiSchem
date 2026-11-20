# DigiSchem — architecture & module ownership

Desktop digital-logic schematic editor: Tauri v2 (Rust shell) + TypeScript/Vite frontend, rendered as SVG.

## Commands
- `npm run dev` — browser-only dev server (http://localhost:1420), file dialogs fall back to download/upload
- `npm run tauri dev` — desktop app in dev mode
- `npm run tauri build` — release exe + installers (`src-tauri/target/release/`)
- `npx tsc --noEmit` — typecheck (must pass) · `npm test` — vitest (must pass)

## Frozen core contracts (DO NOT EDIT without coordination)
| File | Purpose |
|---|---|
| `src/model/types.ts` | Document model: components, wires (orthogonal polylines, **geometric connectivity**), text notes |
| `src/model/component-def.ts` | `ComponentDef` interface, `PinDef`, `PropDef`, `GRID = 10`, CSS class conventions |
| `src/model/registry.ts` | `registerComponent / getDef / listDefs`, palette category order |
| `src/model/geometry.ts` | local→world transforms, pin positions, bounds, hit helpers, junctions |
| `src/model/store.ts` | `DocumentStore`: `update(label, mutator)`, gestures, undo/redo, selection |
| `src/render/svg.ts` | **The one renderer** used by both the canvas and exports. Themes + CSS |
| `src/platform/files.ts` | native save/open dialogs (Tauri) with browser fallback |

## Design principle: everything parametric
Every component's pins are derived from its props in `geometry(props)`. Changing a prop
(MUX select bits, register width, register-file address bits / read ports, decoder inputs,
gate inputs, counter bits...) must add/remove **real, individually connectable pins**, and
`symbol(props)` must draw them. Pin ids must be deterministic from props (e.g. `s0..s{n-1}`,
`d0..d{n-1}`) so they are stable across edits. Bus-mode options (single bus pin of width N vs.
N individual 1-bit pins) are encouraged where it makes sense (`width` on PinDef).

## Coordinate rules
- Local origin (0,0) = top-left of the component's bounding box, unrotated.
- All pin coordinates are multiples of `GRID` (10). Pins sit at the tip of their stub.
- Rotation is clockwise about the local origin; mirror flips about x = width/2 before rotation.

## Module ownership (one owner per directory)
| Area | Directory | Owner |
|---|---|---|
| Component library | `src/components/library/*` | components agent |
| Interactive editor + palette + properties panel | `src/editor/*`, `src/ui/*` | editor agent |
| Project files, SVG/PNG export | `src/io/*`, `tests/io*.test.ts` | io agent |
| App shell, toolbar, Tauri/Rust | `src/main.ts`, `src/app/*`, `src/styles.css`, `src-tauri/*` | lead |

Public APIs of stub modules (`Editor`, `mountPalette`, `mountProperties`, `serializeProject`,
`parseProject`, `exportSvgString`, `exportPngBlob`) are fixed — implement them, keep signatures.

## Resizing (contract)
`ComponentInstance.size?: {w,h}` = user-requested body size in LOCAL units (multiples of GRID).
Defs opt in with `resizable: "both" | "width" | "height"`. `effectiveProps(inst)` (geometry.ts) passes
the request to `geometry()/symbol()` as props `_w` / `_h` (constants `SIZE_W` / `SIZE_H`). Treat them as
minimums; spread pins over the larger body; keep pins on grid and pin ids unchanged.
**Never merge `{...def.defaultProps, ...inst.props}` by hand — always call `effectiveProps(inst)`.**

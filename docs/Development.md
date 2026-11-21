# Development

DigiSchem is a [Tauri v2](https://v2.tauri.app/) app: a thin Rust shell around a TypeScript
frontend built with [Vite](https://vite.dev/). The schematic is drawn as SVG. There is no UI
framework.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The editor in a browser at <http://localhost:1420> |
| `npm run tauri dev` | The desktop app in development mode |
| `npm run tauri build` | Release executable and installers in `src-tauri/target/release/` |
| `npx tsc --noEmit` | Type check (must pass) |
| `npm test` | The test suite, with [Vitest](https://vitest.dev/) (must pass) |
| `npm run dspec:build` | Bundles the DSpec command-line compiler into `dist-cli/dspec.js` |

## Project structure

| Directory | Contents |
|---|---|
| `src/model/` | The document model (`types.ts`), component definitions and registry, geometry (pin positions, bounds, transforms), stored connections (`links.ts`), the `DocumentStore` with undo and redo, settings |
| `src/components/library/` | The 80 components, one file per family (gates, plexers, arithmetic, registers, memory, ...) |
| `src/editor/` | The interactive editor: tools, selection, dragging, wiring, resizing, guides, the router (`safe-route.ts`) |
| `src/layout/` | Compaction: the packer (`pack.ts`), its quality score (`quality.ts`), 1-D compaction, validation, realignment, wire relaxation (`relax-wires.ts`); runs in a web worker |
| `src/spec/` | The DSpec language: parser, resolver, placement, routing, compiler, decompiler, reference and guide; runs in a web worker in the app |
| `src/logic/` | Boolean minimization, two-level schematic generation, combinational evaluation |
| `src/io/` | Project files (`project.ts`), netlists, SVG and PNG export |
| `src/render/` | The one SVG renderer, used by both the canvas and the exports, with its themes |
| `src/app/`, `src/ui/` | The app shell: toolbar, commands, dialogs, the Code dialog, palette, properties panel |
| `src/platform/` | Native file dialogs, with a browser fallback |
| `src-tauri/` | The Rust shell and Tauri configuration |
| `scripts/` | The DSpec command line (`dspec.ts`), the Windows build script, sample generators |
| `examples/` | Example DSpec files |
| `samples/compaction/` | Test schematics for Compact layout, with what each one checks |
| `tests/` | The test suite |

## Architecture rules

[ARCHITECTURE.md](../ARCHITECTURE.md) is the contract between modules. The main rules:

- **Everything parametric.** A component's pins come from its properties through
  `geometry(props)`, and `symbol(props)` draws them. Changing a property adds or removes real
  pins, with ids that follow from the properties (`d0..d{n-1}`, `s0..s{n-1}`) so they are stable.
- **Coordinates.** A part's local origin is the top-left of its unrotated bounding box. Every pin
  is on the 10-unit grid, at the tip of its stub. Rotation is clockwise about the origin; mirror
  flips before rotating.
- **One renderer.** `src/render/svg.ts` draws both the canvas and the exports.
- **Changes go through the store.** `DocumentStore.update(label, mutator)` makes every edit one
  undoable step and keeps the stored connections up to date.
- **Effective properties.** Always read a part's properties through `effectiveProps(inst)`; it
  merges defaults and the requested size.

## Adding a component

1. Pick the family file in `src/components/library/` (or add one and register it in `index.ts`).
2. Define the component: its `type`, name, category, description, properties with ranges or
   options, `geometry(props)` returning the size and pins, and `symbol(props)` drawing it.
3. Run the tests: `tests/components.test.ts` checks every registered component (size and pins on
   the grid, unique pin ids, and more), and `tests/components.resize.test.ts` checks that the pins
   on each side stay evenly spaced at several sizes.

The new component then appears in the palette, in DSpec, and in `dspec reference`.

## Tests

The suite has about 580 tests:

| Area | Files |
|---|---|
| Model, components, resizing | `core`, `components*`, `model.merge` |
| Editor, routing, connectivity | `editor*` |
| Files, export, netlist | `io*`, `fuzz.project` |
| Layout | `layout.pack`, `layout.quality`, `layout.realign`, `layout.beam`, `layout.relax` |
| DSpec | `spec` (including a fuzzer) |
| Logic tools | `logic.minimize` |
| Store | `fuzz.store` |
| Regressions | `audit.regressions`, `hunt.regressions` |

Files named `tests/_scratch*` are ignored by git; use them for experiments.

[AUDIT.md](AUDIT.md) is an earlier correctness audit of the code base; the findings that were
confirmed are fixed and covered by `tests/audit.regressions.test.ts`.

## Contributing

1. Keep `npx tsc --noEmit` and `npm test` passing.
2. Add a test for every bug fix and every new behaviour.
3. Write user-visible text plainly.

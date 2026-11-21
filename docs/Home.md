# DigiSchem

DigiSchem is a desktop editor for digital logic schematics, with **DSpec**, a text language for
writing them as code. These pages describe how to use it and how it works.

![A 4-bit ripple-carry adder compiled from DSpec](images/adder4.svg)

## Using DigiSchem

- **[Getting Started](Getting-Started.md)**: install, run in a browser or as a desktop app, build a release.
- **[Using the Editor](Using-the-Editor.md)**: placing parts, wiring, selecting and editing, the
  properties panel, connection checks, settings and every keyboard shortcut.
- **[Components](Components.md)**: the 80 parts in the library and how their pins follow their properties.
- **[DSpec Language](DSpec-Language.md)**: write a circuit as text and let the compiler draw it;
  directives, the command line, and working with language models.
- **[File Format](File-Format.md)**: what a `.dschem` file contains, and the SVG, PNG and netlist exports.

## How it works

- **[Layout and Routing](Layout-and-Routing.md)**: the router's cost model, layout compaction, and
  the wire tidying pass (tension, repulsion and bundles).
- **[Logic Tools](Logic-Tools.md)**: the boolean minimizer, the two-level schematic generator and
  the truth-table evaluator, with their TypeScript APIs.
- **[Development](Development.md)**: project structure, architecture rules, tests and how to contribute.

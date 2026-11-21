# Getting Started

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer, with npm.
- For the desktop app: [Rust](https://www.rust-lang.org/tools/install) and the
  [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

## Run in a browser

```sh
npm install
npm run dev
```

Open <http://localhost:1420>. Everything works in the browser except native file dialogs:
**Open** uses a file picker, and **Save** and **Export** download the file.

## Run as a desktop app

```sh
npm run tauri dev
```

This starts the same editor in a native window, with native open and save dialogs.

## Build a release

```sh
npm run tauri build                # installers and the exe in src-tauri/target/release/
npx tauri build --no-bundle        # only the executable
```

On Windows, `scripts/build-desktop.ps1` builds the app and copies a portable version to
`builds/<date>-<commit>/` and `builds/latest/`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1             # portable exe
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -Installers # plus MSI and setup.exe
```

Build from PowerShell rather than Git Bash: Git Bash's `link` command can hide the Windows
linker.

### Windows without the Visual C++ build tools

Tauri normally uses the MSVC toolchain, which links Microsoft's WebView2 loader into the
executable, so `digischem.exe` runs on its own. Without Visual Studio's "Desktop development with
C++" workload, the app can be built with Rust's GNU toolchain (MSYS2 mingw64) instead. A GNU
build cannot link the loader in: the executable imports `WebView2Loader.dll`, which must sit next
to it. The build script copies it when it is there, and the installers include it.

## Releases

Releases are built on GitHub with MSVC by `.github/workflows/release.yml`, so the published
`DigiSchem.exe` is a single file. The workflow checks that the exe imports no
`WebView2Loader.dll` before publishing anything.

- **Actions > Release > Run workflow** builds the exe and the installers and attaches them to the
  run as an artifact.
- Pushing a tag such as `v0.2.0` also creates a **draft** release with those files. Review it on
  the Releases page and publish it.

The exe needs the Microsoft Edge WebView2 runtime, which is part of Windows 10 and 11.

## First steps

1. Pick a part from the palette on the left and click on the canvas to place it.
2. Drag from a pin to another pin to draw a wire.
3. Press **?** for the list of keyboard shortcuts.
4. Press **Ctrl+K** to open the code editor. The template there is a half adder; press
   **Ctrl+Enter** to build it.
5. Save with **Ctrl+S** (a `.dschem` file), or export a picture with **Ctrl+E** (SVG) or
   **Ctrl+Shift+E** (PNG).

## Command-line compiler

The DSpec compiler also runs without the editor:

```sh
npm run dspec:build                                   # bundles dist-cli/dspec.js
node dist-cli/dspec.js compile examples/adder4.dspec -o adder4.dschem --svg adder4.svg
```

See [DSpec Language](DSpec-Language.md#command-line) for every command.

## Tests

```sh
npx tsc --noEmit    # type check
npm test            # the test suite (vitest)
```

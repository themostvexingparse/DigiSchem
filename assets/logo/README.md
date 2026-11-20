# DigiSchem logo

Concept: an oscilloscope screen showing the initials — an AND gate drawn as the **D**, and a
sine trace drawn vertically as the **S** — over a faint scope graticule.

Colors: `#2463d1` (accent blue background / trace in UI), `#ffffff` (gate and trace on the icon),
`#cfe6ff` (trace glow), `#1d2430` (gate in the light-theme wordmark).

Files:
- `logo.svg` — master 1024×1024 app icon; all app icons in `src-tauri/icons` are generated from it
  (`npx tauri icon assets/logo/logo.svg -o src-tauri/icons`).
- `logo-mark.svg` — small toolbar mark (no graticule); the gate uses `currentColor`, the trace the accent.
- `wordmark.svg` — mark + "DigiSchem" for the About/Help screen.
- `variants/` — the design candidates (G was adopted); `variants/sheet.html` compares them.

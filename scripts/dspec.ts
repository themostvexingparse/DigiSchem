// DSpec command line (bundled to dist-cli/dspec.js by `npm run dspec:build`).
//
//   node dist-cli/dspec.js compile  in.dspec [-o out.dschem] [--svg out.svg] [--previous old.dschem] [--json] [--no-compact]
//   node dist-cli/dspec.js check    in.dspec [--json]            (diagnostics only, no compaction)
//   node dist-cli/dspec.js decompile in.dschem [-o out.dspec]
//   node dist-cli/dspec.js reference [--json]
//   node dist-cli/dspec.js render   in.dschem [-o out.svg]
//
// Exit code: 0 ok, 1 compile errors, 2 usage or file errors.
import { readFileSync, writeFileSync } from "node:fs";
import { compileSpec } from "../src/spec/compile";
import { decompileDoc } from "../src/spec/decompile";
import { catalog, referenceText } from "../src/spec/reference";
import { parseProject, serializeProject } from "../src/io/project";
import { renderDocumentSvg } from "../src/render/svg";
import { registerBuiltinComponents } from "../src/components/library";

registerBuiltinComponents();

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("-") && !["-o", "--svg", "--previous"].includes(all[i - 1] ?? ""));

function usage(): never {
  process.stderr.write(
    "usage:\n  dspec compile <in.dspec> [-o out.dschem] [--svg out.svg] [--previous old.dschem] [--json] [--no-compact]\n" +
      "  dspec check <in.dspec> [--json]\n  dspec decompile <in.dschem> [-o out.dspec]\n  dspec reference [--json]\n",
  );
  process.exit(2);
}

function read(path: string | undefined): string {
  if (!path) usage();
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    process.stderr.write(`cannot read ${path}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

if (cmd === "reference") {
  process.stdout.write(flag("--json") ? JSON.stringify(catalog(), null, 1) + "\n" : referenceText());
} else if (cmd === "render") {
  const o = opt("-o");
  const svg = renderDocumentSvg(parseProject(read(positional[0])));
  if (o) writeFileSync(o, svg);
  else process.stdout.write(svg);
} else if (cmd === "decompile") {
  const text = decompileDoc(parseProject(read(positional[0])));
  const o = opt("-o");
  if (o) writeFileSync(o, text);
  else process.stdout.write(text);
} else if (cmd === "compile" || cmd === "check") {
  const file = positional[0];
  let src = read(file);
  if (cmd === "check" || flag("--no-compact")) src = "@compact never\n" + src.replace(/^\s*@compact\b.*$/gm, "");
  const prevPath = opt("--previous");
  const previous = prevPath ? parseProject(read(prevPath)) : null;
  const r = compileSpec(src, { previous });
  const shift = cmd === "check" || flag("--no-compact") ? 1 : 0; // the injected first line
  const diags = r.diagnostics.map((d) => ({ ...d, line: Math.max(1, d.line - shift) }));
  if (flag("--json")) {
    process.stdout.write(JSON.stringify({ ok: !!r.doc, diagnostics: diags, stats: r.stats }, null, 1) + "\n");
  } else {
    for (const d of diags) process.stderr.write(`${file}:${d.line}:${d.col}: ${d.severity}: ${d.message}\n`);
    if (r.doc) process.stderr.write(`ok: ${r.stats.parts} parts, ${r.stats.nets} nets, ${r.stats.wires} wires, ${r.stats.tunnels} tunnels, ${r.stats.compactionsApplied}/${r.stats.compactions} compactions applied, ${r.stats.ms.total} ms\n`);
  }
  if (r.doc && cmd === "compile") {
    const o = opt("-o");
    if (o) writeFileSync(o, serializeProject(r.doc));
    const svg = opt("--svg");
    if (svg) writeFileSync(svg, renderDocumentSvg(r.doc));
  }
  process.exit(r.doc ? 0 : 1);
} else usage();

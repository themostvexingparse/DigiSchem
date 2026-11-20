import { describe, expect, it } from "vitest";
import { registerBuiltinComponents } from "../src/components/library";
import { emptyDocument, type SchematicDocument } from "../src/model/types";
import { DARK_THEME, LIGHT_THEME, PRINT_THEME } from "../src/render/svg";
import {
  MAX_RASTER_PIXELS,
  MAX_RASTER_SIDE,
  computeRasterDimensions,
  copyPngToClipboard,
  exportJpegBlob,
  exportPngBlob,
  exportSelectionSvg,
  exportSvgString,
  parseSvgDimensions,
} from "../src/io/export";

registerBuiltinComponents();

/**
 * Minimal well-formedness & balanced-tag XML/SVG validator for tests.
 * Verifies:
 *  - Optional XML declaration `<?xml ...?>`
 *  - Balanced opening/closing tag stack & single root `<svg>` element
 *  - Properly quoted attributes with no raw `<` or unescaped `&`
 *  - No raw `<`, `>`, or unescaped `&` in text nodes
 */
function assertWellFormedSvg(xml: string): void {
  const s = xml.trim();
  let i = 0;

  if (s.startsWith("<?")) {
    const end = s.indexOf("?>");
    expect(end).toBeGreaterThan(2);
    i = end + 2;
  }

  const stack: string[] = [];
  let rootCount = 0;

  const checkEntities = (text: string) => {
    // Every '&' must start a valid XML entity reference
    const badAmp = text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, "");
    expect(badAmp).not.toContain("&");
  };

  while (i < s.length) {
    if (s[i] === "<") {
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4);
        expect(end).toBeGreaterThan(-1);
        i = end + 3;
        continue;
      }
      const close = s.indexOf(">", i + 1);
      expect(close).toBeGreaterThan(i);
      const rawTag = s.slice(i + 1, close).trim();

      if (rawTag.startsWith("/")) {
        const name = rawTag.slice(1).trim();
        expect(stack.length).toBeGreaterThan(0);
        const top = stack.pop();
        expect(top).toBe(name);
      } else {
        const selfClosing = rawTag.endsWith("/");
        const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
        const nameMatch = body.match(/^([A-Za-z_][\w:.-]*)/);
        expect(nameMatch).not.toBeNull();
        const tagName = nameMatch![1];

        // Validate attributes are well-quoted and free of unescaped '<' or '&'
        const attrStr = body.slice(tagName.length).trim();
        if (attrStr.length > 0) {
          const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
          let matchedLen = 0;
          let m: RegExpExecArray | null;
          while ((m = attrRe.exec(attrStr)) !== null) {
            expect(m[2]).not.toContain("<");
            checkEntities(m[2]);
            matchedLen += m[0].length;
          }
          // Removing valid attributes should leave only whitespace
          const leftover = attrStr.replace(attrRe, "").trim();
          expect(leftover).toBe("");
          expect(matchedLen).toBeGreaterThan(0);
        }

        if (stack.length === 0) {
          rootCount += 1;
          expect(tagName).toBe("svg");
        }
        if (!selfClosing) {
          stack.push(tagName);
        }
      }
      i = close + 1;
    } else {
      const nextLt = s.indexOf("<", i);
      const text = nextLt === -1 ? s.slice(i) : s.slice(i, nextLt);
      expect(text).not.toContain(">");
      checkEntities(text);
      i = nextLt === -1 ? s.length : nextLt;
    }
  }

  expect(rootCount).toBe(1);
  expect(stack).toEqual([]);
}

function sampleDoc(): SchematicDocument {
  const doc = emptyDocument("ALU Stage");
  doc.meta = {
    author: "Jane Doe",
    course: "CS 152",
    lab: "Lab 2",
    date: "2026-10-15",
  };
  doc.components.push(
    { id: "c1", type: "and", x: 20, y: 20, rotation: 0, props: { inputs: 2 }, label: "U1" },
    { id: "c2", type: "not", x: 140, y: 30, rotation: 0, props: {}, label: "U2" },
  );
  doc.wires.push({
    id: "w1",
    points: [
      { x: 100, y: 50 },
      { x: 140, y: 50 },
    ],
  });
  doc.texts.push({ id: "t1", x: 20, y: 110, text: "Output stage" });
  return doc;
}

describe("io/export", () => {
  it("exports well-formed SVG across themes and options", () => {
    const doc = sampleDoc();

    const lightSvg = exportSvgString(doc, { theme: LIGHT_THEME });
    assertWellFormedSvg(lightSvg);
    expect(lightSvg).toContain("U1");
    expect(lightSvg).toContain("U2");

    const printSvg = exportSvgString(doc, { theme: PRINT_THEME, grid: true });
    assertWellFormedSvg(printSvg);
    expect(printSvg).toContain('id="ds-grid"');

    const transparentDark = exportSvgString(doc, { theme: DARK_THEME, background: false });
    assertWellFormedSvg(transparentDark);
    expect(transparentDark).not.toContain(`fill="${DARK_THEME.background}"`);
  });

  it("renders title block footer and escapes XML special characters", () => {
    const doc = emptyDocument(`A & B <Mux> "Test" '1'`);
    doc.meta = {
      author: `O'Brien & <Co>`,
      course: `EE "301" & Lab`,
      lab: `Lab <4>`,
      date: `2026-11-20`,
    };
    doc.components.push({
      id: "g1",
      type: "and",
      x: 0,
      y: 0,
      rotation: 0,
      props: { inputs: 2 },
      label: "G1",
    });

    const svgNoTb = exportSvgString(doc);
    const svgWithTb = exportSvgString(doc, { titleBlock: true });

    assertWellFormedSvg(svgNoTb);
    assertWellFormedSvg(svgWithTb);

    expect(svgWithTb).toContain('class="ds-title-block"');
    expect(svgWithTb).toContain("A &amp; B &lt;Mux&gt; &quot;Test&quot; &#39;1&#39;");
    expect(svgWithTb).toContain("Author: O&#39;Brien &amp; &lt;Co&gt;");
    expect(svgWithTb).toContain("Course: EE &quot;301&quot; &amp; Lab | Lab: Lab &lt;4&gt;");
    expect(svgWithTb).toContain("2026-11-20");

    // Title block increases exported SVG height compared to no title block
    const dimNoTb = parseSvgDimensions(svgNoTb);
    const dimWithTb = parseSvgDimensions(svgWithTb);
    expect(dimWithTb.height).toBeGreaterThan(dimNoTb.height);
  });

  it("supports custom titleBlock overrides", () => {
    const doc = emptyDocument("Default Name");
    const svg = exportSvgString(doc, {
      titleBlock: {
        title: "Override Title",
        author: "Alan Turing",
        date: "2026-01-01",
      },
      background: false,
    });

    assertWellFormedSvg(svg);
    expect(svg).toContain("Override Title");
    expect(svg).toContain("Author: Alan Turing");
    expect(svg).toContain("2026-01-01");
  });

  it("exportSelectionSvg exports only the selected components, wires, and texts", () => {
    const doc = sampleDoc();
    const svg = exportSelectionSvg(doc, new Set(["c1", "t1"]));

    assertWellFormedSvg(svg);
    expect(svg).toContain('data-id="c1"');
    expect(svg).toContain('data-id="t1"');
    expect(svg).not.toContain('data-id="c2"');
    expect(svg).not.toContain('data-id="w1"');
  });

  it("computes raster dimensions honoring scale and 16384/side + ~268M px caps", () => {
    expect(computeRasterDimensions(400, 200, 2)).toEqual({ width: 800, height: 400, scale: 2 });

    // Side cap
    const wide = computeRasterDimensions(10000, 1000, 4);
    expect(wide.width).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(wide.height).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(wide.width * wide.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(wide.width).toBe(MAX_RASTER_SIDE);

    // Total pixel cap (~268M px) on large square
    const hugeSquare = computeRasterDimensions(10000, 10000, 3);
    expect(hugeSquare.width).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(hugeSquare.height).toBeLessThanOrEqual(MAX_RASTER_SIDE);
    expect(hugeSquare.width * hugeSquare.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(hugeSquare.scale).toBeLessThan(3);
  });

  it("guards raster and clipboard exports cleanly in non-DOM Node environment", async () => {
    const doc = sampleDoc();
    if (typeof document === "undefined") {
      await expect(exportPngBlob(doc)).rejects.toThrow(/browser DOM/i);
      await expect(exportJpegBlob(doc)).rejects.toThrow(/browser DOM/i);
    }
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      await expect(copyPngToClipboard(doc)).rejects.toThrow(/Clipboard/i);
    }
  });
});

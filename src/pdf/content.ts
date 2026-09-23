// Page content: wrap the original drawing as one artifact, and write the
// invisible, tagged text overlay that carries Iris's words (spec §7.2).
import * as mupdf from "mupdf";
import type { FontSet } from "./fonts.ts";
import type { Box } from "../align/words.ts";

// The page's original content streams, bracketed by /Artifact BMC q ... Q EMC.
// The streams themselves are not touched; only the page's /Contents list changes.
export function artifactStreams(doc: mupdf.PDFDocument, page: mupdf.PDFObject): mupdf.PDFObject[] {
  const contents = page.get("Contents");
  const streams: mupdf.PDFObject[] = [];
  if (contents.isArray()) contents.forEach((s) => { streams.push(s); });
  else if (!contents.isNull()) streams.push(contents);
  if (!streams.length) return [];
  return [doc.addStream("/Artifact BMC q\n", {}), ...streams, doc.addStream("\nQ EMC\n", {})];
}

// True if the page's own content paints nothing (annotations aside).
export function drawsNothing(page: mupdf.PDFPage): boolean {
  let drew = false;
  const paint = () => { drew = true; };
  const dev = new mupdf.Device({
    fillPath: paint, strokePath: paint, fillText: paint, strokeText: paint,
    fillShade: paint, fillImage: paint, fillImageMask: paint,
  });
  page.runPageContents(dev, mupdf.Matrix.identity);
  dev.close();
  return !drew;
}

const num = (n: number) => (Math.abs(n) < 1e-6 ? "0" : String(Math.round(n * 1000) / 1000));

// Text render mode 3 draws nothing, so the overlay changes no pixel.
export class Overlay {
  private ops: string[] = ["q 3 Tr"];
  text = ""; // everything written, for the text check
  private fonts: FontSet;
  private toUser: mupdf.Matrix;

  // pageTransform maps the page's user space to mupdf's top-down page space.
  constructor(fonts: FontSet, pageTransform: mupdf.Matrix) {
    this.fonts = fonts;
    this.toUser = mupdf.Matrix.invert(pageTransform);
  }

  begin(tag: string, mcid: number) {
    this.ops.push(`/${tag} <</MCID ${mcid}>> BDC`);
  }

  end() {
    this.ops.push("EMC");
  }

  // One word, stretched to fill its box. A space after it, if the HTML had
  // one, lets extractors see the word break.
  word(text: string, box: Box, baseline: number, size: number, space = true) {
    const chars = [...text], glyphs = chars.map((c) => this.fonts.glyph(c));
    this.text += chars.filter((_, k) => glyphs[k].gid).join("") + " "; // a missing glyph is reported, not checked
    const natural = glyphs.reduce((w, g) => w + g.advance, 0) * size;
    const h = natural > 0 ? Math.min(10, Math.max(0.1, (box[2] - box[0]) / natural)) : 1;
    const m = mupdf.Matrix.concat([h, 0, 0, -1, box[0], baseline], this.toUser);
    // Consecutive glyphs from the same font share one Tj.
    const runs: { font: number; hex: string }[] = [];
    for (const g of space ? [...glyphs, this.fonts.glyph(" ")] : glyphs) {
      if (runs.at(-1)?.font !== g.font) runs.push({ font: g.font, hex: "" });
      runs.at(-1)!.hex += g.gid.toString(16).padStart(4, "0");
    }
    const shows = runs.map((r) => `/${this.fonts.resourceName(r.font)} ${num(size)} Tf <${r.hex}> Tj`);
    this.ops.push(`BT ${m.map(num).join(" ")} Tm ${shows.join(" ")} ET`);
  }

  // An empty marked-content sequence, for a Figure: it names a place in the
  // reading order without drawing anything.
  empty(tag: string, mcid: number) {
    this.ops.push(`/${tag} <</MCID ${mcid}>> BDC EMC`);
  }

  toString() {
    return this.ops.join("\n") + "\nQ\n";
  }
}

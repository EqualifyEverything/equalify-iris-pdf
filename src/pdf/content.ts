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

// Pages (1-based) whose own drawing has marked-content ids, left from a tag
// tree since removed. Inside our artifact they are tagged content in an
// artifact, which PDF/UA-1 forbids (7.1). A stream that cannot be read, or
// forms nested past a depth of 32, count as marked.
export function pagesWithMcids(doc: mupdf.PDFDocument): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i), seen = new Set<number>();
    const marked = (s: mupdf.PDFObject) => {
      try {
        // An inline property list ending in BDC; not the same letters in a string.
        return /\/MCID\s+\d+[^()]*?>>\s*BDC/.test(s.readStream().asString());
      } catch {
        return true;
      }
    };
    const forms = (res: mupdf.PDFObject, depth: number): boolean => {
      let found = false;
      if (depth > 32) return true;
      if (!res.isDictionary()) return false;
      // A named property list (/Tag /Name BDC) keeps its /MCID in the resources.
      res.get("Properties").forEach((p) => { if (p.isDictionary() && !p.get("MCID").isNull()) found = true; });
      res.get("XObject").forEach((x) => {
        if (found || !x.isStream() || x.get("Subtype").asName() !== "Form") return;
        if (x.isIndirect()) {
          if (seen.has(x.asIndirect())) return;
          seen.add(x.asIndirect());
        }
        found = marked(x) || forms(x.get("Resources"), depth + 1);
      });
      return found;
    };
    const contents = page.get("Contents"), streams: mupdf.PDFObject[] = [];
    if (contents.isArray()) contents.forEach((s) => { if (s.isStream()) streams.push(s); });
    else if (contents.isStream()) streams.push(contents);
    if (streams.some(marked) || forms(page.getInheritable("Resources"), 0)) out.push(i + 1);
  }
  return out;
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
    // A character no font has is reported, and left out: a .notdef glyph has no Unicode (PDF/UA-1 7.21.7).
    const chars = [...text].filter((c) => this.fonts.glyph(c).gid), glyphs = chars.map((c) => this.fonts.glyph(c));
    if (!chars.length) return;
    this.text += chars.join("") + " ";
    const unit = glyphs.reduce((w, g) => w + g.advance, 0), wide = box[2] - box[0];
    // Squeezed to under half its width, extractors merge a word's repeated letters. Shrink the text instead.
    if (unit * size > 0 && wide / (unit * size) < 0.5) size = Math.max(0.5, (2 * wide) / unit);
    const h = unit * size > 0 ? Math.min(10, Math.max(0.1, wide / (unit * size))) : 1;
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

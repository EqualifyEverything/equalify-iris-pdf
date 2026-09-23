// Fonts for the invisible overlay. Each is embedded as a subset with a
// /ToUnicode map, so the text it carries can be extracted exactly.
import * as mupdf from "mupdf";

// mupdf's built-in fonts. Helvetica (Nimbus Sans) covers Latin, Greek and
// Cyrillic; the CJK fallback covers Chinese, Japanese and Korean.
const FALLBACKS = ["Helvetica", "zh-Hans"];

export type Glyph = { font: number; gid: number; advance: number };

export class FontSet {
  fonts: mupdf.Font[] = FALLBACKS.map((name) => new mupdf.Font(name));
  used = new Set<number>();
  missing = new Set<string>();

  glyph(c: string): Glyph {
    for (let i = 0; i < this.fonts.length; i++) {
      const gid = this.fonts[i].encodeCharacter(c);
      if (gid) {
        this.used.add(i);
        return { font: i, gid, advance: this.fonts[i].advanceGlyph(gid) };
      }
    }
    this.missing.add(c);
    return { font: 0, gid: 0, advance: 0.5 };
  }

  resourceName(font: number) {
    return `IrisF${font}`;
  }

  // Subsetting in a scratch document keeps mupdf's subsetter away from the
  // source's own fonts. Glyph ids are kept, so the overlay's codes still hold.
  embed(doc: mupdf.PDFDocument, streams: string[]): Record<string, mupdf.PDFObject> {
    const tmp = new mupdf.PDFDocument();
    const refs: Record<string, mupdf.PDFObject> = {};
    for (const i of this.used) refs[this.resourceName(i)] = tmp.addFont(this.fonts[i]);
    for (const s of streams) tmp.insertPage(-1, tmp.addPage([0, 0, 1, 1], 0, { Font: refs }, s));
    tmp.subsetFonts();
    const out: Record<string, mupdf.PDFObject> = {};
    const graft = doc.newGraftMap();
    for (const [name, ref] of Object.entries(refs)) out[name] = graft.graftObject(ref);
    return out;
  }
}

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

  // Advance of a string at size 1.
  width(text: string) {
    return [...text].reduce((w, c) => w + this.glyph(c).advance, 0);
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
    // Codes are glyph ids. PDF/UA-1 (7.21.3.2) wants a TrueType CIDFont to say so.
    for (const ref of Object.values(refs)) {
      const cid = ref.get("DescendantFonts").get(0);
      if (cid.get("Subtype").asName() === "CIDFontType2" && cid.get("CIDToGIDMap").isNull()) cid.put("CIDToGIDMap", tmp.newName("Identity"));
    }
    const out: Record<string, mupdf.PDFObject> = {};
    const graft = doc.newGraftMap();
    for (const [name, ref] of Object.entries(refs)) out[name] = graft.graftObject(ref);
    return out;
  }
}

// A font descriptor's /CharSet or /CIDSet must list every glyph its program has
// (PDF/UA-1 7.21.4.2), and producers often get them wrong. Both are optional and
// do not change rendering, so they are dropped, unless the file claims PDF/A-1, which requires them.
export function dropGlyphSets(doc: mupdf.PDFDocument) {
  const xmp = doc.getTrailer().get("Root", "Metadata");
  if (xmp.isStream() && /pdfaid:part(>\s*|=["']\s*)1\b/.test(xmp.readStream().asString())) return;
  for (let n = 1; n < doc.countObjects(); n++) {
    const d = doc.newIndirect(n);
    if (d.isDictionary() && d.get("Type").isName() && d.get("Type").asName() === "FontDescriptor") d.delete("CharSet"), d.delete("CIDSet");
  }
}

// Base names of embedded CIDFontType2 fonts whose /W widths disagree with their
// program's advances by more than a unit (PDF/UA-1 7.21.5). Only /W entries are
// compared; with no /W at all, every glyph is /DW wide, so a program with other
// advances among its first 256 glyphs counts. Simple fonts are not checked.
export function widthMismatches(doc: mupdf.PDFDocument): string[] {
  const out = new Set<string>();
  for (let n = 1; n < doc.countObjects(); n++) {
    const f = doc.newIndirect(n);
    if (!f.isDictionary() || !f.get("Subtype").isName() || f.get("Subtype").asName() !== "CIDFontType2") continue;
    const file = f.get("FontDescriptor", "FontFile2");
    if (!file.isStream()) continue;
    let font: mupdf.Font;
    try {
      font = new mupdf.Font("check", file.readStream());
    } catch {
      continue;
    }
    const map = f.get("CIDToGIDMap"), bytes = map.isStream() ? map.readStream().asUint8Array() : null;
    const gid = (cid: number) => (bytes ? ((bytes[2 * cid] ?? 0) << 8) | (bytes[2 * cid + 1] ?? 0) : cid);
    const off = (cid: number, w: number) => Math.abs(font.advanceGlyph(gid(cid), 0) * 1000 - w) > 1;
    const w = f.get("W"), dw = f.get("DW").isNumber() ? f.get("DW").asNumber() : 1000;
    let bad = false;
    if (!w.isArray()) for (let g = 1; g < 256 && !bad; g++) bad = font.advanceGlyph(g, 0) > 0 && Math.abs(font.advanceGlyph(g, 0) * 1000 - dw) > 1;
    for (let i = 0; w.isArray() && i + 1 < w.length && !bad; ) {
      const first = w.get(i).asNumber(), next = w.get(i + 1);
      if (next.isArray()) {
        for (let k = 0; k < next.length && !bad; k++) bad = off(first + k, next.get(k).asNumber());
        i += 2;
      } else {
        for (let c = first; c <= Math.min(next.asNumber(), first + 0xffff) && !bad; c++) bad = off(c, w.get(i + 2).asNumber());
        i += 3;
      }
    }
    if (bad) out.add(f.get("BaseFont").asName() || "(unnamed)");
  }
  return [...out];
}

// Base names of the source's fonts with no embedded program (PDF/UA-1 7.21.4.1).
// Looks in every page, form XObject, tiling pattern and annotation appearance. Nesting past a depth of 32 is not checked, and counts as unembedded.
export function unembeddedFonts(doc: mupdf.PDFDocument): string[] {
  const out = new Set<string>(), seen = new Set<number>(), dr = doc.getTrailer().get("Root", "AcroForm", "DR");
  const once = (o: mupdf.PDFObject) => {
    if (!o.isIndirect()) return true;
    if (seen.has(o.asIndirect())) return false;
    seen.add(o.asIndirect());
    return true;
  };
  const resources = (res: mupdf.PDFObject, depth: number) => {
    if (depth > 32) return void out.add("(nested too deeply to check)");
    if (!res.isDictionary() || !once(res)) return;
    res.get("Font").forEach((f) => { if (f.isDictionary() && once(f)) font(f, depth); });
    res.get("XObject").forEach((x) => { if (x.isStream() && x.get("Subtype").asName() === "Form" && once(x)) resources(x.get("Resources"), depth + 1); });
    res.get("Pattern").forEach((p) => { if (p.isStream() && once(p)) resources(p.get("Resources"), depth + 1); }); // tiling patterns draw too
  };
  const font = (f: mupdf.PDFObject, depth: number) => {
    const type = f.get("Subtype").asName();
    if (type === "Type3") return resources(f.get("Resources"), depth + 1);
    const kids = f.get("DescendantFonts");
    const base = type !== "Type0" ? f : kids.isArray() ? kids.get(0) : kids;
    const d = base.isDictionary() ? base.get("FontDescriptor") : base;
    if (!d.isDictionary() || !["FontFile", "FontFile2", "FontFile3"].some((k) => d.get(k).isStream())) out.add(f.get("BaseFont").asName() || "(unnamed)");
  };
  // /AP holds /N, /R, /D, each a stream or a dictionary of streams: two levels.
  const appearance = (ap: mupdf.PDFObject, depth = 0) => {
    // An appearance with no resources of its own takes the form's (/DR).
    if (ap.isStream()) return resources(ap.get("Resources").isDictionary() ? ap.get("Resources") : dr, 0);
    if (ap.isDictionary() && depth < 2) ap.forEach((x) => appearance(x, depth + 1));
  };
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    resources(page.getInheritable("Resources"), 0);
    page.get("Annots").forEach((a) => { if (a.isDictionary()) appearance(a.get("AP")); });
  }
  return [...out];
}

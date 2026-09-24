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

// Base names of the source's fonts with no embedded program (PDF/UA-1 7.21.4.1).
// Looks in every page, form XObject and annotation appearance, to a nesting depth of 32.
export function unembeddedFonts(doc: mupdf.PDFDocument): string[] {
  const out = new Set<string>(), seen = new Set<number>();
  const once = (o: mupdf.PDFObject) => {
    if (!o.isIndirect()) return true;
    if (seen.has(o.asIndirect())) return false;
    seen.add(o.asIndirect());
    return true;
  };
  const resources = (res: mupdf.PDFObject, depth: number) => {
    if (depth > 32 || !res.isDictionary() || !once(res)) return;
    res.get("Font").forEach((f) => { if (f.isDictionary() && once(f)) font(f, depth); });
    res.get("XObject").forEach((x) => { if (x.isStream() && x.get("Subtype").asName() === "Form" && once(x)) resources(x.get("Resources"), depth + 1); });
  };
  const font = (f: mupdf.PDFObject, depth: number) => {
    const type = f.get("Subtype").asName();
    if (type === "Type3") return resources(f.get("Resources"), depth + 1);
    const kids = f.get("DescendantFonts");
    const base = type !== "Type0" ? f : kids.isArray() ? kids.get(0) : kids;
    const d = base.isDictionary() ? base.get("FontDescriptor") : base;
    if (!d.isDictionary() || !["FontFile", "FontFile2", "FontFile3"].some((k) => d.get(k).isStream())) out.add(f.get("BaseFont").asName() || "(unnamed)");
  };
  const appearance = (ap: mupdf.PDFObject) => {
    if (ap.isStream()) return resources(ap.get("Resources"), 0);
    if (ap.isDictionary()) ap.forEach(appearance);
  };
  resources(doc.getTrailer().get("Root", "AcroForm", "DR"), 0); // fonts a field appearance can name
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    resources(page.getInheritable("Resources"), 0);
    page.get("Annots").forEach((a) => { if (a.isDictionary()) appearance(a.get("AP")); });
  }
  return [...out];
}

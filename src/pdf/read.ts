// Reads a PDF tagged by this tool back the way a screen reader would: the
// structure tree, and the text of the marked content each element points at.
// Only our overlay's text is decoded (hex glyph ids through /ToUnicode).
import * as mupdf from "mupdf";
import { IrisPdfError, EXIT } from "../report.ts";

const MAX_DEPTH = 64;
const MAX_CONTENT = 32 << 20; // bytes of page content read for text; a longer stream is skipped

// gid -> text, from a Type0 font's /ToUnicode CMap. Within PDF's limits
// (9.7.6.2, 9.10.3): a CMap up to 1 MB, codes up to 4 bytes, a bfrange of 256
// codes, a destination up to 512 bytes. Anything else, and invalid code points,
// is skipped.
function toUnicode(font: mupdf.PDFObject): Map<number, string> {
  const map = new Map<number, string>();
  if (!font.isDictionary() || !font.get("ToUnicode").isStream()) return map;
  const buf = font.get("ToUnicode").readStream();
  if (buf.getLength() > 1 << 20) return map;
  const cmap = buf.asString();
  const hex = (h: string) => parseInt(h, 16);
  const valid = (u: number) => u <= 0x10ffff && (u < 0xd800 || u > 0xdfff);
  const str = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map(hex).filter(valid));
  for (const [, body] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, a, b] of body.matchAll(/<([0-9a-fA-F]{1,8})>\s*<([0-9a-fA-F]{1,1024})>/g)) map.set(hex(a), str(b));
  }
  for (const [, body] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, c] of body.matchAll(/<([0-9a-fA-F]{1,8})>\s*<([0-9a-fA-F]{1,8})>\s*<([0-9a-fA-F]{1,8})>/g)) {
      const [lo, hi, u] = [hex(a), hex(b), hex(c)];
      if (hi - lo > 255) continue;
      for (let g = lo; g <= hi; g++) if (valid(u + g - lo)) map.set(g, String.fromCodePoint(u + g - lo));
    }
  }
  return map;
}

// The text inside each marked-content id on a page, from our overlay. One
// linear pass: a BDC with no EMC must not cost a scan of the rest.
export function mcidText(page: mupdf.PDFObject): Map<number, string> {
  const fonts = page.get("Resources", "Font");
  const maps = new Map<string, Map<number, string>>();
  const out = new Map<number, string>();
  const contents = page.get("Contents");
  const streams: string[] = [];
  for (const s of contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents]) {
    const buf = s.isStream() ? s.readStream() : undefined;
    if (buf && buf.getLength() <= MAX_CONTENT) streams.push(buf.asString());
  }
  const all = streams.join("\n").slice(0, MAX_CONTENT);
  let id: number | undefined, start = 0;
  for (const m of all.matchAll(/<<\/MCID (\d+)>> BDC|\bEMC\b/g)) {
    if (m[1] !== undefined) { id = Number(m[1]); start = m.index + m[0].length; continue; }
    if (id === undefined) continue;
    const body = all.slice(start, m.index);
    let text = "";
    for (const [, font, hex] of body.matchAll(/\/(\w+) [\d.]+ Tf <([0-9a-f]*)>/g)) {
      if (!maps.has(font)) maps.set(font, toUnicode(fonts.isDictionary() ? fonts.get(font) : fonts));
      for (const g of hex.match(/.{4}/g) ?? []) text += maps.get(font)!.get(parseInt(g, 16)) ?? "�";
    }
    out.set(id, text.replace(/\s+/g, " ").trim());
    id = undefined;
  }
  return out;
}

// parts holds the element's own text and its child elements, in order.
// pages: 0-based indices of the pages its own content (text, annotations) is on.
export type Elem = {
  type: string; text: string; kids: Elem[]; parts: (string | Elem)[];
  dict: mupdf.PDFObject; objr: mupdf.PDFObject[]; pages: Set<number>;
};

// The structure tree, each element with the text of its own marked content.
// A root /K that is an array gives a root of type "". An element seen twice
// (a cycle or a shared kid) is read once; nesting past MAX_DEPTH is refused.
// Page object number -> 0-based page index.
export function pageIndex(doc: mupdf.PDFDocument): Map<number, number> {
  const index = new Map<number, number>();
  for (let i = 0; i < doc.countPages(); i++) index.set(doc.findPage(i).asIndirect(), i);
  return index;
}

export function structTree(doc: mupdf.PDFDocument): Elem {
  const index = pageIndex(doc);
  const cache = new Map<number, Map<number, string>>();
  const textOn = (pg: mupdf.PDFObject, mcid: number) => {
    if (!pg.isIndirect()) return "";
    if (!cache.has(pg.asIndirect())) cache.set(pg.asIndirect(), mcidText(pg));
    return cache.get(pg.asIndirect())!.get(mcid) ?? "";
  };
  const seen = new Set<number>();
  const visit = (e: mupdf.PDFObject, depth: number): Elem => {
    if (depth > MAX_DEPTH) throw new IrisPdfError("bad_structure", `The structure tree is nested deeper than ${MAX_DEPTH} levels.`, EXIT.badInput);
    if (e.isIndirect()) seen.add(e.asIndirect());
    const node: Elem = { type: e.get("S").asName(), text: "", kids: [], parts: [], dict: e, objr: [], pages: new Set() };
    const parts = node.parts;
    const on = (pg: mupdf.PDFObject) => {
      const i = pg.isIndirect() ? index.get(pg.asIndirect()) : undefined;
      if (i !== undefined) node.pages.add(i);
      return pg;
    };
    const k = e.get("K");
    const each = (x: mupdf.PDFObject) => {
      if (x.isInteger()) parts.push(textOn(on(e.get("Pg")), x.asNumber()));
      else if (x.get("Type").isName() && x.get("Type").asName() === "MCR") parts.push(textOn(on(x.get("Pg")), x.get("MCID").asNumber()));
      else if (x.get("Type").isName() && x.get("Type").asName() === "OBJR") {
        node.objr.push(x.get("Obj"));
        on(x.get("Pg").isNull() ? e.get("Pg") : x.get("Pg"));
      } else if (x.isDictionary() && !(x.isIndirect() && seen.has(x.asIndirect()))) {
        const kid = visit(x, depth + 1);
        node.kids.push(kid);
        parts.push(kid);
      }
    };
    if (k.isArray()) k.forEach(each);
    else if (!k.isNull()) each(k);
    node.text = parts.filter((p) => typeof p === "string" && p).join(" ");
    return node;
  };
  const root = doc.getTrailer().get("Root", "StructTreeRoot");
  return visit(root.get("K").isDictionary() ? root.get("K") : root, 0);
}

// All text in reading order.
export function readingOrder(e: Elem): string {
  return e.parts.map((p) => (typeof p === "string" ? p : readingOrder(p))).filter(Boolean).join(" ");
}

export function find(e: Elem, type: string): Elem[] {
  return [...(e.type === type ? [e] : []), ...e.kids.flatMap((k) => find(k, type))];
}

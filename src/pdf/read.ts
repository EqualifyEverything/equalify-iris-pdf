// Reads a PDF tagged by this tool back the way a screen reader would: the
// structure tree, and the text of the marked content each element points at.
// Only our overlay's text is decoded (hex glyph ids through /ToUnicode).
import * as mupdf from "mupdf";
import { IrisPdfError, EXIT } from "../report.ts";

const MAX_DEPTH = 64;

// gid -> text, from a Type0 font's /ToUnicode CMap. A bfrange spans at most
// 256 codes and a destination at most 512 bytes (PDF 9.10.3); longer ones and
// invalid code points are skipped.
function toUnicode(font: mupdf.PDFObject): Map<number, string> {
  const map = new Map<number, string>();
  const cmap = font.get("ToUnicode").readStream().asString();
  const hex = (h: string) => parseInt(h, 16);
  const valid = (u: number) => u <= 0x10ffff && (u < 0xd800 || u > 0xdfff);
  const str = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map(hex).filter(valid));
  for (const [, body] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, a, b] of body.matchAll(/<(\w+)>\s*<(\w+)>/g)) if (b.length <= 1024) map.set(hex(a), str(b));
  }
  for (const [, body] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, c] of body.matchAll(/<(\w+)>\s*<(\w+)>\s*<(\w+)>/g)) {
      const [lo, hi, u] = [hex(a), hex(b), hex(c)];
      if (hi - lo > 255) continue;
      for (let g = lo; g <= hi; g++) if (valid(u + g - lo)) map.set(g, String.fromCodePoint(u + g - lo));
    }
  }
  return map;
}

// The text inside each marked-content id on a page, from our overlay.
export function mcidText(page: mupdf.PDFObject): Map<number, string> {
  const fonts = page.get("Resources", "Font");
  const maps = new Map<string, Map<number, string>>();
  const out = new Map<number, string>();
  const contents = page.get("Contents");
  const streams: string[] = [];
  if (contents.isArray()) contents.forEach((s) => { streams.push(s.readStream().asString()); });
  else if (!contents.isNull()) streams.push(contents.readStream().asString());
  const all = streams.join("\n");
  for (const [, id, body] of all.matchAll(/<<\/MCID (\d+)>> BDC([\s\S]*?)EMC/g)) {
    let text = "";
    for (const [, font, hex] of body.matchAll(/\/(\w+) [\d.]+ Tf <([0-9a-f]*)>/g)) {
      if (!maps.has(font)) maps.set(font, toUnicode(fonts.get(font)));
      for (const g of hex.match(/.{4}/g) ?? []) text += maps.get(font)!.get(parseInt(g, 16)) ?? "�";
    }
    out.set(Number(id), text.replace(/\s+/g, " ").trim());
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
export function structTree(doc: mupdf.PDFDocument): Elem {
  const index = new Map<number, number>();
  for (let i = 0; i < doc.countPages(); i++) index.set(doc.findPage(i).asIndirect(), i);
  const cache = new Map<number, Map<number, string>>();
  const textOn = (pg: mupdf.PDFObject, mcid: number) => {
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
      const i = index.get(pg.asIndirect());
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

// Reads a PDF tagged by this tool back the way a screen reader would: the
// structure tree, and the text of the marked content each element points at.
// Only our overlay's text is decoded (hex glyph ids through /ToUnicode).
import * as mupdf from "mupdf";

// gid -> text, from a Type0 font's /ToUnicode CMap.
function toUnicode(font: mupdf.PDFObject): Map<number, string> {
  const map = new Map<number, string>();
  const cmap = font.get("ToUnicode").readStream().asString();
  const hex = (h: string) => parseInt(h, 16);
  const str = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map(hex));
  for (const [, body] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, a, b] of body.matchAll(/<(\w+)>\s*<(\w+)>/g)) map.set(hex(a), str(b));
  }
  for (const [, body] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, c] of body.matchAll(/<(\w+)>\s*<(\w+)>\s*<(\w+)>/g)) {
      for (let g = hex(a), u = hex(c); g <= hex(b); g++, u++) map.set(g, String.fromCodePoint(u));
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
export function structTree(doc: mupdf.PDFDocument): Elem {
  const index = new Map<number, number>();
  for (let i = 0; i < doc.countPages(); i++) index.set(doc.findPage(i).asIndirect(), i);
  const cache = new Map<number, Map<number, string>>();
  const textOn = (pg: mupdf.PDFObject, mcid: number) => {
    if (!cache.has(pg.asIndirect())) cache.set(pg.asIndirect(), mcidText(pg));
    return cache.get(pg.asIndirect())!.get(mcid) ?? "";
  };
  const visit = (e: mupdf.PDFObject): Elem => {
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
      } else {
        const kid = visit(x);
        node.kids.push(kid);
        parts.push(kid);
      }
    };
    if (k.isArray()) k.forEach(each);
    else if (!k.isNull()) each(k);
    node.text = parts.filter((p) => typeof p === "string" && p).join(" ");
    return node;
  };
  return visit(doc.getTrailer().get("Root", "StructTreeRoot", "K"));
}

// All text in reading order.
export function readingOrder(e: Elem): string {
  return e.parts.map((p) => (typeof p === "string" ? p : readingOrder(p))).filter(Boolean).join(" ");
}

export function find(e: Elem, type: string): Elem[] {
  return [...(e.type === type ? [e] : []), ...e.kids.flatMap((k) => find(k, type))];
}

// The words of a page's text layer, with their boxes, in the page's own order.
import * as mupdf from "mupdf";
import { isCJK, type Box, type PageWord } from "../align/words.ts";
import type { KeyedChar } from "./shows.ts";

// Page content only: form fields and annotations are tagged by reference, not
// as text. keyed: the same characters, from keyedChars(); each word then gets
// the codes that draw it, unless one of its characters has no known code.
// Spaces are left out of the match: mupdf adds its own where a show is split.
export function textLayerWords(page: mupdf.PDFPage, keyed?: KeyedChar[]): PageWord[] {
  const words: PageWord[] = [];
  keyed = keyed?.filter((k) => !/\s/.test(k.c));
  let cur: PageWord | null = null, n = 0, same = !!keyed;
  const flush = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const stext = page.toDisplayList(false).toStructuredText("");
  const lines = fullLines(stext);
  let line = -1, at = 0;
  stext.walk({
    beginLine() {
      flush();
      line++, at = 0;
    },
    endLine: flush,
    onChar(c, origin, _font, size, quad) {
      c = fullChar(c, lines[line]?.[at++]);
      if (/\s/.test(c)) return flush();
      const k = keyed?.[n++];
      if (k && k.c !== c) same = false;
      const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
      const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const alone = isCJK(c); // a word by itself, as in splitWords
      // A change of size starts a word ("Note¹"), but not at a prime: D′′ is one word.
      if (alone || (cur && Math.abs(cur.size - size) > 0.5 && !/[′″‴⁗]/u.test(c))) flush();
      if (!cur) cur = { text: "", box, baseline: origin[1], size, codes: [] };
      cur.text += c;
      if (cur.codes && k?.key) cur.codes.push(k.key);
      else delete cur.codes;
      cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]), Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])];
      if (alone) flush();
    },
  });
  flush();
  // The two readings must agree character for character, or no code is known.
  if (!same || n !== keyed?.length) for (const w of words) delete w.codes;
  return words;
}

// mupdf.js's walk gives each character's low 16 bits only (String.fromCharCode),
// so 𝑥 (U+1D465) arrives as U+D465. Its JSON has the whole code points, line
// by line in the same order; one is used only where its low bits agree.
export function fullLines(stext: mupdf.StructuredText): string[][] {
  const blocks: { type: string; lines?: { text: string }[] }[] = JSON.parse(stext.asJSON()).blocks;
  return blocks.filter((b) => b.type === "text").flatMap((b) => (b.lines ?? []).map((l) => [...l.text]));
}

export function fullChar(c: string, full: string | undefined): string {
  const u = full?.codePointAt(0);
  return u !== undefined && u > 0xffff && (u & 0xffff) === c.charCodeAt(0) ? full! : c;
}

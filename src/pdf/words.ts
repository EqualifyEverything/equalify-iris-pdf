// The words of a page's text layer, with their boxes, in the page's own order.
import * as mupdf from "mupdf";
import { isCJK, type Box, type PageWord } from "../align/words.ts";

// Page content only: form fields and annotations are tagged by reference, not
// as text.
export function textLayerWords(page: mupdf.PDFPage): PageWord[] {
  const words: PageWord[] = [];
  let cur: PageWord | null = null;
  const flush = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  page.toDisplayList(false).toStructuredText("").walk({
    beginLine: flush,
    endLine: flush,
    onChar(c, origin, _font, size, quad) {
      if (/\s/.test(c)) return flush();
      const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
      const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const alone = isCJK(c); // a word by itself, as in splitWords
      if (alone || (cur && Math.abs(cur.size - size) > 0.5)) flush();
      if (!cur) cur = { text: "", box, baseline: origin[1], size };
      cur.text += c;
      cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]), Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])];
      if (alone) flush();
    },
  });
  flush();
  return words;
}

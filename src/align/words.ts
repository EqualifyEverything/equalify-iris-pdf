// Normalising and tokenising words, the same way for the page and the HTML,
// so they can be compared (spec §7.5 step 2).

// A box in mupdf's page space: x0, y0 top, x1, y1 bottom, in points.
export type Box = [number, number, number, number];

// A word as it sits on the page, from the text layer or from OCR.
export type PageWord = { text: string; box: Box; baseline: number; size: number };

// Chinese, Japanese and Korean are written without spaces, so each character
// is its own token.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;
export const isCJK = (c: string) => CJK.test(c);

// Lower-case, accents stripped, punctuation trimmed from the ends.
export function normalize(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

// Split text into words: on whitespace, and between CJK characters.
// Soft hyphens are dropped. space: whether whitespace follows the word.
export function splitWords(text: string): { text: string; space: boolean }[] {
  const out: { text: string; space: boolean }[] = [];
  let cur = "";
  const push = () => {
    if (cur) out.push({ text: cur, space: false });
    cur = "";
  };
  for (const c of text.replace(/\u00ad/g, "")) {
    if (/\s/.test(c)) {
      push();
      if (out.length) out[out.length - 1].space = true;
    } else if (CJK.test(c)) {
      push();
      cur = c;
      push();
    } else cur += c;
  }
  push();
  return out;
}

// A word the source broke at a line end ("per-" / "mit") is one token on the
// page side. Returns, for each token, the page words it covers.
export function joinHyphenated(words: PageWord[]): { norm: string; words: number[] }[] {
  const out: { norm: string; words: number[] }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = words[i + 1];
    const lineEnd = next && next.box[1] > w.box[3] - 1; // the next word starts on a lower line
    if (lineEnd && /\p{L}-$/u.test(w.text) && /^\p{Ll}/u.test(next.text)) {
      out.push({ norm: normalize(w.text.slice(0, -1) + next.text), words: [i, i + 1] });
      i++;
    } else out.push({ norm: normalize(w.text), words: [i] });
  }
  return out;
}

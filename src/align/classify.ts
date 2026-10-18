// What each unmatched page word means (spec §7.5, the outcomes table).
import { normalize, type PageWord } from "./words.ts";

// Page furniture: a running head, a footer, a page number. Iris strips these
// on purpose, and the original drawing of them is already an artifact.
// Anything else Iris left out is lost content, and is reported.
export function isFurniture(word: PageWord, pageHeight: number, pageNumber: number): boolean {
  const norm = normalize(word.text);
  if (!norm) return true; // bullets, rules and other punctuation
  if (norm === String(pageNumber)) return true;
  return atEdge(word, pageHeight);
}

// The page number, where a page number goes.
export function isPageNumber(word: PageWord, pageHeight: number, pageNumber: number): boolean {
  return normalize(word.text) === String(pageNumber) && atEdge(word, pageHeight);
}

const atEdge = (word: PageWord, pageHeight: number) => word.box[3] <= pageHeight * 0.1 || word.box[1] >= pageHeight * 0.9;

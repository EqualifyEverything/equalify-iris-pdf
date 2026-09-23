// Guarantee 2 (spec §10.2): every word in the input is still in the output,
// and so is every character of the overlay we added. The second part catches
// a source stream that swallows what follows it (an unclosed string, say):
// the tags would then point at text no reader can see.
import * as mupdf from "mupdf";

export type TextFailure = { page: number; missing: string[]; overlayMissing: number };

// `added` holds, per page index, the text our overlay wrote there.
export function compareText(before: mupdf.PDFDocument, after: mupdf.PDFDocument, added = new Map<number, string>()): TextFailure[] {
  const failures: TextFailure[] = [];
  for (let i = 0; i < before.countPages(); i++) {
    const now = count(words(after, i));
    const missing = take(now, words(before, i));
    // What is left is ours. Compared by character: words with no space between them merge.
    const spare = count([...now].flatMap(([w, n]) => [...w.repeat(n)]));
    const overlayMissing = take(spare, [...(added.get(i) ?? "").replace(/\s/g, "")]).length;
    if (missing.length || overlayMissing) failures.push({ page: i + 1, missing, overlayMissing });
  }
  return failures;
}

const count = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

// Removes each of `want` from the multiset `have`; returns those it lacked.
function take(have: Map<string, number>, want: string[]): string[] {
  const missing: string[] = [];
  for (const w of want) {
    const n = have.get(w) ?? 0;
    if (n) have.set(w, n - 1);
    else missing.push(w);
  }
  return missing;
}

// Page content only, so a field's changed value does not count as lost text.
function words(doc: mupdf.PDFDocument, i: number): string[] {
  return doc.loadPage(i).toDisplayList(false).toStructuredText("").asText().split(/\s+/).filter(Boolean);
}

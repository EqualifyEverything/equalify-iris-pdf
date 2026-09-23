// Word-level alignment of Iris's text to the page's words (spec §7.5 step 3).
//
// The two orders can differ (Iris fixes column order; the PDF's operators do
// not), so we align on content: find the best-matching stretch anywhere on the
// page (a local alignment), claim it, then repeat for the HTML words left over
// on either side. Each pass is O(n·m); a budget caps the total work, so a
// page whose orders disagree badly cannot run for minutes.

const MATCH = 3, FUZZY = 1, MISMATCH = -3, GAP = -1;
export const MAX_WORDS = 4000;
const BUDGET = 50_000_000; // cells, over all passes on a page

// For each HTML token, the index of the page token it matched, or -1.
// Empty tokens (pure punctuation) never match. complete is false if the
// budget ran out; the words not yet matched stay at -1.
export function align(html: string[], page: string[], budget = BUDGET): { match: number[]; complete: boolean } {
  const scores = new Scores(html, page);
  const match = html.map(() => -1);
  const claimed = page.map((t) => !t);
  const todo: [number, number][] = [[0, html.length]];
  while (todo.length) {
    const [a, b] = todo.pop()!;
    const hs: number[] = [];
    for (let i = a; i < b; i++) if (html[i]) hs.push(i);
    const ps = page.flatMap((_, j) => (claimed[j] ? [] : [j]));
    if (!hs.length || !ps.length) continue;
    if ((budget -= hs.length * ps.length) < 0) return { match, complete: false };
    const { best, pairs } = local(hs, ps, scores);
    // A lone common word is not evidence; ask for two exact matches unless the
    // stretch is shorter than that.
    if (best < Math.min(2 * MATCH, MATCH * hs.length) || !pairs.length) continue;
    for (const [x, y] of pairs) {
      match[hs[x]] = ps[y];
      claimed[ps[y]] = true;
    }
    // Retry the gaps: before, between and after the matched words.
    const hit = pairs.map(([x]) => hs[x]);
    todo.push([a, hit[0]], [hit.at(-1)! + 1, b]);
    for (let k = 1; k < hit.length; k++) if (hit[k] > hit[k - 1] + 1) todo.push([hit[k - 1] + 1, hit[k]]);
  }
  return { match, complete: true };
}

// Scores between distinct words, filled in as the alignment asks for them.
class Scores {
  h: Int32Array; p: Int32Array; // word ids
  private words: string[] = [];
  private table: Int8Array;
  private cols: number;
  constructor(html: string[], page: string[]) {
    const ids = new Map<string, number>();
    const id = (t: string) => ids.get(t) ?? (ids.set(t, this.words.length), this.words.push(t) - 1);
    this.h = Int32Array.from(html, id);
    this.p = Int32Array.from(page, id);
    this.cols = this.words.length;
    this.table = new Int8Array(this.cols * this.cols); // 0: not yet known
  }
  get(a: number, b: number): number {
    if (a === b) return MATCH;
    const k = a * this.cols + b;
    return this.table[k] || (this.table[k] = similar(this.words[a], this.words[b]) ? FUZZY : MISMATCH);
  }
}

const similar = (a: string, b: string) => {
  const most = Math.floor(Math.max(a.length, b.length) / 4);
  return Math.min(a.length, b.length) >= 4 && Math.abs(a.length - b.length) <= most && distance(a, b, most) <= most;
};

// Smith–Waterman over html[hs[x]] and page[ps[y]]. Returns the best local
// score and its matched pairs (x, y).
function local(hs: number[], ps: number[], s: Scores): { best: number; pairs: [number, number][] } {
  const n = hs.length, m = ps.length, w = m + 1;
  const H = new Int32Array((n + 1) * w);
  const pw = Int32Array.from(ps, (j) => s.p[j]);
  const score = (x: number, y: number) => s.get(s.h[hs[x]], pw[y]);
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) {
    const up = (i - 1) * w, row = i * w;
    for (let j = 1; j <= m; j++) {
      let v = H[up + j - 1] + score(i - 1, j - 1);
      if (H[up + j] + GAP > v) v = H[up + j] + GAP;
      if (H[row + j - 1] + GAP > v) v = H[row + j - 1] + GAP;
      if (v < 0) v = 0;
      H[row + j] = v;
      if (v > best) best = v, bi = i, bj = j;
    }
  }
  const pairs: [number, number][] = [];
  for (let i = bi, j = bj; i > 0 && j > 0 && H[i * w + j] > 0; ) {
    const v = H[i * w + j], sc = score(i - 1, j - 1);
    if (v === H[(i - 1) * w + j - 1] + sc) {
      if (sc > 0) pairs.push([i - 1, j - 1]);
      i--, j--;
    } else if (v === H[(i - 1) * w + j] + GAP) i--;
    else j--;
  }
  return { best, pairs: pairs.reverse() };
}

// Levenshtein distance, or more than max as soon as that is certain.
const rows = [new Int32Array(64), new Int32Array(64)];
function distance(a: string, b: string, max: number): number {
  if (b.length >= rows[0].length) return a === b ? 0 : max + 1;
  let [prev, cur] = rows;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < low) low = cur[j];
    }
    if (low > max) return low;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

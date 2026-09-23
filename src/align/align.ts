// Word-level alignment of Iris's text to the page's words (spec §7.5 step 3).
//
// The two orders can differ (Iris fixes column order; the PDF's operators do
// not), so we align on content: find the best-matching stretch anywhere on the
// page (a local alignment), claim it, then repeat for the HTML words left over
// on either side. Each pass is O(n·m), which is cheap at page scale.

const MATCH = 3, FUZZY = 1, MISMATCH = -3, GAP = -1;

// For each HTML token, the index of the page token it matched, or -1.
// Empty tokens (pure punctuation) never match.
export function align(html: string[], page: string[]): number[] {
  const match = html.map(() => -1);
  const claimed = page.map((t) => !t);
  const todo: [number, number][] = [[0, html.length]];
  while (todo.length) {
    const [a, b] = todo.pop()!;
    const hs: number[] = [];
    for (let i = a; i < b; i++) if (html[i]) hs.push(i);
    const ps = page.flatMap((_, j) => (claimed[j] ? [] : [j]));
    if (!hs.length || !ps.length) continue;
    const { score, pairs } = local(hs.map((i) => html[i]), ps.map((j) => page[j]));
    // A lone common word is not evidence; ask for two exact matches unless the
    // stretch is shorter than that.
    if (score < Math.min(2 * MATCH, MATCH * hs.length) || !pairs.length) continue;
    for (const [x, y] of pairs) {
      match[hs[x]] = ps[y];
      claimed[ps[y]] = true;
    }
    // Retry the gaps: before, between and after the matched words.
    const hit = pairs.map(([x]) => hs[x]);
    todo.push([a, hit[0]], [hit.at(-1)! + 1, b]);
    for (let k = 1; k < hit.length; k++) if (hit[k] > hit[k - 1] + 1) todo.push([hit[k - 1] + 1, hit[k]]);
  }
  return match;
}

function score(a: string, b: string): number {
  if (a === b) return MATCH;
  if (Math.min(a.length, b.length) >= 4 && distance(a, b) <= Math.floor(Math.max(a.length, b.length) / 4)) return FUZZY;
  return MISMATCH;
}

// Smith–Waterman. Returns the best local score and its matched pairs.
function local(h: string[], p: string[]): { score: number; pairs: [number, number][] } {
  const n = h.length, m = p.length, w = m + 1;
  const H = new Float64Array((n + 1) * w);
  let best = 0, bi = 0, bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const v = Math.max(0, H[(i - 1) * w + j - 1] + score(h[i - 1], p[j - 1]), H[(i - 1) * w + j] + GAP, H[i * w + j - 1] + GAP);
      H[i * w + j] = v;
      if (v > best) [best, bi, bj] = [v, i, j];
    }
  }
  const pairs: [number, number][] = [];
  for (let i = bi, j = bj; i > 0 && j > 0 && H[i * w + j] > 0; ) {
    const v = H[i * w + j], s = score(h[i - 1], p[j - 1]);
    if (v === H[(i - 1) * w + j - 1] + s) {
      if (s > 0) pairs.push([i - 1, j - 1]);
      i--, j--;
    } else if (v === H[(i - 1) * w + j] + GAP) i--;
    else j--;
  }
  return { score: best, pairs: pairs.reverse() };
}

// Levenshtein distance.
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

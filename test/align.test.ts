import { test } from "node:test";
import assert from "node:assert/strict";
import { align } from "../src/align/align.ts";
import { isFurniture } from "../src/align/classify.ts";
import { joinHyphenated, normalize, splitWords, type PageWord } from "../src/align/words.ts";

const words = (s: string) => s.split(" ");
const matchOf = (html: string[], page: string[]) => align(html, page).match;

test("normalize ignores case, accents and edge punctuation", () => {
  assert.equal(normalize("Café,"), "cafe");
  assert.equal(normalize("(Résumé)"), "resume");
  assert.equal(normalize("—"), "");
  assert.equal(normalize("ﬁle"), "file"); // ligature
});

test("splitWords splits on spaces and between CJK characters", () => {
  assert.deepEqual(splitWords(" Hello  wor­ld "), [{ text: "Hello", space: true }, { text: "world", space: true }]);
  assert.deepEqual(splitWords("市民a b").map((w) => w.text), ["市", "民", "a", "b"]);
  assert.equal(splitWords("website").at(-1)!.space, false);
});

test("align matches words in order and skips what is missing", () => {
  assert.deepEqual(matchOf(words("a quick brown fox"), words("a quick brown fox")), [0, 1, 2, 3]);
  // The page has a header Iris dropped, and Iris has a word the page lacks.
  assert.deepEqual(matchOf(words("quick brown new fox jumps"), words("Header quick brown fox jumps")), [1, 2, -1, 3, 4]);
});

test("align follows the HTML's order when the page's differs (two columns)", () => {
  // Text order on the page interleaves the columns line by line.
  const page = words("alpha beta gamma delta epsilon zeta theta iota");
  const html = words("alpha beta epsilon zeta gamma delta theta iota");
  assert.deepEqual(matchOf(html, page), [0, 1, 4, 5, 2, 3, 6, 7]);
});

test("align stops when its work budget runs out, and stays fast when orders disagree", () => {
  const page = words("alpha beta gamma delta epsilon zeta theta iota");
  const html = words("alpha beta epsilon zeta gamma delta theta iota");
  assert.equal(align(html, page).complete, true);
  // The first pass needs 8 × 8 cells.
  assert.deepEqual(align(html, page, 63), { match: html.map(() => -1), complete: false });
  assert.equal(align(html, page, 64).complete, false, "the first pass fits, the rest do not");
  // 2000 near-alike words in reverse order: every pass finds little, which once took most of a minute.
  const many = Array.from({ length: 2000 }, (_, i) => `word${i % 700}x${i % 13}`);
  const t = Date.now();
  align([...many].reverse(), many);
  assert.ok(Date.now() - t < 10_000, `${Date.now() - t} ms`);
});

test("align tolerates OCR errors in longer words", () => {
  assert.deepEqual(matchOf(words("application received today"), words("appllcation received today")), [0, 1, 2]);
  assert.deepEqual(matchOf(words("cat"), words("cot")), [-1]); // too short to guess
});

test("joinHyphenated rejoins a word broken at a line end", () => {
  const w = (text: string, y: number): PageWord => ({ text, box: [0, y, 10, y + 10], baseline: y + 8, size: 10 });
  const joined = joinHyphenated([w("per-", 0), w("mit", 12), w("well-", 12), w("Known", 24)]);
  assert.deepEqual(joined.map((t) => t.norm), ["permit", "well", "known"]);
  assert.deepEqual(joined[0].words, [0, 1]);
});

test("furniture: page edges, bare punctuation and the page number", () => {
  const at = (text: string, y: number): PageWord => ({ text, box: [0, y, 10, y + 10], baseline: y + 8, size: 10 });
  assert.ok(isFurniture(at("Header", 10), 792, 1));
  assert.ok(isFurniture(at("3", 400), 792, 3));
  assert.ok(isFurniture(at("•", 400), 792, 1));
  assert.ok(!isFurniture(at("Body", 400), 792, 1));
});

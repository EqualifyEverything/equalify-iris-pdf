import { test } from "node:test";
import assert from "node:assert/strict";
import { align } from "../src/align/align.ts";
import { isFurniture } from "../src/align/classify.ts";
import { joinHyphenated, normalize, splitWords, type PageWord } from "../src/align/words.ts";

const words = (s: string) => s.split(" ");

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
  assert.deepEqual(align(words("a quick brown fox"), words("a quick brown fox")), [0, 1, 2, 3]);
  // The page has a header Iris dropped, and Iris has a word the page lacks.
  assert.deepEqual(align(words("quick brown new fox jumps"), words("Header quick brown fox jumps")), [1, 2, -1, 3, 4]);
});

test("align follows the HTML's order when the page's differs (two columns)", () => {
  // Text order on the page interleaves the columns line by line.
  const page = words("alpha beta gamma delta epsilon zeta theta iota");
  const html = words("alpha beta epsilon zeta gamma delta theta iota");
  assert.deepEqual(align(html, page), [0, 1, 4, 5, 2, 3, 6, 7]);
});

test("align tolerates OCR errors in longer words", () => {
  assert.deepEqual(align(words("application received today"), words("appllcation received today")), [0, 1, 2]);
  assert.deepEqual(align(words("cat"), words("cot")), [-1]); // too short to guess
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

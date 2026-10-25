import { test } from "node:test";
import assert from "node:assert/strict";
import { tag, newReport, type TagOptions, type Report } from "../src/index.ts";
import { MAX_ELEMENTS, MAX_EXCERPT, MAX_LISTED, MAX_WORD, type ElemDetail } from "../src/report.ts";
import { readFixture, pagesOf, tagFixture } from "./helpers.ts";

function detailed(name: string, opts: TagOptions = {}, pages = pagesOf(name)): Report {
  const report = newReport();
  tag(readFixture(`${name}.pdf`), pages, { ...opts, detail: true }, report);
  return report;
}
const all = (e: ElemDetail): ElemDetail[] => [e, ...(e.kids ?? []).flatMap(all)];

test("the detail is only there when asked for", () => {
  assert.equal(tagFixture("structure").report.detail, undefined);
});

test("detail: the structure tree, each page's words and checks, and timing", () => {
  const { detail, pages } = detailed("structure");
  const tree = all(detail!.structure!);
  assert.deepEqual(tree.find((e) => e.type === "H1"), { type: "H1", page: 1, text: "Permit types" });
  assert.equal(tree.find((e) => e.type === "Figure")!.alt, "Zones north and south of the river");
  assert.ok(tree.some((e) => e.type === "Link" && e.href === "https://example.org/permits" && e.text === "the city website"));
  const p = detail!.pages[0];
  assert.equal(p.matched.count, pages[0].matched);
  assert.deepEqual(p.furniture.words, ["City", "Permit", "Office", "1"]); // the running header and page number
  assert.deepEqual([p.differingPixels, p.textKept], [0, true]);
  assert.deepEqual(Object.keys(detail!.timing), ["open", "form", "read", "match", "tag", "save", "check"]);
  assert.ok(Object.values(detail!.timing).every((ms) => Number.isInteger(ms) && ms >= 0));
});

test("detail: where each created field went, and why a field is unresolved", () => {
  assert.deepEqual(detailed("form-flat").detail!.fields.created, [{ name: "name", type: "text", page: 1, box: [110, 71, 289.5, 85.5], label: "Full name" }]);
  const html = pagesOf("form-acroform").pages[0].html + `<label>Pet<input name="pet"></label>`;
  const { unresolved } = detailed("form-acroform", {}, { ...pagesOf("form-acroform"), pages: [{ sourcePage: 1, html }] }).detail!.fields;
  assert.deepEqual(unresolved.map((u) => [u.name, u.code]).sort(), [["pet", "field_not_in_pdf"], ["reset", "field_not_in_html"]]);
});

test("detail never holds a form value, filled or flattened", () => {
  const values = { "applicant.name": "Ada Zyxwvut" };
  for (const flatten of [false, true]) {
    const report = detailed("form-acroform", { values, flatten });
    assert.ok(!JSON.stringify(report).includes("Zyxwvut"), `flatten: ${flatten}`);
    if (flatten) assert.ok(all(report.detail!.structure!).some((e) => e.field === "applicant.name" && !e.text));
  }
});

test("detail is capped: word lists, excerpts and the tree", () => {
  const extra = ["x".repeat(100), ...Array.from({ length: 60 }, (_, k) => `extra${k}`)].join(" ");
  const many = Array.from({ length: MAX_ELEMENTS + 50 }, (_, k) => `<p>p${k}</p>`).join("");
  const { detail } = detailed("text-simple", {}, { ...pagesOf("text-simple"), pages: [{ sourcePage: 1, html: `<p>${extra}</p>${many}` }] });
  const added = detail!.pages[0].added;
  assert.deepEqual([added.count >= 61 + MAX_ELEMENTS, added.words.length], [true, MAX_LISTED]);
  assert.equal(added.words[0], "x".repeat(MAX_WORD - 1) + "…");
  const tree = all(detail!.structure!);
  assert.equal(tree.length, MAX_ELEMENTS);
  assert.ok(detail!.structureTruncated);
  assert.ok(tree.every((e) => (e.text ?? "").length <= MAX_EXCERPT));
  assert.ok(tree.some((e) => e.text?.endsWith("…")));
});

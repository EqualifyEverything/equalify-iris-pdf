import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { tag, newReport, type PagesInput, type TagOptions } from "../src/index.ts";
import { readFixture, pagesOf, tagFixture } from "./helpers.ts";

const simple: PagesInput = pagesOf("text-simple");

// Runs tag and returns the error code it refused with.
function refusal(pdf: Uint8Array, opts: TagOptions = {}, pages: PagesInput = simple): { code: string; exit: number } {
  try {
    tag(pdf, pages, opts);
  } catch (e) {
    return e as { code: string; exit: number };
  }
  assert.fail("tag did not refuse");
}

function blankPdf(pages: number, edit?: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, ""));
  edit?.(doc);
  return doc.saveToBuffer("").asUint8Array().slice();
}

test("refuses what it cannot safely change, each with its own code", () => {
  const cases: [string, Uint8Array, TagOptions, string, number][] = [
    ["not a PDF", new TextEncoder().encode("hello"), {}, "unreadable", 3],
    ["no password", readFixture("encrypted.pdf"), {}, "encrypted", 1],
    ["wrong password", readFixture("encrypted.pdf"), { password: "nope" }, "encrypted", 1],
    ["owner forbids edits", readFixture("restricted.pdf"), {}, "permissions_denied", 1],
    ["signed", readFixture("signed.pdf"), {}, "signed", 1],
    ["26 pages", blankPdf(26), {}, "too_many_pages", 1],
    ["value for a flat form", readFixture("form-flat.pdf"), { values: { name: "Ada" } }, "no_acroform_field", 1],
  ];
  for (const [what, pdf, opts, code, exit] of cases) {
    assert.deepEqual((({ code, exit }) => ({ code, exit }))(refusal(pdf, opts)), { code, exit }, what);
  }
});

test("opens an encrypted PDF with its password", () => {
  const { report, doc } = tagFixture("text-simple", {});
  assert.equal(report.source.encrypted, false);
  const pdf = readFixture("encrypted.pdf");
  const encrypted = newReport();
  const out = tag(pdf, simple, { password: "open" }, encrypted);
  assert.equal(encrypted.source.encrypted, true);
  const back = new mupdf.PDFDocument(out);
  assert.ok(back.needsPassword() && back.authenticatePassword("open"));
  assert.equal(back.countPages(), doc.countPages());
});

test("a damaged PDF is rewritten from its repair, checked, and keeps its encryption", () => {
  // Point startxref at the wrong place, as a bad split or truncated upload does.
  const damage = (pdf: Uint8Array) => new Uint8Array(Buffer.from(Buffer.from(pdf).toString("latin1").replace(/startxref\s+\d+\s+%%EOF\s*$/, "startxref\n9\n%%EOF\n"), "latin1"));
  const report = newReport();
  const out = tag(damage(readFixture("text-simple.pdf")), simple, {}, report);
  assert.ok(report.warnings.some((w) => w.code === "repaired"));
  assert.equal(report.verification.textPreserved, true);
  assert.equal(report.verification.differingPixels, 0);
  assert.ok(!new mupdf.PDFDocument(out).wasRepaired());
  const locked = tag(damage(readFixture("encrypted.pdf")), simple, { password: "open" });
  const back = new mupdf.PDFDocument(locked);
  assert.ok(back.needsPassword() && back.authenticatePassword("open"));
});

test("--allow-signed tags a signed PDF and says the signature is gone", () => {
  const report = newReport();
  tag(readFixture("signed.pdf"), pagesOf("form-acroform"), { allowSigned: true }, report);
  assert.ok(report.warnings.some((w) => w.code === "signature_invalidated"));
  assert.equal(report.source.signed, true);
});

test("refuses a PDF that is already tagged", () => {
  const { out } = tagFixture("text-simple");
  assert.equal(refusal(out).code, "already_tagged");
});

test("XFA: a dynamic form is refused, a hybrid form loses only its XFA", () => {
  const xfa = (needsRendering: boolean) => blankPdf(1, (doc) => {
    const root = doc.getTrailer().get("Root");
    root.put("AcroForm", doc.addObject({ Fields: [], XFA: doc.addStream("<xdp/>", {}) }));
    if (needsRendering) root.put("NeedsRendering", true);
  });
  const blank: PagesInput = { lang: "en", pages: [] };
  assert.equal(refusal(xfa(true), {}, blank).code, "xfa");
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(xfa(false), blank, {}, report));
  assert.ok(report.warnings.some((w) => w.code === "xfa_removed"));
  assert.ok(doc.getTrailer().get("Root", "AcroForm", "XFA").isNull());
});

test("bad pages.json and a missing language are bad input", () => {
  const pdf = readFixture("text-simple.pdf");
  assert.equal(refusal(pdf, {}, { lang: "en", pages: [{ sourcePage: 2, html: "" }] }).code, "bad_pages");
  assert.equal(refusal(pdf, {}, { lang: "en", pages: [{ sourcePage: 1, html: "" }, { sourcePage: 1, html: "" }] }).code, "bad_pages");
  assert.equal(refusal(pdf, {}, { lang: "en" } as PagesInput).code, "bad_pages");
  const e = refusal(pdf, {}, { pages: simple.pages });
  assert.deepEqual([e.code, e.exit], ["no_document_language", 3]);
  assert.ok(tag(pdf, { pages: simple.pages }, { lang: "en" }).length); // --lang fills it in
});

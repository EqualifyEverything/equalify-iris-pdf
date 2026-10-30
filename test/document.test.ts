import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { tag, newReport, type PagesInput, type TagOptions } from "../src/index.ts";
import { readFixture, pagesOf, tagFixture } from "./helpers.ts";

const simple: PagesInput = pagesOf("text-simple");

// Runs tag and returns the error code it refused with.
function refusal(pdf: Uint8Array, opts: TagOptions = {}, pages: PagesInput = simple): { code: string; exit: number; message: string } {
  try {
    tag(pdf, pages, opts);
  } catch (e) {
    return e as { code: string; exit: number; message: string };
  }
  assert.fail("tag did not refuse");
}

function blankPdf(pages: number, edit?: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, ""));
  edit?.(doc);
  return doc.saveToBuffer("").asUint8Array().slice();
}

// text-simple, with an owner password and these permissions.
const restrict = (permissions: number, name = "text-simple") =>
  new mupdf.PDFDocument(readFixture(`${name}.pdf`)).saveToBuffer(`encrypt=aes-256,owner-password=owner,permissions=${permissions}`).asUint8Array().slice();

test("refuses what it cannot safely change, each with its own code", () => {
  const cases: [string, Uint8Array, TagOptions, string, number][] = [
    ["not a PDF", new TextEncoder().encode("hello"), {}, "unreadable", 3],
    ["no password", readFixture("encrypted.pdf"), {}, "encrypted", 1],
    ["wrong password", readFixture("encrypted.pdf"), { password: "nope" }, "encrypted", 1],
    ["owner forbids edits and accessibility", restrict(-1833), {}, "permissions_denied", 1],
    ["signed", readFixture("signed.pdf"), {}, "signed", 1],
    ["26 pages", blankPdf(26), {}, "too_many_pages", 1],
    ["value for a field the form lacks", readFixture("form-flat.pdf"), { values: { name: "Ada" } }, "no_acroform_field", 1],
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

test("tags an owner-restricted PDF that allows extraction for accessibility, keeping its permissions", () => {
  const report = newReport();
  const back = new mupdf.PDFDocument(tag(readFixture("restricted.pdf"), simple, {}, report));
  assert.ok(report.warnings.some((w) => w.code === "owner_restricted"));
  assert.equal(report.verification.differingPixels, 0);
  assert.ok(!back.needsPassword() && !back.hasPermission("edit") && back.hasPermission("accessibility"));
  assert.ok(!back.getTrailer().get("Root", "StructTreeRoot").isNull());
});

test("under an owner's restrictions a form is filled only if allowed, never flattened, and gets no new fields", () => {
  const form = pagesOf("form-acroform"), values = { "applicant.name": "Ada" };
  assert.equal(refusal(restrict(-1321, "form-acroform"), { values }, form).code, "values_not_permitted");
  tag(restrict(-1321, "form-acroform"), form, { values: {} }); // no values is not filling
  assert.equal(refusal(restrict(-1065, "form-acroform"), { flatten: true }, form).code, "flatten_not_permitted");
  const filled = new mupdf.PDFDocument(tag(restrict(-1065, "form-acroform"), form, { values })); // filling allowed
  assert.equal(filled.loadPage(0).getWidgets().find((w) => w.getName() === "applicant.name")!.getValue(), "Ada");
  const report = newReport();
  tag(restrict(-1065, "form-flat"), pagesOf("form-flat"), {}, report);
  assert.deepEqual(report.form.created, []);
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

test("retags a PDF that is already tagged", () => {
  const first = tagFixture("text-simple");
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(first.out, simple, {}, report));
  assert.ok(report.warnings.some((w) => w.code === "retagged"));
  // Our own output gets its original content back: one overlay, not two, and the same tags.
  assert.ok(!report.warnings.some((w) => w.code === "source_marked_content"));
  assert.equal(doc.findPage(0).get("Contents").length, first.doc.findPage(0).get("Contents").length);
  assert.deepEqual(report.structure, first.report.structure);
  assert.equal(report.verification.textPreserved, true);
  assert.equal(report.verification.differingPixels, 0);
});

test("retagging a PDF with an xref stream appends an xref stream", () => {
  // A classic table there, carrying the stream's trailer, is a file macOS Preview cannot open.
  const src = new mupdf.PDFDocument(readFixture("text-simple.pdf")).saveToBuffer("compress,objstms").asUint8Array().slice();
  const lastXref = (pdf: Uint8Array) => {
    const s = Buffer.from(pdf).toString("latin1");
    const at = Number(s.slice(s.lastIndexOf("startxref") + 9).trim().split(/\s/)[0]);
    return s.startsWith("xref", at) ? "table" : "stream";
  };
  assert.equal(lastXref(src), "stream");
  const once = tag(src, simple);
  const report = newReport();
  const twice = tag(once, simple, {}, report);
  assert.ok(report.warnings.some((w) => w.code === "retagged"));
  assert.deepEqual([lastXref(once), lastXref(twice)], ["stream", "stream"]);
});

test("retagging drops a foreign tag tree and what points into it", () => {
  const pdf = blankPdf(1, (doc) => {
    const page = doc.findPage(0);
    doc.getTrailer().get("Root").put("StructTreeRoot", doc.addObject({ Type: "StructTreeRoot", K: [] }));
    page.put("StructParents", 0);
    page.put("Annots", [doc.addObject({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 10, 10], StructParent: 1 })]);
  });
  const doc = new mupdf.PDFDocument(tag(pdf, { lang: "en", pages: [] }));
  const page = doc.findPage(0);
  assert.ok(page.get("StructParents").isNull());
  assert.ok(page.get("Annots").get(0).get("StructParent").isNull());
  assert.equal(doc.getTrailer().get("Root", "StructTreeRoot", "K", "S").asName(), "Document", "a new tree");
});

test("a form XObject's old key and marked content go, so no key has two holders (#54)", () => {
  for (const tree of [true, false]) {
    const src = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
    const form = src.addStream("/Figure <</MCID 0>> BDC 0 0 1 rg 0 0 50 50 re f EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 50, 50], StructParents: 0 });
    const page = src.findPage(0);
    page.put("Contents", src.addStream(page.get("Contents").readStream().asString() + " q 1 0 0 1 200 200 cm /Fx Do Q", {}));
    page.get("Resources").put("XObject", { Fx: form });
    page.put("StructParents", 1);
    if (tree) src.getTrailer().get("Root").put("StructTreeRoot", src.addObject({ Type: "StructTreeRoot" }));
    const report = newReport();
    const doc = new mupdf.PDFDocument(tag(src.saveToBuffer("").asUint8Array().slice(), pagesOf("text-embedded"), {}, report));
    const keys: number[] = [];
    for (let n = 1; n < doc.countObjects(); n++) {
      const k = doc.newIndirect(n).get("StructParents");
      if (k.isNumber()) keys.push(k.asNumber());
    }
    assert.deepEqual(keys, [0], `tree: ${tree}`); // the page's, alone
    const fx = doc.findPage(0).get("Resources", "XObject", "Fx");
    assert.doesNotMatch(fx.readStream().asString(), /MCID|BDC/);
    assert.ok(!report.warnings.some((w) => w.code === "source_marked_content"));
    assert.equal(report.verification.differingPixels, 0);
  }
});

test("retagging rewrites link descriptions we wrote, and keeps the author's", () => {
  const html = (a: string) => ({ ...pagesOf("links"), pages: [{ sourcePage: 1, html: `<h1>Contact</h1><p>Apply online at ${a}.</p>` }] });
  const contents = (pdf: Uint8Array) => new mupdf.PDFDocument(pdf).findPage(0).get("Annots").get(0).get("Contents").asString();
  const once = tag(readFixture("links.pdf"), pagesOf("links"));
  assert.equal(contents(once), "the city website");
  assert.equal(contents(tag(once, html(`the city <a href="https://example.org/permits">website</a>`))), "website");
  const authored = new mupdf.PDFDocument(readFixture("links.pdf"));
  authored.findPage(0).get("Annots").get(0).put("Contents", authored.newString("Permits"));
  const own = tag(tag(authored.saveToBuffer("").asUint8Array().slice(), pagesOf("links")), html(`the city <a href="https://example.org/permits">website</a>`));
  assert.equal(contents(own), "Permits");
});

test("retagging a foreign tagged PDF drops its marked content, so it can claim PDF/UA", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const page = doc.findPage(0);
  page.put("Contents", doc.addStream("/P <</MCID 0>> BDC " + page.get("Contents").readStream().asString() + " EMC", {}));
  doc.getTrailer().get("Root").put("StructTreeRoot", doc.addObject({ Type: "StructTreeRoot" }));
  const report = newReport();
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-embedded"), {}, report));
  assert.deepEqual(["retagged", "source_marked_content"].map((c) => report.warnings.some((w) => w.code === c)), [true, false]);
  assert.match(out.getTrailer().get("Root", "Metadata").readStream().asString(), /pdfuaid:part/);
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

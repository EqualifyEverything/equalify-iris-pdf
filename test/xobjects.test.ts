import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { newReport, tag } from "../src/index.ts";
import { pageBody } from "../src/pdf/content.ts";
import { inlineForms } from "../src/pdf/forms.ts";
import { readingOrder, structTree } from "./helpers.ts";

const PAGE = "BT /F1 12 Tf 20 250 Td (Title) Tj ET /G0 gs /X0 Do";
// A page that draws "Title" itself and "Hello world" through form X0, whose
// own F1 is Courier where the page's is Helvetica. form: X0's extra entries;
// gs: the page's G0.
function formPage(form: (d: mupdf.PDFDocument) => Record<string, unknown> = () => ({}), gs: Record<string, unknown> = {}, body = "BT /F1 12 Tf 0 0 Td (Hello world) Tj ET") {
  const src = new mupdf.PDFDocument();
  const courier = src.addSimpleFont(new mupdf.Font("Courier"));
  const x0 = src.addStream(body, { Type: "XObject", Subtype: "Form", BBox: [0, -5, 200, 20], Matrix: [1, 0, 0, 1, 20, 200], Resources: { Font: { F1: courier } }, ...form(src) });
  const res = src.addObject({ Font: { F1: src.addSimpleFont(new mupdf.Font("Helvetica")) }, XObject: { X0: x0 }, ExtGState: { G0: gs } });
  src.insertPage(-1, src.addPage([0, 0, 300, 300], 0, res, PAGE));
  return src;
}

function tagForm(...args: Parameters<typeof formPage>) {
  const pdf = formPage(...args).saveToBuffer("").asUint8Array().slice(), report = newReport();
  const doc = new mupdf.PDFDocument(tag(pdf, { lang: "en", title: "t", pages: [{ sourcePage: 1, html: "<h1>Title</h1><p>Hello world</p>" }] }, {}, report));
  const text = (d: mupdf.PDFDocument) => d.loadPage(0).toStructuredText("").asText();
  return { doc, report, before: text(new mupdf.PDFDocument(pdf)), after: text(doc) };
}

test("text a form XObject draws is tagged where it is, the form drawn in the page", () => {
  const { doc, report, before, after } = tagForm();
  assert.equal(report.pages[0].redrawn, 0);
  assert.equal(readingOrder(structTree(doc)), "Title Hello world");
  assert.equal(after, before, "no word drawn twice");
  assert.equal(report.verification.pixels, "identical-outside-fields");
  const body = pageBody(doc.findPage(0));
  assert.doesNotMatch(body, /\/X0 Do/);
  assert.match(body, /q 1 0 0 1 20 200 cm 0 -5 200 25 re W n/);
  assert.match(body, /\/F1_f1 12 Tf/, "the form's F1 is not the page's, so it gets a name of its own");
});

test("a form with optional content is drawn inside that optional content", () => {
  const { doc, report } = tagForm((d) => {
    const ocg = d.addObject({ Type: "OCG", Name: d.newString("Layer") });
    d.getTrailer().get("Root").put("OCProperties", { OCGs: [ocg], D: { Name: d.newString("Default"), ON: [ocg] } });
    return { OC: ocg };
  });
  assert.equal(report.pages[0].redrawn, 0);
  assert.match(pageBody(doc.findPage(0)), /\/OC \/OC BDC/);
  assert.equal(report.verification.pixels, "identical-outside-fields");
});

test("a form that might draw differently in the page is left whole", () => {
  const inlines = (...args: Parameters<typeof formPage>) => {
    const doc = formPage(...args), page = doc.findPage(0);
    return inlineForms(doc, page, PAGE) !== PAGE;
  };
  const group = () => ({ Group: { S: "Transparency" } });
  assert.ok(inlines(group), "a group drawn opaque, in Normal blend mode");
  assert.ok(!inlines(() => ({ Group: { S: "Transparency", K: true } })), "knockout");
  assert.ok(!inlines(group, { ca: 0.5 }), "under the page's alpha");
  assert.ok(!inlines(group, { SMask: { S: "Luminosity" } }), "under the page's soft mask");
  assert.ok(!inlines((d) => ({ ...group(), Resources: { Font: { F1: d.addSimpleFont(new mupdf.Font("Courier")) }, ExtGState: { B: { BM: "Multiply" } } } })), "a blend mode");
  assert.ok(!inlines(undefined, {}, "/P BMC BT /F1 12 Tf 0 0 Td (Hello world) Tj ET EMC"), "marked content");
  assert.ok(!inlines(undefined, {}, "Q BT /F1 12 Tf 0 0 Td (Hello world) Tj ET"), "unbalanced");
  assert.ok(!inlines(undefined, {}, "/Pattern cs /P0 scn BT /F1 12 Tf 0 0 Td (Hello world) Tj ET"), "a pattern");
  assert.ok(!inlines(undefined, {}, "0 0 10 10 re f"), "no text");
  // A group mupdf renders differently drawn in the page is left whole: the
  // page is tagged in place, the form's words drawn again.
  const { doc, report } = tagForm(group);
  assert.match(pageBody(doc.findPage(0)), /\/X0 Do/);
  assert.equal(report.pages[0].redrawn, 2);
  assert.ok(!report.warnings.some((w) => w.code === "in_place_failed"));
});

test("forms that would inline too large, or nest too deep, are left whole", () => {
  // Each level draws the next 30 times: inlined four levels deep that is 30^4 copies.
  const doc = new mupdf.PDFDocument(), font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const form = (body: string, xo: Record<string, unknown> = {}) =>
    doc.addStream(body, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 300], Resources: { Font: { F1: font }, XObject: xo } });
  let x = form("BT /F1 12 Tf 0 0 Td (Hello) Tj ET");
  for (let i = 0; i < 4; i++) x = form("/X Do ".repeat(30), { X: x });
  const page = doc.addObject({ Type: "Page", Resources: { XObject: { X: x } } }), body = "/X Do ".repeat(30);
  assert.equal(inlineForms(doc, page, body, 1_000_000), body);
  // A chain of forms deeper than the stack, text only at the end.
  let deep = form("BT /F1 12 Tf 0 0 Td (Hello) Tj ET");
  for (let i = 0; i < 20000; i++) deep = form("/X Do", { X: deep });
  page.put("Resources", { XObject: { X: deep } });
  assert.equal(inlineForms(doc, page, "/X Do"), "/X Do");
});

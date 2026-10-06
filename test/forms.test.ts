import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { fields, tag, newReport, type FormValue } from "../src/index.ts";
import type { Box } from "../src/align/words.ts";
import { tesseractInstalled } from "../src/ocr/tesseract.ts";
import { find, fixture, pagesOf, readFixture, structTree, tagFixture } from "./helpers.ts";

const noOcr = !tesseractInstalled() && "Tesseract is not installed";

const pdf = readFixture("form-acroform.pdf");
const pages = pagesOf("form-acroform");

function widgets(doc: mupdf.PDFDocument) {
  const out = new Map<string, mupdf.PDFWidget[]>();
  for (const w of doc.loadPage(0).getWidgets()) out.set(w.getName(), [...(out.get(w.getName()) ?? []), w]);
  return out;
}
const state = (w: mupdf.PDFWidget) => w.getObject().get("AS").asName();

function error(values: Record<string, FormValue>): { code: string; exit: number; message: string } {
  try {
    tag(pdf, pages, { values });
  } catch (e) {
    return e as { code: string; exit: number; message: string };
  }
  assert.fail("no error");
}

test("fields lists every terminal field with its type and options", () => {
  const list = fields(pdf);
  assert.deepEqual(list.map((f) => [f.name, f.type]), [
    ["applicant.name", "text"], ["applicant.consent", "checkbox"], ["contact", "radio"], ["state", "combobox"],
    ["office", "text"], ["reset", "button"], ["signature", "signature"],
  ]);
  const byName = Object.fromEntries(list.map((f) => [f.name, f]));
  assert.equal(byName["applicant.name"].maxlen, 40);
  assert.deepEqual(byName.contact.options, ["email", "phone"]);
  assert.deepEqual(byName.state.options, ["IL", "IN", "WI"]);
  assert.equal(byName.office.readonly, true);
  assert.deepEqual(fields(readFixture("form-flat.pdf")), []);
  assert.equal(fields(readFixture("restricted.pdf")).length, 0); // read-only use needs no edit permission
});

test("fills text, checkbox, radio and choice fields", () => {
  const report = newReport();
  const out = tag(pdf, pages, { values: { "applicant.name": "Ada Lovelace", "applicant.consent": true, contact: "phone", state: "WI", office: "Loop" } }, report);
  const w = widgets(new mupdf.PDFDocument(out));
  assert.equal(w.get("applicant.name")![0].getValue(), "Ada Lovelace");
  assert.equal(state(w.get("applicant.consent")![0]), "Agree");
  assert.deepEqual(w.get("contact")!.map(state), ["Off", "phone"]);
  assert.equal(w.get("state")![0].getValue(), "WI");
  assert.deepEqual([report.form.set, report.form.skippedReadOnly], [4, 1]);
  assert.notEqual(w.get("office")![0].getValue(), "Loop");
  assert.equal(report.verification.pixels, "identical-outside-fields");
});

test("false unchecks a checkbox", () => {
  const doc = new mupdf.PDFDocument(pdf);
  const box = widgets(doc).get("applicant.consent")![0].getObject();
  box.put("AS", doc.newName("Agree"));
  box.get("Parent").put("V", doc.newName("Agree"));
  const checked = doc.saveToBuffer("").asUint8Array().slice();
  const out = tag(checked, pages, { values: { "applicant.consent": false } });
  assert.equal(state(widgets(new mupdf.PDFDocument(out)).get("applicant.consent")![0]), "Off");
});

test("bad values are refused before anything is written, and never echoed", () => {
  const secret = "x".repeat(41);
  const long = error({ "applicant.name": secret });
  assert.deepEqual([long.code, long.exit], ["bad_value", 3]);
  assert.ok(!long.message.includes(secret));
  assert.equal(error({ contact: "fax" }).code, "bad_value");
  assert.equal(error({ state: "CA" }).code, "bad_value");
  assert.equal(error({ "applicant.consent": "yes" }).code, "bad_value");
  assert.deepEqual([error({ reset: "x" }).code, error({ reset: "x" }).exit], ["field_not_settable", 3]);
  assert.equal(error({ nope: "x" }).code, "no_acroform_field");
});

test("a checkbox with no checked appearance cannot be checked", () => {
  const doc = new mupdf.PDFDocument(pdf);
  widgets(doc).get("applicant.consent")![0].getObject().delete("AP");
  const bare = doc.saveToBuffer("").asUint8Array().slice();
  assert.throws(() => tag(bare, pages, { values: { "applicant.consent": true } }), { code: "bad_value", exit: 3 });
});

test("the tagged form: one Form element per field, widgets tied by reference and named", () => {
  const { doc, report } = tagFixture("form-acroform");
  const forms = find(structTree(doc), "Form");
  assert.equal(forms.length, 8); // 7 fields, the radio group has 2 widgets and 2 inputs
  assert.ok(forms.every((f) => f.objr.length === 1));
  assert.deepEqual(report.warnings.filter((w) => w.code === "field_not_in_html").map((w) => w.detail), ["reset"]);
  // /TU, the name a screen reader announces: the label, or the fieldset's legend for a group.
  const w = widgets(doc);
  assert.equal(w.get("applicant.name")![0].getLabel(), "Full name");
  assert.equal(w.get("contact")![0].getLabel(), "Contact me by");
  assert.equal(w.get("reset")![0].getLabel(), "reset", "a field the HTML does not name still gets a name");
  assert.equal(doc.loadPage(0).getObject().get("Tabs").asName(), "S");
});

test("--flatten bakes the values into the page and tags them as text", () => {
  const { doc, report } = tagFixture("form-acroform", { flatten: true, values: { "applicant.name": "Ada Lovelace", contact: "email" } });
  assert.equal(doc.loadPage(0).getWidgets().length, 0);
  const tree = structTree(doc);
  assert.equal(find(tree, "Form").length, 0);
  const ps = find(tree, "P").map((p) => p.text);
  assert.ok(ps.includes("Ada Lovelace"));
  assert.ok(ps.includes("email"));
  assert.equal(report.verification.textPreserved, true);
  assert.ok(!JSON.stringify(report).includes("Lovelace"), "values never reach the report");
});

test("a field the HTML does not name keeps its own name, a button its caption, a check box its field name", () => {
  const src = new mupdf.PDFDocument(pdf);
  const w = widgets(src);
  w.get("applicant.consent")![0].getObject().put("MK", { CA: src.newString("4") }); // the check mark's glyph, not a caption
  w.get("reset")![0].getObject().put("MK", { CA: src.newString("Clear the form") });
  w.get("state")![0].getObject().put("TU", src.newString("State of residence"));
  w.get("office")![0].getObject().put("T", src.newString("Office (dd.mm)")); // a period in a field's own name
  const html = { ...pages, pages: [{ sourcePage: 1, html: "<p>Permit application</p>" }] };
  const out = widgets(new mupdf.PDFDocument(tag(src.saveToBuffer("").asUint8Array().slice(), html)));
  assert.equal(out.get("applicant.consent")![0].getLabel(), "consent");
  assert.equal(out.get("reset")![0].getLabel(), "Clear the form");
  assert.equal(out.get("state")![0].getLabel(), "State of residence");
  assert.equal(out.get("Office (dd.mm)")![0].getLabel(), "Office (dd.mm)");
});

// A flat form: each blank's place on the page (top down), from make.ts.
const blanks: Record<string, Box[]> = {
  name: [[75, 62, 290, 76]], email: [[75, 86, 290, 102]], news: [[20, 116, 28, 124]],
  card: [[80, 139, 88, 147], [130, 139, 138, 147]],
  book1: [[20, 184, 155, 210]], due1: [[155, 184, 290, 210]], book2: [[20, 210, 155, 236]], due2: [[155, 210, 290, 236]],
};
const grow = (b: Box, d: number): Box => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
const within = (a: Box, b: Box) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

for (const [name, scan] of [["form-lines", false], ["form-scan", true], ["form-scan-skewed", true]] as const) {
  test(`${name}: a flat form gets a field on each blank the HTML names`, { skip: scan && noOcr }, () => {
    const { doc, report } = tagFixture(name);
    assert.deepEqual(report.form.created.map((c) => [c.name, c.type, c.page]), [
      ["name", "text", 1], ["email", "text", 1], ["news", "checkbox", 1], ["card", "radio", 1],
      ["book1", "text", 1], ["due1", "text", 1], ["book2", "text", 1], ["due2", "text", 1],
    ]);
    assert.deepEqual(report.warnings.filter((w) => w.code === "field_not_placed"), [{ code: "field_not_placed", page: 1, detail: "phone" }]);
    for (const [field, ws] of widgets(doc)) {
      const want = blanks[field];
      assert.equal(ws.length, want.length, field);
      ws.forEach((w, k) => {
        const b = w.getBounds() as Box, c: Box = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        // A scan's blanks move a little, and a skewed one's more; drawn ones do not.
        assert.ok(scan ? within(c, grow(want[k], 5)) : within(b, grow(want[k], 1.5)), `${field} at ${b.map((v) => v.toFixed(1))}`);
      });
    }
    assert.equal(find(structTree(doc), "Form").length, 9); // 8 fields, the radio group has 2 widgets
    assert.equal(report.verification.differingPixels, 0);
  });
}

test("a flat form's made fields are filled and named for a screen reader", () => {
  const { doc, report } = tagFixture("form-lines", { values: { name: "Ada Lovelace", card: "child", news: true, book1: "Emma" } });
  const w = widgets(doc);
  assert.equal(w.get("name")![0].getValue(), "Ada Lovelace");
  assert.equal(w.get("book1")![0].getValue(), "Emma");
  assert.deepEqual(w.get("card")!.map(state), ["Off", "child"]);
  assert.notEqual(state(w.get("news")![0]), "Off");
  assert.equal(report.form.set, 4);
  assert.equal(w.get("name")![0].getLabel(), "Full name", "a field in a fieldset is named by its own label");
  assert.equal(w.get("card")![0].getLabel(), "Card type:");
  assert.equal(w.get("book2")![0].getLabel(), "Book");
  assert.equal(report.verification.pixels, "identical-outside-fields");
  assert.throws(() => tag(readFixture("form-lines.pdf"), pagesOf("form-lines"), { values: { phone: "555" } }), { code: "no_acroform_field" });
});

test("a scan whose words are placed approximately gets no fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-pdf-")), out = join(dir, "o.pdf"), json = join(dir, "o.json");
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, "tag", "--pdf", fixture("form-scan.pdf"), "--pages", fixture("form-scan.pages.json"), "--out", out, "--report", json], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(json, "utf8"));
  assert.deepEqual(report.form.created, []);
  assert.equal(report.warnings.filter((w: { code: string }) => w.code === "field_not_placed").length, 10); // every control, a radio button each
  assert.equal(new mupdf.PDFDocument(readFileSync(out)).loadPage(0).getWidgets().length, 0);
});

test("a flat form's made fields keep their tags when the output is tagged again", () => {
  // A check box with a value, a dotted name and a repeated one: each made field's name or state differs from the HTML.
  const html = pagesOf("form-lines").pages[0].html.replace('name="news"', 'name="news" value="yes"').replace('name="name"', 'name="you.name"').replace('name="due2"', 'name="due1"');
  const pages = { ...pagesOf("form-lines"), pages: [{ sourcePage: 1, html }] };
  const first = newReport(), out = tag(readFixture("form-lines.pdf"), pages, { values: { news: true } }, first);
  assert.deepEqual(first.form.created.map((c) => c.name), ["you-name", "email", "news", "card", "book1", "due1", "book2", "due1-2"]);
  const again = newReport(), doc = new mupdf.PDFDocument(tag(out, pages, {}, again));
  assert.deepEqual(again.warnings.filter((w) => w.code.startsWith("field_")).map((w) => w.code), ["field_not_in_pdf"]); // phone
  assert.equal(find(structTree(doc), "Form").length, 9);
  assert.equal(state(widgets(doc).get("news")![0]), "yes");
});

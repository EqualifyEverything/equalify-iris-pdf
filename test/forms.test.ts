import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { fields, tag, newReport, type FormValue } from "../src/index.ts";
import { find, pagesOf, readFixture, structTree, tagFixture } from "./helpers.ts";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { fixture } from "./helpers.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "iris-pdf-"));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const tagArgs = (name: string, out: string, ...rest: string[]) =>
  ["tag", "--pdf", fixture(`${name}.pdf`), "--pages", fixture(`${name}.pages.json`), "--out", out, ...rest];

test("tag writes the PDF and the report, and exits 0", () => {
  const out = join(dir, "ok.pdf"), report = join(dir, "ok.json");
  const r = run(...tagArgs("text-simple", out, "--report", report));
  assert.equal(r.code, 0, r.err);
  assert.ok(readFileSync(out).length > 0);
  assert.equal(JSON.parse(readFileSync(report, "utf8")).verification.pixels, "identical-outside-fields");
});

test("a refusal exits 1, writes no PDF, and still writes the report", () => {
  const out = join(dir, "no.pdf"), report = join(dir, "no.json");
  const r = run("tag", "--pdf", fixture("signed.pdf"), "--pages", fixture("form-acroform.pages.json"), "--out", out, "--report", report);
  assert.equal(r.code, 1);
  assert.match(r.err, /^iris-pdf: signed: /);
  assert.ok(!existsSync(out));
  assert.equal(JSON.parse(readFileSync(report, "utf8")).error.code, "signed");
});

test("a failed verification exits 2 and writes no PDF", () => {
  // A stream ending inside a string swallows the overlay (see tag.test.ts).
  const doc = new mupdf.PDFDocument(readFileSync(fixture("text-simple.pdf")));
  const page = doc.findPage(0);
  page.put("Contents", doc.addStream(page.get("Contents").readStream().asString() + "\nBT (unterminated", {}));
  const pdf = join(dir, "corrupt.pdf"), out = join(dir, "corrupt-out.pdf");
  writeFileSync(pdf, doc.saveToBuffer("").asUint8Array());
  const r = run("tag", "--pdf", pdf, "--pages", fixture("text-simple.pages.json"), "--out", out);
  assert.equal(r.code, 2);
  assert.match(r.err, /iris-pdf: text_lost: /);
  assert.ok(!existsSync(out));
});

test("bad arguments and bad values exit 3; values never appear in output", () => {
  assert.equal(run().code, 3);
  assert.equal(run("tag", "--nope").code, 3);
  assert.equal(run(...tagArgs("text-simple", join(dir, "x.pdf"), "--ocr", "maybe")).code, 3);
  assert.equal(run(...tagArgs("text-simple", join(dir, "x.pdf"), "--verify-dpi", "5")).code, 3);
  assert.equal(run("frobnicate").code, 3);

  const secret = "SSN-123-45-6789-" + "x".repeat(30);
  const values = join(dir, "values.json"), report = join(dir, "values-report.json");
  writeFileSync(values, JSON.stringify({ "applicant.name": secret }));
  const r = run(...tagArgs("form-acroform", join(dir, "v.pdf"), "--values", values, "--report", report));
  assert.equal(r.code, 3);
  assert.match(r.err, /bad_value/);
  assert.ok(!(r.out + r.err + readFileSync(report, "utf8")).includes("SSN"));
});

test("fields prints one line per field, or JSON", () => {
  const r = run("fields", "--pdf", fixture("form-acroform.pdf"));
  assert.equal(r.code, 0);
  assert.match(r.out, /^applicant\.name\ttext\tpage 1/m);
  assert.match(r.out, /^state\tcombobox\tpage 1\t\[IL, IN, WI\]/m);
  const json = JSON.parse(run("fields", "--pdf", fixture("form-acroform.pdf"), "--json").out);
  assert.equal(json.length, 7);
  assert.equal(run("fields", "--pdf", fixture("encrypted.pdf")).code, 1);
});

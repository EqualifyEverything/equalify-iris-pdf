// veraPDF over the corpus: every output that claims PDF/UA-1 must pass it,
// and the fixtures that can conform must claim it. Skips without veraPDF, unless IRIS_REQUIRE_VERAPDF is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tesseractInstalled } from "../src/ocr/tesseract.ts";
import { checkPdfUa } from "../src/verify/pdfua.ts";
import { newReport, tag } from "../src/index.ts";
import { fixture, pagesOf, readFixture, tagFixture, withLayers } from "./helpers.ts";

const noVera = !process.env.IRIS_REQUIRE_VERAPDF && !!spawnSync("verapdf", ["--version"]).error && "veraPDF is not installed";
const noOcr = !tesseractInstalled() && "Tesseract is not installed";
const dir = mkdtempSync(join(tmpdir(), "iris-pdf-ua-"));

// name -> should the output claim PDF/UA-1?
const CORPUS: [string, boolean][] = [
  ["text-embedded", true], ["structure", true], ["blank-page", true], ["scan-300dpi", true], ["scan-skewed", true],
  ["text-simple", false], ["text-two-column", false], ["links", false], ["form-acroform", false], ["cjk", false], ["mixed", false],
];
const SCANS = new Set(["scan-300dpi", "scan-skewed", "mixed"]);

test("a scan tagged without Tesseract claims PDF/UA-1 and passes veraPDF", { skip: noVera }, () => {
  const path = join(dir, "scan-approx.pdf");
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, "tag", "--pdf", fixture("scan-300dpi.pdf"), "--pages", fixture("scan-300dpi.pages.json"), "--out", path], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(path, "latin1"), /<pdfuaid:part>1</);
  const { passed, message } = checkPdfUa(path);
  assert.equal(passed, true, message);
});

test("an equation's Formula passes veraPDF", { skip: noVera }, () => {
  const pages = pagesOf("text-embedded");
  pages.pages[0].html += '<math alttext="x plus 1"><mi>x</mi><mo>+</mo><mn>1</mn></math>';
  const report = newReport();
  const out = tag(readFixture("text-embedded.pdf"), pages, {}, report);
  assert.equal(report.warnings.some((w) => w.code === "unmapped_element"), false);
  const path = join(dir, "formula.pdf");
  writeFileSync(path, out);
  const { passed, message } = checkPdfUa(path);
  assert.equal(passed, true, message);
});

test("a page cut from mid-document, starting at h2, claims PDF/UA-1 and passes veraPDF", { skip: noVera }, () => {
  const pages = pagesOf("text-embedded");
  pages.pages[0].html = pages.pages[0].html.replace("<h2>", "<h3>").replace("</h2>", "</h3>").replace("<h1>", "<h2>").replace("</h1>", "</h2>");
  const report = newReport();
  const out = tag(readFixture("text-embedded.pdf"), pages, {}, report);
  assert.equal(report.warnings.find((w) => w.code === "headings_shifted")?.detail, "The first heading is h2; every heading is tagged 1 level higher, so the first is H1.");
  const path = join(dir, "first-h2.pdf");
  writeFileSync(path, out);
  assert.match(readFileSync(path, "latin1"), /<pdfuaid:part>1</);
  const { passed, message } = checkPdfUa(path);
  assert.equal(passed, true, message);
});

test("a table with an empty row, as <tr><tr> parses, claims PDF/UA-1 and passes veraPDF", { skip: noVera }, () => {
  const pages = pagesOf("text-embedded");
  pages.pages[0].html += "<table><tr><th>Zone</th><th>Fee</th></tr><tr><tr><td>North</td><td>20</td></tr></table>";
  const path = join(dir, "empty-row.pdf");
  writeFileSync(path, tag(readFixture("text-embedded.pdf"), pages));
  assert.match(readFileSync(path, "latin1"), /<pdfuaid:part>1</);
  const { passed, message } = checkPdfUa(path);
  assert.equal(passed, true, message);
});

test("a PDF with unnamed optional content configurations claims PDF/UA-1 and passes veraPDF", { skip: noVera }, () => {
  const out = tag(withLayers(), pagesOf("text-embedded"), {}, newReport());
  const path = join(dir, "layers.pdf");
  writeFileSync(path, out);
  const { passed, message } = checkPdfUa(path);
  assert.equal(passed, true, message);
});

for (const [name, conforms] of CORPUS) {
  test(`${name}: ${conforms ? "claims PDF/UA-1 and passes veraPDF" : "does not claim PDF/UA-1"}`, { skip: noVera || (SCANS.has(name) && noOcr) }, () => {
    const { out, doc } = tagFixture(name);
    const claims = /<pdfuaid:part>1</.test(doc.getTrailer().get("Root", "Metadata").readStream().asString());
    assert.equal(claims, conforms, "claim");
    const path = join(dir, `${name}.pdf`);
    writeFileSync(path, out);
    const { passed, message } = checkPdfUa(path);
    if (claims) assert.equal(passed, true, message);
  });
}

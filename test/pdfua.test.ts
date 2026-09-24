// veraPDF over the corpus: every output that claims PDF/UA-1 must pass it,
// and the fixtures that can conform must claim it. Skips without veraPDF, unless IRIS_REQUIRE_VERAPDF is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tesseractInstalled } from "../src/ocr/tesseract.ts";
import { checkPdfUa } from "../src/verify/pdfua.ts";
import { tagFixture } from "./helpers.ts";

const noVera = !process.env.IRIS_REQUIRE_VERAPDF && !!spawnSync("verapdf", ["--version"]).error && "veraPDF is not installed";
const noOcr = !tesseractInstalled() && "Tesseract is not installed";
const dir = mkdtempSync(join(tmpdir(), "iris-pdf-ua-"));

// name -> should the output claim PDF/UA-1?
const CORPUS: [string, boolean][] = [
  ["text-embedded", true], ["structure", true], ["blank-page", true], ["scan-300dpi", true], ["scan-skewed", true],
  ["text-simple", false], ["text-two-column", false], ["links", false], ["form-acroform", false], ["cjk", false], ["mixed", false],
];
const SCANS = new Set(["scan-300dpi", "scan-skewed", "mixed"]);

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

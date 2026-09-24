// Test helpers: read a tagged PDF back the way a screen reader would, by
// walking the structure tree and decoding the marked content it points at.
import * as mupdf from "mupdf";
import { readFileSync } from "node:fs";
import { tag, newReport, type TagOptions, type Report } from "../src/index.ts";

export const fixture = (name: string) => new URL(`fixtures/${name}`, import.meta.url).pathname;
export const readFixture = (name: string) => readFileSync(fixture(name));
export const pagesOf = (name: string) => JSON.parse(readFileSync(fixture(`${name}.pages.json`), "utf8"));

export function tagFixture(name: string, opts: TagOptions = {}): { out: Uint8Array; report: Report; doc: mupdf.PDFDocument } {
  const report = newReport();
  const out = tag(readFixture(`${name}.pdf`), pagesOf(name), opts, report);
  const doc = new mupdf.PDFDocument(out);
  if (doc.needsPassword()) doc.authenticatePassword(opts.password ?? "");
  return { out, report, doc };
}

export { mcidText, structTree, readingOrder, find, type Elem } from "../src/pdf/read.ts";

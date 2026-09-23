import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { newReport, tag } from "../src/index.ts";
import { buildPage, wordsInOrder } from "../src/html/build.ts";
import { normalize, splitWords } from "../src/align/words.ts";
import { tesseractInstalled } from "../src/ocr/tesseract.ts";
import { comparePixels } from "../src/verify/pixels.ts";
import { compareText } from "../src/verify/text.ts";
import { xmp } from "../src/pdf/metadata.ts";
import { find, mcidText, pagesOf, readFixture, readingOrder, structTree, tagFixture } from "./helpers.ts";

const TEXT = ["text-simple", "text-two-column", "links", "form-acroform", "cjk", "blank-page"];
const SCANS = ["scan-300dpi", "scan-skewed", "mixed"];
const noOcr = { skip: !tesseractInstalled() && "Tesseract is not installed" };

const tokens = (s: string) => splitWords(s).map((w) => normalize(w.text)).filter(Boolean);

// What a screen reader should read: Iris's words, in Iris's order.
function htmlOrder(name: string): string[] {
  return pagesOf(name).pages.flatMap((p: { html: string }) =>
    wordsInOrder(buildPage(p.html, "en", "", () => {})).map((o) => o.word.norm).filter(Boolean));
}

function checkCorpus(name: string) {
  const { out, report, doc } = tagFixture(name);
  const pdf = readFixture(`${name}.pdf`);
  assert.equal(report.verification.pixels, "identical-outside-fields", "pixels");
  assert.equal(report.verification.textPreserved, true, "text");
  assert.ok(Buffer.from(out.subarray(0, pdf.length)).equals(pdf), "the original bytes are untouched");
  assert.deepEqual(report.pages.map((p) => p.lost), report.pages.map(() => 0), "no page text left out");
  assert.deepEqual(tokens(readingOrder(structTree(doc))), htmlOrder(name), "reading order");
  checkParentTree(doc);
}

for (const name of TEXT) test(`${name}: renders the same, keeps its text, reads in Iris's order`, () => checkCorpus(name));
for (const name of SCANS) test(`${name}: tags a scan with OCR word boxes`, noOcr, () => checkCorpus(name));

// Every marked-content id on a page resolves, through the ParentTree, to the
// element that owns it.
function checkParentTree(doc: mupdf.PDFDocument) {
  const root = doc.getTrailer().get("Root", "StructTreeRoot");
  const nums = root.get("ParentTree", "Nums");
  const tree = new Map<number, mupdf.PDFObject>();
  for (let i = 0; i < nums.length; i += 2) tree.set(nums.get(i).asNumber(), nums.get(i + 1));
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    const ids = [...mcidText(page).keys()];
    if (!ids.length) continue;
    const parents = tree.get(page.get("StructParents").asNumber())!;
    for (const id of ids) {
      const elem = parents.get(id);
      const k = elem.get("K");
      const owns = (x: mupdf.PDFObject) => (x.isInteger() ? x.asNumber() === id : x.get("MCID").asNumber() === id);
      let found = false;
      k.forEach((x) => { if (owns(x)) found = true; });
      assert.ok(found, `page ${i + 1} mcid ${id}`);
    }
  }
  assert.equal(root.get("ParentTreeNextKey").asNumber(), tree.size);
}

test("text-simple: headings and paragraphs, running header left as an artifact", () => {
  const { doc, report } = tagFixture("text-simple");
  assert.deepEqual(structTree(doc).kids.map((k) => k.type), ["H1", "P", "H2", "P"]);
  assert.ok(report.pages[0].furniture > 0);
  assert.ok(report.warnings.some((w) => w.code === "duplicate_text_layer"));
  const contents = doc.findPage(0).get("Contents");
  assert.equal(contents.get(0).readStream().asString().trim(), "/Artifact BMC q");
});

test("document info: language, title, marked, PDF/UA identifier", () => {
  const { doc } = tagFixture("text-simple");
  const root = doc.getTrailer().get("Root");
  assert.equal(root.get("Lang").asString(), "en");
  assert.equal(root.get("MarkInfo", "Marked").asBoolean(), true);
  assert.equal(root.get("ViewerPreferences", "DisplayDocTitle").asBoolean(), true);
  assert.equal(doc.getMetaData("info:Title"), "Test document");
  const packet = root.get("Metadata").readStream().asString();
  assert.match(packet, /<pdfuaid:part>1<\/pdfuaid:part>/);
  assert.match(packet, /<rdf:li xml:lang="x-default">Test document<\/rdf:li>/);
});

test("links: the Link element owns its annotation, which gets the link text", () => {
  const { doc } = tagFixture("links");
  const [link] = find(structTree(doc), "Link");
  assert.equal(link.text, "the city website");
  assert.equal(link.objr.length, 1);
  assert.equal(link.objr[0].get("Contents").asString(), "the city website");
  assert.equal(typeof link.objr[0].get("StructParent").asNumber(), "number");
});

test("cjk: every character is recoverable through ToUnicode", () => {
  const { doc, report } = tagFixture("cjk");
  const text = readingOrder(structTree(doc)).replace(/\s/g, "");
  const want = pagesOf("cjk").pages[0].html.replace(/<[^>]+>|\s/g, "");
  assert.equal(text, want);
  assert.ok(!report.warnings.some((w) => w.code === "missing_glyph"));
});

test("a scan with OCR off is refused, or left untagged with --partial", () => {
  const pdf = readFixture("mixed.pdf"), pages = pagesOf("mixed");
  assert.throws(() => tag(pdf, pages, { ocr: "off" }), { code: "no_text_positions" });
  const report = newReport();
  tag(pdf, pages, { ocr: "off", partial: true }, report);
  assert.deepEqual(report.pages.map((p) => p.textSource), ["pdf-text", "none"]);
  assert.ok(report.warnings.some((w) => w.code === "no_text_positions" && w.page === 2));
});

test("text Iris left out is kept and reported, not dropped", () => {
  const pages = { lang: "en", pages: [{ sourcePage: 1, html: "<h1>Parking Permit</h1>" }] };
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(readFixture("text-simple.pdf"), pages, {}, report));
  assert.ok(report.pages[0].lost > 0);
  assert.ok(report.warnings.some((w) => w.code === "unmatched_text"));
  assert.match(readingOrder(structTree(doc)), /^Parking Permit Residents may apply/);
  assert.throws(() => tag(readFixture("text-simple.pdf"), pages, { strict: true }), { code: "strict" });
});

test("the verification gate sees changed pixels and lost text", () => {
  const pdf = readFixture("text-simple.pdf");
  const before = new mupdf.PDFDocument(pdf);
  const drawn = new mupdf.PDFDocument(pdf);
  const page = drawn.findPage(0);
  page.put("Contents", [page.get("Contents"), drawn.addStream("0 0 1 rg 100 100 50 50 re f", {})]);
  const [f] = comparePixels(before, drawn, 72, new Map());
  assert.equal(f.page, 1);
  assert.deepEqual(f.box.map(Math.round), [100, 246, 150, 296]);
  assert.deepEqual(comparePixels(before, drawn, 72, new Map([[0, [[90, 240, 160, 300]]]])), [], "changed field rects are allowed");

  const emptied = new mupdf.PDFDocument(pdf);
  emptied.findPage(0).put("Contents", emptied.addStream("", {}));
  const [t] = compareText(before, emptied);
  assert.ok(t.missing.includes("Residents"));
});

test("xmp keeps an existing packet and replaces only its title and PDF/UA part", () => {
  const old = '<x:xmpmeta><rdf:RDF><rdf:Description xmp:CreatorTool="Word"><dc:title><rdf:Alt><rdf:li>Old</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
  const out = xmp(old, "New & <improved>");
  assert.match(out, /xmp:CreatorTool="Word"/);
  assert.doesNotMatch(out, /Old/);
  assert.equal(out.match(/<dc:title>/g)!.length, 1);
  assert.match(out, /New &#38; &#60;improved&#62;/);
});

test("the gate fails a source stream that swallows the tagged text, and writes nothing", () => {
  // The page's own stream ends inside a string, so a reader takes the overlay after it as that string.
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  const page = doc.findPage(0);
  page.put("Contents", doc.addStream(page.get("Contents").readStream().asString() + "\nBT (unterminated", {}));
  const report = newReport();
  assert.throws(() => tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-simple"), {}, report), { code: "text_lost", exit: 2 });
  assert.match(report.warnings.find((w) => w.code === "text_lost")!.detail!, /characters of the tagged text are not readable/);
});

test("a page with too many words is refused", () => {
  const html = "<p>" + "word ".repeat(4001) + "</p>";
  assert.throws(() => tag(readFixture("text-simple.pdf"), { lang: "en", pages: [{ sourcePage: 1, html }] }), { code: "too_many_words", exit: 1 });
});

test("a character no font has is reported, not a verification failure", () => {
  const report = newReport();
  tag(readFixture("text-simple.pdf"), { lang: "en", pages: [{ sourcePage: 1, html: "<h1>Parking Permit 🦄</h1>" }] }, {}, report);
  assert.equal(report.warnings.find((w) => w.code === "missing_glyph")?.detail, "🦄");
  assert.equal(report.verification.textPreserved, true);
});

test("an internal link: Reference > Link owns the GoTo annotation, which gets the link text", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  const page = doc.loadPage(0);
  const [quad] = page.search("Parking Permit", "")[0];
  page.createLink([quad[0], quad[1], quad[6], quad[7]], "#page=1");
  const html = '<h1><a href="#fees">Parking Permit</a></h1><p>Residents may apply for one parking permit per car. Bring proof of address to the permit office.</p><h2 id="fees">Fees</h2><p>A permit costs twenty dollars a year.</p>';
  const report = newReport();
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), { lang: "en", pages: [{ sourcePage: 1, html }] }, {}, report));
  const tree = structTree(out);
  const [ref] = find(tree, "Reference");
  assert.equal(ref.kids[0].type, "Link");
  assert.equal(ref.kids[0].objr.length, 1);
  assert.equal(ref.kids[0].objr[0].get("Contents").asString(), "Parking Permit");
  assert.equal(find(tree, "H2")[0].dict.get("ID").asString(), "p1-fees");
  assert.ok(!report.warnings.some((w) => w.code === "unmatched_link"));
});

test("an unmatched internal link annotation still gets a description", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  doc.loadPage(0).createLink([0, 0, 20, 20], "#page=1");
  const report = newReport();
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-simple"), {}, report));
  const [link] = find(structTree(out), "Link");
  assert.equal(link.objr[0].get("Contents").asString(), "Link to another part of this document");
  assert.ok(report.warnings.some((w) => w.code === "unmatched_link"));
});

test("a page missing from pages.json is left untouched, warned, and stops the PDF/UA claim", () => {
  const src = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  src.insertPage(-1, src.addPage([0, 0, 306, 396], 0, {}, "BT /F1 12 Tf 72 300 Td (Second page) Tj ET"));
  const pdf = src.saveToBuffer("").asUint8Array().slice();
  const before = src.findPage(1).get("Contents").readStream().asString();
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(pdf, pagesOf("text-simple"), {}, report));
  const page = doc.findPage(1);
  assert.equal(page.get("Contents").readStream().asString(), before);
  assert.ok(page.get("StructParents").isNull());
  assert.ok(report.warnings.some((w) => w.code === "page_not_in_html" && w.page === 2));
  assert.doesNotMatch(doc.getTrailer().get("Root", "Metadata").readStream().asString(), /pdfuaid:part/);
  assert.throws(() => tag(pdf, pagesOf("text-simple"), { strict: true }), { code: "strict" });
});

test("a page whose HTML holds nothing to tag is left as it was, not hidden as an artifact", () => {
  const pdf = readFixture("scan-300dpi.pdf");
  const pages = { lang: "en", title: "T", pages: [{ sourcePage: 1, html: "" }] };
  const before = new mupdf.PDFDocument(pdf).findPage(0).get("Contents").readStream().asString();
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(pdf, pages, {}, report));
  assert.equal(doc.findPage(0).get("Contents").readStream().asString(), before);
  assert.ok(report.warnings.some((w) => w.code === "page_not_tagged"));
  assert.doesNotMatch(doc.getTrailer().get("Root", "Metadata").readStream().asString(), /pdfuaid:part/);
  assert.throws(() => tag(pdf, pages, { strict: true }), { code: "strict" });
});

test("a blank page needs no HTML and does not cost the PDF/UA claim", () => {
  const { doc, report } = tagFixture("blank-page", { strict: true });
  assert.ok(!report.warnings.some((w) => w.code === "page_not_in_html"));
  assert.match(doc.getTrailer().get("Root", "Metadata").readStream().asString(), /<pdfuaid:part>1/);

  // With a link on it, the blank page has something to tag.
  const src = new mupdf.PDFDocument(readFixture("blank-page.pdf"));
  src.loadPage(1).createLink([10, 10, 50, 50], "https://example.org");
  const withLink = src.saveToBuffer("").asUint8Array().slice();
  const linked = newReport();
  const out = new mupdf.PDFDocument(tag(withLink, pagesOf("blank-page"), {}, linked));
  assert.ok(linked.warnings.some((w) => w.code === "page_not_in_html" && w.page === 2));
  assert.doesNotMatch(out.getTrailer().get("Root", "Metadata").readStream().asString(), /pdfuaid:part/);
});

test("a generic link description is marked English in a document that is not", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  doc.loadPage(0).createLink([0, 0, 20, 20], "#page=1");
  const pages = { ...pagesOf("text-simple"), lang: "fr" };
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), pages));
  const [link] = find(structTree(out), "Link");
  assert.equal(link.dict.get("Lang").asString(), "en");
});

test("an unmatched link is described by the words under it", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  const page = doc.loadPage(0);
  const [quad] = page.search("Fees", "")[0];
  page.createLink([quad[0], quad[1], quad[6], quad[7]], "#page=1");
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-simple")));
  // "Fees" is matched to an H2, not a link, so the annotation is unmatched.
  const [link] = find(structTree(out), "Link");
  assert.equal(link.objr[0].get("Contents").asString(), "Fees");
});

test("with no title there is no PDF/UA claim, no empty title, and --strict fails", () => {
  const pages = { ...pagesOf("text-simple"), title: undefined };
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(readFixture("text-simple.pdf"), pages, {}, report));
  const root = doc.getTrailer().get("Root");
  assert.ok(report.warnings.some((w) => w.code === "no_title"));
  assert.ok(root.get("ViewerPreferences", "DisplayDocTitle").isNull());
  assert.ok(root.get("Metadata").isNull(), "no packet to write");
  assert.throws(() => tag(readFixture("text-simple.pdf"), pages, { strict: true }), { code: "strict" });
  const packet = xmp('<x:xmpmeta><rdf:RDF><rdf:Description><dc:title>Old</dc:title><pdfuaid:part>1</pdfuaid:part></rdf:Description></rdf:RDF></x:xmpmeta>', "", false);
  assert.doesNotMatch(packet, /pdfuaid:part>|<dc:title><rdf:Alt>/);
  assert.match(packet, /Old/, "an old title stays when there is no new one");
});

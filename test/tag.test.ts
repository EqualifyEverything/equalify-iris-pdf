import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { newReport, tag, IrisPdfError } from "../src/index.ts";
import { share, withFallback } from "../src/tag.ts";
import { buildPage, wordsInOrder } from "../src/html/build.ts";
import { normalize, splitWords } from "../src/align/words.ts";
import { tesseractInstalled } from "../src/ocr/tesseract.ts";
import { comparePixels } from "../src/verify/pixels.ts";
import { compareText } from "../src/verify/text.ts";
import { xmp } from "../src/pdf/metadata.ts";
import { Overlay, pageBody, pagesWithMcids, unmark } from "../src/pdf/content.ts";
import { FontSet, unembeddedFonts } from "../src/pdf/fonts.ts";
import { find, mcidText, pagesOf, readFixture, readingOrder, structTree, tagFixture, withLayers } from "./helpers.ts";

const TEXT = ["text-simple", "text-embedded", "structure", "text-two-column", "links", "form-acroform", "cjk", "blank-page"];
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
  // The page's own text is tagged where it is: none is drawn twice.
  assert.equal(report.pages[0].redrawn, 0);
  assert.ok(!report.warnings.some((w) => w.code === "duplicate_text_layer"));
  const words = doc.loadPage(0).toStructuredText("").asText().split(/\s+/).filter(Boolean);
  const before = new mupdf.PDFDocument(readFixture("text-simple.pdf")).loadPage(0).toStructuredText("").asText().split(/\s+/).filter(Boolean);
  assert.deepEqual(words, before);
  const contents = doc.findPage(0).get("Contents");
  assert.equal(contents.get(0).readStream().asString().trim(), "/Artifact BMC q");
});

test("document info: language, title, marked, PDF/UA identifier", () => {
  const { doc } = tagFixture("text-embedded");
  const root = doc.getTrailer().get("Root");
  assert.equal(root.get("Lang").asString(), "en");
  assert.equal(root.get("MarkInfo", "Marked").asBoolean(), true);
  assert.equal(root.get("ViewerPreferences", "DisplayDocTitle").asBoolean(), true);
  assert.equal(doc.getMetaData("info:Title"), "Test document");
  const packet = root.get("Metadata").readStream().asString();
  assert.match(packet, /<pdfuaid:part>1<\/pdfuaid:part>/);
  assert.match(packet, /<rdf:li xml:lang="x-default">Test document<\/rdf:li>/);
});

test("a source font that is not embedded is reported, and PDF/UA is not claimed", () => {
  const { doc, report } = tagFixture("text-simple");
  assert.equal(report.warnings.find((w) => w.code === "font_not_embedded")?.detail?.split(";")[0], "Helvetica, Helvetica-Bold");
  assert.doesNotMatch(doc.getTrailer().get("Root", "Metadata").readStream().asString(), /pdfuaid:part/);
  assert.ok(!tagFixture("text-embedded").report.warnings.some((w) => w.code === "font_not_embedded"));
  // The form's default resources count only for an appearance with none of its own.
  const form = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const helv = form.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
  form.getTrailer().get("Root").put("AcroForm", form.addObject({ Fields: [], DR: { Font: { Helv: helv } } }));
  assert.deepEqual(unembeddedFonts(form), []);
  const ap = form.addStream("BT /Helv 10 Tf (x) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 50, 20] });
  form.findPage(0).put("Annots", [form.addObject({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 50, 20], AP: { N: ap } })]);
  assert.deepEqual(unembeddedFonts(form), ["Helvetica"]);
  // So can a tiling pattern.
  const tiled = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const courier = tiled.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Courier" });
  tiled.findPage(0).get("Resources").put("Pattern", { P0: tiled.addStream("BT /C 8 Tf (Paid) Tj ET", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 40, 10], XStep: 40, YStep: 10, Resources: { Font: { C: courier } } }) });
  assert.deepEqual(unembeddedFonts(tiled), ["Courier"]);
});

test("an equation is a Formula with Alt that owns its words, and its MathML as an associated file", () => {
  const pages = pagesOf("text-simple");
  pages.pages[0].html += '<p>Fee <math alttext="\\frac{x}{2}"><mfrac><mi>x</mi><mn>2</mn></mfrac></math></p>';
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(readFixture("text-simple.pdf"), pages, {}, report));
  const [f] = find(structTree(doc), "Formula");
  assert.equal(f.dict.get("Alt").asString(), "x over 2");
  assert.equal(f.text, "x 2");
  assert.equal(report.warnings.some((w) => w.code === "unmapped_element"), false);
  const spec = f.dict.get("AF").get(0);
  assert.equal(spec.get("AFRelationship").asName(), "Supplement");
  assert.equal(spec.get("UF").asString(), "formula.mml");
  assert.equal(doc.getEmbeddedFileContents(spec)!.asString(),
    '<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="\\frac{x}{2}"><mfrac><mi>x</mi><mn>2</mn></mfrac></math>');
  assert.deepEqual(Object.keys(doc.getEmbeddedFiles()), []); // not an attachment
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
  const want = pagesOf("cjk").pages[0].html.replace(/<[^>]+>|\s/g, "");
  assert.equal(readingOrder(structTree(tagFixture("cjk").doc)).replace(/\s/g, ""), want);
  // Drawn in the overlay, through our font's /ToUnicode.
  const { doc, report } = tagFixture("cjk", { inPlace: false });
  assert.equal(readingOrder(structTree(doc)).replace(/\s/g, ""), want);
  assert.ok(!report.warnings.some((w) => w.code === "missing_glyph"));
  const cid = doc.findPage(0).get("Resources", "Font", "IrisF1", "DescendantFonts").get(0);
  assert.equal(cid.get("CIDToGIDMap").asName(), "Identity");
});

test("text Iris left out is kept and reported, not dropped", () => {
  const pages = { lang: "en", pages: [{ sourcePage: 1, html: "<h1>Parking Permit</h1>" }] };
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(readFixture("text-simple.pdf"), pages, {}, report));
  assert.ok(report.pages[0].lost > 0);
  assert.ok(report.warnings.some((w) => w.code === "unmatched_text"));
  assert.match(readingOrder(structTree(doc)), /^Parking Permit Residents may apply/);
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

test("the text gate compares drawn text, not the old structure's ActualText", () => {
  // A tagged source marks a line-end hyphen as a soft hyphen: ActualText U+00AD on its MCID.
  // Our tagging replaces that structure, so the same glyph then reads as "-".
  const doc = new mupdf.PDFDocument();
  const content = (end: string) => "BT /F1 10 Tf 20 300 Td\n" +
    "/P <</MCID 0>> BDC (See example.com/2022-PA) Tj EMC\n/Span <</MCID 1>> BDC (-) Tj EMC\n" +
    `0 -14 Td /P <</MCID 2>> BDC (${end}) Tj EMC\nET\n`;
  const font = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
  const page = doc.addPage([0, 0, 306, 396], 0, { Font: { F1: font } }, content("0060.htm today."));
  page.put("StructParents", 0);
  doc.insertPage(-1, page);
  const pg = doc.findPage(0);
  const root = doc.addObject({ Type: "StructTreeRoot" });
  const kid = (s: string, mcid: number, extra = {}) => doc.addObject({ Type: "StructElem", S: s, P: root, Pg: pg, K: mcid, ...extra });
  const kids = [kid("P", 0), kid("Span", 1, { ActualText: doc.newString("­") }), kid("P", 2)];
  root.put("K", kids);
  root.put("ParentTree", doc.addObject({ Nums: [0, kids] }));
  doc.getTrailer().get("Root").put("StructTreeRoot", root);
  doc.getTrailer().get("Root").put("MarkInfo", { Marked: true });
  const pdf = doc.saveToBuffer("").asUint8Array().slice();
  assert.match(new mupdf.PDFDocument(pdf).loadPage(0).toStructuredText("").asText(), /2022-PA­/, "the source reads a soft hyphen");

  const pages = { lang: "en", title: "T", pages: [{ sourcePage: 1, html: "<p>See example.com/2022-PA0060.htm today.</p>" }] };
  const report = newReport();
  tag(pdf, pages, {}, report);
  assert.equal(report.verification.textPreserved, true);

  // Real loss still fails: the next line's word is gone.
  const cut = new mupdf.PDFDocument(pdf);
  cut.findPage(0).put("Contents", cut.addStream(content("today."), {}));
  assert.deepEqual(compareText(new mupdf.PDFDocument(pdf), cut)[0].missing, ["0060.htm"]);
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

test("HTML words not on the page are laid out one after another, so none is lost to extraction", () => {
  // Squeezed into one spot, the repeated letters of "viii" and "Illustrations" merge when extracted.
  const pages = { lang: "en", title: "T", pages: [{ sourcePage: 1, html: pagesOf("text-simple").pages[0].html.replace("Permit", "Permit v Tables viii Illustrations") }] };
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(readFixture("text-simple.pdf"), pages, {}, report));
  assert.equal(report.pages[0].addedFromHtml, 4);
  assert.match(readingOrder(structTree(doc)), /^Parking Permit v Tables viii Illustrations Residents/);
  assert.match(doc.loadPage(0).toStructuredText("").asText(), /v\s*Tables\s*viii\s*Illustrations/);

  // Too many to fit on the line: they wrap, rather than run off the page.
  const long = { ...pages, pages: [{ sourcePage: 1, html: pages.pages[0].html.replace("Permit", "Permit" + " Tables…………………".repeat(40)) }] };
  const wrapped = newReport();
  tag(readFixture("text-simple.pdf"), long, {}, wrapped);
  assert.equal(wrapped.verification.textPreserved, true);
});

test("a word in a very narrow box keeps its repeated letters", () => {
  // OCR of sideways text gives boxes like this one: tall, and a tenth as wide as the word.
  const doc = new mupdf.PDFDocument();
  const fonts = new FontSet(), overlay = new Overlay(fonts, mupdf.Matrix.identity);
  overlay.word("Juasaffig", [100, 100, 116, 140], 140, 37);
  const ops = overlay.toString();
  doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, { Font: fonts.embed(doc, [ops]) }, ops));
  assert.equal(doc.loadPage(0).toStructuredText("").asText().trim(), "Juasaffig");
  // A source word drawn at size 0 still gets a finite matrix.
  overlay.word("Permit", [100, 100, 130, 110], 110, 0);
  assert.doesNotMatch(overlay.toString(), /NaN|Infinity/);
});

test("a figure's marked content holds its image; a decorative image stays an artifact", () => {
  const { out, report, doc } = tagFixture("structure");
  const body = pageBody(doc.findPage(0));
  const figure = find(structTree(doc), "Figure")[0];
  const mcid = figure.dict.get("K").get(0).asNumber();
  assert.match(body, new RegExp(`EMC /Figure <</MCID ${mcid}>> BDC\\n/Map Do\\nEMC /Artifact BMC`));
  assert.equal(body.match(/BDC\n\/\w+ Do/g)?.length, 1, "the logo is not tagged");
  assert.ok(!report.warnings.some((w) => w.code === "figure_without_image"));
  // Retagged, the figure is marked once; left out of the new HTML, its page drawing has no marked content.
  const again = new mupdf.PDFDocument(tag(out, pagesOf("structure")));
  assert.equal(pageBody(again.findPage(0)).match(/\/Figure/g)?.length, 1);
  const none = pageBody(new mupdf.PDFDocument(tag(out, { lang: "en", pages: [] })).findPage(0));
  assert.doesNotMatch(none, /BDC|BMC|EMC/);
  // When the HTML's images and the page's do not pair up, the figure keeps an empty place in the reading order.
  const html = pagesOf("structure").pages[0].html.replace('<img alt="">', '<img alt="">'.repeat(2));
  const r = newReport();
  const odd = new mupdf.PDFDocument(tag(readFixture("structure.pdf"), { ...pagesOf("structure"), pages: [{ sourcePage: 1, html }] }, {}, r));
  assert.match(r.warnings.find((w) => w.code === "figure_without_image")?.detail ?? "", /3 images and the page 2/);
  assert.match(pageBody(odd.findPage(0)), /\/Figure <<\/MCID \d+>> BDC EMC/);
});

test("a content stream that cannot be read is left alone, and its figure is warned", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const page = doc.findPage(0);
  page.put("Contents", [page.get("Contents"), doc.addRawStream("x", { Filter: "FlateDecode", DecodeParms: { Predictor: 2, BitsPerComponent: 7 } })]);
  const r = newReport(), html = pagesOf("text-embedded").pages[0].html + '<img alt="A map">';
  tag(doc.saveToBuffer("").asUint8Array().slice(), { lang: "en", pages: [{ sourcePage: 1, html }] }, {}, r);
  assert.deepEqual(["source_marked_content", "figure_without_image"].map((c) => r.warnings.some((w) => w.code === c)), [true, true]);
});

test("a scan's page image is not a figure; an inline image can be", () => {
  const r = newReport();
  tag(readFixture("scan-300dpi.pdf"), { ...pagesOf("scan-300dpi"), pages: [{ sourcePage: 1, html: '<img alt="A permit">' }] }, {}, r);
  assert.match(r.warnings.find((w) => w.code === "figure_without_image")?.detail ?? "", /1 images and the page 0/);
  const doc = new mupdf.PDFDocument(readFixture("blank-page.pdf"));
  doc.findPage(0).put("Contents", doc.addStream("q 50 0 0 50 10 10 cm BI /W 2 /H 1 /CS /G /BPC 8 ID ab EI Q", {}));
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), { lang: "en", pages: [{ sourcePage: 1, html: '<img alt="A square">' }] }));
  assert.match(pageBody(out.findPage(0)), /\/Figure <<\/MCID 0>> BDC\nBI .* EI\nEMC/s);
});

test("a word running off the page edge keeps every letter of its tagged text", () => {
  // Extractors drop a glyph off the page. The source word is monospaced, so its
  // last letter starts just inside; stretched to the same box, ours would not.
  // So too at the left edge, for its first letter.
  const doc = new mupdf.PDFDocument();
  const res = doc.addObject({ Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")), F2: doc.addSimpleFont(new mupdf.Font("Courier")) } });
  doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, res, "BT /F1 12 Tf 10 200 Td (Thanks) Tj ET BT /F2 12 Tf 276.4 200 Td (Hail) Tj ET BT /F2 12 Tf -4 180 Td (iWall) Tj ET"));
  const report = newReport();
  tag(doc.saveToBuffer("").asUint8Array().slice(), { lang: "en", title: "t", pages: [{ sourcePage: 1, html: "<p>Thanks Hail</p><p>iWall</p>" }] }, {}, report);
  assert.equal(report.verification.textPreserved, true);
});

test("a character no font has is reported and left out, not a verification failure", () => {
  const report = newReport();
  tag(readFixture("text-simple.pdf"), { lang: "en", pages: [{ sourcePage: 1, html: "<h1>Parking Permit 🦄 x🦄</h1>" }] }, {}, report);
  assert.equal(report.warnings.find((w) => w.code === "missing_glyph")?.detail, "🦄");
  assert.equal(report.verification.textPreserved, true);
  const overlay = new Overlay(new FontSet(), mupdf.Matrix.identity);
  overlay.word("🦄", [0, 0, 10, 10], 10, 10);
  assert.doesNotMatch(overlay.toString(), /Tj/, "no .notdef glyph");
  overlay.word("x🦄", [0, 0, 10, 10], 10, 10);
  assert.match(overlay.toString(), /<[0-9a-f]{4}[0-9a-f]{4}> Tj/, "x and a space");
});

test("marked content left from an old tag tree is removed from the page's drawing; elsewhere it is reported and stops the PDF/UA claim", () => {
  const claims = (pdf: Uint8Array) => /pdfuaid:part/.test(new mupdf.PDFDocument(pdf).getTrailer().get("Root", "Metadata").readStream().asString());
  const doc = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const page = doc.findPage(0);
  page.put("Contents", doc.addStream("/P <</MCID 0>> BDC " + page.get("Contents").readStream().asString() + " EMC", {}));
  let report = newReport();
  let out = tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-embedded"), {}, report);
  assert.ok(!report.warnings.some((w) => w.code === "source_marked_content"));
  assert.ok(claims(out));
  // Optional content decides what is drawn, so it stays.
  assert.equal(unmark("/OC /L1 BDC /P <</MCID 0 /Alt (x\\)y)>> BDC 0 0 m EMC EMC /Artifact BMC EMC"), "/OC /L1 BDC   0 0 m   EMC    ");
  // A form XObject is not rewritten: its ids are reported.
  page.get("Resources").put("XObject", { Old: doc.addStream("/P <</MCID 0>> BDC EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }) });
  report = newReport();
  out = tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-embedded"), {}, report);
  assert.match(report.warnings.find((w) => w.code === "source_marked_content")?.detail ?? "", /^Pages 1 /);
  assert.ok(!claims(out));
  // A form XObject that cannot be decoded is not searched, so it counts as marked.
  const bad = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  bad.findPage(0).get("Resources").put("XObject", { Bad: bad.addRawStream("x", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1], Filter: "FlateDecode", DecodeParms: { Predictor: 2, BitsPerComponent: 7 } }) });
  assert.deepEqual(pagesWithMcids(bad), [1]);
  // The same letters in a string are text, not marked content; a named property list is.
  const text = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  text.findPage(0).put("Contents", text.addStream("BT /F1 9 Tf 20 150 Td (Each BDC carries an /MCID entry.) Tj ET", {}));
  assert.deepEqual(pagesWithMcids(text), []);
  text.findPage(0).get("Resources").put("Properties", { MC0: { MCID: 0 } });
  assert.deepEqual(pagesWithMcids(text), [1]);
  const drawing = (...contents: string[]) => {
    const d = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
    d.findPage(0).put("Contents", contents.map((c) => d.addStream(c, {})));
    return pagesWithMcids(d);
  };
  assert.deepEqual(drawing("/Span <</MCID 0 /ActualText (f\\)i)>> BDC EMC"), [1], "a string after the id");
  assert.deepEqual(drawing("/P <</MCID 0", ">> BDC EMC"), [1], "split across streams");
  assert.deepEqual(drawing("BI /W 1 /H 1 ID ( EI /P <</MCID 0>> BDC EMC"), [1], "an unclosed string hides nothing");
  const image = (b: string) => `q BI /W 2 /H 1 /CS /G /BPC 8 ID ${b} EI Q`;
  assert.deepEqual(drawing(`${image("a(")} /P <</MCID 0>> BDC EMC ${image(")b")}`), [1], "image bytes are not strings");
  assert.deepEqual(drawing("% a ( comment\n/P <</MCID 0>> BDC EMC % and )\n"), [1], "nor are comments");
  // A tiling pattern draws too.
  const tiled = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  tiled.findPage(0).get("Resources").put("Pattern", { P0: tiled.addStream("/P <</MCID 0>> BDC EMC", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1 }) });
  assert.deepEqual(pagesWithMcids(tiled), [1]);
  // So does an annotation appearance.
  const annot = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const n = annot.addStream("/P <</MCID 0>> BDC EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] });
  annot.findPage(0).put("Annots", [annot.addObject({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 1, 1], AP: { N: n } })]);
  assert.deepEqual(pagesWithMcids(annot), [1]);
  // An appearance dictionary that holds itself ends the walk, not the run.
  const cycle = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  const self = cycle.addObject({});
  self.put("N", self);
  cycle.findPage(0).put("Annots", [cycle.addObject({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 1, 1], AP: self })]);
  assert.deepEqual([pagesWithMcids(cycle), unembeddedFonts(cycle)], [[], []]);
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
});

test("a blank page needs no HTML and does not cost the PDF/UA claim", () => {
  const { doc, report } = tagFixture("blank-page");
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

  // Annotations PDF/UA does not tag (hidden, no-view, popups) and null entries leave the page blank.
  const exempt: [string, (a: mupdf.PDFObject, d: mupdf.PDFDocument) => void][] = [
    ["hidden", (a) => a.put("F", 2)],
    ["no-view", (a) => a.put("F", 32)],
    ["popup", (a, d) => a.put("Subtype", d.newName("Popup"))],
  ];
  for (const [name, edit] of exempt) {
    const d = new mupdf.PDFDocument(readFixture("blank-page.pdf"));
    d.loadPage(1).createLink([10, 10, 50, 50], "https://example.org");
    const annots = d.findPage(1).get("Annots");
    edit(annots.get(0), d);
    annots.push(null);
    const quiet = newReport();
    tag(d.saveToBuffer("").asUint8Array().slice(), pagesOf("blank-page"), {}, quiet);
    assert.ok(!quiet.warnings.some((w) => w.code === "page_not_in_html"), name);
  }
});

test("a generic link description is marked English in a document that is not", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  doc.loadPage(0).createLink([0, 0, 20, 20], "#page=1");
  const pages = { ...pagesOf("text-simple"), lang: "fr" };
  const out = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), pages));
  const [link] = find(structTree(out), "Link");
  assert.equal(link.dict.get("Lang").asString(), "en");
});

test("a null entry in a tagged page's annotations is skipped", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  doc.findPage(0).put("Annots", [null]);
  const report = newReport();
  tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-simple"), {}, report);
  assert.equal(report.verification.textPreserved, true);
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

test("optional content configurations are named; one with /AS stops the PDF/UA claim", () => {
  const claims = (doc: mupdf.PDFDocument) => /<pdfuaid:part>1</.test(doc.getTrailer().get("Root", "Metadata").readStream().asString());
  const named = new mupdf.PDFDocument(tag(withLayers(), pagesOf("text-embedded"), {}, newReport()));
  const oc = named.getTrailer().get("Root", "OCProperties");
  assert.equal(oc.get("D", "Name").asString(), "Default");
  assert.equal(oc.get("Configs").get(0).get("Name").asString(), "Configuration 1");
  assert.equal(claims(named), true);
  const report = newReport();
  const auto = new mupdf.PDFDocument(tag(withLayers({ AS: [{ Event: "View", Category: ["View"] }] }), pagesOf("text-embedded"), {}, report));
  assert.equal(claims(auto), false);
  assert.ok(report.warnings.some((w) => w.code === "layer_auto_state"));
});

test("with no title there is no PDF/UA claim, and no empty title", () => {
  const pages = { ...pagesOf("text-simple"), title: undefined };
  const report = newReport();
  const doc = new mupdf.PDFDocument(tag(readFixture("text-simple.pdf"), pages, {}, report));
  const root = doc.getTrailer().get("Root");
  assert.ok(report.warnings.some((w) => w.code === "no_title"));
  assert.ok(root.get("ViewerPreferences", "DisplayDocTitle").isNull());
  assert.ok(root.get("Metadata").isNull(), "no packet to write");
  const packet = xmp('<x:xmpmeta><rdf:RDF><rdf:Description><dc:title>Old</dc:title><pdfuaid:part>1</pdfuaid:part></rdf:Description></rdf:RDF></x:xmpmeta>', "", false);
  assert.doesNotMatch(packet, /pdfuaid:part>|<dc:title><rdf:Alt>/);
  assert.match(packet, /Old/, "an old title stays when there is no new one");
});

test("deeply nested form XObjects do not overflow the stack", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-embedded.pdf"));
  let inner = doc.addStream("/P <</MCID 0>> BDC EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] });
  for (let i = 0; i < 20000; i++) inner = doc.addStream("/X Do", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1], Resources: { XObject: { X: inner } } });
  doc.findPage(0).get("Resources").put("XObject", { Deep: inner });
  // Past the depth limit nothing is searched, and the claim is withheld.
  assert.deepEqual(unembeddedFonts(doc), ["(nested too deeply to check)"]);
  assert.deepEqual(pagesWithMcids(doc), [1]);
});

test("a character past U+FFFF in the source text matches the HTML", () => {
  // A ToUnicode surrogate pair, as Word writes math italic: x is 𝑥 (U+1D465).
  const src = new mupdf.PDFDocument();
  const cmap = "begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <78> <D835DC65> endbfchar\nendcmap";
  const font = src.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", ToUnicode: src.addStream(cmap, {}) });
  src.insertPage(-1, src.addPage([0, 0, 612, 792], 0, src.addObject({ Font: { F1: font } }), "BT /F1 24 Tf 72 700 Td (If 2x = 4) Tj ET"));
  const report = newReport();
  const out = tag(src.saveToBuffer("").asUint8Array().slice(), { lang: "en", pages: [{ sourcePage: 1, html: "<p>If 2𝑥 = 4</p>" }] }, {}, report);
  assert.ok(!report.warnings.some((w) => w.code === "unmatched_text"));
  assert.equal(report.pages[0].addedFromHtml, 0);
  // All of it, "=" too, is tagged where it is, and reads back whole.
  assert.equal(report.pages[0].redrawn, 0);
  const doc = new mupdf.PDFDocument(out);
  assert.equal(doc.loadPage(0).toStructuredText("").asText().trim(), "If 2𝑥 = 4");
  assert.equal(find(structTree(doc), "P")[0].text, "If 2𝑥 = 4");
});

test("words sharing a page word split its box across, by length", () => {
  const p = { box: [10, 0, 40, 10] as [number, number, number, number], baseline: 8, size: 10 };
  assert.deepEqual([0, 1].map((k) => share(p, [1, 2], k).box), [[10, 0, 20, 10], [20, 0, 40, 10]]);
  assert.equal(share(p, [3], 0), p);
});

test("math the page writes as one word matches Iris's separate tokens", () => {
  const src = new mupdf.PDFDocument();
  const font = src.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
  src.insertPage(-1, src.addPage([0, 0, 612, 792], 0, src.addObject({ Font: { F1: font } }), "BT /F1 24 Tf 72 700 Td (Solve 5x = 10 now) Tj ET"));
  const report = newReport();
  const html = "<p>Solve <math><mn>5</mn><mi>x</mi><mo>=</mo><mn>10</mn></math> now</p>";
  tag(src.saveToBuffer("").asUint8Array().slice(), { lang: "en", pages: [{ sourcePage: 1, html }] }, {}, report);
  assert.deepEqual([report.pages[0].addedFromHtml, report.pages[0].lost], [0, 0]);
});

// One page drawn with Helvetica from `content`, tagged from `html`.
function tagContent(content: string, html: string) {
  const src = new mupdf.PDFDocument();
  src.insertPage(-1, src.addPage([0, 0, 300, 300], 0, src.addObject({ Font: { F1: src.addSimpleFont(new mupdf.Font("Helvetica")) } }), content));
  const pdf = src.saveToBuffer("").asUint8Array().slice(), report = newReport();
  const doc = new mupdf.PDFDocument(tag(pdf, { lang: "en", title: "t", pages: [{ sourcePage: 1, html }] }, {}, report));
  const text = (d: mupdf.PDFDocument) => d.loadPage(0).toStructuredText("").asText();
  return { doc, report, root: structTree(doc), before: text(new mupdf.PDFDocument(pdf)), after: text(doc) };
}

test("the page's own text is tagged where it is, one show split between elements", () => {
  const { doc, report, root, before, after } = tagContent("BT /F1 12 Tf 20 200 Td (Hello world) Tj ET", "<h1>Hello</h1><p>world</p>");
  assert.deepEqual(root.kids.map((k) => [k.type, k.text]), [["H1", "Hello"], ["P", "world"]]);
  assert.equal(report.pages[0].redrawn, 0);
  assert.equal(after, before, "no word drawn twice");
  assert.equal(report.verification.pixels, "identical-outside-fields");
  assert.ok(!report.warnings.some((w) => w.code === "in_place_failed"));
  assert.doesNotMatch(pageBody(doc.findPage(0)), /3 Tr/, "no empty overlay");
});

test("a word hyphenated across lines is one element part, read as the HTML's word", () => {
  const { root, report } = tagContent("BT /F1 12 Tf 20 200 Td (An exam-) Tj 0 -14 Td (ple today.) Tj ET", "<p>An example today.</p>");
  const span = find(root, "Span")[0];
  assert.equal(span.dict.get("ActualText").asString(), "example");
  assert.equal(readingOrder(root), "An example today.");
  assert.equal(report.pages[0].redrawn, 0);
});

test("a page tagged in place with no overlay gets its own drawing back on a retag", () => {
  const { doc } = tagContent("BT /F1 12 Tf 20 200 Td (Hello world) Tj ET", "<p>Hello world</p>");
  assert.equal(doc.findPage(0).get("Contents").length, 3, "no overlay");
  const again = new mupdf.PDFDocument(tag(doc.saveToBuffer("").asUint8Array().slice(), { lang: "en", pages: [] }));
  assert.doesNotMatch(pageBody(again.findPage(0)), /BDC|BMC|EMC/);
});

test("a word OCR misread is tagged where it is, read as the HTML's word", () => {
  const { root, report } = tagContent("BT /F1 12 Tf 20 200 Td (The forescattered electrons) Tj ET", "<p>The forscattered electrons</p>");
  assert.equal(find(root, "Span")[0].dict.get("ActualText").asString(), "forscattered");
  assert.equal(readingOrder(root), "The forscattered electrons");
  assert.equal(report.pages[0].redrawn, 0);
  // Not over a page word that draws more, or other digits.
  for (const [page, html] of [["See the website.1 now", "See the website. now"], ["Total $1,250.00 due", "Total $1,350.00 due"]]) {
    const r = tagContent(`BT /F1 12 Tf 20 200 Td (${page}) Tj ET`, `<p>${html}</p>`);
    assert.equal(find(r.root, "Span").length, 0, page);
    assert.equal(r.report.pages[0].redrawn, 1, page);
  }
});

// Where the page's quote or dash and the HTML's differ, the HTML is as likely
// wrong, so the page's own is read: no ActualText.
test("a typographic apostrophe matches the HTML's plain one in place, and is read as the page's", () => {
  const { root, report } = tagContent("BT /F1 12 Tf 20 200 Td (Verkamp\\222s store) Tj ET", "<p>Verkamp's store</p>");
  assert.equal(report.pages[0].redrawn, 0);
  assert.equal(readingOrder(root), "Verkamp’s store");
  assert.equal(find(root, "Span").length, 0);
});

test("a dash the HTML writes differently is the page's own, read as the page's", () => {
  const { root, report, after } = tagContent("BT /F1 12 Tf 20 200 Td (Library Hours \\227 Fall Term) Tj ET", "<p>Library Hours – Fall Term</p>");
  assert.equal(readingOrder(root), "Library Hours — Fall Term");
  assert.equal(after.trim(), "Library Hours — Fall Term", "one dash, not two");
  assert.equal(find(root, "Span").length, 0);
  assert.equal(report.pages[0].redrawn, 0);
});

test("lines padded with spaces, one show each, are tagged where they are", () => {
  // As cupsfilter writes plain text: each line one Tj, padded out to the margin.
  const pad = " ".repeat(60);
  const { root, report } = tagContent(`BT /F1 9 Tf 1 0 0 1 20 200 Tm (Lot 5 closes.${pad}) Tj ET BT /F1 9 Tf 1 0 0 1 20 188 Tm (Use Lot 7.${pad}) Tj ET`, "<p>Lot 5 closes.</p><p>Use Lot 7.</p>");
  assert.equal(readingOrder(root), "Lot 5 closes. Use Lot 7.");
  assert.equal(report.pages[0].redrawn, 0);
});

test("operators run together in the source are tagged where they are", () => {
  const { root, report } = tagContent("BT /F1 12 Tf 20 200 Td 0 Tc[(Hello world)]TJ ET", "<p>Hello world</p>");
  assert.equal(readingOrder(root), "Hello world");
  assert.equal(report.pages[0].redrawn, 0);
});

test("a page word that holds several HTML words is split between them", () => {
  const { root, report } = tagContent("BT /F1 12 Tf 20 200 Td (If 2x = 4) Tj ET", "<p>If 2 x = 4</p>");
  assert.equal(readingOrder(root), "If 2x = 4"); // "2" and "x" each own their part of "2x"
  assert.equal(report.pages[0].redrawn, 0);
});

test("only the page number at the page's edge stays an artifact", () => {
  const { root, report } = tagContent("BT /F1 12 Tf 20 200 Td (1. First) Tj ET BT /F1 9 Tf 150 10 Td (1) Tj ET", "<p>1. First</p><p>1</p>");
  assert.equal(readingOrder(root), "1. First 1");
  // The body's "1." is tagged where it is. The HTML's "1" is not the page
  // number: it is added like any word the page lacks, not drawn on top of it.
  assert.deepEqual([report.pages[0].redrawn, report.pages[0].addedFromHtml, report.pages[0].furniture], [0, 1, 1]);
  assert.ok(!report.warnings.some((w) => w.code === "in_place_failed"));
});

test("text drawn invisibly, as OCR leaves it, or only as a clip, is tagged where it is", () => {
  const { doc, root, report } = tagContent("BT 3 Tr /F1 12 Tf 20 200 Td (Hello world) Tj ET q BT 7 Tr /F1 30 Tf 20 100 Td (Clip) Tj ET 0 0 1 rg 0 0 300 300 re f Q",
    "<h1>Hello</h1><p>world</p><p>Clip</p>");
  assert.deepEqual(root.kids.map((k) => k.text), ["Hello", "world", "Clip"]);
  assert.equal(report.pages[0].redrawn, 0);
  assert.match(pageBody(doc.findPage(0)), /3 Tr \/F1 12 Tf.*7 Tr/s);
});

test("marked text is read through named properties too", () => {
  const doc = new mupdf.PDFDocument();
  const res = doc.addObject({ Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) }, Properties: { M0: { MCID: 0 } } });
  doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, res, "/P /M0 BDC BT /F1 12 Tf 20 200 Td (Hello) Tj ET EMC"));
  assert.deepEqual([...mcidText(doc.findPage(0), { doc, index: 0 })], [[0, "Hello"]]);
});

test("link text followed by its period is tagged in place, the period split off", () => {
  const { doc, report } = tagFixture("links");
  assert.equal(report.pages[0].redrawn, 0);
  assert.ok(!report.warnings.some((w) => w.code === "in_place_failed" || w.code === "duplicate_text_layer"));
  assert.match(pageBody(doc.findPage(0)), /\/Link <<\/MCID \d+>> BDC <[0-9a-f]+> Tj\s+EMC\s+\/P <<\/MCID \d+>> BDC <2e> Tj/);
});

test("a page number the HTML matches stays an artifact, and a word the page draws with more is not hidden", () => {
  // structure.pdf draws "website.1"; the HTML's footnote "1" matches the page number.
  const { doc } = tagFixture("structure");
  const body = pageBody(doc.findPage(0));
  assert.match(body, /\nBT \/F1 7 Tf 153 18 Td <0012> Tj ET\n/, "the page number is not rewritten");
  assert.doesNotMatch(body, /ActualText/);
  assert.match(doc.loadPage(0).toStructuredText("").asText(), /website\.1/);
});

test("a run that fails verification in place is tagged again from the overlay, on a fresh report", () => {
  const report = newReport(), tried: boolean[] = [];
  const out = withFallback((inPlace) => {
    tried.push(inPlace);
    report.warnings.push({ code: inPlace ? "text_lost" : "no_title" });
    if (inPlace) throw new IrisPdfError("text_lost", "Page 1 lost text.", 2);
    return "overlay";
  }, report);
  assert.equal(out, "overlay");
  assert.deepEqual(tried, [true, false]);
  assert.deepEqual(report.warnings.map((w) => w.code), ["no_title", "in_place_failed"]);
  // Any other failure is not retried.
  assert.throws(() => withFallback(() => { throw new IrisPdfError("too_many_words", "x"); }, newReport()), { code: "too_many_words" });
});

test("a page whose content is too long to trace is tagged from the overlay", () => {
  const doc = new mupdf.PDFDocument(readFixture("text-simple.pdf"));
  const page = doc.findPage(0);
  page.put("Contents", doc.addStream(page.get("Contents").readStream().asString() + " ".repeat(4 << 20), {}));
  const report = newReport();
  tag(doc.saveToBuffer("").asUint8Array().slice(), pagesOf("text-simple"), {}, report);
  assert.equal(report.pages[0].redrawn, report.pages[0].matched);
});

// Builds the test corpus. Every fixture is generated here, so all of them can
// be redistributed and none holds real personal data. Run: npm run fixtures
import * as mupdf from "mupdf";
import { writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const W = 306, H = 396; // half-letter: small files, fast tests

// A PDF string literal, escaped.
const lit = (s: string) => "(" + s.replace(/[\\()]/g, (c) => "\\" + c) + ")";
const show = (x: number, y: number, size: number, s: string, font = "F1") =>
  `BT /${font} ${size} Tf ${x} ${y} Td ${lit(s)} Tj ET\n`;

const helv = new mupdf.Font("Helvetica");
const width = (s: string, size: number) => [...s].reduce((w, c) => w + helv.advanceGlyph(helv.encodeCharacter(c)), 0) * size;

// A base-14 font that is not embedded, like most real-world untagged PDFs.
function helvetica(doc: mupdf.PDFDocument, bold = false) {
  return doc.addObject({
    Type: "Font", Subtype: "Type1", BaseFont: bold ? "Helvetica-Bold" : "Helvetica", Encoding: "WinAnsiEncoding",
  });
}

// embed: embedded fonts, as PDF/UA requires, so the file can reach the claim.
// mupdf embeds only composite fonts, so each string is rewritten as glyph ids.
function textDoc(pages: string[], embed = false): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  if (!embed) {
    const res = doc.addObject({ Font: { F1: helvetica(doc), F2: helvetica(doc, true) } });
    for (const c of pages) doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, c));
    return doc;
  }
  const fonts = { F1: new mupdf.Font("Helvetica"), F2: new mupdf.Font("Helvetica-Bold") };
  const res = doc.addObject({ Font: { F1: doc.addFont(fonts.F1), F2: doc.addFont(fonts.F2) } });
  const gids = (font: mupdf.Font, s: string) => "<" + [...s].map((c) => font.encodeCharacter(c).toString(16).padStart(4, "0")).join("") + ">";
  const unlit = (s: string) => s.slice(1, -1).replace(/\\(.)/g, "$1");
  for (const c of pages) {
    const content = c.replace(/\/(F[12]) ([\d.]+) Tf (.*?) (\((?:\\.|[^\\)])*\)) Tj/g,
      (_, f: "F1" | "F2", size, td, str) => `/${f} ${size} Tf ${td} ${gids(fonts[f], unlit(str))} Tj`);
    doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, content));
  }
  doc.subsetFonts();
  return doc;
}

function save(name: string, doc: mupdf.PDFDocument, options = "compress") {
  writeFileSync(dir + name, doc.saveToBuffer(options).asUint8Array());
}

function pagesJson(name: string, pages: { sourcePage: number; html: string }[], extra = {}) {
  writeFileSync(dir + name, JSON.stringify({ lang: "en", title: "Test document", ...extra, pages }, null, 2) + "\n");
}

// Running head, page number: the furniture Iris strips from its HTML.
const furniture = (n: number) => show(20, H - 20, 7, "City Permit Office") + show(W / 2, 18, 7, String(n));

// --- text-simple -------------------------------------------------------------
const simple =
  furniture(1) +
  show(20, 340, 16, "Parking Permit", "F2") +
  show(20, 315, 9, "Residents may apply for one parking permit per car.") +
  show(20, 303, 9, "Bring proof of address to the permit office.") +
  show(20, 280, 12, "Fees", "F2") +
  show(20, 262, 9, "A permit costs twenty dollars a year.");
const simpleHtml =
  "<h1>Parking Permit</h1><p>Residents may apply for one parking permit per car. " +
  "Bring proof of address to the permit office.</p><h2>Fees</h2><p>A permit costs twenty dollars a year.</p>";
save("text-simple.pdf", textDoc([simple]));
pagesJson("text-simple.pages.json", [{ sourcePage: 1, html: simpleHtml }]);

// --- text-embedded: text-simple with its fonts embedded.
save("text-embedded.pdf", textDoc([simple], true));
pagesJson("text-embedded.pages.json", [{ sourcePage: 1, html: simpleHtml }]);

// --- text-two-column: operators run across the columns line by line, so the
// PDF's own order interleaves them. Iris's HTML reads left column first.
const left = ["The library opens at nine", "every weekday morning and", "closes at six in the evening."];
const right = ["Books may be renewed", "twice by phone or online", "before the due date."];
let twoCol = furniture(1) + show(20, 350, 14, "Library Hours", "F2");
for (let i = 0; i < 3; i++) twoCol += show(20, 320 - i * 12, 9, left[i]) + show(165, 320 - i * 12, 9, right[i]);
save("text-two-column.pdf", textDoc([twoCol]));
pagesJson("text-two-column.pages.json", [{
  sourcePage: 1,
  html: `<h1>Library Hours</h1><p>${left.join(" ")}</p><p>${right.join(" ")}</p>`,
}]);

// --- scans: the text page rendered to an image, so there is no text layer.
function scanDoc(sources: mupdf.PDFDocument[], rotate = 0): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  for (const src of sources) {
    const page = src.loadPage(0);
    const m = mupdf.Matrix.concat(mupdf.Matrix.scale(300 / 72, 300 / 72), mupdf.Matrix.rotate(rotate));
    const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceGray, false);
    const img = doc.addImage(new mupdf.Image(pix.asJPEG(70)));
    const res = doc.addObject({ XObject: { Im0: img } });
    // Rotated scans come out larger than the page; fit them back onto it.
    const s = Math.min(W / (pix.getWidth() * 72 / 300), H / (pix.getHeight() * 72 / 300));
    const w = pix.getWidth() * 72 / 300 * s, h = pix.getHeight() * 72 / 300 * s;
    doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, `q ${w} 0 0 ${h} 0 ${H - h} cm /Im0 Do Q\n`));
  }
  return doc;
}
save("scan-300dpi.pdf", scanDoc([textDoc([simple])]));
pagesJson("scan-300dpi.pages.json", [{ sourcePage: 1, html: simpleHtml }]);
save("scan-skewed.pdf", scanDoc([textDoc([simple])], 1.5));
pagesJson("scan-skewed.pages.json", [{ sourcePage: 1, html: simpleHtml }]);

// --- mixed: page 1 born-digital, page 2 scanned.
const mixedPage2 =
  furniture(2) + show(20, 340, 14, "Office Address", "F2") + show(20, 315, 9, "The permit office is on Main Street.");
{
  const doc = textDoc([simple]);
  const scan = scanDoc([textDoc([mixedPage2])]);
  doc.graftPage(-1, scan, 0);
  save("mixed.pdf", doc);
}
pagesJson("mixed.pages.json", [
  { sourcePage: 1, html: simpleHtml },
  { sourcePage: 2, html: "<h2>Office Address</h2><p>The permit office is on Main Street.</p>" },
]);

// --- blank-page: page 2 is empty, and Iris sends no HTML for it.
save("blank-page.pdf", textDoc([simple, ""], true));
pagesJson("blank-page.pages.json", [{ sourcePage: 1, html: simpleHtml }]);

// --- links: a link annotation over its text.
{
  const doc = textDoc([
    furniture(1) + show(20, 340, 14, "Contact", "F2") + show(20, 315, 9, "Apply online at the city website."),
  ]);
  const page = doc.loadPage(0);
  // The link covers "the city website", which follows "Apply online at ".
  const x0 = 20 + width("Apply online at ", 9), x1 = x0 + width("the city website", 9);
  const annot = doc.addObject({
    Type: "Annot", Subtype: "Link", Rect: [x0, 312, x1, 323], Border: [0, 0, 0],
    A: { S: "URI", URI: doc.newString("https://example.org/permits") },
  });
  page.getObject().put("Annots", [annot]);
  save("links.pdf", doc);
}
pagesJson("links.pages.json", [{
  sourcePage: 1,
  html: '<h1>Contact</h1><p>Apply online at <a href="https://example.org/permits">the city website</a>.</p>',
}]);

// --- cjk: a non-Latin script, with an embedded CJK font.
{
  const doc = new mupdf.PDFDocument();
  const cjk = doc.addCJKFont(new mupdf.Font("zh-Hans"), "zh-Hans");
  const res = doc.addObject({ Font: { F1: cjk } });
  // Identity-H with UCS-2 code points, which is how mupdf's CJK fonts are encoded.
  const hex = (s: string) => "<" + [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0")).join("") + ">";
  doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res,
    `BT /F1 16 Tf 20 340 Td ${hex("停车许可证")} Tj ET\nBT /F1 10 Tf 20 315 Td ${hex("每辆车可申请一张许可证")} Tj ET\n`));
  save("cjk.pdf", doc);
}
pagesJson("cjk.pages.json", [{ sourcePage: 1, html: "<h1>停车许可证</h1><p>每辆车可申请一张许可证</p>" }], { lang: "zh-Hans" });

// --- form-acroform: text, checkbox, radio group, combo box, a read-only
// field, a push button and an unsigned signature field.
function formDoc(signed: boolean): mupdf.PDFDocument {
  const doc = textDoc([
    furniture(1) + show(20, 340, 14, "Permit Application", "F2") +
    show(20, 312, 9, "Full name") + show(20, 287, 9, "I agree to the terms") +
    show(20, 262, 9, "Contact me by") + show(110, 262, 9, "Email") + show(170, 262, 9, "Phone") +
    show(20, 237, 9, "State") + show(20, 212, 9, "Office code") + show(20, 187, 9, "Signature"),
  ]);
  const page = doc.loadPage(0);
  const pageRef = page.getObject();
  const helv = helvetica(doc);
  // mupdf turns a bare JS string into a PDF name; field names and values are strings.
  const s = (v: string) => doc.newString(v);
  const box = (on: boolean) => doc.addStream(on ? "0 g 2 2 m 8 8 l 2 8 m 8 2 l S\n" : "", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10],
  });
  const widget = (extra: object) => doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pageRef, ...extra });

  const applicant = doc.addObject({ T: s("applicant"), Kids: [] });
  const name = widget({ FT: "Tx", T: s("name"), Parent: applicant, Rect: [110, 308, 290, 322], DA: s("/Helv 9 Tf 0 g"), MaxLen: 40 });
  const consent = widget({
    FT: "Btn", T: s("consent"), Parent: applicant, Rect: [110, 285, 120, 295], V: "Off", AS: "Off",
    AP: { N: { Agree: box(true), Off: box(false) } },
  });
  applicant.get("Kids").push(name);
  applicant.get("Kids").push(consent);

  const contact = doc.addObject({ FT: "Btn", T: s("contact"), Ff: 1 << 15, V: "Off", Kids: [] });
  for (const [x, state] of [[98, "email"], [158, "phone"]] as const) {
    const w = widget({ Parent: contact, Rect: [x, 260, x + 10, 270], AS: "Off", AP: { N: { [state]: box(true), Off: box(false) } } });
    contact.get("Kids").push(w);
  }
  const state = widget({ FT: "Ch", T: s("state"), Ff: 1 << 17, Opt: ["IL", "IN", "WI"].map(s), Rect: [110, 233, 160, 247], DA: s("/Helv 9 Tf 0 g") });
  const office = widget({ FT: "Tx", T: s("office"), Ff: 1, V: s("A-12"), Rect: [110, 208, 160, 222], DA: s("/Helv 9 Tf 0 g") });
  const reset = widget({ FT: "Btn", T: s("reset"), Ff: 1 << 16, Rect: [200, 208, 290, 222] });
  const sigV = signed ? { V: doc.addObject({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 0, 0, 0] }) } : {};
  const sig = widget({ FT: "Sig", T: s("signature"), Rect: [110, 183, 290, 197], ...sigV });

  const kids = [name, consent, ...[0, 1].map((i) => contact.get("Kids").get(i)), state, office, reset, sig];
  pageRef.put("Annots", kids);
  doc.getTrailer().get("Root").put("AcroForm", doc.addObject({
    Fields: [applicant, contact, state, office, reset, sig], DA: s("/Helv 0 Tf 0 g"), DR: { Font: { Helv: helv } },
    ...(signed ? { SigFlags: 3 } : {}),
  }));
  // Let mupdf draw the text and choice appearances once, as a form author's tool would.
  for (const w of doc.loadPage(0).getWidgets()) if (w.isText() || w.isChoice()) w.update();
  return doc;
}
save("form-acroform.pdf", formDoc(false));
pagesJson("form-acroform.pages.json", [{
  sourcePage: 1,
  html:
    "<h1>Permit Application</h1><form>" +
    '<p><label for="n">Full name</label> <input id="n" name="applicant.name"></p>' +
    '<p><input type="checkbox" id="c" name="applicant.consent"> <label for="c">I agree to the terms</label></p>' +
    '<fieldset><legend>Contact me by</legend>' +
    '<input type="radio" id="e" name="contact" value="email"> <label for="e">Email</label> ' +
    '<input type="radio" id="p" name="contact" value="phone"> <label for="p">Phone</label></fieldset>' +
    '<p><label for="s">State</label> <select id="s" name="state"><option>IL</option><option>IN</option><option>WI</option></select></p>' +
    '<p><label for="o">Office code</label> <input id="o" name="office" readonly value="A-12"></p>' +
    '<p><label for="g">Signature</label> <input id="g" name="signature"></p></form>',
}]);
save("signed.pdf", formDoc(true));

// --- form-flat: a scanned-style form, lines and labels, no fields.
save("form-flat.pdf", textDoc([
  furniture(1) + show(20, 340, 14, "Permit Application", "F2") + show(20, 312, 9, "Full name") +
  "0 G 0.5 w 110 310 m 290 310 l S\n",
]));
pagesJson("form-flat.pages.json", [{
  sourcePage: 1, html: '<h1>Permit Application</h1><form><p><label for="n">Full name</label> <input id="n" name="name"></p></form>',
}]);

// --- encrypted: needs a password to open. restricted: opens, but the owner
// has forbidden changes (permissions: print, copy, extract only).
save("encrypted.pdf", textDoc([simple]), "encrypt=aes-256,user-password=open,owner-password=owner");
save("restricted.pdf", textDoc([simple]), "encrypt=aes-256,owner-password=owner,permissions=-1321");

console.log("fixtures written to", dir);

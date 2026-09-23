// tag(): the original PDF plus Iris's HTML -> the same PDF, tagged, with any
// form values filled in, checked to render identically (spec §7).
import * as mupdf from "mupdf";
import { openPdf, save, type OpenOptions } from "./pdf/document.ts";
import { artifactStreams, drawsNothing, Overlay } from "./pdf/content.ts";
import { FontSet } from "./pdf/fonts.ts";
import { StructTree } from "./pdf/struct.ts";
import { setDocumentInfo } from "./pdf/metadata.ts";
import { textLayerWords } from "./pdf/words.ts";
import { allWidgets, checkValues, inventory, onStates, setValues, type FormValue, type Widget } from "./pdf/widgets.ts";
import { buildPage, isRun, wordsInOrder, type Node, type Placed, type Run, type Word } from "./html/build.ts";
import { joinHyphenated, type Box, type PageWord } from "./align/words.ts";
import { align, MAX_WORDS } from "./align/align.ts";
import { isFurniture } from "./align/classify.ts";
import { ocrWords, tesseractInstalled } from "./ocr/tesseract.ts";
import { comparePixels } from "./verify/pixels.ts";
import { compareText } from "./verify/text.ts";
import { EXIT, IrisPdfError, newReport, type PageReport, type Report, type Warning } from "./report.ts";

export type PagesInput = { lang?: string; title?: string; pages: { sourcePage: number; html: string }[] };

export type TagOptions = OpenOptions & {
  values?: Record<string, FormValue>;
  lang?: string;
  title?: string;
  ocr?: "auto" | "off" | "required";
  verify?: boolean;
  verifyDpi?: number;
  flatten?: boolean;
  partial?: boolean;
  strict?: boolean;
};

// With --strict these fail the run instead of only being reported.
const STRICT = ["no_title", "page_not_in_html", "unmatched_text", "missing_glyph", "missing_alt", "unmapped_element", "field_not_in_html", "field_not_in_pdf", "unmatched_link", "alignment_incomplete", "page_not_tagged"];

// Throws IrisPdfError. `report` is filled in as far as the run got, either way.
export function tag(pdf: Uint8Array, input: PagesInput, opts: TagOptions = {}, report: Report = newReport()): Uint8Array {
  const src = openPdf(pdf, opts);
  const { doc } = src;
  const warn = (w: Warning) => report.warnings.push(w);
  src.warnings.forEach(warn);
  const pageCount = doc.countPages();
  report.source = { pages: pageCount, encrypted: src.encrypted, signed: src.signed, acroform: src.acroform, xfa: src.xfa, hadTextLayer: [] };
  if (src.xfa) {
    // A hybrid form also carries a plain AcroForm, which is what we fill and tag.
    doc.getTrailer().get("Root", "AcroForm").delete("XFA");
    warn({ code: "xfa_removed", detail: "The XFA version of the form was removed; the AcroForm remains." });
  }

  const html = pagesByIndex(input, pageCount);
  const lang = input.lang || opts.lang;
  if (!lang) throw new IrisPdfError("no_document_language", "No document language. Iris gave none; pass --lang.", EXIT.badInput);
  const title = input.title || opts.title || doc.getMetaData("info:Title");
  if (!title) warn({ code: "no_title", detail: "No document title. Pass --title." });
  const ocr = opts.ocr ?? "auto";
  if (ocr === "required" && !tesseractInstalled()) throw new IrisPdfError("no_text_positions", "Tesseract is not installed, and --ocr required was given.");

  // Forms: check every value, then set them, then flatten if asked.
  const fields = inventory(doc);
  const values = opts.values ?? {};
  checkValues(fields, values).forEach(warn);
  const filled = setValues(doc, fields, values);
  report.form = { fields: fields.length, set: filled.set, skippedReadOnly: filled.skippedReadOnly, unresolved: [] };
  const widgets = allWidgets(doc).map((w) => ({ ...w, box: w.widget.getBounds() as Box, used: false }));
  if (opts.flatten) doc.bake(false, true);

  const struct = new StructTree(doc);
  const fonts = new FontSet();
  const written: { page: mupdf.PDFObject; overlay: string }[] = [];
  const overlayText = new Map<number, string>(); // per page index
  let untagged = 0; // pages left as they were
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    if (!html.has(i)) {
      // Nothing says what this page holds, so it is left exactly as it was.
      // A blank page with no annotations to tag needs no tags, so it is not a warning.
      const blank = drawsNothing(page) && !needTags(page.getObject().get("Annots"));
      if (!blank) warn({ code: "page_not_in_html", page: i + 1, detail: "pages.json has no HTML for this page; it was left untagged." });
      report.pages.push({ page: i + 1, textSource: "none", words: 0, matched: 0, addedFromHtml: 0, furniture: 0, lost: 0, mcids: 0 });
      if (!blank) untagged++;
      continue;
    }
    const r = tagPage(page, i, html.get(i)!, {
      doc, struct, fonts, lang, ocr, partial: !!opts.partial, flatten: !!opts.flatten, warn,
      widgets: widgets.filter((w) => w.page === i), allWidgets: widgets, values, fields,
    });
    report.pages.push(r.report);
    if (r.untagged) untagged++;
    if (r.report.textSource === "pdf-text") {
      report.source.hadTextLayer.push(i + 1);
      warn({ code: "duplicate_text_layer", page: i + 1, detail: "This page's text now exists twice; plain text extractors may show it doubled." });
    }
    if (r.overlay !== null) {
      written.push({ page: page.getObject(), overlay: r.overlay.ops });
      overlayText.set(i, r.overlay.text);
    }
  }
  for (const w of widgets) if (!w.used) report.form.unresolved.push(w.name);

  // Fonts go in last, as one subset holding every glyph the overlays use.
  const fontRefs = fonts.embed(doc, written.map((w) => w.overlay));
  for (const { page, overlay } of written) {
    const res = ownResources(doc, page);
    for (const [name, ref] of Object.entries(fontRefs)) res.get("Font").put(name, ref);
    page.put("Contents", [...artifactStreams(doc, page), doc.addStream(overlay, {})]);
  }
  if (fonts.missing.size) warn({ code: "missing_glyph", detail: [...fonts.missing].join("") });
  struct.finish();
  report.structure = { elements: struct.elements, byType: struct.byType };
  setDocumentInfo(doc, lang, title ?? "", !!title && !untagged);

  const out = save(doc);
  report.sizeIncreaseBytes = out.length - pdf.length;
  if (opts.verify !== false) verify(pdf, out, opts, filled.changed, overlayText, report);
  const strict = report.warnings.filter((w) => STRICT.includes(w.code));
  if (opts.strict && strict.length) {
    throw new IrisPdfError("strict", `--strict: ${[...new Set(strict.map((w) => w.code))].join(", ")}`);
  }
  return out;
}

// PDF/UA-1 7.18.1, 7.18.3: hidden annotations and popups are not tagged.
function needTags(annots: mupdf.PDFObject): boolean {
  let any = false;
  if (annots.isArray()) annots.forEach((a) => {
    if (!a.isDictionary()) return; // a null entry
    const flags = a.get("F").isNumber() ? a.get("F").asNumber() : 0;
    if (a.get("Subtype").asName() !== "Popup" && !(flags & (2 | 32))) any = true;
  });
  return any;
}

type PageCtx = {
  doc: mupdf.PDFDocument;
  struct: StructTree;
  fonts: FontSet;
  lang: string;
  ocr: "auto" | "off" | "required";
  partial: boolean;
  flatten: boolean;
  warn: (w: Warning) => void;
  widgets: (Widget & { box: Box; used: boolean })[]; // this page's
  allWidgets: (Widget & { box: Box; used: boolean })[];
  values: Record<string, FormValue>;
  fields: ReturnType<typeof inventory>;
};

// One page: find its words, align Iris's words to them, write the overlay and
// the page's part of the structure tree. overlay is null if the page is left alone.
function tagPage(page: mupdf.PDFPage, i: number, html: string, ctx: PageCtx): { report: PageReport; overlay: { ops: string; text: string } | null; untagged?: boolean } {
  const n = i + 1;
  const warn = (w: Warning) => ctx.warn({ page: n, ...w });
  const plan = buildPage(html, ctx.lang, `p${n}-`, warn);
  const ordered = wordsInOrder(plan);
  const report: PageReport = { page: n, textSource: "none", words: 0, matched: 0, addedFromHtml: 0, furniture: 0, lost: 0, mcids: 0 };

  let words: PageWord[] = textLayerWords(page);
  if (words.length) report.textSource = "pdf-text";
  else if (ordered.length) {
    const ocr = ctx.ocr === "off" ? null : ocrWords(page);
    if (!ocr) {
      const why = ctx.ocr === "off" ? "OCR is off" : "Tesseract is not installed";
      if (!ctx.partial) throw new IrisPdfError("no_text_positions", `Page ${n} has no text layer and ${why}.`);
      warn({ code: "no_text_positions", detail: `${why}; the page was left untagged.` });
      return { report, overlay: null, untagged: true };
    }
    words = ocr;
    report.textSource = "ocr";
  }
  // Text drawn inside a form field belongs to the field, which is tagged by reference.
  const inField = (w: PageWord) => ctx.widgets.some((f) => overlaps(f.box, w.box, 0.5));
  words = words.filter((w) => !inField(w));
  report.words = words.length;

  // Align, then place every HTML word: on its page word, or beside its neighbour.
  const tokens = joinHyphenated(words);
  if (Math.max(ordered.length, tokens.length) > MAX_WORDS)
    throw new IrisPdfError("too_many_words", `Page ${n} has more than ${MAX_WORDS} words.`);
  const { match, complete } = align(ordered.map((o) => o.word.norm), tokens.map((t) => t.norm));
  if (!complete) warn({ code: "alignment_incomplete", detail: "The page and the HTML differ too much to match every word in time." });
  const blockOf = new Map<number, number>();
  match.forEach((t, k) => {
    if (t < 0) {
      if (ordered[k].word.norm) report.addedFromHtml++; // punctuation is not a word
      return;
    }
    report.matched++;
    ordered[k].word.at = placed(words[tokens[t].words[0]]);
    blockOf.set(t, ordered[k].block);
  });
  const bounds = page.getBounds();
  fillPositions(ordered.map((o) => o.word), { box: [bounds[0] + 10, bounds[1] + 10, bounds[0] + 10, bounds[1] + 20], baseline: bounds[1] + 20, size: 10 });

  // Page words Iris left out: furniture, or lost content reported and kept as a P.
  const lost = new Map<number, Run[]>(); // after which top-level block
  let block = -1, run: Run | null = null;
  tokens.forEach((t, k) => {
    if (blockOf.has(k)) return void ((block = blockOf.get(k)!), (run = null));
    for (const w of t.words.map((j) => words[j])) {
      if (isFurniture(w, bounds[3] - bounds[1], n)) {
        report.furniture++;
        continue;
      }
      report.lost++;
      if (!run) lost.set(block, [...(lost.get(block) ?? []), (run = { words: [] })]);
      run.words.push({ text: w.text, norm: "", at: placed(w) });
    }
  });
  for (const runs of lost.values()) {
    warn({ code: "unmatched_text", detail: runs.map((r) => r.words.map((w) => w.text).join(" ")).join(" / ") });
  }
  const kids: (Node | Run)[] = [...(lost.get(-1) ?? []).map(asP)];
  plan.kids.forEach((k, b) => kids.push(k, ...(lost.get(b) ?? []).map(asP)));

  const pageObj = page.getObject();
  const overlay = new Overlay(ctx.fonts, page.getTransform());
  const links = linkAnnots(page);
  const e: Emitter = { ...ctx, pageObj, overlay, links, warn, mcids: 0 };
  for (const k of kids) emit(k as Node, ctx.struct.top, e);

  // Annotations that Iris's HTML did not mention still need a place in the tree.
  for (const l of links.filter((l) => !l.used)) {
    // Its description: the words under it, else its address, else a generic
    // English phrase, marked as English so it is read as such.
    const under = words.filter((w) => overlaps(l.box, w.box, 0.3)).map((w) => w.text).join(" ");
    const generic = !l.obj.get("Contents").isString() && !under && !l.uri;
    const elem = ctx.struct.add(ctx.struct.top, "Link", generic && !ctx.lang.startsWith("en") ? { Lang: ctx.doc.newString("en") } : {});
    ctx.struct.objr(elem, pageObj, l.obj);
    if (l.obj.get("Contents").isNull()) l.obj.put("Contents", ctx.doc.newString(under || l.uri || "Link to another part of this document"));
    warn({ code: "unmatched_link", detail: l.uri || "internal link" });
  }
  for (const w of ctx.widgets.filter((w) => !w.used && !ctx.flatten)) {
    const elem = ctx.struct.add(ctx.struct.top, "Form");
    ctx.struct.objr(elem, pageObj, w.widget.getObject());
    w.used = true;
    warn({ code: "field_not_in_html", detail: w.name });
  }
  if (!pageObj.get("Annots").isNull()) pageObj.put("Tabs", ctx.doc.newName("S"));
  report.mcids = e.mcids;
  if (!e.mcids) {
    // Nothing to tag. A page that draws something is left as it was, not hidden as an artifact.
    if (drawsNothing(page)) return { report, overlay: null };
    warn({ code: "page_not_tagged", detail: "The HTML for this page holds nothing to tag; it was left untagged." });
    return { report, overlay: null, untagged: true };
  }
  return { report, overlay: { ops: overlay.toString(), text: overlay.text } };
}

type Link = { obj: mupdf.PDFObject; box: Box; uri: string; used: boolean };
type Emitter = PageCtx & { pageObj: mupdf.PDFObject; overlay: Overlay; links: Link[]; mcids: number };

const asP = (r: Run): Node => ({ type: "P", kids: [r] });
const placed = (w: PageWord): Placed => ({ box: w.box, baseline: w.baseline, size: w.size });

// An HTML word with no page word sits just after the word before it, or
// before the first placed word, or at the page's top left.
function fillPositions(words: Word[], fallback: Placed) {
  const first = words.find((w) => w.at)?.at ?? fallback;
  let prev: Placed | null = null;
  for (const w of words) {
    if (w.at) prev = w.at;
    else if (prev) w.at = { ...prev, box: [prev.box[2], prev.box[1], prev.box[2], prev.box[3]] };
    else w.at = { ...first, box: [first.box[0], first.box[1], first.box[0], first.box[3]] };
  }
}

function emit(n: Node, parent: mupdf.PDFObject, e: Emitter) {
  const { doc, struct } = e;
  if (n.type === "Form") return emitField(n, parent, e);
  const extra: Record<string, unknown> = {};
  if (n.alt) extra.Alt = doc.newString(n.alt);
  if (n.title) extra.T = doc.newString(n.title);
  if (n.lang) extra.Lang = doc.newString(n.lang);
  if (n.attrs || n.headers) extra.A = { ...n.attrs, ...(n.headers ? { O: "Table", Headers: n.headers.map((h) => doc.newString(h)) } : {}) };
  const elem = struct.add(parent, n.type, extra);
  if (n.id) struct.id(elem, n.id);
  for (const k of n.kids) {
    if (isRun(k)) writeRun(n.type, elem, k.words, e);
    else emit(k, elem, e);
  }
  if (n.type === "Figure" && !n.kids.length) {
    e.overlay.empty("Figure", struct.mcid(elem, e.pageObj));
    e.mcids++;
  }
  if (n.type === "Link") linkAnnotation(n, elem, e);
}

function writeRun(type: string, elem: mupdf.PDFObject, words: Word[], e: Emitter) {
  const mcid = e.struct.mcid(elem, e.pageObj);
  e.mcids++;
  e.overlay.begin(type, mcid);
  for (const w of words) e.overlay.word(w.text, w.at!.box, w.at!.baseline, w.at!.size, w.space ?? true);
  e.overlay.end();
}

// A Link element owns its annotation: the one under its words, or else the
// first unused one with the same address.
function linkAnnotation(n: Node, elem: mupdf.PDFObject, e: Emitter) {
  const boxes = n.kids.flatMap((k) => (isRun(k) ? k.words.map((w) => w.at!.box) : []));
  const link =
    e.links.find((l) => !l.used && boxes.some((b) => overlaps(l.box, b, 0.3))) ??
    e.links.find((l) => !l.used && l.uri && l.uri === n.href);
  if (!link) return e.warn({ code: "link_not_on_page", detail: n.href });
  link.used = true;
  e.struct.objr(elem, e.pageObj, link.obj);
  const text = n.kids.flatMap((k) => (isRun(k) ? k.words.map((w) => w.text) : [])).join(" ");
  if (link.obj.get("Contents").isNull() && text) link.obj.put("Contents", e.doc.newString(text));
}

// An <input>: a Form element owning its widgets, which get the label as /TU.
// Flattened, the widget is gone and a P carries the value instead.
function emitField(n: Node, parent: mupdf.PDFObject, e: Emitter) {
  const f = n.form!;
  const mine = e.widgets.filter((w) => w.name === f.name && !w.used && (!f.value || onStates(w.widget).includes(f.value)));
  if (!mine.length) {
    const code = e.allWidgets.some((w) => w.name === f.name) ? "field_on_other_page" : "field_not_in_pdf";
    return e.warn({ code, detail: f.name });
  }
  mine.forEach((w) => (w.used = true));
  if (e.flatten) {
    const text = fieldText(mine[0], f.value);
    if (!text) return;
    const at = { box: mine[0].box, baseline: mine[0].box[3] - 2, size: Math.min(12, mine[0].box[3] - mine[0].box[1]) };
    const elem = e.struct.add(parent, "P", f.label ? { Alt: e.doc.newString(f.label) } : {});
    return writeRun("P", elem, [{ text, norm: "", at }], e);
  }
  const elem = e.struct.add(parent, "Form", f.label ? { Alt: e.doc.newString(f.label) } : {});
  const name = f.group || f.label;
  for (const w of mine) {
    e.struct.objr(elem, e.pageObj, w.widget.getObject());
    if (name) w.field.put("TU", e.doc.newString(name));
  }
}

// The value a flattened field shows, as text.
function fieldText(w: Widget, state?: string): string {
  const v = w.field.get("V");
  if (w.widget.isCheckbox() || w.widget.isRadioButton()) {
    const on = w.widget.getObject().get("AS");
    return on.isName() && on.asName() !== "Off" && (!state || on.asName() === state) ? on.asName() : "";
  }
  if (v.isArray()) {
    const out: string[] = [];
    v.forEach((x) => { out.push(x.asString()); });
    return out.join(", ");
  }
  return v.isString() ? v.asString() : "";
}

function linkAnnots(page: mupdf.PDFPage): Link[] {
  const out: Link[] = [];
  const m = page.getTransform();
  const annots = page.getObject().get("Annots");
  if (!annots.isArray()) return out;
  annots.forEach((a) => {
    if (!a.isDictionary() || a.get("Subtype").asName() !== "Link") return;
    const r = a.get("Rect");
    const box = mupdf.Rect.transform([0, 1, 2, 3].map((k) => r.get(k).asNumber()) as Box, m) as Box;
    const uri = a.get("A", "URI");
    out.push({ obj: a, box, uri: uri.isString() ? uri.asString() : "", used: false });
  });
  return out;
}

// True if at least `share` of b's area lies inside a.
function overlaps(a: Box, b: Box, share: number): boolean {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const area = Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]));
  return w > 0 && h > 0 && (w * h) / area >= share;
}

// The page's /Resources as its own direct dictionary, so adding our font never
// changes a dictionary another page shares or inherits.
function ownResources(doc: mupdf.PDFDocument, page: mupdf.PDFObject): mupdf.PDFObject {
  const copy = (from: mupdf.PDFObject) => {
    const d = doc.newDictionary();
    if (from.isDictionary()) from.forEach((v, k) => { d.put(k, v); });
    return d;
  };
  const res = copy(page.getInheritable("Resources"));
  res.put("Font", copy(res.get("Font")));
  page.put("Resources", res);
  return res;
}

function pagesByIndex(input: PagesInput, pageCount: number): Map<number, string> {
  const bad = (why: string) => new IrisPdfError("bad_pages", `pages.json: ${why}`, EXIT.badInput);
  if (!input || !Array.isArray(input.pages)) throw bad("needs a pages array.");
  const out = new Map<number, string>();
  for (const p of input.pages) {
    if (!Number.isInteger(p?.sourcePage) || p.sourcePage < 1 || p.sourcePage > pageCount) {
      throw bad(`sourcePage ${p?.sourcePage} is not a page of this ${pageCount}-page PDF.`);
    }
    if (typeof p.html !== "string") throw bad(`page ${p.sourcePage} has no html string.`);
    if (out.has(p.sourcePage - 1)) throw bad(`page ${p.sourcePage} appears twice.`);
    out.set(p.sourcePage - 1, p.html);
  }
  return out;
}

function verify(pdf: Uint8Array, out: Uint8Array, opts: TagOptions, changed: Map<number, Box[]>, added: Map<number, string>, report: Report) {
  const open = (b: Uint8Array) => {
    const d = new mupdf.PDFDocument(b);
    if (d.needsPassword()) d.authenticatePassword(opts.password ?? "");
    return d;
  };
  const before = open(pdf), after = open(out);
  const pixels = comparePixels(before, after, opts.verifyDpi ?? 150, changed);
  const text = compareText(before, after, added);
  report.verification = {
    pixels: pixels.length ? "failed" : "identical-outside-fields",
    differingPixels: pixels.reduce((s, f) => s + f.differing, 0),
    textPreserved: !text.length,
  };
  for (const f of pixels) report.warnings.push({ code: "pixels_changed", page: f.page, detail: `${f.differing} pixels differ within [${f.box.map(Math.round).join(", ")}]` });
  for (const f of text) {
    const detail = [f.missing.join(" "), f.overlayMissing ? `${f.overlayMissing} characters of the tagged text are not readable` : ""];
    report.warnings.push({ code: "text_lost", page: f.page, detail: detail.filter(Boolean).join("; ") });
  }
  if (pixels.length) throw new IrisPdfError("pixels_changed", `Page ${pixels[0].page} no longer renders identically.`, EXIT.verification);
  if (text.length) throw new IrisPdfError("text_lost", `Page ${text[0].page} lost text.`, EXIT.verification);
}

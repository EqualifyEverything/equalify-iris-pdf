// tag(): the original PDF plus Iris's HTML -> the same PDF, tagged, with any
// form values filled in, checked to render identically (spec §7).
import * as mupdf from "mupdf";
import { describe, inherited, openPdf, save, type OpenOptions } from "./pdf/document.ts";
import { drawsNothing, Overlay, pageBody, pageImages, pagesWithMcids, unmarkPage, withoutStrings, type PageImage } from "./pdf/content.ts";
import { artifactStreams, keyedBody, keyedChars, parseText, type Mark, type PageText } from "./pdf/shows.ts";
import { FontSet, unembeddedFonts } from "./pdf/fonts.ts";
import { StructTree } from "./pdf/struct.ts";
import { layersAutoState, setDocumentInfo } from "./pdf/metadata.ts";
import { textLayerWords } from "./pdf/words.ts";
import { allWidgets, checkValues, inventory, onStates, setValues, type FormValue, type Widget } from "./pdf/widgets.ts";
import { buildPage, headingShift, isRun, wordsInOrder, type Node, type Placed, type Run, type Word } from "./html/build.ts";
import { joinHyphenated, normalize, type Box, type PageWord } from "./align/words.ts";
import { align, matchRuns, MAX_WORDS } from "./align/align.ts";
import { isFurniture } from "./align/classify.ts";
import { ocrWords } from "./ocr/tesseract.ts";
import { FieldMaker, fieldNames } from "./form/create.ts";
import { comparePixels } from "./verify/pixels.ts";
import { compareText } from "./verify/text.ts";
import { EXIT, IrisPdfError, newReport, type PageReport, type Report, type Warning } from "./report.ts";

export type PagesInput = { lang?: string; title?: string; pages: { sourcePage: number; html: string }[] };

export type TagOptions = OpenOptions & {
  values?: Record<string, FormValue>;
  lang?: string;
  title?: string;
  flatten?: boolean;
  inPlace?: boolean; // tag the page's own text where it is (the default), not a copy in an overlay
};

// Throws IrisPdfError. `report` is filled in as far as the run got, either way.
// Tagging the page's own text is checked like the rest; if it fails, the
// text is tagged in an overlay instead.
export function tag(pdf: Uint8Array, input: PagesInput, opts: TagOptions = {}, report: Report = newReport()): Uint8Array {
  const run = (inPlace: boolean) => tagWith(pdf, input, opts, report, inPlace);
  return opts.inPlace === false ? run(false) : withFallback(run, report);
}

// run(true), or if that fails verification, run(false) on a fresh report.
export function withFallback<T>(run: (inPlace: boolean) => T, report: Report): T {
  try {
    return run(true);
  } catch (e) {
    if (!(e instanceof IrisPdfError) || !["pixels_changed", "text_lost"].includes(e.code)) throw e;
    Object.assign(report, newReport());
    const out = run(false);
    report.warnings.push({ code: "in_place_failed", detail: `Tagging the page's own text failed verification (${e.message}); its words were drawn again in an overlay instead.` });
    return out;
  }
}

function tagWith(pdf: Uint8Array, input: PagesInput, opts: TagOptions, report: Report, inPlace: boolean): Uint8Array {
  const src = openPdf(pdf, opts);
  const { doc } = src;
  // The old overlay's text is gone on purpose, so the text check compares against the source without it.
  // Pixels compare against the input itself: the restore must not change a pixel.
  // The baseline is saved from a second copy: after a full save, mupdf writes the
  // incremental update as an xref table with the xref stream's trailer, which Preview cannot open.
  const baseline = src.restored ? save(openPdf(pdf, opts).doc, true) : pdf;
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

  // Forms: check every value, then set them, then flatten if asked. A form
  // with no fields gets them from its HTML, page by page, and is filled after.
  let fields = inventory(doc);
  const values = opts.values ?? {};
  const maker = !fields.length && !opts.flatten ? new FieldMaker(doc) : undefined;
  let filled = { set: 0, skippedReadOnly: 0, changed: new Map<number, Box[]>() };
  if (!maker) {
    checkValues(fields, values).forEach(warn);
    filled = setValues(doc, fields, values);
  }
  const widgets = allWidgets(doc).map((w) => ({ ...w, box: w.widget.getBounds() as Box, used: false }));
  if (opts.flatten) doc.bake(false, true);

  // The source's own fonts must be embedded for the file to be PDF/UA. We do not rewrite them.
  let unembedded = unembeddedFonts(doc);
  if (unembedded.length) warn({ code: "font_not_embedded", detail: `${unembedded.join(", ")}; the output does not claim PDF/UA-1.` });
  for (const i of html.keys()) unmarkPage(doc, doc.findPage(i));
  const { shift, detail } = headingShift([...html.keys()].sort((a, b) => a - b).map((i) => html.get(i)!), lang);
  if (detail) warn({ code: "headings_shifted", detail });
  const marked = pagesWithMcids(doc);
  if (marked.length) warn({ code: "source_marked_content", detail: `Pages ${marked.join(", ")} carry marked-content ids from an earlier tag tree, or could not be checked; the output does not claim PDF/UA-1.` });
  const struct = new StructTree(doc);
  const fonts = new FontSet();
  const written: { page: mupdf.PDFObject; ops: string; figures: Map<number, number>; source?: PageText; mark?: (id: number) => Mark | undefined }[] = [];
  const overlayText = new Map<number, string>(); // per page index
  let untagged = 0; // pages left as they were
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    if (!html.has(i)) {
      // Nothing says what this page holds, so it is left exactly as it was.
      // A blank page with no annotations to tag needs no tags, so it is not a warning.
      const blank = drawsNothing(page) && !needTags(page.getObject().get("Annots"));
      if (!blank) warn({ code: "page_not_in_html", page: i + 1, detail: "pages.json has no HTML for this page; it was left untagged." });
      report.pages.push({ page: i + 1, textSource: "none", words: 0, matched: 0, addedFromHtml: 0, furniture: 0, lost: 0, redrawn: 0, mcids: 0 });
      if (!blank) untagged++;
      continue;
    }
    const r = tagPage(page, i, html.get(i)!, {
      doc, struct, fonts, lang, flatten: !!opts.flatten, warn, maker, shift, inPlace,
      widgets: widgets.filter((w) => w.page === i), allWidgets: widgets,
    });
    report.pages.push(r.report);
    if (r.untagged) untagged++;
    if (r.report.textSource === "pdf-text") {
      report.source.hadTextLayer.push(i + 1);
      const n = r.report.redrawn;
      if (n) warn({ code: "duplicate_text_layer", page: i + 1, detail: `${n} of this page's words now exist twice; plain text extractors may show them doubled.` });
    }
    if (r.overlay !== null) {
      written.push({ page: page.getObject(), ...r.overlay });
      overlayText.set(i, r.overlay.text);
    }
  }
  for (const w of widgets) if (!w.used) report.form.unresolved.push(w.name);
  if (maker) {
    fields = inventory(doc);
    checkValues(fields, values).forEach(warn);
    filled = setValues(doc, fields, values);
    report.form.created = maker.created;
    // Typed text is drawn in Helvetica, which is not embedded.
    const more = unembeddedFonts(doc).filter((f) => !unembedded.includes(f));
    if (more.length) warn({ code: "font_not_embedded", detail: `${more.join(", ")}, for the filled fields; the output does not claim PDF/UA-1.` });
    unembedded = [...unembedded, ...more];
  }
  Object.assign(report.form, { fields: fields.length, set: filled.set, skippedReadOnly: filled.skippedReadOnly });

  // Fonts go in last, as one subset holding every glyph the overlays use.
  const fontRefs = fonts.embed(doc, written.map((w) => w.ops));
  for (const { page, ops, figures, source, mark } of written) {
    const res = ownResources(doc, page);
    for (const [name, ref] of Object.entries(fontRefs)) res.get("Font").put(name, ref);
    page.put("Contents", [...artifactStreams(doc, page, figures, source, mark), ...(ops ? [doc.addStream(ops, {})] : [])]);
  }
  if (fonts.missing.size) warn({ code: "missing_glyph", detail: [...fonts.missing].join("") });
  struct.finish();
  report.structure = { elements: struct.elements, byType: struct.byType };
  const autoState = layersAutoState(doc);
  if (autoState) warn({ code: "layer_auto_state", detail: "An optional content configuration has /AS, which PDF/UA-1 forbids; the output does not claim PDF/UA-1." });
  setDocumentInfo(doc, lang, title ?? "", !!title && !untagged && !unembedded.length && !marked.length && !autoState);

  const out = save(doc, src.repaired);
  report.sizeIncreaseBytes = out.length - pdf.length;
  verify(pdf, baseline, out, opts, filled.changed, overlayText, report);
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
  flatten: boolean;
  warn: (w: Warning) => void;
  widgets: (Widget & { box: Box; used: boolean })[]; // this page's
  allWidgets: (Widget & { box: Box; used: boolean })[];
  maker?: FieldMaker; // a flat form: its fields are made from the HTML
  shift: number; // heading levels to move up
  inPlace: boolean;
};

const MAX_TRACED = 4 << 20; // bytes of page content; tracing writes some 50 per code
// The page's own text, parsed so its codes can be marked where they are, and
// read code by code. Null if it has none, or its content cannot be read, is
// too long to trace, or ends inside a string: what follows would be read as that string.
function sourceText(doc: mupdf.PDFDocument, page: mupdf.PDFPage) {
  let body: string;
  try {
    body = pageBody(page.getObject());
  } catch {
    return null;
  }
  if (body.length > MAX_TRACED || (body.includes("(") && withoutStrings(body) === body)) return null;
  const text = parseText(page.getObject(), body);
  if (!text.shows.size || text.codes.length >= 0xffffff) return null; // a key is 24 bits
  const keyed = keyedChars(doc, page, (mask) => keyedBody(text, (_op, id) => id, mask));
  return { text, keyed, ink: new Set(keyed.filter((c) => c.key && !/\s/.test(c.c)).map((c) => c.key)) };
}

// One page: find its words, align Iris's words to them, write the overlay and
// the page's part of the structure tree. overlay is null if the page is left alone.
type Written = { ops: string; text: string; figures: Map<number, number>; source?: PageText; mark?: (id: number) => Mark | undefined };
function tagPage(page: mupdf.PDFPage, i: number, html: string, ctx: PageCtx): { report: PageReport; overlay: Written | null; untagged?: boolean } {
  const n = i + 1;
  const warn = (w: Warning) => ctx.warn({ page: n, ...w });
  const plan = buildPage(html, ctx.lang, `p${n}-`, warn, ctx.shift);
  const ordered = wordsInOrder(plan);
  const report: PageReport = { page: n, textSource: "none", words: 0, matched: 0, addedFromHtml: 0, furniture: 0, lost: 0, redrawn: 0, mcids: 0 };

  const src = ctx.inPlace ? sourceText(ctx.doc, page) : null;
  let words: PageWord[] = textLayerWords(page, src?.keyed);
  if (words.length) report.textSource = "pdf-text";
  else if (ordered.length) {
    const ocr = ocrWords(page);
    if (typeof ocr === "string") {
      // Still tagged: the words flow down the page in reading order, not over their image.
      warn({ code: "no_text_positions", detail: `The page has no text layer and ${ocr}; its words are placed approximately.` });
      report.textSource = "approximate";
    } else {
      words = ocr;
      report.textSource = "ocr";
    }
  }
  // Text drawn inside a form field belongs to the field, which is tagged by reference.
  const inField = (w: PageWord) => ctx.widgets.some((f) => overlaps(f.box, w.box, 0.5));
  words = words.filter((w) => !inField(w));
  report.words = words.length;

  // Align, then place every HTML word: on its page word, or beside its neighbour.
  const tokens = joinHyphenated(words);
  if (Math.max(ordered.length, tokens.length) > MAX_WORDS)
    throw new IrisPdfError("too_many_words", `Page ${n} has more than ${MAX_WORDS} words.`);
  const htmlNorms = ordered.map((o) => o.word.norm), pageNorms = tokens.map((t) => t.norm);
  const aligned = align(htmlNorms, pageNorms), complete = aligned.complete;
  const match = matchRuns(htmlNorms, pageNorms, aligned.match);
  const sharing = new Map<number, number[]>(); // page token -> the HTML words on it
  match.forEach((t, k) => t >= 0 && sharing.set(t, [...(sharing.get(t) ?? []), k]));
  if (!complete) warn({ code: "alignment_incomplete", detail: "The page and the HTML differ too much to match every word in time." });
  const blockOf = new Map<number, number>(), bounds = page.getBounds() as Box;
  const matched = new Set<Word>();
  // In place: the page's codes each HTML word owns, and the text a reader is given for them if it differs.
  const codes = new Map<Word, number[]>(), actual = new Map<Word, string>();
  match.forEach((t, k) => {
    if (t < 0) {
      if (ordered[k].word.norm) report.addedFromHtml++; // punctuation is not a word
      return;
    }
    report.matched++;
    matched.add(ordered[k].word);
    const on = tokens[t].words.map((j) => words[j]), w = ordered[k].word;
    // A page number or running header the HTML happens to match stays an artifact.
    if (sharing.get(t)!.length === 1 && on.every((p) => p.codes && !isFurniture(p, bounds[3] - bounds[1], n))) {
      const drawn = [...on.map((p) => p.text).join("")], all = on.flatMap((p) => p.codes!);
      const split = on.length === 1 ? beside(drawn, ordered.map((o, j) => (j === k || match[j] === -1 ? o.word.text : null)), k) : null;
      if (drawn.join("").normalize("NFKC") === w.text.normalize("NFKC")) codes.set(w, unique(all));
      else if (split) for (const [j, from, to] of split) codes.set(ordered[j].word, unique(all.slice(from, to)));
      else if (tokens[t].norm === w.norm) {
        // Spelled with other marks, such as a line-end hyphen: read as the HTML's word.
        codes.set(w, unique(all));
        actual.set(w, w.text);
      } // else the page draws more than this word: it stays an artifact, and the word goes in the overlay.
    }
    ordered[k].word.at = share(placed(words[tokens[t].words[0]], bounds), sharing.get(t)!.map((x) => htmlNorms[x].length), sharing.get(t)!.indexOf(k));
    blockOf.set(t, ordered[k].block);
  });
  // With no page words, each block starts a new line, so blocks do not run together.
  const breaks = new Set(words.length ? [] : ordered.filter((o, k) => k && o.newLine).map((o) => o.word));
  fillPositions(ordered.map((o) => o.word), bounds, (s) => ctx.fonts.width(s), breaks);
  if (ctx.maker) {
    const made = ctx.maker.page(page, i, plan, report.textSource === "approximate" ? null : {
      matched, order: ordered.map((o) => o.word), words: words.map((w) => ({ norm: normalize(w.text), box: w.box })),
    }, warn);
    for (const w of made) {
      const entry = { ...w, box: w.widget.getBounds() as Box, used: false };
      ctx.widgets.push(entry);
      ctx.allWidgets.push(entry);
    }
  }

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
      const word: Word = { text: w.text, norm: "", at: placed(w, bounds) };
      run.words.push(word);
      if (w.codes) codes.set(word, unique(w.codes));
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
  const onPage = new Set(report.textSource === "pdf-text" ? [...matched, ...[...lost.values()].flat().flatMap((r) => r.words)] : []);
  const place = src ? { codes, actual, seg: segments(kids, codes, actual, src.text, src.ink), marks: new Map<number, Mark>() } : null;
  const e: Emitter = { ...ctx, pageObj, overlay, links, warn, mcids: 0, images: [], figures: new Map(), place, onPage, redrawn: 0 };
  if (hasFigure(plan)) {
    const images = imagesInOrder(pageImages(page), bounds, report.textSource !== "pdf-text");
    if (images.length === plan.images) e.images = images;
    else warn({ code: "figure_without_image", detail: `The HTML has ${plan.images} images and the page ${images.length}; its figures do not contain their images.` });
  }
  for (const k of kids) emit(k as Node, ctx.struct.top, e);

  // Annotations that Iris's HTML did not mention still need a place in the tree.
  for (const l of links.filter((l) => !l.used)) {
    // Its description: the words under it, else its address, else a generic
    // English phrase, marked as English so it is read as such.
    const under = words.filter((w) => overlaps(l.box, w.box, 0.3)).map((w) => w.text).join(" ");
    const generic = !l.obj.get("Contents").isString() && !under && !l.uri;
    const elem = ctx.struct.add(ctx.struct.top, "Link", generic && !ctx.lang.startsWith("en") ? { Lang: ctx.doc.newString("en") } : {});
    ctx.struct.objr(elem, pageObj, l.obj);
    if (l.obj.get("Contents").isNull()) describe(ctx.doc, l.obj, under || l.uri || "Link to another part of this document");
    warn({ code: "unmatched_link", detail: l.uri || "internal link" });
  }
  for (const w of ctx.widgets.filter((w) => !w.used && !ctx.flatten)) {
    const elem = ctx.struct.add(ctx.struct.top, "Form");
    ctx.struct.objr(elem, pageObj, w.widget.getObject());
    nameField(w, "", ctx.doc);
    w.used = true;
    warn({ code: "field_not_in_html", detail: w.name });
  }
  if (!pageObj.get("Annots").isNull()) pageObj.put("Tabs", ctx.doc.newName("S"));
  report.mcids = e.mcids;
  report.redrawn = e.redrawn;
  if (!e.mcids) {
    // Nothing to tag. A page that draws something is left as it was, not hidden as an artifact.
    if (drawsNothing(page)) return { report, overlay: null };
    warn({ code: "page_not_tagged", detail: "The HTML for this page holds nothing to tag; it was left untagged." });
    return { report, overlay: null, untagged: true };
  }
  const mark = place ? (id: number) => place.marks.get(place.seg.get(id) ?? -1) : undefined;
  return { report, overlay: { ops: overlay.toString(), text: overlay.text, figures: e.figures, source: src?.text, mark } };
}

// The marked-content sequence (a number) each of the page's codes goes in.
// A run's words share one owner, unless an overlay word parts them; a word
// read through ActualText owns its codes alone. A code two owners claim is
// marked by neither: their words go in the overlay instead (out of `codes`).
// A space between two codes of one owner, in one text object, is theirs too.
function segments(kids: (Node | Run)[], codes: Map<Word, number[]>, actual: Map<Word, string>, t: PageText, ink: Set<number>): Map<number, number> {
  const runs: Run[] = [];
  const visit = (k: Node | Run): void => void (isRun(k) ? runs.push(k) : k.kids.forEach(visit));
  kids.forEach(visit);
  let claim = new Map<number, object>();
  for (let bad = new Set<number>(); ; bad = new Set()) {
    claim = new Map();
    for (const r of runs) {
      let part = {}, gap = false;
      for (const w of r.words) {
        const cs = codes.get(w);
        if (!cs) {
          gap ||= !!w.text;
          continue;
        }
        if (gap) (part = {}), (gap = false);
        const owner = actual.has(w) ? w : part;
        for (const c of cs) {
          if (claim.has(c) && claim.get(c) !== owner) bad.add(c);
          claim.set(c, owner);
        }
      }
    }
    if (!bad.size) break;
    for (const [w, cs] of codes) if (cs.some((c) => bad.has(c))) codes.delete(w);
  }
  const seg = new Map<number, number>();
  let n = 0, prev = null as { owner: object; bt: number } | null, pending: number[] = [];
  for (let id = 1; id <= t.codes.length; id++) {
    const owner = claim.get(id), bt = t.codes[id - 1].bt;
    if (prev && bt !== prev.bt) (prev = null), (pending = []);
    if (!owner) {
      if (ink.has(id)) (prev = null), (pending = []);
      else if (prev) pending.push(id);
      continue;
    }
    if (prev?.owner === owner) for (const p of pending) seg.set(p, n);
    else n++;
    seg.set(id, n);
    pending = [];
    prev = { owner, bt };
  }
  return seg;
}

type Link = { obj: mupdf.PDFObject; box: Box; uri: string; used: boolean };
type Emitter = PageCtx & {
  pageObj: mupdf.PDFObject; overlay: Overlay; links: Link[]; mcids: number;
  images: PageImage[][]; // the page's images, matched in order to the HTML's <img>
  figures: Map<number, number>; // a content operator drawing a figure's image -> its MCID
  // In place: each word's codes, the ActualText some need, each code's sequence, and each sequence's mark.
  place: { codes: Map<Word, number[]>; actual: Map<Word, string>; seg: Map<number, number>; marks: Map<number, Mark> } | null;
  onPage: Set<Word>; // words the page's text layer already draws
  redrawn: number; // of those, how many the overlay draws again
};

const hasFigure = (n: Node): boolean => n.type === "Figure" || n.kids.some((k) => !isRun(k) && hasFigure(k));

// The images a reader would see, in reading order: top to bottom, left to
// right along a row. Tiles, images sharing a whole edge, are one picture.
// Hairlines are left out, and so is a scan's page image (scan: the page has no text layer).
function imagesInOrder(images: PageImage[], page: Box, scan: boolean): PageImage[][] {
  const groups: { box: Box; images: PageImage[] }[] = [];
  for (const img of images) {
    const near = groups.filter((g) => tiles(g.box, img.box));
    const group = { box: img.box, images: [img] };
    for (const g of near) {
      group.box = [Math.min(group.box[0], g.box[0]), Math.min(group.box[1], g.box[1]), Math.max(group.box[2], g.box[2]), Math.max(group.box[3], g.box[3])];
      group.images.push(...g.images);
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(group);
  }
  const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
  const seen = groups.filter((g) => g.box[2] - g.box[0] >= 2 && g.box[3] - g.box[1] >= 2 && !(scan && area(g.box) > area(page) / 2));
  seen.sort((a, b) => a.box[1] - b.box[1]);
  const rows: (typeof seen)[] = [];
  for (const g of seen) {
    const row = rows.at(-1), mid = (g.box[1] + g.box[3]) / 2;
    if (row && mid < row[0].box[3]) row.push(g);
    else rows.push([g]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.box[0] - b.box[0])).map((g) => g.images.sort((a, b) => a.op - b.op));
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1;
const tiles = (a: Box, b: Box) =>
  (close(a[0], b[0]) && close(a[2], b[2]) && (close(a[3], b[1]) || close(b[3], a[1]))) ||
  (close(a[1], b[1]) && close(a[3], b[3]) && (close(a[2], b[0]) || close(b[2], a[0])));

const asP = (r: Run): Node => ({ type: "P", kids: [r] });
const unique = (xs: number[]) => [...new Set(xs)];
// A page word drawn as HTML word k and the unmatched HTML words beside it
// ("website.1" for "website", ".", "1"): each one's characters [from, to) of
// it, or null. texts: each HTML word's text, null if it is matched. What is left over must be punctuation.
function beside(drawn: string[], texts: (string | null)[], k: number): [number, number, number][] | null {
  const punct = (cs: string[]) => cs.every((c) => !/[\p{L}\p{N}]/u.test(c));
  const word = [...texts[k] ?? ""], same = (at: number, w: string[]) => w.length > 0 && w.every((c, i) => drawn[at + i] === c);
  for (let at = 0; at + word.length <= drawn.length; at++) {
    if (!same(at, word)) continue;
    const out: [number, number, number][] = [[k, at, at + word.length]];
    let end = at + word.length, start = at;
    for (let j = k + 1, w; (w = [...texts[j] ?? ""]) && same(end, w); j++) out.push([j, end, (end += w.length)]);
    for (let j = k - 1, w; (w = [...texts[j] ?? ""]) && same(start - w.length, w); j--) out.push([j, (start -= w.length), start + w.length]);
    if (punct(drawn.slice(0, start)) && punct(drawn.slice(end))) return out;
  }
  return null;
}
// A word running off the page is squeezed onto it: extractors drop glyphs off the page.
const placed = (w: PageWord, page: Box): Placed =>
  ({ box: [Math.max(w.box[0], page[0]), w.box[1], Math.min(w.box[2], page[2]), w.box[3]], baseline: w.baseline, size: w.size });

// Words sharing one page word split its box across, by length.
export function share(p: Placed, lengths: number[], k: number): Placed {
  if (lengths.length < 2) return p;
  const total = lengths.reduce((a, b) => a + b, 0) || 1, w = p.box[2] - p.box[0];
  const x0 = p.box[0] + (w * lengths.slice(0, k).reduce((a, b) => a + b, 0)) / total;
  return { ...p, box: [x0, p.box[1], x0 + (w * lengths[k]) / total, p.box[3]] };
}

// An HTML word with no page word follows the word before it, at its natural
// width, wrapping at the page edge: extractors drop text off the page, and
// merge repeated letters piled into one spot. With no word before it, it
// starts at the first placed word, or the page's top left. A word in `breaks` starts a new line.
function fillPositions(words: Word[], page: Box, width: (text: string) => number, breaks: Set<Word>) {
  const fallback: Placed = { box: [page[0] + 10, page[1] + 10, page[0] + 10, page[1] + 20], baseline: page[1] + 20, size: 10 };
  const first = words.find((w) => w.at)?.at ?? fallback;
  let prev: Word | null = null;
  for (const w of words) {
    if (!w.at) {
      const from = prev?.at ?? first, size = from.size, line = size * 1.2;
      const wide = Math.min(width(w.text) * size, page[2] - page[0] - 2);
      let x = prev ? from.box[2] + (prev.space ?? true ? width(" ") * size : 0) : first.box[0];
      let dy = 0;
      if (breaks.has(w) || x + wide > page[2] - 1) {
        x = breaks.has(w) && first.box[0] + wide <= page[2] - 1 ? first.box[0] : page[0] + 1;
        dy = from.box[3] + line > page[3] ? page[1] + line - from.box[3] : line; // off the bottom: back to the top
      }
      w.at = { size, baseline: from.baseline + dy, box: [x, from.box[1] + dy, x + wide, from.box[3] + dy] };
    }
    prev = w;
  }
}

// MathML as an associated file (ISO 32000-2 14.13), read by Firefox and by NVDA in Foxit.
// It is not listed in /EmbeddedFiles, so it does not show as an attachment.
function mathFile(doc: mupdf.PDFDocument, xml: string): mupdf.PDFObject {
  const now = new Date();
  const spec = doc.addEmbeddedFile("formula.mml", "application/mathml+xml", xml, now, now);
  spec.put("AFRelationship", doc.newName("Supplement"));
  spec.put("Desc", doc.newString("MathML"));
  return spec;
}

function emit(n: Node, parent: mupdf.PDFObject, e: Emitter) {
  const { doc, struct } = e;
  if (n.type === "Form") return emitField(n, parent, e);
  const extra: Record<string, unknown> = {};
  if (n.alt) extra.Alt = doc.newString(n.alt);
  if (n.title) extra.T = doc.newString(n.title);
  if (n.lang) extra.Lang = doc.newString(n.lang);
  if (n.mathml) extra.AF = [mathFile(doc, n.mathml)];
  if (n.attrs || n.headers) extra.A = { ...n.attrs, ...(n.headers ? { O: "Table", Headers: n.headers.map((h) => doc.newString(h)) } : {}) };
  const elem = struct.add(parent, n.type, extra);
  if (n.id) struct.id(elem, n.id);
  for (const k of n.kids) {
    if (isRun(k)) writeRun(n.type, elem, k.words, e);
    else emit(k, elem, e);
  }
  if (n.type === "Figure" && !n.kids.length) {
    // The figure owns its image's drawing; one that cannot be marked leaves an empty place in the reading order.
    const own = (e.images[n.image!] ?? []).filter((img) => img.wrap);
    for (const img of own) e.figures.set(img.op, struct.mcid(elem, e.pageObj));
    if (!own.length) e.overlay.empty("Figure", struct.mcid(elem, e.pageObj));
    e.mcids += own.length || 1;
  }
  if (n.type === "Link") linkAnnotation(n, elem, e);
}

// A run's words: each marked where the page draws it, or else drawn in the overlay.
function writeRun(type: string, elem: mupdf.PDFObject, words: Word[], e: Emitter) {
  let open = false; // an overlay sequence
  const begin = () => {
    e.overlay.begin(type, e.struct.mcid(elem, e.pageObj));
    e.mcids++;
    open = true;
  };
  if (!words.length) begin(); // a run with no words still has its place
  for (const w of words) {
    const codes = e.place?.codes.get(w);
    if (!codes) {
      if (!open) begin();
      e.overlay.word(w.text, w.at!.box, w.at!.baseline, w.at!.size, w.space ?? true);
      if (e.onPage.has(w)) e.redrawn++;
      continue;
    }
    if (open) (e.overlay.end(), (open = false));
    const { seg, marks, actual } = e.place!, text = actual.get(w);
    const owner = text === undefined ? elem : e.struct.add(elem, "Span", { ActualText: e.doc.newString(text) });
    for (const c of codes) {
      const s = seg.get(c)!;
      if (marks.has(s)) continue;
      marks.set(s, { tag: text === undefined ? type : "Span", mcid: e.struct.mcid(owner, e.pageObj) });
      e.mcids++;
    }
  }
  if (open) e.overlay.end();
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
  if (link.obj.get("Contents").isNull() && text) describe(e.doc, link.obj, text);
}

// An <input>: a Form element owning its widgets, which get the label as /TU.
// Flattened, the widget is gone and a P carries the value instead.
function emitField(n: Node, parent: mupdf.PDFObject, e: Emitter) {
  const f = n.form!;
  if (f.unplaced) return;
  if (e.maker && !f.type) return; // a button: nothing to fill
  if (!f.name) return e.warn({ code: "field_without_name", detail: f.label || "a form control" });
  const free = (name: string) => e.widgets.filter((w) => w.name === name && !w.used && (!f.value || onStates(w.widget).includes(f.value)));
  let mine = free(f.name);
  // Retagging our own output: a field we made may carry a changed name.
  for (const name of fieldNames(f.name)) {
    if (mine.length || !e.allWidgets.some((w) => w.name === name)) break;
    mine = free(name);
  }
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
  // A radio button's label names one choice; its group's legend or question names the field.
  const name = (f.type === "radio" && f.group) || f.label || f.group || "";
  for (const w of mine) {
    e.struct.objr(elem, e.pageObj, w.widget.getObject());
    nameField(w, name, e.doc);
  }
}

// /TU, the name a screen reader announces (PDF/UA-1 7.18.1). The HTML's label
// wins; without one, keep the source's, else a push button's caption, else the
// field name. (On a check box or radio button, /MK /CA is the check mark's glyph.)
function nameField(w: Widget, label: string, doc: mupdf.PDFDocument) {
  const had = w.field.get("TU");
  if (!label && had.isString() && had.asString()) return;
  const push = inherited(w.field, "FT")?.asName() === "Btn" && ((inherited(w.field, "Ff")?.asNumber() ?? 0) & (1 << 16)) !== 0;
  const caption = w.widget.getObject().get("MK", "CA");
  const name = label || (push && caption.isString() && caption.asString()) || inherited(w.field, "T")?.asString();
  if (name) w.field.put("TU", doc.newString(name));
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

function verify(pdf: Uint8Array, baseline: Uint8Array, out: Uint8Array, opts: TagOptions, changed: Map<number, Box[]>, added: Map<number, string>, report: Report) {
  const open = (b: Uint8Array) => {
    const d = new mupdf.PDFDocument(b);
    if (d.needsPassword()) d.authenticatePassword(opts.password ?? "");
    return d;
  };
  const after = open(out);
  const pixels = comparePixels(open(pdf), after, 150, changed);
  const text = compareText(open(baseline), after, added);
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

// Page content: wrap the original drawing as one artifact, and write the
// invisible, tagged text overlay that carries Iris's words (spec §7.2).
import * as mupdf from "mupdf";
import type { FontSet } from "./fonts.ts";
import type { Box } from "../align/words.ts";

// The page's original content streams, bracketed by /Artifact BMC q ... Q EMC.
// The streams are not touched unless a figure owns an image in them: then
// they are joined into one, with each such image in its Figure's marked content.
export function artifactStreams(doc: mupdf.PDFDocument, page: mupdf.PDFObject, figures = new Map<number, number>()): mupdf.PDFObject[] {
  let streams = pageStreams(page);
  if (!streams.length) return [];
  if (figures.size) {
    const s = pageBody(page), ops = operators(s);
    let out = "", from = 0;
    for (const [k, mcid] of [...figures].sort((a, b) => a[0] - b[0])) {
      out += `${s.slice(from, ops[k].start)}\nEMC /Figure <</MCID ${mcid}>> BDC\n${s.slice(ops[k].start, ops[k].end)}\nEMC /Artifact BMC\n`;
      from = ops[k].end;
    }
    streams = [addBody(doc, out + s.slice(from))];
  }
  return [doc.addStream("/Artifact BMC q\n", {}), ...streams, doc.addStream("\nQ EMC\n", {})];
}

function pageStreams(page: mupdf.PDFObject): mupdf.PDFObject[] {
  const contents = page.get("Contents"), streams: mupdf.PDFObject[] = [];
  if (contents.isArray()) contents.forEach((s) => { if (s.isStream()) streams.push(s); });
  else if (contents.isStream()) streams.push(contents);
  return streams;
}

// The page's drawing as one string, a character per byte.
export function pageBody(page: mupdf.PDFObject): string {
  return pageStreams(page).map((s) => Buffer.from(s.readStream().asUint8Array()).toString("latin1")).join("\n");
}

export const addBody = (doc: mupdf.PDFDocument, s: string) => doc.addStream(Buffer.from(s, "latin1"), {});

const WS = "\0\t\n\f\r ", DELIM = "()<>[]{}/%";
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
// A content stream's operators, each spanning its operands: s.slice(start, end).
export type Op = { op: string; args: string[]; start: number; end: number };
export function operators(s: string): Op[] {
  const out: Op[] = [], n = s.length;
  let args: string[] = [], start = -1, i = 0;
  const regular = (j: number) => { while (j < n && !WS.includes(s[j]) && !DELIM.includes(s[j])) j++; return j; };
  while (i < n) {
    const c = s[i], from = i;
    if (WS.includes(c)) { i++; continue; }
    if (c === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    if (c === "(") {
      for (let depth = 0; i < n; i++) {
        if (s[i] === "\\") i++;
        else if (s[i] === "(") depth++;
        else if (s[i] === ")" && !--depth) { i++; break; }
      }
    } else if ((c === "<" || c === ">") && s[i + 1] === c) i += 2;
    else if (c === "<") { const e = s.indexOf(">", i); i = e < 0 ? n : e + 1; }
    else if ("[]{}".includes(c)) i++;
    else if (c === "/") i = regular(i + 1);
    else {
      i = regular(i);
      if (i === from) { i++; continue; } // a stray delimiter
      const word = s.slice(from, i);
      if (!NUMBER.test(word) && word !== "true" && word !== "false" && word !== "null") {
        if (word === "BI") {
          // An inline image runs to the EI after its binary data.
          const id = s.slice(i).search(/[\0\t\n\f\r ]ID[\0\t\n\f\r ]/);
          const data = id < 0 ? n : i + id + 4;
          const ei = s.slice(data).search(/[\0\t\n\f\r ]EI(?![^\0\t\n\f\r ])/);
          i = ei < 0 ? n : data + ei + 3;
        }
        out.push({ op: word, args, start: start < 0 ? from : start, end: i });
        args = [];
        start = -1;
        continue;
      }
    }
    if (start < 0) start = from;
    args.push(s.slice(from, i));
  }
  return out;
}

// The drawing without the marked content an earlier tag tree left in it:
// inside our artifact it would be tagged content in an artifact (PDF/UA-1
// 7.1). Optional content (/OC) decides what is drawn, so it stays.
export function unmark(s: string): string {
  const cut: Op[] = [], open: boolean[] = [];
  for (const o of operators(s)) {
    if (o.op === "BMC" || o.op === "BDC") {
      open.push(o.args[0] === "/OC");
      if (o.args[0] !== "/OC") cut.push(o);
    } else if (o.op === "EMC") {
      if (!open.pop()) cut.push(o);
    } else if (o.op === "MP" || o.op === "DP") cut.push(o);
  }
  let out = "", from = 0;
  for (const o of cut) (out += s.slice(from, o.start) + " "), (from = o.end);
  return cut.length ? out + s.slice(from) : s;
}

// unmark() on the page's drawing. A stream that cannot be read leaves it as it was.
export function unmarkPage(doc: mupdf.PDFDocument, page: mupdf.PDFObject) {
  let body: string;
  try {
    body = pageBody(page);
  } catch {
    return;
  }
  const clean = unmark(body);
  if (clean !== body) page.put("Contents", addBody(doc, clean));
}

// Each image the page's own content draws, in page space, with the index of
// the operator drawing it. wrap: it can be given marked content of its own (it
// is not inside a text object or optional content).
export type PageImage = { box: Box; op: number; wrap: boolean };
// A stream that cannot be read gives none.
export function pageImages(page: mupdf.PDFPage): PageImage[] {
  const xobjects = page.getObject().getInheritable("Resources").get("XObject");
  let ops: Op[];
  try {
    ops = operators(pageBody(page.getObject()));
  } catch {
    return [];
  }
  const out: PageImage[] = [];
  const stack: mupdf.Matrix[] = [];
  let ctm = mupdf.Matrix.identity, text = 0, marked = 0;
  ops.forEach((o, k) => {
    if (o.op === "q") stack.push(ctm);
    else if (o.op === "Q") ctm = stack.pop() ?? ctm;
    else if (o.op === "cm" && o.args.length === 6) ctm = mupdf.Matrix.concat(o.args.map(Number) as mupdf.Matrix, ctm);
    else if (o.op === "BT") text++;
    else if (o.op === "ET") text = Math.max(0, text - 1);
    else if (o.op === "BMC" || o.op === "BDC") marked++;
    else if (o.op === "EMC") marked = Math.max(0, marked - 1);
    else if (o.op === "BI" || (o.op === "Do" && xobjects.get(o.args[0]?.slice(1) ?? "").get("Subtype").asName() === "Image")) {
      const box = mupdf.Rect.transform([0, 0, 1, 1], mupdf.Matrix.concat(ctm, page.getTransform())) as Box;
      out.push({ box, op: k, wrap: !text && !marked });
    }
  });
  return out;
}

// Pages (1-based) whose own drawing has marked-content ids, left from a tag
// tree since removed. Inside our artifact they are tagged content in an
// artifact, which PDF/UA-1 forbids (7.1). A stream that cannot be read, or
// forms nested past a depth of 32, count as marked. Tiling patterns and annotation appearances are searched too.
export function pagesWithMcids(doc: mupdf.PDFDocument): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i), seen = new Set<number>();
    const marked = (...s: mupdf.PDFObject[]) => {
      try {
        return /\/MCID\b/.test(withoutStrings(s.map((x) => x.readStream().asString()).join("\n")));
      } catch {
        return true;
      }
    };
    const forms = (res: mupdf.PDFObject, depth: number): boolean => {
      let found = false;
      if (depth > 32) return true;
      if (!res.isDictionary()) return false;
      // A named property list (/Tag /Name BDC) keeps its /MCID in the resources.
      res.get("Properties").forEach((p) => { if (p.isDictionary() && !p.get("MCID").isNull()) found = true; });
      const drawn = (x: mupdf.PDFObject) => x.isStream() && (x.get("Subtype").asName() === "Form" || x.get("PatternType").asNumber() === 1);
      [res.get("XObject"), res.get("Pattern")].forEach((d) => d.forEach((x) => {
        if (found || !drawn(x)) return;
        if (x.isIndirect()) {
          if (seen.has(x.asIndirect())) return;
          seen.add(x.asIndirect());
        }
        found = marked(x) || forms(x.get("Resources"), depth + 1);
      }));
      return found;
    };
    const contents = page.get("Contents"), streams: mupdf.PDFObject[] = [];
    if (contents.isArray()) contents.forEach((s) => { if (s.isStream()) streams.push(s); });
    else if (contents.isStream()) streams.push(contents);
    // Annotation appearances draw too.
    let appearance = false;
    // /AP holds /N, /R, /D, each a stream or a dictionary of streams: two levels.
    const ap = (a: mupdf.PDFObject, depth: number) => {
      if (appearance) return;
      if (a.isStream()) appearance = marked(a) || forms(a.get("Resources"), 1);
      else if (a.isDictionary() && depth < 2) a.forEach((x) => ap(x, depth + 1));
    };
    page.get("Annots").forEach((a) => { if (a.isDictionary()) ap(a.get("AP"), 0); });
    if ((streams.length && marked(...streams)) || forms(page.getInheritable("Resources"), 0) || appearance) out.push(i + 1);
  }
  return out;
}

// A content stream with its string literals, comments and inline-image data
// removed, so their bytes are not read as operators. An unclosed string leaves
// the stream as it was.
export function withoutStrings(s: string): string {
  let out = "", depth = 0;
  const space = (c: string | undefined) => c === undefined || /[\0\t\n\f\r ]/.test(c);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    } else if (c === "(") depth = 1;
    else if (c === "%") while (i + 1 < s.length && !/[\n\r]/.test(s[i + 1])) i++;
    else if (c === "I" && s[i + 1] === "D" && space(s[i - 1]) && space(s[i + 2])) {
      const end = s.slice(i + 3).search(/[\0\t\n\f\r ]EI(?![^\0\t\n\f\r ])/);
      if (end < 0) return s;
      out += " ";
      i += 3 + end + 2;
    } else out += c;
  }
  return depth ? s : out;
}

// True if the page's own content paints nothing (annotations aside).
export function drawsNothing(page: mupdf.PDFPage): boolean {
  let drew = false;
  const paint = () => { drew = true; };
  const dev = new mupdf.Device({
    fillPath: paint, strokePath: paint, fillText: paint, strokeText: paint,
    fillShade: paint, fillImage: paint, fillImageMask: paint,
  });
  page.runPageContents(dev, mupdf.Matrix.identity);
  dev.close();
  return !drew;
}

const num = (n: number) => (Math.abs(n) < 1e-6 ? "0" : String(Math.round(n * 1000) / 1000));

// Text render mode 3 draws nothing, so the overlay changes no pixel.
export class Overlay {
  private ops: string[] = ["q 3 Tr"];
  text = ""; // everything written, for the text check
  private fonts: FontSet;
  private toUser: mupdf.Matrix;

  // pageTransform maps the page's user space to mupdf's top-down page space.
  constructor(fonts: FontSet, pageTransform: mupdf.Matrix) {
    this.fonts = fonts;
    this.toUser = mupdf.Matrix.invert(pageTransform);
  }

  begin(tag: string, mcid: number) {
    this.ops.push(`/${tag} <</MCID ${mcid}>> BDC`);
  }

  end() {
    this.ops.push("EMC");
  }

  // One word, stretched to fill its box. A space after it, if the HTML had
  // one, lets extractors see the word break.
  word(text: string, box: Box, baseline: number, size: number, space = true) {
    // A character no font has is reported, and left out: a .notdef glyph has no Unicode (PDF/UA-1 7.21.7).
    const chars = [...text].filter((c) => this.fonts.glyph(c).gid), glyphs = chars.map((c) => this.fonts.glyph(c));
    if (!chars.length) return;
    this.text += chars.join("") + " ";
    const unit = glyphs.reduce((w, g) => w + g.advance, 0), wide = box[2] - box[0];
    // Squeezed to under half its width, extractors merge a word's repeated letters. Shrink the text instead.
    if (unit * size > 0 && wide / (unit * size) < 0.5) size = Math.max(0.5, (2 * wide) / unit);
    const h = unit * size > 0 ? Math.min(10, Math.max(0.1, wide / (unit * size))) : 1;
    const m = mupdf.Matrix.concat([h, 0, 0, -1, box[0], baseline], this.toUser);
    // Consecutive glyphs from the same font share one Tj.
    const runs: { font: number; hex: string }[] = [];
    for (const g of space ? [...glyphs, this.fonts.glyph(" ")] : glyphs) {
      if (runs.at(-1)?.font !== g.font) runs.push({ font: g.font, hex: "" });
      runs.at(-1)!.hex += g.gid.toString(16).padStart(4, "0");
    }
    const shows = runs.map((r) => `/${this.fonts.resourceName(r.font)} ${num(size)} Tf <${r.hex}> Tj`);
    this.ops.push(`BT ${m.map(num).join(" ")} Tm ${shows.join(" ")} ET`);
  }

  // An empty marked-content sequence, for a Figure: it names a place in the
  // reading order without drawing anything.
  empty(tag: string, mcid: number) {
    this.ops.push(`/${tag} <</MCID ${mcid}>> BDC EMC`);
  }

  toString() {
    return this.ops.join("\n") + "\nQ\n";
  }
}

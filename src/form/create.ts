// A flat form's fields: each HTML control placed on its blank and made an
// empty widget with no border, so the page looks as it did.
import * as mupdf from "mupdf";
import type { Box } from "../align/words.ts";
import { isRun, type ControlType, type FormRef, type Node, type Word } from "../html/build.ts";
import { widgetOf, type Widget } from "../pdf/widgets.ts";
import type { Warning } from "../report.ts";
import { cellAt, cellBlank, cellUnder, Ink, markBlank, rowsOf, textBlank } from "./find.ts";

// What the alignment found of the HTML on a page. order: the HTML's words in
// reading order; words: the page's own. null: the words are placed
// approximately, which says nothing about where the blanks are.
export type PageText = { matched: Set<Word>; order: Word[]; words: { norm: string; box: Box }[] };

export type Created = { name: string; type: ControlType; page: number };

export class FieldMaker {
  readonly created: Created[] = [];
  private names = new Set<string>();
  private doc: mupdf.PDFDocument;
  constructor(doc: mupdf.PDFDocument) { this.doc = doc; }

  // Places and makes one page's fields. Each control placed gets its field's
  // name; one not placed is marked so.
  page(page: mupdf.PDFPage, index: number, plan: Node, text: PageText | null, warn: (w: Warning) => void): Widget[] {
    const controls: { f: FormRef; td?: Node }[] = [], ths = new Map<string, Node>();
    const visit = (n: Node, td?: Node) => {
      if (n.form?.type) controls.push({ f: n.form, td });
      if (n.type === "TH" && n.id) ths.set(n.id, n);
      for (const k of n.kids) if (!isRun(k)) visit(k, n.type === "TD" ? n : td);
    };
    visit(plan);
    const unplaced = (f: FormRef) => {
      f.unplaced = true;
      warn({ code: "field_not_placed", page: index + 1, detail: f.name || f.label || f.type! });
    };
    if (!text) return controls.forEach(({ f }) => unplaced(f)), [];
    if (!controls.length) return [];

    const { matched } = text, at = new Map(text.order.map((w, k) => [w, k]));
    const ink = new Ink(page);
    const toRect = mupdf.Matrix.invert(page.getTransform());
    const obstacles = [...matched].map((w) => w.at!.box);
    const rows = new Map<Node, number>(); // body cells seen under each column header
    const groups = new Map<string, { name: string; parent: mupdf.PDFObject; states: Set<string> }>();
    const made = new Set<number>();
    for (const { f, td } of controls) {
      const label = labelBox(f.labelWords, text, at);
      const mark = f.type === "checkbox" || f.type === "radio";
      let box = td && !mark ? this.cell(ink, td, ths, rows, matched, obstacles) : null;
      if (!box && label) box = mark ? markBlank({ ink, label, obstacles }) : textBlank({ ink, label, obstacles }, f.type === "multiline");
      if (!box) {
        unplaced(f);
        continue;
      }
      obstacles.push(box);
      const rect = mupdf.Rect.transform(box, toRect);
      const [w, h] = [rect[2] - rect[0], rect[3] - rect[1]];
      const obj = page.createAnnotation("Widget").getObject();
      obj.put("Rect", rect);
      made.add(obj.asIndirect());
      const s = (v: string) => this.doc.newString(v);
      const n = (v: string) => this.doc.newName(v);
      if (f.type === "radio") {
        const key = f.name || f.group || "";
        let g = key ? groups.get(key) : undefined;
        if (!g) {
          const name = this.unique(f.name || slug(f.group ?? "") || "choice");
          const parent = this.doc.addObject({ FT: n("Btn"), Ff: (1 << 15) | (1 << 14), T: s(name), Kids: [] });
          this.acroform().get("Fields").push(parent);
          g = { name, parent, states: new Set() };
          if (key) groups.set(key, g);
          this.created.push({ name, type: "radio", page: index + 1 });
        }
        let state = (f.value || slug(f.label) || "option").replace(/^Off$/, "off");
        for (let k = 2; g.states.has(state); k++) state = `${f.value || slug(f.label) || "option"}-${k}`;
        g.states.add(state);
        obj.put("Parent", g.parent);
        g.parent.get("Kids").push(obj);
        obj.put("AP", { N: { [state]: this.stream(dot(w, h), w, h), Off: this.stream("", w, h) } });
        obj.put("AS", n("Off"));
        f.name = g.name, f.value = state;
        continue;
      }
      const name = this.unique(f.name || f.id || slug(f.label) || f.type!);
      obj.put("T", s(name));
      this.acroform().get("Fields").push(obj);
      if (f.type === "checkbox") {
        obj.put("FT", n("Btn"));
        obj.put("AP", { N: { Yes: this.stream(cross(w, h), w, h), Off: this.stream("", w, h) } });
        obj.put("AS", n("Off"));
        f.value = undefined; // its on-state is Yes, whatever the HTML's value
      } else {
        const size = Math.max(6, Math.min(f.type === "multiline" ? 10 : 12, Math.floor(h * 0.7)));
        obj.put("FT", n(f.type === "combobox" ? "Ch" : "Tx"));
        obj.put("DA", s(`/Helv ${size} Tf 0 g`));
        if (f.type === "multiline") obj.put("Ff", 1 << 12);
        if (f.type === "combobox") {
          obj.put("Ff", 1 << 17);
          obj.put("Opt", (f.options ?? []).map(s));
        }
        obj.put("AP", { N: this.stream("", w, h) });
      }
      f.name = name;
      this.created.push({ name, type: f.type!, page: index + 1 });
    }
    // A page loaded afresh sees the new widgets.
    return this.doc.loadPage(index).getWidgets().filter((w) => made.has(w.getObject().asIndirect())).map((w) => widgetOf(w, index));
  }

  // A control in a table cell: the cell under its column header, on its row
  // header's line, or else counted down from the header.
  private cell(ink: Ink, td: Node, ths: Map<string, Node>, rows: Map<Node, number>, matched: Set<Word>, obstacles: Box[]): Box | null {
    const heads = (td.headers ?? []).map((id) => ths.get(id)!).filter(Boolean);
    const col = heads.filter((h) => h.attrs?.Scope !== "Row").at(-1), row = heads.find((h) => h.attrs?.Scope === "Row");
    const colBox = col && lineBox(wordsOf(col), matched);
   
    if (!col || !colBox) return null;
    const x = (colBox[0] + colBox[2]) / 2, lh = colBox[3] - colBox[1];
    let cell: Box | null;
    if (row) {
      const on = wordsOf(row).filter((w) => matched.has(w)).map((w) => w.at!.box);
      const y = on.length ? (Math.min(...on.map((b) => b[1])) + Math.max(...on.map((b) => b[3]))) / 2 : -1;
      const c = on.length ? cellAt(ink, [x, y]) : null;
      cell = c && (rowsOf(ink, c, lh).find((r) => y >= r[1] && y <= r[3]) ?? null);
    } else {
      const k = rows.get(col) ?? 0, below: Box[] = [];
      rows.set(col, k + 1);
      for (let c = cellUnder(ink, [x, colBox[3]]); c && below.length <= k; c = cellUnder(ink, [x, c[3]])) {
        const last = below.at(-1); // the column goes on only while its cells line up
        if (last && (Math.abs(c[0] - last[0]) > lh || Math.abs(c[2] - last[2]) > lh || c[1] - last[3] > lh)) break;
        below.push(...rowsOf(ink, c, lh));
      }
      cell = below[k] ?? null;
    }
    return cell && cellBlank({ ink, obstacles }, cell, lh);
  }

  private unique(base: string): string {
    const clean = base.replace(/\./g, "-"); // a period separates a field from its parent's name
    let name = clean;
    for (let k = 2; this.names.has(name); k++) name = `${clean}-${k}`;
    this.names.add(name);
    return name;
  }

  private stream(ops: string, w: number, h: number) {
    return this.doc.addStream(ops, { Type: this.doc.newName("XObject"), Subtype: this.doc.newName("Form"), BBox: [0, 0, w, h] });
  }

  // The document's AcroForm, made if absent, with Helvetica for typed text.
  private acroform(): mupdf.PDFObject {
    const root = this.doc.getTrailer().get("Root");
    if (!root.get("AcroForm").isDictionary()) root.put("AcroForm", this.doc.addObject({}));
    const af = root.get("AcroForm");
    if (!af.get("Fields").isArray()) af.put("Fields", this.doc.newArray());
    if (!af.get("DA").isString()) af.put("DA", this.doc.newString("/Helv 0 Tf 0 g"));
    if (!af.get("DR").isDictionary()) af.put("DR", this.doc.newDictionary());
    if (!af.get("DR", "Font").isDictionary()) af.get("DR").put("Font", this.doc.newDictionary());
    if (af.get("DR", "Font", "Helv").isNull()) {
      const n = (v: string) => this.doc.newName(v);
      af.get("DR", "Font").put("Helv", this.doc.addObject({ Type: n("Font"), Subtype: n("Type1"), BaseFont: n("Helvetica"), Encoding: n("WinAnsiEncoding") }));
    }
    return af;
  }
}

// A label's line on the page: where its words are read once, in a row; else
// where the alignment put them, if a word read near it in the HTML is near it on the page.
function labelBox(label: Word[], text: PageText, at: Map<Word, number>): Box | null {
  const norms = label.map((w) => w.norm).filter(Boolean), { words } = text;
  const hits: Box[][] = [];
  for (let i = 0; norms.length && i + norms.length <= words.length; i++) {
    if (norms.every((n, k) => words[i + k].norm === n)) hits.push(words.slice(i, i + norms.length).map((w) => w.box));
  }
  const first = at.get(label[0]), last = at.get(label.at(-1)!);
  if (first === undefined || last === undefined) return null;
  const mine = new Set(label);
  const near = [...text.order.slice(Math.max(0, first - 3), first), ...text.order.slice(last + 1, last + 4)]
    .filter((w) => !mine.has(w) && text.matched.has(w)).map((w) => w.at!.box);
  const fits = (box: Box | null) => !!box && (!near.length || near.some((b) => Math.abs((b[1] + b[3] - box[1] - box[3]) / 2) <= 6 * (box[3] - box[1])));
  const box = hits.length === 1 ? line(hits[0]) : null;
  if (fits(box)) return box;
  const aligned = lineBox(label, text.matched);
  return fits(aligned) ? aligned : null;
}

// The words of a label that were found on the page, on the line of its last one.
function lineBox(words: Word[], matched: Set<Word>): Box | null {
  return line(words.filter((w) => matched.has(w)).map((w) => w.at!.box));
}

// The boxes on the line of the last one, as one box.
function line(on: Box[]): Box | null {
  const last = on.at(-1);
  if (!last) return null;
  const l = on.filter((b) => (b[1] + b[3]) / 2 > last[1] && (b[1] + b[3]) / 2 < last[3]);
  return [Math.min(...l.map((b) => b[0])), Math.min(...l.map((b) => b[1])), Math.max(...l.map((b) => b[2])), Math.max(...l.map((b) => b[3]))];
}

const wordsOf = (n: Node): Word[] => n.kids.flatMap((k) => (isRun(k) ? k.words : wordsOf(k)));
const slug = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// A check box's cross and a radio button's dot, drawn when chosen.
const cross = (w: number, h: number) => `0 g 1 w ${w * 0.2} ${h * 0.2} m ${w * 0.8} ${h * 0.8} l ${w * 0.2} ${h * 0.8} m ${w * 0.8} ${h * 0.2} l S\n`;
function dot(w: number, h: number): string {
  const x = w / 2, y = h / 2, r = Math.min(w, h) * 0.3, k = r * 0.5523;
  return `0 g ${x + r} ${y} m ${x + r} ${y + k} ${x + k} ${y + r} ${x} ${y + r} c ${x - k} ${y + r} ${x - r} ${y + k} ${x - r} ${y} c ` +
    `${x - r} ${y - k} ${x - k} ${y - r} ${x} ${y - r} c ${x + k} ${y - r} ${x + r} ${y - k} ${x + r} ${y} c f\n`;
}

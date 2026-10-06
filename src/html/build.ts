// Iris's HTML for one page -> the structure we will write: a tree of PDF
// structure types whose leaves are words. Positions are filled in later by
// the alignment.
import { parseHtml, textOf, type Elem } from "./parse.ts";
import { STRUCT, TRANSPARENT, SKIP, listNumbering } from "./map.ts";
import { normalize, splitWords, type Box } from "../align/words.ts";
import type { Warning } from "../report.ts";

export type Placed = { box: Box; baseline: number; size: number };
export type Word = { text: string; norm: string; space?: boolean; at?: Placed }; // space: one follows
export type Run = { words: Word[] };
// A form control. type is null for one that holds no value (a button). labelWords: its
// label's words, to find it on the page; group: its fieldset's legend, or a radio group's question.
export type ControlType = "text" | "multiline" | "checkbox" | "radio" | "combobox";
export type FormRef = {
  name: string; id?: string; value?: string; label: string; group?: string;
  type: ControlType | null; options?: string[]; labelWords: Word[];
  unplaced?: boolean; // a flat form's control whose blank was not found
};

export type Node = {
  type: string;
  kids: (Node | Run)[];
  alt?: string;
  title?: string; // /T
  lang?: string;
  id?: string;
  attrs?: Record<string, unknown>; // the /A attribute object
  headers?: string[]; // a TD's /Headers
  href?: string; // Link
  form?: FormRef; // Form
  span?: [number, number]; // a table cell's colspan, rowspan
};

export const isRun = (k: Node | Run): k is Run => "words" in k;

type Ctx = {
  lang: string;
  prefix: string; // keeps ids unique across pages
  labels: Map<string, string>; // input id -> its label's text
  labelWords: Map<string, Word[]>; // input id -> its label's words, filled as they are built
  questions: Map<string, string>; // radio name -> the text before its first button
  notes: Set<string>; // ids that internal links point at
  label?: string; // text of an enclosing <label>
  legend?: string; // text of an enclosing <fieldset>'s legend
  collect: Word[][]; // label word lists that the text being built belongs to
  wrapped?: Word[]; // an enclosing <label>'s words
  ths: { n: number }; // TH cells numbered so far, so their ids are unique on the page
  warn: (w: Warning) => void;
};

export function buildPage(html: string, lang: string, prefix: string, warn: (w: Warning) => void): Node {
  const root = parseHtml(html);
  const labels = new Map<string, string>(), notes = new Set<string>();
  walk(root, (e) => {
    if (e.tag === "label" && e.attrs.for) labels.set(e.attrs.for, clean(textOf(e)));
    if (e.tag === "a" && e.attrs.href?.startsWith("#")) notes.add(e.attrs.href.slice(1));
  });
  const top: Node = { type: "#root", kids: [] };
  const ctx: Ctx = { lang, prefix, labels, notes, warn, labelWords: new Map(), questions: new Map(), collect: [], ths: { n: 0 } };
  for (const k of root.kids) build(k, top, ctx);
  // Text directly in the fragment, outside any block, becomes a paragraph.
  top.kids = top.kids.map((k) => (isRun(k) ? { type: "P", kids: [k] } : k));
  return top;
}

function build(e: Elem | string, parent: Node, ctx: Ctx) {
  if (typeof e === "string") return addText(parent, e, ctx.collect);
  if (SKIP.has(e.tag)) return;
  const kids = (into: Node, c: Ctx = ctx) => e.kids.forEach((k) => build(k, into, c));
  if (e.tag === "label") {
    const words = e.attrs.for ? labelWords(ctx, e.attrs.for) : [];
    const wrapped = e.attrs.for ? ctx.wrapped : words;
    return kids(parent, { ...ctx, label: clean(textOf(e)), collect: [...ctx.collect, words], wrapped });
  }
  if (e.tag === "a" && !e.attrs.href) return kids(parent);
  if (TRANSPARENT.has(e.tag)) return kids(parent);

  const add = (type: string): Node => {
    const n: Node = { type, kids: [] };
    if (e.attrs.lang && e.attrs.lang !== ctx.lang) n.lang = e.attrs.lang;
    if (e.attrs.id && ctx.notes.has(e.attrs.id)) target(n, e.attrs.id, ctx);
    parent.kids.push(n);
    return n;
  };
  const inner: Ctx = e.attrs.lang ? { ...ctx, lang: e.attrs.lang } : ctx;

  switch (e.tag) {
    case "ul": case "ol": {
      const list = add("L");
      list.attrs = { O: "List", ListNumbering: listNumbering(e.tag, e.attrs.type) };
      let n = Number(e.attrs.start ?? 1);
      for (const k of e.kids) {
        if (typeof k !== "string" && k.tag === "li") listItem(k, list, e.tag === "ol" ? `${n++}.` : "•", inner);
        else build(k, list, inner);
      }
      return;
    }
    case "li": return listItem(e, parent, "", inner);
    case "dl": {
      const list = add("L");
      // Each <dt> starts an item; its <dd> follow it into the same LI.
      let item: Node | null = null;
      for (const k of e.kids) {
        if (typeof k === "string") continue;
        if (k.tag === "dt" || !item) list.kids.push((item = { type: "LI", kids: [] }));
        build(k, item, inner);
      }
      return;
    }
    case "img": {
      if (e.attrs.alt === undefined) return ctx.warn({ code: "missing_alt", detail: e.attrs.src ?? "img" });
      if (e.attrs.alt === "") return; // decorative: the original drawing is already an artifact
      add("Figure").alt = e.attrs.alt;
      return;
    }
    case "a": {
      // An internal link is a Reference; the Link inside it owns the annotation.
      const internal = e.attrs.href.startsWith("#");
      const outer = add(internal ? "Reference" : "Link");
      const link: Node = internal ? { type: "Link", kids: [] } : outer;
      if (internal) outer.kids.push(link);
      link.href = e.attrs.href;
      return kids(link, inner);
    }
    case "input": case "select": case "textarea": {
      const type = (e.attrs.type ?? "").toLowerCase();
      if (type === "hidden") return;
      const { id, name = "" } = e.attrs;
      const label = (id && ctx.labels.get(id)) || ctx.label || e.attrs["aria-label"] || e.attrs.title || "";
      const words = (id && ctx.labels.has(id) ? labelWords(ctx, id) : ctx.wrapped) ?? [];
      const f = add("Form");
      f.form = { name, id, label, group: ctx.legend, type: controlType(e.tag, type), labelWords: words };
      if (type === "radio" || type === "checkbox") f.form.value = e.attrs.value;
      if (type === "radio" && !ctx.legend && name) {
        if (!ctx.questions.has(name)) ctx.questions.set(name, clean(textOfNode(parent)));
        f.form.group = ctx.questions.get(name) || undefined;
      }
      if (e.tag === "select") {
        f.form.options = e.kids.flatMap((o) => (typeof o !== "string" && o.tag === "option" ? [o.attrs.value ?? clean(textOf(o))] : []));
      }
      if (label) f.alt = label;
      return;
    }
    case "fieldset": {
      const sect = add("Sect");
      const legend = e.kids.find((k) => typeof k !== "string" && k.tag === "legend");
      if (legend) sect.title = clean(textOf(legend));
      return kids(sect, { ...inner, legend: sect.title });
    }
    case "nav": case "aside": case "section": {
      const sect = add("Sect");
      if (e.attrs["aria-label"]) sect.title = e.attrs["aria-label"];
      return kids(sect, inner);
    }
    case "table": {
      const table = add("Table");
      kids(table, inner);
      return tableHeaders(table, ctx.prefix, ctx.ths);
    }
    case "th": case "td": {
      const cell = add(STRUCT[e.tag]);
      cell.span = [Number(e.attrs.colspan) || 1, Number(e.attrs.rowspan) || 1];
      if (e.tag === "th" && e.attrs.scope) cell.attrs = { O: "Table", Scope: scope(e.attrs.scope) };
      return kids(cell, inner);
    }
  }
  const type = STRUCT[e.tag];
  if (!type) ctx.warn({ code: "unmapped_element", detail: e.tag });
  if (type === "LBody") { const w = lastWord(parent); if (w) w.space = true; } // after its <dt>
  kids(add(type ?? "P"), inner);
}

function listItem(e: Elem, parent: Node, label: string, ctx: Ctx) {
  const li: Node = { type: "LI", kids: [] };
  parent.kids.push(li);
  if (label) li.kids.push({ type: "Lbl", kids: [{ words: [word(label)] }] });
  let body: Node = { type: "LBody", kids: [] };
  li.kids.push(body);
  // A footnote list item: LI may hold only Lbl and LBody, so the Note goes inside the LBody.
  if (e.attrs.id && ctx.notes.has(e.attrs.id)) {
    const note: Node = { type: "P", kids: [] };
    body.kids.push(note);
    target(note, e.attrs.id, ctx);
    body = note;
  }
  for (const k of e.kids) build(k, body, ctx);
}

// The target of an internal link gets an /ID. A paragraph is a footnote, so
// it becomes a Note; anything else (a heading, say) keeps its type.
function target(n: Node, id: string, ctx: Ctx) {
  n.id = `${ctx.prefix}${id}`;
  if (n.type === "P") n.type = "Note";
}

const scope = (s: string) => ({ row: "Row", rowgroup: "Row", col: "Column", colgroup: "Column" })[s.toLowerCase()] ?? "Both";

// Every TH gets an /ID and every TD a /Headers list naming the TH cells above
// it in its column and before it in its row.
function tableHeaders(table: Node, prefix: string, ths: { n: number }) {
  const rows: { cells: Node[]; head: boolean }[] = [];
  const collect = (n: Node, head: boolean) => {
    for (const k of n.kids) {
      if (isRun(k)) continue;
      if (k.type === "TR") rows.push({ cells: k.kids.filter((c): c is Node => !isRun(c) && !!c.span), head });
      else if (["THead", "TBody", "TFoot"].includes(k.type)) collect(k, k.type === "THead");
    }
  };
  collect(table, false);
  const grid: Node[][] = [];
  rows.forEach(({ cells, head }, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of cells) {
      while (grid[r][c]) c++;
      const [cs, rs] = cell.span!;
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) (grid[r + dr] ??= [])[c + dc] = cell;
      if (cell.type === "TH") {
        cell.id = `${prefix}th${++ths.n}`;
        cell.attrs ??= { O: "Table", Scope: head || r === 0 ? "Column" : "Row" };
      }
      const a: Record<string, unknown> = { O: "Table", ...cell.attrs };
      if (cs > 1) a.ColSpan = cs;
      if (rs > 1) a.RowSpan = rs;
      if (cs > 1 || rs > 1 || cell.type === "TH") cell.attrs = a;
      c += cs;
    }
  });
  grid.forEach((row, r) => row.forEach((cell, c) => {
    if (cell.type !== "TD" || cell.headers) return;
    const hs = new Set<string>();
    for (let rr = 0; rr < r; rr++) { const h = grid[rr][c]; if (h?.type === "TH" && h.attrs?.Scope !== "Row") hs.add(h.id!); }
    for (let cc = 0; cc < c; cc++) { const h = row[cc]; if (h?.type === "TH" && h.attrs?.Scope !== "Column") hs.add(h.id!); }
    cell.headers = [...hs];
  }));
}

const TEXT = new Set(["", "text", "email", "tel", "number", "date", "url", "search", "password", "time", "month", "week", "datetime-local"]);
function controlType(tag: string, type: string): ControlType | null {
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "multiline";
  if (type === "checkbox" || type === "radio") return type;
  return TEXT.has(type) ? "text" : null;
}

const labelWords = (ctx: Ctx, id: string) => ctx.labelWords.get(id) ?? (ctx.labelWords.set(id, []), ctx.labelWords.get(id)!);
const textOfNode = (n: Node | Run): string => (isRun(n) ? n.words.map((w) => w.text).join(" ") : n.kids.map(textOfNode).join(" "));

function addText(parent: Node, text: string, collect: Word[][] = []) {
  const words = splitWords(text).map((w) => ({ ...word(w.text), space: w.space }));
  for (const list of collect) list.push(...words);
  if (/^\s/.test(text)) { const w = lastWord(parent); if (w) w.space = true; } // "<a>form</a> for"
  if (!words.length) return;
  const last = parent.kids.at(-1);
  if (last && isRun(last)) last.words.push(...words);
  else parent.kids.push({ words });
}

const word = (text: string): Word => ({ text, norm: normalize(text) });
const lastWord = (n: Node | Run): Word | undefined => (isRun(n) ? n.words.at(-1) : n.kids.length ? lastWord(n.kids.at(-1)!) : undefined);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function walk(e: Elem, fn: (e: Elem) => void) {
  fn(e);
  for (const k of e.kids) if (typeof k !== "string") walk(k, fn);
}

// Every word in reading order, each with the index of its top-level block.
// newLine: the word is the first in, or after, a block element.
const INLINE = new Set(["Link", "Reference", "Code", "Lbl", "LBody"]);
export function wordsInOrder(top: Node): { word: Word; block: number; newLine: boolean }[] {
  const out: { word: Word; block: number; newLine: boolean }[] = [];
  let newLine = true;
  const visit = (n: Node | Run, block: number) => {
    if (isRun(n)) return n.words.forEach((word) => (out.push({ word, block, newLine }), (newLine = false)));
    if (!INLINE.has(n.type)) newLine = true;
    n.kids.forEach((k) => visit(k, block));
    if (!INLINE.has(n.type)) newLine = true;
  };
  top.kids.forEach((k, i) => visit(k, i));
  return out;
}

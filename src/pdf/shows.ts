// The page's own text, character code by character code: which operator
// draws each code, and which characters mupdf reads from it. This lets the
// tags mark the source's text where it is, instead of drawing it again.
import * as mupdf from "mupdf";
import { addBody, operators, pageBody, pageStreams, type Op } from "./content.ts";

// One character code: bytes [from, to) of string item `item` of a show
// operator, in text object `bt`. item -1: the operator cannot be cut, and is one code.
export type Code = { item: number; from: number; to: number; bt: number };
// A text-showing operator. items: its strings as bytes, and a TJ's numbers;
// lead: the two numbers before a `"`; codes: ids, 1-based indexes into PageText.codes.
export type Show = { name: string; items: (string | number)[]; lead: string[]; codes: number[]; bt: number };
export type PageText = { body: string; ops: Op[]; shows: Map<number, Show>; codes: Code[] };

export const SHOW = new Set(["Tj", "TJ", "'", '"']);
const MARK = new Set(["BMC", "BDC", "EMC", "MP", "DP"]);
const ESC: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

// A string operand as bytes, a character per byte; null if malformed.
function bytes(t: string): string | null {
  if (t.startsWith("<")) {
    const h = t.slice(1, -1).replace(/[\0\t\n\f\r ]/g, "");
    if (!t.endsWith(">") || /[^0-9a-fA-F]/.test(h)) return null;
    return Buffer.from(h.length % 2 ? h + "0" : h, "hex").toString("latin1");
  }
  if (!t.startsWith("(") || !t.endsWith(")")) return null;
  let out = "";
  for (let i = 1; i < t.length - 1; i++) {
    const c = t[i];
    if (c === "\r") {
      if (t[i + 1] === "\n") i++;
      out += "\n";
    } else if (c !== "\\") out += c;
    else {
      const d = t[++i];
      if (ESC[d]) out += ESC[d];
      else if (/[0-7]/.test(d)) {
        let o = d;
        while (o.length < 3 && /[0-7]/.test(t[i + 1])) o += t[++i];
        out += String.fromCharCode(parseInt(o, 8) & 255);
      } else if (d === "\r") {
        if (t[i + 1] === "\n") i++;
      } else if (d !== "\n") out += d;
    }
  }
  return out;
}

// Bytes per code in the named font: 1 for a simple font, 2 for Identity-H/V, 0 if unknown.
function codeWidth(fonts: mupdf.PDFObject, name: string | undefined): number {
  const f = name && fonts.isDictionary() ? fonts.get(name) : null;
  if (!f?.isDictionary()) return 0;
  if (f.get("Subtype").asName() !== "Type0") return 1;
  const enc = f.get("Encoding");
  return enc.isName() && ["Identity-H", "Identity-V"].includes(enc.asName()) ? 2 : 0;
}

// The page's show operators and their codes. One in a text object that holds
// marked content, or is unclosed or nested, is left out: it stays whole.
export function parseText(page: mupdf.PDFObject, body: string): PageText {
  const ops = operators(body), fonts = page.getInheritable("Resources").get("Font");
  const shows = new Map<number, Show>(), codes: Code[] = [], bad = new Set<number>();
  const saved: (string | undefined)[] = [];
  let font: string | undefined, bt = 0, inBT = false;
  ops.forEach((o, k) => {
    if (o.op === "q") saved.push(font);
    else if (o.op === "Q") font = saved.length ? saved.pop() : font;
    else if (o.op === "Tf") font = o.args[0]?.slice(1);
    else if (o.op === "BT") {
      if (inBT) bad.add(bt);
      inBT = true;
      bt++;
    } else if (o.op === "ET") inBT = false;
    else if (MARK.has(o.op) && inBT) bad.add(bt);
    else if (SHOW.has(o.op) && inBT) {
      const lead = o.op === '"' ? o.args.slice(0, 2) : [];
      const raw = o.op === "TJ" ? o.args.slice(1, -1) : o.args.slice(lead.length);
      const items = raw.map((a) => (/^[(<]/.test(a) ? bytes(a) : Number(a)));
      const width = codeWidth(fonts, font);
      const show: Show = { name: o.op, items: items as (string | number)[], lead, codes: [], bt };
      const add = (item: number, from: number, to: number) => show.codes.push(codes.push({ item, from, to, bt }));
      const whole = !width || items.some((x) => x === null || (typeof x === "number" ? isNaN(x) : x.length % width));
      if (whole) {
        if (items.some((x) => typeof x === "string" && x)) add(-1, 0, 0);
      } else items.forEach((x, i) => {
        if (typeof x === "string") for (let b = 0; b < x.length; b += width) add(i, b, b + width);
      });
      shows.set(k, show);
    }
  });
  if (inBT) bad.add(bt);
  for (const [k, s] of shows) if (bad.has(s.bt)) shows.delete(k);
  return { body, ops, shows, codes };
}

// Codes [a, b) of a show (indexes into show.codes), as an operator of their
// own. A TJ's number stays after the code before it. Later pieces of ' and " are Tj.
export function showText(t: PageText, s: Show, a: number, b: number): string {
  const cs = s.codes.map((id) => t.codes[id - 1]), parts: string[] = [];
  let j = 0, last = 0;
  s.items.forEach((x, i) => {
    if (typeof x === "number") {
      if (last >= a && last < b) parts.push(String(x));
      return;
    }
    let hex = "";
    for (; j < cs.length && cs[j].item === i; j++) {
      if (j >= a && j < b) hex += x.slice(cs[j].from, cs[j].to);
      last = j;
    }
    if (hex) parts.push(`<${Buffer.from(hex, "latin1").toString("hex")}>`);
  });
  const body = parts.join(" ");
  if (s.name === "TJ") return `[${body}] TJ`;
  if (a === 0 && s.name === "'") return `${body} '`;
  if (a === 0 && s.name === '"') return `${s.lead.join(" ")} ${body} "`;
  return `${body} Tj`;
}

const f = (x: number) => (x / 255).toFixed(4);
const col = (k: number) => {
  const c = `${f((k >> 16) & 255)} ${f((k >> 8) & 255)} ${f(k & 255)}`;
  return `${c} rg ${c} RG`;
};

// The page body with each code drawn in the colour of key(op, code id), and
// any other show or form in key(op, 0), XORed with mask. Text drawn
// invisibly or only as a clip is filled, so mupdf reports its colour.
export function keyedBody(t: PageText, key: (op: number, id: number) => number, mask: number): string {
  let out = "", from = 0;
  t.ops.forEach((o, k) => {
    out += t.body.slice(from, o.start);
    from = o.end;
    const op = t.body.slice(o.start, o.end), s = t.shows.get(k);
    if (s?.codes.length && t.codes[s.codes[0] - 1].item >= 0) {
      out += s.codes.map((id, j) => `${col(key(k, id) ^ mask)} ${showText(t, s, j, j + 1)}`).join(" ");
    } else if (s?.codes.length) out += `${col(key(k, s.codes[0]) ^ mask)} ${op}`;
    else if (SHOW.has(o.op) || o.op === "Do") out += `${col(key(k, 0) ^ mask)} ${op}`;
    else if (o.op === "Tr" && (o.args[0] === "3" || o.args[0] === "7")) out += "0 Tr";
    else out += op;
  });
  return out + t.body.slice(from);
}

export type KeyedChar = { c: string; key: number; line: number };
const MASK = 0xa5c3f0;

// The page's characters, as mupdf reads them, each with the key its colour
// names. The page is read twice, the second time with every key XORed with a
// mask; a key the two disagree on (text whose colour the content sets itself: a
// form, a Type 3 glyph) is 0. Content mupdf cannot read gives none.
export function keyedChars(doc: mupdf.PDFDocument, page: mupdf.PDFPage, body: (mask: number) => string): KeyedChar[] {
  const obj = page.getObject(), old = obj.get("Contents");
  const read = (mask: number) => {
    const s = addBody(doc, body(mask)), out: KeyedChar[] = [];
    let line = -1;
    obj.put("Contents", s);
    try {
      page.toDisplayList(false).toStructuredText("").walk({
        beginLine() { line++; },
        onChar(c, _o, _f, _s, _q, color) {
          const [r, g, b] = (color ?? []).map((x) => Math.round(x * 255));
          out.push({ c, line, key: (((r << 16) | (g << 8) | b) ^ mask) >>> 0 });
        },
      });
    } catch {
      return [];
    } finally {
      obj.put("Contents", old);
      doc.deleteObject(s);
    }
    return out;
  };
  const a = read(0), b = read(MASK);
  if (a.length !== b.length) return [];
  return a.map((x, i) => ({ ...x, key: b[i].c === x.c && b[i].key === x.key ? x.key : 0 }));
}

export type Mark = { tag: string; mcid: number };

// The page's content streams, bracketed by /Artifact BMC q ... Q EMC. A
// figure's image (by operator index) and the codes `mark` names are taken out
// of the artifact into marked content of their own; the streams are then
// joined into one. The source's optional content is closed and reopened around them.
export function artifactStreams(doc: mupdf.PDFDocument, page: mupdf.PDFObject, figures = new Map<number, number>(), t?: PageText, mark: (id: number) => Mark | undefined = () => undefined): mupdf.PDFObject[] {
  let streams = pageStreams(page);
  if (!streams.length) return [];
  const marked = new Set<number>(); // text objects holding marked codes
  for (const s of t?.shows.values() ?? []) if (s.codes.some((id) => mark(id))) marked.add(s.bt);
  if (figures.size || marked.size) {
    const s = t?.body ?? pageBody(page), ops = t?.ops ?? operators(s), open: string[] = [];
    const reopen = () => open.map((x) => x + " ").join("");
    const leave = () => "EMC ".repeat(open.length + 1) + reopen();
    const back = () => "EMC ".repeat(open.length) + "/Artifact BMC " + reopen();
    let out = "", from = 0, bt = 0, inBT = false, cur: Mark | null = null;
    const to = (m: Mark | null) => {
      if (m === cur) return "";
      cur = m;
      return `EMC ${m ? `/${m.tag} <</MCID ${m.mcid}>> BDC` : "/Artifact BMC"} `;
    };
    ops.forEach((o, k) => {
      out += s.slice(from, o.start);
      from = o.end;
      const op = s.slice(o.start, o.end), show = t?.shows.get(k);
      if (o.op === "BT") (bt++, (inBT = true));
      const here = inBT && marked.has(bt);
      if (o.op === "ET") inBT = false;
      if (figures.has(k)) out += `\n${leave()}/Figure <</MCID ${figures.get(k)}>> BDC\n${op}\nEMC ${back()}\n`;
      else if (here && o.op === "BT") (cur = null), (out += `\n${leave()}BT /Artifact BMC `);
      else if (here && o.op === "ET") out += `EMC ET ${back()}\n`;
      else if (here && show?.codes.length) {
        const m = (j: number) => mark(show.codes[j]) ?? null, n = show.codes.length;
        for (let a = 0, j = 1; j <= n; j++) {
          if (j < n && m(j) === m(a)) continue;
          out += to(m(a)) + (a === 0 && j === n ? op : showText(t!, show, a, j)) + " ";
          a = j;
        }
      } else {
        if (o.op === "BMC" || o.op === "BDC") open.push(op);
        else if (o.op === "EMC") open.pop();
        out += op;
      }
    });
    streams = [addBody(doc, out + s.slice(from))];
  }
  return [doc.addStream("/Artifact BMC q\n", {}), ...streams, doc.addStream("\nQ EMC\n", {})];
}

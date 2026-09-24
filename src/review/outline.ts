// What a screen reader gets from one page: the structure elements with
// content on it, indented, each with its text and the properties read aloud.
import { inherited } from "../pdf/document.ts";
import type { Elem } from "../pdf/read.ts";

const MAX_TEXT = 2000;

const onPage = (e: Elem, page: number): boolean => e.pages.has(page) || e.kids.some((k) => onPage(k, page));

const quote = (s: string) => JSON.stringify(s.slice(0, MAX_TEXT)) + (s.length > MAX_TEXT ? ` [${s.length - MAX_TEXT} more characters not shown]` : "");

// index: page object number -> page index, to show where an internal link goes.
function props(e: Elem, index: Map<number, number>): string[] {
  const d = e.dict, out: string[] = [];
  const str = (key: string) => (d.get(key).isString() ? d.get(key).asString() : undefined);
  for (const key of ["ID", "Alt", "ActualText", "Lang", "T"]) if (str(key) !== undefined) out.push(`${key}=${quote(str(key)!)}`);
  const a = d.get("A").isDictionary() ? d.get("A") : null;
  if (a?.get("Scope").isName()) out.push(`Scope=${a.get("Scope").asName()}`);
  if (a?.get("Headers").isArray()) {
    const ids: string[] = [];
    a.get("Headers").forEach((h) => { if (h.isString()) ids.push(h.asString()); });
    out.push(`Headers=${quote(ids.join(" "))}`);
  }
  for (const o of e.objr) {
    const sub = o.get("Subtype").asName();
    if (o.get("Contents").isString()) out.push(`Contents=${quote(o.get("Contents").asString())}`);
    if (sub === "Link") {
      const act = o.get("A"), s = act.isDictionary() && act.get("S").isName() ? act.get("S").asName() : "";
      if (s === "URI") out.push(`href=${act.get("URI").isString() ? quote(act.get("URI").asString()) : "(none)"}`);
      else if (s === "GoTo" || (!s && !o.get("Dest").isNull())) {
        const d = s ? act.get("D") : o.get("Dest"), pg = d.isArray() && d.get(0).isIndirect() ? index.get(d.get(0).asIndirect()) : undefined;
        out.push(pg !== undefined ? `href=(page ${pg + 1})` : d.isString() || d.isName() ? `href=(in this document, ${quote(d.isName() ? d.asName() : d.asString())})` : "href=(in this document)");
      }
      else out.push(s ? `action=${s}` : "href=(none)");
    } else if (sub === "Widget") {
      const tu = inherited(o, "TU"), ft = inherited(o, "FT");
      out.push(`field=${ft?.isName() ? ft.asName() : "?"}`, `name=${tu?.isString() ? quote(tu.asString()) : "(none)"}`);
    } else out.push(`annotation=${sub}`);
  }
  return out;
}

// page: 0-based.
export function pageOutline(root: Elem, page: number, index = new Map<number, number>()): string {
  const lines: string[] = [];
  const visit = (e: Elem, depth: number) => {
    const pad = "  ".repeat(depth);
    const head = [e.type, ...props(e, index)].join(" ");
    const texts = e.parts.filter((p) => typeof p === "string" && p);
    // Text alone goes on the element's line; text between child elements gets lines of its own.
    if (!e.kids.length) return void lines.push(pad + head + (texts.length ? " " + quote(texts.join(" ")) : ""));
    lines.push(pad + head);
    for (const p of e.parts) {
      if (typeof p !== "string") { if (onPage(p, page)) visit(p, depth + 1); }
      else if (p) lines.push(pad + "  " + quote(p));
    }
  };
  for (const k of root.kids) if (onPage(k, page)) visit(k, 0);
  return lines.join("\n");
}

// The headings on pages before this one, so heading levels can be judged across pages.
export function headingsBefore(root: Elem, page: number, max = 20): string[] {
  const out: string[] = [];
  const visit = (e: Elem) => {
    if (/^H[1-6]?$/.test(e.type) && e.pages.size && Math.min(...e.pages) < page) out.push(`${e.type} ${quote(e.text)}`);
    e.kids.forEach(visit);
  };
  visit(root);
  return out.slice(-max);
}

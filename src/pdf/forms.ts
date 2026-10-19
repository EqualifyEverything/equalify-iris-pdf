// Text a form XObject draws is one operator (Do) in the page's content, so it
// cannot be marked where it is. A form that draws text is copied into the
// page's content instead, its resources added to the page's under names of their own.
import * as mupdf from "mupdf";
import { addBody, operators, type Op } from "./content.ts";

const DEVICE = new Set(["/DeviceGray", "/DeviceRGB", "/DeviceCMYK", "/Pattern"]);
// The resource category named by each operator's first operand.
const NAMES: Record<string, string> = { Tf: "Font", Do: "XObject", gs: "ExtGState", cs: "ColorSpace", CS: "ColorSpace", sh: "Shading" };
const ROUNDS = 4; // forms inside forms
const DEPTH = 8; // how deep drawsText and normalBlend look

// The page's forms inlined into its content (inlineForms) if the page then
// renders to the same pixels at dpi, and the body it now has.
export function inlinePage(doc: mupdf.PDFDocument, page: mupdf.PDFPage, body: string, dpi: number, max: number): string {
  const obj = page.getObject(), contents = obj.get("Contents"), res = obj.get("Resources");
  const inlined = inlineForms(doc, obj, body, max);
  if (inlined !== body) {
    const m = mupdf.Matrix.scale(dpi / 72, dpi / 72), pixels = () => page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true).getPixels();
    const before = pixels();
    obj.put("Contents", addBody(doc, inlined));
    if (Buffer.from(pixels()).equals(Buffer.from(before))) return inlined;
    obj.put("Contents", contents);
  }
  if (res.isNull()) obj.delete("Resources");
  else obj.put("Resources", res);
  return body;
}

// The page body with each form that draws text drawn in place:
// q Matrix cm BBox clip, its content, Q; inside /OC ... BDC EMC if the form
// has optional content. A form is left alone if inlining could change what is
// drawn or tagged (see inlined). Returns the body unchanged if none is
// inlined, or if inlining would make it longer than max.
export function inlineForms(doc: mupdf.PDFDocument, page: mupdf.PDFObject, body: string, max = Infinity): string {
  const original = body, text = new Map<number, boolean>();
  // The page's own copy of its resources and of each category written to, made on first use.
  let res: mupdf.PDFObject | null = null;
  const copied = new Set<string>();
  const own = (cat: string) => {
    res ??= copy(doc, page.getInheritable("Resources"));
    page.put("Resources", res);
    if (!copied.has(cat)) (copied.add(cat), res.put(cat, copy(doc, res.get(cat))));
    return res.get(cat);
  };
  for (let round = 0; round < ROUNDS; round++) {
    const pres = page.getInheritable("Resources"), xo = pres.get("XObject");
    let out = "", from = 0, inBT = false;
    for (const o of operators(body)) {
      if (o.op === "BT") inBT = true;
      else if (o.op === "ET") inBT = false;
      if (o.op !== "Do" || inBT || !xo.isDictionary()) continue;
      const drawn = inlined(xo.get(o.args[0]?.slice(1) ?? ""), pres, own, text, max);
      if (drawn === null) continue;
      out += body.slice(from, o.start) + drawn;
      from = o.end;
      if (out.length + body.length - from > max) return original;
    }
    if (!from) break;
    body = out + body.slice(from);
  }
  return body;
}

// A form's content in page terms, or null if it is not inlined: it draws no
// text, uses a pattern (its space would change), an inline image or marked
// content, is unbalanced, or is a transparency group that would not composite
// the same drawn straight onto the page.
function inlined(form: mupdf.PDFObject, pres: mupdf.PDFObject, own: (cat: string) => mupdf.PDFObject, text: Map<number, boolean>, max: number): string | null {
  if (form.get("Subtype").asName() !== "Form" || !form.isStream() || !drawsText(form, text)) return null;
  const group = form.get("Group");
  if (!group.isNull() && (group.get("K").asBoolean() || !normalBlend(form.get("Resources"), new Set()) || !opaque(pres))) return null;
  const box = form.get("BBox"), m = form.get("Matrix"), oc = form.get("OC");
  if (!box.isArray() || box.length !== 4) return null;
  const s = content(form), ops = s === null ? [] : operators(s);
  if (s === null || s.length > max || !safe(ops)) return null;
  const fres = form.get("Resources");
  let out = "", from = 0;
  for (const o of ops) {
    const cat = NAMES[o.op], name = o.args[0];
    if (!cat || !fres.isDictionary() || !name?.startsWith("/") || (cat === "ColorSpace" && DEVICE.has(name))) continue;
    const obj = fres.get(cat).get(name.slice(1));
    if (obj.isNull()) continue; // the form uses the page's resource of that name
    out += s.slice(from, o.start) + [`/${rename(own(cat), name.slice(1), obj)}`, ...o.args.slice(1), o.op].join(" ");
    from = o.end;
  }
  const n = (a: mupdf.PDFObject, i: number) => a.get(i).asNumber();
  const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => n(box, i));
  const cm = m.isArray() && m.length === 6 ? [0, 1, 2, 3, 4, 5].map((i) => n(m, i)).join(" ") : "1 0 0 1 0 0";
  const drawn = `\nq ${cm} cm ${x0} ${y0} ${x1 - x0} ${y1 - y0} re W n\n${out + s.slice(from)}\nQ\n`;
  return oc.isNull() ? drawn : `\n/OC /${rename(own("Properties"), "OC", oc)} BDC${drawn}EMC\n`;
}

const content = (form: mupdf.PDFObject): string | null => {
  try {
    return Buffer.from(form.readStream().asUint8Array()).toString("latin1");
  } catch {
    return null;
  }
};

// Each form XObject a resource dictionary names, once.
function forms(res: mupdf.PDFObject, seen: Set<number>): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [], xo = res.isDictionary() ? res.get("XObject") : res;
  if (xo.isDictionary()) xo.forEach((v) => {
    const id = v.isIndirect() ? v.asIndirect() : 0;
    if (v.get("Subtype").asName() !== "Form" || (id && seen.has(id))) return;
    if (id) seen.add(id);
    out.push(v);
  });
  return out;
}

// Whether a form draws text, itself or in the forms it draws, remembered by
// object. Forms nested deeper than DEPTH count as drawing none.
function drawsText(form: mupdf.PDFObject, text: Map<number, boolean>, depth = 0): boolean {
  const id = form.isIndirect() ? form.asIndirect() : 0;
  if (id && text.has(id)) return text.get(id)!;
  if (id) text.set(id, false); // a cycle
  const yes = depth < DEPTH && (/\bBT\b/.test(content(form) ?? "") || forms(form.get("Resources"), new Set()).some((f) => drawsText(f, text, depth + 1)));
  if (id) text.set(id, yes);
  return yes;
}

const states = (res: mupdf.PDFObject) => {
  const out: mupdf.PDFObject[] = [], gs = res.isDictionary() ? res.get("ExtGState") : res;
  if (gs.isDictionary()) gs.forEach((g) => { out.push(g); });
  return out;
};
const normal = (g: mupdf.PDFObject) => g.get("BM").isNull() || ["Normal", "Compatible"].includes(g.get("BM").asName());

// No blend mode but Normal, here or in the forms it draws (to DEPTH).
const normalBlend = (res: mupdf.PDFObject, seen: Set<number>, depth = 0): boolean =>
  depth < DEPTH && states(res).every(normal) && forms(res, seen).every((f) => normalBlend(f.get("Resources"), seen, depth + 1));

// The page sets no alpha, soft mask or blend mode that a group takes as a whole.
const one = (x: mupdf.PDFObject) => x.isNull() || x.asNumber() === 1;
const opaque = (res: mupdf.PDFObject) =>
  states(res).every((g) => normal(g) && one(g.get("CA")) && one(g.get("ca")) && (g.get("SMask").isNull() || g.get("SMask").asName() === "None"));

// Balanced, and nothing whose meaning depends on where it is drawn.
function safe(ops: Op[]): boolean {
  let q = 0, bt = 0;
  for (const o of ops) {
    if (o.op === "q") q++;
    else if (o.op === "Q" && --q < 0) return false;
    else if (o.op === "BT" && ++bt > 1) return false;
    else if (o.op === "ET" && --bt < 0) return false;
    else if (["BI", "BMC", "BDC", "EMC", "MP", "DP"].includes(o.op)) return false;
    else if ((o.op === "scn" || o.op === "SCN") && o.args.at(-1)?.startsWith("/")) return false;
  }
  return q === 0 && bt === 0;
}

// The page's name for obj in a resource category: the one it already has, or
// a new one.
function rename(cat: mupdf.PDFObject, name: string, obj: mupdf.PDFObject): string {
  let found = "";
  cat.forEach((v, k) => { if (!found && same(v, obj)) found = String(k); });
  if (found) return found;
  let k = name, i = 0;
  while (!cat.get(k).isNull()) k = `${name}_f${++i}`;
  cat.put(k, obj);
  return k;
}

const same = (a: mupdf.PDFObject, b: mupdf.PDFObject) => a.isIndirect() && b.isIndirect() && a.asIndirect() === b.asIndirect();

function copy(doc: mupdf.PDFDocument, from: mupdf.PDFObject): mupdf.PDFObject {
  const d = doc.newDictionary();
  if (from.isDictionary()) from.forEach((v, k) => { d.put(k, v); });
  return d;
}

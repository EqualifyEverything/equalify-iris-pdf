// Open a PDF and refuse the ones we must not touch (spec §11).
import * as mupdf from "mupdf";
import { IrisPdfError, EXIT, type Warning } from "../report.ts";
import { unmark, unmarkPage, withoutStrings } from "./content.ts";

export const MAX_PAGES = 25; // matches Iris's MAX_PDF_PAGES

export type Source = {
  doc: mupdf.PDFDocument;
  encrypted: boolean;
  signed: boolean;
  acroform: boolean;
  xfa: boolean;
  repaired: boolean; // damaged: saved as a full rewrite, not an update
  restored: boolean; // the PDF was our own output: pages got their original content back
  restricted: boolean; // owner forbids changes; tagged under the accessibility allowance
  warnings: Warning[];
};

// readOnly: only reading (listing fields), so the refusals that protect the
// file from changes do not apply.
export type OpenOptions = { password?: string; allowSigned?: boolean; readOnly?: boolean };

export function openPdf(bytes: Uint8Array, opts: OpenOptions = {}): Source {
  let doc: mupdf.PDFDocument;
  try {
    doc = new mupdf.PDFDocument(bytes);
  } catch (e) {
    throw new IrisPdfError("unreadable", `Not a readable PDF: ${(e as Error).message}`, EXIT.badInput);
  }
  const warnings: Warning[] = [];
  const encrypted = doc.needsPassword();
  if (encrypted) {
    if (!opts.password) throw new IrisPdfError("encrypted", "The PDF is encrypted. Pass --password.");
    if (!doc.authenticatePassword(opts.password)) throw new IrisPdfError("encrypted", "The password is wrong.");
  }
  const root = doc.getTrailer().get("Root");
  const acroform = root.get("AcroForm");
  const xfa = !root.get("AcroForm", "XFA").isNull();
  let signed = false;
  forEachField(doc, (field) => {
    if (inherited(field, "FT")?.asName() === "Sig" && inherited(field, "V")) signed = true;
  });
  const repaired = doc.wasRepaired() || !doc.canBeSavedIncrementally();
  const source = { doc, encrypted, signed, acroform: !acroform.isNull(), xfa, repaired, restored: false, restricted: false, warnings };
  if (opts.readOnly) return source;

  // An owner password can forbid changes. With no open password, and extraction
  // for accessibility allowed, an accessible copy is still made; the output keeps
  // the owner's encryption and permissions.
  if (!doc.hasPermission("edit")) {
    if (encrypted || !doc.hasPermission("accessibility")) {
      throw new IrisPdfError("permissions_denied", "The PDF's owner does not permit changes to it, or extraction for accessibility.");
    }
    source.restricted = true;
    warnings.push({ code: "owner_restricted", detail: "The PDF's owner forbids changes; it was tagged because its permissions allow extraction for accessibility. Its form is filled only if the owner allows that, and no fields are added. The output keeps those permissions." });
  }
  // A damaged file cannot be updated in place. It is rewritten from what mupdf
  // repaired, which is also what the checks render as the original.
  if (source.repaired) warnings.push({ code: "repaired", detail: "The PDF was damaged; the output is a rewritten copy, not an update of the original bytes." });
  const pages = doc.countPages();
  if (pages > MAX_PAGES) {
    throw new IrisPdfError("too_many_pages", `The PDF has ${pages} pages; the limit is ${MAX_PAGES}.`);
  }
  unkeyForms(doc);
  if (!root.get("StructTreeRoot").isNull()) {
    source.restored = untag(doc);
    warnings.push({ code: "retagged", detail: "The PDF's existing tags were removed and replaced." });
  }
  // Dynamic XFA draws the form when it opens; its pages are not in the file.
  if (xfa && root.get("NeedsRendering").valueOf() === true) {
    throw new IrisPdfError("xfa", "The PDF is a dynamic XFA form. Its pages are generated when it opens.");
  }
  if (signed && !opts.allowSigned) {
    throw new IrisPdfError("signed", "The PDF is signed, and any change invalidates the signature. Pass --allow-signed.");
  }
  if (signed) warnings.push({ code: "signature_invalidated", detail: "The PDF was signed; the signature is now invalid." });

  return source;
}

// Marks an annotation /Contents that this tool wrote, so a retag can tell it from the author's.
const DESCRIBED = "IrisPdfContents";
export function describe(doc: mupdf.PDFDocument, annot: mupdf.PDFObject, text: string) {
  annot.put("Contents", doc.newString(text));
  annot.put(DESCRIBED, true);
}

// Drop the structure tree and what points into it. A page we tagged gets its
// original content back, so retagging our own output does not stack overlays.
function untag(doc: mupdf.PDFDocument): boolean {
  let restored = false;
  doc.getTrailer().get("Root").delete("StructTreeRoot");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i), contents = page.get("Contents");
    page.delete("StructParents");
    page.get("Annots").forEach((a) => {
      if (!a.isDictionary()) return;
      a.delete("StructParent");
      // A description we wrote is rewritten from the new HTML; the author's stays.
      if (a.get(DESCRIBED).isBoolean()) { a.delete("Contents"); a.delete(DESCRIBED); }
    });
    if (!contents.isArray() || contents.length < 3) continue;
    const body = (j: number) => { try { return contents.get(j).readStream().asString(); } catch { return null; } };
    // The frame, then the overlay if any.
    const end = [contents.length - 1, contents.length - 2].find((j) => j > 1 && body(j) === "\nQ EMC\n");
    if (body(0) !== "/Artifact BMC q\n" || end === undefined) continue;
    const original: mupdf.PDFObject[] = [];
    for (let j = 1; j < end; j++) original.push(contents.get(j));
    page.put("Contents", original);
    unmarkPage(doc, page); // the brackets around a figure's image
    restored = true;
  }
  return restored;
}

// Forms and tiling patterns keep the /StructParents and marked-content ids of
// an earlier tag tree, even when the tree is gone. A page given the same key
// would share their parent-tree entry: two streams claiming MCID 0, which PAC
// refuses to open. Each loses its key and its marked content, which draws nothing.
function unkeyForms(doc: mupdf.PDFDocument) {
  for (let n = 1; n < doc.countObjects(); n++) {
    const x = doc.newIndirect(n);
    if (!x.isStream() || !(x.get("Subtype").asName() === "Form" || x.get("PatternType").asNumber() === 1)) continue;
    x.delete("StructParents");
    x.delete("StructParent");
    let body: string;
    try {
      body = Buffer.from(x.readStream().asUint8Array()).toString("latin1");
    } catch {
      continue;
    }
    if (!/\/MCID\b/.test(withoutStrings(body))) continue;
    const clean = unmark(body);
    if (clean !== body) x.writeStream(Buffer.from(clean, "latin1"));
  }
}

// Every terminal field in the AcroForm tree.
export function forEachField(doc: mupdf.PDFDocument, fn: (field: mupdf.PDFObject) => void) {
  const visit = (field: mupdf.PDFObject, depth: number) => {
    if (depth > 32) return; // a cycle in a malformed tree
    const kids = field.get("Kids");
    // A kid with its own /T is a field; kids without one are widgets of this field.
    const fieldKids: mupdf.PDFObject[] = [];
    if (kids.isArray()) kids.forEach((k) => { if (!k.get("T").isNull()) fieldKids.push(k); });
    if (fieldKids.length) fieldKids.forEach((k) => visit(k, depth + 1));
    else fn(field);
  };
  const fields = doc.getTrailer().get("Root", "AcroForm", "Fields");
  if (fields.isArray()) fields.forEach((f) => visit(f, 0));
}

// A field attribute, looked up the /Parent chain as the spec requires.
export function inherited(field: mupdf.PDFObject, key: string): mupdf.PDFObject | null {
  for (let f = field, i = 0; !f.isNull() && i < 32; f = f.get("Parent"), i++) {
    const v = f.get(key);
    if (!v.isNull()) return v;
  }
  return null;
}

export function save(doc: mupdf.PDFDocument, rewrite = false): Uint8Array {
  // A copy: the buffer lives in mupdf's memory, which can move.
  return doc.saveToBuffer(rewrite ? "compress,encrypt=keep" : "incremental,compress").asUint8Array().slice();
}

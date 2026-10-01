// Open a PDF and refuse the ones we must not touch (spec §11).
import * as mupdf from "mupdf";
import { IrisPdfError, EXIT, type Warning } from "../report.ts";

export const MAX_PAGES = 25; // matches Iris's MAX_PDF_PAGES

export type Source = {
  doc: mupdf.PDFDocument;
  encrypted: boolean;
  signed: boolean;
  acroform: boolean;
  xfa: boolean;
  repaired: boolean; // damaged: saved as a full rewrite, not an update
  restored: boolean; // retagging our own output: pages got their original content back
  warnings: Warning[];
};

// readOnly: only reading (listing fields), so the refusals that protect the
// file from changes do not apply.
// retag: replace the tags of a PDF that has them.
export type OpenOptions = { password?: string; allowSigned?: boolean; retag?: boolean; readOnly?: boolean };

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
  const source = { doc, encrypted, signed, acroform: !acroform.isNull(), xfa, repaired, restored: false, warnings };
  if (opts.readOnly) return source;

  // An owner password can forbid changes. We do not work around it.
  if (!doc.hasPermission("edit")) {
    throw new IrisPdfError("permissions_denied", "The PDF's owner does not permit changes to it.");
  }
  // A damaged file cannot be updated in place. It is rewritten from what mupdf
  // repaired, which is also what the checks render as the original.
  if (source.repaired) warnings.push({ code: "repaired", detail: "The PDF was damaged; the output is a rewritten copy, not an update of the original bytes." });
  const pages = doc.countPages();
  if (pages > MAX_PAGES) {
    throw new IrisPdfError("too_many_pages", `The PDF has ${pages} pages; the limit is ${MAX_PAGES}.`);
  }
  if (!root.get("StructTreeRoot").isNull()) {
    if (!opts.retag) throw new IrisPdfError("already_tagged", "The PDF is already tagged. Pass --retag to replace its tags.");
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

// Drop the structure tree and what points into it. A page we tagged gets its
// original content back, so retagging our own output does not stack overlays.
function untag(doc: mupdf.PDFDocument): boolean {
  let restored = false;
  doc.getTrailer().get("Root").delete("StructTreeRoot");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i), contents = page.get("Contents");
    page.delete("StructParents");
    page.get("Annots").forEach((a) => { if (a.isDictionary()) a.delete("StructParent"); });
    if (!contents.isArray() || contents.length < 4) continue;
    const body = (j: number) => { try { return contents.get(j).readStream().asString(); } catch { return null; } };
    if (body(0) !== "/Artifact BMC q\n" || body(contents.length - 2) !== "\nQ EMC\n") continue;
    const original: mupdf.PDFObject[] = [];
    for (let j = 1; j < contents.length - 2; j++) original.push(contents.get(j));
    page.put("Contents", original);
    restored = true;
  }
  return restored;
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

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
  const source = { doc, encrypted, signed, acroform: !acroform.isNull(), xfa, warnings };
  if (opts.readOnly) return source;

  // An owner password can forbid changes. We do not work around it.
  if (!doc.hasPermission("edit")) {
    throw new IrisPdfError("permissions_denied", "The PDF's owner does not permit changes to it.");
  }
  if (doc.wasRepaired() || !doc.canBeSavedIncrementally()) {
    throw new IrisPdfError("damaged", "The PDF is damaged, so it cannot be updated without rewriting it.");
  }
  const pages = doc.countPages();
  if (pages > MAX_PAGES) {
    throw new IrisPdfError("too_many_pages", `The PDF has ${pages} pages; the limit is ${MAX_PAGES}.`);
  }
  if (!root.get("StructTreeRoot").isNull()) {
    throw new IrisPdfError("already_tagged", "The PDF is already tagged. Retagging it is not supported.");
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

export function save(doc: mupdf.PDFDocument): Uint8Array {
  // A copy: the buffer lives in mupdf's memory, which can move.
  return doc.saveToBuffer("incremental,compress").asUint8Array().slice();
}

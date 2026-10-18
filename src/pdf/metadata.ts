// Document-level requirements (spec §8.3): /Lang, /MarkInfo,
// /ViewerPreferences, the title, and XMP metadata declaring PDF/UA-1.
import * as mupdf from "mupdf";

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

// claimUa: declare PDF/UA-1. Only when there is a title and every page is tagged.
export function setDocumentInfo(doc: mupdf.PDFDocument, lang: string, title: string, claimUa: boolean) {
  const root = doc.getTrailer().get("Root");
  root.put("Lang", doc.newString(lang));
  root.put("MarkInfo", { Marked: true });
  nameLayerConfigs(doc, root);
  const meta = root.get("Metadata");
  const old = meta.isStream() ? meta.readStream().asString() : "";
  if (!title && !claimUa && !old) return;
  if (title) {
    const prefs = root.get("ViewerPreferences");
    if (prefs.isDictionary()) prefs.put("DisplayDocTitle", true);
    else root.put("ViewerPreferences", { DisplayDocTitle: true });
    doc.setMetaData("info:Title", title);
  }
  root.put("Metadata", doc.addStream(xmp(old, title, claimUa), { Type: "Metadata", Subtype: "XML" }));
}

// PDF/UA-1 7.10: every optional content configuration needs a /Name. It changes no pixel.
function nameLayerConfigs(doc: mupdf.PDFDocument, root: mupdf.PDFObject) {
  const oc = root.get("OCProperties");
  if (!oc.isDictionary()) return;
  const name = (d: mupdf.PDFObject, text: string) => {
    if (!d.isDictionary()) return;
    const had = d.get("Name");
    if (!(had.isString() && had.asString())) d.put("Name", doc.newString(text));
  };
  name(oc.get("D"), "Default");
  const configs = oc.get("Configs");
  if (configs.isArray()) configs.forEach((c, i) => name(c, `Configuration ${Number(i) + 1}`));
}

// PDF/UA-1 7.10 also forbids /AS in a configuration. Removing it could change which layers a
// viewer shows, which the pixel check would not see, so such a file makes no claim instead.
export function layersAutoState(doc: mupdf.PDFDocument): boolean {
  const oc = doc.getTrailer().get("Root", "OCProperties");
  if (!oc.isDictionary()) return false;
  const configs = [oc.get("D")];
  oc.get("Configs").forEach((c) => configs.push(c));
  return configs.some((c) => c.isDictionary() && !c.get("AS").isNull());
}

// Our title and PDF/UA claim go in their own rdf:Description. Any title or
// PDF/UA entry already there is removed first so the packet has one of each,
// and an old PDF/UA claim does not outlive a run that cannot make it.
export function xmp(old: string, title: string, claimUa = true): string {
  const ours =
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">` +
    (title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>` : "") +
    (claimUa ? `<pdfuaid:part>1</pdfuaid:part>` : "") +
    `</rdf:Description>`;
  if (old.includes("</rdf:RDF>")) {
    let cleaned = old
      .replace(/<pdfuaid:part\b[\s\S]*?<\/pdfuaid:part>/g, "")
      .replace(/\spdfuaid:part="[^"]*"/g, "");
    if (title) cleaned = cleaned.replace(/<dc:title\b[\s\S]*?<\/dc:title>/g, "").replace(/\sdc:title="[^"]*"/g, "");
    return cleaned.replace("</rdf:RDF>", ours + "</rdf:RDF>");
  }
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    ours + `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

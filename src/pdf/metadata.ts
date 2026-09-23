// Document-level requirements (spec §8.3): /Lang, /MarkInfo,
// /ViewerPreferences, the title, and XMP metadata declaring PDF/UA-1.
import * as mupdf from "mupdf";

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

// claimUa: declare PDF/UA-1. Only when there is a title and every page is tagged.
export function setDocumentInfo(doc: mupdf.PDFDocument, lang: string, title: string, claimUa: boolean) {
  const root = doc.getTrailer().get("Root");
  root.put("Lang", doc.newString(lang));
  root.put("MarkInfo", { Marked: true });
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

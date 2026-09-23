// The structure tree: StructTreeRoot, its elements, and the ParentTree that
// maps each page's marked content (and each annotation) back to its element.
import * as mupdf from "mupdf";

export class StructTree {
  doc: mupdf.PDFDocument;
  root: mupdf.PDFObject;
  top: mupdf.PDFObject; // the Document element
  byType: Record<string, number> = {};
  private pageOf = new Map<number, number>(); // element → the page its /Pg names
  private pageMcids = new Map<number, mupdf.PDFObject[]>(); // page object → element per MCID
  private annots: [number, mupdf.PDFObject][] = [];
  private nextKey = 0;
  private pageKeys = new Map<number, number>();
  private ids: [string, mupdf.PDFObject][] = [];

  constructor(doc: mupdf.PDFDocument) {
    this.doc = doc;
    this.root = doc.addObject({ Type: "StructTreeRoot" });
    this.top = this.add(this.root, "Document");
  }

  get elements() {
    return Object.values(this.byType).reduce((a, b) => a + b, 0);
  }

  add(parent: mupdf.PDFObject, type: string, extra: Record<string, unknown> = {}): mupdf.PDFObject {
    const elem = this.doc.addObject({ Type: "StructElem", S: type, P: parent, K: [], ...extra });
    if (parent === this.root) parent.put("K", elem);
    else parent.get("K").push(elem);
    this.byType[type] = (this.byType[type] ?? 0) + 1;
    return elem;
  }

  // A new marked-content id on the page, owned by elem.
  mcid(elem: mupdf.PDFObject, page: mupdf.PDFObject): number {
    const list = this.pageMcids.get(page.asIndirect()) ?? [];
    this.pageMcids.set(page.asIndirect(), list);
    const mcid = list.length;
    list.push(elem);
    this.pageKey(page);
    elem.get("K").push(this.onPage(elem, page) ? mcid : { Type: "MCR", Pg: page, MCID: mcid });
    return mcid;
  }

  // An annotation (link or widget) owned by elem.
  objr(elem: mupdf.PDFObject, page: mupdf.PDFObject, annot: mupdf.PDFObject) {
    const key = this.nextKey++;
    annot.put("StructParent", key);
    this.annots.push([key, elem]);
    this.onPage(elem, page);
    elem.get("K").push({ Type: "OBJR", Obj: annot, Pg: page });
  }

  // An /ID for elem, for table headers and notes. Ids must be unique.
  id(elem: mupdf.PDFObject, id: string) {
    elem.put("ID", this.doc.newString(id));
    this.ids.push([id, elem]);
  }

  finish() {
    const nums: unknown[] = [];
    for (const [page, key] of this.pageKeys) nums.push([key, this.pageMcids.get(page) ?? []]);
    for (const a of this.annots) nums.push(a);
    nums.sort((a, b) => (a as [number])[0] - (b as [number])[0]);
    this.root.put("ParentTree", this.doc.addObject({ Nums: nums.flat() }));
    this.root.put("ParentTreeNextKey", this.nextKey);
    if (this.ids.length) {
      const names = [...this.ids].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([id, e]) => [this.doc.newString(id), e]);
      this.root.put("IDTree", this.doc.addObject({ Names: names }));
    }
    this.doc.getTrailer().get("Root").put("StructTreeRoot", this.root);
  }

  private pageKey(page: mupdf.PDFObject) {
    if (this.pageKeys.has(page.asIndirect())) return;
    const key = this.nextKey++;
    this.pageKeys.set(page.asIndirect(), key);
    page.put("StructParents", key);
  }

  // Sets elem's /Pg the first time; true if elem's /Pg is this page.
  private onPage(elem: mupdf.PDFObject, page: mupdf.PDFObject): boolean {
    const n = elem.asIndirect();
    if (!this.pageOf.has(n)) {
      this.pageOf.set(n, page.asIndirect());
      elem.put("Pg", page);
    }
    return this.pageOf.get(n) === page.asIndirect();
  }
}

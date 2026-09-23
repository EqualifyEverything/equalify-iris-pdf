// Iris's HTML fragment -> a plain element tree with text runs.
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

export type Elem = { tag: string; attrs: Record<string, string>; kids: (Elem | string)[] };

type P5Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"];

export function parseHtml(html: string): Elem {
  return convert(parseFragment(html)) as Elem;
}

function convert(node: P5Node): Elem | string | null {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (!("childNodes" in node)) return null; // comments, doctypes
  const el = node as DefaultTreeAdapterMap["element"];
  const kids: (Elem | string)[] = [];
  // <template> keeps its children in .content
  for (const c of (el.nodeName === "template" ? (el as DefaultTreeAdapterMap["template"]).content : el).childNodes) {
    const k = convert(c as P5Node);
    if (k !== null) kids.push(k);
  }
  const attrs = Object.fromEntries((el.attrs ?? []).map((a) => [a.name, a.value]));
  return { tag: el.tagName ?? "#root", attrs, kids };
}

export function textOf(e: Elem | string): string {
  return typeof e === "string" ? e : e.kids.map(textOf).join("");
}

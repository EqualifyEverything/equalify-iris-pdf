// The spec's §8.1 table: which PDF structure type each HTML element becomes.
// Special cases (li, dl, img, a, input, label) are handled where the
// tree is built, in tag.ts; this file only names the types.

export const STRUCT: Record<string, string> = {
  h1: "H1", h2: "H2", h3: "H3", h4: "H4", h5: "H5", h6: "H6",
  p: "P",
  ul: "L", ol: "L", dl: "L", li: "LI", dt: "Lbl", dd: "LBody",
  table: "Table", caption: "Caption", thead: "THead", tbody: "TBody", tfoot: "TFoot",
  tr: "TR", th: "TH", td: "TD",
  figure: "Div", figcaption: "Caption", img: "Figure",
  a: "Link",
  blockquote: "BlockQuote", code: "Code", pre: "Code",
  input: "Form", select: "Form", textarea: "Form",
  nav: "Sect", aside: "Sect", section: "Sect", fieldset: "Sect", legend: "P",
  article: "Art", div: "Div", header: "Div", footer: "Div", main: "Div",
};

// Inline and wrapper elements add no structure: their text belongs to the
// enclosing element. A <label>'s text also names its field (spec §9.2).
export const TRANSPARENT = new Set([
  "#root", "form", "label", "span", "strong", "em", "b", "i", "u", "s", "small", "mark",
  "abbr", "time", "cite", "q", "sub", "sup", "br", "wbr", "bdi", "bdo", "data", "var", "kbd", "samp", "ins", "del",
]);

// Not content. <hr> is Iris's page separator, or a rule already on the page.
export const SKIP = new Set(["hr", "script", "style", "template", "head", "title", "meta", "link", "option", "optgroup"]);

// HTML list types -> /ListNumbering.
export function listNumbering(tag: string, type?: string): string {
  if (tag !== "ol") return tag === "ul" ? "Disc" : "None";
  return { a: "LowerAlpha", A: "UpperAlpha", i: "LowerRoman", I: "UpperRoman" }[type ?? ""] ?? "Decimal";
}

// An <ol> item's number as a browser shows it: decimal where letters or
// roman numerals can't say it.
export function listLabel(type: string | undefined, n: number): string {
  let s = "";
  if ((type === "a" || type === "A") && n > 0) {
    for (let m = n; m > 0; m = Math.floor((m - 1) / 26)) s = String.fromCharCode(97 + ((m - 1) % 26)) + s;
  } else if ((type === "i" || type === "I") && n > 0 && n < 4000) {
    let m = n;
    for (const [v, r] of ROMAN) for (; m >= v; m -= v) s += r;
  } else return String(n);
  return type === "A" || type === "I" ? s.toUpperCase() : s;
}

const ROMAN: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

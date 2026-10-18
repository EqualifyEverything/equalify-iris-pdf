// MathML -> the words a screen reader would speak for it. In HTML a reader
// speaks the MathML itself; in the PDF the Formula's Alt is all it gets.
import type { Elem } from "./parse.ts";

const SKIP = new Set(["annotation", "annotation-xml", "mspace", "mphantom", "mprescripts", "none"]);
const TOKEN = new Set(["mi", "mn", "mo", "mtext", "ms"]);
const INVISIBLE = /[⁡-⁤]/g; // function application, invisible times, separator, plus
const ACCENT: Record<string, string> = { "^": "hat", "ˆ": "hat", "¯": "bar", "‾": "bar", "~": "tilde", "˜": "tilde", "˙": "dot", "→": "vector" };

const clean = (s: string) => s.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
const elems = (e: Elem) => e.kids.filter((k): k is Elem => typeof k !== "string" && !SKIP.has(k.tag));

// The token texts (mi, mn, mo, mtext, ms) in order: the formula's words on the page.
export function mathTokens(e: Elem | string): string[] {
  if (typeof e === "string") return clean(e) ? [clean(e)] : [];
  return SKIP.has(e.tag) ? [] : e.kids.flatMap(mathTokens);
}

export function speak(e: Elem): string {
  return clean(say(e));
}

function say(e: Elem): string {
  if (TOKEN.has(e.tag)) return mathTokens(e).join("");
  const [a, b, c] = elems(e).map(say);
  const simple = (i: number) => mathTokens(elems(e)[i] ?? "").length <= 1;
  const end = (i: number, word: string) => (simple(i) ? "" : ` end ${word}`);
  switch (e.tag) {
    case "mfrac": return simple(0) && simple(1) ? `${a} over ${b}` : `fraction ${a} over ${b} end fraction`;
    case "msqrt": return `square root of ${elems(e).map(say).join(" ")} end root`;
    case "mroot": return `root with index ${b} of ${a} end root`;
    case "msup": return `${a} ${power(b, simple(1))}`;
    case "msub": return `${a} sub ${b}${end(1, "sub")}`;
    case "msubsup": return `${a} sub ${b}${end(1, "sub")} ${power(c, simple(2))}`;
    case "munder": return `${a} under ${b}${end(1, "under")}`;
    case "mover": return ACCENT[b] ? `${a} ${ACCENT[b]}` : `${a} over ${b}${end(1, "over")}`;
    case "munderover": return `${a} from ${b} to ${c}`;
    case "mtable": return `table ${elems(e).map((r, i) => `row ${i + 1} ${elems(r).map(say).join(", ")}`).join(", ")} end table`;
    case "mfenced": {
      const sep = e.attrs.separators ?? ",";
      return `${e.attrs.open ?? "("} ${elems(e).map(say).join(` ${sep.trim()[0] ?? ""} `)} ${e.attrs.close ?? ")"}`;
    }
    case "semantics": return a ?? "";
  }
  return elems(e).map(say).join(" "); // mrow, mstyle, mpadded, menclose, math and the rest
}

function power(p: string, simple: boolean): string {
  if (p === "2") return "squared";
  if (p === "3") return "cubed";
  if (p === "′" || p === "'") return "prime";
  return `to the power ${p}${simple ? "" : " end power"}`;
}

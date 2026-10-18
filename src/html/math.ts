// MathML -> the words a screen reader would speak for it. In HTML a reader
// speaks the MathML itself; in the PDF the Formula's Alt is all it gets.
import type { Elem } from "./parse.ts";

const SKIP = new Set(["annotation", "annotation-xml", "mspace", "mphantom", "mprescripts", "none"]);
const TOKEN = new Set(["mi", "mn", "mo", "mtext", "ms"]);
const INVISIBLE = /[⁡-⁤]/g; // function application, invisible times, separator, plus
const ACCENT = new Map(Object.entries({ "^": "hat", "ˆ": "hat", "¯": "bar", "‾": "bar", "~": "tilde", "˜": "tilde", "˙": "dot", "→": "vector" }));

const clean = (s: string) => s.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
const elems = (e: Elem) => e.kids.filter((k): k is Elem => typeof k !== "string" && !SKIP.has(k.tag));

// The token texts (mi, mn, mo, mtext, ms) in order: the formula's words on the page.
export function mathTokens(e: Elem | string): string[] {
  if (typeof e === "string") return clean(e) ? [clean(e)] : [];
  return SKIP.has(e.tag) ? [] : e.kids.flatMap(mathTokens);
}

// "" for MathML that is malformed: a script or fraction with the wrong number of children.
export function speak(e: Elem): string {
  const { text } = say(e);
  return text === null ? "" : clean(text);
}

const ARITY: Record<string, number> = { mfrac: 2, mroot: 2, msup: 2, msub: 2, msubsup: 3, munder: 2, mover: 2, munderover: 3 };

// Each node is spoken once, from its children's speech, so the work is linear in its size.
// tokens: how many tokens the node holds; one is simple enough to need no "end" marker.
type Said = { text: string | null; tokens: number };
function say(e: Elem): Said {
  if (TOKEN.has(e.tag)) {
    const text = mathTokens(e).join("");
    return { text, tokens: text ? 1 : 0 };
  }
  const parts = elems(e).map(say);
  const tokens = parts.reduce((n, p) => n + p.tokens, 0);
  if (parts.some((p) => p.text === null) || (Object.hasOwn(ARITY, e.tag) && parts.length !== ARITY[e.tag])) return { text: null, tokens };
  return { text: speech(e, parts as { text: string; tokens: number }[]), tokens };
}

function speech(e: Elem, parts: { text: string; tokens: number }[]): string {
  const [a, b, c] = parts.map((p) => p.text);
  const simple = (i: number) => (parts[i]?.tokens ?? 0) <= 1;
  const end = (i: number, word: string) => (simple(i) ? "" : ` end ${word}`);
  const all = (sep: string) => parts.map((p) => p.text).join(sep);
  switch (e.tag) {
    case "mfrac": return simple(0) && simple(1) ? `${a} over ${b}` : `fraction ${a} over ${b} end fraction`;
    case "msqrt": return `square root of ${all(" ")} end root`;
    case "mroot": return `root with index ${b} of ${a} end root`;
    case "msup": return `${a} ${power(b, simple(1))}`;
    case "msub": return `${a} sub ${b}${end(1, "sub")}`;
    case "msubsup": return `${a} sub ${b}${end(1, "sub")} ${power(c, simple(2))}`;
    case "munder": return `${a} under ${b}${end(1, "under")}`;
    case "mover": return ACCENT.has(b) ? `${a} ${ACCENT.get(b)}` : `${a} over ${b}${end(1, "over")}`;
    case "munderover": return `${a} from ${b} to ${c}`;
    case "mtable": return `table ${parts.map((p, i) => `row ${i + 1} ${p.text}`).join(", ")} end table`;
    case "mtr": return all(", ");
    case "mfenced": return `${e.attrs.open ?? "("} ${all(` ${(e.attrs.separators ?? ",").trim()[0] ?? ""} `)} ${e.attrs.close ?? ")"}`;
    case "semantics": return a ?? "";
  }
  return all(" "); // mrow, mstyle, mpadded, menclose, math and the rest
}

function power(p: string, simple: boolean): string {
  if (p === "2") return "squared";
  if (p === "3") return "cubed";
  if (p === "′" || p === "'") return "prime";
  return `to the power ${p}${simple ? "" : " end power"}`;
}

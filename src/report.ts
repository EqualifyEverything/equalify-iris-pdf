// The report is this tool's honesty surface: every page, every field, and
// everything the source file made impossible. It is built only here.

export const VERSION = "0.1.0";

export type Warning = { code: string; page?: number; detail?: string };

export type PageReport = {
  page: number;
  textSource: "pdf-text" | "ocr" | "approximate" | "none";
  words: number;
  matched: number;
  addedFromHtml: number;
  furniture: number;
  lost: number;
  redrawn: number; // words of the page's own text drawn again in the overlay
  mcids: number;
};

// --report-detail: where and why, not just how many. Capped so 25 pages stay
// under a megabyte: lists of 50 words of at most 40 characters, and a tree of
// at most 2000 elements and 400 kB. It never holds a form value; a flattened
// field's element gives its field name instead of its text.
export const MAX_LISTED = 50, MAX_WORD = 40, MAX_ELEMENTS = 2000, MAX_TREE_BYTES = 400_000, MAX_EXCERPT = 80, MAX_ALT = 300;
export type WordList = { count: number; words: string[] }; // words: the first MAX_LISTED
export type PageDetail = {
  page: number;
  matched: WordList; // Iris's words found on the page, tagged there
  furniture: WordList; // page words left out as headers, footers, page numbers: artifacts
  added: WordList; // Iris's words the page does not draw: put in the added text layer
  lost: WordList; // page words not in the HTML: kept as a paragraph (unmatched_text)
  redrawn: WordList; // page words drawn again in the added layer (duplicate_text_layer)
  differingPixels: number;
  textKept: boolean;
};
export type ElemDetail = {
  type: string; page?: number; text?: string; alt?: string; lang?: string; href?: string; field?: string; kids?: ElemDetail[];
};
export type Detail = {
  timing: { open: number; form: number; read: number; match: number; tag: number; save: number; check: number }; // ms
  pages: PageDetail[];
  structure: ElemDetail | null; // the first MAX_ELEMENTS elements, depth first
  structureTruncated: boolean;
  fields: {
    created: { name: string; type: string; page: number; box: number[]; label: string }[]; // box: page points, from the top left
    unresolved: { name: string; page?: number; code: string }[]; // code: the warning that says why
  };
};

export function newDetail(): Detail {
  return {
    timing: { open: 0, form: 0, read: 0, match: 0, tag: 0, save: 0, check: 0 },
    pages: [], structure: null, structureTruncated: false, fields: { created: [], unresolved: [] },
  };
}

export const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
export const wordList = (words: string[]): WordList => ({ count: words.length, words: words.slice(0, MAX_LISTED).map((w) => cut(w, MAX_WORD)) });

export type Report = {
  tool: string;
  source: {
    pages: number;
    encrypted: boolean;
    signed: boolean;
    acroform: boolean;
    xfa: boolean;
    hadTextLayer: number[];
  };
  pages: PageReport[];
  structure: { elements: number; byType: Record<string, number> };
  // created: the fields made for a flat form, from its HTML.
  form: { fields: number; set: number; skippedReadOnly: number; unresolved: string[]; created: { name: string; type: string; page: number }[] };
  verification: {
    pixels: "identical-outside-fields" | "failed" | "off";
    differingPixels: number;
    textPreserved: boolean | null;
  };
  pdfua: { checked: false };
  sizeIncreaseBytes: number;
  warnings: Warning[];
  error?: { code: string; message: string };
  detail?: Detail;
};

export function newReport(): Report {
  return {
    tool: `iris-pdf ${VERSION}`,
    source: { pages: 0, encrypted: false, signed: false, acroform: false, xfa: false, hadTextLayer: [] },
    pages: [],
    structure: { elements: 0, byType: {} },
    form: { fields: 0, set: 0, skippedReadOnly: 0, unresolved: [], created: [] },
    verification: { pixels: "off", differingPixels: 0, textPreserved: null },
    pdfua: { checked: false },
    sizeIncreaseBytes: 0,
    warnings: [],
  };
}

// Exit codes from the CLI contract: 1 refused, 2 verification failed, 3 bad input.
export const EXIT = { refused: 1, verification: 2, badInput: 3 } as const;

// Every refusal and failure is one of these: a code, a one-line message, and
// the exit status the CLI uses. Never a crash, never a silent degradation.
export class IrisPdfError extends Error {
  code: string;
  exit: number;
  constructor(code: string, message: string, exit: number = EXIT.refused) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

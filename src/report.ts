// The report is this tool's honesty surface: every page, every field, and
// everything the source file made impossible. It is built only here.

export const VERSION = "0.1.0";

export type Warning = { code: string; page?: number; detail?: string };

export type PageReport = {
  page: number;
  textSource: "pdf-text" | "ocr" | "none";
  words: number;
  matched: number;
  addedFromHtml: number;
  furniture: number;
  lost: number;
  mcids: number;
};

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
  form: { fields: number; set: number; skippedReadOnly: number; unresolved: string[] };
  verification: {
    pixels: "identical-outside-fields" | "failed" | "off";
    differingPixels: number;
    textPreserved: boolean | null;
  };
  pdfua: { checked: false };
  sizeIncreaseBytes: number;
  warnings: Warning[];
  error?: { code: string; message: string };
};

export function newReport(): Report {
  return {
    tool: `iris-pdf ${VERSION}`,
    source: { pages: 0, encrypted: false, signed: false, acroform: false, xfa: false, hadTextLayer: [] },
    pages: [],
    structure: { elements: 0, byType: {} },
    form: { fields: 0, set: 0, skippedReadOnly: 0, unresolved: [] },
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

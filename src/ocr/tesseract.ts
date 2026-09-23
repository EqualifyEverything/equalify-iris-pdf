// Word boxes for scanned pages, from Tesseract (spec §7.4). Only the boxes
// are used; the words placed on the page are always Iris's.
import * as mupdf from "mupdf";
import { spawnSync } from "node:child_process";
import type { PageWord } from "../align/words.ts";

const DPI = 300;

let installed: boolean | undefined;
export function tesseractInstalled(): boolean {
  installed ??= spawnSync("tesseract", ["--version"], { stdio: "ignore" }).status === 0;
  return installed;
}

// null when Tesseract is not installed.
export function ocrWords(page: mupdf.PDFPage, lang = "eng"): PageWord[] | null {
  if (!tesseractInstalled()) return null;
  const s = DPI / 72;
  const png = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false).asPNG();
  const run = spawnSync("tesseract", ["stdin", "stdout", "-l", lang, "tsv"], { input: png, maxBuffer: 64 << 20 });
  if (run.status !== 0) throw new Error(`tesseract failed: ${run.stderr.toString().trim()}`);
  return parseTsv(run.stdout.toString(), s);
}

// Tesseract's TSV: one row per word (level 5), boxes in pixels.
export function parseTsv(tsv: string, scale: number): PageWord[] {
  const words: PageWord[] = [];
  for (const line of tsv.split("\n").slice(1)) {
    const f = line.split("\t");
    if (f[0] !== "5" || !f[11]?.trim()) continue;
    const [x, y, w, h] = f.slice(6, 10).map((v) => Number(v) / scale);
    words.push({ text: f[11].trim(), box: [x, y, x + w, y + h], baseline: y + h, size: h });
  }
  return words;
}

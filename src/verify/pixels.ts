// Guarantee 1 (spec §10.1): outside the fields whose values changed, every
// page renders to byte-identical pixels.
import * as mupdf from "mupdf";
import type { Box } from "../align/words.ts";

export type PixelFailure = { page: number; differing: number; box: Box };

// `changed` holds, per page index, the field rectangles that may differ.
export function comparePixels(
  before: mupdf.PDFDocument, after: mupdf.PDFDocument, dpi: number, changed: Map<number, Box[]>,
): PixelFailure[] {
  const failures: PixelFailure[] = [];
  const s = dpi / 72, m = mupdf.Matrix.scale(s, s);
  for (let i = 0; i < before.countPages(); i++) {
    // showExtras: draw annotations and form fields too.
    const a = before.loadPage(i).toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
    const b = after.loadPage(i).toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
    const w = a.getWidth(), h = a.getHeight();
    if (w !== b.getWidth() || h !== b.getHeight()) {
      failures.push({ page: i + 1, differing: w * h, box: [0, 0, w / s, h / s] });
      continue;
    }
    // Field rectangles in pixels, padded for anti-aliasing at the edges.
    const skip = (changed.get(i) ?? []).map((r) => r.map((v, k) => Math.round(v * s) + (k < 2 ? -2 : 2)));
    const pa = a.getPixels(), pb = b.getPixels(), stride = a.getStride();
    let differing = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * stride + x * 3;
        if (pa[o] === pb[o] && pa[o + 1] === pb[o + 1] && pa[o + 2] === pb[o + 2]) continue;
        if (skip.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3])) continue;
        differing++;
        x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x + 1), y1 = Math.max(y1, y + 1);
      }
    }
    if (differing) failures.push({ page: i + 1, differing, box: [x0 / s, y0 / s, x1 / s, y1 / s] });
  }
  return failures;
}

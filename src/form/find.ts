// Where a flat form's blanks are. Iris gives no positions, so each is looked
// for in the rendered page near its label: an underline or a box for text, a
// small hollow square or circle for a check box or radio button, a table cell.
// Nothing found with confidence is nothing placed: a field in the wrong place is worse than none.
import * as mupdf from "mupdf";
import type { Box } from "../align/words.ts";

const SCALE = 2; // 144 dpi

// The page's ink: pixels well darker than the paper, so tinted paper works too.
export class Ink {
  readonly w: number; readonly h: number;
  private dark: Uint8Array;
  private gray: Uint8Array;
  private paper: number;
  private x0: number; private y0: number;
  constructor(page: mupdf.Page) {
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceGray, false);
    this.w = pix.getWidth(), this.h = pix.getHeight(), this.x0 = pix.getX(), this.y0 = pix.getY();
    const px = pix.getPixels(), stride = pix.getStride();
    const hist = new Uint32Array(256);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) hist[px[y * stride + x]]++;
    const paper = (this.paper = hist.indexOf(Math.max(...hist))); // the commonest shade
    this.dark = new Uint8Array(this.w * this.h);
    this.gray = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const g = (this.gray[y * this.w + x] = px[y * stride + x]);
      this.dark[y * this.w + x] = g < paper * 0.7 ? 1 : 0;
    }
    pix.destroy();
  }
  at(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.dark[y * this.w + x] === 1;
  }
  // Ink too light to stop a ray, as a table's dotted or gray row lines are.
  faint(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.gray[y * this.w + x] < this.paper * 0.93;
  }
  toPx(b: Box): Box { return [b[0] * SCALE - this.x0, b[1] * SCALE - this.y0, b[2] * SCALE - this.x0, b[3] * SCALE - this.y0].map(Math.round) as Box; }
  toPage(b: Box): Box { return [(b[0] + this.x0) / SCALE, (b[1] + this.y0) / SCALE, (b[2] + this.x0) / SCALE, (b[3] + this.y0) / SCALE]; }
}

const inside = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const meets = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// A horizontal rule through a dark pixel, followed both ways through small gaps
// and a pixel of drift per step, as a scan's lines have. ys: its row at each column.
type Rule = { x0: number; x1: number; ys: Map<number, number> };
function rule(ink: Ink, x: number, y: number): Rule {
  const ys = new Map([[x, y]]);
  let x0 = x, x1 = x;
  for (const dir of [1, -1]) {
    let cx = x, cy = y, gap = 0;
    while (gap <= 3 && cx > 0 && cx < ink.w - 1) {
      cx += dir;
      const dy = [0, -1, 1].find((d) => ink.at(cx, cy + d));
      if (dy === undefined) { gap++; continue; }
      cy += dy, gap = 0;
      ys.set(cx, cy);
      if (dir > 0) x1 = cx; else x0 = cx;
    }
  }
  return { x0, x1, ys };
}

// Thin where it runs: not a line of text whose letters happen to touch.
function thin(ink: Ink, r: Rule, most: number): boolean {
  let ok = 0, n = 0;
  for (const [x, y] of r.ys) {
    if (x % 3) continue;
    let top = y, bottom = y;
    while (ink.at(x, top - 1) && y - top < most + 1) top--;
    while (ink.at(x, bottom + 1) && bottom - y < most + 1) bottom++;
    n++;
    if (bottom - top + 1 <= most) ok++;
  }
  return n > 0 && ok / n >= 0.85;
}

// A line from `from` to `to`, followed both ways from (start, at) with a pixel
// of drift per step, as a skewed scan's lines have: how much of it is ink, and
// where it is halfway.
function along(ink: (t: number, c: number) => boolean, at: number, start: number, from: number, to: number) {
  let hit = 0, mid = at;
  for (const dir of [1, -1]) {
    for (let t = dir > 0 ? start : start - 1, c = at; dir > 0 ? t <= to : t >= from; t += dir) {
      const d = [0, -1, 1].find((d) => ink(t, c + d));
      if (d !== undefined) c += d, hit++;
      if (t === Math.round((from + to) / 2)) mid = c;
    }
  }
  return { share: to > from ? hit / (to - from + 1) : 0, mid };
}

// A box's edge, found by a ray at `start`: most of it must be ink.
function edge(ink: Ink, horizontal: boolean, at: number, start: number, from: number, to: number): boolean {
  const dark = horizontal ? (t: number, c: number) => ink.at(t, c) : (t: number, c: number) => ink.at(c, t);
  return along(dark, at, start, from, to).share >= 0.8;
}

// The box drawn around a light seed pixel, as [left, top, right, bottom] lines, or null.
export function enclosure(ink: Ink, sx: number, sy: number): Box | null {
  if (ink.at(sx, sy)) return null;
  const ray = (dx: number, dy: number) => {
    let x = sx, y = sy;
    for (;;) {
      x += dx, y += dy;
      if (x < 0 || y < 0 || x >= ink.w || y >= ink.h) return null;
      // Three pixels wide, so a dotted line still stops it.
      if (ink.at(x, y) || ink.at(x + dy, y + dx) || ink.at(x - dy, y - dx)) return dx ? x : y;
    }
  };
  const l = ray(-1, 0), r = ray(1, 0), t = ray(0, -1), b = ray(0, 1);
  if (l === null || r === null || t === null || b === null) return null;
  const sides = edge(ink, true, t, sx, l, r) && edge(ink, true, b, sx, l, r) && edge(ink, false, l, sy, t, b) && edge(ink, false, r, sy, t, b);
  return sides ? [l, t, r, b] : null;
}

export type Find = {
  ink: Ink;
  label: Box; // page space
  obstacles: Box[]; // page space: words of the page's text, and fields already placed
};

// A text field's blank: an underline beside or under its label, else a box to its right or below.
export function textBlank(f: Find, multiline = false): Box | null {
  const { ink } = f;
  const L = ink.toPx(f.label), lh = Math.max(8, L[3] - L[1]);
  const obstacles = f.obstacles.map((o) => ink.toPx(o)).filter((o) => !meets(o, L));
  // The search stops at the next word along the label's line.
  const limit = Math.min(ink.w - 1, ...obstacles.filter((o) => o[0] > L[2] && o[1] < L[3] && o[3] > L[1]).map((o) => o[0]));
  const pad = Math.round(lh * 0.3);
  const fits = (b: Box) => b[2] - b[0] >= 2 * lh && !obstacles.some((o) => meets(o, b));

  const seen = new Set<number>();
  let best: { box: Box; score: number } | null = null;
  for (let y = Math.round(L[3] - lh * 0.5); y <= L[3] + lh * 1.5; y++) {
    for (let x = L[0]; x <= Math.min(limit, L[2] + 8 * lh); x++) {
      if (!ink.at(x, y) || seen.has(y * ink.w + x) || obstacles.some((o) => inside(o, x, y))) continue;
      const r = rule(ink, x, y);
      for (const [rx, ry] of r.ys) seen.add(ry * ink.w + rx);
      if (r.x1 < L[2] + 2 * lh || !thin(ink, r, Math.max(5, lh * 0.35))) continue;
      const at = Math.min(...r.ys.values());
      const e = enclosure(ink, Math.round((r.x0 + r.x1) / 2), at - 3);
      if (e && Math.abs(e[3] - at) <= 3) continue; // a box's bottom: the box is the blank
      const box: Box = [Math.max(r.x0, L[2] + pad), Math.round(at - lh * 1.25), r.x1, at - 1];
      // Clip at the next word over the rule: it is the next label.
      const next = obstacles.filter((o) => meets(o, [box[0], box[1], box[2], box[3]]) && o[0] > box[0]).map((o) => o[0]);
      if (next.length) box[2] = Math.min(...next) - pad;
      if (!fits(box)) continue;
      const score = Math.max(0, r.x0 - L[2]) + 2 * Math.abs(at - L[3]);
      if (!best || score < best.score) best = { box, score };
    }
  }
  if (best) return ink.toPage(best.box);

  // A box: seeded just right of the label, or just inside the line below it.
  const my = Math.round((L[1] + L[3]) / 2), seeds: [number, number][] = [[L[2] + pad, my]];
  let x = L[2] + pad; // past the next line to the right, a box's left side
  while (x < Math.min(limit, L[2] + 8 * lh) && !ink.at(x, my)) x++;
  while (ink.at(x, my)) x++;
  seeds.push([x + 2, my]);
  for (let y = L[3] + 1, cx = Math.round((L[0] + L[2]) / 2); y < L[3] + 2 * lh; y++) {
    if (!ink.at(cx, y)) continue;
    while (ink.at(cx, y) && y < L[3] + 3 * lh) y++;
    seeds.push([cx, y + 3]);
    break;
  }
  for (const [sx, sy] of seeds) {
    const e = enclosure(ink, sx, sy);
    if (!e) continue;
    const box: Box = [Math.max(e[0], inside(e, L[0], L[1]) ? L[2] : e[0]) + pad, e[1] + 2, e[2] - 2, e[3] - 2];
    const tall = box[3] - box[1];
    if (tall >= 0.9 * lh && tall <= (multiline ? 30 : 4) * lh && fits(box)) return ink.toPage(box);
  }
  return null;
}

// The cell around a point, its lines in page space.
export function cellAt(ink: Ink, p: [number, number]): Box | null {
  const [sx, sy] = ink.toPx([p[0], p[1], p[0], p[1]]);
  const e = enclosure(ink, sx, sy);
  return e && ink.toPage(e);
}

// A cell's rows, split at lines too faint to stop a ray. lh: the text height.
export function rowsOf(ink: Ink, cell: Box, lh: number): Box[] {
  const [l, t, r, b] = ink.toPx(cell), min = lh * 0.9 * SCALE;
  const ys: number[] = [], faint = (x: number, y: number) => ink.faint(x, y);
  for (let y = t + 3; y <= b - 3; y++) {
    let x = l + 3; // trace from the row's first ink
    while (x <= r - 3 && !faint(x, y)) x++;
    const { share, mid } = along(faint, y, x, l + 3, r - 3);
    if (x <= r - 3 && share >= 0.6 && mid > t + min / 2 && mid < b - min / 2) ys.push(mid); // not the cell's own border
  }
  ys.sort((a, b) => a - b);
  const cuts: number[] = []; // the middle of each line
  for (let k = 0, s = 0; k < ys.length; k++) if (!(ys[k + 1] - ys[k] <= 3)) cuts.push(Math.round((ys[s] + ys[k]) / 2)), (s = k + 1);
  const edges = [t, ...cuts, b];
  const rows = edges.slice(1).map((y, k): Box => [l, edges[k], r, y]);
  return rows.every((x) => x[3] - x[1] >= min) ? rows.map((x) => ink.toPage(x)) : [cell];
}

// The cell under a point: down to the next line, then past it.
export function cellUnder(ink: Ink, p: [number, number]): Box | null {
  const [x, top] = ink.toPx([p[0], p[1], p[0], p[1]]);
  const line = (y: number) => ink.at(x - 1, y) || ink.at(x, y) || ink.at(x + 1, y);
  // The first ink may be the label's own letters: try each line in turn.
  for (let y = top, end = Math.min(ink.h - 1, top + 100); y < end; ) {
    while (y < end && !line(y)) y++;
    const from = y;
    while (y < from + 8 && line(y)) y++;
    if (y >= end || line(y)) return null;
    // A scan's line is ragged or skewed: seeds just past it may still touch it.
    for (let d = 1; d <= 12 && !line(y + d); d++) {
      const e = enclosure(ink, x, y + d);
      if (e) return ink.toPage(e);
    }
  }
  return null;
}

// A table cell's blank: inside its lines, if nothing is written there. lh: the text height.
export function cellBlank(f: Omit<Find, "label">, cell: Box, lh: number): Box | null {
  const box: Box = [cell[0] + 1.5, cell[1] + 1.5, cell[2] - 1.5, cell[3] - 1.5];
  if (box[3] - box[1] < lh * 0.9 || box[2] - box[0] < lh * 2 || f.obstacles.some((o) => meets(o, box))) return null;
  return box;
}

// A check box or radio button: a small hollow mark, roughly square, just left
// of its label, else just right of it.
export function markBlank(f: Find): Box | null {
  const { ink } = f;
  const L = ink.toPx(f.label), lh = Math.max(8, L[3] - L[1]), cy = (L[1] + L[3]) / 2;
  const all = f.obstacles.map((o) => ink.toPx(o)), others = all.filter((o) => !meets(o, L));
  // Left of the label, then right, then at its start: OCR may read the mark as part of the word.
  for (const side of [-1, 1, 0]) {
    const win: Box = side < 0 ? [L[0] - 3 * lh, cy - 1.2 * lh, L[0] - 1, cy + 1.2 * lh]
      : side > 0 ? [L[2] + 1, cy - 1.2 * lh, L[2] + 3 * lh, cy + 1.2 * lh] : [L[0], cy - 1.2 * lh, L[0] + 1.7 * lh, cy + 1.2 * lh];
    const words = side ? all : others;
    const m = Math.round(lh * 0.5), outer: Box = [win[0] - m, win[1] - m, win[2] + m, win[3] + m];
    const seen = new Set<number>();
    let best: { box: Box; d: number } | null = null;
    for (let y = Math.round(win[1]); y <= win[3]; y++) {
      for (let x = Math.round(win[0]); x <= win[2]; x++) {
        if (!ink.at(x, y) || seen.has(y * ink.w + x)) continue;
        const c = component(ink, x, y, outer, seen);
        if (!c) continue;
        const [x0, y0, x1, y1] = c.box, w = x1 - x0 + 1, h = y1 - y0 + 1;
        const ok = w >= 0.6 * lh && h >= 0.6 * lh && w <= 2.2 * lh && h <= 2.2 * lh && w / h >= 0.6 && w / h <= 1.6 &&
          c.count / (w * h) < 0.5 && hollow(ink, c.box) && !words.some((o) => meets(o, c.box));
        // A letter at the word's start is followed closely by the next one.
        if (!ok || (!side && !clear(ink, [x1 + 1, y0, x1 + Math.round(0.15 * lh), y1]))) continue;
        const d = side < 0 ? L[0] - x1 : x0 - L[2];
        if (!best || d < best.d) best = { box: c.box, d };
      }
    }
    if (best) return ink.toPage(best.box);
  }
  return null;
}

// The 8-connected ink around (x, y), or null if it runs out of the window.
function component(ink: Ink, x: number, y: number, win: Box, seen: Set<number>): { box: Box; count: number } | null {
  const stack = [[x, y]], box: Box = [x, y, x, y];
  let count = 0, out = false;
  seen.add(y * ink.w + x);
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    count++;
    if (!inside(win, cx, cy)) { out = true; continue; }
    box[0] = Math.min(box[0], cx), box[1] = Math.min(box[1], cy), box[2] = Math.max(box[2], cx), box[3] = Math.max(box[3], cy);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy, k = ny * ink.w + nx;
      if (ink.at(nx, ny) && !seen.has(k)) { seen.add(k); stack.push([nx, ny]); }
    }
  }
  return out ? null : { box, count };
}

const clear = (ink: Ink, b: Box) => {
  for (let y = b[1]; y <= b[3]; y++) for (let x = b[0]; x <= b[2]; x++) if (ink.at(x, y)) return false;
  return true;
};

// No ink in the middle third.
function hollow(ink: Ink, b: Box): boolean {
  const w = b[2] - b[0], h = b[3] - b[1];
  for (let y = Math.round(b[1] + h / 3); y <= b[3] - h / 3; y++) for (let x = Math.round(b[0] + w / 3); x <= b[2] - w / 3; x++) if (ink.at(x, y)) return false;
  return true;
}

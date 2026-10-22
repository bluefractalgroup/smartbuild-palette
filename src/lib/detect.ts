import { medianColor, meanColor, toHex } from "./color";
import type { Box, Candidate, TextLine } from "./types";

/**
 * Finds color chips on a rendered page.
 *
 * Solid chips: the page is split into small cells; flat cells are flood-filled into
 * regions of one color, and roughly rectangular regions of chip size are kept.
 * The chip color is the median of the pixels inside, so it is exactly what the
 * chart prints — no estimation.
 *
 * Textured chips (galvalume, metallics) are images placed in the PDF at chip size.
 */
export interface DetectOptions {
  cell?: number;
  /** Max per-channel spread inside a cell for it to count as flat. */
  flatTolerance?: number;
  /** Max per-channel difference between neighbouring cells of one region. */
  joinTolerance?: number;
}

const CHIP_MIN_SIDE = 0.022; // fraction of the page's shorter side
const CHIP_MAX_AREA = 0.06; // fraction of page area
const CHIP_MIN_AREA = 0.0012;
const MAX_ASPECT = 4.5;

function chipShaped(b: Box, pw: number, ph: number) {
  const short = Math.min(pw, ph);
  const area = (b.w * b.h) / (pw * ph);
  const aspect = Math.max(b.w / b.h, b.h / b.w);
  return (
    Math.min(b.w, b.h) >= CHIP_MIN_SIDE * short &&
    area >= CHIP_MIN_AREA &&
    area <= CHIP_MAX_AREA &&
    aspect <= MAX_ASPECT
  );
}

function containsText(b: Box, text: TextLine[]) {
  const ix = b.w * 0.06, iy = b.h * 0.06;
  return text.some((t) => {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    return cx > b.x + ix && cx < b.x + b.w - ix && cy > b.y + iy && cy < b.y + b.h - iy;
  });
}

export function inset(b: Box, frac: number): Box {
  return { x: b.x + b.w * frac, y: b.y + b.h * frac, w: b.w * (1 - 2 * frac), h: b.h * (1 - 2 * frac) };
}

export function detectSolids(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  text: TextLine[],
  opts: DetectOptions = {},
): Omit<Candidate, "id">[] {
  const cell = opts.cell ?? 4;
  const flatTol = opts.flatTolerance ?? 10;
  const joinTol = opts.joinTolerance ?? 8;
  const cw = Math.floor(width / cell), ch = Math.floor(height / cell);
  const mean = new Float32Array(cw * ch * 3);
  const flat = new Uint8Array(cw * ch);

  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let mnR = 255, mnG = 255, mnB = 255, mxR = 0, mxG = 0, mxB = 0, sR = 0, sG = 0, sB = 0;
      for (let y = cy * cell; y < cy * cell + cell; y++) {
        let i = (y * width + cx * cell) * 4;
        for (let x = 0; x < cell; x++, i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          sR += r; sG += g; sB += b;
          if (r < mnR) mnR = r; if (r > mxR) mxR = r;
          if (g < mnG) mnG = g; if (g > mxG) mxG = g;
          if (b < mnB) mnB = b; if (b > mxB) mxB = b;
        }
      }
      const k = cy * cw + cx, n = cell * cell;
      mean[k * 3] = sR / n; mean[k * 3 + 1] = sG / n; mean[k * 3 + 2] = sB / n;
      flat[k] = mxR - mnR <= flatTol && mxG - mnG <= flatTol && mxB - mnB <= flatTol ? 1 : 0;
    }
  }

  const label = new Int32Array(cw * ch).fill(-1);
  const out: Omit<Candidate, "id">[] = [];
  const stack: number[] = [];
  let next = 0;

  for (let start = 0; start < cw * ch; start++) {
    if (!flat[start] || label[start] !== -1) continue;
    const id = next++;
    const r0 = mean[start * 3], g0 = mean[start * 3 + 1], b0 = mean[start * 3 + 2];
    const cells: number[] = [];
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      cells.push(k);
      const x = k % cw, y = (k / cw) | 0;
      const nb = [x > 0 ? k - 1 : -1, x < cw - 1 ? k + 1 : -1, y > 0 ? k - cw : -1, y < ch - 1 ? k + cw : -1];
      for (const j of nb) {
        if (j < 0 || !flat[j] || label[j] !== -1) continue;
        // Compare with the seed so a gradient can't creep into one region.
        if (
          Math.abs(mean[j * 3] - r0) <= joinTol &&
          Math.abs(mean[j * 3 + 1] - g0) <= joinTol &&
          Math.abs(mean[j * 3 + 2] - b0) <= joinTol
        ) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    if (cells.length < 16) continue;
    const core = coreRect(cells, cw);
    if (!core) continue; // not a rectangle
    const { minX, minY, maxX, maxY } = core;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    // Grow by one cell: flat cells stop short of anti-aliased edges.
    const box: Box = {
      x: Math.max(0, (minX - 0.5) * cell),
      y: Math.max(0, (minY - 0.5) * cell),
      w: Math.min(width, (bw + 1) * cell),
      h: Math.min(height, (bh + 1) * cell),
    };
    if (!chipShaped(box, width, height)) continue;
    if (containsText(box, text)) continue;
    const hex = toHex(medianColor(data, width, inset(box, 0.2)));
    out.push({ ...box, kind: "solid", hex });
  }
  // A banner printed across a chip splits it in two; only the piece next to the
  // color's name gets labelled, so no merging is needed (and identical neighbouring
  // chips, like Central States' Ash and Slate Gray, stay separate).
  return out;
}

/**
 * The solid rectangle inside a region. Text that touches a chip (its label, a
 * warning bar's lettering) joins the flood fill; trimming rows and columns that are
 * mostly empty recovers the chip itself.
 */
function coreRect(cells: number[], cw: number) {
  const rows = new Map<number, number>(), cols = new Map<number, number>();
  for (const k of cells) {
    const x = k % cw, y = (k / cw) | 0;
    rows.set(y, (rows.get(y) ?? 0) + 1);
    cols.set(x, (cols.get(x) ?? 0) + 1);
  }
  const maxRow = Math.max(...rows.values()), maxCol = Math.max(...cols.values());
  const keptRows = [...rows].filter(([, n]) => n >= maxRow * 0.6).map(([y]) => y);
  const keptCols = [...cols].filter(([, n]) => n >= maxCol * 0.6).map(([x]) => x);
  const minY = Math.min(...keptRows), maxY = Math.max(...keptRows);
  const minX = Math.min(...keptCols), maxX = Math.max(...keptCols);
  let inside = 0;
  for (const k of cells) {
    const x = k % cw, y = (k / cw) | 0;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) inside++;
  }
  const area = (maxX - minX + 1) * (maxY - minY + 1);
  return inside / area >= 0.85 ? { minX, minY, maxX, maxY } : null;
}


/** Images placed at chip size become textured chips (their average color is reported). */
export function detectTextures(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  imageBoxes: Box[],
  solids: Box[],
  text: TextLine[],
): Omit<Candidate, "id">[] {
  const out: Omit<Candidate, "id">[] = [];
  for (const raw of imageBoxes) {
    const b: Box = {
      x: Math.max(0, raw.x),
      y: Math.max(0, raw.y),
      w: Math.min(width, raw.x + raw.w) - Math.max(0, raw.x),
      h: Math.min(height, raw.y + raw.h) - Math.max(0, raw.y),
    };
    if (b.w <= 0 || b.h <= 0 || !chipShaped(b, width, height)) continue;
    if (containsText(b, text)) continue;
    // Skip images that sit on top of a solid chip we already measured.
    if (solids.some((s) => overlap(s, b) > 0.5)) continue;
    const hex = toHex(meanColor(data, width, inset(b, 0.1)));
    out.push({ ...b, kind: "texture", hex });
  }
  return out;
}

export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.w * a.h, b.w * b.h);
}

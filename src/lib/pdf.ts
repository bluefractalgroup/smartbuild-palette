import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Box, RenderedPage, TextLine } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const TARGET_LONG_SIDE = 2200;

type Matrix = number[];
const mul = (m1: Matrix, m2: Matrix): Matrix => pdfjs.Util.transform(m1, m2) as Matrix;

function boxFromMatrix(m: Matrix): Box {
  // An image is drawn into the unit square, so its corners are the matrix applied to (0,0)-(1,1).
  const pts = [
    [0, 0], [1, 0], [0, 1], [1, 1],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

async function imagePlacements(page: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport): Promise<Box[]> {
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const boxes: Box[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case O.save:
        stack.push(ctm);
        break;
      case O.restore:
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case O.transform:
        ctm = mul(ctm, args as Matrix);
        break;
      case O.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
        break;
      case O.paintFormXObjectEnd:
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case O.paintImageXObject:
      case O.paintInlineImageXObject:
      case O.paintImageXObjectRepeat:
        boxes.push(boxFromMatrix(mul(viewport.transform as Matrix, ctm)));
        break;
    }
  }
  return boxes;
}

async function textLines(page: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport): Promise<TextLine[]> {
  const content = await page.getTextContent();
  type Piece = { text: string; x: number; y: number; w: number; h: number; base: number };
  const pieces: Piece[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const t = pdfjs.Util.transform(viewport.transform, item.transform);
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.2) continue; // skip rotated text
    const h = Math.hypot(t[2], t[3]);
    const w = item.width * viewport.scale;
    pieces.push({ text: item.str, x: t[4], y: t[5] - h, w, h, base: t[5] });
  }
  pieces.sort((a, b) => a.base - b.base || a.x - b.x);
  const lines: (Piece & { last: number })[] = [];
  for (const p of pieces) {
    const line = lines.find(
      (l) => Math.abs(l.base - p.base) < Math.max(l.h, p.h) * 0.35 && p.x - l.last < Math.max(l.h, p.h) * 0.9 && p.x >= l.x - 1,
    );
    if (line) {
      const gap = p.x - line.last;
      const sep = gap > Math.min(line.h, p.h) * 0.15 && !line.text.endsWith(" ") && !p.text.startsWith(" ") ? " " : "";
      line.text += sep + p.text;
      line.last = Math.max(line.last, p.x + p.w);
      line.w = line.last - line.x;
      const top = Math.min(line.y, p.y);
      line.h = Math.max(line.y + line.h, p.y + p.h) - top;
      line.y = top;
    } else {
      lines.push({ ...p, last: p.x + p.w });
    }
  }
  return lines
    .map(({ text, x, y, w, h }) => ({ text: text.replace(/\s+/g, " ").trim(), x, y, w, h }))
    .filter((l) => l.text);
}

export async function renderPdf(file: File, onPage?: (n: number, total: number) => void): Promise<RenderedPage[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: RenderedPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onPage?.(n, doc.numPages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, TARGET_LONG_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const [text, imageBoxes] = await Promise.all([textLines(page, viewport), imagePlacements(page, viewport)]);
    pages.push({ page: n, width: canvas.width, height: canvas.height, scale, canvas, text, imageBoxes });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

/** Photos or screenshots of a chart: one page, no text layer — the AI step names the chips. */
export async function renderImage(file: File): Promise<RenderedPage[]> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, TARGET_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return [{ page: 1, width: canvas.width, height: canvas.height, scale, canvas, text: [], imageBoxes: [] }];
}

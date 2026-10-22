import { detectSolids, detectTextures, inset } from "./detect";
import { labelChips, guessSource, cleanName } from "./pair";
import { renderImage, renderPdf } from "./pdf";
import { aiLabel, type AiColor } from "./ai";
import { meanColor, medianColor, toHex } from "./color";
import { applyCorrection, cmykFillsIn, correctionTable, loadLut } from "./cmyk";
import type { Box, Candidate, ExtractMethod, RenderedPage, Source, Swatch } from "./types";

export interface ExtractResult {
  source: Source;
  swatches: Swatch[];
}

const uid = () => crypto.randomUUID();

function crop(canvas: HTMLCanvasElement, b: Box, maxSide = 160): string {
  const s = Math.min(1, maxSide / Math.max(b.w, b.h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(b.w * s));
  c.height = Math.max(1, Math.round(b.h * s));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

export function findCandidates(page: RenderedPage): Candidate[] {
  const ctx = page.canvas.getContext("2d", { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, page.width, page.height);
  const solids = detectSolids(data, page.width, page.height, page.text);
  const textures = detectTextures(data, page.width, page.height, page.imageBoxes, solids, page.text);
  // Reading order: top-to-bottom, left-to-right, so the grid matches the chart.
  return [...solids, ...textures]
    .sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y))
    .map((c, i) => ({ ...c, id: i }));
}

function measure(page: RenderedPage, b: Box, textured: boolean): string {
  const ctx = page.canvas.getContext("2d", { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, page.width, page.height);
  return toHex(textured ? meanColor(data, page.width, inset(b, 0.1)) : medianColor(data, page.width, inset(b, 0.2)));
}

export async function extractFile(
  file: File,
  useAi: boolean,
  onProgress: (msg: string) => void,
): Promise<ExtractResult> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  onProgress("Opening the chart");
  const pages = isPdf
    ? await renderPdf(file, (n, total) => onProgress(`Reading page ${n} of ${total}`))
    : await renderImage(file);

  const allText = pages.flatMap((p) => p.text);
  const guess = guessSource(allText, file.name);
  const source: Source = {
    id: uid(),
    fileName: file.name,
    manufacturer: guess.manufacturer,
    productLine: guess.productLine,
    pageCount: pages.length,
    method: "layout",
    status: "ready",
    addedAt: new Date().toISOString(),
  };

  let trueValues = new Set<number>();
  // CMYK charts: repaint each page with profile-accurate colors before measuring.
  if (isPdf) {
    try {
      const fills = await cmykFillsIn(new Uint8Array(await file.arrayBuffer()));
      if (fills.length) {
        onProgress("Converting CMYK colors");
        await loadLut();
        const table = correctionTable(fills);
        trueValues = new Set(table.values());
        for (const page of pages) {
          const ctx = page.canvas.getContext("2d", { willReadFrequently: true })!;
          const img = ctx.getImageData(0, 0, page.width, page.height);
          if (applyCorrection(img.data, table)) ctx.putImageData(img, 0, 0);
        }
      }
    } catch {
      source.cmykFills = 0;
    }
  }

  const swatches: Swatch[] = [];
  let method: ExtractMethod = useAi ? "ai" : "layout";
  let aiFailure = "";

  for (const page of pages) {
    const candidates = findCandidates(page);
    if (!candidates.length && page.text.length) continue; // a terms or warranty page

    let named: { box: Box; textured: boolean; hex: string; name: string; types: string[]; serial: string }[] = [];

    if (method === "ai") {
      onProgress(`Naming colors on page ${page.page}`);
      try {
        const res = await aiLabel(page, candidates, file.name);
        if (res.manufacturer && !source.manufacturer) source.manufacturer = res.manufacturer;
        if (res.productLine && page.page === 1) source.productLine = res.productLine;
        named = res.colors
          .map((c: AiColor) => {
            const cand = c.candidateId != null ? candidates.find((x) => x.id === c.candidateId) : undefined;
            const box = cand ?? c.box;
            if (!box) return null;
            const textured = cand ? cand.kind === "texture" : !!c.textured;
            return {
              box,
              textured,
              hex: cand ? cand.hex : measure(page, box, textured),
              name: cleanName(c.name),
              types: c.types ?? [],
              serial: c.serial ?? "",
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
      } catch (e) {
        aiFailure = e instanceof Error ? e.message : String(e);
        method = "layout";
      }
    }

    if (method === "layout") {
      named = labelChips(candidates, page.text).map((l) => ({
        box: l.candidate,
        textured: l.candidate.kind === "texture",
        hex: l.candidate.hex,
        name: l.name,
        types: l.types,
        serial: l.serial,
      }));
    }

    for (const n of named) {
      swatches.push({
        id: uid(),
        sourceId: source.id,
        name: n.name || `Unnamed ${swatches.length + 1}`,
        hex: n.hex,
        chartCrop: crop(page.canvas, n.textured ? n.box : inset(n.box, 0.06)),
        textured: n.textured,
        types: n.types,
        serial: n.serial,
        page: page.page,
        selected: false,
      });
    }
  }

  source.method = method;
  // Count the chips whose color came from a CMYK fill (text and logos don't count).
  source.cmykFills = swatches.filter((w) => !w.textured && trueValues.has(parseInt(w.hex.slice(1), 16))).length;
  if (aiFailure) source.note = `AI naming was unavailable (${aiFailure}), so names were read from the chart layout. Check them before export.`;
  else if (!swatches.length) source.note = "No color chips were found in this file.";
  else if (swatches.some((s) => s.name.startsWith("Unnamed"))) source.note = "Some chips have no name on the chart. Name them in the review step.";

  // Release the page canvases.
  pages.forEach((p) => { p.canvas.width = 0; p.canvas.height = 0; });
  return { source, swatches };
}

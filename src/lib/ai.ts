import { supabase } from "./supabase";
import type { Box, Candidate, RenderedPage } from "./types";

export interface AiColor {
  candidateId?: number;
  box?: Box;
  textured?: boolean;
  name: string;
  types?: string[];
  serial?: string;
}

export interface AiResult {
  manufacturer: string;
  productLine: string;
  colors: AiColor[];
}

const SEND_LONG_SIDE = 1568; // keeps the image inside Claude's native resolution

/**
 * Sends the page picture, the measured chip list and the text layer to the
 * `extract-colors` edge function. Claude only names and classifies chips; the
 * colors themselves always come from the pixels measured in the browser.
 */
export async function aiLabel(page: RenderedPage, candidates: Candidate[], fileName: string): Promise<AiResult> {
  if (!supabase) throw new Error("no Supabase project configured");
  const k = Math.min(1, SEND_LONG_SIDE / Math.max(page.width, page.height));
  const c = document.createElement("canvas");
  c.width = Math.round(page.width * k);
  c.height = Math.round(page.height * k);
  c.getContext("2d")!.drawImage(page.canvas, 0, 0, c.width, c.height);
  const image = c.toDataURL("image/jpeg", 0.88).split(",")[1];
  const r = (v: number) => Math.round(v * k);

  const { data, error } = await supabase.functions.invoke("extract-colors", {
    body: {
      fileName,
      page: page.page,
      width: c.width,
      height: c.height,
      image,
      candidates: candidates.map((x) => ({ id: x.id, x: r(x.x), y: r(x.y), w: r(x.w), h: r(x.h), hex: x.hex, kind: x.kind })),
      text: page.text.map((t) => ({ text: t.text, x: r(t.x), y: r(t.y), w: r(t.w), h: r(t.h) })),
    },
  });
  if (error) throw new Error(error.message);
  const res = data as AiResult;
  // Boxes come back in the scaled picture's pixels.
  res.colors = (res.colors ?? []).map((col) =>
    col.box ? { ...col, box: { x: col.box.x / k, y: col.box.y / k, w: col.box.w / k, h: col.box.h / k } } : col,
  );
  return res;
}

import { supabase } from "./supabase";
import { normalizeHex } from "./color";
import type { ExportRow, PaletteDoc } from "./types";

export interface PaletteSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export function newPalette(name = "Untitled palette"): PaletteDoc {
  return {
    id: crypto.randomUUID(),
    name,
    sources: [],
    swatches: [],
    overrides: {},
    codeStyle: "full",
    mergeSameNames: true,
    updatedAt: new Date().toISOString(),
  };
}

/* ---------- Local mode (no Supabase): this browser only ---------- */

const LS_KEY = "smartbuild-palette:palettes";

function readLocal(): PaletteDoc[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PaletteDoc[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(docs: PaletteDoc[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(docs));
  } catch {
    // Storage full or blocked; the palette still lives in memory for this visit.
  }
}

/* ---------- Shared API ---------- */

export async function listPalettes(): Promise<PaletteSummary[]> {
  if (!supabase) {
    return readLocal()
      .map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const { data, error } = await supabase.from("palettes").select("id,name,updated_at").order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at }));
}

export async function loadPalette(id: string): Promise<PaletteDoc | null> {
  if (!supabase) return readLocal().find((d) => d.id === id) ?? null;
  const { data, error } = await supabase.from("palettes").select("doc").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data?.doc as PaletteDoc) ?? null;
}

export async function savePalette(doc: PaletteDoc): Promise<void> {
  const stamped = { ...doc, updatedAt: new Date().toISOString() };
  if (!supabase) {
    const all = readLocal().filter((d) => d.id !== doc.id);
    writeLocal([stamped, ...all]);
    return;
  }
  const { error } = await supabase
    .from("palettes")
    .upsert({ id: doc.id, name: doc.name, doc: stamped, updated_at: stamped.updatedAt });
  if (error) throw error;
}

export async function deletePalette(id: string): Promise<void> {
  if (!supabase) {
    writeLocal(readLocal().filter((d) => d.id !== id));
    return;
  }
  const { error } = await supabase.from("palettes").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Keeps the exported colors and their codes in a plain table, so later steps
 * (metal and trim parts, which reuse the color codes) can look them up.
 */
export async function recordExport(doc: PaletteDoc, rows: ExportRow[]): Promise<void> {
  if (!supabase) return;
  const { error: delErr } = await supabase.from("palette_colors").delete().eq("palette_id", doc.id);
  if (delErr) throw delErr;
  if (!rows.length) return;
  const { error } = await supabase.from("palette_colors").insert(
    rows.map((r, i) => ({
      palette_id: doc.id,
      position: i,
      color_name: r.name.trim(),
      hex_code: normalizeHex(r.hex) ?? r.hex,
      color_code: r.code.trim(),
      description: r.description.trim(),
      preferred_manufacturer: r.preferredManufacturer,
      serial_number: r.serial.trim(),
      all_available_manufacturers: r.availableManufacturers,
      textured: r.swatches.some((s) => s.textured),
    })),
  );
  if (error) throw error;
}

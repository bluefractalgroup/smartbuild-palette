import { supabase } from "./supabase";
import { normalizeHex } from "./color";
import type { ExportRow, PaletteDoc } from "./types";

export interface PaletteSummary {
  id: string;
  name: string;
  updatedAt: string;
  updatedBy?: string;
}

/** Thrown when a teammate saved this palette after we loaded it. */
export class SaveConflict extends Error {
  constructor(public by: string, public at: string) {
    super(`${by} changed this palette`);
  }
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
  const { data, error } = await supabase
    .from("palettes")
    .select("id,name,updated_at,updated_by")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at, updatedBy: r.updated_by ?? undefined }));
}

export async function loadPalette(id: string): Promise<PaletteDoc | null> {
  if (!supabase) return readLocal().find((d) => d.id === id) ?? null;
  const { data, error } = await supabase.from("palettes").select("doc").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data?.doc as PaletteDoc) ?? null;
}

/**
 * Saves the palette and returns its new save time.
 *
 * `basedOn` is the save time of the version this browser loaded. If a teammate has
 * saved since then, nothing is written and SaveConflict is thrown, so nobody's work
 * is silently overwritten. Pass `force` to save anyway.
 */
export async function savePalette(doc: PaletteDoc, basedOn?: string, force = false): Promise<string> {
  const stamped = { ...doc, updatedAt: new Date().toISOString() };
  if (!supabase) {
    const all = readLocal().filter((d) => d.id !== doc.id);
    writeLocal([stamped, ...all]);
    return stamped.updatedAt;
  }
  const { data: auth } = await supabase.auth.getUser();
  const me = auth.user?.email ?? "";
  if (!force) {
    const { data: current, error: readErr } = await supabase
      .from("palettes")
      .select("updated_at,updated_by")
      .eq("id", doc.id)
      .maybeSingle();
    if (readErr) throw readErr;
    if (current && current.updated_by && current.updated_by !== me && (!basedOn || Date.parse(current.updated_at) > Date.parse(basedOn) + 1)) {
      throw new SaveConflict(current.updated_by, current.updated_at);
    }
  }
  const { error } = await supabase
    .from("palettes")
    .upsert({ id: doc.id, name: doc.name, doc: stamped, updated_at: stamped.updatedAt, updated_by: me });
  if (error) throw error;
  return stamped.updatedAt;
}

/** True when the signed-in user's email is on a team domain (always true in local mode). */
export async function isTeamMember(): Promise<boolean> {
  if (!supabase) return true;
  const { data, error } = await supabase.rpc("is_team_member");
  if (error) return true; // older database without the function: let RLS decide
  return data === true;
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

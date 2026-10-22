import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

/**
 * Only the origin is used, so a pasted "https://ref.supabase.co/rest/v1/" (as the
 * dashboard shows it) still works.
 */
function origin(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

export const supabaseUrl = origin(rawUrl);

/** Null when the app runs in local mode (no Supabase project configured). */
export const supabase: SupabaseClient | null = supabaseUrl && key ? createClient(supabaseUrl, key) : null;

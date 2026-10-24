/**
 * The app has no accounts; each person gives their name once, and it is shown on the
 * palettes they edit. Kept in this browser only.
 */
const KEY = "smartbuild-palette:editor";

export function getEditorName(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setEditorName(name: string) {
  try {
    localStorage.setItem(KEY, name.trim());
  } catch {
    // Storage blocked: the name lasts for this visit only.
  }
}

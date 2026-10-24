import { deltaE, fromHex, normalizeHex } from "./color";
import type { CodeStyle, ExportRow, PaletteDoc, Source, Swatch } from "./types";

export function sourceLabel(s: Source | undefined): string {
  if (!s) return "";
  return [s.manufacturer.trim(), s.productLine.trim()].filter(Boolean).join(" - ") || s.fileName;
}

export const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

function abbreviate(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (letters.length <= 6) return letters;
  let out = letters[0];
  for (const ch of letters.slice(1)) {
    if ("AEIOU".includes(ch)) continue;
    if (out[out.length - 1] === ch) continue;
    out += ch;
    if (out.length === 6) break;
  }
  return out;
}

function makerPrefix(maker: string): string {
  const words = maker.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]);
}

export function generateCode(name: string, maker: string, style: CodeStyle): string {
  if (style === "full") return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const p = makerPrefix(maker);
  const a = abbreviate(name);
  return p ? `${p}-${a}` : a;
}

export function buildRows(doc: PaletteDoc): ExportRow[] {
  const sourceById = new Map(doc.sources.map((s) => [s.id, s]));
  const order = new Map(doc.sources.map((s, i) => [s.id, i]));
  const selected = doc.swatches
    .filter((s) => s.selected)
    .sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0));

  const groups = new Map<string, Swatch[]>();
  for (const s of selected) {
    // Same name AND same manufacturer: another maker's "Charcoal" is a different paint.
    const maker = nameKey(sourceById.get(s.sourceId)?.manufacturer ?? "");
    const key = doc.mergeSameNames ? `n:${maker}|${nameKey(s.name)}` : "s:" + s.id;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }

  const rows: ExportRow[] = [];
  const taken = new Set<string>();
  // Codes the user typed are reserved first so generated ones never collide with them.
  // Palettes saved before merging was scoped to a manufacturer keyed edits by name only.
  const overrideFor = (key: string) => doc.overrides[key] ?? (key.startsWith("n:") ? doc.overrides["n:" + key.split("|")[1]] : undefined) ?? {};
  for (const [key] of groups) {
    const c = overrideFor(key).code;
    if (c) taken.add(c.toUpperCase());
  }

  for (const [key, swatches] of groups) {
    const o = overrideFor(key);
    const preferred = swatches.find((s) => s.sourceId === o.preferredSourceId) ?? swatches[0];
    const src = sourceById.get(preferred.sourceId);
    const name = o.name ?? preferred.name;
    let code = o.code;
    if (!code) {
      const base = generateCode(name, src?.manufacturer ?? "", doc.codeStyle) || "COLOR";
      code = base;
      for (let n = 2; taken.has(code.toUpperCase()); n++) code = `${base}${n}`;
      taken.add(code.toUpperCase());
    }
    let spread = 0;
    for (let i = 0; i < swatches.length; i++)
      for (let j = i + 1; j < swatches.length; j++) {
        const a = fromHex(swatches[i].hex), b = fromHex(swatches[j].hex);
        if (a && b) spread = Math.max(spread, deltaE(a, b));
      }
    rows.push({
      key,
      name,
      hex: o.hex ?? preferred.hex,
      code,
      description: o.description ?? preferred.types.join(" | "),
      preferredManufacturer: sourceLabel(src),
      preferredSourceId: preferred.sourceId,
      serial: o.serial ?? preferred.serial,
      availableManufacturers: [...new Set(swatches.map((s) => sourceLabel(sourceById.get(s.sourceId))))],
      swatches,
      spread,
    });
  }
  return rows;
}

export interface RowProblem {
  key: string;
  field: "name" | "hex" | "code";
  message: string;
}

export function validateRows(rows: ExportRow[]): RowProblem[] {
  const problems: RowProblem[] = [];
  const codes = new Map<string, number>();
  for (const r of rows) codes.set(r.code.trim().toUpperCase(), (codes.get(r.code.trim().toUpperCase()) ?? 0) + 1);
  for (const r of rows) {
    if (!r.name.trim()) problems.push({ key: r.key, field: "name", message: "Add a color name." });
    if (!normalizeHex(r.hex)) problems.push({ key: r.key, field: "hex", message: "Use a 6-digit hex code like #9D8F88." });
    const c = r.code.trim();
    if (!c) problems.push({ key: r.key, field: "code", message: "Add a color code." });
    else if (!/^[A-Za-z0-9_-]+$/.test(c)) problems.push({ key: r.key, field: "code", message: "Use letters, numbers, - or _ only." });
    else if ((codes.get(c.toUpperCase()) ?? 0) > 1) problems.push({ key: r.key, field: "code", message: "Another color already uses this code." });
  }
  return problems;
}

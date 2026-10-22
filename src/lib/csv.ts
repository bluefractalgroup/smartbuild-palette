import { normalizeHex } from "./color";
import type { ExportRow } from "./types";

/**
 * SmartBuild's import screen checks these headings exactly, including case
 * ("HEX Code", not "Hex Code"). The first eight are required; the rest may follow.
 */
export const CSV_HEADINGS = [
  "Color Name",
  "HEX Code",
  "Unique ID",
  "Color Transparency",
  "Color Code",
  "Color Map",
  "Bump Map",
  "Systems",
  "Description",
  "Preferred Manufacturer",
  "Serial Number",
  "All Available Manufacturers",
] as const;

const q = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

export function toCsv(rows: ExportRow[]): string {
  const lines = [CSV_HEADINGS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.name.trim(),
        normalizeHex(r.hex) ?? r.hex,
        "", // Unique ID: always blank, SmartBuild assigns it
        "0", // Color Transparency
        r.code.trim(),
        "", // Color Map
        "", // Bump Map
        "", // Systems
        r.description.trim(),
        r.preferredManufacturer,
        r.serial.trim(),
        r.availableManufacturers.join("; "),
      ]
        .map(q)
        .join(","),
    );
  }
  // No byte-order mark: it would change the first heading SmartBuild reads.
  return lines.join("\r\n") + "\r\n";
}

export function toJson(rows: ExportRow[], paletteName: string): string {
  return JSON.stringify(
    {
      palette: paletteName,
      exportedAt: new Date().toISOString(),
      colors: rows.map((r) => ({
        colorName: r.name.trim(),
        hexCode: normalizeHex(r.hex) ?? r.hex,
        colorCode: r.code.trim(),
        description: r.description.trim(),
        preferredManufacturer: r.preferredManufacturer,
        serialNumber: r.serial.trim(),
        allAvailableManufacturers: r.availableManufacturers,
      })),
    },
    null,
    2,
  );
}

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

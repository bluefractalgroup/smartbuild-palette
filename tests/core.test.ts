import { describe, expect, it } from "vitest";
import { detectSolids } from "../src/lib/detect";
import { labelChips, parseTypes, readBlock, blocksFrom } from "../src/lib/pair";
import { buildRows, generateCode, validateRows } from "../src/lib/rows";
import { CSV_HEADINGS, toCsv } from "../src/lib/csv";
import { newPalette } from "../src/lib/store";
import type { Candidate, PaletteDoc, Swatch, TextLine } from "../src/lib/types";

function page(w: number, h: number, rects: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[]) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = r.rgb[0]; data[i + 1] = r.rgb[1]; data[i + 2] = r.rgb[2];
      }
  return data;
}

describe("chip detection", () => {
  it("measures flat chips exactly and ignores ones with text inside", () => {
    const W = 600, H = 800;
    const data = page(W, H, [
      { x: 40, y: 40, w: 60, h: 120, rgb: [157, 143, 136] },
      { x: 120, y: 40, w: 60, h: 120, rgb: [74, 18, 32] },
      { x: 300, y: 300, w: 120, h: 80, rgb: [200, 30, 40] }, // a banner with a title in it
    ]);
    const text: TextLine[] = [{ text: "Panel-Loc Plus", x: 320, y: 330, w: 80, h: 14 }];
    const found = detectSolids(data, W, H, text);
    expect(found.map((f) => f.hex).sort()).toEqual(["#4A1220", "#9D8F88"]);
  });
});

describe("labels", () => {
  it("reads paint types", () => {
    expect(parseTypes("STANDARD  |  PRIME  | ULTRA")).toEqual(["Standard", "Prime", "Ultra"]);
    expect(parseTypes("Burnished")).toBeNull();
  });

  it("joins wrapped names and drops fine print", () => {
    const lines: TextLine[] = [
      { text: "Burnished", x: 176, y: 638, w: 41, h: 12 },
      { text: "Slate", x: 186, y: 649, w: 23, h: 12 },
      { text: "STANDARD | PRIME | ULTRA", x: 169, y: 661, w: 54, h: 7 },
    ];
    const [b] = blocksFrom(lines);
    expect(readBlock(b)).toEqual({ name: "Burnished Slate", types: ["Standard", "Prime", "Ultra"], serial: "" });
  });

  it("pairs each chip with its nearest label", () => {
    const chips: Candidate[] = [
      { id: 0, x: 42, y: 0, w: 54, h: 117, kind: "solid", hex: "#030405" },
      { id: 1, x: 105, y: 0, w: 54, h: 117, kind: "solid", hex: "#4D4C48" },
    ];
    const text: TextLine[] = [
      { text: "Black", x: 58, y: 118, w: 25, h: 13 },
      { text: "STANDARD | PRIME | ULTRA", x: 42, y: 130, w: 54, h: 8 },
      { text: "Charcoal", x: 115, y: 118, w: 38, h: 13 },
      { text: "STANDARD | PRIME | ULTRA", x: 106, y: 130, w: 53, h: 8 },
    ];
    expect(labelChips(chips, text).map((l) => l.name)).toEqual(["Black", "Charcoal"]);
  });
});

function sw(over: Partial<Swatch>): Swatch {
  return { id: crypto.randomUUID(), sourceId: "a", name: "", hex: "#000000", chartCrop: "", textured: false, types: [], serial: "", page: 1, selected: true, ...over };
}

describe("export", () => {
  const doc = (): PaletteDoc => ({
    ...newPalette("Test"),
    sources: [
      { id: "a", fileName: "a.pdf", manufacturer: "Central States", productLine: "Panel-Loc Plus", pageCount: 1, method: "layout", status: "ready", addedAt: "" },
      { id: "b", fileName: "b.pdf", manufacturer: "Central States", productLine: "Horizon-Loc", pageCount: 1, method: "layout", status: "ready", addedAt: "" },
    ],
    swatches: [
      sw({ sourceId: "a", name: "Charcoal", hex: "#4D4C48", types: ["Standard", "Prime"] }),
      sw({ sourceId: "b", name: "Charcoal", hex: "#4D4C48" }),
      sw({ sourceId: "a", name: "Burnished Slate", hex: "#353530" }),
      sw({ sourceId: "a", name: "Gray", hex: "#999999", selected: false }),
    ],
  });

  it("uses SmartBuild's exact headings and fixed values", () => {
    const csv = toCsv(buildRows(doc()));
    const [head, first] = csv.split("\r\n");
    expect(head).toBe(CSV_HEADINGS.join(","));
    expect(head.startsWith("Color Name,HEX Code,Unique ID,Color Transparency,Color Code,Color Map,Bump Map,Systems")).toBe(true);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(first).toBe('"Charcoal","#4D4C48","","0","CHARCOAL","","","","Standard | Prime","Central States - Panel-Loc Plus","","Central States - Panel-Loc Plus; Central States - Horizon-Loc"');
  });

  it("merges same-named colors and keeps codes unique", () => {
    const d = doc();
    expect(buildRows(d).map((r) => r.code)).toEqual(["CHARCOAL", "BURNISHEDSLATE"]);
    d.mergeSameNames = false;
    const codes = buildRows(d).map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(validateRows(buildRows(d))).toEqual([]);
  });

  it("never merges different manufacturers' colors that share a name", () => {
    const d = doc();
    d.sources.push({ id: "c", fileName: "c.pdf", manufacturer: "Sherwin-Williams", productLine: "WeatherXL", pageCount: 1, method: "layout", status: "ready", addedAt: "" });
    d.swatches.push(sw({ sourceId: "c", name: "Charcoal", hex: "#3F3F3F" }));
    const rows = buildRows(d).filter((r) => r.name === "Charcoal");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.hex).sort()).toEqual(["#3F3F3F", "#4D4C48"]);
    expect(new Set(rows.map((r) => r.code)).size).toBe(2);
  });

  it("keeps edits saved under the old name-only key", () => {
    const d = doc();
    d.overrides["n:charcoal"] = { code: "CS-CHAR" };
    expect(buildRows(d).find((r) => r.name === "Charcoal")?.code).toBe("CS-CHAR");
  });

  it("generates short prefixed codes", () => {
    expect(generateCode("Burnished Slate", "Central States", "prefixed")).toBe("CS-BRNSHD");
    expect(generateCode("Tan", "Central States", "prefixed")).toBe("CS-TAN");
    expect(generateCode("Copper Metallic", "", "full")).toBe("COPPERMETALLIC");
  });

  it("flags duplicate codes the user typed", () => {
    const d = doc();
    const rows = buildRows(d);
    // A typed code wins; the generated one it would clash with renumbers itself.
    d.overrides[rows[1].key] = { code: "CHARCOAL" };
    expect(buildRows(d).map((r) => r.code)).toEqual(["CHARCOAL2", "CHARCOAL"]);
    // Two typed codes that clash are flagged on both rows.
    d.overrides[rows[0].key] = { code: "CHARCOAL" };
    const problems = validateRows(buildRows(d));
    expect(problems.filter((p) => p.field === "code")).toHaveLength(2);
  });
});

import { pdfjsCmykToRgb, iccCmykToRgb, setLut, correctionTable, applyCorrection } from "../src/lib/cmyk";
import { readFileSync } from "fs";

describe("CMYK true color", () => {
  setLut(new Uint8Array(readFileSync("src/assets/cmyk-srgb-17.bin")));
  const hex = (c: number[]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

  it("matches the ICC conversion within 2/255", () => {
    // Reference values: MuPDF/LittleCMS conversion of fills from CHRT_PLP_LO-1.pdf.
    const ref: [number[], string][] = [
      [[0.83, 0.44, 1, 0.49], "#1D4922"],
      [[0.1, 0.97, 0.61, 0.48], "#830C2C"],
      [[0.27, 0.42, 0.65, 0.03], "#B99268"],
      [[0, 0, 0, 1], "#231F20"],
      [[0.15, 0.11, 0.15, 0], "#D7D7D1"],
    ];
    for (const [cmyk, want] of ref) {
      const got = iccCmykToRgb(cmyk as [number, number, number, number]);
      const w = [1, 3, 5].map((i) => parseInt(want.slice(i, i + 2), 16));
      expect(Math.max(...got.map((v, i) => Math.abs(v - w[i])))).toBeLessThanOrEqual(2);
    }
  });

  it("repaints what the browser drew with the true color", () => {
    const fill: [number, number, number, number] = [0.1, 0.97, 0.61, 0.48];
    const [r, g, b] = pdfjsCmykToRgb(fill);
    const px = new Uint8ClampedArray([r, g, b, 255, 255, 255, 255, 255]);
    expect(applyCorrection(px, correctionTable([fill]))).toBe(1);
    expect(hex([...px.slice(0, 3)])).toBe(hex(iccCmykToRgb(fill)));
    expect([...px.slice(4, 7)]).toEqual([255, 255, 255]);
  });
});

describe("identical neighbours", () => {
  it("keeps two same-colored chips apart (Ash and Slate Gray)", () => {
    const W = 600, H = 400;
    const data = page(W, H, [
      { x: 100, y: 10, w: 54, h: 117, rgb: [152, 147, 146] },
      { x: 164, y: 10, w: 54, h: 117, rgb: [152, 147, 146] },
    ]);
    expect(detectSolids(data, W, H, [])).toHaveLength(2);
  });
});

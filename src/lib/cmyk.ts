import lutUrl from "../assets/cmyk-srgb-17.bin?url";

/**
 * True color for CMYK charts.
 *
 * Many manufacturer charts define colors in CMYK (print ink). Browsers' PDF
 * renderer (pdf.js) turns CMYK into screen color with a quick formula that can be
 * far off — Central States "Crimson" renders #CF2C1A instead of #BD2726. Acrobat
 * and macOS Preview convert through an ICC print profile.
 *
 * This module reads the CMYK values straight from the PDF and converts them with a
 * lookup table built from an ICC conversion (MuPDF / LittleCMS, CMYK -> sRGB).
 * Checked against Central States' own RGB charts: every shared color matches
 * within 1/255.
 */

export type CMYK = [number, number, number, number];

/** pdf.js 4.x DeviceCMYK -> RGB (copied so we can recognise what it painted). */
export function pdfjsCmykToRgb([c, m, y, k]: CMYK): [number, number, number] {
  const r = 255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747);
  const g = 255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578);
  const b = 255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

const N = 17;
let lut: Uint8Array | null = null;

export async function loadLut(): Promise<void> {
  if (lut) return;
  const res = await fetch(lutUrl);
  if (!res.ok) throw new Error("color table missing");
  lut = new Uint8Array(await res.arrayBuffer());
}

export function setLut(bytes: Uint8Array) {
  lut = bytes;
}

/** ICC-accurate CMYK (0..1) -> sRGB, by interpolating the 17^4 table. */
export function iccCmykToRgb(cmyk: CMYK): [number, number, number] {
  if (!lut) throw new Error("color table not loaded");
  const t = cmyk.map((v) => Math.max(0, Math.min(1, v)) * (N - 1));
  const i = t.map((v) => Math.min(N - 2, Math.floor(v)));
  const f = t.map((v, d) => v - i[d]);
  const out = [0, 0, 0];
  for (let corner = 0; corner < 16; corner++) {
    let w = 1, idx = 0;
    for (let d = 0; d < 4; d++) {
      const bit = (corner >> (3 - d)) & 1;
      w *= bit ? f[d] : 1 - f[d];
      idx = idx * N + i[d] + bit;
    }
    if (!w) continue;
    out[0] += w * lut[idx * 3];
    out[1] += w * lut[idx * 3 + 1];
    out[2] += w * lut[idx * 3 + 2];
  }
  return [Math.round(out[0]), Math.round(out[1]), Math.round(out[2])];
}

/* ---------- Reading CMYK fills from the PDF ---------- */

const NUM = String.raw`(-?\d*\.?\d+)`;
const CMYK_OP = new RegExp(String.raw`(?:^|[\s\[\]()<>/])${NUM}\s+${NUM}\s+${NUM}\s+${NUM}\s+(?:k|sc|scn)(?=[\s\[\]()<>/]|$)`, "g");

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  // Keep whatever decodes before an error: some writers leave junk after the data.
  const chunks: Uint8Array[] = [];
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    if (!chunks.length) return null;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Every CMYK fill color used anywhere in the file. Scans page and form content
 * streams (Flate or uncompressed); images are skipped.
 */
export async function cmykFillsIn(pdf: Uint8Array): Promise<CMYK[]> {
  const text = new TextDecoder("latin1").decode(pdf);
  const found = new Map<string, CMYK>();
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const dictStart = text.lastIndexOf(" obj", m.index);
    const dict = text.slice(Math.max(0, dictStart), m.index);
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    re.lastIndex = end + "endstream".length;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XRef|\/Type\s*\/ObjStm|\/Length1|\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType)/.test(dict)) continue;
    // Use the declared length when it's a plain number; otherwise trim the line break.
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let stop = len ? start + Number(len[1]) : end;
    if (stop > end) stop = end;
    while (!len && stop > start && (pdf[stop - 1] === 10 || pdf[stop - 1] === 13)) stop--;
    let body: Uint8Array | null = pdf.subarray(start, stop);
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
    if (filter) {
      const names = [...filter[1].matchAll(/\/(\w+)/g)].map((x) => x[1]);
      if (!names.length || names.some((n) => n !== "FlateDecode")) continue;
      for (let n = 0; n < names.length && body; n++) body = await inflate(body);
      if (!body) continue;
    }
    const content = new TextDecoder("latin1").decode(body);
    for (const op of content.matchAll(CMYK_OP)) {
      const v = op.slice(1, 5).map(Number) as CMYK;
      if (v.some((x) => !(x >= 0 && x <= 1))) continue;
      found.set(v.join(","), v);
    }
  }
  return [...found.values()];
}

/**
 * Maps each RGB that pdf.js painted for a CMYK fill to the profile-accurate RGB.
 * Keyed by 24-bit color.
 */
export function correctionTable(fills: CMYK[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const f of fills) {
    const [r, g, b] = pdfjsCmykToRgb(f);
    const [R, G, B] = iccCmykToRgb(f);
    map.set((r << 16) | (g << 8) | b, (R << 16) | (G << 8) | B);
  }
  return map;
}

/** Repaints a rendered page so CMYK fills show their true color. Returns pixels changed. */
export function applyCorrection(data: Uint8ClampedArray, table: Map<number, number>): number {
  if (!table.size) return 0;
  let changed = 0;
  let lastKey = -1, lastVal: number | undefined;
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const val = key === lastKey ? lastVal : table.get(key);
    lastKey = key;
    lastVal = val;
    if (val === undefined) continue;
    data[i] = val >> 16;
    data[i + 1] = (val >> 8) & 255;
    data[i + 2] = val & 255;
    changed++;
  }
  return changed;
}

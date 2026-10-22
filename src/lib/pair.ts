import type { Box, Candidate, TextLine } from "./types";

/**
 * Layout-based labelling: pairs each chip with the nearest block of text and reads
 * the color name, paint types and serial number from it. Works well on charts with a
 * text layer (most manufacturer PDFs). The AI step replaces this when it's available.
 */

const TYPE_WORD = /^(standard|prime|ultra|signature|classic|plus|pvdf|smp|polyester|kynar)$/i;
/** Marketing lines next to pictures ("Explore our roofing visualizer.") are not color names. */
const SENTENCE = /([.!?:]$|\.(com|net|org|us)\b|\b(our|your|visit|call|explore|scan|www|click|learn|see)\b)/i;
const TYPE_LINE = /^[A-Za-z]+(\s*[|/,•]\s*[A-Za-z]+)*$/;
const NOTE = /(trim|ga\b|gauge|only|warranty|coating|fluropon|clear|acrylic|available|stock|special order|lead time|^premium( colou?rs?)?$|premium$|^colou?rs?$|\d{2,}%|^\W+$)/i;
const FINISH = /(galv|metal|copper|zinc|alum|wood|stone|rust|weather|camo|stainless|brushed|patina)/i;
const SERIAL = /^[A-Z]{1,4}[- ]?\d{2,}[A-Z0-9-]*$/;

export function cleanName(s: string): string {
  return s
    .replace(/[®™©*†‡§¹²³]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTypes(line: string): string[] | null {
  const t = line.trim();
  if (!TYPE_LINE.test(t)) return null;
  const words = t.split(/\s*[|/,•]\s*/).filter(Boolean);
  if (!words.length || !words.every((w) => TYPE_WORD.test(w))) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

interface Block extends Box {
  lines: TextLine[];
}

/** Groups lines stacked under each other (a chip's label) into blocks. */
export function blocksFrom(text: TextLine[]): Block[] {
  const lines = [...text].sort((a, b) => a.y - b.y);
  const blocks: Block[] = [];
  for (const l of lines) {
    const cx = l.x + l.w / 2;
    const host = blocks.find((b) => {
      const last = b.lines[b.lines.length - 1];
      const gap = l.y - (last.y + last.h);
      const lastCx = last.x + last.w / 2;
      const horizontal = Math.abs(cx - lastCx) < Math.max(last.w, l.w) * 0.6 || (l.x < last.x + last.w && l.x + l.w > last.x && Math.abs(cx - lastCx) < Math.max(last.w, l.w));
      return gap > -last.h * 0.5 && gap < Math.max(last.h, l.h) * 0.9 && horizontal;
    });
    if (host) {
      host.lines.push(l);
      const x1 = Math.max(host.x + host.w, l.x + l.w), y1 = Math.max(host.y + host.h, l.y + l.h);
      host.x = Math.min(host.x, l.x);
      host.y = Math.min(host.y, l.y);
      host.w = x1 - host.x;
      host.h = y1 - host.y;
    } else {
      blocks.push({ x: l.x, y: l.y, w: l.w, h: l.h, lines: [l] });
    }
  }
  return blocks;
}

export function readBlock(block: Block): { name: string; types: string[]; serial: string } {
  let types: string[] = [];
  let serial = "";
  const nameLines: TextLine[] = [];
  for (const l of block.lines) {
    const t = cleanName(l.text);
    if (!t) continue;
    const ty = parseTypes(t);
    if (ty) { types = types.concat(ty); continue; }
    if (SERIAL.test(t) && /\d/.test(t)) { serial = t; continue; }
    if (NOTE.test(t)) continue;
    nameLines.push({ ...l, text: t });
  }
  // The name is set larger than the fine print around it.
  const tallest = Math.max(0, ...nameLines.map((l) => l.h));
  const name = nameLines
    .filter((l) => l.h >= tallest * 0.8)
    .map((l) => l.text)
    .join(" ");
  return { name, types: [...new Set(types)], serial };
}

function distance(a: Box, b: Box) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

export interface Labelled {
  candidate: Candidate;
  name: string;
  types: string[];
  serial: string;
}

export function labelChips(candidates: Candidate[], text: TextLine[]): Labelled[] {
  const blocks = blocksFrom(text)
    .map((b) => ({ block: b, read: readBlock(b) }))
    .filter((b) => b.read.name && b.read.name.length <= 40 && b.read.name.split(" ").length <= 5 && !SENTENCE.test(b.read.name));

  // Titles ("Commercial") are set much larger than color names; a chip-sized patch of a
  // product photo next to the title must not become a color.
  const heights = blocks.map((b) => Math.max(...b.block.lines.map((l) => l.h))).sort((a, b) => a - b);
  const typical = heights.length ? heights[heights.length >> 1] : 0;
  const tooBig = (b: (typeof blocks)[number]) => typical > 0 && Math.max(...b.block.lines.map((l) => l.h)) > typical * 1.8;

  const pairs: { c: number; b: number; d: number }[] = [];
  candidates.forEach((c, ci) => {
    const reach = Math.max(c.w, c.h) * 0.75;
    blocks.forEach((b, bi) => {
      if (tooBig(b)) return;
      const d = distance(c, b.block);
      if (d <= reach) pairs.push({ c: ci, b: bi, d });
    });
  });
  pairs.sort((p, q) => p.d - q.d);

  const usedC = new Set<number>(), usedB = new Set<number>();
  const result = new Map<number, Labelled>();
  for (const p of pairs) {
    if (usedC.has(p.c) || usedB.has(p.b)) continue;
    // A picture only counts as a textured chip when its label looks like a paint:
    // it lists paint systems or a number, or names a metallic/natural finish.
    const r0 = blocks[p.b].read;
    if (candidates[p.c].kind === "texture" && !r0.types.length && !r0.serial && !FINISH.test(r0.name)) continue;
    usedC.add(p.c);
    usedB.add(p.b);
    const r = blocks[p.b].read;
    result.set(p.c, { candidate: candidates[p.c], name: r.name, types: r.types, serial: r.serial });
  }
  // Chips with no label are kept only when the page has no text layer (a scanned chart).
  const scanned = text.length === 0;
  return candidates
    .map((c, i) => result.get(i) ?? (scanned ? { candidate: c, name: "", types: [], serial: "" } : null))
    .filter((x): x is Labelled => x !== null);
}

/** Best guess at manufacturer and product line from a chart's text. */
export function guessSource(text: TextLine[], fileName: string): { manufacturer: string; productLine: string } {
  const all = text.map((t) => t.text).join(" ");
  let manufacturer = "";
  // Website text like "central states mfg .com" names the maker. Token scan, not a
  // regex, because charts can carry a lot of text.
  let site: string | null = null;
  const tokens = all.split(/\s+/);
  const at = tokens.findIndex((t) => /^\.?com\b/i.test(t) || /\w\.com\b/i.test(t));
  if (at >= 0) {
    const words = tokens.slice(Math.max(0, at - 3), at + 1).join(" ").replace(/\.?com\b.*$/i, "").replace(/\bmfg\b/i, "").replace(/www\.?/i, "");
    site = words.replace(/[^a-z0-9 -]/gi, " ").trim() || null;
  }
  const known: [RegExp, string][] = [
    [/central\s*states/i, "Central States"],
    [/sherwin[-\s]?williams/i, "Sherwin-Williams"],
    [/mcelroy/i, "McElroy Metal"],
    [/union\s*corrugating/i, "Union Corrugating"],
    [/fabral/i, "Fabral"],
    [/metal\s*sales/i, "Metal Sales"],
    [/bridger\s*steel/i, "Bridger Steel"],
    [/northland/i, "Northland Steel"],
    [/abc\s*metal|ab\s*metals/i, "AB Metals"],
    [/mueller/i, "Mueller"],
    [/everlast/i, "EverLast"],
  ];
  for (const [re, n] of known) if (re.test(all)) { manufacturer = n; break; }
  if (!manufacturer && site) manufacturer = site.replace(/\s+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

  // Product line: the largest text on the page that isn't the manufacturer.
  const big = [...text]
    .filter((t) => t.text.trim().length > 3 && !/selection|color chart|colou?r tool|warranty/i.test(t.text))
    .sort((a, b) => b.h - a.h);
  const productLine = (big.length ? cleanName(big[0].text) : fileName.replace(/\.[^.]+$/, ""))
    .replace(/\s+\d+\s*(ga|gauge)\b.*$/i, "")
    .trim();
  return { manufacturer, productLine };
}

// AI naming evaluation.
//
// Sends real chart pages (captured from the app, so the requests are exactly what
// production sends) through the production prompt and reply parsing, and scores
// Claude's answers against hand-checked expected answers.
//
//   ANTHROPIC_API_KEY=sk-ant-... node evals/ai/run.ts
//   node evals/ai/run.ts --model claude-sonnet-5-5 --variants normal,no-text
//   node evals/ai/run.ts --mock            (no API calls; checks the harness)
//   node evals/ai/run.ts --mock=noisy      (fake mistakes; the scores must drop)
//
// Variants:
//   normal   the request as the app sends it (page image + text layer)
//   no-text  text layer removed, like a screenshot or scanned chart: Claude must
//            read every name from the picture
//
// Pages with no colors (page 2 of each chart) must come back empty.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMessagesRequest,
  parseClaudeOutput,
  DEFAULT_MODEL,
  type ExtractRequest,
  type ExtractResponse,
} from "../../supabase/functions/extract-colors/index.ts";

interface Expected {
  name: string;
  candidateId: number;
  textured: boolean;
  types: string[];
}
interface Fixture {
  id: string;
  request: ExtractRequest;
  expected: Expected[];
}

const arg = (name: string, fallback?: string) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const i = process.argv.indexOf(hit);
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
};

const model = arg("model", process.env.ANTHROPIC_MODEL || DEFAULT_MODEL)!;
const mock = arg("mock");
const variants = (arg("variants", "normal,no-text") ?? "").split(",").filter(Boolean);
const minRecall = Number(arg("min-recall", "0.95"));
const minRegion = Number(arg("min-region", "0.95"));
const key = process.env.ANTHROPIC_API_KEY;
const dir = new URL("./fixtures/", import.meta.url).pathname;

if (!mock && !key) {
  console.error("Set ANTHROPIC_API_KEY, or run with --mock to check the harness.");
  process.exit(2);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(a.w * a.h, b.w * b.h) : 0;
}

/** A stand-in for Claude: the expected answer, optionally with mistakes. */
function mockReply(f: Fixture, noisy: boolean) {
  const colors = f.expected.map((e) => ({ candidate_id: e.candidateId, name: e.name, textured: e.textured, types: e.types }));
  if (noisy && colors.length > 2) {
    colors.pop(); // a missed color
    colors[0].candidate_id = colors[1].candidate_id; // a wrong region
    colors.push({ candidate_id: -1, name: "Invented Red", textured: false, types: [] }); // dropped by the parser (no region)
    (colors as unknown[]).push({ name: "Phantom Gray", box: [5, 5, 40, 40] }); // an extra color
  }
  if (noisy && colors.length === 0) (colors as unknown[]).push({ name: "Banner", box: [0, 0, 300, 60] });
  return { content: [{ type: "tool_use", input: { manufacturer: "Central States", product_line: "", colors } }] };
}

async function askClaude(req: ExtractRequest) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(buildMessagesRequest(req, model)),
  });
  if (!res.ok) throw new Error(`Claude API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

interface Score {
  fixture: string;
  variant: string;
  expected: number;
  returned: number;
  found: number;
  regionOk: number;
  texturedOk: number;
  texturedTotal: number;
  typesOk: number;
  typesTotal: number;
  missed: string[];
  extra: string[];
  wrongRegion: string[];
  error?: string;
  seconds: number;
}

function score(f: Fixture, variant: string, out: ExtractResponse | null, seconds: number, error?: string): Score {
  const s: Score = {
    fixture: f.id, variant, expected: f.expected.length, returned: out?.colors.length ?? 0, found: 0, regionOk: 0,
    texturedOk: 0, texturedTotal: 0, typesOk: 0, typesTotal: 0, missed: [], extra: [], wrongRegion: [], error, seconds,
  };
  if (!out) {
    s.missed = f.expected.map((e) => e.name);
    if (!error) s.error = "no colors in reply";
    return s;
  }
  const byId = new Map(f.request.candidates.map((c) => [c.id, c]));
  const remaining = [...out.colors];
  for (const e of f.expected) {
    const i = remaining.findIndex((c) => norm(c.name) === norm(e.name));
    if (i < 0) { s.missed.push(e.name); continue; }
    const got = remaining.splice(i, 1)[0];
    s.found++;
    const want = byId.get(e.candidateId)!;
    const where = got.candidateId !== undefined ? byId.get(got.candidateId) : got.box;
    if ((got.candidateId !== undefined && got.candidateId === e.candidateId) || (got.candidateId === undefined && where && overlap(where, want) >= 0.5)) s.regionOk++;
    else s.wrongRegion.push(e.name);
    if (e.textured) { s.texturedTotal++; if (got.textured) s.texturedOk++; }
    if (e.types.length) {
      s.typesTotal++;
      const a = new Set(got.types.map(norm)), b = new Set(e.types.map(norm));
      if (a.size === b.size && [...b].every((t) => a.has(t))) s.typesOk++;
    }
  }
  s.extra = remaining.map((c) => c.name);
  return s;
}

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${Math.round((100 * a) / b)}%`);

async function main() {
  const fixtures: Fixture[] = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const scores: Score[] = [];

  for (const variant of variants) {
    for (const f of fixtures) {
      const req: ExtractRequest = variant === "no-text" ? { ...f.request, text: [] } : f.request;
      const t0 = Date.now();
      let out: ExtractResponse | null = null;
      let error: string | undefined;
      try {
        const reply = mock ? mockReply(f, mock === "noisy") : await askClaude(req);
        out = parseClaudeOutput(reply, req.candidates.map((c) => c.id));
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const s = score(f, variant, out, (Date.now() - t0) / 1000, error);
      scores.push(s);
      console.log(
        `${variant.padEnd(8)} ${f.id.padEnd(18)} found ${s.found}/${s.expected}  regions ${s.regionOk}/${s.found}  extra ${s.extra.length}` +
          (s.error ? `  ERROR ${s.error}` : "") +
          (s.missed.length ? `\n           missed: ${s.missed.join(", ")}` : "") +
          (s.extra.length ? `\n           extra: ${s.extra.join(", ")}` : "") +
          (s.wrongRegion.length ? `\n           wrong chip: ${s.wrongRegion.join(", ")}` : ""),
      );
    }
  }

  // Summary per variant.
  const lines: string[] = [`## AI naming evaluation`, ``, `Model: \`${mock ? `mock (${mock})` : model}\``, ``];
  lines.push(`| Variant | Colors found | Right chip | Extra colors | Empty pages kept empty | Textured flagged | Paint types | Errors |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  let gateFailed = false;
  for (const v of variants) {
    const vs = scores.filter((s) => s.variant === v);
    const sum = (k: keyof Score) => vs.reduce((n, s) => n + (s[k] as number), 0);
    const empty = vs.filter((s) => s.expected === 0);
    const emptyOk = empty.filter((s) => s.returned === 0 && !s.error).length;
    const extras = vs.reduce((n, s) => n + s.extra.length, 0);
    const errors = vs.filter((s) => s.error).length;
    lines.push(
      `| ${v} | ${sum("found")}/${sum("expected")} (${pct(sum("found"), sum("expected"))}) | ${pct(sum("regionOk"), sum("found"))} | ${extras} | ${emptyOk}/${empty.length} | ${sum("texturedOk")}/${sum("texturedTotal")} | ${pct(sum("typesOk"), sum("typesTotal"))} | ${errors} |`,
    );
    if (v === "normal") {
      const recall = sum("found") / Math.max(1, sum("expected"));
      const region = sum("regionOk") / Math.max(1, sum("found"));
      if (recall < minRecall || region < minRegion || errors > 0) gateFailed = true;
    }
  }
  const problems = scores.filter((s) => s.missed.length || s.extra.length || s.wrongRegion.length || s.error);
  if (problems.length) {
    lines.push(``, `### Details`, ``);
    for (const s of problems) {
      const bits = [
        s.error && `error: ${s.error}`,
        s.missed.length && `missed: ${s.missed.join(", ")}`,
        s.extra.length && `extra: ${s.extra.join(", ")}`,
        s.wrongRegion.length && `wrong chip: ${s.wrongRegion.join(", ")}`,
      ].filter(Boolean);
      lines.push(`- **${s.variant} / ${s.fixture}**: ${bits.join("; ")}`);
    }
  }
  lines.push(``, gateFailed ? `**Result: below the bar** (normal variant needs ≥${minRecall * 100}% found and ≥${minRegion * 100}% right chip, no errors).` : `**Result: passed.**`);
  const report = lines.join("\n");
  console.log("\n" + report);

  mkdirSync(new URL("./results/", import.meta.url).pathname, { recursive: true });
  writeFileSync(new URL("./results/latest.json", import.meta.url).pathname, JSON.stringify({ model: mock ? `mock:${mock}` : model, scores }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  process.exit(gateFailed ? 1 : 0);
}

main();

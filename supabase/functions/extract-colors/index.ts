// Supabase Edge Function: names the color chips found on one page of a chart.
//
// The browser has already measured every chip's color from the chart's pixels.
// Claude only decides which regions are paint chips and reads each one's name,
// paint types and serial number. It never supplies a color value.
//
// Secrets: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional),
//          ALLOWED_ORIGINS (optional, comma-separated; defaults below).
//
// The app has no sign-in, so JWT verification is off for this function. Requests
// are accepted only from the app's own web address (browsers enforce this).
//
// The pure functions are exported so tests and the AI evaluation can use the exact
// prompt and parsing that production uses. The server only starts under Deno.

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_ALLOWED_ORIGINS = ["https://bluefractalgroup.github.io", "http://localhost:5173", "http://localhost:4173"];

export interface ExtractRequest {
  fileName: string;
  page: number;
  width: number;
  height: number;
  image: string; // base64 JPEG
  candidates: { id: number; x: number; y: number; w: number; h: number; hex: string; kind: "solid" | "texture" }[];
  text: { text: string; x: number; y: number; w: number; h: number }[];
}

export interface NamedColor {
  candidateId?: number;
  box?: { x: number; y: number; w: number; h: number };
  textured: boolean;
  name: string;
  types: string[];
  serial: string;
}

export interface ExtractResponse {
  manufacturer: string;
  productLine: string;
  colors: NamedColor[];
}

export const tool = {
  name: "report_colors",
  description: "Report the paint colors offered on this color chart page.",
  input_schema: {
    type: "object",
    properties: {
      manufacturer: { type: "string", description: "Company that makes the panels, e.g. 'Central States'. Empty if not shown." },
      product_line: { type: "string", description: "Panel or product name the chart is for, e.g. 'Panel-Loc Plus'. Empty if not shown." },
      colors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate_id: { type: "integer", description: "id of the measured region that is this color's chip. Omit only if no region matches." },
            box: {
              type: "array",
              items: { type: "number" },
              minItems: 4,
              maxItems: 4,
              description: "[x, y, w, h] in image pixels. Only when candidate_id is omitted.",
            },
            textured: { type: "boolean", description: "True for metallic, galvalume, wood-grain or other non-flat finishes." },
            name: { type: "string", description: "Color name exactly as printed, without ®, ™, *, †, ‡." },
            types: { type: "array", items: { type: "string" }, description: "Paint systems printed for this color, e.g. ['Standard','Prime','Ultra']." },
            serial: { type: "string", description: "Color/serial/stock number printed for this color, or empty." },
          },
          required: ["name"],
        },
      },
    },
    required: ["manufacturer", "product_line", "colors"],
  },
};

export function buildPrompt(b: ExtractRequest): string {
  const regions = b.candidates
    .map((c) => `${c.id}: ${c.kind} at x=${c.x} y=${c.y} w=${c.w} h=${c.h}, color ${c.hex}`)
    .join("\n");
  const text = b.text.map((t) => `"${t.text}" at x=${t.x} y=${t.y} w=${t.w} h=${t.h}`).join("\n");
  return `This is page ${b.page} of "${b.fileName}", a metal roofing and siding manufacturer's color chart. The image is ${b.width}x${b.height} px.

Measured regions that might be color chips:
${regions || "(none found)"}

Text on the page with positions${text ? "" : " (none; read the text from the image)"}:
${text}

Report every paint color offered on this page:
- Match each color's printed name to its chip. Use candidate_id whenever a region is that chip.
- Ignore regions that are not paint chips: banners, logos, photos, backgrounds, warning bars.
- If a chip has no matching region (common for white chips on a white page or for metallic textures), give its box instead.
- Mark metallic, galvalume and other non-flat finishes as textured.
- Names can wrap onto two lines ("Burnished" / "Slate" is "Burnished Slate"). Paint system labels like STANDARD | PRIME | ULTRA go in types, not in the name.
- Leave out notes such as "Trim in 29 ga only."
- Report each chip once.

Answer by calling the report_colors tool.`;
}

export function buildMessagesRequest(b: ExtractRequest, model = DEFAULT_MODEL) {
  return {
    model,
    max_tokens: 4096,
    tools: [tool],
    // Newer models reject a forced tool choice; "auto" plus a clear instruction works on all.
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.image } },
          { type: "text", text: buildPrompt(b) },
        ],
      },
    ],
  };
}

type RawColor = { candidate_id?: unknown; box?: unknown; textured?: unknown; name?: unknown; types?: unknown; serial?: unknown };

/**
 * Turns Claude's reply into the response the app expects, or null when the reply
 * holds no colors. Accepts a report_colors tool call, or a JSON object in text.
 * Drops colors without a name, unknown or repeated region ids, and boxes that are
 * too small; a color with neither a valid region nor a box is dropped.
 */
export function parseClaudeOutput(out: { content?: { type: string; input?: unknown; text?: string }[] }, candidateIds: number[]): ExtractResponse | null {
  const call = out.content?.find((c) => c.type === "tool_use");
  let raw: unknown = call?.input;
  if (!raw) {
    const text = (out.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const m = /\{[\s\S]*\}/.exec(text);
    try {
      raw = m ? JSON.parse(m[0]) : undefined;
    } catch {
      raw = undefined;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const input = raw as { manufacturer?: unknown; product_line?: unknown; colors?: unknown };
  if (!Array.isArray(input.colors)) return null;

  const ids = new Set(candidateIds);
  const seen = new Set<number>();
  const colors: NamedColor[] = [];
  for (const c of input.colors as RawColor[]) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const id = typeof c.candidate_id === "number" ? c.candidate_id : undefined;
    const okId = id !== undefined && ids.has(id) && !seen.has(id);
    if (okId) seen.add(id!);
    const b = c.box;
    const box =
      !okId && Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number") && b[2] > 2 && b[3] > 2
        ? { x: b[0], y: b[1], w: b[2], h: b[3] }
        : undefined;
    if (!okId && !box) continue;
    colors.push({
      candidateId: okId ? id : undefined,
      box,
      textured: c.textured === true,
      name,
      types: Array.isArray(c.types) ? c.types.filter((t): t is string => typeof t === "string") : [],
      serial: typeof c.serial === "string" ? c.serial : "",
    });
  }
  return {
    manufacturer: typeof input.manufacturer === "string" ? input.manufacturer : "",
    productLine: typeof input.product_line === "string" ? input.product_line : "",
    colors,
  };
}

/** True when the request comes from one of the app's own web addresses. */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return false;
  return allowed.map((o) => o.trim().replace(/\/$/, "")).includes(origin.replace(/\/$/, ""));
}

/* ---------- Server (Deno only) ---------- */

function corsFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "null",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(data: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsFor(origin), "content-type": "application/json" } });
}

type DenoLike = { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };
const deno = (globalThis as { Deno?: DenoLike }).Deno;

if (deno) {
  const MODEL = deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_MODEL;
  const API_KEY = deno.env.get("ANTHROPIC_API_KEY");
  const ALLOWED = (deno.env.get("ALLOWED_ORIGINS") ?? DEFAULT_ALLOWED_ORIGINS.join(",")).split(",");

  deno.serve(async (req) => {
    const origin = req.headers.get("origin");
    const ok = originAllowed(origin, ALLOWED);
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(ok ? origin : null) });
    if (!ok) return json({ error: "Requests are accepted only from the color palette app." }, 403, null);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (!API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set on this function." }, 500, origin);

    let body: ExtractRequest;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Request body must be JSON." }, 400, origin);
    }
    if (!body.image || !body.width) return json({ error: "Missing page image." }, 400, origin);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(buildMessagesRequest(body, MODEL)),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("Anthropic error", res.status, detail);
      return json({ error: `Claude API returned ${res.status}` }, 502, origin);
    }

    const parsed = parseClaudeOutput(await res.json(), body.candidates.map((c) => c.id));
    if (!parsed) return json({ error: "Claude did not return colors." }, 502, origin);
    return json(parsed, 200, origin);
  });
}

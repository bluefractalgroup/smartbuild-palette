// Supabase Edge Function: names the color chips found on one page of a chart.
//
// The browser has already measured every chip's color from the chart's pixels.
// Claude only decides which regions are paint chips and reads each one's name,
// paint types and serial number. It never supplies a color value.
//
// Secrets: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional).

const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ExtractRequest {
  fileName: string;
  page: number;
  width: number;
  height: number;
  image: string; // base64 JPEG
  candidates: { id: number; x: number; y: number; w: number; h: number; hex: string; kind: "solid" | "texture" }[];
  text: { text: string; x: number; y: number; w: number; h: number }[];
}

const tool = {
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

function prompt(b: ExtractRequest) {
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
- Report each chip once.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  if (!API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set on this function." }, 500);

  let body: ExtractRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }
  if (!body.image || !body.width) return json({ error: "Missing page image." }, 400);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      tools: [tool],
      tool_choice: { type: "tool", name: "report_colors" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: body.image } },
            { type: "text", text: prompt(body) },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic error", res.status, detail);
    return json({ error: `Claude API returned ${res.status}` }, 502);
  }

  const out = await res.json();
  const call = out.content?.find((c: { type: string }) => c.type === "tool_use");
  if (!call) return json({ error: "Claude did not return colors." }, 502);
  const input = call.input as {
    manufacturer?: string;
    product_line?: string;
    colors?: { candidate_id?: number; box?: number[]; textured?: boolean; name: string; types?: string[]; serial?: string }[];
  };

  const ids = new Set(body.candidates.map((c) => c.id));
  const seen = new Set<number>();
  const colors = (input.colors ?? [])
    .filter((c) => c.name?.trim())
    .map((c) => {
      const okId = typeof c.candidate_id === "number" && ids.has(c.candidate_id) && !seen.has(c.candidate_id);
      if (okId) seen.add(c.candidate_id!);
      const box =
        !okId && Array.isArray(c.box) && c.box.length === 4 && c.box[2] > 2 && c.box[3] > 2
          ? { x: c.box[0], y: c.box[1], w: c.box[2], h: c.box[3] }
          : undefined;
      return {
        candidateId: okId ? c.candidate_id : undefined,
        box,
        textured: !!c.textured,
        name: c.name.trim(),
        types: c.types ?? [],
        serial: c.serial ?? "",
      };
    })
    .filter((c) => c.candidateId !== undefined || c.box);

  return json({ manufacturer: input.manufacturer ?? "", productLine: input.product_line ?? "", colors });
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });
}

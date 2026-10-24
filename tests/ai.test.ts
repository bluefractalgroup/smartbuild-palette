import { describe, expect, it } from "vitest";
import {
  buildMessagesRequest,
  buildPrompt,
  emailFromAuthHeader,
  isTeamEmail,
  parseClaudeOutput,
  DEFAULT_TEAM_DOMAINS,
  type ExtractRequest,
} from "../supabase/functions/extract-colors/index";
import { placeAiColors } from "../src/lib/extract";
import { unscaleBoxes } from "../src/lib/ai";
import type { Candidate } from "../src/lib/types";

const req: ExtractRequest = {
  fileName: "CHRT_PLP_LO-1.pdf",
  page: 1,
  width: 1211,
  height: 1568,
  image: "AAAA",
  candidates: [
    { id: 0, x: 84, y: 0, w: 108, h: 232, hex: "#030404", kind: "solid" },
    { id: 1, x: 210, y: 0, w: 108, h: 232, hex: "#4D4C48", kind: "solid" },
    { id: 2, x: 207, y: 1336, w: 113, h: 232, hex: "#989898", kind: "texture" },
  ],
  text: [
    { text: "Black", x: 115, y: 234, w: 50, h: 26 },
    { text: "STANDARD | PRIME | ULTRA", x: 84, y: 258, w: 108, h: 16 },
  ],
};

const toolReply = (input: unknown) => ({ content: [{ type: "tool_use", input }] });

describe("prompt", () => {
  it("lists every measured region and the text layer with positions", () => {
    const p = buildPrompt(req);
    expect(p).toContain("0: solid at x=84 y=0 w=108 h=232, color #030404");
    expect(p).toContain("2: texture at");
    expect(p).toContain('"Black" at x=115 y=234');
    expect(p).toContain("report_colors");
  });

  it("asks Claude to read text from the image when there is no text layer", () => {
    expect(buildPrompt({ ...req, text: [] })).toContain("(none; read the text from the image)");
  });

  it("does not force a tool choice (newer models reject it)", () => {
    const body = buildMessagesRequest(req, "test-model");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.model).toBe("test-model");
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg", data: "AAAA" } });
  });
});

describe("reading Claude's reply", () => {
  const ids = req.candidates.map((c) => c.id);

  it("reads a report_colors tool call", () => {
    const r = parseClaudeOutput(
      toolReply({
        manufacturer: "Central States",
        product_line: "Panel-Loc Plus",
        colors: [
          { candidate_id: 0, name: "Black", types: ["Standard", "Prime", "Ultra"] },
          { candidate_id: 2, name: "Galvalume", textured: true },
        ],
      }),
      ids,
    );
    expect(r).toEqual({
      manufacturer: "Central States",
      productLine: "Panel-Loc Plus",
      colors: [
        { candidateId: 0, box: undefined, textured: false, name: "Black", types: ["Standard", "Prime", "Ultra"], serial: "" },
        { candidateId: 2, box: undefined, textured: true, name: "Galvalume", types: [], serial: "" },
      ],
    });
  });

  it("falls back to JSON in a text reply, including a fenced code block", () => {
    const r = parseClaudeOutput(
      { content: [{ type: "text", text: 'Here you go:\n```json\n{"manufacturer":"","product_line":"","colors":[{"candidate_id":1,"name":"Charcoal"}]}\n```' }] },
      ids,
    );
    expect(r?.colors.map((c) => c.name)).toEqual(["Charcoal"]);
  });

  it("drops unknown region ids, repeated ids and unnamed colors", () => {
    const r = parseClaudeOutput(
      toolReply({
        manufacturer: "",
        product_line: "",
        colors: [
          { candidate_id: 99, name: "Ghost" }, // no such region, no box
          { candidate_id: 1, name: "Charcoal" },
          { candidate_id: 1, name: "Charcoal again" }, // region already used
          { candidate_id: 0, name: "   " }, // no name
        ],
      }),
      ids,
    );
    expect(r?.colors.map((c) => c.name)).toEqual(["Charcoal"]);
  });

  it("keeps a color given only as a box, if the box is usable", () => {
    const r = parseClaudeOutput(
      toolReply({
        manufacturer: "",
        product_line: "",
        colors: [
          { name: "Brilliant", box: [700, 0, 108, 232] },
          { name: "Speck", box: [10, 10, 1, 1] }, // too small
          { name: "Bad box", box: [1, 2, 3] },
        ],
      }),
      ids,
    );
    expect(r?.colors).toEqual([
      { candidateId: undefined, box: { x: 700, y: 0, w: 108, h: 232 }, textured: false, name: "Brilliant", types: [], serial: "" },
    ]);
  });

  it("treats a page with no colors as an empty answer, and a reply with none as a failure", () => {
    expect(parseClaudeOutput(toolReply({ manufacturer: "", product_line: "", colors: [] }), ids)?.colors).toEqual([]);
    expect(parseClaudeOutput({ content: [{ type: "text", text: "I can't see any colors." }] }, ids)).toBeNull();
    expect(parseClaudeOutput({ content: [] }, ids)).toBeNull();
  });

  it("ignores wrongly typed fields instead of failing", () => {
    const r = parseClaudeOutput(
      toolReply({ manufacturer: 7, colors: [{ candidate_id: "0", name: "Black", types: "Prime", serial: 12 }, { candidate_id: 1, name: "Charcoal", types: ["Prime", 3] }] }),
      ids,
    );
    expect(r).toEqual({
      manufacturer: "",
      productLine: "",
      colors: [{ candidateId: 1, box: undefined, textured: false, name: "Charcoal", types: ["Prime"], serial: "" }],
    });
  });
});

describe("team access to AI naming", () => {
  const jwt = (payload: object) =>
    "Bearer x." + btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ".sig";

  it("reads the email from the access token", () => {
    expect(emailFromAuthHeader(jwt({ email: "bstudholme@smartbuildsystems.com" }))).toBe("bstudholme@smartbuildsystems.com");
    expect(emailFromAuthHeader(null)).toBe("");
    expect(emailFromAuthHeader("Bearer not-a-jwt")).toBe("");
  });

  it("allows team domains only", () => {
    expect(isTeamEmail("Ken.Furie@BlueFractalGroup.com", DEFAULT_TEAM_DOMAINS)).toBe(true);
    expect(isTeamEmail("bstudholme@smartbuildsystems.com", DEFAULT_TEAM_DOMAINS)).toBe(true);
    expect(isTeamEmail("someone@gmail.com", DEFAULT_TEAM_DOMAINS)).toBe(false);
    expect(isTeamEmail("", DEFAULT_TEAM_DOMAINS)).toBe(false);
  });
});

describe("placing AI-named colors on the page", () => {
  const candidates: Candidate[] = req.candidates.map((c) => ({ ...c }));

  it("keeps the measured color; the AI never supplies one", () => {
    const placed = placeAiColors(
      [{ candidateId: 1, name: "Charcoal®", types: ["Prime"] }],
      candidates,
      () => "#FF00FF",
    );
    expect(placed).toEqual([{ box: candidates[1], textured: false, hex: "#4D4C48", name: "Charcoal", types: ["Prime"], serial: "" }]);
  });

  it("measures a box-only color at that box, and honours its textured flag", () => {
    const calls: unknown[] = [];
    const placed = placeAiColors([{ box: { x: 1, y: 2, w: 30, h: 40 }, textured: true, name: "Galvalume" }], candidates, (b, t) => {
      calls.push([b, t]);
      return "#AFB0B2";
    });
    expect(calls).toEqual([[{ x: 1, y: 2, w: 30, h: 40 }, true]]);
    expect(placed[0]).toMatchObject({ hex: "#AFB0B2", textured: true, name: "Galvalume" });
  });

  it("maps boxes from the picture sent to Claude back to the page", () => {
    expect(unscaleBoxes([{ name: "A", box: { x: 50, y: 100, w: 25, h: 10 } }, { name: "B", candidateId: 0 }], 0.5)).toEqual([
      { name: "A", box: { x: 100, y: 200, w: 50, h: 20 } },
      { name: "B", candidateId: 0 },
    ]);
  });
});

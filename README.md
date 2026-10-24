# SmartBuild Color Palette

Turns metal roofing and siding manufacturers' color charts into a SmartBuild
color palette CSV. This is Activity Set 1 of the SmartBuild Customer Onboarding
System, rebuilt to replace the earlier Lovable prototype.

1. **Add charts.** Drop in the PDF color charts (photos and screenshots work too).
2. **Choose colors.** Each chart's colors appear as swatches. Click to select,
   or use Select all / Deselect all per chart.
3. **Review and export.** Fix names, edit color codes, choose the preferred
   manufacturer, then download the CSV for SmartBuild import (or JSON).

## How the colors stay true

- **Measured, not guessed.** Every hex value is read from the chart's own pixels
  (the median of the chip's interior). AI is only used to name chips.
- **CMYK charts are converted properly.** Many charts define colors in CMYK.
  Browsers convert CMYK with a rough formula (Central States Crimson renders
  `#CF2C1A` instead of `#BD2726`). The app reads the CMYK values from the PDF
  and converts them through an ICC print-profile table, the way Acrobat and
  macOS Preview do. Checked on four Central States charts (72 chips): mean
  ΔE 0.22, worst 0.88 against an ICC reference, which is below what the eye
  can see.
- **Textures stay textures.** Galvalume and metallic chips are kept as the
  chart's image. Their CSV hex is the average color.
- **Compare with chart** splits every swatch: the left half is the exported
  value and the right half is the chart as printed. If you can't see the seam,
  the value is right.
- **A neutral surround.** The interface has no color of its own, and swatches
  sit on a mid-gray field, so nothing nearby shifts how a color reads.

Charts carry the manufacturer's own warning: a screen color is not a paint
match. The app reproduces the digital chart faithfully. It can't make the
digital chart match the painted steel.

## CSV format

The headings must match exactly; SmartBuild's import check is case-sensitive:

```
Color Name,HEX Code,Unique ID,Color Transparency,Color Code,Color Map,Bump Map,Systems,Description,Preferred Manufacturer,Serial Number,All Available Manufacturers
```

- Unique ID: always blank.
- Color Transparency: always 0.
- Color Map, Bump Map and Systems: blank for now.
- Color Code: unique and editable. It's generated as either the full name
  (`BURNISHEDSLATE`) or a maker prefix plus a short form (`CS-BRNSHD`).
- The file is written without a byte-order mark.

A manufacturer's colors with the same name on several of its charts are combined
into one row; colors from different manufacturers never combine, even when the
names match. The review table flags a combined row when the shades differ (for
example, Central States Crimson on Panel-Loc Plus versus Horizon-Loc).

## Running it

### Local mode (no setup)

```
npm install
npm run dev
```

With no Supabase settings, the app runs in local mode: palettes are kept in
this browser, and names come from the chart layout (no AI).

### With Supabase (sign-in, saved palettes, AI naming)

1. Create a Supabase project.
2. Run `supabase/migrations/20261022000000_init.sql` in the SQL editor. It
   creates `palettes` (working state) and `palette_colors` (exported rows and
   their codes, which later onboarding steps will reuse). Both are locked to
   their owner with row-level security.
3. Under Authentication → URL Configuration, add the app's URL (and
   `http://localhost:5173` for development) to the redirect URLs. Sign-in uses
   an email link.
4. Deploy the AI function and set its key:
   ```
   supabase link --project-ref <ref>
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy extract-colors
   ```
   Optional: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`). The function
   only accepts signed-in users.
5. Copy `.env.example` to `.env.local` and fill in the project URL and anon key.

If the AI call fails, the app falls back to reading names from the chart
layout and says so beside that chart.

### Team sharing

Every palette is shared with the whole team: anyone signed in with an email on a
team domain can open, edit and export any palette. Team domains are listed in two
places, which should match:

- the `team_domains` table (who can read and save palettes)
- the `TEAM_DOMAINS` secret on the `extract-colors` function (who can use AI
  naming); it defaults to `smartbuildsystems.com,bluefractalgroup.com`

If a teammate saves a palette after you opened it, the app won't overwrite their
work. It asks whether to load their version or keep yours.

Run `supabase/migrations/20261024000000_team_sharing.sql` after the first migration.

### Hosting on GitHub Pages

`.github/workflows/deploy.yml` tests, builds and publishes on every push to
`main`. In the repository:

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → **Variables**: add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon key is public by
   design; row-level security protects the data.

## Code map

| Path | What it does |
| --- | --- |
| `src/lib/pdf.ts` | Renders pages with pdf.js; collects text lines and image placements |
| `src/lib/cmyk.ts` | Finds CMYK fills in the PDF and repaints them with ICC-accurate color |
| `src/lib/detect.ts` | Finds flat chips and textured chips on a rendered page |
| `src/lib/pair.ts` | Layout-based naming: pairs chips with names, paint types, serials |
| `src/lib/ai.ts` | Calls the `extract-colors` function for AI naming |
| `src/lib/rows.ts` | Builds export rows: merging, codes, validation |
| `src/lib/csv.ts` | SmartBuild CSV and JSON output |
| `src/lib/store.ts` | Palettes in Supabase, or in the browser in local mode |
| `supabase/functions/extract-colors` | Edge function: Claude names the chips |
| `src/assets/cmyk-srgb-17.bin` | 17⁴ CMYK→sRGB table, built with MuPDF/LittleCMS |

## Tests

`npm test` runs the unit tests: chip detection, labelling, CMYK conversion, the
CSV format, merging, and the AI function's prompt and reply parsing.

### AI naming evaluation

`evals/ai/` holds seven real chart pages captured from the app (four Central
States charts plus their page 2s, which have no colors), with hand-checked
answers: 78 colors in all. The evaluation sends them to Claude using the
production prompt and parsing, and scores:

- colors found, and whether each was matched to the right chip
- extra colors invented, and whether pages with no colors stay empty
- textured finishes flagged, and paint types read correctly

It runs two ways: `normal` (as the app sends it) and `no-text` (text layer
removed, like a screenshot, so every name must be read from the picture).

```
ANTHROPIC_API_KEY=sk-ant-... npm run eval:ai
npm run eval:ai:mock          # no API calls; checks the harness itself
```

Or from GitHub: **Actions → AI naming evaluation → Run workflow** (needs an
`ANTHROPIC_API_KEY` repository secret). The report appears on the run's
summary page. The normal variant must find at least 95% of colors on the right
chip with no errors.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import { getEditorName, setEditorName } from "./lib/editor";
import { extractFile } from "./lib/extract";
import { buildRows, validateRows, sourceLabel } from "./lib/rows";
import { toCsv, toJson, download } from "./lib/csv";
import { deletePalette, listPalettes, loadPalette, newPalette, recordExport, savePalette, SaveConflict, type PaletteSummary } from "./lib/store";
import type { CodeStyle, PaletteDoc, RowOverride, Source } from "./lib/types";
import { Chip } from "./components/Chip";
import { ChartRail } from "./components/ChartRail";
import { ReviewTable } from "./components/ReviewTable";

type Tab = "choose" | "review";

export default function App() {
  return <Workspace />;
}

function Workspace() {
  const [editor, setEditor] = useState(getEditorName);
  const [doc, setDoc] = useState<PaletteDoc | null>(null);
  const [list, setList] = useState<PaletteSummary[]>([]);
  const [tab, setTab] = useState<Tab>("choose");
  const [compare, setCompare] = useState(false);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "error" | "conflict">("saved");
  const [conflict, setConflict] = useState<{ by: string; at: string } | null>(null);
  /** Save time of the version this browser last loaded or saved. */
  const stamp = useRef<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportNote, setExportNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [csvText, setCsvText] = useState<string | null>(null);
  const queue = useRef(Promise.resolve());
  const first = useRef(true);

  const refreshList = useCallback(() => listPalettes().then(setList).catch(() => {}), []);

  /** Shows a palette without treating the switch itself as an edit to save. */
  const open = (d: PaletteDoc, saved: boolean) => {
    first.current = true;
    stamp.current = saved ? d.updatedAt : undefined;
    setConflict(null);
    setSaveState("saved");
    setDoc(d);
  };

  // Open the most recent palette, or start one.
  useEffect(() => {
    (async () => {
      const all = await listPalettes().catch(() => []);
      setList(all);
      const latest = all[0] ? await loadPalette(all[0].id).catch(() => null) : null;
      if (latest) open(latest, true);
      else open(newPalette(), false);
    })();
  }, []);

  // Autosave shortly after each change.
  useEffect(() => {
    if (!doc) return;
    if (first.current) { first.current = false; return; }
    if (doc.sources.some((s) => s.status === "reading")) return;
    if (conflict) return; // wait for the person to choose
    setSaveState("unsaved");
    const t = setTimeout(() => {
      setSaveState("saving");
      savePalette(doc, stamp.current)
        .then((at) => { stamp.current = at; setSaveState("saved"); refreshList(); })
        .catch((e) => {
          if (e instanceof SaveConflict) { setConflict({ by: e.by, at: e.at }); setSaveState("conflict"); }
          else setSaveState("error");
        });
    }, 700);
    return () => clearTimeout(t);
  }, [doc, refreshList, conflict]);

  const keepMine = async () => {
    if (!doc) return;
    setSaveState("saving");
    try {
      stamp.current = await savePalette(doc, stamp.current, true);
      setConflict(null);
      setSaveState("saved");
      refreshList();
    } catch {
      setSaveState("error");
    }
  };
  const loadTheirs = async () => {
    if (!doc) return;
    const d = await loadPalette(doc.id).catch(() => null);
    if (d) open(d, true);
  };

  const update = (fn: (d: PaletteDoc) => PaletteDoc) => setDoc((d) => (d ? fn(d) : d));

  const addFiles = (files: File[]) => {
    for (const file of files) {
      const placeholder: Source = {
        id: crypto.randomUUID(),
        fileName: file.name,
        manufacturer: "",
        productLine: "",
        pageCount: 0,
        method: "layout",
        status: "reading",
        addedAt: new Date().toISOString(),
      };
      update((d) => ({ ...d, sources: [...d.sources, placeholder] }));
      queue.current = queue.current.then(async () => {
        try {
          const { source, swatches } = await extractFile(file, !!supabase, (m) =>
            setProgress((p) => ({ ...p, [placeholder.id]: m })),
          );
          const s = { ...source, id: placeholder.id };
          update((d) => ({
            ...d,
            sources: d.sources.map((x) => (x.id === placeholder.id ? s : x)),
            swatches: [...d.swatches, ...swatches.map((w) => ({ ...w, sourceId: placeholder.id }))],
          }));
        } catch (e) {
          update((d) => ({
            ...d,
            sources: d.sources.map((x) =>
              x.id === placeholder.id
                ? { ...x, status: "error", note: `This file couldn't be read (${e instanceof Error ? e.message : e}). Try a PDF or a PNG.` }
                : x,
            ),
          }));
        }
      });
    }
  };

  const rows = useMemo(() => (doc ? buildRows(doc) : []), [doc]);
  const problems = useMemo(() => validateRows(rows), [rows]);

  if (!doc) return null;

  const selectedCount = doc.swatches.filter((s) => s.selected).length;
  const setOverride = (key: string, patch: RowOverride) =>
    update((d) => ({ ...d, overrides: { ...d.overrides, [key]: { ...d.overrides[key], ...patch } } }));
  const setSelected = (pred: (sourceId: string, id: string) => boolean, value: boolean) =>
    update((d) => ({ ...d, swatches: d.swatches.map((s) => (pred(s.sourceId, s.id) ? { ...s, selected: value } : s)) }));

  const fileBase = (doc.name.trim() || "palette").replace(/[^\w-]+/g, "-").toLowerCase();
  const exportCsv = async () => {
    download(`${fileBase}.csv`, toCsv(rows), "text/csv;charset=utf-8");
    try {
      await recordExport(doc, rows);
      setExportNote(supabase ? `Exported ${rows.length} colors. Codes saved for later steps.` : `Exported ${rows.length} colors.`);
    } catch {
      setExportNote(`Exported ${rows.length} colors. The codes couldn't be saved to the database; the CSV is complete.`);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><b>SmartBuild</b><span>Color palette</span></div>
        <div className="menu">
          <button type="button" className="btn quiet" aria-expanded={menuOpen} onClick={() => { setMenuOpen((o) => !o); setConfirmDelete(false); }}>Palettes ▾</button>
          {menuOpen && (
            <div className="menu-list" role="menu">
              <button role="menuitem" onClick={() => { open(newPalette(), false); setTab("choose"); setMenuOpen(false); }}>New palette</button>
              <hr />
              {list.map((p) => (
                <button
                  role="menuitem"
                  key={p.id}
                  onClick={async () => {
                    const d = await loadPalette(p.id);
                    if (d) open(d, true);
                    setMenuOpen(false);
                  }}
                >
                  {p.name}
                  <span className="when">
                    Edited {new Date(p.updatedAt).toLocaleString()}
                    {p.updatedBy ? ` by ${p.updatedBy}` : ""}
                  </span>
                </button>
              ))}
              {list.some((p) => p.id === doc.id) && (
                <>
                  <hr />
                  {confirmDelete ? (
                    <button
                      role="menuitem"
                      style={{ color: "var(--danger)", fontWeight: 600 }}
                      onClick={async () => {
                        await deletePalette(doc.id);
                        await refreshList();
                        open(newPalette(), false);
                        setConfirmDelete(false);
                        setMenuOpen(false);
                      }}
                    >
                      Delete "{doc.name}" for good
                    </button>
                  ) : (
                    <button role="menuitem" onClick={() => setConfirmDelete(true)}>Delete this palette…</button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <input
          className="palette-name"
          value={doc.name}
          aria-label="Palette name"
          onChange={(e) => update((d) => ({ ...d, name: e.target.value }))}
        />
        <div className="top-right">
          <span className="save-state" role="status">
            {{ saved: "Saved", saving: "Saving…", unsaved: "Editing", error: "Not saved", conflict: "Not saved" }[saveState]}
          </span>
          {supabase ? (
            <label className={"editor" + (editor ? "" : " missing")}>
              <span>Your name</span>
              <input
                className="field"
                value={editor}
                placeholder="Shown on palettes you edit"
                onChange={(e) => { setEditor(e.target.value); setEditorName(e.target.value); }}
              />
            </label>
          ) : (
            <span title="No Supabase project is configured, so palettes stay in this browser.">Local mode</span>
          )}
        </div>
      </header>

      {conflict && (
        <div className="conflict" role="alert">
          <span>
            <strong>{conflict.by}</strong> saved changes to this palette at{" "}
            {new Date(conflict.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, after you opened it.
            Your recent edits aren't saved yet.
          </span>
          <button className="btn" onClick={loadTheirs}>Load their version</button>
          <button className="btn quiet" onClick={keepMine}>Keep mine and replace theirs</button>
        </div>
      )}

      <nav className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === "choose"} onClick={() => setTab("choose")}>
          Choose colors<span className="count">{doc.swatches.length || ""}</span>
        </button>
        <button className="tab" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
          Review and export<span className="count">{rows.length || ""}</span>
        </button>
      </nav>

      {tab === "choose" ? (
        <div className="choose">
          <ChartRail
            sources={doc.sources}
            progress={progress}
            aiAvailable={!!supabase}
            onFiles={addFiles}
            onEdit={(id, patch) => update((d) => ({ ...d, sources: d.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))}
            onRemove={(id) => update((d) => ({ ...d, sources: d.sources.filter((s) => s.id !== id), swatches: d.swatches.filter((s) => s.sourceId !== id) }))}
          />
          <main className="booth" aria-label="Colors">
            {doc.swatches.length === 0 ? (
              <p className="empty">
                Add a manufacturer's color chart to see its colors here.
                <small>Each color is measured from the chart itself, so the swatch you see is the value that's exported.</small>
              </p>
            ) : (
              <>
                <div className="booth-tools">
                  <label className="toggle">
                    <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                    Compare with chart
                  </label>
                </div>
                {doc.sources.filter((s) => s.status === "ready").map((s) => {
                  const chips = doc.swatches.filter((w) => w.sourceId === s.id);
                  if (!chips.length) return null;
                  const n = chips.filter((c) => c.selected).length;
                  return (
                    <section className="group" key={s.id} aria-label={sourceLabel(s)}>
                      <div className="group-head">
                        <h3>{sourceLabel(s)}</h3>
                        <span className="meta">{n} of {chips.length} selected</span>
                        <span className="actions">
                          <button className="btn quiet" onClick={() => setSelected((sid) => sid === s.id, true)}>Select all</button>
                          <button className="btn quiet" onClick={() => setSelected((sid) => sid === s.id, false)}>Deselect all</button>
                        </span>
                      </div>
                      <div className="chips">
                        {chips.map((c) => (
                          <Chip key={c.id} swatch={c} compare={compare} onToggle={() => setSelected((_, id) => id === c.id, !c.selected)} />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </>
            )}
          </main>
        </div>
      ) : (
        <main className="review" aria-label="Review and export">
          {rows.length === 0 ? (
            <p style={{ color: "var(--ink-2)", maxWidth: "52ch" }}>
              Pick colors on the Choose colors tab and they'll appear here, ready to check and export.
            </p>
          ) : (
            <>
              <div className="review-tools">
                <label>
                  Color code style
                  <select
                    className="field"
                    value={doc.codeStyle}
                    onChange={(e) => update((d) => ({ ...d, codeStyle: e.target.value as CodeStyle }))}
                  >
                    <option value="full">Full name, e.g. BURNISHEDSLATE</option>
                    <option value="prefixed">Maker prefix + short, e.g. CS-BRNSHD</option>
                  </select>
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={doc.mergeSameNames}
                    onChange={(e) => update((d) => ({ ...d, mergeSameNames: e.target.checked }))}
                  />
                  Combine a manufacturer's same-named colors across its charts
                </label>
                <span className="spacer" />
                <span style={{ color: "var(--ink-2)", fontSize: 13 }}>
                  {selectedCount} chips, {rows.length} colors
                </span>
                <button className="btn" onClick={() => download(`${fileBase}.json`, toJson(rows, doc.name), "application/json")} disabled={problems.length > 0}>
                  Download JSON
                </button>
                <button
                  className="btn"
                  disabled={problems.length > 0}
                  onClick={async () => {
                    const text = toCsv(rows);
                    try {
                      await navigator.clipboard.writeText(text);
                      setExportNote(`Copied ${rows.length} colors as CSV. Paste into a text file and save it as .csv.`);
                      setCsvText(null);
                    } catch {
                      setCsvText(text);
                      setExportNote("Copy the CSV below (it's selected), then save it as a .csv file.");
                    }
                    recordExport(doc, rows).catch(() => {});
                  }}
                >
                  Copy CSV
                </button>
                <button className="btn primary" onClick={exportCsv} disabled={problems.length > 0}>
                  Download CSV
                </button>
              </div>
              {problems.length > 0 && (
                <div className="problems" role="alert">
                  <strong>{problems.length} {problems.length === 1 ? "field needs" : "fields need"} fixing before export.</strong> They're marked in the table.
                </div>
              )}
              {exportNote && problems.length === 0 && <p role="status" style={{ fontSize: 14, marginTop: 0 }}>{exportNote}</p>}
              {csvText !== null && problems.length === 0 && (
                <textarea
                  className="field"
                  readOnly
                  rows={6}
                  value={csvText}
                  aria-label="CSV"
                  ref={(el) => el?.select()}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, marginBottom: 16 }}
                />
              )}
              <ReviewTable rows={rows} sources={doc.sources} problems={problems} onChange={setOverride} />
            </>
          )}
        </main>
      )}
    </div>
  );
}

import { useRef, useState } from "react";
import type { Source } from "../lib/types";

interface Props {
  sources: Source[];
  progress: Record<string, string>;
  aiAvailable: boolean;
  onFiles: (files: File[]) => void;
  onEdit: (id: string, patch: Partial<Source>) => void;
  onRemove: (id: string) => void;
}

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

export function ChartRail({ sources, progress, aiAvailable, onFiles, onEdit, onRemove }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <aside className="rail" aria-label="Color charts">
      <h2>Color charts</h2>
      <div
        className={"drop" + (over ? " over" : "")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFiles([...e.dataTransfer.files]);
        }}
      >
        <p>Drop manufacturer color charts here. PDF works best; photos and screenshots work too.</p>
        <button type="button" className="btn" onClick={() => input.current?.click()}>Add charts</button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            onFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {!aiAvailable && (
        <p className="method">AI naming is off in local mode. Names are read from the chart layout.</p>
      )}

      {sources.map((s) => (
        <section className="source" key={s.id} aria-label={s.fileName}>
          <div className="file">
            <span title={s.fileName}>{s.fileName}</span>
            <button type="button" className="btn quiet" onClick={() => onRemove(s.id)} aria-label={`Remove ${s.fileName}`}>
              Remove
            </button>
          </div>
          {s.status === "reading" ? (
            <div className="working" role="status">{progress[s.id] ?? "Reading"}…</div>
          ) : (
            <>
              <label>
                Manufacturer
                <input className="field" value={s.manufacturer} onChange={(e) => onEdit(s.id, { manufacturer: e.target.value })} />
              </label>
              <label>
                Product line
                <input className="field" value={s.productLine} onChange={(e) => onEdit(s.id, { productLine: e.target.value })} />
              </label>
              <div className="method">
                {s.method === "ai" ? "Names by AI" : "Names from chart layout"}.{" "}
                {s.cmykFills ? "CMYK colors converted with a print profile, as Acrobat shows them." : "Colors measured from the chart."}
              </div>
              {s.note && <div className="note">{s.note}</div>}
            </>
          )}
        </section>
      ))}
    </aside>
  );
}

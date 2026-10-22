import { normalizeHex } from "../lib/color";
import { sourceLabel, type RowProblem } from "../lib/rows";
import type { ExportRow, RowOverride, Source } from "../lib/types";

interface Props {
  rows: ExportRow[];
  sources: Source[];
  problems: RowProblem[];
  onChange: (key: string, patch: RowOverride) => void;
}

export function ReviewTable({ rows, sources, problems, onChange }: Props) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const err = (key: string, field: RowProblem["field"]) => problems.find((p) => p.key === key && p.field === field);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th aria-label="Swatch" />
            <th className="col-name">Color Name</th>
            <th className="col-hex">HEX Code</th>
            <th className="col-code">Color Code</th>
            <th>Description</th>
            <th>Preferred Manufacturer</th>
            <th className="col-serial">Serial Number</th>
            <th>All Available Manufacturers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const textured = r.swatches.some((s) => s.textured);
            const hexOk = normalizeHex(r.hex);
            const nameErr = err(r.key, "name"), hexErr = err(r.key, "hex"), codeErr = err(r.key, "code");
            const choices = [...new Set(r.swatches.map((s) => s.sourceId))];
            return (
              <tr key={r.key}>
                <td>
                  <span
                    className="mini"
                    style={textured ? { backgroundImage: `url(${r.swatches[0].chartCrop})` } : { background: hexOk ?? "transparent" }}
                    title={textured ? "Textured finish" : r.hex}
                  />
                </td>
                <td>
                  <input
                    className={"field" + (nameErr ? " bad" : "")}
                    value={r.name}
                    aria-label="Color name"
                    onChange={(e) => onChange(r.key, { name: e.target.value })}
                  />
                  {nameErr && <div className="err">{nameErr.message}</div>}
                </td>
                <td>
                  <div className="hexcell">
                    <i style={{ background: hexOk ?? "transparent" }} />
                    <input
                      className={"field" + (hexErr ? " bad" : "")}
                      value={r.hex}
                      aria-label="HEX code"
                      spellCheck={false}
                      onChange={(e) => onChange(r.key, { hex: e.target.value.toUpperCase() })}
                    />
                  </div>
                  {hexErr && <div className="err">{hexErr.message}</div>}
                  {textured && !hexErr && <div className="hint">Average of texture</div>}
                </td>
                <td>
                  <input
                    className={"field" + (codeErr ? " bad" : "")}
                    value={r.code}
                    aria-label="Color code"
                    spellCheck={false}
                    onChange={(e) => onChange(r.key, { code: e.target.value.toUpperCase() })}
                  />
                  {codeErr && <div className="err">{codeErr.message}</div>}
                </td>
                <td>
                  <input
                    className="field"
                    value={r.description}
                    aria-label="Description"
                    onChange={(e) => onChange(r.key, { description: e.target.value })}
                  />
                </td>
                <td>
                  {choices.length > 1 ? (
                    <select
                      className="field"
                      value={r.preferredSourceId}
                      aria-label="Preferred manufacturer"
                      onChange={(e) => {
                        const sw = r.swatches.find((s) => s.sourceId === e.target.value);
                        // Switching maker takes that maker's measured color unless the hex was typed in.
                        onChange(r.key, { preferredSourceId: e.target.value, hex: sw?.hex });
                      }}
                    >
                      {choices.map((id) => (
                        <option key={id} value={id}>{sourceLabel(byId.get(id))}</option>
                      ))}
                    </select>
                  ) : (
                    r.preferredManufacturer
                  )}
                  {r.spread > 3 && (
                    <div className="shades" title={`Color difference ΔE ${r.spread.toFixed(1)}`}>
                      {r.swatches.map((s) => (
                        <i key={s.id} style={{ background: s.hex }} title={`${sourceLabel(byId.get(s.sourceId))}: ${s.hex}`} />
                      ))}
                      <span>Shades differ between charts</span>
                    </div>
                  )}
                </td>
                <td>
                  <input
                    className="field"
                    value={r.serial}
                    aria-label="Serial number"
                    onChange={(e) => onChange(r.key, { serial: e.target.value })}
                  />
                </td>
                <td className="avail">{r.availableManufacturers.join("; ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

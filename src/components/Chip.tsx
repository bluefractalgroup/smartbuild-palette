import { useState } from "react";
import type { Swatch } from "../lib/types";

interface Props {
  swatch: Swatch;
  compare: boolean;
  onToggle: () => void;
}

/**
 * The color area shows the measured hex as a flat fill — that is exactly what goes
 * into the CSV. Textured chips (galvalume, metallics) show the chart's own image.
 * In compare mode the right half is the chip as printed in the chart; a seamless
 * join means the measurement is true.
 */
export function Chip({ swatch, compare, onToggle }: Props) {
  const { name, hex, types, textured, chartCrop, selected } = swatch;
  // A low-resolution texture (e.g. from a screenshot) is tiled at its own size instead
  // of being enlarged, so the grain stays sharp.
  const [tile, setTile] = useState<{ w: number; h: number } | null>(null);
  return (
    <button
      type="button"
      className="chip"
      role="checkbox"
      aria-checked={selected}
      aria-label={`${name}, ${hex}${textured ? ", textured finish" : ""}`}
      onClick={onToggle}
    >
      <span className="color" aria-hidden="true">
        {textured ? (
          tile ? (
            <span
              className="tex"
              style={{ backgroundImage: `url(${chartCrop})`, backgroundSize: `${tile.w}px ${tile.h}px`, backgroundRepeat: "repeat" }}
            />
          ) : (
            <img
              className="tex"
              src={chartCrop}
              alt=""
              onLoad={(e) => {
                const img = e.currentTarget;
                // Enlarging more than about 1.5x on screen visibly softens the texture.
                const shown = img.clientWidth * (window.devicePixelRatio || 1);
                if (img.naturalWidth > 0 && img.naturalWidth * 1.5 < shown) {
                  setTile({ w: img.naturalWidth, h: img.naturalHeight });
                }
              }}
            />
          )
        ) : compare ? (
          <>
            <span style={{ background: hex }} />
            <img src={chartCrop} alt="" />
            <span className="seam" />
          </>
        ) : (
          <span style={{ background: hex }} />
        )}
      </span>
      {textured && <span className="tag">Textured</span>}
      <span className="check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" /></svg>
      </span>
      <span className="plate">
        {compare && !textured && (
          <span className="split-label"><span>Measured</span><span>Chart</span></span>
        )}
        <span className="name">{name}</span>
        <span className="hex">{textured ? `avg ${hex}` : hex}</span>
        {types.length > 0 && <span className="types">{types.join(" | ")}</span>}
      </span>
    </button>
  );
}

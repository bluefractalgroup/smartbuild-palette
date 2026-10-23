export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line of text on a rendered page, in canvas pixels. */
export interface TextLine extends Box {
  text: string;
}

/** A region on a page that may be a color chip. */
export interface Candidate extends Box {
  id: number;
  /** "solid" = flat fill, color measured from pixels; "texture" = image (metallic, galvalume...). */
  kind: "solid" | "texture";
  hex: string;
}

export interface RenderedPage {
  page: number;
  width: number;
  height: number;
  /** Scale from PDF points to canvas pixels. */
  scale: number;
  canvas: HTMLCanvasElement;
  text: TextLine[];
  /** Where images are placed, with their native detail (image pixels per canvas pixel). */
  imageBoxes: (Box & { density?: number })[];
  /** Re-renders one region (in this page's canvas pixels) at higher resolution. */
  renderCrop: (box: Box, longSide: number) => Promise<HTMLCanvasElement>;
}

export interface RenderedFile {
  pages: RenderedPage[];
  /** Frees the PDF or image once extraction is done. */
  close: () => Promise<void>;
}

export type ExtractMethod = "ai" | "layout";

export interface Source {
  id: string;
  fileName: string;
  manufacturer: string;
  productLine: string;
  pageCount: number;
  method: ExtractMethod;
  /** Number of CMYK fills converted with the print profile (0 for RGB charts). */
  cmykFills?: number;
  status: "reading" | "ready" | "error";
  note?: string;
  addedAt: string;
}

export interface Swatch {
  id: string;
  sourceId: string;
  name: string;
  hex: string;
  /** PNG data URL of the chip as printed in the chart (always kept, used for the compare view). */
  chartCrop: string;
  /** True when the chip is a texture (metallic, galvalume) rather than a flat paint. */
  textured: boolean;
  types: string[];
  serial: string;
  page: number;
  selected: boolean;
}

/** Edits a user makes on the review table, keyed by row key. */
export interface RowOverride {
  name?: string;
  hex?: string;
  code?: string;
  description?: string;
  preferredSourceId?: string;
  serial?: string;
}

export type CodeStyle = "full" | "prefixed";

export interface PaletteDoc {
  id: string;
  name: string;
  sources: Source[];
  swatches: Swatch[];
  overrides: Record<string, RowOverride>;
  codeStyle: CodeStyle;
  mergeSameNames: boolean;
  updatedAt: string;
}

/** One row of the SmartBuild export. */
export interface ExportRow {
  key: string;
  name: string;
  hex: string;
  code: string;
  description: string;
  preferredManufacturer: string;
  preferredSourceId: string;
  serial: string;
  availableManufacturers: string[];
  swatches: Swatch[];
  /** Largest color difference between merged swatches (0 when one source). */
  spread: number;
}

// Data for scanned-to-Excel conversion (D-272): TableDoc is modified on the edit page, and xlsx is regenerated from it each time.

/** Pixel coordinates, with origin at the top-left corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** RGBA pixels (4 bytes per pixel). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Recognized line of text (same coordinate system as the line-detection image). */
export interface OcrBox extends Box {
  text: string;
  /** Average recognition confidence (0–1, present in PP-OCRv6; absent in system OCR). */
  score?: number;
  /**
   * Approximate position of each character (PP-OCRv6 CTC timestamps, D-272): at is the ratio
   * (0–1) of the character's center from left to right within the line. When absent (system OCR),
   * lines crossing vertical lines cannot be split by character, and the entire line is placed
   * into a cell based on its center.
   */
  chars?: readonly { text: string; at: number }[];
}

/** Horizontal alignment: determined by the position of text within the cell in the original image (D-272); defaults to left when absent. */
export type CellAlign = 'left' | 'center' | 'right';

/**
 * A single cell; merged cells have only one top-left cell, with rowSpan / colSpan greater than 1.
 * Every position in the grid belongs to exactly one cell. col and colSpan are calculated based on
 * shared columns for this page (starting from the table's first column TableBlock.col), so a cell
 * may span multiple column lines unique to other tables.
 */
export interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  align?: CellAlign;
  /** Position of this cell in the original image (for screenshot verification); absent for rows/columns inserted on the edit page. */
  box?: Box;
  /**
   * Cell export format (record export, D-427): text is always text, number is a true number or
   * date (format is Excel number format). When absent (scans), guessed as text: pure numbers are
   * written as numbers.
   */
  write?: { kind: 'text' } | { kind: 'number'; value: number; format: string };
  /** Font size (points, D-521): estimated from the line height of characters in this cell; falls back to the page's bodySize when absent (defaulting to 11). */
  size?: number;
  /** Bold (D-521): strokes are significantly thicker than the page's text; not bold when absent. */
  bold?: boolean;
}

export interface TableBlock {
  kind: 'table';
  rows: number;
  /** Starting shared column index for this table on the page (0-indexed). */
  col: number;
  /** Number of shared columns occupied. */
  cols: number;
  /** Arranged by rows and columns. */
  cells: TableCell[];
  box: Box;
  /** Side-by-side band (D-522), same as TextBlock.band. */
  band?: number;
  /** Cells have no borders when writing xlsx (tables imported from external xlsx files, D-509: original borders cannot be read, nor are borders added to individual cells). */
  borderless?: boolean;
}

/**
 * A paragraph of text outside tables (written to xlsx when recognition scope is "all content",
 * one line per paragraph). When col is absent, spans from the first column to the last column;
 * two-column pages (D-522) have their own column ranges per column, with two-column paragraphs
 * laid out on the same batch of rows.
 */
export interface TextBlock {
  kind: 'text';
  text: string;
  align?: CellAlign;
  /** Starting shared column index and column span on this page (same as TableBlock.col / cols); spans the entire page when both are absent. */
  col?: number;
  cols?: number;
  /** Side-by-side band (D-522): blocks with the same ID start on the same row, each laying out its own columns (left column, right column, adjacent image). */
  band?: number;
  /** Font size (points) and bold (D-521), same as TableCell. */
  size?: number;
  bold?: boolean;
  box: Box;
}

/**
 * Image cropped from the original image (D-520): placed starting at column col spanning cols
 * columns when writing xlsx, with height proportional to the image aspect ratio. src is the
 * cropped JPG (current runtime file, becomes a workspace file after being placed on the desk);
 * absent if cropping fails, edit page displays position only.
 */
export interface ImageBlock {
  kind: 'image';
  col: number;
  cols: number;
  band?: number;
  src?: string;
  box: Box;
}

export type Block = TableBlock | TextBlock | ImageBlock;

export interface TablePage {
  /** Worksheet name (cleaned up when writing xlsx). */
  name: string;
  /** URI of the image used to crop the original image (the line-detection image). */
  source: string;
  /** Size of that image during line detection: boxes are in this coordinate system, converted to actual original image sizes during screenshots. */
  width: number;
  height: number;
  /** Typical text line height on this page (pixels): leaves a blank line when the gap between paragraphs exceeds 1.5 times the line height. */
  lineHeight: number;
  /**
   * Shared column widths across the page (original image pixels): vertical lines of all tables
   * (or text gap-based columns when no vertical lines exist) are aligned into a set of column
   * lines (D-272), with non-table text spanning from the first column to the last column.
   * Defaults to 4 columns evenly splitting page width when there are no tables.
   */
  colWidths: number[];
  /** Body text font size on this page (points, D-521): used when cells and text lack their own font size; defaults to 11 when absent (legacy files). */
  bodySize?: number;
  /** Ordered by reading sequence (top to bottom). */
  blocks: Block[];
}

export type TableScope = 'all' | 'tables';

export interface TableDoc {
  /** 3: Added image blocks, text column ranges, font sizes (D-520–D-522); version 2 files are upgraded to 3 upon reading (parseTableDoc) without losing any fields. */
  version: 3;
  /** Recognition scope: determines only whether non-table text is written to xlsx, so toggling it does not lose edited content. */
  scope: TableScope;
  pages: TablePage[];
}

import {
  addSpan,
  coveredLength,
  findLines,
  findTables,
  type PageLines,
  type RuleLine,
  type TableLines,
} from './lines';
import { BOLD_RATIO, CHOP_MIN, CHOP_SHARE, isRuleGrid, strokeRatio } from './doc-support';
import { lineShareIn, type LayoutRegion } from './layout';
import { bodySizeOf, layoutRegions, planRest, tableSizeOf } from './sheet-arrange';
import { findTextTables, levelLines } from './text-table';
import type {
  Block,
  Box,
  CellAlign,
  OcrBox,
  RgbaImage,
  TableBlock,
  TableCell,
  TablePage,
} from './types';

// Single page: lines -> table area -> grid and merged cells -> text lines placed into cells ->
// non-table text segmented (D-272). Computed in rectified coordinates (x' = x + y*t, y' = y - x*t),
// converted back to original image coordinates before storing in TablePage (for screenshot
// verification).

export interface BuildOptions {
  /** Join lines in the same cell (or paragraph) into text; App uses layoutOcrLines from D-268 plus language-based formatting. */
  joinLines?: (lines: readonly OcrBox[]) => string;
  /**
   * Recognition lines placed into cells for each table (passed-in object): rows not placed into
   * tables during Word export are still arranged as body text (D-501). chopped is the number of
   * lines cut from the middle of a word by column lines (D-502): characters do not cross column
   * lines in real tables; crossings usually indicate grid misrecognition.
   */
  onTable?: (
    table: TableBlock,
    lines: readonly OcrBox[],
    check: { chopped: number; ruled: boolean; framedText?: boolean },
  ) => void;
  /**
   * Recognize borderless tables in addition to lined tables (D-506: same rule set as Word export,
   * D-471, D-502, D-503), enabled by default. Word export performs its own recognition after
   * removing vertical text and sporadic characters, not here.
   */
  textTables?: boolean;
  /**
   * Excel export (D-520-D-522): use layout analysis regions (image regions clipped into image
   * blocks, text in non-table grids arranged as text), non-table text split into columns using
   * Word export side-by-side rules, estimate font size and boldness for each text block and
   * table. When omitted, non-table text defaults to one paragraph per line (handled by Word
   * export).
   */
  arrange?: boolean;
  /** Detect very faint table lines (findLines light): passed only to Word export, Excel export unchanged. */
  lightRules?: boolean;
  /** Separate vertically stacked tables sharing an outer border (findTables splitStacked): passed only to Word export. */
  splitStacked?: boolean;
  /** Grids filled with horizontal/vertical lines but containing no characters use the text row immediately above as their header (for Word export, withHeaderAbove). */
  headerAbove?: boolean;
}

export interface PageInput {
  /** Image used for line detection (enhanced version, or original if not enhanced). */
  image: RgbaImage;
  /** Recognized lines, with coordinates matching image. */
  lines: readonly OcrBox[];
  name: string;
  source: string;
  /** Layout analysis regions (used when arrange is enabled; otherwise arranged by position only). */
  regions?: readonly LayoutRegion[];
  /** Known tilt angle (degrees); enhanced images are already rectified, pass 0. Estimated when omitted. */
  skew?: number;
}

/** A grid boundary: lined indicates presence of lines (borderless boundaries split by text gaps or text lines do not merge across). */
export interface Boundary {
  pos: number;
  lined: boolean;
}

export interface Grid {
  xs: Boundary[];
  ys: Boundary[];
  /** Cell ownership for each position (r * cols + c -> index in cells). */
  owner: Int32Array;
  cells: TableCell[];
  /** A box enclosing a few lines of text, not a table (EU sample 075). */
  framedText?: boolean;
}

/** Merge adjacent cells if the line length on a shared side is less than half. */
const MERGE_COVERAGE = 0.5;
/** Considered a column separator if at least this proportion of text lines are blank at the same location (tables with horizontal lines only). */
const GAP_ROW_SHARE = 0.6;
/** Column separator gap must be at least this many times the line height (wider than spaces between words). */
const GAP_MIN_HEIGHTS = 0.6;
/** A region covered by vertical lines and lacking horizontal lines must have at least this many text rows to split by row. */
const SPLIT_MIN_ROWS = 3;
/** Maximum number of cells per table; tables exceeding this (graph paper) are not treated as tables. */
const MAX_TABLE_CELLS = 5000;
/** Paragraph: vertical spacing not exceeding 1.2 times line height counts as the same paragraph (same as D-268). */
const PARAGRAPH_GAP = 1.2;

/** Column lines of different tables differing by less than this fraction (1%) of the long side are aligned into a page-shared column line (slightly wider than 0.8% deduplication within a single table). */
const SHARED_COLUMN_SHARE = 0.01;
/** When no table exists, non-table text is merged from column A to D. */
const TEXT_ONLY_COLS = 4;
/** Alignment: alignment is imperceptible when the combined margins on both sides of the text are less than one line height (text nearly fills the cell). */
const ALIGN_MIN_SLACK = 1;
/** Ratio of the difference between left and right whitespace to the sum of both sides' whitespace; exceeding this is considered aligned to one side, otherwise centered. */
const ALIGN_SIDE_SHARE = 0.35;

/** Bold characters misidentified as lines: horizontal lines inside a line box (both top and bottom are at least 20% of the line height away from the box edges), with a large majority falling within the horizontal range of the box. */
const STROKE_INSIDE = 0.2;
const STROKE_SHARE = 0.7;
/** Lines considered connected (same as TOUCH_SHARE in lines.ts): endpoints are no further than 0.5% of the long side from the other line. */
const STROKE_TOUCH_SHARE = 0.005;
const STROKE_MIN_JOINED = 3;
const STROKE_RULE_SHARE = 0.3;
/** Inter-word gap indicating a gap between two text segments rather than the middle of a word when the distance between both sides of a cut is larger than normal by this multiple. */
const CHOP_GAP = 1.8;
/** Maximum number of line heights outermost column lines of a table without lines can be shifted outward to align with column lines of other tables (D-506, same as the upper limit for column spacing in D-471). */
const SNAP_REACH = 3;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1]! : 0;
};

const centerX = (b: Box) => b.x + b.width / 2;
const centerY = (b: Box) => b.y + b.height / 2;

/** Grouped into rows by vertical overlap (same rule as D-268), with each row ordered from left to right. */
function textRows<T extends Box>(lines: readonly T[]): T[][] {
  const sorted = [...lines].sort((a, b) => centerY(a) - centerY(b));
  const rows: T[][] = [];
  for (const line of sorted) {
    const first = rows.at(-1)?.[0];
    if (first) {
      const overlap =
        Math.min(first.y + first.height, line.y + line.height) - Math.max(first.y, line.y);
      if (overlap >= 0.5 * Math.min(first.height, line.height)) {
        rows.at(-1)!.push(line);
        continue;
      }
    }
    rows.push([line]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

/** Default joining method: join items in the same row with spaces, and separate rows with newlines. */
/**
 * Recognize text that reads a dashed or double line: at least two symbols like `=`, `_`, `-`,
 * with miscellaneous characters making up no more than half; one or two `-` characters are
 * excluded (short dashes in grid cells representing "none").
 */
export function isRuleText(text: string): boolean {
  const chars = [...text.replace(/\s/g, '')];
  const marks = chars.filter((c) => /[=_~\-–—]/.test(c));
  return (
    marks.length >= 2 &&
    marks.length * 2 >= chars.length &&
    (marks.some((c) => /[=_~]/.test(c)) || marks.length >= 3)
  );
}

function defaultJoin(lines: readonly OcrBox[]): string {
  return textRows(lines)
    .map((row) => row.map((l) => l.text.trim()).join(' '))
    .join('\n');
}

/** Remove closely spaced duplicate positions (double lines, two segments of the same line). */
function dedupe(values: readonly number[], tol: number): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length && v - out.at(-1)! <= tol) out[out.length - 1] = (out.at(-1)! + v) / 2;
    else out.push(v);
  }
  return out;
}

/** Ratio of the line's length to [a, b] (endpoints slightly indented, intersections excluded). */
function coverage(lines: readonly RuleLine[], pos: number, a: number, b: number, tol: number) {
  const spans: [number, number][] = [];
  for (const l of lines) {
    if (Math.abs(l.pos - pos) > tol) continue;
    for (const [s, e] of l.spans) addSpan(spans, s, e, 0);
  }
  const shrink = Math.min(tol, (b - a) * 0.25);
  const length = b - a - 2 * shrink;
  return length > 0 ? coveredLength(spans, a + shrink, b - shrink) / length : 0;
}

/** Tables with horizontal lines only: whitespace gaps in the x-direction across all text lines; column separators are places where at least 60% of the lines are empty. */
function gapColumns(lines: readonly OcrBox[], left: number, right: number, lineHeight: number) {
  const rows = textRows(lines);
  if (rows.length < 2) return [];
  const from = Math.max(left, Math.floor(Math.min(...lines.map((l) => l.x))));
  const to = Math.min(right, Math.ceil(Math.max(...lines.map((l) => l.x + l.width))));
  if (to - from < 2) return [];
  const empty = new Int32Array(to - from);
  for (const row of rows) {
    const used = new Uint8Array(to - from);
    for (const l of row) {
      const a = Math.max(0, Math.floor(l.x) - from);
      const b = Math.min(to - from, Math.ceil(l.x + l.width) - from);
      used.fill(1, a, Math.max(a, b));
    }
    for (let x = 0; x < used.length; x++) if (!used[x]) empty[x]!++;
  }
  const need = Math.ceil(rows.length * GAP_ROW_SHARE);
  const minWidth = lineHeight * GAP_MIN_HEIGHTS;
  const out: number[] = [];
  let start = -1;
  for (let x = 0; x <= empty.length; x++) {
    const open = x < empty.length && empty[x]! >= need;
    if (open && start < 0) start = x;
    if (!open && start >= 0) {
      if (x - start >= minWidth) out.push(from + (start + x) / 2);
      start = -1;
    }
  }
  return out;
}

/**
 * Framed text that can be split into columns by word gaps, with at least half of the rows having
 * text in more than two columns (key-value pairs, single-item-per-row lists): only then is it
 * divided into rows and cells by row.
 */
function alignedRows(lines: readonly OcrBox[], left: number, right: number, lineHeight: number) {
  const gaps = gapColumns(lines, left, right, lineHeight);
  if (!gaps.length) return false;
  const rows = textRows(lines);
  const column = (x: number) => gaps.filter((g) => g < x).length;
  const wide = rows.filter((row) => new Set(row.map((l) => column(centerX(l)))).size >= 2);
  return wide.length >= rows.length / 2;
}

const indexOf = (bounds: readonly Boundary[], v: number) => {
  let i = 0;
  while (i < bounds.length - 2 && v >= bounds[i + 1]!.pos) i++;
  return i;
};

/** A box with only four sides is considered to contain a block of text (single-line input boxes, colored grid cells are still treated as tables) only if it contains at least this many rows of text. */
const FRAME_TEXT_ROWS = 3;
/** At least this many rows are full-width text (wrapped body text). */
const FRAME_WIDE_ROWS = 2;

/** A prose block is counted only if the box contains at least this many rows, and at least this many rows are full-width text (taking up this fraction of the box width). */
const PROSE_MIN_ROWS = 2;
const PROSE_WIDE_SHARE = 2 / 3;
const PROSE_LINE_WIDTH = 0.6;

/** Count of rows where a single row is a very wide OCR box (multiple columns, or key-value pairs split into separate blocks). */
function wideRows(lines: readonly OcrBox[], width: number): number {
  return textRows(lines).filter(
    (row) => row.length === 1 && row[0]!.width >= PROSE_LINE_WIDTH * width,
  ).length;
}

/** Text in the box is prose: the majority of rows are full-width text. */
function isProse(lines: readonly OcrBox[], width: number): boolean {
  const rows = textRows(lines).length;
  return rows >= PROSE_MIN_ROWS && wideRows(lines, width) >= PROSE_WIDE_SHARE * rows;
}

/** A line of text is predominantly numeric (amounts, dates, serial numbers, percentages). */
function isNumber(text: string): boolean {
  const s = text.replace(/\s/g, '');
  return s.length > 0 && (s.match(/\d/g)?.length ?? 0) >= 0.5 * s.length;
}

/** Grid of a table: horizontal lines define rows, vertical lines define columns (or column spacing based on word gaps when intermediate vertical lines are missing), and two cells with insufficient boundary lines are merged. */
function buildGrid(
  table: TableLines,
  lines: readonly OcrBox[],
  tol: number,
  lineHeight: number,
): Grid | null {
  const { hs, vs, box } = table;
  const left = box.x;
  const right = box.x + box.width;
  // Rows.
  let ys: Boundary[] = dedupe(
    hs.map((h) => h.pos),
    tol,
  ).map((pos) => ({ pos, lined: true }));
  if (vs.length) {
    // Extend vertical lines of left and right borders up and down (D-501): intermediate column line
    // extensions often pick up strokes of text outside the table (such as a footer line immediately
    // below a payslip), pulling external text into the frame. When vertical lines lack borders, all
    // vertical lines are considered.
    const sides = vs.filter((v) => v.pos <= left + tol || v.pos >= right - tol);
    const ends = sides.length ? sides : vs;
    const top = Math.min(...ends.map((v) => v.from));
    const bottom = Math.max(...ends.map((v) => v.to));
    if (top < ys[0]!.pos - tol) ys.unshift({ pos: top, lined: false });
    if (bottom > ys.at(-1)!.pos + tol) ys.push({ pos: bottom, lined: false });
  }
  // Columns.
  let xs: Boundary[] = dedupe(
    vs.map((v) => v.pos),
    tol,
  ).map((pos) => ({ pos, lined: true }));
  if (!xs.length || xs[0]!.pos > left + tol) xs.unshift({ pos: left, lined: false });
  if (xs.at(-1)!.pos < right - tol) xs.push({ pos: right, lined: false });
  const inner = vs.filter((v) => v.pos > xs[0]!.pos + tol && v.pos < xs.at(-1)!.pos - tol);
  // Rows not covered by vertical lines (tables with horizontal lines only, or the unvertical-lined section below a header): do not merge sides, split into as many rows as there are text lines in a cell.
  const bandCovered = (a: number, b: number) =>
    inner.some((v) => Math.min(v.to, b) - Math.max(v.from, a) >= 0.5 * (b - a));
  const covered = ys.slice(0, -1).map((y, r) => bandCovered(y.pos, ys[r + 1]!.pos));
  const firstCovered = covered.indexOf(true);
  const lastCovered = covered.lastIndexOf(true);
  // Four-sided frames with no internal column lines and text structured as prose paragraphs
  // (tooltip boxes on Cerfa forms, EU sample 038): treated as a boxed paragraph rather than split
  // into single-line grid cells (where editing one word breaks the whole paragraph), and not split
  // into columns by word gaps.
  const framedProse =
    !inner.length && xs[0]!.lined && xs.at(-1)!.lined && isProse(lines, right - left);
  // Four-sided frames (with no internal lines) containing wrapped body text (at least two rows of
  // full-width text), where text is not aligned into columns row by row (a letter: address,
  // salutation, paragraphs of body text, EU sample 075): this is just a frame, not a table.
  // Exported by splitting into rows as usual, converted to Word without treating as a table, and
  // text is returned to body prose (see framedText). Frames with only short labels (e.g.,
  // "Krankenkasse" frame on sick leaves where fine internal lines were not recognized, EU sample
  // 061) remain unchanged.
  const framedText =
    !framedProse &&
    !inner.length &&
    xs[0]!.lined &&
    xs.at(-1)!.lined &&
    ys.filter((y) => y.lined).length <= 2 &&
    textRows(lines).length >= FRAME_TEXT_ROWS &&
    wideRows(lines, right - left) >= FRAME_WIDE_ROWS &&
    !alignedRows(lines, left, right, lineHeight);
  const isOpen = (r: number) =>
    !framedProse && (firstCovered < 0 || r < firstCovered || r > lastCovered);
  const split: Boundary[] = [ys[0]!];
  const open: boolean[] = [];
  // Rows split by row; whether vertical lines are long enough is evaluated based on the pre-split segment (curved lines or broken lines in short rows might otherwise fall short of half).
  const parentBand: ([number, number] | null)[] = [];
  for (let r = 0; r < ys.length - 1; r++) {
    const a = ys[r]!.pos;
    const b = ys[r + 1]!.pos;
    const inBand = lines.filter((l) => centerY(l) >= a && centerY(l) < b);
    // Upper and lower horizontal lines are not drawn in this column (a large left cell spanning
    // multiple rows: yellow-backed "QUOTA FISSA" on electricity bills, EU sample 057): text in this
    // column belongs to the multi-row spanning cell and is not used for row splitting.
    const spans = (c: number) =>
      [ys[r]!, ys[r + 1]!].some(
        (y) => y.lined && coverage(hs, y.pos, xs[c]!.pos, xs[c + 1]!.pos, tol) < MERGE_COVERAGE,
      );
    const rows = textRows(
      isOpen(r) ? inBand : inBand.filter((l) => !spans(indexOf(xs, centerX(l)))),
    );
    // Position between the upper and lower text rows.
    const between = (i: number) =>
      (Math.max(...rows[i - 1]!.map((l) => l.y + l.height)) +
        Math.min(...rows[i]!.map((l) => l.y))) /
      2;
    let bySplit = false;
    if (isOpen(r)) {
      for (let i = 1; i < rows.length; i++) {
        split.push({ pos: between(i), lined: false });
        open.push(true);
        parentBand.push(null);
      }
    } else if (rows.length >= SPLIT_MIN_ROWS) {
      // Segments covered by vertical lines with no horizontal lines in between (payslips, bill
      // bodies): split into rows if more than half of the text-containing columns have multiple
      // text rows, and at least half of the rows have text in more than two columns (one item per
      // row). Excluded: cases with text rows in only individual columns (wrapped text in a cell),
      // only two rows (two-line table headers), or most rows having text in only a single column
      // (multiline address in a single table cell with other columns empty, D-333).
      const rowsByCol = new Map<number, Set<number>>();
      // Number of rows per column and how many of those rows are numbers (amounts, dates, serial numbers).
      const numbersByCol = new Map<number, number>();
      let wide = 0;
      for (const [i, row] of rows.entries()) {
        const cols = new Set<number>();
        for (const l of row) {
          const c = indexOf(xs, centerX(l));
          cols.add(c);
          if (!rowsByCol.has(c)) rowsByCol.set(c, new Set());
          rowsByCol.get(c)!.add(i);
          if (isNumber(l.text)) numbersByCol.set(c, (numbersByCol.get(c) ?? 0) + 1);
        }
        if (cols.size >= 2) wide++;
      }
      const multi = [...rowsByCol.values()].filter((g) => g.size >= 2).length;
      // Text-containing columns counted by total text length in the segment (including the multi-row spanning cell column, though it is not used for row splitting).
      const used = new Set(inBand.map((l) => indexOf(xs, centerX(l)))).size;
      // Tables with only a single row of framing (just two horizontal lines at top and bottom)
      // always have a column of numbers (amounts, quantities, dates) when acting as
      // single-item-per-row bodies. When multiple cells contain text (instruction steps, bullet
      // points, EU sample 049), cells with coincidentally identical row heights are not
      // single-item-per-row; splitting them would break up the lines inside a single cell.
      const oneBox = ys.filter((y) => y.lined).length <= 2;
      const numbers = [...numbersByCol.entries()].some(
        ([c, n]) => n >= 2 && n >= rowsByCol.get(c)!.size / 2,
      );
      if (multi >= 2 && multi > used / 2 && wide >= rows.length / 2 && (numbers || !oneBox)) {
        for (let i = 1; i < rows.length; i++) {
          split.push({ pos: between(i), lined: false });
          open.push(false);
          parentBand.push([a, b]);
        }
        bySplit = true;
      }
    }
    split.push(ys[r + 1]!);
    open.push(isOpen(r));
    parentBand.push(bySplit ? [a, b] : null);
  }
  ys = split;
  if (!inner.length && !framedProse) {
    const gaps = gapColumns(lines, left, right, lineHeight);
    xs = [xs[0]!, ...gaps.map((pos) => ({ pos, lined: false })), xs.at(-1)!];
  }
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  if (rows < 1 || cols < 1 || rows * cols > MAX_TABLE_CELLS) return null;
  const straddled = (r: number, x: number) =>
    lines.some(
      (l) =>
        centerY(l) >= ys[r]!.pos &&
        centerY(l) < ys[r + 1]!.pos &&
        x > l.x + l.height * 0.5 &&
        x < l.x + l.width - l.height * 0.5,
    );
  // Merging: disjoint-set data structure, one per position.
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Right border (vertical line). Rows not covered by vertical lines are merged only if a line
      // of text spans across this boundary (major table title); otherwise, columns are split based
      // on upper and lower vertical lines.
      if (c + 1 < cols && xs[c + 1]!.lined && (!open[r] || straddled(r, xs[c + 1]!.pos))) {
        const [top, bottom] = parentBand[r] ?? [ys[r]!.pos, ys[r + 1]!.pos];
        const cov = coverage(vs, xs[c + 1]!.pos, top, bottom, tol);
        if (cov < MERGE_COVERAGE) parent[find(r * cols + c)] = find(r * cols + c + 1);
      }
      // Bottom border (horizontal line).
      if (r + 1 < rows && ys[r + 1]!.lined) {
        const cov = coverage(hs, ys[r + 1]!.pos, xs[c]!.pos, xs[c + 1]!.pos, tol);
        if (cov < MERGE_COVERAGE) parent[find(r * cols + c)] = find((r + 1) * cols + c);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < rows * cols; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  const owner = new Int32Array(rows * cols);
  const cells: TableCell[] = [];
  const add = (r0: number, c0: number, r1: number, c1: number) => {
    const index = cells.length;
    cells.push({
      row: r0,
      col: c0,
      rowSpan: r1 - r0 + 1,
      colSpan: c1 - c0 + 1,
      text: '',
      box: {
        x: xs[c0]!.pos,
        y: ys[r0]!.pos,
        width: xs[c1 + 1]!.pos - xs[c0]!.pos,
        height: ys[r1 + 1]!.pos - ys[r0]!.pos,
      },
    });
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) owner[r * cols + c] = index;
  };
  for (const members of [...groups.values()].sort((a, b) => a[0]! - b[0]!)) {
    const rs = members.map((i) => Math.floor(i / cols));
    const cs = members.map((i) => i % cols);
    const r0 = Math.min(...rs);
    const r1 = Math.max(...rs);
    const c0 = Math.min(...cs);
    const c1 = Math.max(...cs);
    // If the merged result is not rectangular: revert and do not merge.
    if ((r1 - r0 + 1) * (c1 - c0 + 1) === members.length) add(r0, c0, r1, c1);
    else
      for (const i of members) add(Math.floor(i / cols), i % cols, Math.floor(i / cols), i % cols);
  }
  const order = cells
    .map((cell, i) => ({ cell, i }))
    .sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col);
  const remap = new Int32Array(cells.length);
  order.forEach(({ i }, k) => (remap[i] = k));
  for (let p = 0; p < owner.length; p++) owner[p] = remap[owner[p]!]!;
  return { xs, ys, owner, cells: order.map((o) => o.cell), ...(framedText ? { framedText } : {}) };
}

/** A form box requires at least this many rows at the top, with each row having text in at most one cell (not a table title). */
const FORM_MIN_ROWS = 4;
/** After removing those rows, the remainder must have at least this many rows with text in two or more cells to be a true table. */
const FORM_BODY_ROWS = 2;

/**
 * Form box and table below merged into a single grid (D-520, F4): multiple top rows where each
 * row has text in at most one cell (label on one line, value on another, gaps between boxes),
 * followed below by a table where each row has multiple cells. The top rows are not table rows
 * (table titles are only one or two rows), so they are removed and their text is arranged as text
 * outside the table; returns null if no such rows exist (or if the remainder doesn't resemble a
 * table). Merged cells cannot be cut across gaps.
 */
function dropLeadingRows(
  grid: Grid,
  lines: readonly OcrBox[],
): { grid: Grid; lines: OcrBox[] } | null {
  const rows = grid.ys.length - 1;
  const cols = grid.xs.length - 1;
  const filled = grid.cells.map(() => false);
  for (const line of lines) for (const { cell } of piecesOf(line, grid)) filled[cell] = true;
  const perRow = new Array<number>(rows).fill(0);
  grid.cells.forEach((c, i) => {
    if (filled[i]) perRow[c.row]!++;
  });
  let cut = 0;
  for (let r = 1; r < rows && perRow[r - 1]! <= 1; r++) {
    if (!grid.cells.some((c) => c.row < r && c.row + c.rowSpan > r)) cut = r;
  }
  if (cut < FORM_MIN_ROWS || rows - cut < 2) return null;
  if (perRow.slice(cut).filter((n) => n >= 2).length < FORM_BODY_ROWS) return null;
  const y = grid.ys[cut]!.pos;
  const kept = lines.filter((l) => centerY(l) >= y);
  const cells = grid.cells.filter((c) => c.row >= cut).map((c) => ({ ...c, row: c.row - cut }));
  // Mapping from position to cell: rows are shifted up, and cell indices follow the new order.
  const index = new Map<TableCell, number>(cells.map((c, i) => [c, i]));
  const old = grid.cells.filter((c) => c.row >= cut);
  const remap = new Map(old.map((c, i) => [grid.cells.indexOf(c), index.get(cells[i]!)!]));
  const owner = new Int32Array((rows - cut) * cols);
  for (let r = cut; r < rows; r++) {
    for (let c = 0; c < cols; c++)
      owner[(r - cut) * cols + c] = remap.get(grid.owner[r * cols + c]!)!;
  }
  return { grid: { xs: grid.xs, ys: grid.ys.slice(cut), owner, cells }, lines: kept };
}

/**
 * Tables with horizontal lines only: bottom few rows each contain only a single line of text
 * spanning all columns ("Vielen Dank / Auf Wiedersehen" centered below the table on a receipt,
 * followed by another separator line, EU sample 003): footer text rather than table rows; remove
 * these rows and arrange text as outside the table. Applied only if at least two rows remain
 * after removal, with at least FORM_BODY_ROWS of them containing text in two or more cells;
 * otherwise returns null.
 */
export function dropTrailingRows(
  grid: Grid,
  lines: readonly OcrBox[],
): { grid: Grid; lines: OcrBox[] } | null {
  const rows = grid.ys.length - 1;
  const cols = grid.xs.length - 1;
  if (cols < 2 || grid.xs.slice(1, -1).some((x) => x.lined)) return null;
  const rowLines = (r: number) => lines.filter((l) => indexOf(grid.ys, centerY(l)) === r);
  // This row contains only a single line of text spanning across columns split by gap.
  const spanning = (r: number) => {
    const own = rowLines(r);
    return (
      own.length === 1 &&
      grid.xs
        .slice(1, -1)
        .some(
          (x) =>
            x.pos > own[0]!.x + own[0]!.height &&
            x.pos < own[0]!.x + own[0]!.width - own[0]!.height,
        )
    );
  };
  let cut = rows;
  let closing = false;
  while (cut > 0 && (spanning(cut - 1) || !rowLines(cut - 1).length)) {
    closing ||= spanning(cut - 1);
    cut--;
  }
  if (!closing || cut < 2 || !rowLines(cut - 1).length) return null;
  const columns = (r: number) => new Set(rowLines(r).map((l) => indexOf(grid.xs, centerX(l)))).size;
  if (
    Array.from({ length: cut }, (_, r) => columns(r)).filter((n) => n >= 2).length < FORM_BODY_ROWS
  )
    return null;
  if (grid.cells.some((c) => c.row < cut && c.row + c.rowSpan > cut)) return null;
  const y = grid.ys[cut]!.pos;
  const cells = grid.cells.filter((c) => c.row < cut);
  const keep = new Map(cells.map((c, i) => [grid.cells.indexOf(c), i]));
  const owner = new Int32Array(cut * cols);
  for (let p = 0; p < owner.length; p++) owner[p] = keep.get(grid.owner[p]!)!;
  return {
    grid: { xs: grid.xs, ys: grid.ys.slice(0, cut + 1), owner, cells },
    lines: lines.filter((l) => centerY(l) < y),
  };
}

/**
 * This line is cut across the middle of a word by a lined column separator (D-502): the two sides
 * of the column line are not the same cell, and characters on both sides of the cut are adjacent
 * (not a space, and word spacing is not wider than normal). PP-OCR misrecognizing adjacent cells
 * as a single line is ignored when the column line falls in the gap between text segments. Not
 * detectable and ignored when individual character positions are absent.
 */
function chopsWord(line: OcrBox, grid: Grid): boolean {
  const chars = line.chars;
  if (!chars || chars.length < 2) return false;
  const cols = grid.xs.length - 1;
  const row = indexOf(grid.ys, centerY(line));
  const margin = line.height * 0.5;
  const at = chars.map((ch) => line.x + ch.at * line.width);
  const steps = at.slice(1).map((x, i) => x - at[i]!);
  const typical = [...steps].sort((a, b) => a - b)[steps.length >> 1]!;
  for (let c = 1; c < cols; c++) {
    if (!grid.xs[c]!.lined) continue;
    const x = grid.xs[c]!.pos;
    if (x <= line.x + margin || x >= line.x + line.width - margin) continue;
    if (grid.owner[row * cols + c - 1] === grid.owner[row * cols + c]) continue;
    const right = at.findIndex((p) => p >= x);
    if (right <= 0) continue;
    const gap = at[right]! - at[right - 1]!;
    const blank = !chars[right]!.text.trim() || !chars[right - 1]!.text.trim();
    if (!blank && gap < CHOP_GAP * typical) return true;
  }
  return false;
}

/**
 * Place a line of text into cells: when text spans across a vertical line (PP-OCR recognized
 * adjacent cells as a single line) and character positions are available, cut it at the vertical
 * line. Returns the resulting pieces, each placed into a cell based on its center point.
 */
function piecesOf(line: OcrBox, grid: Grid): { cell: number; piece: OcrBox }[] {
  const cols = grid.xs.length - 1;
  const row = indexOf(grid.ys, centerY(line));
  const cellAt = (c: number) => grid.owner[row * cols + c]!;
  const margin = line.height * 0.5;
  const cuts: number[] = [];
  if (line.chars?.length) {
    for (let c = 1; c < cols; c++) {
      // Cut only at vertical lines; columns separated by text gaps are not cut (gaps are already between words).
      if (!grid.xs[c]!.lined) continue;
      const x = grid.xs[c]!.pos;
      if (x > line.x + margin && x < line.x + line.width - margin && cellAt(c - 1) !== cellAt(c))
        cuts.push(x);
    }
  }
  const whole = () => [{ cell: cellAt(indexOf(grid.xs, centerX(line))), piece: line }];
  if (!cuts.length) return whole();
  const chars = line.chars!;
  const charWidth = line.width / chars.length;
  const parts: { text: string; first: number; last: number }[] = [];
  for (const ch of chars) {
    const x = line.x + ch.at * line.width;
    const k = cuts.filter((cut) => x >= cut).length;
    const part = (parts[k] ??= { text: '', first: x, last: x });
    part.text += ch.text;
    part.last = x;
  }
  const out: { cell: number; piece: OcrBox }[] = [];
  for (const part of parts) {
    if (!part || !part.text.trim()) continue;
    const x = Math.max(line.x, part.first - charWidth / 2);
    const piece: OcrBox = {
      text: part.text.trim(),
      x,
      y: line.y,
      width: Math.min(line.x + line.width, part.last + charWidth / 2) - x,
      height: line.height,
    };
    out.push({ cell: cellAt(indexOf(grid.xs, centerX(piece))), piece });
  }
  return out.length ? out : whole();
}

/**
 * Remove horizontal "lines" falling inside text lines: bold or flattened characters connected in
 * a row resemble a thick line during row scanning (item names on payslips). Real lines appear
 * above and the below text, never in the middle of a text line. Same for vertical lines (D-463):
 * underlined bold titles have vertical strokes connected to the underline, resembling a short
 * vertical line sequence during column scanning, intersecting with characters' top horizontal
 * strokes and underlines to form a "table" (one or two letters per cell). Vertical lines fully
 * enclosed within a text line box (extending at most 20% of line height outside the box) are
 * character strokes; true vertical lines are cell borders and are taller than characters inside
 * the cell.
 */
function dropTextStrokes(page: PageLines, lines: readonly OcrBox[]): PageLines {
  const inText = (h: RuleLine) =>
    lines.some((l) => {
      const inset = l.height * STROKE_INSIDE;
      if (h.pos <= l.y + inset || h.pos >= l.y + l.height - inset) return false;
      const overlap = Math.min(h.to, l.x + l.width) - Math.max(h.from, l.x);
      return overlap >= STROKE_SHARE * (h.to - h.from);
    });
  const inTextV = (v: RuleLine) =>
    lines.some((l) => {
      const out = l.height * STROKE_INSIDE;
      return (
        v.pos > l.x && v.pos < l.x + l.width && v.from >= l.y - out && v.to <= l.y + l.height + out
      );
    });
  const vertical = page.vertical.filter((v) => !inTextV(v));
  // Horizontal lines spanning at least 30% of page width and connected to at least 3 vertical lines
  // are table lines (left, right, and at least one middle column line), even if pressing into a
  // text line box (D-501: curved footer line in photos with a high OCR box covering the table
  // bottom). Character strokes and paper creases are not this long; short vertical lines formed by
  // connected vertical strokes of two text lines often touch bold text horizontal strokes.
  const tol = Math.max(4, Math.max(page.width, page.height) * STROKE_TOUCH_SHARE);
  const joined = (h: RuleLine) =>
    h.to - h.from >= STROKE_RULE_SHARE * page.width &&
    vertical.filter(
      (v) =>
        v.pos >= h.from - tol &&
        v.pos <= h.to + tol &&
        h.pos >= v.from - tol &&
        h.pos <= v.to + tol,
    ).length >= STROKE_MIN_JOINED;
  return {
    ...page,
    horizontal: page.horizontal.filter((h) => !inText(h) || joined(h)),
    vertical,
  };
}

/** Pure numbers representing amounts (may include signs, currency symbols, thousands separators with spaces or commas, percentages, and currency characters like yuan): right-aligned when alignment cannot be determined. */
const AMOUNT = /^[-−+(]?\s?[$€£¥￥]?\s?\d[\d\s.,'’]*%?\s?[$€£¥￥元]?\)?$/;

/**
 * Horizontal alignment: evaluated per row based on whitespace on left and right relative to cell
 * boundaries (left and right are cell margins); determined by how the majority of rows are
 * positioned; rows where text fills the cell are ignored. When undetermined, amounts are
 * right-aligned, others unassigned (Excel "General": left-aligned for text).
 */
function alignOf(
  pieces: readonly OcrBox[],
  left: number,
  right: number,
  lineHeight: number,
  text: string,
): CellAlign | undefined {
  const rows = textRows(pieces);
  // Left-aligned text block formed by multiple left-aligned rows (boxed prose has equal whitespace
  // on both sides, making each row look centered, EU sample 038). Only rows containing text are
  // considered: columns of equally wide amounts are also left-aligned, but they are right-aligned
  // semantically.
  const lefts = rows.map((row) => Math.min(...row.map((p) => p.x)));
  if (
    rows.length > PROSE_MIN_ROWS &&
    rows.every((row) => row.some((p) => /\p{L}{3}/u.test(p.text))) &&
    Math.max(...lefts) - Math.min(...lefts) <= 0.5 * lineHeight
  )
    return 'left';
  const votes: Record<CellAlign, number> = { left: 0, center: 0, right: 0 };
  for (const row of rows) {
    const l = Math.min(...row.map((p) => p.x)) - left;
    const r = right - Math.max(...row.map((p) => p.x + p.width));
    const slack = l + r;
    if (slack < ALIGN_MIN_SLACK * lineHeight) continue;
    const d = (l - r) / slack;
    votes[d < -ALIGN_SIDE_SHARE ? 'left' : d > ALIGN_SIDE_SHARE ? 'right' : 'center']++;
  }
  const best = (['left', 'center', 'right'] as const).reduce((a, b) =>
    votes[b] > votes[a] ? b : a,
  );
  if (votes[best] > 0) return best;
  return AMOUNT.test(text.trim()) ? 'right' : undefined;
}

/**
 * Page-shared column lines (D-272): column boundaries of all tables arranged from left to right,
 * merging those differing by less than tol (averaging them); boundaries of the same table are not
 * merged together (to avoid losing a column). Returns shared column line positions, and mapping
 * of each table's boundaries to the corresponding shared column line index.
 */
export function sharedColumns(
  tables: readonly (readonly number[])[],
  tol: number,
): { pos: number[]; maps: number[][] } {
  const items = tables
    .flatMap((xs, t) => xs.map((x, i) => ({ x, t, i })))
    .sort((a, b) => a.x - b.x);
  const groups: { sum: number; members: { t: number; i: number }[] }[] = [];
  for (const item of items) {
    const g = groups.at(-1);
    if (g && item.x - g.sum / g.members.length <= tol && !g.members.some((m) => m.t === item.t)) {
      g.sum += item.x;
      g.members.push(item);
    } else groups.push({ sum: item.x, members: [item] });
  }
  const maps = tables.map((xs) => xs.map(() => 0));
  groups.forEach((g, k) => {
    for (const m of g.members) maps[m.t]![m.i] = k;
  });
  return { pos: groups.map((g) => g.sum / g.members.length), maps };
}

/** Cache for lines found on the same image with the same parameters (converting to Word processes the same page twice for tables with overlapping/non-overlapping structures). */
const linesCache = new WeakMap<RgbaImage, Map<string, PageLines>>();
export function cachedLines(
  image: RgbaImage,
  options: { skew?: number; light?: boolean },
): PageLines {
  const key = JSON.stringify(options);
  let byOptions = linesCache.get(image);
  if (!byOptions) linesCache.set(image, (byOptions = new Map()));
  let found = byOptions.get(key);
  if (!found) byOptions.set(key, (found = findLines(image, options)));
  return found;
}

/** Empty grid must have at least this many rows and columns before searching for a header above it. */
const HEADER_GRID_MIN_ROWS = 3;
const HEADER_GRID_MIN_COLS = 2;
/** Bottom edge of the header text row is no more than this many line heights away from the top edge of the grid. */
const HEADER_GAP_LINES = 1.5;

/**
 * Grids filled with horizontal/vertical lines but lacking text (merchandise columns waiting to be
 * filled): the single-column text row immediately above is the header. When found, add a
 * horizontal line above the header, extend vertical lines upward to meet it, making the header
 * the first row of the grid; header text must fall within at least half of the columns (at least
 * two columns), with each text segment contained within a single column (not spanning column
 * lines).
 */
function withHeaderAbove(
  table: TableLines,
  lines: readonly OcrBox[],
  tol: number,
  lineHeight: number,
): { table: TableLines; lines: OcrBox[] } | null {
  const { box, hs, vs } = table;
  const top = box.y;
  const bottom = box.y + box.height;
  const cols = vs.length - 1;
  if (hs.length - 1 < HEADER_GRID_MIN_ROWS || cols < HEADER_GRID_MIN_COLS) return null;
  // Every vertical line is drawn fully from top to bottom (indicating a regular grid rather than isolated box lines).
  if (vs.some((v) => v.from > top + tol || v.to < bottom - tol)) return null;
  const near = lines.filter(
    (l) =>
      centerX(l) > box.x &&
      centerX(l) < box.x + box.width &&
      l.y + l.height <= top + tol &&
      l.y + l.height >= top - HEADER_GAP_LINES * lineHeight,
  );
  if (!near.length) return null;
  // Take only the bottom-most row (center differs from the bottom-most segment by less than half a line height).
  const lowest = Math.max(...near.map(centerY));
  const row = near.filter((l) => lowest - centerY(l) <= 0.5 * lineHeight);
  const inner = vs.slice(1, -1).map((v) => v.pos);
  const pad = 0.25 * lineHeight;
  if (row.some((l) => inner.some((x) => x > l.x + pad && x < l.x + l.width - pad))) return null;
  const hit = new Set(
    row.map((l) => vs.findIndex((v, i) => i < cols && centerX(l) < vs[i + 1]!.pos)),
  );
  if (hit.size < HEADER_GRID_MIN_COLS || hit.size * 2 < cols) return null;
  const pos = Math.min(...row.map((l) => l.y)) - 0.3 * lineHeight;
  const ruleAbove: RuleLine = {
    pos,
    from: box.x,
    to: box.x + box.width,
    thickness: 1,
    spans: [[box.x, box.x + box.width]],
  };
  return {
    table: {
      hs: [ruleAbove, ...hs],
      vs: vs.map((v) => ({ ...v, from: pos, spans: [[pos, v.to] as [number, number]] })),
      box: { ...box, y: pos, height: bottom - pos },
    },
    lines: row,
  };
}

/** TablePage for a single page: find lines, group tables, fill text, segment non-table text. */
export function buildTablePage(input: PageInput, options: BuildOptions = {}): TablePage {
  const join = options.joinLines ?? defaultJoin;
  const { image } = input;
  const page = cachedLines(image, {
    ...(input.skew !== undefined ? { skew: input.skew } : {}),
    ...(options.lightRules ? { light: true } : {}),
  });
  const t = Math.tan((page.skew * Math.PI) / 180);
  const tol = Math.max(4, Math.max(image.width, image.height) * 0.008);
  const arrange = options.arrange === true;
  // OCR boxes converted to deskewed coordinates (only centers moved, dimensions unchanged).
  let source = input.lines.filter((l) => l.text.trim());
  // Image region (Excel conversion, D-520): text inside is part of the image, excluded from table grouping and text layout.
  const found =
    arrange && input.regions?.length
      ? layoutRegions(input.regions, source, image, median(source.map((l) => l.height)) || 20)
      : { figures: [], text: [] };
  const { figures } = found;
  if (figures.length) {
    source = source.filter((l) => !figures.some((f) => lineShareIn(l, f) >= 0.5));
  }
  const flat = source.map((l): OcrBox => {
    const cx = centerX(l);
    const cy = centerY(l);
    return { ...l, x: cx + cy * t - l.width / 2, y: cy - cx * t - l.height / 2 };
  });
  const sourceOf = new Map(flat.map((l, i) => [l, source[i]!]));
  // Deskewed box -> surrounding box in the original image.
  const back = (b: Box): Box => {
    if (t === 0) return b;
    const corners = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ].map(([x, y]) => [x! - y! * t, y! + x! * t] as const);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  // Box in original image -> deskewed position (only center moved, same as OCR boxes).
  const flatBox = (b: Box): Box => {
    const cx = centerX(b);
    const cy = centerY(b);
    return {
      x: cx + cy * t - b.width / 2,
      y: cy - cx * t - b.height / 2,
      width: b.width,
      height: b.height,
    };
  };
  const lineHeight = median(flat.map((l) => l.height)) || 20;
  // Line height used for estimating font size (D-521): for skewed pages, OCR boxes of long lines exceed character height by width × slope, which is deducted.
  const tilt = Math.abs(t);
  const sizeHeight = (l: Box) => Math.max(0.6 * l.height, l.height - tilt * l.width);
  const baseHeight = median(flat.map(sizeHeight)) || lineHeight;
  const bodySize = bodySizeOf(baseHeight, image.width);
  // Character stroke thickness (bold, D-521): measured based on positions in the original image; used only during Excel conversion.
  const strokes = new Map<OcrBox, number>();
  const strokeOf = (l: OcrBox) => {
    if (!strokes.has(l)) strokes.set(l, strokeRatio(image, sourceOf.get(l) ?? back(l)));
    return strokes.get(l)!;
  };
  const pageStroke = arrange ? median(flat.map(strokeOf).filter((v) => v > 0)) : 0;
  const placed = new Set<OcrBox>();
  const tables: {
    block: TableBlock;
    flatBox: Box;
    xs: number[];
    lines: OcrBox[];
    chopped: number;
    /** Each row and column line is drawn explicitly (rather than inferred from text gaps). */
    ruled: boolean;
    framedText?: boolean;
  }[] = [];
  const foundTables = findTables(dropTextStrokes(page, flat), {
    ...(options.splitStacked ? { splitStacked: true } : {}),
    text: flat,
  });
  const within = (l: Box, b: Box) =>
    centerX(l) >= b.x &&
    centerX(l) <= b.x + b.width &&
    centerY(l) >= b.y &&
    centerY(l) <= b.y + b.height;
  for (const found of foundTables) {
    let table = found;
    let { box } = table;
    // "Tables" predominantly within image regions are lines within the image (diagrams, chart grids).
    if (
      figures.some((f) => {
        const ix = Math.min(box.x + box.width, f.x + f.width) - Math.max(box.x, f.x);
        const iy = Math.min(box.y + box.height, f.y + f.height) - Math.max(box.y, f.y);
        return ix > 0 && iy > 0 && ix * iy > 0.5 * box.width * box.height;
      })
    )
      continue;
    let members = flat.filter(
      (l) =>
        !placed.has(l) &&
        centerX(l) >= box.x - tol &&
        centerX(l) <= box.x + box.width + tol &&
        centerY(l) >= box.y - tol &&
        centerY(l) <= box.y + box.height + tol &&
        // An adjacent table (separate top/bottom or left/right tables sharing an edge, EU sample 090) belongs to that table.
        (within(l, box) || !foundTables.some((t) => t !== found && within(l, t.box))),
    );
    // The header of a blank table is written above the grid (item columns in the invoice template, EU sample 001): the header row is included in the table.
    if (!members.length && options.headerAbove) {
      const headed = withHeaderAbove(
        table,
        flat.filter((l) => !placed.has(l)),
        tol,
        lineHeight,
      );
      if (headed) {
        table = headed.table;
        box = table.box;
        members = headed.lines;
      }
    }
    // A recognition line lying on a horizontal line in a table and consisting only of characters
    // like '=', '_', or '-' represents the line itself (dashed or double line, EU sample 020):
    // considered part of the table (not formatted as body text), but does not occupy a row or get
    // written into a cell.
    const ruleText = new Set(
      members.filter(
        (l) =>
          isRuleText(l.text) &&
          table.hs.some(
            (h) =>
              Math.abs(h.pos - centerY(l)) <= Math.max(4, 0.6 * l.height) &&
              h.from <= l.x + l.width &&
              h.to >= l.x,
          ),
      ),
    );
    // Items without text inside are not considered tables (e.g., several aligned fill-in lines in a form).
    if (members.length === ruleText.size) continue;
    // Only one row, with no text inside the cells (the background of a fill-in blank area has four edges looking like lines, and nearby text falls within the tolerance, EU sample 082): not a table.
    if (table.hs.length <= 2 && members.every((l) => ruleText.has(l) || !within(l, box))) continue;
    const built = buildGrid(
      table,
      members.filter((l) => !ruleText.has(l)),
      tol,
      lineHeight,
    );
    if (!built) continue;
    let grid: Grid = built;
    const { framedText } = built;
    // Text whose center is outside the outermost horizontal line and which spans across column
    // lines is not part of the table (D-501: a curved page footer line in a photo overlapping the
    // table bottom border; including it in the table would split it apart at the column lines).
    // Text falling within a single column remains in the table as usual (e.g., total row below the
    // table bottom border).
    const top = grid.ys[0]!;
    const bottom = grid.ys.at(-1)!;
    let inside = members.filter((l) => {
      const out = (top.lined && centerY(l) < top.pos) || (bottom.lined && centerY(l) > bottom.pos);
      const across = grid.xs.some(
        (x, c) =>
          c > 0 &&
          c < grid.xs.length - 1 &&
          x.lined &&
          x.pos > l.x + l.height * 0.5 &&
          x.pos < l.x + l.width - l.height * 0.5,
      );
      // Text entirely above the top horizontal line (notes immediately above the table header stripe) is not part of the table.
      const above = top.lined && l.y + l.height <= top.pos;
      return !(out && across) && !above;
    });
    if (!inside.length) continue;
    // A form box connected across multiple rows (D-520): the top rows are not table rows, and the text is left for non-table text.
    const trimmed = arrange ? dropLeadingRows(grid, inside) : null;
    if (trimmed) {
      grid = trimmed.grid;
      inside = trimmed.lines;
      if (!inside.length) continue;
    }
    const tail = dropTrailingRows(grid, inside);
    if (tail) {
      grid = tail.grid;
      inside = tail.lines;
    }
    const texts = grid.cells.map(() => [] as OcrBox[]);
    for (const line of inside) {
      if (ruleText.has(line)) continue;
      for (const { cell, piece } of piecesOf(line, grid)) texts[cell]!.push(piece);
    }
    const chopped = inside.filter((l) => !ruleText.has(l) && chopsWord(l, grid)).length;
    // Tables with only horizontal lines: at least two rows must have text, and at least two columns must be separated by text gaps to be considered a table (body text between multiple separator lines cannot be separated into columns).
    const rowsWithText = new Set(grid.cells.filter((_, i) => texts[i]!.length).map((c) => c.row));
    if (!table.vs.length && (rowsWithText.size < 2 || grid.xs.length < 3)) continue;
    // Font size of text inside a table (pt): if similar to body text, do not write separately.
    const tableSize = arrange
      ? tableSizeOf(median(inside.map(sizeHeight)), image.width, bodySize)
      : bodySize;
    // Bold style is determined per row: inspecting strokes cell by cell often misidentifies short
    // numbers as bold or misses a cell in the header; if more than half of the cells with text in a
    // row look bold, the whole row is bold, otherwise the whole row is not bold (D-521).
    const thickCell = grid.cells.map(
      (_, i) =>
        arrange &&
        texts[i]!.length > 0 &&
        pageStroke > 0 &&
        median(texts[i]!.map(strokeOf)) > BOLD_RATIO * pageStroke,
    );
    const boldRows = new Set<number>();
    for (const row of new Set(grid.cells.map((c) => c.row))) {
      const filled = grid.cells.flatMap((c, i) => (c.row === row && texts[i]!.length ? [i] : []));
      if (filled.filter((i) => thickCell[i]).length * 2 > filled.length) boldRows.add(row);
    }
    const cells = grid.cells.map((cell, i) => {
      const text = texts[i]!.length ? join(texts[i]!).trim() : '';
      const flatCell = cell.box!;
      const align = text
        ? alignOf(texts[i]!, flatCell.x, flatCell.x + flatCell.width, lineHeight, text)
        : undefined;
      const bold = text !== '' && boldRows.has(cell.row);
      return {
        ...cell,
        text,
        ...(align ? { align } : {}),
        ...(arrange && tableSize !== bodySize ? { size: tableSize } : {}),
        ...(bold ? { bold: true } : {}),
        box: back(flatCell),
      };
    });
    // Form underlines, large grids connected by boxes, and grids where column lines cut text in the middle of a word (D-502): not treated as a table, and text inside is arranged into text lines by position (F4).
    if (
      arrange &&
      (isRuleGrid(
        { kind: 'table', rows: grid.ys.length - 1, col: 0, cols: grid.xs.length - 1, cells, box },
        inside.length,
      ) ||
        (chopped >= CHOP_MIN && chopped >= CHOP_SHARE * inside.length))
    )
      continue;
    for (const line of inside) placed.add(line);
    const flatBox: Box = {
      x: grid.xs[0]!.pos,
      y: grid.ys[0]!.pos,
      width: grid.xs.at(-1)!.pos - grid.xs[0]!.pos,
      height: grid.ys.at(-1)!.pos - grid.ys[0]!.pos,
    };
    tables.push({
      flatBox,
      xs: grid.xs.map((x) => x.pos),
      lines: inside.map((l) => sourceOf.get(l)!),
      chopped,
      // The two outer vertical lines can be omitted ('open' tables with only horizontal lines and
      // internal column lines), and when the header is written above the first horizontal line,
      // there is no top line either (EU sample 031): if internal column lines and horizontal lines
      // below the first one are drawn, it is considered fully ruled.
      ruled:
        grid.xs.length > 2 &&
        grid.xs.slice(1, -1).every((x) => x.lined) &&
        grid.ys.slice(1).every((y) => y.lined),
      ...(framedText ? { framedText } : {}),
      block: {
        kind: 'table',
        rows: grid.ys.length - 1,
        col: 0,
        cols: grid.xs.length - 1,
        cells,
        box: back(flatBox),
      },
    });
  }
  // Tables without lines (D-506): tables where lines could not be found (very faint thin lines,
  // columns aligned only by whitespace) are recognized using remaining rows aligned by column,
  // flattening by local slope before splitting rows, similar to Word conversion.
  if (options.textTables !== false) {
    const rest = flat.filter((l) => !placed.has(l));
    const leveled = levelLines(rest, lineHeight, image.width / 2);
    const flatOf = new Map(leveled.map((l, k) => [l, rest[k]!]));
    const toFlat = (l: OcrBox) => flatOf.get(l) ?? l;
    for (const found of findTextTables(leveled, lineHeight, toFlat)) {
      const members = found.lines.map(toFlat);
      for (const line of members) placed.add(line);
      const textSize = tableSizeOf(median(members.map(sizeHeight)), image.width, bodySize);
      let x = found.box.x;
      const xs = [x, ...found.colWidths.map((w) => (x += w))];
      // Shared columns across the entire page (D-272): column lines of borderless tables can be
      // placed anywhere in the whitespace between two columns, and the outermost two can be shifted
      // outward (up to 3 row heights, same as the upper limit for column separation in D-471).
      // Align with other table column lines if present; otherwise, adjacent column lines from
      // different tables create an extra narrow column on the page, splitting cells in half (totals
      // below an invoice table).
      const others = tables.flatMap((tb) => tb.xs);
      const { bands } = found;
      const reach = SNAP_REACH * lineHeight;
      xs.forEach((at, e) => {
        const lo = e === 0 ? at - reach : bands[e - 1]!.right;
        const hi = e === bands.length ? at + reach : bands[e]!.x;
        const near = others.filter((o) => o >= lo && o <= hi);
        if (near.length) {
          xs[e] = near.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a));
        }
      });
      tables.push({
        flatBox: found.box,
        xs,
        lines: members.map((l) => sourceOf.get(l)!),
        chopped: 0,
        ruled: false,
        block: {
          ...found.table,
          cells: found.table.cells.map((c) => ({
            ...(c.box ? { ...c, box: back(c.box) } : c),
            ...(arrange && textSize !== bodySize ? { size: textSize } : {}),
          })),
          box: back(found.box),
        },
      });
    }
  }
  // Excel conversion: arrangement of text and images outside tables (D-520–D-522). Items with
  // horizontal boundaries (columned text, images) also participate in page-wide shared columns:
  // boundaries between columns and left/right edges of images serve as column lines; when no table
  // is present, the left and right edges of all contents are added so the page has a width.
  const plan = arrange
    ? planRest({
        lines: flat.filter((l) => !placed.has(l)),
        figures: figures.map(flatBox),
        regions: found.text,
        tables: tables.map((tb) => tb.flatBox),
        lineHeight,
        sizeHeight,
        baseHeight,
        bodySize,
        join,
        strokeOf,
        pageStroke,
      })
    : null;
  const ranged = (plan?.groups.flatMap((g) => g.drafts) ?? []).filter((d) => d.range);
  const extra = ranged.map((d) => [...d.range!]);
  if (!tables.length && ranged.length) {
    const all = (plan?.groups ?? []).flatMap((g) => g.drafts);
    // Do not add a side if it is less than two row heights away from an existing column line: a title extending slightly outside a column boundary does not generate a narrow column (text spans across and fits anyway).
    const edges = extra.flat();
    const far = (x: number) => edges.every((e) => Math.abs(e - x) >= 2 * lineHeight);
    extra.push(
      [
        Math.min(...all.map((d) => d.box.x)),
        Math.max(...all.map((d) => d.box.x + d.box.width)),
      ].filter(far),
    );
  }
  // Page-wide shared columns: replace each table cell's position with its position on the shared columns, and its colSpan equals how many shared column lines it spans across.
  const shared = sharedColumns(
    [...tables.map((tb) => tb.xs), ...extra],
    Math.max(tol, Math.max(image.width, image.height) * SHARED_COLUMN_SHARE),
  );
  tables.forEach((tb, k) => {
    const map = shared.maps[k]!;
    const first = map[0]!;
    tb.block.col = first;
    tb.block.cols = map.at(-1)! - first;
    tb.block.cells = tb.block.cells.map((cell) => ({
      ...cell,
      col: map[cell.col]! - first,
      colSpan: map[cell.col + cell.colSpan]! - map[cell.col]!,
    }));
  });
  for (const tb of tables)
    options.onTable?.(tb.block, tb.lines, {
      chopped: tb.chopped,
      ruled: tb.ruled,
      ...(tb.framedText ? { framedText: true } : {}),
    });
  const colWidths =
    tables.length || ranged.length
      ? shared.pos.slice(1).map((x, c) => Math.round(x - shared.pos[c]!))
      : Array.from({ length: TEXT_ONLY_COLS }, () => Math.round(image.width / TEXT_ONLY_COLS));
  if (plan) {
    // Which columns each block occupies: the positions of its left and right boundaries within the shared columns.
    const spans = new Map(
      ranged.map((d, k) => {
        const map = shared.maps[tables.length + k]!;
        return [d, { col: map[0]!, cols: map[1]! - map[0]! }] as const;
      }),
    );
    // When there are no tables, page-wide left and right bounds cannot be determined, only existing with columns or images (centered titles).
    const aligned = tables.length > 0 || ranged.length > 0;
    const entries: { y: number; blocks: Block[] }[] = [
      ...plan.groups.map((g) => ({
        y: g.y,
        blocks: g.drafts.map((d): Block => {
          if (d.kind === 'table') {
            const block = tables[d.index]!.block;
            if (d.band !== undefined) block.band = d.band;
            return block;
          }
          const span = spans.get(d);
          const at = span ? { col: span.col, cols: span.cols } : {};
          const band = d.band !== undefined ? { band: d.band } : {};
          if (d.kind === 'image') {
            return {
              kind: 'image',
              ...at,
              ...band,
              col: span!.col,
              cols: span!.cols,
              box: back(d.box),
            };
          }
          const [left, right] = d.range ?? [shared.pos[0]!, shared.pos.at(-1)!];
          const align = aligned ? alignOf(d.lines, left, right, lineHeight, d.text) : undefined;
          return {
            kind: 'text',
            text: d.text,
            ...(align ? { align } : {}),
            ...at,
            ...band,
            ...(d.size !== undefined ? { size: d.size } : {}),
            ...(d.bold ? { bold: true } : {}),
            box: back(d.box),
          };
        }),
      })),
    ];
    return {
      name: input.name,
      source: input.source,
      width: image.width,
      height: image.height,
      lineHeight: Math.round(lineHeight),
      colWidths,
      bodySize,
      blocks: entries.sort((a, b) => a.y - b.y).flatMap((e) => e.blocks),
    };
  }
  // Non-table text: ordered top-to-bottom by row, split into paragraphs where spacing exceeds 1.2x row height or a table lies in between.
  const rest = textRows(flat.filter((l) => !placed.has(l)));
  const paragraphs: OcrBox[][] = [];
  let prevBottom = -Infinity;
  for (const row of rest) {
    const top = Math.min(...row.map((l) => l.y));
    const bottom = Math.max(...row.map((l) => l.y + l.height));
    const tableBetween = tables.some(
      (tb) => tb.flatBox.y >= prevBottom - tol && tb.flatBox.y + tb.flatBox.height <= top + tol,
    );
    if (paragraphs.length && top - prevBottom <= PARAGRAPH_GAP * lineHeight && !tableBetween)
      paragraphs.at(-1)!.push(...row);
    else paragraphs.push([...row]);
    prevBottom = bottom;
  }
  const blocks: { y: number; block: Block }[] = [
    ...tables.map((tb) => ({ y: tb.flatBox.y, block: tb.block as Block })),
    ...paragraphs.map((lines) => {
      const x = Math.min(...lines.map((l) => l.x));
      const y = Math.min(...lines.map((l) => l.y));
      const box = {
        x,
        y,
        width: Math.max(...lines.map((l) => l.x + l.width)) - x,
        height: Math.max(...lines.map((l) => l.y + l.height)) - y,
      };
      const text = join(lines).trim();
      // Non-table text alignment is determined by the left and right bounds of page-wide shared columns (centered titles); omitted if no tables are present and bounds cannot be determined.
      const align = tables.length
        ? alignOf(lines, shared.pos[0]!, shared.pos.at(-1)!, lineHeight, text)
        : undefined;
      return {
        y,
        block: { kind: 'text' as const, text, ...(align ? { align } : {}), box: back(box) },
      };
    }),
  ];
  return {
    name: input.name,
    source: input.source,
    width: image.width,
    height: image.height,
    lineHeight: Math.round(lineHeight),
    colWidths,
    blocks: blocks
      .filter((b) => b.block.kind !== 'text' || b.block.text)
      .sort((a, b) => a.y - b.y)
      .map((b) => b.block),
  };
}

/** A page for Excel conversion (D-520–D-522): same as buildTablePage, with image regions, columned text, and font sizes added (see BuildOptions.arrange). */
export const buildSheetPage = (input: PageInput, options: BuildOptions = {}): TablePage =>
  buildTablePage(input, { ...options, arrange: true });

import type { Box, OcrBox, RgbaImage, TableBlock, TableCell } from './types';

// General layout correction for Word conversion (D-471, founder 2026-11-06: receipt "conversion is
// very poor", done as suggested, "do not make special receipt rules"):
// 1. Whole-page skew: when photos are crooked or paper is curved, text on the right of the same
// line is higher (or lower) than the left; splitting lines horizontally will split text on the
// right into the previous row. Estimate the whole-page slope first, and split lines along the
// slope.
// 2. Borderless tables: multiple rows aligned to the same columns (a text segment on the left,
// multiple number columns on the right), arranged into a borderless table by columns, avoiding
// merging multiple columns into a single sentence. At least three columns and three rows;
// two-column "label: value" pairs remain as before (D-332).
// 3. Barcodes: dense vertical bars without text inside are clipped as images rather than treated as
// text.

const median = (values: readonly number[]) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const unionBox = (boxes: readonly Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
};

// ---- 1. Skew ----

/** Search range (approx. +/-5 degrees) and step size for slope. */
const MAX_SLOPE = 0.09;
const SLOPE_STEP = 0.0025;

/**
 * Whole-page slope (change in y per 1 pixel rightward): test a series of slopes to see which
 * aligns the maximum number of separated left/right rows to the same height. Returns 0 when there
 * are too few rows to determine.
 */
export function pageSlope(lines: readonly OcrBox[], lineHeight: number): number {
  return slopeFit(lines, lineHeight).slope;
}

/** Slope and the number of pairs of separated left/right rows aligned to the same height at this slope (more is more reliable). */
function slopeFit(lines: readonly OcrBox[], lineHeight: number): { slope: number; score: number } {
  if (lines.length < 4) return { slope: 0, score: 0 };
  const pts = lines.map((l) => ({
    cx: l.x + l.width / 2,
    cy: l.y + l.height / 2,
    left: l.x,
    right: l.x + l.width,
  }));
  const tol = 0.25 * lineHeight;
  let best = { slope: 0, score: -1 };
  for (let k = -Math.round(MAX_SLOPE / SLOPE_STEP); k <= Math.round(MAX_SLOPE / SLOPE_STEP); k++) {
    const s = k * SLOPE_STEP;
    let score = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!;
        const b = pts[j]!;
        // Only consider two blocks separated horizontally (vertical rows in the same column do not indicate skew).
        if (a.right > b.left && b.right > a.left) continue;
        const dy = a.cy - s * a.cx - (b.cy - s * b.cx);
        if (Math.abs(dy) < tol) score++;
      }
    }
    // When equally good, pick the flatter slope.
    if (score > best.score || (score === best.score && Math.abs(s) < Math.abs(best.slope))) {
      best = { slope: s, score };
    }
  }
  return best.score > 0 ? best : { slope: 0, score: 0 };
}

/** Appearance after leveling along the slope (only y changes; x and size remain unchanged). */
export function levelLine(line: OcrBox, slope: number, centerX: number): OcrBox {
  if (!slope) return line;
  return { ...line, y: Math.round(line.y - slope * (line.x + line.width / 2 - centerX)) };
}

/** Height of the segment for local slope calculation (multiple of row height): upper and lower slopes differ when paper is curved. */
const BAND_LINES = 6;
/** Minimum number of pairs of separated left/right rows required in a segment for its slope to be reliable. */
const MIN_PAIRS = 3;

/**
 * Level each line (D-471): page is divided into segments by height (several row heights per
 * segment, looking ahead/behind by half a segment), each segment estimates its own slope (for
 * curved paper like receipts, top and bottom slopes differ); uses whole-page slope when rows in a
 * segment are too few.
 */
export function levelLines(
  lines: readonly OcrBox[],
  lineHeight: number,
  centerX: number,
): OcrBox[] {
  const whole = pageSlope(lines, lineHeight);
  const band = BAND_LINES * lineHeight;
  const cy = (l: OcrBox) => l.y + l.height / 2;
  const slopes = new Map<number, number>();
  // Slope of the k-th segment (centered at (k + 0.5) * segment height): unreliable when aligned pairs are fewer than three, falls back to whole-page slope.
  const slopeOf = (k: number) => {
    let s = slopes.get(k);
    if (s === undefined) {
      const near = lines.filter((l) => Math.abs(cy(l) - (k + 0.5) * band) <= band);
      const fit = slopeFit(near, lineHeight);
      s = fit.score >= MIN_PAIRS ? fit.slope : whole;
      slopes.set(k, s);
    }
    return s;
  };
  // Smooth transition between segments by position: blocks on the same row landing at segment boundaries have similar slopes and will not be separated.
  const at = (y: number) => {
    const t = y / band - 0.5;
    const k = Math.floor(t);
    const f = t - k;
    return (1 - f) * slopeOf(Math.max(0, k)) + f * slopeOf(Math.max(0, k + 1));
  };
  return lines.map((l) => levelLine(l, at(cy(l)), centerX));
}

// ---- 2. Borderless tables ----

/** A separated segment within a row (candidate cell). */
interface Segment {
  lines: OcrBox[];
  x: number;
  right: number;
}

interface TextRow {
  lines: OcrBox[];
  segments: Segment[];
  top: number;
  bottom: number;
}

/** After leveling, split into rows by height (same row if midline difference from previous row is less than half a row height), and segment each row by gaps. */
function textRows(lines: readonly OcrBox[], lineHeight: number): TextRow[] {
  const sorted = [...lines].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const groups: OcrBox[][] = [];
  for (const line of sorted) {
    const g = groups.at(-1);
    const mid = (l: OcrBox) => l.y + l.height / 2;
    if (g && Math.abs(mid(line) - median(g.map(mid))) < 0.5 * Math.min(lineHeight, line.height)) {
      g.push(line);
    } else groups.push([line]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    for (const line of g) {
      const last = segments.at(-1);
      // Two blocks very close together are the same segment (recognition split a sentence).
      if (last && line.x - last.right < 0.6 * lineHeight) {
        last.lines.push(line);
        last.right = Math.max(last.right, line.x + line.width);
      } else segments.push({ lines: [line], x: line.x, right: line.x + line.width });
    }
    return {
      lines: g,
      segments,
      top: Math.min(...g.map((l) => l.y)),
      bottom: Math.max(...g.map((l) => l.y + l.height)),
    };
  });
}

/** Columns: segments across multiple rows mostly fall within the same horizontal range; columns are separated by whitespace with almost no text. */
function columnBands(rows: readonly TextRow[]): { x: number; right: number }[] {
  const multi = rows.filter((r) => r.segments.length >= 2);
  const left = Math.min(...rows.flatMap((r) => r.segments.map((s) => s.x)));
  const right = Math.max(...rows.flatMap((r) => r.segments.map((s) => s.right)));
  const width = Math.ceil(right - left) + 1;
  const cover = new Uint16Array(width);
  for (const row of multi) {
    for (const s of row.segments) {
      for (let x = Math.floor(s.x - left); x < Math.ceil(s.right - left); x++) cover[x]!++;
    }
  }
  // Places where only one or two rows span across are also counted as whitespace (a long text line spanning two columns).
  const empty = Math.max(1, Math.floor(multi.length * 0.12));
  const bands: { x: number; right: number }[] = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    const on = x < width && cover[x]! > empty;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      bands.push({ x: left + start, right: left + x });
      start = -1;
    }
  }
  return bands;
}

/** Which columns this paragraph falls into (based on the amount of overlap with each column). */
function spanOf(seg: Segment, bands: readonly { x: number; right: number }[]): [number, number] {
  const hits = bands
    .map((b, i) => ({
      i,
      ov: Math.min(b.right, seg.right) - Math.max(b.x, seg.x),
    }))
    .filter((h) => h.ov > 0.3 * Math.min(seg.right - seg.x, bands[h.i]!.right - bands[h.i]!.x));
  if (!hits.length) {
    // Falls into whitespace: the column closest to the center.
    const c = (seg.x + seg.right) / 2;
    let best = 0;
    bands.forEach((b, i) => {
      const d = Math.abs((b.x + b.right) / 2 - c);
      if (d < Math.abs((bands[best]!.x + bands[best]!.right) / 2 - c)) best = i;
    });
    return [best, best];
  }
  return [hits[0]!.i, hits.at(-1)!.i];
}

/** A text segment is a number (amount, quantity, rate): contains digits, with at most 3 letters (units like "€", "kg", "%"). */
const isNumber = (s: Segment) => {
  const text = s.lines.map((l) => l.text).join(' ');
  return /\d/.test(text) && (text.match(/\p{L}/gu)?.length ?? 0) <= MAX_UNIT_LETTERS;
};

/**
 * A text segment is a unit (lab test units like "U/l", "mg/dl", "mmol/l", "%", "sec", EU sample
 * 098): a single word, at most 6 characters, containing "/" or "%" or at most 3 letters. A unit
 * in a separate column following a number is treated the same as a number, and is part of those
 * number columns.
 */
const isUnit = (s: Segment) => {
  const text = s.lines.map((l) => l.text.trim()).join(' ');
  return (
    /^[\p{L}µ%°/.]{1,6}$/u.test(text) &&
    (/[/%]/.test(text) || (text.match(/\p{L}/gu)?.length ?? 0) <= MAX_UNIT_LETTERS)
  );
};

/**
 * When there is a wide gap between column k and column k + 1, checks whether the right side
 * consists of columns of numbers aligned row by row with the left side (D-502): at least 70% of
 * the segments on the right are numbers, at least 70% of the text rows on the right also have
 * text on the left, and the height difference between left and right sides is less than 1/4 of a
 * line height (in highly skewed, unflattened photos, adjacent left/right segments might differ
 * significantly, and pairing them into a row would misalign amounts next to other items);
 * requires at least three such rows.
 */
function lockedRows(
  spans: readonly { s: Segment; span: [number, number] }[][],
  k: number,
  lineHeight: number,
  textColumns = false,
): boolean {
  const mid = (seg: Segment) => median(seg.lines.map((l) => l.y + l.height / 2));
  const right = spans.filter((row) => row.some((x) => x.span[0] > k));
  const both = right.filter((row) => {
    const l = row.filter((x) => x.span[1] <= k).map((x) => mid(x.s));
    const r = row.filter((x) => x.span[0] > k).map((x) => mid(x.s));
    return l.length > 0 && Math.abs(median(l) - median(r)) <= LOCKED_SKEW * lineHeight;
  });
  const segs = right.flatMap((row) => row.filter((x) => x.span[0] > k).map((x) => x.s));
  return (
    both.length >= MIN_ROWS &&
    both.length >= LOCKED_SHARE * right.length &&
    (textColumns ||
      segs.filter((x) => isNumber(x) || isUnit(x)).length >= LOCKED_SHARE * segs.length)
  );
}

export interface TextTable {
  /** Flattened rows (removed from free). */
  lines: OcrBox[];
  table: TableBlock;
  /** Width of each column (in original image pixels). */
  colWidths: number[];
  /** Span of text for each column (x): column dividers can be placed anywhere in the whitespace between two columns (D-506). */
  bands: { x: number; right: number }[];
  box: Box;
}

/**
 * A borderless table must have at least 3 columns and 3 rows split into segments, with at least
 * two rows using more than 3 columns; most text inside cells is short (three-column articles have
 * long paragraphs and are not treated as tables).
 */
const MIN_COLS = 3;
const MIN_ROWS = 3;
const MIN_WIDE_ROWS = 2;
const MAX_CELL_CHARS = 24;
const MAX_COL_GAP = 3;
/** For distant columns on the right: at least this proportion are numbers, and this proportion of rows have text on the left (D-502). */
const LOCKED_SHARE = 0.7;
const LOCKED_SKEW = 0.25;
const MAX_UNIT_LETTERS = 3;
/** Rows immediately above and below the table are considered adjacent: separated by no more than the maximum row gap inside the table plus this many additional line heights (D-506). */
const NEAR_SLACK = 0.5;

/** This row can be laid out according to the table's columns: at least two segments, each starting from a different column (no two segments squeezed into the same column; text overflowing into the next column is truncated at that column). */
function fitsBands(row: TextRow, bands: readonly Band[]): boolean {
  const starts = row.segments.map((seg) => spanOf(seg, bands)[0]);
  return starts.length >= 2 && new Set(starts).size === starts.length;
}

/**
 * Finds borderless tables: consecutive rows (which may have rows with only a single segment
 * interspersed, provided the gap is small), aligned by columns, with at least 3 columns and at
 * least 3 rows using 3+ columns. lines are the flattened rows; original maps flattened rows back
 * to their original positions (for cell positions in the original image, screenshot verification,
 * and original image thumbnail views).
 */
export function findTextTables(
  lines: readonly OcrBox[],
  lineHeight: number,
  original: (l: OcrBox) => OcrBox = (l) => l,
  /** Enclosed by a reliable table region: still requires multi-row alignment, but distant columns may also contain text such as names or statuses. */
  textColumns = false,
): TextTable[] {
  const rows = textRows(lines, lineHeight);
  // First find tables with 3+ columns, then find 2-column lists in the remaining rows (D-503): a
  // 2-column "Item -> Amount" must not hijack rows from a 3-column table (e.g., receipt totals
  // swallowing the GST summary below and compressing it into a 2-column table, or removing rows
  // above the summary when the summary itself cannot form a table).
  const wide = runTables(rows, lineHeight, original, false, textColumns);
  const used = new Set(wide.flatMap(({ from, to }) => rows.slice(from, to + 1)));
  // One or two rows immediately below a 3+ column table that do not form a table on their own
  // (receipt GST summary: header row, number row): if they can be laid out according to the table's
  // columns (each segment starting from a different column), they are appended below the table
  // without recalculating columns (D-503). If included in column calculation, the summary header
  // spanning across two columns would merge three columns into two.
  for (const w of wide) {
    const tail: TextRow[] = [];
    for (let k = w.to + 1; k < rows.length && !used.has(rows[k]!); k++) {
      if (rows[k]!.top - rows[k - 1]!.bottom > 1.8 * lineHeight) break;
      if (!fitsBands(rows[k]!, w.bands)) break;
      tail.push(rows[k]!);
    }
    if (!tail.length || tail.length >= MIN_ROWS) continue;
    w.table = buildTable(rows.slice(w.from, w.to + 1 + tail.length), w.bands, original);
    for (const row of tail) used.add(row);
  }
  const out = wide.map(({ table }) => table);
  let group: TextRow[] = [];
  for (const row of [...rows, null]) {
    if (row && !used.has(row)) {
      group.push(row);
      continue;
    }
    if (group.length) out.push(...runTables(group, lineHeight, original, true).map((t) => t.table));
    group = [];
  }
  return out.sort((x, y) => x.box.y - y.box.y);
}

/** Finds tables within a sequence of connected rows: from top to bottom, takes the longest valid table segment at each location. Also collects 2-column lists when twoColumns is true. */
function runTables(
  rows: readonly TextRow[],
  lineHeight: number,
  original: (l: OcrBox) => OcrBox,
  twoColumns: boolean,
  textColumns = false,
): { table: TextTable; bands: Band[]; from: number; to: number }[] {
  const out: { table: TextTable; bands: Band[]; from: number; to: number }[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.segments.length < 2) {
      i++;
      continue;
    }
    // Extending downward: rows with 2+ segments, or rows with a single segment sandwiched between 2+ segment rows with a small gap.
    let j = i;
    let lastMulti = i;
    while (j + 1 < rows.length) {
      const next = rows[j + 1]!;
      if (next.top - rows[j]!.bottom > 1.8 * lineHeight) break;
      j++;
      if (next.segments.length >= 2) lastMulti = j;
      else if (j - lastMulti > 2) break;
    }
    // When column layouts differ between the upper and lower sections (e.g., receipt items and totals below), the entire section cannot form a single table: takes the longest valid table segment starting from here.
    let found: { table: TextTable; bands: Band[]; end: number } | null = null;
    for (let end = lastMulti; end >= i + MIN_ROWS - 1 && !found; end--) {
      if (rows[end]!.segments.length < 2) continue;
      // Two rows immediately adjacent above/below the table (separated by less than 1.8 line
      // heights): checks if distant number columns are misaligned (D-502). Shifted numbers
      // belonging to the table's own number column have the same density as rows inside the table;
      // numbers significantly farther than any row gap inside the table (more than half a line
      // height) belong to another block (e.g., Subtotal / VAT / Total in the two columns on the
      // bottom right of an invoice table) and are not considered shifted numbers (D-506).
      let spacing = 0;
      for (let k = i + 1; k <= end; k++) {
        spacing = Math.max(spacing, rows[k]!.top - rows[k - 1]!.bottom);
      }
      const close = (gap: number) =>
        gap <= Math.min(1.8 * lineHeight, Math.max(0, spacing) + NEAR_SLACK * lineHeight);
      const near: TextRow[] = [];
      for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
        if (!close(rows[k + 1]!.top - rows[k]!.bottom)) break;
        near.push(rows[k]!);
      }
      for (let k = end + 1; k <= Math.min(rows.length - 1, end + 2); k++) {
        if (!close(rows[k]!.top - rows[k - 1]!.bottom)) break;
        near.push(rows[k]!);
      }
      const hit = tableOf(
        rows.slice(i, end + 1),
        lineHeight,
        original,
        near,
        twoColumns,
        textColumns,
      );
      if (hit) found = { ...hit, end };
    }
    if (found) {
      out.push({ table: found.table, bands: found.bands, from: i, to: found.end });
      i = found.end + 1;
    } else i++;
  }
  return out;
}

function tableOf(
  run: readonly TextRow[],
  lineHeight: number,
  original: (l: OcrBox) => OcrBox,
  near: readonly TextRow[] = [],
  twoColumns = false,
  textColumns = false,
): { table: TextTable; bands: Band[] } | null {
  const bands = columnBands(run);
  if (bands.length < 2) return null;
  const spans = run.map((row) => row.segments.map((s) => ({ s, span: spanOf(s, bands) })));
  // Columns separated by too great a distance (more than 3 line heights) represent two side-by-side
  // blocks (left address, right "label: value") rather than a single table (same rule as block
  // splitting). Unless those distant columns are numbers, and the numbers in every row have text on
  // the left (D-502: payroll or billing table bodies, with item names in the left column and
  // amounts in distant columns on the right; when table borders are not recognized, rows are still
  // aligned as a table rather than splitting item names and amounts into two unaligned blocks).
  const far = bands
    .slice(1)
    .map((b, k) => k)
    .filter((k) => bands[k + 1]!.x - bands[k]!.right > MAX_COL_GAP * lineHeight);
  if (far.some((k) => !lockedRows(spans, k, lineHeight, textColumns))) return null;
  // Stray numbers immediately adjacent to the table that appear only in distant columns without
  // text on the left: number columns shifted globally by several rows (in highly skewed,
  // unflattened photos where other items happen to align), which would be mispaired if matched by
  // row, preventing table formation (D-502).
  const stray = (row: TextRow, k: number) =>
    row.segments.some(isNumber) && row.segments.every((x) => spanOf(x, bands)[0] > k);
  if (far.some((k) => near.some((row) => stray(row, k)))) return null;
  // Two-column tables are also included (D-502): left item, distant single column of numbers on the
  // right (receipt totals, bill fee lists), matched row by row; closely spaced two-column "label:
  // value" pairs remain unchanged (D-332).
  const minCols = twoColumns && bands.length === 2 && far.length === 1 ? 2 : MIN_COLS;
  if (bands.length < minCols) return null;
  const wide = spans.filter((r) => new Set(r.map((x) => x.span[0])).size >= minCols).length;
  if (wide < MIN_WIDE_ROWS) return null;
  if (run.filter((r) => r.segments.length >= 2).length < MIN_ROWS) return null;
  const lengths = run.flatMap((r) =>
    r.segments.map((seg) => seg.lines.reduce((n, l) => n + l.text.trim().length, 0)),
  );
  if (median(lengths) > MAX_CELL_CHARS) return null;
  return { table: buildTable(run, bands, original), bands };
}

type Band = { x: number; right: number };

/** Arranges rows into a table according to specified columns. */
function buildTable(
  run: readonly TextRow[],
  bands: readonly Band[],
  original: (l: OcrBox) => OcrBox,
): TextTable {
  const spans = run.map((row) => row.segments.map((s) => ({ s, span: spanOf(s, bands) })));
  const cells: TableCell[] = [];
  for (const [r, row] of spans.entries()) {
    // Concatenates segments within the same column; multi-column segments span multiple columns.
    const byCol = new Map<number, { segs: Segment[]; end: number }>();
    for (const { s, span } of row) {
      const at = byCol.get(span[0]);
      if (at) {
        at.segs.push(s);
        at.end = Math.max(at.end, span[1]);
      } else byCol.set(span[0], { segs: [s], end: span[1] });
    }
    let c = 0;
    const starts = [...byCol.keys()].sort((a, b) => a - b);
    for (const start of starts) {
      if (start < c) continue;
      for (; c < start; c++) cells.push(emptyCell(r, c));
      const { segs, end } = byCol.get(start)!;
      const last = Math.max(
        start,
        Math.min(end, (starts.find((k) => k > start) ?? bands.length) - 1),
      );
      const segLines = segs.flatMap((s) => s.lines);
      const box = unionBox(segLines.map(original));
      const band = { x: bands[start]!.x, right: bands[last]!.right };
      const segLeft = Math.min(...segs.map((s) => s.x));
      const segRight = Math.max(...segs.map((s) => s.right));
      // Numeric columns are often right-aligned: flush against the right, with more space on the left.
      const align =
        segRight - segLeft < 0.7 * (band.right - band.x) &&
        band.right - segRight < 0.5 * (segLeft - band.x)
          ? 'right'
          : undefined;
      cells.push({
        row: r,
        col: start,
        rowSpan: 1,
        colSpan: last - start + 1,
        text: segs.map((s) => s.lines.map((l) => l.text.trim()).join(' ')).join(' '),
        ...(align ? { align } : {}),
        box,
      });
      c = last + 1;
    }
    for (; c < bands.length; c++) cells.push(emptyCell(r, c));
  }
  // Alignment determined per column: if most cells in a column are right-aligned, the entire column is right-aligned (mixed right and left alignment within a column looks messy).
  for (let c = 0; c < bands.length; c++) {
    const inCol = cells.filter((x) => x.col === c && x.colSpan === 1 && x.text);
    const right = inCol.filter((x) => x.align === 'right').length;
    for (const x of inCol) {
      if (right * 2 >= inCol.length && right > 0) x.align = 'right';
      else delete x.align;
    }
  }
  const all = run.flatMap((row) => row.lines);
  const box = unionBox(all.map(original));
  // Column widths: whitespace between columns is split equally between both sides.
  const edges = [
    box.x,
    ...bands.slice(1).map((b, k) => (bands[k]!.right + b.x) / 2),
    box.x + box.width,
  ];
  const colWidths = bands.map((_, k) => Math.max(1, Math.round(edges[k + 1]! - edges[k]!)));
  return {
    lines: all,
    table: { kind: 'table', rows: run.length, col: 0, cols: bands.length, cells, box },
    colWidths,
    bands: bands.map(({ x, right }) => ({ x, right })),
    box,
  };
}

const emptyCell = (row: number, col: number): TableCell => ({
  row,
  col,
  rowSpan: 1,
  colSpan: 1,
  text: '',
});

// // ---- 3. Barcodes ----

/** Black and white alternates at least this many times along a horizontal line (barcodes have dozens of vertical bars; lines of text do as well, so text regions are ignored). */
const BAR_TRANSITIONS = 24;
/** At least this proportion of black/white transition positions match on two adjacent horizontal lines to be considered the same vertical barcode region. */
const BAR_MATCH = 0.7;

/**
 * Whether barcode vertical bars span the entire region from top to bottom: splits black and white
 * based on the midpoint between the darkest and lightest points in the region, with at least 20%
 * of columns containing black, and over half of those black columns having a height exceeding
 * 50%. Paper texture fluctuates around average line brightness (scan noise is similar across
 * adjacent lines), and diagonal dashed lines can also accumulate enough black/white transitions,
 * but truly black regions are only as tall as those dashed pixels or adjacent text (starting
 * after D-533, barcodes are also searched near sporadic text, D-471).
 */
function barsFillHeight(image: RgbaImage, box: Box): boolean {
  const { width, data } = image;
  const lumAt = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    return 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
  };
  const x0 = Math.max(0, box.x);
  const x1 = Math.min(width, box.x + box.width);
  const y0 = Math.max(0, box.y);
  const y1 = Math.min(image.height, box.y + box.height);
  let lo = 255;
  let hi = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = lumAt(x, y);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  const mid = (lo + hi) / 2;
  const shares: number[] = [];
  for (let x = x0; x < x1; x++) {
    let dark = 0;
    for (let y = y0; y < y1; y++) if (lumAt(x, y) < mid) dark++;
    if (dark) shares.push(dark / (y1 - y0));
  }
  return shares.length >= 0.2 * (x1 - x0) && median(shares) >= 0.5;
}

/**
 * Recognized words forming readable terms within a "vertical bar" region (3+ letters, not
 * consisting solely of vertical strokes like I or l) indicate it is not a barcode, but patterned
 * background text: ticket security triangles alternate black and white on every line and align
 * vertically, causing the enclosed "Von: Fulda" region to be mistakenly cropped out as a barcode
 * (EU sample 066). Sporadic words recognized inside barcodes are numbers and vertical strokes.
 */
const wordy = (text: string) => (text.match(/\p{L}{3,}/gu) ?? []).some((w) => /[^IilL]/u.test(w));

/**
 * Finds vertical bar regions like barcodes: multiple horizontal lines from top to bottom have
 * frequent black/white transitions with no recognized text present. Returns their bounding boxes
 * (original image pixels); ignores regions with a height less than one line height.
 */
export function findBarcodes(
  image: RgbaImage,
  lines: readonly OcrBox[],
  lineHeight: number,
  localText = false,
): Box[] {
  const text = lines.filter((l) => wordy(l.text));
  const barcode = (b: Box) =>
    !text.some((l) => {
      const cx = l.x + l.width / 2;
      const cy = l.y + l.height / 2;
      return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
    });
  const { width, height, data } = image;
  const step = Math.max(2, Math.round(lineHeight / 4));
  const pad = 0.3 * lineHeight;
  const covered = (y: number) => lines.some((l) => y >= l.y - pad && y <= l.y + l.height + pad);
  const hits: { y: number; x0: number; x1: number; edges: number[] }[] = [];
  // Ignored lines with text; recorded: when a barcode is interrupted by a single line of recognized sporadic text, the upper and lower halves still belong to the same region.
  const skipped = new Set<number>();
  for (let y = 0; y < height; y += step) {
    if (covered(y)) {
      skipped.add(y);
      if (!localText) continue;
    }
    // Brightness of this line, used to split black and white based on the line's average value.
    const lum = new Float32Array(width);
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      lum[x] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    }
    if (localText)
      for (const l of lines)
        if (y >= l.y - pad && y <= l.y + l.height + pad)
          lum.fill(
            255,
            Math.max(0, Math.floor(l.x - pad)),
            Math.min(width, Math.ceil(l.x + l.width + pad)),
          );
    for (const v of lum) sum += v;
    const mean = sum / width;
    let prev = lum[0]! < mean;
    let count = 0;
    let x0 = -1;
    let x1 = -1;
    const edges: number[] = [];
    for (let x = 1; x < width; x++) {
      const dark = lum[x]! < mean;
      if (dark !== prev) {
        count++;
        edges.push(x);
        if (x0 < 0) x0 = x;
        x1 = x;
      }
      prev = dark;
    }
    // Only counts differences large enough (noise on pure white paper is excluded).
    let min = 255;
    let max = 0;
    for (let x = 0; x < width; x++) {
      min = Math.min(min, lum[x]!);
      max = Math.max(max, lum[x]!);
    }
    if (count >= BAR_TRANSITIONS && max - min > 80) {
      if (!localText) hits.push({ y, x0, x1, edges });
      else {
        // Isolated page boxes must not pull crops into neighboring fields; separate groups of vertical bars are also preserved individually.
        const clusters: number[][] = [];
        for (const x of edges) {
          const last = clusters.at(-1);
          if (last && x - last.at(-1)! <= Math.max(lineHeight, width / 100)) last.push(x);
          else clusters.push([x]);
        }
        for (const group of clusters)
          if (group.length >= BAR_TRANSITIONS)
            hits.push({ y, x0: group[0]!, x1: group.at(-1)!, edges: group });
      }
    }
  }
  // Whether vertical bars align vertically: black/white transitions on adjacent horizontal lines mostly occur at the same positions (text strokes and photo textures do not).
  const sameBars = (a: number[], b: number[]) => {
    const tol = Math.max(2, Math.round(width / 400));
    let j = 0;
    let match = 0;
    for (const x of a) {
      while (j < b.length && b[j]! < x - tol) j++;
      if (j < b.length && Math.abs(b[j]! - x) <= tol) match++;
    }
    return match >= BAR_MATCH * Math.max(a.length, b.length);
  };
  // Combines consecutive horizontal lines into a single region.
  const out: Box[] = [];
  if (localText) {
    const groups: (typeof hits)[] = [];
    for (const hit of hits) {
      const group = groups.find((g) => {
        const last = g.at(-1)!;
        return hit.y > last.y && hit.y - last.y <= 2 * step && sameBars(last.edges, hit.edges);
      });
      if (group) group.push(hit);
      else groups.push([hit]);
    }
    for (const group of groups) {
      if (group.length < 2 || group.at(-1)!.y - group[0]!.y + step < lineHeight) continue;
      const x0 = median(group.map((g) => g.x0)),
        x1 = median(group.map((g) => g.x1));
      const box = {
        x: Math.round(x0),
        y: group[0]!.y,
        width: Math.round(x1 - x0),
        height: Math.min(height, group.at(-1)!.y + step) - group[0]!.y,
      };
      if (barsFillHeight(image, box) && barcode(box)) out.push(box);
    }
    return out;
  }
  let group: typeof hits = [];
  const flush = () => {
    if (group.length >= 2 && group.at(-1)!.y - group[0]!.y + step >= lineHeight) {
      const x0 = median(group.map((g) => g.x0));
      const x1 = median(group.map((g) => g.x1));
      const y0 = group[0]!.y;
      const y1 = Math.min(height, group.at(-1)!.y + step);
      out.push({
        x: Math.max(0, Math.round(x0)),
        y: y0,
        width: Math.round(x1 - x0),
        height: y1 - y0,
      });
    }
    group = [];
  };
  for (const h of hits) {
    const last = group.at(-1);
    let apart = last ? h.y - last.y : 0;
    if (last) {
      // Skipped lines in between that contain text are not counted as gaps.
      for (let y = last.y + step; y < h.y && skipped.has(y); y += step) apart -= step;
    }
    if (last && (apart > 2 * step || !sameBars(last.edges, h.edges))) flush();
    group.push(h);
  }
  flush();
  return out.filter(barcode);
}

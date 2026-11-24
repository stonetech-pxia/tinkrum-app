import { type BuildOptions } from './build';

import { lineShareIn, readingOrder, type LayoutRegion } from './layout';

import { ENDS_WITH_FILL } from './word-fill-ins';

import { sideOfGutter, type PageGutter } from './word-gutter';

import type { Box, OcrBox, RgbaImage, TableBlock, TableCell } from './types';

// Scan-to-Word (D-328): Page OCR results + layout analysis regions -> DocDoc (edited on the edit
// page, docx regenerated from it each time). Lined tables and Excel conversion share the line
// detection and table grouping logic (D-272); remaining text is segmented into paragraphs by region
// (or position-clustered blocks if unregioned), lines are joined according to D-268 rules; font
// size is derived from line height (or character width when text is sufficiently long and font is
// uniform across the page, D-463), bold from stroke thickness, and color from text pixels.
// Vertically overlapping and horizontally separated blocks are placed into parallel rows (D-331).
// Underlines beneath text are written as underlines (D-463); strike-throughs are omitted (text
// only).

/** Paragraph style: font size (points), bold, italic, underline, color (RRGGBB), alignment; missing values fall back to document defaults. */
export interface DocStyle {
  size?: number;
  bold?: boolean;
  /** Added in the edit page (D-465); italics cannot be recognized. */
  italic?: boolean;
  /** A line matching the text length exists beneath the characters in the source image (D-463). */
  underline?: boolean;
  color?: string;
  /** Source color bars reflow with paragraphs rather than staying fixed at the page bottom. */
  fill?: string;
  align?: 'left' | 'center' | 'right';
}

/**
 * A stylized run within a text block (D-465, selecting characters in the edit page to bold or
 * change font size): specified properties define this run's appearance (`bold: false` explicitly
 * disables bold for this run even if the entire paragraph is bold), while unspecified properties
 * inherit from the paragraph.
 */
export interface DocRun {
  text: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface DocParagraph extends DocStyle {
  kind: 'paragraph';
  text: string;
  /** Heading level (1 or 2); defaults to body text when absent. */
  heading?: 1 | 2;
  /** Original spacing between paragraphs (paragraph gap), rendered as space-before. */
  spaced?: boolean;
  /** First-line indent (source image pixels, D-330): offset of the first line relative to other lines in this block. */
  indent?: number;
  /**
   * Configured form labels and values (D-332): each line in `text` is 'label\tvalue', `tab` is
   * the value's position relative to the label's left edge (source pixels), rendered as a tab
   * stop in docx.
   */
  tab?: number;
  /** Stylized runs (D-465): when concatenated, they form the text content. */
  runs?: DocRun[];
  box: Box;
}

export interface DocList extends DocStyle {
  kind: 'list';
  /** Numbered list (1., 2., (3), ①); otherwise treated as bulleted. */
  ordered: boolean;
  /** Numbering format (Word's lvlText, where %1 is the number): '%1.', '%1、', '(%1)', '%1)'. */
  format?: string;
  /** Starting number of the first item. */
  start?: number;
  /** Text of each item (excluding original numbers and symbols). */
  items: string[];
  /** Stylized runs for each item (D-465), corresponding 1:1 with items; items without runs inherit the list's overall style. */
  itemRuns?: (DocRun[] | null)[];
  spaced?: boolean;
  box: Box;
}

/** Lined table: same as TableBlock for Excel conversion (0-indexed columns), `colWidths` specifies column widths in source pixels. */
export interface DocTable {
  kind: 'table';
  /** Tables rotated 90 degrees on landscape pages retain source text orientation, preventing character-by-character wrapping of words in narrow columns. */
  direction?: 'tbRl';
  /** Borderless tables recognized via column alignment in source image (D-471): rendered without borders. */
  borderless?: boolean;
  table: TableBlock;
  colWidths: number[];
  /** Font size of table text (points, based on table text line height, D-335); defaults to body font size when absent. Scales down proportionally with table shrinkage in docx. */
  size?: number;
  /** Original line positions in each cell; generates standard paragraph indentation/space-before only, becoming invalid after editing, adding, or deleting rows. */
  cellLayout?: {
    row: number;
    col: number;
    /** When native shading covers the entire cell, background color follows the cell rather than individual characters. */
    fill?: string;
    lines: (Box & { color?: string; fill?: string; tabs?: number[] })[];
  }[];
  box: Box;
}

/** Cropped image: `src` is the cropped JPG (current runtime file); absent before cropping. */
export interface DocImage {
  kind: 'image';
  box: Box;
  src?: string;
  /** Purely decorative page element, not participating in document flow; legacy sidebars may also retain non-text drawing layers. */
  background?: true;
}

/** Blank space originally occupied by an image converted to base background; not a transparent image and contains no text. */
export interface DocSpace {
  kind: 'space';
  box: Box;
}

/** Independent block elements; only these are placed inside parallel row cells (no nested parallel rows). */
export type DocLeaf = DocParagraph | DocList | DocTable | DocImage | DocSpace;

/** Parallel row cell: `width` is its width in source image pixels (up to the left edge of the next cell), `blocks` are in reading order. */
export interface DocRowCell {
  width: number;
  blocks: DocLeaf[];
}

/**
 * Parallel row (D-331): vertically overlapping, horizontally separated blocks (two-column text,
 * side-by-side tables, form left/right sections), written as a borderless layout table row in
 * docx containing respective paragraphs and tables in each cell.
 */
export interface DocRow {
  kind: 'row';
  /** From left to right. */
  cells: DocRowCell[];
  box: Box;
}

export type DocBlock = DocLeaf | DocRow;

/** All independent blocks on a page (with parallel rows expanded into cell blocks), in order. */
export function leafBlocks(page: { blocks: readonly DocBlock[] }): DocLeaf[] {
  return page.blocks.flatMap((b) => (b.kind === 'row' ? b.cells.flatMap((c) => c.blocks) : [b]));
}

/** Temporarily uses standard layout tables when a column contains nested parallel fields; underlying file blocks and edit references remain unchanged. */
export function flowCellBlocks(blocks: readonly DocLeaf[], h: number): readonly DocBlock[] {
  const parallel = blocks.some((a, i) =>
    blocks.slice(i + 1).some((b) => {
      const x = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
      const y =
        Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
      return x < h * 1.5 && y > Math.min(a.box.height, b.box.height) * 0.5;
    }),
  );
  return parallel
    ? arrangeUnits(
        blocks.map((b) => ({ box: b.box, blocks: [b] })),
        h,
      )
    : blocks;
}

export interface DocPage {
  /** URI of the source image snippet used for verification. */
  source: string;
  /** Coordinate system of the box (matches line-detection and OCR image). */
  width: number;
  height: number;
  /** Body font size for this page (points): paragraphs close to this size omit explicit font size declarations. */
  bodySize: number;
  /** Physical dimensions of the source paper (points); falls back to legacy portrait A4 when absent. */
  paper?: { width: number; height: number };
  /** Page margins preserved from source content boundaries (points); defaults to 2 cm for legacy documents without margins. */
  margins?: { top: number; right: number; bottom: number; left: number };
  /** In reading order. */
  blocks: DocBlock[];
}

export interface DocDoc {
  version: 1 | 2 | 3 | 4 | 5;
  pages: DocPage[];
}

export interface DocPageInput {
  /** Image used for line detection, thickness measurement, and color analysis (enhanced version, or original if unenhanced). */
  image: RgbaImage;
  /** Recognized lines, with coordinates matching image. */
  lines: readonly OcrBox[];
  /** Layout analysis regions (absent when model is uninstalled: blocks segmented solely by position, ignoring headings and images). */
  regions?: readonly LayoutRegion[];
  /** Verified full-page image from native digital PDF (pixel coordinates); text and grids are isolated before participating in layout as a standard image. */
  nativeFigures?: readonly Box[];
  /** Text in native PDFs not rendered into full-page image crops (pixel coordinates): overlapping OCR lines are excluded from the image and retained as body text. */
  nativeText?: readonly Box[];
  /** Layout prior to taking over native full-page images on the same page; retains font sizes and styles outside the image, preventing removal of intra-image labels from altering body text statistics. */
  prior?: DocPage;
  source: string;
  /** Physical dimensions preserved by PDF rendering path; absent for regular photos, preventing millimeter estimations of receipts based solely on pixels. */
  paper?: { width: number; height: number };
  /** Known skew angle (degrees), same as `buildTablePage`. */
  skew?: number;
}

export interface DocBuildOptions extends BuildOptions {
  /** Handling line continuations for reattached fragments or numeric ranges; other paragraphs and dense pages retain `joinLines` to minimize scope of changes. */
  joinParagraph?: (lines: readonly OcrBox[]) => string;
}

/** Width of A4 (points): full page width used to calculate font scaling relative to A4. */
export const A4_WIDTH_PT = 595;

/** Recognition box height -> font size: PP-OCR boxes exceed character height (e.g., 10 pt body text in word-exp letters yields ~11 pt boxes). */
const BOX_TO_FONT = 0.9;

/**
 * Body font size constraints: source photos may not be A4 (narrow book pages scale up excessively
 * when normalized to A4); other paragraphs calculate font size proportional to body line height.
 * Form pages (D-335) follow source aspect ratios down to 6 pt to preserve single-page fidelity;
 * prose pages (where >50% of text is in long lines, e.g., books, terms) enforce a minimum of 9 pt
 * for readability, allowing multi-page flow.
 */
const BODY_MIN = 9;

const FORM_MIN = 6;

const BODY_MAX = 12;

/** Pages with at least this many lines are classified as dense pages (forms, tax sheets): body font is not boosted to 9 pt to prevent pagination expansion. */
const DENSE_LINES = 90;

/** Proportion of text in long lines (exceeding this width ratio) required to classify a page as a prose page (form labels, values, and table text are typically short). */
const PROSE_SHARE = 0.5;

const PROSE_LINE = 0.4;

/** Font sizes within this proportion of the body size are treated as body text (Chinese quotation marks inflate bounding box heights, making 20% variance common). */
const BODY_SNAP = 0.25;

/** Paragraphs with fewer letters or digits than this threshold (e.g., ["Child."]) have inaccurate line height, are not assigned a separate font size, and are not treated as headings (unless classified as headings by the model). */
const SHORT_TEXT = 6;

/** Paragraphs exceeding body size by this multiplier and spanning no more than two lines are headings; exceeding this larger threshold makes it a level-1 heading. */
const HEADING_RATIO = 1.3;

const HEADING1_RATIO = 1.8;

/**
 * Paragraphs excluded from being headings (D-330): starting with quotation marks (dialogue),
 * ending with a period and having >20 alphanumeric characters (complete sentences), or exceeding
 * 100 alphanumeric characters. Layout models and font sizes may otherwise misclassify these as
 * headings.
 */
const QUOTE_START = /^\s*[“"«「『‘'„]/;

const SENTENCE_END = /[.。!！?？]\s*$/;

/**
 * Headings determined solely by font size (not labeled by model): must start with an alphanumeric
 * character and have a sufficient letter ratio. In scans, handwriting and typewriter boxes vary
 * in height, frequently causing lines with symbols and numbers ('Displays (8) 40 Floor (40)', '#
 * Customers Attended 35') to measure as large text without being headings.
 */
const HEADING_MIN_LETTERS = 0.7;

export const looksLikeHeading = (text: string) => {
  const chars = text.replace(/\s/g, '');
  const letters = chars.match(/\p{L}/gu)?.length ?? 0;
  return /^[\p{L}\p{N}]/u.test(chars) && letters >= HEADING_MIN_LETTERS * chars.length;
};

const notHeading = (text: string) => {
  const n = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return QUOTE_START.test(text) || (SENTENCE_END.test(text) && n > 20) || n > 100;
};

/** First-line indent (D-330): between 0.8 and 4 line heights, up to half the block width (larger values indicate centered, right-aligned, or multi-column short lines). */
const INDENT_MIN = 0.8;

const INDENT_MAX = 0.5;

const INDENT_LINES = 4;

/** Strokes thicker than the page median by this multiple are classified as bold. */
export const BOLD_RATIO = 1.35;

/** Text pixels with chromaticity (difference between max and min color channels) exceeding this threshold are considered colored. */
const COLOR_CHROMA = 60;

/** Paragraph: vertical spacing not exceeding 1.2 times line height counts as the same paragraph (same as D-268). */
const PARAGRAPH_GAP = 1.2;

/** Lines whose centerline is within this fraction of the page width from the page centerline, with at least 15% page width margin on both sides (D-463), are centered. */
const PAGE_CENTER = 0.06;

const PAGE_CENTER_MARGIN = 0.15;

/** Maximum width ratio of centered lines relative to container width. */
const CENTER_MAX_SHARE = 0.85;

/** Determine container first, then evaluate alignment; headers may additionally center relative to the entire page, while column text considers only its column. */
function alignmentIn(
  box: Box,
  h: number,
  rows: number,
  left: number,
  right: number,
  pageWidth?: number,
): DocStyle['align'] {
  const leftGap = box.x - left;
  const rightGap = right - (box.x + box.width);
  // Lines nearly as wide as the container (with minimal side margins) are not centered: side blank space is treated as noise (EU sample 021 capturing full fillable lines).
  const centered =
    (leftGap > 2 * h &&
      rightGap > 2 * h &&
      box.width <= CENTER_MAX_SHARE * (right - left) &&
      Math.abs(leftGap - rightGap) < 0.2 * (leftGap + rightGap)) ||
    (pageWidth !== undefined &&
      rows === 1 &&
      Math.min(box.x, pageWidth - (box.x + box.width)) > PAGE_CENTER_MARGIN * pageWidth &&
      Math.abs(box.x - (pageWidth - box.x - box.width)) < PAGE_CENTER * pageWidth);
  return centered
    ? 'center'
    : leftGap > 6 * h && rightGap < 1.5 * h && rows <= 2
      ? 'right'
      : undefined;
}

/** Two lines whose centerlines differ by fewer than this many line heights (with unaligned left edges) are treated as a centered two-line group (D-463). */
const CENTER_PAIR = 0.2;

/**
 * Font size estimation via character width (D-463): PP-OCR and Vision box heights vary with
 * ascenders/descenders ('Docteur' and 'Ophtalmologiste' are identical size yet differ by 30% in
 * box height), whereas character width is much more stable. Line width in pixels / Arial
 * character count width ratio ≈ font size in pixels. Restricted to lines with at least 8
 * alphanumeric characters; page body estimates must be consistent (interquartile range <= 15% of
 * median for the same font) and within 1/3 difference of line-height estimates (guarding against
 * other fonts or OCR errors), otherwise line height is used. Paragraphs estimated via character
 * width differing from body size by >8% receive explicit font size declarations.
 */
const WIDTH_MIN_CHARS = 8;

const WIDTH_SPREAD = 0.15;

const WIDTH_CLAMP = 4 / 3;

const WIDTH_SNAP = 0.08;

/** Start of a list item (same as `layoutOcrLines` in D-268). */
// Entries followed immediately by digits like '7.29', '3)5', '-7.29' represent numbers (amounts, barcode numbers), not list numbers or bullets (D-471).
const LIST_ITEM = /^\s*(?:[•·*▪●○◦■□]|[-–—](?!\d)|\d{1,3}[.、)）](?!\d)|[(（]\d{1,3}[)）]|[①-⑳])/;

const ORDERED = /^\s*(?:(\d{1,3})([.、)）])(?!\d)|[(（](\d{1,3})[)）]|([①-⑳]))\s*/;

const BULLET = /^\s*(?:[•·*▪●○◦■□]|[-–—](?!\d))\s*/;

/**
 * Decorative elements: repeated consecutive symbols ('***', '--') or lines bookended by matching
 * symbols ('– Anmeldebestätigung –', '*** ATTO ***') are title/receipt borders, not list bullets.
 */
const DECORATED =
  /^\s*(?:([*•·▪●○◦■□])\s*\1|[-–—]\s*[-–—])|^\s*(?:([*•·▪●○◦■□]).*\2|[-–—].*[-–—])\s*$/;

/**
 * Leading dates ('21. APR. 2006', '1. Januar 2024', '15. März', '3. 4. 2025'): German, Austrian,
 * and Nordic formatting where the day is followed by a period, not a list number (EU sample 076
 * date stamp misread as a list starting at 21). Months are recognized by full names and
 * abbreviations in German, French, Italian, Spanish, Portuguese, and English.
 */
const MONTHS =
  'jan|jän|feb|fév|fev|mär|mar|apr|avr|abr|mai|may|mag|jun|juin|giu|jul|juil|lug|aug|aoû|aou|ago|' +
  'sep|set|okt|oct|ott|out|nov|dez|dec|déc|dic|ene|gen';

const DATE_START = new RegExp(
  `^\\s*\\d{1,2}\\.\\s*(?:\\d{1,2}\\.\\s*\\d{2,4}\\b|(?:${MONTHS})\\p{L}{0,7}\\.?\\s*(?:\\d{2,4}\\b|$))`,
  'iu',
);

/**
 * Parenthetical numbers followed by nothing or another parenthetical code ('(12) (13)', '(6)',
 * '(22) (D.1)'): form field codes (EU standardized vehicle registration, EU sample 089), not list
 * numbers.
 */
const FIELD_CODE = /^\s*[(（]\d{1,3}[)）]\s*(?:[(（][\p{L}\p{N}.]{1,6}[)）]\s*)*$/u;

const listStart = (text: string) =>
  LIST_ITEM.test(text) && !DECORATED.test(text) && !DATE_START.test(text) && !FIELD_CODE.test(text);

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1]! : 0;
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

interface Row {
  lines: OcrBox[];
  box: Box;
  text: string;
}

/** Group lines into rows by vertical overlap (D-268), with each row ordered from left to right. */
function rowsOf(lines: readonly OcrBox[]): Row[] {
  const sorted = [...lines].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const groups: OcrBox[][] = [];
  for (const line of sorted) {
    const first = groups.at(-1)?.[0];
    if (first) {
      const ov = Math.min(first.y + first.height, line.y + line.height) - Math.max(first.y, line.y);
      // Centered line of small text below large text (slogan beneath the logo `"flexPEDIA"`, EU
      // sample 091): the bounding box of the large text protrudes and overlaps the top of the small
      // text, but the two lines overlap horizontally and thus form two separate rows rather than a
      // single row.
      const stacked = groups
        .at(-1)!
        .some(
          (l) =>
            Math.max(l.height, line.height) > 1.6 * Math.min(l.height, line.height) &&
            Math.min(l.x + l.width, line.x + line.width) - Math.max(l.x, line.x) >
              0.5 * Math.min(l.width, line.width),
        );
      if (ov >= 0.5 * Math.min(first.height, line.height) && !stacked) {
        groups.at(-1)!.push(line);
        continue;
      }
    }
    groups.push([line]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    return { lines: g, box: unionBox(g), text: g.map((l) => l.text.trim()).join(' ') };
  });
}

/**
 * Cluster lines that do not fall into any region by position: vertically adjacent lines (with a
 * gap of no more than 1.2 times the line height) that also overlap horizontally are linked
 * together (e.g., the address on the left of the letterhead and the date on the right are
 * separated into two blocks).
 */
export function clusterLines(lines: readonly OcrBox[], lineHeight: number): OcrBox[][] {
  const rows = rowsOf(lines).flatMap((r) => splitRow(r, lineHeight));
  const clusters: { rows: Row[]; box: Box }[] = [];
  for (const row of rows) {
    const near = clusters.filter((c) => {
      const gap = row.box.y - (c.box.y + c.box.height);
      const xOverlap =
        Math.min(c.box.x + c.box.width, row.box.x + row.box.width) - Math.max(c.box.x, row.box.x);
      return gap <= PARAGRAPH_GAP * lineHeight && gap > -0.5 * lineHeight && xOverlap > 0;
    });
    const target = near.at(-1);
    if (target) {
      target.rows.push(row);
      target.box = unionBox([target.box, row.box]);
    } else clusters.push({ rows: [row], box: row.box });
  }
  return clusters.map((c) => c.rows.flatMap((r) => r.lines));
}

/** The gap between the label column and the content column must be at least this many line heights. */
const LABEL_GUTTER = 2;

/** The width of the label column (from rightmost to leftmost) does not exceed this fraction of the total text width of the page. */
const LABEL_COLUMN_SHARE = 0.3;

/** The label column and content column must each have at least this many lines; lines covered by the gap take up at most this fraction. */
const LABEL_MIN_LINES = 4;

const LABEL_MAX_COVER = 0.25;

/**
 * A narrow column of labels on the left of a form (e.g., `"Step 3: Claim Dependent and Other
 * Credits"`), a content column on the right, with a vertical gap in between, occasionally crossed
 * by a line of text spanning the entire page. Finding such a gap splits the lines into three
 * categories: spanning lines, left-side label lines, and right-side content lines, each clustered
 * by position; otherwise, the spanning text line above would overlap in x with both the labels
 * and content, merging the left and right columns into a single block and scrambling the order.
 * If no such gap exists (such as in body text or two-column papers), return a single category
 * as-is.
 */
export function splitLabelColumn(
  lines: readonly OcrBox[],
  lineHeight: number,
): { across: OcrBox[]; labels: OcrBox[]; contents: OcrBox[] } | null {
  if (lines.length < 2 * LABEL_MIN_LINES) return null;
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.x + l.width));
  const span = right - left;
  // How many lines cover each x-coordinate; the gap is a continuous segment on the right of the
  // label column where very few lines are covered (only occasional spanning lines). Look only
  // within the left 30% of the entire page width: gaps further to the right represent the gutter
  // between two columns of body text.
  const step = Math.max(1, Math.round(lineHeight / 4));
  let best: { a: number; b: number } | null = null;
  let start: number | null = null;
  const limit = left + LABEL_COLUMN_SHARE * span;
  for (let x = left + 2 * lineHeight; x <= limit + step; x += step) {
    const open =
      x <= limit &&
      lines.filter((l) => l.x < x && l.x + l.width > x).length <= LABEL_MAX_COVER * lines.length;
    if (open && start === null) start = x;
    if (!open && start !== null) {
      if (x - start >= LABEL_GUTTER * lineHeight && (!best || x - start > best.b - best.a))
        best = { a: start, b: x };
      start = null;
    }
  }
  if (!best) return null;
  // Using the centerline of the gap as a boundary: the left side of lines in the content column is often a few pixels short of the right edge of the gap.
  const mid = (best.a + best.b) / 2;
  // Labels consist of a few narrow words; a whole line of wide text is considered body text even if it falls to the left of the gap.
  const labels = lines.filter((l) => l.x + l.width <= mid && l.width <= LABEL_COLUMN_SHARE * span);
  const contents = lines.filter((l) => l.x >= mid);
  const across = lines.filter((l) => !labels.includes(l) && !contents.includes(l));
  if (labels.length < LABEL_MIN_LINES || contents.length < LABEL_MIN_LINES) return null;
  // If the left column consists solely of numbering (`"3."`, `"4."`), these are numbered clauses where the number belongs to the item on the right rather than forming a label column (EU sample 032).
  if (labels.every((l) => listStart(l.text) && !stripMarker(l.text))) return null;
  return { across, labels, contents };
}

type LabelSplit = NonNullable<ReturnType<typeof splitLabelColumn>>;

/** Cluster a batch of lines; when the page has a label column, the left labels, right content, and spanning lines within this batch form separate blocks (marked with side). */
function clustersOf(
  lines: readonly OcrBox[],
  lineHeight: number,
  split: LabelSplit | null,
): { lines: OcrBox[]; side?: 'label' | 'content' }[] {
  if (!split) return clusterLines(lines, lineHeight).map((c) => ({ lines: c }));
  const labels = new Set(split.labels);
  const contents = new Set(split.contents);
  const pick = (f: (l: OcrBox) => boolean) => lines.filter(f);
  return [
    ...clusterLines(
      pick((l) => !labels.has(l) && !contents.has(l)),
      lineHeight,
    ).map((c) => ({ lines: c })),
    ...clusterLines(
      pick((l) => labels.has(l)),
      lineHeight,
    ).map((c) => ({ lines: c, side: 'label' as const })),
    ...clusterLines(
      pick((l) => contents.has(l)),
      lineHeight,
    ).map((c) => ({ lines: c, side: 'content' as const })),
  ];
}

/** Two short lines must have at least this many line heights of space between them (or when each corresponds to a line of text on the left) to be treated as separate lines. */
const SHORT_APART = 0.8;

const SHORT_BESIDE = 0.5;

/** Amount-like text: numbers make up more than half (e.g., `"3.60"`, `"19.90 EUR"`, `"-12,5 %"`). */
const isAmount = (text: string) => {
  const t = text.replace(/\s/g, '');
  return t.length > 0 && (t.match(/\d/g)?.length ?? 0) * 2 >= t.length;
};

/** A short line must have at least this many line heights of clear space following it (including the first word of the next line) to be considered fitting; gaps between columns are not counted as empty space. */
const ROOM_GUTTER = 3;

/** If two blocks of text in a row are separated by more than this many line heights, split them into left and right blocks (as word-to-word gaps within a single line are far smaller than a line height). */
const ROW_SPLIT = 1.6;

/** A numbering prefix at the start of a line and its clause are considered the same item if separated by at most this many line heights. */
const MARKER_GAP = 6;

/** A fully stretched line must be split into at least this many words, with word gaps differing from the median by at most this amount, to be treated as a text line (rather than multiple columns). */
const JUSTIFIED_MIN_WORDS = 3;

const JUSTIFIED_GAP_SPREAD = 0.2;

/**
 * Justified single-word-per-block lines with large gaps between words (e.g., `"dont le siège est
 * fixé à (adresse précise)"`), where OCR splits each word into a box: each block contains only a
 * single word and gaps are nearly uniform, representing a single line of text rather than
 * multiple columns (EU sample 037). Multiple columns and letterhead left/right blocks contain
 * multiple words whose gaps will not be uniform.
 */
function justifiedWords(pieces: readonly (readonly OcrBox[])[]): boolean {
  if (pieces.length < JUSTIFIED_MIN_WORDS) return false;
  if (!pieces.every((p) => /^\S+$/u.test(p.map((l) => l.text.trim()).join('')))) return false;
  const gaps = pieces.slice(1).map((p, i) => {
    const prev = pieces[i]!.at(-1)!;
    return p[0]!.x - (prev.x + prev.width);
  });
  const mid = median(gaps);
  return gaps.every((g) => Math.abs(g - mid) <= JUSTIFIED_GAP_SPREAD * mid);
}

/** A cell is considered a prose paragraph if it has at least this many rows, every row except the last has at least this many words, and its width is comparable to the widest row. */
const CELL_PROSE_ROWS = 3;

const CELL_PROSE_CHARS = 40;

const CELL_PROSE_WIDTH = 0.85;

/**
 * Several lines of text in a cell form a wrapped prose paragraph (each line is long and extends
 * to the edge except for the last) rather than individual single-item rows (such as addresses or
 * dates, D-333).
 */
function proseRows(rows: readonly Row[]): boolean {
  if (rows.length < CELL_PROSE_ROWS) return false;
  const widest = Math.max(...rows.map((r) => r.box.width));
  return rows
    .slice(0, -1)
    .every(
      (r) => [...r.text].length >= CELL_PROSE_CHARS && r.box.width >= CELL_PROSE_WIDTH * widest,
    );
}

/** Split apart widely separated blocks within a single row (such as two columns or left/right letterhead sides). */
function splitRow(row: Row, lineHeight: number): Row[] {
  const out: OcrBox[][] = [[row.lines[0]!]];
  for (const line of row.lines.slice(1)) {
    const prev = out.at(-1)!.at(-1)!;
    if (line.x - (prev.x + prev.width) > ROW_SPLIT * lineHeight) out.push([line]);
    else out.at(-1)!.push(line);
  }
  if (justifiedWords(out)) return [row];
  // An isolated number at the start of a line (e.g., `"3."` separated by a large gap from the
  // clause, as in the declaration of conformity in EU sample 032) belongs to the same item as the
  // following text: if split, the number forms its own column and fails to align with the clause
  // when placed side-by-side (e.g., `"7."` aligned next to the last line of item 6).
  const [first, second] = out;
  if (
    first?.length === 1 &&
    second &&
    listStart(first[0]!.text) &&
    !stripMarker(first[0]!.text) &&
    second[0]!.x - (first[0]!.x + first[0]!.width) <= MARKER_GAP * lineHeight
  )
    out.splice(0, 2, [...first, ...second]);
  return out.map((g) => ({
    lines: g,
    box: unionBox(g),
    text: g.map((l) => l.text.trim()).join(' '),
  }));
}

/**
 * Check whether the first word of the next line can fit after the previous line (the right side
 * of left-aligned body text is naturally ragged: if the previous line did not reach the end, it
 * wrapped because the next word could not fit; wrapping despite having enough space marks the end
 * of a paragraph). Word width is estimated using the average character width of the next line.
 * Chinese, Japanese, and Korean have no spaces, so wrapping can occur at the first character.
 */
function fitsOnPrev(prev: Row, row: Row, right: number, typical: number): boolean {
  // Very short lines (such as form label columns) frequently vary in length and are not wraps; apply this check only to sufficiently long lines.
  if ([...prev.text].length <= LABEL_MAX) return true;
  return prev.box.x + prev.box.width + firstWordWidth(row) <= right + 0.3 * typical;
}

/** Approximate width of the first word of a line (including preceding spaces): estimated using the average character width of that line. Chinese, Japanese, and Korean can wrap at the first character. */
function firstWordWidth(row: Row): number {
  const text = row.text.trim();
  const first = /^[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(text)
    ? text.slice(0, 1)
    : (text.split(/\s+/)[0] ?? '');
  const char = row.box.width / Math.max(1, text.length);
  return (first.length + 1) * char;
}

/** Split lines within a block into paragraphs: start a new paragraph when there is a large gap, a list item, a previous line that does not reach the right margin (not a wrap), or an indentation. */
export function paragraphsOf(
  lines: readonly OcrBox[],
  peers: readonly OcrBox[] = [],
  /** Right side of the page text (including tables); when not provided, calculated based on peers and this block. */
  textRight?: number,
): { rows: Row[]; spaced: boolean; list: boolean }[] {
  const rows = rowsOf(lines);
  if (!rows.length) return [];
  const typical = median(rows.map((r) => median(r.lines.map((l) => l.height)))) || 1;
  const left = Math.min(...rows.map((r) => r.box.x));
  // Right edge: when line count is large, use the 80th percentile right-aligned position so that
  // exceptionally long lines (URLs, stray table content) do not push the right boundary outward.
  // Lines outside the block (peers) indicate the width of this column: when several short lines
  // form their own block, the widest line is not the right edge of the column. Lines that match the
  // block's height, lie on both its left and right sides, and contain other text within that line's
  // span are cross-column spanning lines and are excluded.
  const top = Math.min(...rows.map((r) => r.box.y));
  const bottom = Math.max(...rows.map((r) => r.box.y + r.box.height));
  const own = Math.max(...rows.map((r) => r.box.x + r.box.width));
  const beside = peers.filter(
    (q) => (q.x + q.width <= left || q.x >= own) && q.y < bottom && q.y + q.height > top,
  );
  const sameColumn = (p: OcrBox) => !beside.some((q) => q.x < p.x + p.width && q.x + q.width > p.x);
  // Left-aligned lines: lines that are left-aligned, have similar font heights, and are vertically adjacent (within three line heights).
  const column = peers.filter(
    (p) =>
      Math.abs(p.x - left) <= typical &&
      Math.abs(p.height - typical) <= 0.5 * typical &&
      Math.max(p.y - bottom, top - (p.y + p.height)) <= 3 * typical &&
      sameColumn(p),
  );
  const rights = [
    ...rows.map((r) => r.box.x + r.box.width),
    ...column.map((p) => p.x + p.width),
  ].sort((a, b) => a - b);
  const right =
    rights.length >= 5 ? rights[Math.floor((rights.length - 1) * 0.85)]! : rights.at(-1)!;
  // Centered lines: centered lines can be as wide as any line crossing the block's centerline.
  const middle = (left + own) / 2;
  const centeredWidth = Math.max(
    own - left,
    ...peers
      .filter((p) => p.x <= middle && p.x + p.width >= middle && sameColumn(p))
      .map((p) => p.width),
  );
  // The right boundary where text in this block can extend: the right edge of the block, or the
  // left edge of the nearest other text (in another column or block) within three line heights
  // vertically, defaulting to the right edge of the page text if none exists.
  const roomRight = Math.min(
    textRight ?? Math.max(own, ...peers.map((p) => p.x + p.width)),
    ...peers
      .filter((p) => p.x >= own && p.y < bottom + 3 * typical && p.y + p.height > top - 3 * typical)
      .map((p) => p.x),
  );
  const out: { rows: Row[]; spaced: boolean; list: boolean }[] = [];
  for (const [i, row] of rows.entries()) {
    const prev = rows[i - 1];
    const marker = listStart(row.text);
    const list = marker && /[\p{L}\p{N}]/u.test(stripMarker(row.text));
    const rangeTail =
      prev !== undefined && /\d[-–—]\s*$/.test(prev.text) && /^\s*\d+\.\s*$/.test(row.text);
    // Bare numbering is retained as an independent label; only a tail immediately following a number range can be appended as a wrap, and it cannot be treated as a new list.
    const bareLabel = marker && !list && !rangeTail;
    const gap = prev ? row.box.y - (prev.box.y + prev.box.height) : 0;
    const h = median(row.lines.map((l) => l.height));
    const prevH = prev ? median(prev.lines.map((l) => l.height)) : h;
    // Centered lines of text (letterheads, prescription headers, D-463): centerline-aligned and left-ragged, representing individual lines rather than wrapped text.
    const centerShift = prev
      ? Math.abs(prev.box.x + prev.box.width / 2 - (row.box.x + row.box.width / 2))
      : 0;
    const leftShift = prev ? Math.abs(prev.box.x - row.box.x) : 0;
    // Two lines with nearly matching left margins and much more precisely aligned centerlines are
    // also treated as centered (left-aligned lines typically have only a few pixels of jitter on
    // the left): if the first word of the next line fits within the allowable centered width yet a
    // line break occurred, it is a sequence of individual lines rather than wrapped text.
    const centeredLines =
      prev !== undefined &&
      centerShift <= CENTER_PAIR * typical &&
      leftShift > 0.2 * typical &&
      centerShift < leftShift / 4 &&
      prev.box.width + firstWordWidth(row) <= centeredWidth + 0.3 * typical;
    const centeredPair =
      prev !== undefined &&
      ((centerShift <= CENTER_PAIR * typical && leftShift > 0.5 * typical) || centeredLines);
    // Rows containing `"label: value"` on both left and right sides are independent information
    // lines, not wraps of the preceding prose paragraph. Consider only fields outside groups and
    // separated by a column; two-column body text aligned by coincidence or continuation lines of
    // field values are not split accordingly.
    const field = (text: string) => /^[^:：.!?。！？\n]{1,30}[:：]\s*\S/u.test(text.trim());
    const fieldRow =
      field(row.text) &&
      peers.some((p) => {
        const gap = Math.max(p.x - (row.box.x + row.box.width), row.box.x - (p.x + p.width));
        const overlap =
          Math.min(p.y + p.height, row.box.y + row.box.height) - Math.max(p.y, row.box.y);
        return (
          gap > ROW_SPLIT * typical &&
          overlap > 0.7 * Math.min(p.height, row.box.height) &&
          field(p.text)
        );
      });
    // A stack of short lines (addresses, letterheads, receipt fields): a line break occurring even
    // though the first word of the next line could fit after the previous line (with plenty of
    // space remaining to the next text block or page right edge) indicates they were written as
    // separate lines rather than wrapped text (EU samples 023, 025, 029).
    const roomy =
      prev !== undefined &&
      [...prev.text].length <= LABEL_MAX &&
      [...row.text].length <= LABEL_MAX &&
      prev.box.x + prev.box.width + firstWordWidth(row) + ROOM_GUTTER * typical < roomRight;
    // Two short lines separated by nearly a line height (e.g., an `"email:"` line separated by a
    // blank line after an address), or separated by half a line height while each corresponds to a
    // distantly separated line of text on the left (e.g., the right-hand column of clauses with `"○
    // ja ○ nein"`, EU samples 041, 049): written as separate lines rather than wrapped text. Prose
    // wraps have only minimal line spacing.
    const facing = (r: Row) =>
      peers.find(
        (p) =>
          p.x + p.width < left - ROW_SPLIT * typical &&
          Math.min(p.y + p.height, r.box.y + r.box.height) - Math.max(p.y, r.box.y) >=
            0.5 * Math.min(p.height, r.box.height),
      );
    // Receipt or price list items consisting of one line each: two short lines separated
    // horizontally with each having its own amount on the same row (EU sample 003), representing
    // separate items rather than a wrap (the second line of a wrap would not have a separate amount
    // on the right).
    const priced = (r: Row) =>
      peers.find(
        (p) =>
          p.x > r.box.x + r.box.width + ROW_SPLIT * typical &&
          isAmount(p.text) &&
          Math.min(p.y + p.height, r.box.y + r.box.height) - Math.max(p.y, r.box.y) >=
            0.5 * Math.min(p.height, r.box.height),
      );
    const apart =
      prev !== undefined &&
      [...prev.text].length <= LABEL_MAX &&
      [...row.text].length <= LABEL_MAX &&
      ((priced(prev) !== undefined && priced(row) !== undefined && priced(prev) !== priced(row)) ||
        gap >= SHORT_APART * typical ||
        (gap >= SHORT_BESIDE * typical &&
          facing(prev) !== undefined &&
          facing(row) !== undefined &&
          facing(prev) !== facing(row)));
    const wrapped =
      prev !== undefined &&
      !centeredPair &&
      !fieldRow &&
      !roomy &&
      !apart &&
      // Lines ending with fill-in prompts (e.g., `"Name ……"`) are individual lines rather than wraps.
      !ENDS_WITH_FILL.test(prev.text) &&
      gap <= PARAGRAPH_GAP * typical &&
      (prev.box.x + prev.box.width >= right - 1.2 * typical ||
        !fitsOnPrev(prev, row, right, typical)) &&
      prev.box.width >= 0.6 * (right - left) &&
      // The left side is close to the leftmost line in the block, or left-aligned with the previous line (after block expansion, the leftmost line may belong to a different paragraph).
      (row.box.x <= left + typical || Math.abs(row.box.x - prev.box.x) <= 0.5 * typical) &&
      !list &&
      !bareLabel &&
      Math.abs(h - prevH) <= 0.3 * Math.max(h, prevH);
    // An indented line immediately following a list item (hanging indent) is a wrap of that item.
    const last = out.at(-1);
    const hanging =
      last?.list === true &&
      prev !== undefined &&
      !fieldRow &&
      !ENDS_WITH_FILL.test(prev.text) &&
      gap <= PARAGRAPH_GAP * typical &&
      !list &&
      !bareLabel &&
      row.box.x > last.rows[0]!.box.x + 0.3 * typical &&
      prev.box.x + prev.box.width >= right - 2 * typical;
    if ((wrapped || hanging) && last) last.rows.push(row);
    else out.push({ rows: [row], spaced: gap > PARAGRAPH_GAP * typical, list });
  }
  return out;
}

/** Stroke width of a line (median of contiguous dark pixels horizontally) as a ratio of the line height. Returns 0 when there are no dark pixels. */
export function strokeRatio(image: RgbaImage, box: Box): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y0 = Math.max(0, Math.floor(box.y + box.height * 0.2));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height * 0.8));
  if (x1 - x0 < 2 || y1 - y0 < 1) return 0;
  const { data, width } = image;
  const lum = (o: number) => (data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) / 1000;
  let lo = 255;
  let hi = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const v = lum((y * width + x) * 4);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi - lo < 40) return 0;
  const cut = (lo + hi) / 2;
  const runs: number[] = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = x0; x < x1; x++) {
      if (lum((y * width + x) * 4) < cut) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    if (run) runs.push(run);
  }
  // Long continuous segments are ruled lines (underlines, strikethroughs) and are not counted as strokes.
  const strokes = runs.filter((r) => r < box.height * 0.6);
  return strokes.length ? median(strokes) / box.height : 0;
}

/** Color of text pixels (RRGGBB); returns undefined for black or gray. */
export function textColor(image: RgbaImage, box: Box): string | undefined {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y0 = Math.max(0, Math.floor(box.y));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  const { data, width } = image;
  const lums: number[] = [];
  for (let y = y0; y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
      const o = (y * width + x) * 4;
      lums.push((data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) / 1000);
    }
  if (lums.length < 4) return undefined;
  const sorted = lums.sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)]!;
  const hi = sorted[Math.floor(sorted.length * 0.9)]!;
  if (hi - lo < 40) return undefined;
  // The darkest subset of pixels (in the middle of strokes, unaffected by background blending).
  const cut = lo + (hi - lo) * 0.35;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      const v = (data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) / 1000;
      if (v <= cut) {
        r += data[o]!;
        g += data[o + 1]!;
        b += data[o + 2]!;
        n++;
      }
    }
  if (!n) return undefined;
  const rgb = [r / n, g / n, b / n].map(Math.round);
  if (Math.max(...rgb) - Math.min(...rgb) < COLOR_CHROMA) return undefined;
  return rgb
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Padding to leave around image regions when cropping (as a multiple of line height): must not exceed the gap between the image and neighboring text (0.3 line heights), otherwise side-by-side images and text would be stacked vertically. */
export const IMAGE_PAD = 0.15;

/** Product of line count and column count reaching this threshold, combined with very few cells, suggests a layout grid. */
const LAYOUT_MIN_POSITIONS = 40;

/** Cell count as a fraction of position count below this value indicates a layout grid (top half of W-9 is 0.13–0.15; true merged tables are generally above 0.38). */
const LAYOUT_MAX_FILL = 0.25;

/** Cell count below this ratio, where each cell averages this many lines of text, indicates that cells contain full paragraphs of text (W-4 is 0.29–0.35, 1.8 lines per cell) rather than data. */
const LAYOUT_MAYBE_FILL = 0.4;

const LAYOUT_LINES_PER_CELL = 1.5;

/** Cell count must reach this threshold before using the empty cell ratio to determine if a grid is a true table. */
const GRID_MIN_CELLS = 30;

/** Large grids where filled cells account for less than this fraction are produced by underlines and checkboxes in forms, not true tables. */
const GRID_MIN_FILLED = 0.35;

/**
 * Form underlines, signature lines, boxes, and text fused into a massive grid (common in scanned
 * forms): over 90% of cells are empty, and text inside non-empty cells is fragmented by vertical
 * lines. Such structures are not valid tables, and their text is arranged positionally as
 * ordinary text. The same applies to layout grids (many positions, few cells, large merged blocks
 * containing full paragraphs of text); however, true bordered tables (order forms, payslips) also
 * feature large merged blocks, so this check is applied only when cells are exceptionally few or
 * every cell contains a full paragraph. lineCount is the number of recognized lines falling
 * within this table.
 */
export function isRuleGrid(table: TableBlock, lineCount = 0): boolean {
  const positions = table.rows * table.cols;
  const fill = table.cells.length / Math.max(1, positions);
  if (positions >= LAYOUT_MIN_POSITIONS) {
    if (fill < LAYOUT_MAX_FILL) return true;
    if (fill < LAYOUT_MAYBE_FILL && lineCount >= LAYOUT_LINES_PER_CELL * table.cells.length)
      return true;
  }
  if (table.cells.length < GRID_MIN_CELLS) return false;
  const filled = table.cells.filter((c) => c.text.trim()).length;
  return filled < GRID_MIN_FILLED * table.cells.length;
}

/** Row number cells (such as the `"Lfd. Nr."` column 1, 2, 3 on the left of forms) are very short. */
const ROW_NUMBER_CHARS = 4;

/** Maximum number of header rows in a blank table. */
const HEADER_ROWS_MAX = 2;

/**
 * Blank tables designed for manual filling (EU samples 001, 004, 006): densely packed with
 * horizontal and vertical lines, with unmerged cells in lower rows (cells in each row split along
 * identical column lines), and text restricted to the header (one or two rows, where cells may
 * span multiple columns; at least two rows below are empty, with at most a number in the first
 * cell of each row) or limited to the first column (labels), where empty cells on the right are
 * at least as wide as the label (unlike agendas, certificate borders, or test answer sheets where
 * empty columns are narrower than text-containing ones, see `isSparseColumnLayout`). Such tables
 * are not discarded as form line art due to having too many empty cells.
 */
export function isBlankFormGrid(table: TableBlock): boolean {
  if (table.rows < 2) return false;
  const rows = Array.from({ length: table.rows }, (_, r) =>
    table.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col),
  );
  const starts = (row: readonly TableCell[]) => row.map((c) => c.col).join(',');
  /** Cells in each row starting from row from split along identical column lines without spanning multiple rows. */
  const regular = (from: number) =>
    rows[from]!.length >= 2 &&
    rows
      .slice(from)
      .every((row) => row.every((c) => c.rowSpan === 1) && starts(row) === starts(rows[from]!));
  const has = (c: TableCell) => c.text.trim() !== '';
  // Header row (or two rows, if separated by a short horizontal dash in the header) containing text
  // and cells spanning multiple columns, followed by at least two identical empty rows (where the
  // first cell may be a sequence number).
  for (let k = 1; k <= HEADER_ROWS_MAX && k + 2 <= table.rows; k++) {
    const head = rows.slice(0, k).flat();
    if (head.some((c) => c.row + c.rowSpan > k) || !regular(k)) continue;
    const filled = head.filter(has).length;
    if (
      filled >= 2 &&
      filled * 2 >= head.length &&
      rows
        .slice(k)
        .every((row) =>
          row.every((c, i) => !has(c) || (i === 0 && c.text.trim().length <= ROW_NUMBER_CHARS)),
        )
    )
      return true;
  }
  // The first column contains labels, while right-hand cells are empty and at least as wide as the labels.
  if (!regular(0)) return false;
  const widthOf = (cells: readonly TableCell[]) =>
    cells.reduce((sum, c) => sum + (c.box?.width ?? 0), 0);
  return rows.every(
    ([label, ...rest]) =>
      has(label!) &&
      rest.every((c) => !has(c)) &&
      widthOf([label!]) > 0 &&
      widthOf(rest) >= widthOf([label!]),
  );
}

/** Maximum number of lines for a label inside a fillable box. */
const FIELD_LABEL_LINES = 2;

/** Fillable box: label bottom does not exceed this fraction of cell height (label is positioned at the top, leaving room below for writing). */
const FIELD_LABEL_SHARE = 0.5;

/** At least this many labeled fillable boxes connected together are required to treat them as a table. */
const FIELD_MIN_BOXES = 2;

/** At least this many columns. */
const FIELD_MIN_COLS = 2;

/**
 * Forms with fully drawn lines (Polish PIT-37, German Antrag, EU sample 062): sections of boxes,
 * each box with a short tag at the top left (e.g., "10. Nazwisko"), leaving the rest empty for
 * people to write in. Because the positions of the boxes in full-page grids vary across rows and
 * contain many empty cells, they are treated as ruled grids (isRuleGrid) and dropped entirely,
 * removing the boxes and leaving nowhere to write. Here, such grids are split row by row (at
 * horizontal lines not crossed by any cell), and if multiple consecutive rows contain filled
 * cells acting as input boxes (at most two lines of text, aligned to the top of the cell with at
 * least one line height of empty space below), they are extracted as a table; other rows
 * (explanatory text, option box sections, section title bars) are rendered as normal text. The
 * returned table starts from column 0, and colWidths represents its own column widths.
 */
export function fieldBoxTables(
  table: TableBlock,
  colWidths: readonly number[],
  placed: readonly OcrBox[],
  lineHeight: number,
): { table: TableBlock; colWidths: number[] }[] {
  const inCell = (l: Box, c: Box) => {
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    return cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height;
  };
  const isField = (c: TableCell) => {
    const box = c.box;
    if (!box) return false;
    const own = placed.filter((l) => inCell(l, box));
    if (!c.text.trim()) return !own.length;
    if (!own.length || rowsOf(own).length > FIELD_LABEL_LINES) return false;
    const top = Math.min(...own.map((l) => l.y)) - box.y;
    const bottom = Math.max(...own.map((l) => l.y + l.height)) - box.y;
    return (
      top <= lineHeight &&
      bottom <= FIELD_LABEL_SHARE * box.height &&
      box.height - bottom >= lineHeight
    );
  };
  // Where the grid is split row by row: no cells cross from above.
  const cuts = [0];
  for (let r = 1; r < table.rows; r++)
    if (!table.cells.some((c) => c.row < r && r < c.row + c.rowSpan)) cuts.push(r);
  cuts.push(table.rows);
  const slabs = cuts.slice(1).map((end, i) => {
    const cells = table.cells.filter((c) => c.row >= cuts[i]! && c.row < end);
    const ok = cells.length > 0 && cells.some((c) => c.text.trim()) && cells.every(isField);
    return { from: cuts[i]!, to: end, cells, ok };
  });
  const groups: (typeof slabs)[] = [];
  let run: typeof slabs = [];
  for (const s of [...slabs, undefined]) {
    if (s?.ok) run.push(s);
    else {
      if (run.length) groups.push(run);
      run = [];
    }
  }
  const out: { table: TableBlock; colWidths: number[] }[] = [];
  for (const group of groups) {
    let cells = group.flatMap((s) => s.cells);
    if (cells.filter((c) => c.text.trim()).length < FIELD_MIN_BOXES) continue;
    // Empty cells on both the far left and far right sides represent margins next to the inner and outer frames (e.g., the address box on the right of EU sample 004), not input fields.
    for (;;) {
      const first = Math.min(...cells.map((c) => c.col));
      const last = Math.max(...cells.map((c) => c.col + c.colSpan));
      // Right side: cells starting from the rightmost column all begin at the same column line; the left side is the opposite. Only remove this column if all cells within it are empty.
      const rightFrom = Math.max(
        ...cells.filter((c) => c.col + c.colSpan === last).map((c) => c.col),
      );
      const leftTo = Math.min(
        ...cells.filter((c) => c.col === first).map((c) => c.col + c.colSpan),
      );
      const strips = [
        cells.filter((c) => c.col + c.colSpan > rightFrom),
        cells.filter((c) => c.col < leftTo),
      ];
      const strip = strips.find(
        (side, k) =>
          side.every((c) => !c.text.trim()) &&
          side.every((c) => (k === 0 ? c.col >= rightFrom : c.col + c.colSpan <= leftTo)),
      );
      if (!strip || strip.length === cells.length) break;
      cells = cells.filter((c) => !strip.includes(c));
    }
    const from = group[0]!.from;
    // Keep only the column lines used by these rows.
    const edges = [...new Set(cells.flatMap((c) => [c.col, c.col + c.colSpan]))].sort(
      (a, b) => a - b,
    );
    // Single-column, vertically stacked boxes ("Patient/in", "Anschrift" with only horizontal lines
    // on prescriptions, EU sample 076): mostly just writing lines; treating them as a table would
    // lose the writing area, so they are rendered as text instead.
    if (edges.length - 1 < FIELD_MIN_COLS) continue;
    const at = (col: number) => edges.indexOf(col);
    const boxes = cells.map((c) => c.box!);
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    out.push({
      table: {
        kind: 'table',
        rows: group[group.length - 1]!.to - from,
        col: 0,
        cols: edges.length - 1,
        cells: cells.map((c) => ({
          ...c,
          row: c.row - from,
          col: at(c.col),
          colSpan: at(c.col + c.colSpan) - at(c.col),
        })),
        box: {
          x,
          y,
          width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
          height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
        },
      },
      colWidths: edges
        .slice(1)
        .map((e, i) =>
          colWidths.slice(table.col + edges[i]!, table.col + e).reduce((a, b) => a + b, 0),
        ),
    });
  }
  return out;
}

/** Empty cells whose width is at least this many line heights are reserved as input columns and are not folded into the left side (foldEmptyColumns). */
const FILL_IN_LINES = 3;

/** Horizontal lines must cover at least this fraction of the cell width. */
/** Horizontal lines must cover at least this fraction of the cell width. */
const RULE_ACROSS_SHARE = 0.5;

/** Check whether there is a line spanning x0–x1 horizontally between y0 and y1 (the white gap between two lines of text): more than half of the pixels in a given row are dark. */
function ruleAcross(image: RgbaImage, x0: number, x1: number, y0: number, y1: number): boolean {
  const left = Math.max(0, Math.round(x0));
  const right = Math.min(image.width, Math.round(x1));
  if (right <= left) return false;
  const step = Math.max(1, Math.round((right - left) / 200));
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(image.height, Math.round(y1)); y++) {
    let dark = 0;
    let total = 0;
    for (let x = left; x < right; x += step) {
      const o = (y * image.width + x) * 4;
      total++;
      if (0.299 * image.data[o]! + 0.587 * image.data[o + 1]! + 0.114 * image.data[o + 2]! < 200)
        dark++;
    }
    if (dark >= RULE_ACROSS_SHARE * total) return true;
  }
  return false;
}

function isSparseColumnLayout(table: TableBlock): boolean {
  if (table.rows < 3 || table.cols < 2) return false;
  const filled = table.cells.filter((c) => c.text.trim());
  if (filled.length * 3 > table.cells.length * 2) return false;
  const counts = new Map<number, number>();
  for (const cell of filled) counts.set(cell.row, (counts.get(cell.row) ?? 0) + 1);
  const paired = [...counts.values()].filter((n) => n >= 2).length;
  if (paired >= 2) return false;
  // Attendance sheets: every column in the header row has text, and at least two rows below are entirely empty, indicating a form intended for manual entry rather than decoration.
  const rowsWith = new Set(filled.map((c) => c.row));
  const header = filled.filter((c) => c.row === filled[0]!.row);
  if (
    paired === 1 &&
    rowsWith.size === 1 &&
    header.reduce((n, c) => n + c.colSpan, 0) === table.cols &&
    table.rows - 1 >= 2
  )
    return false;
  // Blank forms: all labels are in the same column, and the right side is entirely empty and at
  // least as wide as the label column, indicating an input section. Decorative grids (agendas, exam
  // answer lines, certificate borders) have empty columns that are narrower than the text columns.
  if (!paired && filled.every((c) => c.colSpan === 1 && c.col === filled[0]!.col)) {
    const widthOf = (col: number) =>
      Math.max(
        0,
        ...table.cells
          .filter((c) => c.col === col && c.colSpan === 1 && c.box)
          .map((c) => c.box!.width),
      );
    const label = filled[0]!.col;
    for (let col = label + 1; col < table.cols; col++) {
      const blank = table.cells.every(
        (c) => !(c.col <= col && c.col + c.colSpan > col) || !c.text.trim(),
      );
      if (blank && widthOf(label) > 0 && widthOf(col) >= widthOf(label)) return false;
    }
  }
  // Columns shared across the entire page add empty cells to a merged table. When true column
  // relationships already exist in a row, fold these empty columns before checking density; do not
  // split densely filled merged tables into prose, which would cause extra page breaks in forms.
  const folded = paired ? foldEmptyColumns(table) : table;
  const occupied = folded.cells.filter((c) => c.text.trim()).length;
  return occupied * 3 <= folded.cells.length * 2;
}

/** If at least this many lines and this proportion of text are cut through the middle of words by column lines, the grid detection is considered incorrect (D-502). */
export const CHOP_MIN = 2;

export const CHOP_SHARE = 0.3;

/** Box height is more than this multiple of its width and contains at least two characters: vertical or rotated text. */
const VERTICAL_RATIO = 2;

export const isVertical = (l: Box & { text: string }) =>
  l.height > VERTICAL_RATIO * l.width && l.text.replace(/\s/g, '').length >= 2;

/** Group vertical lines into blocks by position (closely adjacent ones are connected), leave a small margin around each block, and crop them into images. */
export function verticalBoxes(
  lines: readonly Box[],
  lineHeight: number,
  page: { width: number; height: number },
): Box[] {
  const groups: Box[] = [];
  for (const line of [...lines].sort((a, b) => a.x - b.x)) {
    const near = groups.findIndex(
      (g) =>
        line.x <= g.x + g.width + lineHeight &&
        line.x + line.width >= g.x - lineHeight &&
        line.y <= g.y + g.height + lineHeight &&
        line.y + line.height >= g.y - lineHeight,
    );
    if (near >= 0) groups[near] = unionBox([groups[near]!, line]);
    else groups.push({ ...line });
  }
  const pad = 0.3 * lineHeight;
  return groups.map((g) => {
    const x = Math.max(0, g.x - pad);
    const y = Math.max(0, g.y - pad);
    return {
      x,
      y,
      width: Math.min(page.width, g.x + g.width + pad) - x,
      height: Math.min(page.height, g.y + g.height + pad) - y,
    };
  });
}

/**
 * Text that reads like a page number: "3", "- 3 -", "2/3", "Page 2 of 5", "Seite 2 von 3", "iv",
 * "Page 2". Only drop such strings in the page number area, leaving everything else as body text.
 */
const PAGE_NUMBER =
  /^\s*[-–—]?\s*(?:(?:pages?|pg|p|seite|s|pagina|pag|página|pág|strona|str|sida|side|blz|bladzijde|folio|fol|стр|第)\.?\s*)?(?:\d{1,4}|(?=[ivxlc])c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))(?:\s*(?:\/|of|von|de|di|sur|su|z|av|van|из|共)\s*\d{1,4})?\s*页?\s*[-–—]?\s*$/i;

/** Margin stray artifacts (D-334): no more than this number of characters (excluding spaces). */
const STRAY_CHARS = 3;

/** Considered isolated if separated from other text by at least this many line heights. */
const STRAY_GAP = 3;

/** If confidence is lower than this, or the box is higher than the body text line height by this multiple (smudges, signatures), it does not look like text. */
const STRAY_SCORE = 0.7;

const STRAY_TALL = 2;

/** Touching the page margin: distance to the image edge is less than this fraction (1%) of the longer side. */
const STRAY_EDGE = 0.01;

/** At least this fraction of points in the box are not white paper (dark or colored background): text printed on a colored stripe. */
const STRAY_ON_FILL = 0.5;

/** Calculate the proportion of non-white points in the box (sampled at alternate points): white text printed on a colored stripe ("A1" on a form header green stripe) consists mostly of the background color. */
function fillShare(line: OcrBox, image: RgbaImage): number {
  const x0 = Math.max(0, Math.floor(line.x));
  const y0 = Math.max(0, Math.floor(line.y));
  const x1 = Math.min(image.width, Math.ceil(line.x + line.width));
  const y1 = Math.min(image.height, Math.ceil(line.y + line.height));
  let fill = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * image.width + x) * 4;
      const min = Math.min(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
      n++;
      if (min < 200) fill++;
    }
  }
  return n ? fill / n : 0;
}

/**
 * Margin stray artifacts (D-334): very short, isolated (separated from other text by at least 3
 * line heights), touching the page margin, with low confidence or a box much taller than the body
 * text, are considered margin smudges, binding holes, or signatures misidentified as text (e.g.,
 * "00" at the top of a terms page) and are not written to the file. Accurately recognized short
 * text of normal body height is retained. Short text that is tall and does not touch margins,
 * printed on a colored stripe (white text, box mostly background), represents form codes (e.g.,
 * "A1" in EU sample 056) and is also retained.
 */
function isStray(
  line: OcrBox,
  all: readonly OcrBox[],
  lineHeight: number,
  page: RgbaImage,
): boolean {
  if (line.text.replace(/\s/g, '').length > STRAY_CHARS) return false;
  const edge = Math.max(page.width, page.height) * STRAY_EDGE;
  const atEdge =
    line.x <= edge ||
    line.y <= edge ||
    line.x + line.width >= page.width - edge ||
    line.y + line.height >= page.height - edge;
  const unsure = line.score !== undefined && line.score < STRAY_SCORE;
  const tall = line.height > STRAY_TALL * lineHeight;
  if (!atEdge && !unsure && !tall) return false;
  if (!atEdge && !unsure && fillShare(line, page) >= STRAY_ON_FILL) return false;
  return all.every((o) => {
    if (o === line) return true;
    const dx = Math.max(0, Math.max(o.x, line.x) - Math.min(o.x + o.width, line.x + line.width));
    const dy = Math.max(0, Math.max(o.y, line.y) - Math.min(o.y + o.height, line.y + line.height));
    return Math.max(dx, dy) > STRAY_GAP * lineHeight;
  });
}

/** Widths of ASCII characters in Arial (in units of 1/1000 of the font size, 32–126). */
const ARIAL_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/**
 * Number of font-size widths a line of text occupies in Arial (D-463): accented letters are
 * treated as unaccented, CJK characters and full-width symbols count as 1, and other scripts
 * (Cyrillic, Greek) count as 0.556.
 */
export function textEm(text: string): number {
  let em = 0;
  for (const ch of text.trim().normalize('NFD')) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x300 && code < 0x370) continue;
    if (code >= 32 && code <= 126) em += ARIAL_WIDTHS[code - 32]! / 1000;
    else if (code >= 0x2e80) em += 1;
    else em += 0.556;
  }
  return em;
}

/** Estimated font size (in pixels) based on character width; returns 0 if there are too few characters. */
function widthSizeOf(line: OcrBox): number {
  const n = line.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const em = textEm(line.text);
  return n >= WIDTH_MIN_CHARS && em > 0 ? line.width / em : 0;
}

/**
 * Check whether text has an underline below it (D-463): between the lower part of the box and 0.3
 * line heights below the box, a row of pixels is more than 90% dark, and this line disappears
 * outside the left and right edges of the text (extending by 0.6 line heights on each side).
 * Longer lines are dividers or table borders, not underlines for this line of text.
 */
export function hasUnderline(image: RgbaImage, box: Box): boolean {
  const { data, width, height } = image;
  const x0 = Math.max(0, Math.floor(box.x + box.width * 0.03));
  const x1 = Math.min(width, Math.ceil(box.x + box.width * 0.97));
  const y0 = Math.max(0, Math.floor(box.y + box.height * 0.7));
  const y1 = Math.min(height, Math.ceil(box.y + box.height * 1.3));
  if (x1 - x0 < 4 || y1 <= y0) return false;
  const lum = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    return (data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) / 1000;
  };
  let lo = 255;
  let hi = 0;
  for (let y = Math.max(0, Math.floor(box.y)); y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
      const v = lum(x, y);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (hi - lo < 40) return false;
  const cut = (lo + hi) / 2;
  const outL = Math.round(box.x - 0.6 * box.height);
  const outR = Math.round(box.x + box.width + 0.6 * box.height);
  for (let y = y0; y < y1; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (lum(x, y) < cut) dark++;
    if (dark < 0.9 * (x1 - x0)) continue;
    const beyond = [outL, outR].some((x) => x >= 0 && x < width && lum(x, y) < cut);
    if (!beyond) return true;
  }
  return false;
}

/** Estimated font size in points based on line height (rounded to the nearest half point). */
export function fontSizeOf(lineHeightPx: number, pageWidthPx: number): number {
  const pt = (lineHeightPx * A4_WIDTH_PT * BOX_TO_FONT) / pageWidthPx;
  return Math.min(48, Math.max(6, Math.round(pt * 2) / 2));
}

/** Bullet list item numbering style. */
function listMarker(text: string): { ordered: boolean; format?: string; start?: number } {
  const m = ORDERED.exec(text);
  if (!m) return { ordered: false };
  if (m[4]) return { ordered: true, format: '%1', start: m[4].charCodeAt(0) - 0x2460 + 1 };
  if (m[3]) return { ordered: true, format: '(%1)', start: Number(m[3]) };
  return { ordered: true, format: `%1${m[2] === '）' ? ')' : m[2]}`, start: Number(m[1]) };
}

const stripMarker = (text: string) => text.replace(ORDERED, '').replace(BULLET, '').trim();

/**
 * Fold cells that are empty across an entire column into the cell to the left (D-328): when
 * exporting to Excel, a uniform set of column lines is shared across the page (D-272), causing a
 * table to have extra columns present only in other tables, which appear as columns of empty
 * cells in Word. Only cells without row spans are folded; column lines remain unchanged (cells
 * span across using colSpan).
 */
export function foldEmptyColumns(table: TableBlock, keepWidth = Infinity): TableBlock {
  let cells = table.cells;
  for (let c = table.cols - 1; c > 0; c--) {
    const at = (r: number, col: number) =>
      cells.find(
        (x) => x.row <= r && r < x.row + x.rowSpan && x.col <= col && col < x.col + x.colSpan,
      );
    const pairs: { left: TableCell; empty: TableCell }[] = [];
    let ok = true;
    for (let r = 0; r < table.rows && ok; r++) {
      const empty = at(r, c);
      const left = at(r, c - 1);
      // This row already has a cell spanning across this column line: do not fold.
      if (empty && empty === left) continue;
      ok =
        !!empty &&
        !!left &&
        empty.col === c &&
        !empty.text.trim() &&
        empty.rowSpan === 1 &&
        left.rowSpan === 1;
      if (ok) pairs.push({ left: left!, empty: empty! });
    }
    if (!ok || !pairs.length) continue;
    // Input fields: empty cells are wide enough (keepWidth, in pixels) to be reserved for user input.
    if (pairs.every((p) => (p.empty.box?.width ?? 0) >= keepWidth)) continue;
    const drop = new Set(pairs.map((p) => p.empty));
    const grow = new Map(pairs.map((p) => [p.left, p.empty.colSpan]));
    cells = cells
      .filter((x) => !drop.has(x))
      .map((x) => (grow.has(x) ? { ...x, colSpan: x.colSpan + grow.get(x)! } : x));
  }
  return cells === table.cells ? table : { ...table, cells };
}

/** Default joining method (for testing): lines in a paragraph are joined with spaces (no spaces between Chinese characters). */
function defaultJoin(lines: readonly OcrBox[]): string {
  return rowsOf(lines)
    .map((r) => r.text)
    .join(' ');
}

/** A3 dimensions in points (short: 841.9, long: 1190.6); paper larger than this is considered incorrectly measured. */
const A3_PT = { short: 841.9, long: 1190.6 };

const A3_SLACK = 1.05;

/**
 * PDF pages larger than A3 (scans stored at 1 pixel = 1 point, e.g., 87 x 124 cm) are not mapped
 * directly to Word page dimensions: they are scaled to A4 width based on their original aspect
 * ratio (landscape uses A4 long side), just like photos without paper metadata. Font sizes are
 * estimated based on A4 width so that the ratio of text to paper remains correct.
 */
export function fitPaper(paper: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const short = Math.min(paper.width, paper.height);
  const long = Math.max(paper.width, paper.height);
  if (short <= A3_PT.short * A3_SLACK && long <= A3_PT.long * A3_SLACK) return paper;
  const width = paper.width > paper.height ? 841.9 : 595.3;
  return { width, height: Math.round(((width * paper.height) / paper.width) * 10) / 10 };
}

/** Restored figures and adjacent blocks are still considered side-by-side if their horizontal overlap does not exceed this fraction of the narrower block's width. */
const FIGURE_EDGE_OVERLAP = 0.05;

/** Preserve text and source order when restoring native full-page figures; page-margin figures spanning multiple horizontal bands share a layout table with those bands. */
export function insertWordFigures(page: DocPage, boxes: readonly Box[]): DocPage {
  const owned = (b: DocLeaf) => boxes.some((box) => lineShareIn(b.box, box) >= 0.8);
  const blocks = page.blocks.flatMap((b): DocBlock[] => {
    if (b.kind !== 'row') return owned(b) ? [] : [b];
    const cells = b.cells
      .map((c) => ({ ...c, blocks: c.blocks.filter((x) => !owned(x)) }))
      .filter((c) => c.blocks.length);
    return cells.length
      ? [{ ...b, box: unionBox(cells.flatMap((c) => c.blocks.map((x) => x.box))), cells }]
      : [];
  });
  for (const box of [...boxes].sort((a, b) => b.width - a.width)) {
    const image: DocImage = { kind: 'image', box };
    if (box.width < page.width * 0.12 && box.height > box.width * 3) {
      const band = blocks.filter((b) => {
        const overlap =
          Math.min(b.box.y + b.box.height, box.y + box.height) - Math.max(b.box.y, box.y);
        return (
          overlap >= Math.min(b.box.height, box.height) * 0.3 &&
          leafBlocks({ blocks: [b] }).every(
            (l) => box.x + box.width <= l.box.x + 2 || box.x >= l.box.x + l.box.width - 2,
          )
        );
      });
      if (band.length > 1) {
        const content = leafBlocks({ blocks: band });
        const bounds = unionBox(content.map((b) => b.box));
        const left = box.x < bounds.x;
        const cells = left
          ? [
              { width: bounds.x - box.x, blocks: [image] },
              { width: bounds.width, blocks: content },
            ]
          : [
              { width: box.x - bounds.x, blocks: content },
              { width: box.width, blocks: [image] },
            ];
        const index = blocks.indexOf(band[0]!);
        const next: DocRow = { kind: 'row', box: unionBox([bounds, box]), cells };
        blocks.splice(index, 1, next);
        for (const b of band.slice(1)) blocks.splice(blocks.indexOf(b), 1);
        continue;
      }
    }
    // Figures within a column (restricted to a specific column) are placed back into that column and inserted according to their vertical position, without moving them to the end of the multi-column row.
    const column = blocks.flatMap((b) => {
      if (b.kind !== 'row' || b.cells.length < 2) return [];
      const overlap =
        Math.min(b.box.y + b.box.height, box.y + box.height) - Math.max(b.box.y, box.y);
      if (overlap < 0.5 * box.height) return [];
      const xs = b.cells.map((c) => Math.min(...c.blocks.map((x) => x.box.x)));
      const cell = b.cells.findIndex((_, i) => {
        const right = xs[i + 1] ?? b.box.x + b.box.width;
        const inside = Math.min(right, box.x + box.width) - Math.max(xs[i]!, box.x);
        return inside >= 0.8 * box.width;
      });
      return cell >= 0 ? [{ row: b, cell: b.cells[cell]! }] : [];
    })[0];
    if (column) {
      const { row, cell } = column;
      const at = cell.blocks.findIndex((b) => b.box.y > box.y);
      cell.blocks.splice(at < 0 ? cell.blocks.length : at, 0, image);
      row.box = unionBox([row.box, box]);
      continue;
    }
    const index = blocks.findIndex((b) => {
      const overlap =
        Math.min(b.box.y + b.box.height, box.y + box.height) - Math.max(b.box.y, box.y);
      // Evaluate side-by-side rows based on the blocks inside the cells (the middle image might
      // fall within the row's range and between two cells). Cropped images retain a small margin,
      // and adjacent bounding boxes often overlap by a few pixels; this is not considered
      // occlusion, and an image must not be removed from the row for this reason.
      return (
        overlap >= 0.3 * Math.min(b.box.height, box.height) &&
        leafBlocks({ blocks: [b] }).every((x) => {
          const across =
            Math.min(x.box.x + x.box.width, box.x + box.width) - Math.max(x.box.x, box.x);
          return across <= FIGURE_EDGE_OVERLAP * Math.min(x.box.width, box.width);
        })
      );
    });
    if (index >= 0) {
      const old = blocks[index]!;
      const cells = (
        old.kind === 'row' ? old.cells : [{ width: old.box.width, blocks: [old] }]
      ).concat([{ width: box.width, blocks: [image] }]);
      const slots = cells
        .map((c) => ({
          cell: c,
          x: Math.min(...c.blocks.map((b) => b.box.x)),
          right: Math.max(...c.blocks.map((b) => b.box.x + b.box.width)),
        }))
        .sort((a, b) => a.x - b.x);
      blocks[index] = {
        kind: 'row',
        box: unionBox([old.box, box]),
        cells: slots.map((s, i) => ({ ...s.cell, width: (slots[i + 1]?.x ?? s.right) - s.x })),
      };
    } else {
      const index = blocks.findIndex((b) => {
        const body = leafBlocks({ blocks: [b] }).filter((x) => x.kind !== 'image');
        return (body.length ? Math.min(...body.map((x) => x.box.y)) : b.box.y) > box.y;
      });
      blocks.splice(index < 0 ? blocks.length : index, 0, image);
    }
  }
  return { ...page, blocks };
}

/** Photos more portrait-oriented (height/width ratio) than this are not treated as a single page (receipts, long screenshots): no page size is set, and they are laid out continuously on A4 using the old style with natural page breaks. */
const PAGE_LIKE_RATIO = 1.6;

/** Use A4 directly when the photo's aspect ratio differs from A4 by less than this amount. */
const A4_ASPECT_SNAP = 0.03;

/**
 * Photos without physical dimensions estimate paper size based on A4 width (landscape uses A4
 * long side), with the paper aspect ratio matching the photo: maintaining the same proportions in
 * both dimensions without squishing. Photos more portrait-oriented than a single page (receipts)
 * have no page size set and are laid out continuously on A4 with natural page breaks using the
 * old style, avoiding awkward narrow and long pages.
 */
function photoPaper(image: { width: number; height: number }) {
  if (image.width > image.height)
    return { width: 841.9, height: (841.9 * image.height) / image.width };
  const ratio = image.height / image.width;
  if (Math.abs(ratio / (841.9 / 595.3) - 1) <= A4_ASPECT_SNAP)
    return { width: 595.3, height: 841.9 };
  return ratio > PAGE_LIKE_RATIO ? undefined : { width: 595.3, height: 595.3 * ratio };
}

/**
 * Join line-wrapped list items that were split into another block by the layout model (EU samples
 * 026, 027): a paragraph immediately following a list, aligned with the list items on the left
 * (indented further right than the bullet), no wider than the list, and sharing the same font
 * size and style, is joined back to the last item.
 */
export function joinListContinuations(blocks: readonly DocBlock[], lineHeight: number): DocBlock[] {
  const out: DocBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'row') {
      out.push({
        ...b,
        cells: b.cells.map((c) => ({
          ...c,
          blocks: joinListContinuations(c.blocks, lineHeight) as DocLeaf[],
        })),
      });
      continue;
    }
    const list = out.at(-1);
    if (
      list?.kind === 'list' &&
      !list.ordered &&
      !list.itemRuns &&
      b.kind === 'paragraph' &&
      !b.heading &&
      !b.runs &&
      !b.tab &&
      !b.align &&
      !listStart(b.text) &&
      b.box.y - (list.box.y + list.box.height) <= PARAGRAPH_GAP * lineHeight &&
      b.box.y >= list.box.y + list.box.height - 0.5 * lineHeight &&
      b.box.x - list.box.x >= 0.5 * lineHeight &&
      b.box.x - list.box.x <= 3 * lineHeight &&
      b.box.x + b.box.width <= list.box.x + list.box.width + lineHeight &&
      b.size === list.size &&
      b.bold === list.bold &&
      b.underline === list.underline &&
      b.color === list.color
    ) {
      const items = [...list.items];
      items[items.length - 1] = `${items.at(-1)!} ${b.text.replace(/\n/g, ' ')}`;
      out[out.length - 1] = {
        ...list,
        items,
        box: unionBox([list.box, b.box]),
      };
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * Layout models often split a sentence in the middle (body text with similar line spacing and
 * paragraph spacing, where each "paragraph" is only one or two lines). Two vertically adjacent
 * body regions (gap not exceeding one line height) that are left-aligned and overlap in width are
 * merged into one, deferring segmentation decisions to line-wrapping logic (whether the next word
 * fits on the right). Regions in left and right columns have unaligned left edges and are not
 * merged.
 */
export function mergeTextRegions<T extends { kind: string; box: Box }>(
  regions: readonly T[],
  lineHeight: number,
): T[] {
  const sorted = [...regions].sort((a, b) => a.box.y - b.box.y);
  const out: T[] = [];
  for (const r of sorted) {
    const idx = out.findIndex((o) => {
      if (o.kind !== 'text' || r.kind !== 'text') return false;
      const gap = r.box.y - (o.box.y + o.box.height);
      const ov =
        Math.min(o.box.x + o.box.width, r.box.x + r.box.width) - Math.max(o.box.x, r.box.x);
      return (
        gap <= lineHeight &&
        gap >= -0.5 * lineHeight &&
        Math.abs(o.box.x - r.box.x) <= lineHeight &&
        ov >= 0.8 * Math.min(o.box.width, r.box.width)
      );
    });
    if (idx >= 0) out[idx] = { ...out[idx]!, box: unionBox([out[idx]!.box, r.box]) };
    else out.push(r);
  }
  return out;
}

/** A text block (a region or a cluster grouped by position); pairs contains matched form labels and values (D-332). */
interface Group {
  lines: OcrBox[];
  title: 0 | 1 | 2;
  box: Box;
  pairs?: [OcrBox[], OcrBox[]][];
  /** Separated label column and content column: label and content columns are no longer paired by colons (rows in the two columns do not correspond one-to-one). */
  side?: 'label' | 'content';
  /** Original model region; unassigned lines are used when absent. Used only during construction, not written to file. */
  region?: Box;
}

/**
 * Model regions are ownership hints, not paragraph boundaries. Only reattach unassigned fragments
 * or line wraps split by nested regions; parallel regions, headings, form columns, and true
 * paragraph spacing/indentation are preserved, and each full line enters at most one group.
 */
function reconcileTextGroups(
  groups: readonly Group[],
  lines: readonly OcrBox[],
  h: number,
  compatible: (a: readonly OcrBox[], b: readonly OcrBox[]) => boolean,
): Group[] {
  const contains = (a: Box, b: Box) =>
    // Model bounding box coordinates have a few pixels of jitter; permit only approximate nesting of less than one-third of a line height without relaxing line ownership thresholds.
    a.x <= b.x + 0.3 * h &&
    a.y <= b.y + 0.3 * h &&
    a.x + a.width >= b.x + b.width - 0.3 * h &&
    a.y + a.height >= b.y + b.height - 0.3 * h;
  let out = [...groups].sort((a, b) => a.box.y - b.box.y);
  for (;;) {
    let merged = false;
    for (let i = 0; i < out.length && !merged; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!,
          b = out[j]!;
        if (a.title || b.title || a.pairs || b.pairs || a.side || b.side) continue;
        if ((!a.region && !b.region) || a.region === b.region) continue;
        if (a.region && b.region && !contains(a.region, b.region) && !contains(b.region, a.region))
          continue;
        const gap = b.box.y - a.box.y - a.box.height;
        if (gap < -0.5 * h || gap > PARAGRAPH_GAP * h || Math.abs(a.box.x - b.box.x) > h) continue;
        const ar = rowsOf(a.lines),
          br = rowsOf(b.lines),
          last = ar.at(-1)!,
          first = br[0]!;
        const range = /\d[-–—]\s*$/.test(last.text) && /^\s*\d+\.?\s*$/.test(first.text);
        const members = new Set([...a.lines, ...b.lines]),
          peers = lines.filter((l) => !members.has(l));
        const tail = paragraphsOf(
          a.lines,
          lines.filter((l) => !a.lines.includes(l)),
        ).at(-1)!;
        const head = paragraphsOf(
          b.lines,
          lines.filter((l) => !b.lines.includes(l)),
        )[0]!;
        // Inspect truly adjacent paragraph fragments; do not borrow line-wrap evidence from other long paragraphs in the same region.
        if (
          !range &&
          (tail.rows.length + head.rows.length < 3 || Math.max(a.box.width, b.box.width) < 8 * h)
        )
          continue;
        if (
          !compatible(
            tail.rows.flatMap((r) => r.lines),
            head.rows.flatMap((r) => r.lines),
          )
        )
          continue;
        // Do not cross over other intervening lines in the same column.
        if (
          peers.some(
            (l) =>
              l.y + l.height / 2 > last.box.y + last.box.height / 2 &&
              l.y + l.height / 2 < first.box.y + first.box.height / 2 &&
              l.x < Math.min(a.box.x + a.box.width, b.box.x + b.box.width) &&
              l.x + l.width > Math.max(a.box.x, b.box.x),
          )
        )
          continue;
        const paras = paragraphsOf([...a.lines, ...b.lines], peers);
        if (
          !paras.some(
            (p) =>
              p.rows.some((r) => r.lines.some((l) => a.lines.includes(l))) &&
              p.rows.some((r) => r.lines.some((l) => b.lines.includes(l))),
          )
        )
          continue;
        const region =
          a.region && b.region
            ? contains(a.region, b.region)
              ? a.region
              : b.region
            : (a.region ?? b.region);
        out.splice(j, 1);
        out[i] = {
          lines: [...a.lines, ...b.lines],
          title: 0,
          box: unionBox([a.box, b.box]),
          ...(region ? { region } : {}),
        };
        merged = true;
        break;
      }
    if (!merged) return out;
    out.sort((a, b) => a.box.y - b.box.y);
  }
}

/** The tallest line among paired lines does not exceed the shortest line by more than this multiple. */
const PAIR_HEIGHT_RATIO = 1.6;

/** Labels: short text ending with a colon, or left-aligned in a column with no more than this number of characters (D-332). */
const LABEL_MAX = 30;

const LABEL_COLON = /[:：]\s*$/;

/**
 * Form labels and values (D-332): consecutive lines of one block (label) and consecutive lines of
 * another block on the right (value) correspond line-by-line (vertically overlapping, value to
 * the right of the label), where labels end in colons, or there are more than two pairs with
 * left-aligned labels of no more than 30 characters forming standalone paragraphs (not wrapped
 * body text), these lines are paired together; unmatched lines above and below in both blocks
 * form separate blocks.
 */
function pairForms(
  groups: readonly Group[],
  lineHeight: number,
  gutter: PageGutter | null = null,
): Group[] {
  let out = [...groups];
  for (;;) {
    let next: Group[] | null = null;
    for (const left of out) {
      for (const right of out) {
        if (left === right || left.title || right.title || left.pairs || right.pairs) continue;
        // Full-page two-column layout: labels in the left column are not paired with text in the right column.
        if (gutter && sideOfGutter(left.box, gutter) !== sideOfGutter(right.box, gutter)) continue;
        const found = pairRows(left.lines, right.lines, lineHeight);
        // Label and content columns: pairing occurs only if every row is matched ("Step 3:" in W-4 matches only the first row, leaving the rest and scrambling the two columns).
        const partial = left.side === 'label' && right.side === 'content' && found?.length !== 1;
        if (found && !partial) {
          next = [...out.filter((g) => g !== left && g !== right), ...found];
          break;
        }
      }
      if (next) break;
    }
    if (!next) return out;
    out = next;
  }
}

function pairRows(
  labelLines: readonly OcrBox[],
  valueLines: readonly OcrBox[],
  lineHeight: number,
): Group[] | null {
  const labels = rowsOf(labelLines);
  const values = rowsOf(valueLines);
  const matchOf = (i: number) =>
    values.findIndex((v) => {
      const a = labels[i]!.box;
      const b = v.box;
      const ov = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return ov >= 0.5 * Math.min(a.height, b.height) && b.x > a.x + a.width;
    });
  // The first segment of consecutively matched lines.
  const a = labels.findIndex((_, i) => matchOf(i) >= 0);
  if (a < 0) return null;
  const c = matchOf(a);
  let n = 1;
  while (a + n < labels.length && matchOf(a + n) === c + n) n++;
  const pairedLabels = labels.slice(a, a + n);
  // Lines with vastly different heights (logos, major headings, and small text) do not form a single label column: pairing them would result in font sizes calculated from the median line height, shrinking major headings into small text.
  const heightOf = (r: Row) => median(r.lines.map((l) => l.height));
  const heights = pairedLabels.map(heightOf);
  if (n >= 2 && Math.max(...heights) >= PAIR_HEIGHT_RATIO * Math.min(...heights)) return null;
  const colon = pairedLabels.every((r) => LABEL_COLON.test(r.text));
  const column =
    n >= 2 &&
    pairedLabels.every(
      (r) =>
        [...r.text].length <= LABEL_MAX && Math.abs(r.box.x - pairedLabels[0]!.box.x) <= lineHeight,
    ) &&
    paragraphsOf(pairedLabels.flatMap((r) => r.lines)).length === n;
  if (!colon && !column) return null;
  const pairs = pairedLabels.map((r, k): [OcrBox[], OcrBox[]] => [r.lines, values[c + k]!.lines]);
  const lines = pairs.flat(2);
  const group = (rows: Row[]): Group[] => {
    const ls = rows.flatMap((r) => r.lines);
    return ls.length ? [{ lines: ls, title: 0, box: unionBox(ls) }] : [];
  };
  return [
    { lines, title: 0, box: unionBox(lines), pairs },
    ...group(labels.slice(0, a)),
    ...group(labels.slice(a + n)),
    ...group(values.slice(0, c)),
    ...group(values.slice(c + n)),
  ];
}

/** Lines of a text block spanning across both sides of a gutter (within the same model region and clustered together in the same row): cluster blocks separately for the left column, right column, and spanning elements. */
function splitAtGutter(group: Group, gutter: PageGutter, lineHeight: number): Group[] {
  const sides = [-1, 0, 1].map((s) => group.lines.filter((l) => sideOfGutter(l, gutter) === s));
  if (sides.filter((s) => s.length).length < 2) return [group];
  return sides.flatMap((part) =>
    clusterLines(part, lineHeight).map((ls): Group => {
      const { pairs: _pairs, ...rest } = group;
      return { ...rest, lines: ls, box: unionBox(ls) };
    }),
  );
}

/**
 * When a full-page gutter exists (findPageGutter): blocks above, below, and spanning the gutter
 * are laid out normally, while the two columns are laid out individually and placed into a
 * two-cell side-by-side row (blocks inside cells follow reading order; if cells contain nested
 * side-by-side fields, they are further laid out by flowCellBlocks when writing docx).
 */
function arrangeColumns(
  units: readonly Unit[],
  lineHeight: number,
  gutter: PageGutter | null,
  options: { dense?: boolean; onColumns?: (row: DocRow) => void },
): DocBlock[] {
  if (!gutter) return arrangeUnits(units, lineHeight, options);
  // Blocks entirely above (e.g., page numbers to the left of the header) or below the side-by-side column section are laid out normally along with the spanning blocks.
  const above = units.filter((u) =>
    sideOfGutter(u.box, gutter) < 0
      ? u.box.y + u.box.height / 2 < gutter.top
      : u.box.y + u.box.height <= gutter.top,
  );
  const below = units.filter(
    (u) => !above.includes(u) && (sideOfGutter(u.box, gutter) < 0 || u.box.y >= gutter.bottom),
  );
  const cols = [0, 1].map((s) =>
    units.filter(
      (u) => !above.includes(u) && !below.includes(u) && sideOfGutter(u.box, gutter) === s,
    ),
  );
  if (cols.some((c) => !c.length)) return arrangeUnits(units, lineHeight, options);
  const left = Math.min(...cols[0]!.map((u) => u.box.x));
  const right = Math.max(...cols[1]!.map((u) => u.box.x + u.box.width));
  const row: DocRow = {
    kind: 'row',
    cells: cols.map((c, k) => ({
      width: k ? right - gutter.x : gutter.x - left,
      blocks: leafBlocks({ blocks: arrangeUnits(c, lineHeight, { dense: true }) }),
    })),
    box: unionBox(cols.flat().map((u) => u.box)),
  };
  options.onColumns?.(row);
  return [
    ...arrangeUnits(above, lineHeight, options),
    row,
    ...arrangeUnits(below, lineHeight, options),
  ];
}

/** A block (region, table, or image) along with its laid-out blocks. */
interface Unit {
  box: Box;
  blocks: DocLeaf[];
}

/** Vertical extent overlap exceeding this fraction of the shorter block's height counts as side-by-side (D-331). */
const SIDE_OVERLAP = 0.5;

/**
 * Arrange blocks into document order (D-331): blocks with significantly overlapping vertical
 * ranges are connected into horizontal bands, ordered from top to bottom; within a band, items
 * divisible into columns horizontally (non-overlapping horizontally, with side-by-side tables
 * often separated by only a line height) are written as side-by-side rows, with each cell
 * following reading order; indivisible items are ordered strictly by reading order.
 */
/**
 * Two vertically adjacent side-by-side rows with the same number of columns and similar left
 * coordinate and width for each column (e.g., a two-column body text where titles and subsections
 * in the left column cut the right column's paragraphs into different bands) are merged into a
 * single side-by-side row: blocks in each column are joined together so that reading goes down
 * the left column first, then the right column.
 */
const COLUMN_SAME = 1.5;

const COLUMN_WIDTH_SAME = 0.2;

export function mergeColumnRows(blocks: readonly DocBlock[], lineHeight: number): DocBlock[] {
  const lefts = (row: DocRow) => row.cells.map((c) => Math.min(...c.blocks.map((b) => b.box.x)));
  const out: DocBlock[] = [];
  for (const block of blocks) {
    const prev = out.at(-1);
    if (
      prev?.kind === 'row' &&
      block.kind === 'row' &&
      prev.cells.length === block.cells.length &&
      prev.cells.length >= 2
    ) {
      const a = lefts(prev);
      const b = lefts(block);
      const same = prev.cells.every(
        (c, i) =>
          Math.abs(a[i]! - b[i]!) <= COLUMN_SAME * lineHeight &&
          Math.abs(c.width - block.cells[i]!.width) <= COLUMN_WIDTH_SAME * c.width,
      );
      if (same) {
        out[out.length - 1] = {
          kind: 'row',
          cells: prev.cells.map((c, i) => ({
            width: c.width,
            blocks: [...c.blocks, ...block.cells[i]!.blocks],
          })),
          box: unionBox([prev.box, block.box]),
        };
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

export function arrangeUnits(
  units: readonly Unit[],
  lineHeight: number,
  options: { dense?: boolean; onColumns?: (row: DocRow) => void } = {},
): DocBlock[] {
  const paragraphs = units
    .flatMap((u) => u.blocks)
    .filter((b) => b.kind === 'paragraph' || b.kind === 'image');
  const separated = units.flatMap((unit): Unit[] => {
    const parallel = unit.blocks.some((a) =>
      paragraphs.some((b) => {
        if (a === b || (a.kind !== 'paragraph' && a.kind !== 'image')) return false;
        const x =
          Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
        const y =
          Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
        return (
          x > 0 &&
          x < lineHeight * (a.kind === 'image' || b.kind === 'image' ? 3 : 1.5) &&
          y > SIDE_OVERLAP * Math.min(a.box.height, b.box.height)
        );
      }),
    );
    if (!parallel) return [unit];
    // Side-by-side headers/options may also appear within the same model text area. Slight bounding box expansion must not chain the entire band into a single column.
    return unit.blocks.map((block) => ({
      box: {
        ...block.box,
        width: Math.max(1, block.box.width - lineHeight * (block.kind === 'image' ? 3.5 : 2)),
      },
      blocks: [block],
    }));
  });
  const bands = mergeColumnRows(arrangeBands(separated, lineHeight), lineHeight);
  return splitAnswerRows(
    options.dense ? bands : retainProseColumns(bands, lineHeight, options.onColumns),
    lineHeight,
  );
}

/**
 * Answer column: each block does not exceed this many characters ("○ ja ○ nein", amounts, dates)
 * or this many line heights, with its vertical span overlapping at least half of the
 * corresponding left block; the right box is narrower than this fraction of the left box.
 */
const ANSWER_MAX_CHARS = 30;

const ANSWER_MAX_LINES = 3;

const ANSWER_OVERLAP = 0.5;

const ANSWER_WIDTH_SHARE = 0.5;

/**
 * Short answer column alongside clauses (such as "○ ja ○ nein" after each clause in authorization
 * forms, EU sample 041): multiple paragraphs of clauses in a region and several answers on the
 * right form a two-column side-by-side row. Because Word changes fonts and line wrapping
 * differently on the left, the answers on the right get misaligned and fail to match the clauses.
 * When the right column consists of short individual blocks, each corresponding to a block on the
 * left, split them into rows by answer: each row contains an answer and its corresponding clause
 * segment (along with any preceding clause segments lacking an answer). Do not split if the right
 * column is main body text (e.g., two-column body).
 */
function splitAnswerRows(blocks: readonly DocBlock[], lineHeight: number): DocBlock[] {
  return blocks.flatMap((block): DocBlock[] => {
    if (block.kind !== 'row' || block.cells.length !== 2) return [block];
    const [left, right] = block.cells as [DocRowCell, DocRowCell];
    const answers = [...right.blocks].sort((a, b) => a.box.y - b.box.y);
    const clauses = [...left.blocks].sort((a, b) => a.box.y - b.box.y);
    if (answers.length < 2 || clauses.length < 2) return [block];
    if (right.width > ANSWER_WIDTH_SHARE * left.width) return [block];
    if (
      !answers.every(
        (a) =>
          a.kind === 'paragraph' &&
          [...a.text.trim()].length <= ANSWER_MAX_CHARS &&
          a.box.height <= ANSWER_MAX_LINES * lineHeight,
      )
    )
      return [block];
    const overlap = (a: Box, b: Box) =>
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    // The clause segment corresponding to each answer (the one with the maximum overlap).
    const owners = answers.map((a) => {
      let best = -1;
      for (const [k, c] of clauses.entries())
        if (
          overlap(a.box, c.box) >= ANSWER_OVERLAP * Math.min(a.box.height, c.box.height) &&
          (best < 0 || overlap(a.box, c.box) > overlap(a.box, clauses[best]!.box))
        )
          best = k;
      return best;
    });
    // Each answer must correspond to a clause, with consistent ordering and no shared clauses.
    if (owners.some((k, i) => k < 0 || (i > 0 && k <= owners[i - 1]!))) return [block];
    return answers.map((a, i): DocRow => {
      const from = i ? owners[i - 1]! + 1 : 0;
      const to = i === answers.length - 1 ? clauses.length : owners[i]! + 1;
      const mine = clauses.slice(from, to);
      return {
        kind: 'row',
        cells: [
          { width: left.width, blocks: mine },
          { width: right.width, blocks: [a] },
        ],
        box: unionBox([...mine.map((b) => b.box), a.box]),
      };
    });
  });
}

/**
 * Two-column layout supported by long prose is preserved until cross-column content or a clear
 * gap is reached, without reverting to full-page width just because one band lacks another
 * column. Short labels and side-by-side fields lack this evidence and continue using the original
 * local side-by-side arrangement. Reuses DocRow only, without adding new file formats.
 */
function retainProseColumns(
  blocks: readonly DocBlock[],
  h: number,
  onColumns?: (row: DocRow) => void,
): DocBlock[] {
  const extent = (cell: DocRowCell) => unionBox(cell.blocks.map((b) => b.box));
  const evidence = (row: DocRow) =>
    row.cells.length === 2 &&
    row.cells.every((c) => extent(c).width >= 6 * h) &&
    row.cells.some((c) =>
      c.blocks.some(
        (b) =>
          b.kind === 'paragraph' &&
          !b.heading &&
          !b.tab &&
          b.box.height >= 3 * h &&
          b.box.width >= 8 * h,
      ),
    );
  const out: DocBlock[] = [];
  for (let i = 0; i < blocks.length;) {
    const seed = blocks[i]!;
    if (seed.kind !== 'row' || !evidence(seed)) {
      out.push(seed);
      i++;
      continue;
    }
    const edges = seed.cells.map(extent);
    const columnOf = (b: DocLeaf) =>
      edges.findIndex(
        (e) => b.box.x >= e.x - COLUMN_SAME * h && b.box.x + b.box.width <= e.x + e.width + h * 0.3,
      );
    let end = i + 1;
    let rowBottom = seed.box.y + seed.box.height;
    let bottom = rowBottom;
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j]!;
      if (b.box.y - bottom > 4 * h) break;
      if (b.kind === 'row') {
        if (
          b.cells.length !== 2 ||
          !b.cells.every((c, k) => Math.abs(extent(c).x - edges[k]!.x) <= COLUMN_SAME * h)
        )
          break;
        const next = b.cells.map(extent);
        // There must still be whitespace between the two columns; blocks that genuinely span across the gutter terminate this two-column segment.
        if (next[0]!.x + next[0]!.width + h * 0.3 > next[1]!.x) break;
        next.forEach((e, k) => {
          edges[k] = unionBox([edges[k]!, e]);
        });
        rowBottom = Math.max(rowBottom, b.box.y + b.box.height);
        end = j + 1;
      } else {
        if (columnOf(b) < 0) break;
        // Isolated trailing lines can only follow already verified columns; more distant footers must not extend the scope indefinitely via consecutive short lines.
        if (b.box.y <= rowBottom + COLUMN_SAME * h) end = j + 1;
      }
      bottom = Math.max(bottom, b.box.y + b.box.height);
    }
    const leading: DocBlock[] = [];
    let top = seed.box.y;
    while (out.length) {
      const before = out.at(-1)!;
      if (before.kind === 'row') {
        if (
          top - before.box.y - before.box.height > COLUMN_SAME * h ||
          before.cells.length !== 2 ||
          !before.cells.every((c, k) => Math.abs(extent(c).x - edges[k]!.x) <= COLUMN_SAME * h)
        )
          break;
        const previous = before.cells.map(extent);
        if (previous[0]!.x + previous[0]!.width + h * 0.3 > previous[1]!.x) break;
        previous.forEach((e, k) => {
          edges[k] = unionBox([edges[k]!, e]);
        });
        top = before.box.y;
      } else if (columnOf(before) < 0 || before.box.y + before.box.height < top - 0.5 * h) break;
      leading.unshift(before);
      out.pop();
    }
    const cells: DocRowCell[] = edges.map((e, k) => ({
      width: (edges[k + 1]?.x ?? e.x + e.width) - e.x,
      blocks: [],
    }));
    for (const b of [...leading, ...blocks.slice(i, end)]) {
      if (b.kind === 'row') b.cells.forEach((c, k) => cells[k]!.blocks.push(...c.blocks));
      else cells[columnOf(b)]!.blocks.push(b);
    }
    const row: DocRow = {
      kind: 'row',
      cells,
      box: unionBox([...leading, ...blocks.slice(i, end)].map((b) => b.box)),
    };
    onColumns?.(row);
    out.push(row);
    i = end;
  }
  return out;
}

function arrangeBands(units: readonly Unit[], lineHeight: number): DocBlock[] {
  const parent = units.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!.box;
      const b = units[j]!.box;
      const ov = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ov > SIDE_OVERLAP * Math.min(a.height, b.height)) parent[root(i)] = root(j);
    }
  }
  const bands = new Map<number, Unit[]>();
  units.forEach((u, i) => {
    const r = root(i);
    bands.set(r, [...(bands.get(r) ?? []), u]);
  });
  const top = (band: Unit[]) => Math.min(...band.map((u) => u.box.y));
  const gap = lineHeight * 0.3;
  return [...bands.values()]
    .sort((a, b) => top(a) - top(b))
    .flatMap((band): DocBlock[] => {
      const cols = columnsOf(band, gap);
      if (cols.length < 2) return readingOrder(band, gap, lineHeight).flatMap((u) => u.blocks);
      const lefts = cols.map((c) => Math.min(...c.map((u) => u.box.x)));
      const right = Math.max(...cols.at(-1)!.map((u) => u.box.x + u.box.width));
      return [
        {
          kind: 'row',
          cells: cols.map((c, k) => ({
            width: (lefts[k + 1] ?? right) - lefts[k]!,
            blocks: readingOrder(c, gap, lineHeight).flatMap((u) => u.blocks),
          })),
          box: unionBox(band.map((u) => u.box)),
        },
      ];
    });
}

/** Split columns by horizontal extent: columns that do not overlap horizontally with the previous column and are separated by at least the gap start a new column. */
function columnsOf(units: readonly Unit[], gap: number): Unit[][] {
  const cols: Unit[][] = [];
  let end = -Infinity;
  for (const u of [...units].sort((a, b) => a.box.x - b.box.x)) {
    const right = u.box.x + u.box.width;
    // Image margins may occupy white column gutters; two non-overlapping images must not be vertically stacked because of this.
    const pictureGap =
      u.blocks.length > 0 &&
      u.blocks.every((b) => b.kind === 'image') &&
      cols.at(-1)?.every((old) => old.blocks.every((b) => b.kind === 'image'))
        ? 0
        : gap;
    if (cols.length && u.box.x < end + pictureGap) {
      cols.at(-1)!.push(u);
      end = Math.max(end, right);
    } else {
      cols.push([u]);
      end = right;
    }
  }
  return cols;
}
export {
  alignmentIn,
  arrangeColumns,
  BODY_MAX,
  BODY_MIN,
  BODY_SNAP,
  BOX_TO_FONT,
  clustersOf,
  defaultJoin,
  DENSE_LINES,
  FILL_IN_LINES,
  FORM_MIN,
  HEADING1_RATIO,
  HEADING_RATIO,
  INDENT_LINES,
  INDENT_MAX,
  INDENT_MIN,
  isSparseColumnLayout,
  isStray,
  listMarker,
  listStart,
  MARKER_GAP,
  median,
  notHeading,
  PAGE_CENTER,
  PAGE_CENTER_MARGIN,
  PAGE_NUMBER,
  pairForms,
  photoPaper,
  PROSE_LINE,
  PROSE_SHARE,
  proseRows,
  reconcileTextGroups,
  rowsOf,
  ruleAcross,
  SHORT_TEXT,
  splitAtGutter,
  stripMarker,
  unionBox,
  WIDTH_CLAMP,
  WIDTH_SNAP,
  WIDTH_SPREAD,
  widthSizeOf,
  type Group,
  type Unit,
};

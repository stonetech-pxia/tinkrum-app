import {
  BOLD_RATIO,
  IMAGE_PAD,
  arrangeUnits,
  clusterLines,
  fontSizeOf,
  mergeTextRegions,
  type DocLeaf,
} from './doc-support';
import { cleanRegions, lineShareIn, type LayoutRegion } from './layout';
import type { Box, OcrBox, RgbaImage } from './types';

// How non-table elements are arranged when converting to Excel (D-520-D-522): image regions,
// two-column text, font size, and bold text. Layout analysis and column splitting use the Word
// conversion pipeline (D-328, D-331), but map to worksheet columns instead of side-by-side
// paragraphs in docx. Calculations are performed in straightened coordinates, and build.ts
// determines column spans based on shared page columns.

/** Body font size range (pt): similar to Word conversion, paper in photos is not necessarily A4, and scaling based on A4 can be too large. */
const BODY_MIN = 6;
const BODY_MAX = 12;
/** Treat as body text if the font size difference from the body is below this threshold (ratio); line heights with fewer than SHORT_TEXT alphanumeric characters are unreliable and also treated as body text. */
const BODY_SNAP = 0.25;
const SHORT_TEXT = 6;
/** Treat as body text if the table font size difference from the body is below this threshold (pt), avoiding half-point estimation errors causing inconsistent table font sizes on the same page. */
const TABLE_SNAP = 0.5;
const TEXT_MAX = 48;

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

/** A text block is considered a right-column block only if its left edge is at least this fraction of the page width away from the left edge of the full-page content. */
const RIGHT_COLUMN = 0.25;

/** Line height difference ratio between consecutive rows exceeding this threshold indicates they belong to different blocks (e.g., a large heading is placed very close to the small subtitle below it). */
const SIZE_BREAK = 1.3;

/** Split lines within a block into rows based on vertical overlap, separating them where line heights differ significantly from the previous row. */
function splitBySize(lines: OcrBox[]): OcrBox[][] {
  const sorted = [...lines].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const rows: OcrBox[][] = [];
  for (const line of sorted) {
    const first = rows.at(-1)?.[0];
    const overlap = first
      ? Math.min(first.y + first.height, line.y + line.height) - Math.max(first.y, line.y)
      : 0;
    if (first && overlap >= 0.5 * Math.min(first.height, line.height)) rows.at(-1)!.push(line);
    else rows.push([line]);
  }
  const heightOf = (row: OcrBox[]) => median(row.map((l) => l.height));
  const parts: OcrBox[][] = [];
  for (const [i, row] of rows.entries()) {
    const ratio = i
      ? Math.max(heightOf(row), heightOf(rows[i - 1]!)) /
        Math.min(heightOf(row), heightOf(rows[i - 1]!))
      : 1;
    if (i && ratio < SIZE_BREAK) parts.at(-1)!.push(...row);
    else parts.push([...row]);
  }
  return parts;
}

/** Page body font size (pt): based on typical line height of page text. */
export const bodySizeOf = (lineHeight: number, pageWidth: number) =>
  Math.min(BODY_MAX, Math.max(BODY_MIN, fontSizeOf(lineHeight, pageWidth)));

/** Table font size (pt): based on line height of text within the table; similar to body text means it is body text. */
export function tableSizeOf(lineHeight: number, pageWidth: number, bodySize: number): number {
  const size = bodySizeOf(lineHeight, pageWidth);
  return Math.abs(size - bodySize) <= TABLE_SNAP ? bodySize : size;
}

/**
 * Layout region arrangement (original image coordinates): leave a small margin outside image
 * regions (not hugging text when cropped, same as Word conversion), and use the rest (title,
 * body, page numbers) to segment text into blocks (for two-column pages, narrow gaps between
 * columns are separated by regions). Region cleanup (discarding image regions with too many
 * characters or occupying half a page; ignoring model-generated tables) also reuses Word's
 * cleanRegions.
 */
export function layoutRegions(
  regions: readonly LayoutRegion[],
  lines: readonly OcrBox[],
  image: RgbaImage,
  lineHeight: number,
): { figures: Box[]; text: LayoutRegion[] } {
  const size = { width: image.width, height: image.height };
  const pad = IMAGE_PAD * lineHeight;
  // D-530 weak evidence recovery is restricted to Word for now; adding new boxes would re-split worksheet column lines and could unintentionally alter Excel column widths and pagination.
  const cleaned = cleanRegions(
    regions.filter((r) => !r.wordOnly),
    lines,
    size,
    image,
  );
  return {
    figures: cleaned
      .filter((r) => r.kind === 'image')
      .map((r) => {
        const x = Math.max(0, r.box.x - pad);
        const y = Math.max(0, r.box.y - pad);
        return {
          x,
          y,
          width: Math.min(size.width, r.box.x + r.box.width + pad) - x,
          height: Math.min(size.height, r.box.y + r.box.height + pad) - y,
        };
      }),
    text: cleaned.filter((r) => r.kind !== 'image'),
  };
}

/** An element to be arranged: text or image; 'range' is its horizontal span (straightened pixels), or spanning the full page if absent. */
export type Draft = (
  | { kind: 'text'; text: string; lines: OcrBox[]; size?: number; bold?: boolean }
  | { kind: 'image' }
  /** Already identified table (index): used only for arranging side-by-side bands; table columns are already established. */
  | { kind: 'table'; index: number }
) & { box: Box; band?: number; range?: [number, number] };

export interface RestPlan {
  /** From top to bottom; a group is either a side-by-side band (multiple blocks each occupying a column) or a single block. */
  groups: { y: number; drafts: Draft[] }[];
}

export interface RestInput {
  /** Lines outside tables (straightened coordinates). */
  lines: readonly OcrBox[];
  /** Image regions (straightened coordinates). */
  figures: readonly Box[];
  /** Text regions from layout analysis (title, body): text within the same region forms a connected block; missing regions or text outside any region are clustered by position. */
  regions: readonly LayoutRegion[];
  /** Positions of identified tables (straightened coordinates): arranged in side-by-side bands with text and images (e.g., table on the left, text on the right). */
  tables: readonly Box[];
  lineHeight: number;
  /** Line height used for estimating font size: when photos are skewed, bounding boxes of long lines are taller than the text, so extra skew height must be subtracted; baseHeight is the typical value for page text. */
  sizeHeight: (line: OcrBox) => number;
  baseHeight: number;
  bodySize: number;
  /** Join lines of the same paragraph into text. */
  join: (lines: readonly OcrBox[]) => string;
  /** Ratio of stroke thickness to line height for a line of text; page typical value. */
  strokeOf: (line: OcrBox) => number;
  pageStroke: number;
}

/**
 * Cluster non-table text into blocks by position (Word's clusterLines: vertically adjacent and
 * horizontally overlapping text are connected, with widely separated items in a row split
 * horizontally), combine with images, and arrange using Word's side-by-side rules (arrangeUnits,
 * D-331): blocks with overlapping vertical ranges and separate horizontal ranges form a
 * side-by-side band, each column has its own horizontal range, and blocks within a column are
 * concatenated. Estimate font size for each text block (based on line height-to-body ratio) and
 * bold style (stroke width significantly thicker than page average).
 */
export function planRest(input: RestInput): RestPlan {
  const { lineHeight, bodySize, pageStroke } = input;
  const drafts: Draft[] = [];
  // Text segmentation into blocks: text within regions (each title forms a block) clustered
  // individually, and unassigned text clustered by position (same as Word, D-328). Discard regions
  // that substantially overlap with tables (table header rows, or table content misidentified as
  // body text).
  const overTable = (r: LayoutRegion) =>
    input.tables.some((box) => {
      const ix = Math.min(box.x + box.width, r.box.x + r.box.width) - Math.max(box.x, r.box.x);
      const iy = Math.min(box.y + box.height, r.box.y + r.box.height) - Math.max(box.y, r.box.y);
      return ix > 0 && iy > 0 && ix * iy > 0.5 * r.box.width * r.box.height;
    });
  const regions = mergeTextRegions(
    input.regions.filter((r) => !overTable(r)),
    lineHeight,
  );
  // Assign each line to the smallest region enclosing it (at least half inside): models often
  // output nested body regions (a large region covering 2-3 paragraphs plus small regions for each
  // paragraph); selecting by containment proportion causes the last line of a paragraph to fall
  // into the large region, splitting the paragraph into two blocks.
  const owner = input.lines.map((line) => {
    let best = -1;
    for (const [i, r] of regions.entries()) {
      if (lineShareIn(line, r.box) < 0.5) continue;
      if (
        best < 0 ||
        r.box.width * r.box.height < regions[best]!.box.width * regions[best]!.box.height
      )
        best = i;
    }
    return best;
  });
  const clusters: OcrBox[][] = [];
  for (const [i, region] of regions.entries()) {
    const members = input.lines.filter((_, k) => owner[k] === i);
    if (!members.length) continue;
    if (region.kind === 'title') clusters.push(members);
    else clusters.push(...clusterLines(members, lineHeight));
  }
  const unowned = input.lines.filter((_, k) => owner[k] === -1);
  if (unowned.length) clusters.push(...clusterLines(unowned, lineHeight));
  for (const lines of clusters.flatMap(splitBySize)) {
    const text = input.join(lines).trim();
    if (!text) continue;
    const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    const raw = (median(lines.map(input.sizeHeight)) / input.baseHeight) * bodySize;
    let size = Math.min(TEXT_MAX, Math.max(BODY_MIN, Math.round(raw * 2) / 2));
    if (letters < SHORT_TEXT || Math.abs(size - bodySize) <= BODY_SNAP * bodySize) size = bodySize;
    const bold = pageStroke > 0 && median(lines.map(input.strokeOf)) > BOLD_RATIO * pageStroke;
    drafts.push({
      kind: 'text',
      text,
      lines,
      ...(size !== bodySize ? { size } : {}),
      ...(bold ? { bold: true } : {}),
      box: unionBox(lines),
    });
  }
  for (const box of input.figures) drafts.push({ kind: 'image', box });
  for (const [index, box] of input.tables.entries()) drafts.push({ kind: 'table', index, box });
  // Arrange into side-by-side bands: each block is represented by a placeholder image block carrying its index, which is swapped back after layout.
  const units = drafts.map((d, i) => ({
    box: d.box,
    blocks: [{ kind: 'image', box: d.box, src: String(i) }] as DocLeaf[],
  }));
  const indexOf = (leaf: DocLeaf) => Number((leaf as { src: string }).src);
  const own = (d: Draft): [number, number] => [d.box.x, d.box.x + d.box.width];
  const groups: RestPlan['groups'] = [];
  let band = 0;
  // Left and right margins of full-page content (used for right-column text and tables positioned on the left).
  const pageLeft = Math.min(...drafts.map((d) => d.box.x));
  const pageRight = Math.max(...drafts.map((d) => d.box.x + d.box.width));
  const pageWidth = pageRight - pageLeft;
  for (const block of arrangeUnits(units, lineHeight)) {
    if (block.kind !== 'row') {
      const d = drafts[indexOf(block)]!;
      if (d.kind === 'image') d.range = own(d);
      // For a single block not in a side-by-side band and positioned in the right column (the start
      // of one column falls above a paragraph in the other column): extend from its left edge to
      // the right edge of the page, without spanning the full page (centered titles have similar
      // left/right whitespace and are excluded).
      else if (
        d.kind === 'text' &&
        d.box.x - pageLeft >= RIGHT_COLUMN * pageWidth &&
        d.box.x - pageLeft >= 1.3 * (pageRight - (d.box.x + d.box.width))
      )
        d.range = [d.box.x, pageRight];
      groups.push({ y: d.box.y, drafts: [d] });
      continue;
    }
    const id = band++;
    const group: Draft[] = [];
    for (const cell of block.cells) {
      const at = cell.blocks.map(indexOf);
      const left = Math.min(...at.map((i) => drafts[i]!.box.x));
      for (const i of at) {
        const d = drafts[i]!;
        d.band = id;
        // Text occupies the full width of the column (up to the left edge of the next column); images occupy only their own position.
        if (d.kind === 'image') d.range = own(d);
        else if (d.kind === 'text') d.range = [left, left + cell.width];
        group.push(d);
      }
    }
    groups.push({ y: block.box.y, drafts: group });
  }
  return { groups };
}

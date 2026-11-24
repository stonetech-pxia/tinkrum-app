import type { Box } from './types';

// Pages split into left and right columns with aligned rows (EU sample 044: a gazette page printing
// 2 x 4 small invoice samples; two-column label rows share the same height): when block
// partitioning, same-height left and right rows merge into bands, zigzagging left and right, and
// left/right rows on the same line might merge into 'left\tright', turning one page into several.
// After finding the page gutter (a vertical white gap in the middle where no lines, tables, or
// images cross the two-column region), both columns are laid out independently as a two-column
// side-by-side row; spanning titles and footers above and below the gutter are laid out normally.

/** The gutter falls within this range of text horizontal bounds (not marginal label columns). */
const GUTTER_FROM = 0.3;
const GUTTER_TO = 0.7;
/** Minimum gutter width: at least this many line heights, and at least this fraction of page width. */
const GUTTER_MIN_LINES = 2;
const GUTTER_MIN_SHARE = 0.02;
/** Each column must have at least this many rows, occupy this fraction of all rows, and span at least this fraction of text width (ruling out a left column of short labels and a right column of values). */
const SIDE_MIN_LINES = 8;
const SIDE_MIN_SHARE = 0.25;
const SIDE_MIN_WIDTH = 0.3;
/** The two-column region must span at least this fraction of page height. */
const BAND_MIN_HEIGHT = 0.3;
/**
 * Columns must have similar widths (narrow column is at least this fraction of the wide one) and
 * sufficient letter content on both sides: item names, quantities, and amounts in receipts/price
 * lists form table columns rather than two columns (regression case tbl-receipt-local-tilt).
 */
const SIDE_BALANCE = 0.6;
const SIDE_LETTERS = 0.6;

export interface PageGutter {
  /** Centerline of the gutter. */
  x: number;
  /** Vertical bounds of the two-column region: no elements cross the gutter within this range. */
  top: number;
  bottom: number;
}

/**
 * Find the page gutter. 'lines' are body text lines, 'blocks' are tables and images (which also
 * cannot cross the gutter, though they don't count towards line count). Returns null if none:
 * pages with spanning images, titles, or tables between columns keep original band layout.
 */
export function findPageGutter(
  lines: readonly (Box & { text: string })[],
  blocks: readonly Box[],
  lineHeight: number,
  page: { width: number; height: number },
): PageGutter | null {
  if (lines.length < 2 * SIDE_MIN_LINES) return null;
  const items = [
    ...lines.map((box) => ({ box, text: box.text as string | null })),
    ...blocks.map((box) => ({ box, text: null })),
  ];
  const left = Math.min(...items.map((i) => i.box.x));
  const right = Math.max(...items.map((i) => i.box.x + i.box.width));
  const span = right - left;
  const at = (x: number): PageGutter | null => {
    const a = items.filter((i) => i.box.x + i.box.width <= x);
    const b = items.filter((i) => i.box.x >= x);
    const count = (side: typeof items) => side.filter((i) => i.text !== null).length;
    if (Math.min(count(a), count(b)) < Math.max(SIDE_MIN_LINES, SIDE_MIN_SHARE * lines.length))
      return null;
    const extent = (side: typeof items) =>
      Math.max(...side.map((i) => i.box.x + i.box.width)) - Math.min(...side.map((i) => i.box.x));
    const [ea, eb] = [extent(a), extent(b)];
    if (Math.min(ea, eb) < Math.max(SIDE_MIN_WIDTH * span, SIDE_BALANCE * Math.max(ea, eb)))
      return null;
    const letters = (side: typeof items) => {
      const text = side
        .map((i) => i.text ?? '')
        .join('')
        .replace(/\s/g, '');
      return (text.match(/\p{L}/gu)?.length ?? 0) / Math.max(1, text.length);
    };
    if (Math.min(letters(a), letters(b)) < SIDE_LETTERS) return null;
    const top = Math.max(Math.min(...a.map((i) => i.box.y)), Math.min(...b.map((i) => i.box.y)));
    const bottom = Math.min(
      Math.max(...a.map((i) => i.box.y + i.box.height)),
      Math.max(...b.map((i) => i.box.y + i.box.height)),
    );
    if (bottom - top < BAND_MIN_HEIGHT * page.height) return null;
    const crossing = items.some(
      (i) =>
        i.box.x < x &&
        i.box.x + i.box.width > x &&
        i.box.y < bottom &&
        i.box.y + i.box.height > top,
    );
    return crossing ? null : { x, top, bottom };
  };
  const step = Math.max(1, lineHeight / 4);
  let best: { from: number; to: number } | null = null;
  let start: number | null = null;
  const end = left + GUTTER_TO * span;
  for (let x = left + GUTTER_FROM * span; x <= end + step; x += step) {
    const open = x <= end && at(x) !== null;
    if (open && start === null) start = x;
    if (!open && start !== null) {
      if (!best || x - step - start > best.to - best.from) best = { from: start, to: x - step };
      start = null;
    }
  }
  if (!best) return null;
  if (best.to - best.from < Math.max(GUTTER_MIN_LINES * lineHeight, GUTTER_MIN_SHARE * page.width))
    return null;
  return at((best.from + best.to) / 2);
}

/** Determine which side of the gutter a box lies on: 0 for left column, 1 for right column, -1 for spanning (titles and footers above/below the gutter). */
export function sideOfGutter(box: Box, gutter: PageGutter): -1 | 0 | 1 {
  if (box.x + box.width <= gutter.x) return 0;
  if (box.x >= gutter.x) return 1;
  return -1;
}

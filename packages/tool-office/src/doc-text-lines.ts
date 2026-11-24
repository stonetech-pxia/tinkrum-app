import { cachedLines } from './build';
import { type StageState, nextStage } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import { type RuledTablesState } from './doc-ruled-tables';
import { isStray, isVertical, ruleAcross, verticalBoxes } from './doc-support';
import { lineShareIn } from './layout';
import { levelLines } from './text-table';
import { type OcrBox, type TableCell } from './types';
import { withBullets } from './word-bullets';
import { findFillIns, joinShadedBlanks, withFillIns } from './word-fill-ins';

/** Reconnect fill-in areas and list markers, preserving the correspondence between recognized lines and the original image. */
export function prepareTextLines(
  state: Pick<RuledTablesState, 'ruled' | 'placedIn' | 'tables' | 'rejected'> &
    Pick<
      PreparePageState,
      | 'available'
      | 'lines'
      | 'lineHeight'
      | 'image'
      | 'working'
      | 'dots'
      | 'tableSkew'
      | 'figures'
      | 'cropLineHeight'
    >,
) {
  const {
    ruled,
    placedIn,
    available,
    lines,
    lineHeight,
    image,
    working,
    dots,
    tableSkew,
    tables,
    figures,
    cropLineHeight,
    rejected,
  } = state;

  // Calculated based on lines actually placed inside cells (D-501): text outside table borders or spanning column lines that was not placed into a table is formatted as regular body text and is not lost.
  const inTable = new Set(ruled.flatMap((t) => placedIn.get(t) ?? []));
  // Page-wide skew (D-471): when photos are tilted or paper is warped, split lines along oblique
  // vectors. Flattened lines are used solely for line-splitting, paragraph-splitting, and
  // positioning; measuring stroke width, color, and underlines still relies on original positions
  // in the source image.
  const outside = available.filter((l) => !inTable.has(l) && !isStray(l, lines, lineHeight, image));
  // Vertical and rotated text (margin vertical markers, side callouts, barcode identifiers):
  // recognized text is mostly garbage, and placing it in the main body would inflate font sizes.
  // Crop the entire block as an image and preserve it as-is.
  const upright = outside.filter((l) => !isVertical(l));
  // Form fill-in locations (a string of dots, a horizontal line to the right of a label) are attached behind the label in the same row, or form their own row (EU samples 021, 030).
  const fills = findFillIns(
    working,
    dots,
    cachedLines(working, { ...(tableSkew !== undefined ? { skew: tableSkew } : {}), light: true }),
    upright,
    lineHeight,
    [...tables.map((t) => t.box), ...figures.map((f) => f.box)],
  );
  const withFills = withFillIns(upright, fills, lineHeight);
  // Shaded background blocks interspersed within sentences (EU sample 082): reconnect separated segments into a single line.
  const shaded = joinShadedBlanks(image, withFills.lines, lineHeight);
  const filled = shaded.lines;
  const fillSource = new Map(withFills.source);
  for (const [l, from] of shaded.source) fillSource.set(l, withFills.source.get(from) ?? from);
  const synthetic = new Set(filled.filter((l) => !fillSource.has(l) && !upright.includes(l)));
  // Restore missed list markers ("•", "-") in front of lines (EU samples 026, 027).
  const { lines: kept, source: bulletSource } = withBullets(image, filled);
  const verticals = verticalBoxes(outside.filter(isVertical), cropLineHeight, {
    width: image.width,
    height: image.height,
  });
  const originalOf = new Map<OcrBox, OcrBox>();
  const leveled = levelLines(kept, lineHeight, image.width / 2);
  leveled.forEach((flat, k) => originalOf.set(flat, kept[k]!));
  // Original recognition line (replace lines with attached fill-ins back with the recognized line: measure strokes, color, underlines, and determine which table it belongs to).
  const orig = (l: OcrBox) => {
    const o = originalOf.get(l) ?? l;
    const b = bulletSource.get(o) ?? o;
    return fillSource.get(b) ?? b;
  };
  const releasedCells = new Map<OcrBox, TableCell>();
  for (const table of rejected) {
    const placed = placedIn.get(table) ?? [];
    const cellOf = (l: OcrBox) => table.cells.find((c) => c.box && lineShareIn(l, c.box) >= 0.5);
    // Treat adjacent vertical cells without drawn horizontal lines (white space between text) as
    // the same cell: e.g., small ticks on the right outer border of a letter, where grid lines
    // slice a row of text, preserving row-by-row paragraphs after grid removal (EU sample 075).
    // Cells with actual drawn horizontal lines (agenda grid cells) remain separate.
    const same = new Map<TableCell, TableCell>();
    for (const cell of [...table.cells].sort((a, b) => a.row - b.row)) {
      const above = table.cells.find(
        (c) =>
          c.col === cell.col &&
          c.colSpan === cell.colSpan &&
          c.row + c.rowSpan === cell.row &&
          c.box &&
          cell.box,
      );
      const upper = placed.filter((l) => above && cellOf(l) === above);
      const lower = placed.filter((l) => cellOf(l) === cell);
      if (
        above &&
        upper.length &&
        lower.length &&
        !ruleAcross(
          working,
          cell.box!.x,
          cell.box!.x + cell.box!.width,
          Math.max(...upper.map((l) => l.y + l.height)),
          Math.min(...lower.map((l) => l.y)),
        )
      )
        same.set(cell, same.get(above) ?? above);
    }
    for (const l of placed) {
      const cell = cellOf(l);
      if (cell) releasedCells.set(l, same.get(cell) ?? cell);
    }
  }
  return nextStage({ synthetic, kept, verticals, leveled, orig, releasedCells });
}
export type TextLinesState = StageState<ReturnType<typeof prepareTextLines>>;

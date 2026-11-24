import { type BuildOptions, buildTablePage } from './build';
import { type PageBuildContext, type StageState, nextStage } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import {
  BODY_MAX,
  CHOP_MIN,
  CHOP_SHARE,
  type DocTable,
  FILL_IN_LINES,
  FORM_MIN,
  fieldBoxTables,
  foldEmptyColumns,
  fontSizeOf,
  isBlankFormGrid,
  isRuleGrid,
  isSparseColumnLayout,
  median,
  proseRows,
  rowsOf,
} from './doc-support';
import { lineShareIn } from './layout';
import { type Box, type OcrBox, type TableBlock } from './types';

/** Find lines and group tables, retaining blank fill-in cells and releasing misidentified grids. */
export function buildRuledTables(
  state: Pick<
    PreparePageState,
    | 'working'
    | 'available'
    | 'tableSkew'
    | 'joinParagraph'
    | 'join'
    | 'lineHeight'
    | 'figures'
    | 'lines'
    | 'rotated'
    | 'fontWidthPx'
  > &
    Pick<PageBuildContext, 'input' | 'options' | 'repairTables'>,
) {
  const {
    working,
    available,
    input,
    tableSkew,
    options,
    joinParagraph,
    join,
    lineHeight,
    figures,
    lines,
    repairTables,
    rotated,
    fontWidthPx,
  } = state;

  // Line-enabled tables (similar to Excel export); lines placed inside tables no longer participate in paragraph segmentation.
  const placedIn = new Map<TableBlock, readonly OcrBox[]>();
  const choppedIn = new Map<TableBlock, number>();
  // Grids fully enclosed by horizontal and vertical lines (all cells separated by lines); only these qualify as blank tables intended for user entry.
  const ruledGrids = new Set<TableBlock>();
  const blankForm = (t: TableBlock) => ruledGrids.has(t) && isBlankFormGrid(t);
  // Boxes merely framing a few text lines (letters in EU sample 075): not treated as tables, text returned to body.
  const framedTexts = new Set<TableBlock>();
  const tableInput = {
    image: working,
    lines: available,
    name: '',
    source: input.source,
    ...(tableSkew !== undefined ? { skew: tableSkew } : {}),
  };
  // Text inside cells follows original image row formatting (D-333): addresses and dates in form
  // cells occupy individual lines without merging into paragraphs (Word cell widths match original
  // images, font sizes proportional). Unruled tables are recognized after removing vertical and
  // sporadic text below (D-471).
  const tableOptions = (splitStacked: boolean): BuildOptions => ({
    ...options,
    textTables: false,
    // Light rules: electronic templates often use very light gray lines for tables (EU sample 001, 006), which should also be detected during Word conversion.
    lightRules: true,
    // Header above: blank product columns with headers written above the grid (EU sample 001).
    headerAbove: true,
    splitStacked,
    joinLines: (cell) => {
      const rows = rowsOf(cell);
      // Single cell containing body text (boxed prompts, EU sample 038): joined into a single paragraph to allow re-flowing in Word.
      if (proseRows(rows)) return joinParagraph(rows.flatMap((r) => r.lines)).trim();
      return rows.map((r) => join(r.lines).trim()).join('\n');
    },
    onTable: (table, placed, { chopped, ruled, framedText }) => {
      placedIn.set(table, placed);
      choppedIn.set(table, chopped);
      if (ruled) ruledGrids.add(table);
      if (framedText) framedTexts.add(table);
    },
  });
  const sheet = buildTablePage(tableInput, tableOptions(false));
  const tol = lineHeight * 0.3;
  const inBox = (l: Box, box: Box) => {
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    return (
      cx >= box.x - tol &&
      cx <= box.x + box.width + tol &&
      cy >= box.y - tol &&
      cy <= box.y + box.height + tol
    );
  };
  // Tables where column lines split many text lines mid-word (D-502): grid is misidentified (text
  // strokes or creases mistaken for column lines), reject as table and format inner text by lines
  // (detectable even without lines).
  const chopsMuch = (t: TableBlock) => {
    const chopped = choppedIn.get(t) ?? 0;
    return chopped >= CHOP_MIN && chopped >= CHOP_SHARE * (placedIn.get(t)?.length ?? 0);
  };
  // Exclude grids inside images (tables mostly inside images); also exclude when images span
  // multiple table cells (full-page layout frames enclosing table blocks, D-533). Tables are
  // retained when images reside within a single cell (ID photos occupying merged form cells);
  // marginal overlap into a table cell (logos clipped with a sliver below, EU sample 062) is also
  // retained: determined by whether the overlapping portion lies entirely within a single cell.
  const insideOf = (f: Box, b: Box): Box => {
    const x = Math.max(f.x, b.x);
    const y = Math.max(f.y, b.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(f.x + f.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(f.y + f.height, b.y + b.height) - y),
    };
  };
  const outsideFigures = (b: TableBlock) =>
    !figures.some(
      (f) =>
        lineShareIn(b.box, f.box) >= 0.5 ||
        (lineShareIn(f.box, b.box) >= 0.2 &&
          !b.cells.some((c) => c.box && lineShareIn(insideOf(f.box, b.box), c.box) >= 0.8)),
    );
  const sheetTables = sheet.blocks.filter((b): b is TableBlock => b.kind === 'table');
  const ruledCandidates = sheetTables.filter(
    (b) =>
      outsideFigures(b) &&
      (blankForm(b) || !isRuleGrid(b, lines.filter((l) => inBox(l, b.box)).length)) &&
      !chopsMuch(b),
  );
  const sparse = (t: TableBlock) =>
    repairTables && !blankForm(t) && (isSparseColumnLayout(t) || framedTexts.has(t));
  const colWidthsOf = new Map(sheetTables.map((t) => [t, sheet.colWidths] as const));
  // Multiple vertically stacked tables sharing an external border (registration tables in EU sample
  // 004) merged into one: split at horizontal lines where column layouts change (findTables
  // splitStacked), evaluating each separately. Tables originally intended as tables retain their
  // tabular parts after splitting (falling back to full tables if none qualify); parts previously
  // discarded as ruled form lines or split due to excessive whitespace retain only blank form grids
  // (isBlankFormGrid) as tables, formatting remaining parts as text.
  const stacked = buildTablePage(tableInput, tableOptions(true));
  const stackedTables = stacked.blocks.filter((b): b is TableBlock => b.kind === 'table');
  const ruled: TableBlock[] = [];
  const rejected: TableBlock[] = [];
  // Within grids discarded as ruled forms (or unselected parts after splitting), row-by-row fill-in boxes are still treated as tables (EU sample 062).
  const carveFieldBoxes = (t: TableBlock, colWidths: readonly number[]) => {
    if (!repairTables || chopsMuch(t)) return;
    const placed = placedIn.get(t) ?? [];
    for (const f of fieldBoxTables(t, colWidths, placed, lineHeight)) {
      if (!outsideFigures(f.table)) continue;
      colWidthsOf.set(f.table, f.colWidths);
      placedIn.set(
        f.table,
        placed.filter((l) => inBox(l, f.table.box)),
      );
      ruled.push(f.table);
    }
  };
  for (const t of sheetTables) {
    const kept = ruledCandidates.includes(t) && !sparse(t);
    const parts = stackedTables.filter((p) => lineShareIn(p.box, t.box) >= 0.9);
    const keep =
      parts.length < 2
        ? []
        : parts.filter(
            (p) =>
              outsideFigures(p) &&
              !chopsMuch(p) &&
              (blankForm(p) ||
                (kept &&
                  !isRuleGrid(p, lines.filter((l) => inBox(l, p.box)).length) &&
                  !sparse(p))),
          );
    if (keep.length) {
      for (const p of keep) colWidthsOf.set(p, stacked.colWidths);
      ruled.push(...keep);
      for (const p of parts) if (!keep.includes(p)) carveFieldBoxes(p, stacked.colWidths);
    } else if (kept) ruled.push(t);
    else if (ruledCandidates.includes(t)) rejected.push(t);
    else carveFieldBoxes(t, colWidthsOf.get(t)!);
  }
  const tables: DocTable[] = ruled.map((table) => {
    // Table font sizes are determined by text line heights within the table (D-335), calculated separately from body text.
    const h = median(lines.filter((l) => inBox(l, table.box)).map((l) => l.height));
    return {
      kind: 'table',
      ...(rotated ? { direction: 'tbRl' as const } : {}),
      // Columns wide enough for writing (fill-in fields) are not merged: merge only narrow columns resembling gaps between double lines.
      table: foldEmptyColumns({ ...table, col: 0 }, FILL_IN_LINES * lineHeight),
      colWidths: colWidthsOf.get(table)!.slice(table.col, table.col + table.cols),
      ...(h ? { size: Math.min(BODY_MAX, Math.max(FORM_MIN, fontSizeOf(h, fontWidthPx))) } : {}),
      box: table.box,
    };
  });
  return nextStage({ placedIn, inBox, ruled, rejected, tables });
}
export type RuledTablesState = StageState<ReturnType<typeof buildRuledTables>>;

import { type PageBuildContext, type StageState, donePage, nextStage } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import { type RuledTablesState } from './doc-ruled-tables';
import {
  BODY_MAX,
  FORM_MIN,
  fontSizeOf,
  insertWordFigures,
  leafBlocks,
  median,
} from './doc-support';
import { type TextLinesState } from './doc-text-lines';
import { lineShareIn } from './layout';
import { findBarcodes, findTextTables } from './text-table';
import { type OcrBox } from './types';
import { findPageGutter, sideOfGutter } from './word-gutter';

/** Reconstruct borderless tables and barcodes, falling back to the unpatched full page when necessary. */
export function buildTextTables(
  state: Pick<TextLinesState, 'leveled' | 'orig' | 'kept'> &
    Pick<RuledTablesState, 'ruled' | 'rejected' | 'tables' | 'inBox'> &
    Pick<
      PreparePageState,
      'figures' | 'lineHeight' | 'image' | 'fontWidthPx' | 'working' | 'available'
    > &
    Pick<
      PageBuildContext,
      'repairTables' | 'input' | 'buildPage' | 'options' | 'protectFigures' | 'repairBarcodes'
    >,
) {
  const {
    leveled,
    ruled,
    figures,
    lineHeight,
    image,
    repairTables,
    input,
    orig,
    rejected,
    buildPage,
    options,
    protectFigures,
    repairBarcodes,
    tables,
    fontWidthPx,
    working,
    kept,
    available,
    inBox,
  } = state;

  // Borderless tables (D-471): rows aligned across three or more columns are formatted as
  // borderless tables rather than joined into a single sentence. The model only provides the
  // bounding region and cannot construct tables directly. The region must contain at least three
  // columns and multiple rows aligned simultaneously; regions already claimed by bordered tables
  // are not rebuilt, and remaining text on the page follows original strict rules.
  const boundedLines = new Set<OcrBox>();
  // Find left and right page gutters with row-by-row alignment (EU sample 044): first locate the
  // gutter; for borderless tables, search only within each column (otherwise, labels at the same
  // height across two columns might align into a single table spanning both columns). Re-verify
  // once image regions are available later.
  const early = findPageGutter(
    leveled,
    // Model image regions that have not been cleaned up yet (small page forms are often boxed into a large image) are excluded; re-verified later using cleaned regions.
    [...ruled.map((t) => t.box), ...figures.map((f) => f.box)],
    lineHeight,
    image,
  );
  const bySide = (ls: readonly OcrBox[]) =>
    early ? [-1, 0, 1].map((k) => ls.filter((l) => sideOfGutter(l, early) === k)) : [ls];
  const textTables = (repairTables ? (input.regions ?? []) : [])
    .filter((r) => r.kind === 'table' && !ruled.some((t) => lineShareIn(r.box, t.box) >= 0.5))
    .flatMap((r) =>
      bySide(
        leveled.filter((l) => !boundedLines.has(l) && lineShareIn(orig(l), r.box) >= 0.5),
      ).flatMap((members) => {
        const found = findTextTables(members, lineHeight, orig, true);
        for (const t of found) for (const l of t.lines) boundedLines.add(l);
        return found;
      }),
    );
  const repairBoxes = [...rejected.map((t) => t.box), ...textTables.map((t) => t.box)];
  const repairBaseline = repairBoxes.length
    ? buildPage(input, options, protectFigures, false, repairBarcodes)
    : undefined;
  textTables.push(
    ...bySide(leveled.filter((l) => !boundedLines.has(l))).flatMap((part) =>
      findTextTables(part, lineHeight, orig),
    ),
  );
  const inTextTable = new Set(textTables.flatMap((t) => t.lines));
  for (const t of textTables) {
    const h = median(t.lines.map((l) => l.height));
    tables.push({
      kind: 'table',
      table: t.table,
      colWidths: t.colWidths,
      borderless: true,
      ...(h ? { size: Math.min(BODY_MAX, Math.max(FORM_MIN, fontSizeOf(h, fontWidthPx))) } : {}),
      box: t.box,
    });
  }
  // Barcodes (D-471): cropped as images; ignore sporadic text recognized within them. Gaps without
  // text inside bordered tables (several parallel column lines) are not barcodes (D-501).
  const oldBarcodes = findBarcodes(working, kept, lineHeight);
  const barcodes = (
    repairBarcodes && !oldBarcodes.length
      ? findBarcodes(working, available, lineHeight, true)
      : oldBarcodes
  ).filter(
    (b) =>
      !tables.some((t) => !t.borderless && inBox(b, t.box)) &&
      // One of several side-by-side tables spanning across white gutters (EU sample 090): if the majority is inside the table, it is not a barcode either.
      tables.reduce((n, t) => n + (t.borderless ? 0 : lineShareIn(b, t.box)), 0) < 0.5,
  );
  if (repairBarcodes && protectFigures && repairTables && !oldBarcodes.length && barcodes.length) {
    const baseline = buildPage(input, options, protectFigures, repairTables, false);
    const pictures = leafBlocks(baseline).filter((b) => b.kind === 'image');
    const missing = barcodes.filter((b) => !pictures.some((p) => lineShareIn(b, p.box) >= 0.8));
    return donePage(missing.length ? insertWordFigures(baseline, missing) : baseline);
  }
  const inBarcode = (l: OcrBox) => {
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    return barcodes.some(
      (b) => cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height,
    );
  };
  const free = leveled.filter((l) => !inTextTable.has(l) && !inBarcode(orig(l)));
  return nextStage({ early, repairBoxes, repairBaseline, barcodes, free });
}
export type TextTablesState = StageState<ReturnType<typeof buildTextTables>>;

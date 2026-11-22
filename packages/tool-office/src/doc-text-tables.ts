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

/** 补无框表和条形码，必要时回到未修复的整页。 */
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

  // 没有线的表（D-471）：几排按三列以上对齐的，排成没有边框的表，不接成一句话。
  // 模型只提供范围，不能凭模型直接造表。范围内仍要有三列、多排同时对齐；
  // 已经被带线表接管的范围不重建，整页其余的字沿用原来的严格规则。
  const boundedLines = new Set<OcrBox>();
  // 整页左右两栏、两栏的行一排一排对齐（EU 样本 044）：先找中缝，没有线的表只在每一栏里找
  // （不然两栏同一高度的标签对齐成一张横跨两栏的表）。后面有了图片区域再核对一次。
  const early = findPageGutter(
    leveled,
    // 模型的图片区域还没清理（整页的小表单常被框成一张大图），不算；后面用清理过的再核对。
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
  // 条形码（D-471）：剪成图片，里面认出来的零星的字不要。
  // 带线的表里一段没字的地方（几条平行的列线）不是条形码（D-501）。
  const oldBarcodes = findBarcodes(working, kept, lineHeight);
  const barcodes = (
    repairBarcodes && !oldBarcodes.length
      ? findBarcodes(working, available, lineHeight, true)
      : oldBarcodes
  ).filter(
    (b) =>
      !tables.some((t) => !t.borderless && inBox(b, t.box)) &&
      // 横跨并排的几张表（中间隔着白缝，EU 样本 090）的一条：大半在表里，也不是条形码。
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

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

/** 找线组表，保留空白填写格并释放误判的网格。 */
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

  // 带线的表格（和转 Excel 一样）；放进表格的行不再参加分段。
  const placedIn = new Map<TableBlock, readonly OcrBox[]>();
  const choppedIn = new Map<TableBlock, number>();
  // 横竖线画满的网格（格子都是线分出来的），只有这样的才可能是留给人填的空白表格。
  const ruledGrids = new Set<TableBlock>();
  const blankForm = (t: TableBlock) => ruledGrids.has(t) && isBlankFormGrid(t);
  // 只是框着几行字的框（EU 样本 075 的信）：不当表，字放回正文。
  const framedTexts = new Set<TableBlock>();
  const tableInput = {
    image: working,
    lines: available,
    name: '',
    source: input.source,
    ...(tableSkew !== undefined ? { skew: tableSkew } : {}),
  };
  // 格子里的字按原图一排一行（D-333）：表单一格里的地址、日期各占一行，不接成一段（Word 里格子宽按原图，字号按比例）。
  // 没有线的表在下面去掉竖排、零星的字以后再认（D-471）。
  const tableOptions = (splitStacked: boolean): BuildOptions => ({
    ...options,
    textTables: false,
    // 电子版模板常用很浅的灰线画表（EU 样本 001、006），转 Word 时也找。
    lightRules: true,
    // 空白的商品栏：表头写在网格上面（EU 样本 001）。
    headerAbove: true,
    splitStacked,
    joinLines: (cell) => {
      const rows = rowsOf(cell);
      // 一格里是一段正文（框起来的提示，EU 样本 038）：接成一段，在 Word 里能重新折行。
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
  // 列线把很多行字从词中间切开的表（D-502）：网格认错了（字的笔画、折痕当成了列线），不当表，
  // 里面的字按行排（没有线的表照样能认出来）。
  const chopsMuch = (t: TableBlock) => {
    const chopped = choppedIn.get(t) ?? 0;
    return chopped >= CHOP_MIN && chopped >= CHOP_SHARE * (placedIn.get(t)?.length ?? 0);
  };
  // 图内的网格（表大半在图里）不要；图跨过表的好几格时（整页的版式框把图表框在里面，D-533）也不要。
  // 图在表的一格里（表单的证件照占着合并的一格）时表照样要；只是边上压进表的一格（表上面的标志剪下来时带着
  // 下面一点，EU 样本 062）也照样要：看压进表里的那一部分在不在一格里。
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
  // 共用一个外框、上下叠着的几张表（EU 样本 004 的登记表）连成了一张：在列线换了的横线处分开（findTables 的
  // splitStacked），每张各自判断。原来要当表的，分开后能当表的部分当表（都不能时照旧整张）；原来被当成表单画线
  // 丢掉、或者太空被拆开的，只把其中的空白表格（isBlankFormGrid）留下当表，别的部分照旧排成文字。
  const stacked = buildTablePage(tableInput, tableOptions(true));
  const stackedTables = stacked.blocks.filter((b): b is TableBlock => b.kind === 'table');
  const ruled: TableBlock[] = [];
  const rejected: TableBlock[] = [];
  // 当成表单画线不要的网格（或者分开后不要的部分）里，一排排的填写框照样当表（EU 样本 062）。
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
    // 表里的字号按表里文字的行高（D-335），和正文分开算。
    const h = median(lines.filter((l) => inBox(l, table.box)).map((l) => l.height));
    return {
      kind: 'table',
      ...(rotated ? { direction: 'tbRl' as const } : {}),
      // 空着的列够写字（填写栏）时不并：只并双线之间、细缝那样的窄列。
      table: foldEmptyColumns({ ...table, col: 0 }, FILL_IN_LINES * lineHeight),
      colWidths: colWidthsOf.get(table)!.slice(table.col, table.col + table.cols),
      ...(h ? { size: Math.min(BODY_MAX, Math.max(FORM_MIN, fontSizeOf(h, fontWidthPx))) } : {}),
      box: table.box,
    };
  });
  return nextStage({ placedIn, inBox, ruled, rejected, tables });
}
export type RuledTablesState = StageState<ReturnType<typeof buildRuledTables>>;

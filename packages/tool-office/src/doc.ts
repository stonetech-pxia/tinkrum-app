import { buildPage } from './doc-build';
import {
  arrangeUnits,
  defaultJoin,
  type DocBuildOptions,
  type DocLeaf,
  type DocPage,
  type DocPageInput,
  type DocTable,
  fitPaper,
  insertWordFigures,
  leafBlocks,
  median,
  rowsOf,
} from './doc-support';
import { lineShareIn } from './layout';
import { recoverPictureCards } from './word-cards';
import { restoreWordCellSpans } from './word-cell-spans';
import { restoreWordFormRows } from './word-form-rows';
export {
  A4_WIDTH_PT,
  arrangeUnits,
  BOLD_RATIO,
  CHOP_MIN,
  CHOP_SHARE,
  clusterLines,
  fieldBoxTables,
  fitPaper,
  flowCellBlocks,
  foldEmptyColumns,
  fontSizeOf,
  hasUnderline,
  IMAGE_PAD,
  insertWordFigures,
  isBlankFormGrid,
  isRuleGrid,
  isVertical,
  joinListContinuations,
  leafBlocks,
  looksLikeHeading,
  mergeColumnRows,
  mergeTextRegions,
  paragraphsOf,
  splitLabelColumn,
  strokeRatio,
  textColor,
  textEm,
  verticalBoxes,
  type DocBlock,
  type DocBuildOptions,
  type DocDoc,
  type DocImage,
  type DocLeaf,
  type DocList,
  type DocPage,
  type DocPageInput,
  type DocParagraph,
  type DocRow,
  type DocRowCell,
  type DocRun,
  type DocSpace,
  type DocStyle,
  type DocTable,
} from './doc-support';

/** 一页的 DocPage。 */
export function buildDocPage(input: DocPageInput, options: DocBuildOptions = {}): DocPage {
  if (input.paper) input = { ...input, paper: fitPaper(input.paper) };
  const page = buildPage(input, options, true);
  const next = recoverPictureCards(
    page,
    input.image,
    input.lines,
    median(input.lines.map((l) => l.height)) || 20,
  );
  const form = leafBlocks(next).find(
    (b) =>
      b.kind === 'table' &&
      !b.borderless &&
      b.box.height > input.image.height * 0.5 &&
      b.box.y < input.image.height * 0.3,
  );
  if (form) {
    const header = next.blocks.filter((b) => b.box.y + b.box.height <= form.box.y);
    const leaves = leafBlocks({ blocks: header });
    const compact = (s: string) => s.replace(/\s/g, '');
    let split = false;
    const parts = leaves.flatMap((b): DocLeaf[] => {
      if (b.kind !== 'paragraph' || b.text.length > 160) return [b];
      const rows = rowsOf(input.lines.filter((l) => lineShareIn(l, b.box) >= 0.8));
      if (
        rows.length < 2 ||
        rows.length > 6 ||
        compact(rows.map((r) => r.text).join('')) !== compact(b.text)
      )
        return [b];
      split = true;
      const { runs: _runs, ...style } = b;
      return rows.map((r) => ({ ...style, text: r.text, box: r.box }));
    });
    if (split || header.length > 1)
      next.blocks = [
        ...arrangeUnits(
          parts.map((b) => ({ box: b.box, blocks: [b] })),
          median(input.lines.map((l) => l.height)) || 20,
        ),
        ...next.blocks.filter((b) => !header.includes(b)),
      ];
  }
  for (const block of leafBlocks(next)) {
    if (block.kind !== 'table' || block.direction) continue;
    restoreWordFormRows(block, input.image, input.lines, options.joinLines ?? defaultJoin);
    restoreWordCellSpans(block, input.image, input.lines, options.joinLines ?? defaultJoin);
    const layout: NonNullable<DocTable['cellLayout']> = [];
    for (const cell of block.table.cells) {
      const box = cell.box;
      if (!box || !cell.text.trim()) continue;
      const lines = input.lines.filter((l) => {
        const x = l.x + l.width / 2,
          y = l.y + l.height / 2;
        return (
          x >= box.x &&
          x < box.x + box.width &&
          y >= box.y &&
          y < box.y + box.height &&
          l.x >= box.x - 2 &&
          l.x + l.width <= box.x + box.width + 2
        );
      });
      const rows = rowsOf(lines);
      // 跨格识别行已在组表时按字符切过；不能拿整行框给某一格定位。
      const compact = (s: string) => s.replace(/\s/g, '');
      if (
        rows.length !== cell.text.split('\n').length ||
        compact(rows.map((r) => r.text).join('')) !== compact(cell.text)
      )
        continue;
      layout.push({
        row: cell.row,
        col: cell.col,
        lines: rows.map((r, i) => ({
          ...r.box,
          ...(r.lines.length > 1 && cell.text.split('\n')[i]?.split('\t').length === r.lines.length
            ? { tabs: r.lines.slice(1).map((l) => l.x) }
            : {}),
        })),
      });
    }
    if (layout.length) block.cellLayout = layout;
  }
  if (input.prior && input.nativeFigures?.length) {
    const candidate = insertWordFigures(input.prior, input.nativeFigures);
    // 只换图且可编辑块完全相同时保留原分栏顺序；组表或正文有变化时仍用隔离后的重建结果。
    const signature = (page: DocPage) =>
      leafBlocks(page)
        .filter((b) => b.kind !== 'image')
        .map((b) => {
          if (b.kind === 'table')
            return JSON.stringify([
              b.kind,
              b.table.rows,
              b.table.cols,
              b.table.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.text]),
            ]);
          return JSON.stringify([
            b.kind,
            b.kind === 'paragraph' ? b.text : b.kind === 'list' ? b.items : b.box,
          ]);
        })
        .sort()
        .join('\n');
    if (
      signature(candidate) === signature(next) &&
      leafBlocks(candidate).filter((b) => b.kind === 'image').length ===
        leafBlocks(next).filter((b) => b.kind === 'image').length
    )
      return candidate;
  }
  return next;
}

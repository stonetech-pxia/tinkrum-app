import { type PageBuildContext, type StageState, donePage, nextStage } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import { type PageRegionsState } from './doc-regions';
import {
  DENSE_LINES,
  type DocBlock,
  type DocPage,
  alignmentIn,
  arrangeColumns,
  joinListContinuations,
  leafBlocks,
} from './doc-support';
import { type TextLinesState } from './doc-text-lines';
import { type TextTablesState } from './doc-text-tables';
import { type PageTypographyState } from './doc-typography';
import { lineShareIn, readingOrder } from './layout';
import { type OcrBox } from './types';
import { FILL_RUN } from './word-fill-ins';

/** 排列阅读顺序，只替换已确认的修表范围。 */
export function composePage(
  state: Pick<PageBuildContext, 'input'> &
    Pick<PreparePageState, 'image' | 'paper' | 'lineHeight' | 'lines'> &
    Pick<PageTypographyState, 'bodySize' | 'units' | 'alignment'> &
    Pick<PageRegionsState, 'gutter'> &
    Pick<TextTablesState, 'repairBaseline' | 'repairBoxes'> &
    Pick<TextLinesState, 'synthetic'>,
) {
  const {
    input,
    image,
    paper,
    bodySize,
    units,
    lineHeight,
    gutter,
    lines,
    alignment,
    repairBaseline,
    synthetic,
    repairBoxes,
  } = state;

  const page: DocPage = {
    source: input.source,
    width: image.width,
    height: image.height,
    ...(paper ? { paper } : {}),
    bodySize,
    blocks: arrangeColumns(units, lineHeight, gutter, {
      // 密集页沿用原来的局部并排行；长表格的标题 keepNext 会改变跨页行为，另行处理分页。
      dense: lines.length >= DENSE_LINES,
      onColumns: (row) => {
        let left = row.box.x;
        for (const cell of row.cells) {
          for (const block of cell.blocks) {
            if (block.kind !== 'paragraph') continue;
            const source = alignment.get(block);
            if (!source) continue;
            const align = alignmentIn(block.box, source.h, source.rows, left, left + cell.width);
            if (align) block.align = align;
            else delete block.align;
          }
          left += cell.width;
        }
      },
    }),
  };
  page.blocks = joinListContinuations(page.blocks, lineHeight);
  if (repairBaseline) {
    // 组表会改变整页字号、分组统计。只替换修复范围中的顶层块，范围外继续用原来的
    // 段落和并排行（包括它们的顺序和样式），避免修一张表挪动上方的日期、署名。
    // 按识别行归属换块：两边分段不同（修复范围上面的段落接进了网格的第一行）时，
    // 一行字所在的块两边一起换，直到两边换的块装着同一批行，不丢字也不重复。
    // 自成一行的填写处（一串点）也算一行，它在哪一块里按位置找。
    const every = [...lines, ...synthetic];
    const linesOf = (b: DocBlock) => {
      const boxes = leafBlocks({ blocks: [b] }).map((leaf) => leaf.box);
      return every.filter((l) => {
        const cx = l.x + l.width / 2,
          cy = l.y + l.height / 2;
        return boxes.some(
          (box) =>
            cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height,
        );
      });
    };
    const oldLines = new Map(repairBaseline.blocks.map((b) => [b, linesOf(b)] as const));
    const newLines = new Map(page.blocks.map((b) => [b, linesOf(b)] as const));
    const owned = new Set(
      every.filter((l) => repairBoxes.some((box) => lineShareIn(l, box) >= 0.5)),
    );
    const touches = (members: readonly OcrBox[]) => members.some((l) => owned.has(l));
    for (let size = -1; size !== owned.size;) {
      size = owned.size;
      for (const members of [...oldLines.values(), ...newLines.values()])
        if (touches(members)) for (const l of members) owned.add(l);
    }
    const merged = readingOrder(
      [
        ...repairBaseline.blocks.filter((b) => !touches(oldLines.get(b)!)),
        ...page.blocks.filter((b) => touches(newLines.get(b)!)),
      ],
      lineHeight * 0.3,
      lineHeight,
    );
    // 拼好以后的字必须和整页重建的字一样多：对不上（行和块对不准）就不修这一页。
    const words = (blocks: readonly DocBlock[]) =>
      leafBlocks({ blocks })
        .flatMap((b) =>
          b.kind === 'paragraph'
            ? [b.text]
            : b.kind === 'list'
              ? b.items
              : b.kind === 'table'
                ? b.table.cells.map((c) => c.text)
                : [],
        )
        .join(' ')
        // 填写处（「....」「____」）的长短跟着它接在哪一行，不算字。
        .replace(FILL_RUN, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(' ');
    if (words(merged) !== words(page.blocks)) return donePage(repairBaseline);
    page.blocks = merged;
  }
  return nextStage({ page });
}
export type ComposedPageState = StageState<ReturnType<typeof composePage>>;

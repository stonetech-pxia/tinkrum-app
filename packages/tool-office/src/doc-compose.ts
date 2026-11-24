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

/** Arrange reading order, replacing only confirmed table-repair ranges. */
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
      // Dense pages retain original local side-by-side layout; long table titles with keepNext change pagination behavior, so handle pagination separately.
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
    // Table grouping changes page-wide font sizes and group statistics. Replace only top-level
    // blocks within the repair range; outside the range, continue using original paragraphs and
    // side-by-side layouts (including their order and styles) to avoid shifting dates or signatures
    // above when repairing a table. Swap blocks based on recognition row ownership: when both sides
    // have different paragraph splits (paragraphs above the repair range merged into the first row
    // of the grid), replace blocks containing the text rows on both sides together until both
    // sides' blocks contain the same set of rows, without losing or duplicating text. Fill-in areas
    // forming a single line (a string of dots) are also treated as a line, locating their block by
    // position.
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
    // The text after composition must have the same length as the text from full-page reconstruction; if they do not match (rows and blocks misaligned), this page is not repaired.
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
        // Length of fill-in areas ('....', '____') matches the line they attach to, and they are not counted as text characters.
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

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

/** 接回填写处和列表记号，保留识别行与原图的对应。 */
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

  // 按实际放进格子的行算（D-501）：表格边线外面、横跨列线的字没放进表，照样排成正文，不丢。
  const inTable = new Set(ruled.flatMap((t) => placedIn.get(t) ?? []));
  // 整页的倾斜（D-471）：照片拍歪、纸弯了时按斜线分行；拉平以后的行只用来分行、分段、排位置，
  // 量笔画、颜色、下划线还是看原图里原来的位置。
  const outside = available.filter((l) => !inTable.has(l) && !isStray(l, lines, lineHeight, image));
  // 竖排、旋转的字（页边的竖排标志、侧边的说明、条码旁的编号）：认出来的字多半是乱的，
  // 放进正文又会把字号撑得很大。整块剪成图片，原样保留。
  const upright = outside.filter((l) => !isVertical(l));
  // 表单的填写处（一串点、标签右边的横线）接进同一排的标签后面，或者自成一行（EU 样本 021、030）。
  const fills = findFillIns(
    working,
    dots,
    cachedLines(working, { ...(tableSkew !== undefined ? { skew: tableSkew } : {}), light: true }),
    upright,
    lineHeight,
    [...tables.map((t) => t.box), ...figures.map((f) => f.box)],
  );
  const withFills = withFillIns(upright, fills, lineHeight);
  // 句子中间一块块要填的底色（EU 样本 082）：隔开的几段接回一行。
  const shaded = joinShadedBlanks(image, withFills.lines, lineHeight);
  const filled = shaded.lines;
  const fillSource = new Map(withFills.source);
  for (const [l, from] of shaded.source) fillSource.set(l, withFills.source.get(from) ?? from);
  const synthetic = new Set(filled.filter((l) => !fillSource.has(l) && !upright.includes(l)));
  // 识别漏了的列表记号（「•」「-」）补在行的前面（EU 样本 026、027）。
  const { lines: kept, source: bulletSource } = withBullets(image, filled);
  const verticals = verticalBoxes(outside.filter(isVertical), cropLineHeight, {
    width: image.width,
    height: image.height,
  });
  const originalOf = new Map<OcrBox, OcrBox>();
  const leveled = levelLines(kept, lineHeight, image.width / 2);
  leveled.forEach((flat, k) => originalOf.set(flat, kept[k]!));
  // 原来的识别行（接了填写处的行换回识别出的那一行：量笔画、颜色、下划线，找它在哪张表里）。
  const orig = (l: OcrBox) => {
    const o = originalOf.get(l) ?? l;
    const b = bulletSource.get(o) ?? o;
    return fillSource.get(b) ?? b;
  };
  const releasedCells = new Map<OcrBox, TableCell>();
  for (const table of rejected) {
    const placed = placedIn.get(table) ?? [];
    const cellOf = (l: OcrBox) => table.cells.find((c) => c.box && lineShareIn(l, c.box) >= 0.5);
    // 上下两格之间没画横线（字之间是白纸）时算同一格：信的外框右边每行一个小刻度，网格一行字切一排，
    // 去掉网格以后照样一行一段（EU 样本 075）。真画了横线的（议程的格子）仍是各自一条。
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

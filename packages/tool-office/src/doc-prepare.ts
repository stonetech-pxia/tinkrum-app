import { type PageBuildContext, type StageState, donePage, nextStage } from './doc-build-state';
import {
  A4_WIDTH_PT,
  DENSE_LINES,
  defaultJoin,
  leafBlocks,
  median,
  photoPaper,
} from './doc-support';
import { type LayoutRegion, lineShareIn } from './layout';
import { findLines } from './lines';
import { type Box } from './types';
import { figureOwns, figureWorkingImage, planWordFigures } from './word-figures';
import { leaderDots } from './word-fill-ins';

/** 隔离整图并准备像素、纸张和识别行。 */
export function preparePage(
  state: Pick<
    PageBuildContext,
    'options' | 'input' | 'protectFigures' | 'buildPage' | 'repairTables' | 'repairBarcodes'
  >,
) {
  const { options, input, protectFigures, buildPage, repairTables, repairBarcodes } = state;

  const join = options.joinLines ?? defaultJoin;
  const { image } = input;
  const paper = input.paper ?? photoPaper(image);
  // 按 Word 的纸宽估字：窄幅 PDF 按它的物理宽度；横向的纸（横向 A4 的 PDF、横拍的照片）按 842 磅宽，
  // 不按竖向 A4 的 595 磅，不然字整体只有原来的 0.71 倍。比 A3 大的纸已经由 fitPaper 缩过，不会因此放大字。
  const fontWidthPx = (image.width * A4_WIDTH_PT) / (paper?.width ?? A4_WIDTH_PT);
  const lines = input.lines.filter((l) => l.text.trim());
  const joinParagraph = lines.length < DENSE_LINES ? (options.joinParagraph ?? join) : join;
  const rotatedLines = lines.filter((l) => l.text.trim().length >= 4 && l.height > 2 * l.width);
  const rotated =
    !!input.paper &&
    image.width > image.height &&
    rotatedLines.length >= 4 &&
    rotatedLines.reduce((n, l) => n + l.text.length, 0) >=
      0.7 * lines.reduce((n, l) => n + l.text.length, 0);
  const lineHeight =
    median(lines.map((l) => (rotated ? Math.min(l.width, l.height) : l.height))) || 20;
  const cropLineHeight = rotated ? median(lines.map((l) => l.height)) || 20 : lineHeight;
  const native = protectFigures && input.nativeFigures?.length ? input.nativeFigures : undefined;
  const sourceRegions: readonly LayoutRegion[] = native
    ? [
        ...(input.regions ?? []).filter(
          (r) => !native.some((b) => lineShareIn(r.box, b) >= (r.kind === 'image' ? 0.5 : 0.8)),
        ),
        ...native.map((box): LayoutRegion => ({ kind: 'image', label: 'image', score: 1, box })),
      ]
    : (input.regions ?? []);
  const figures = native
    ? sourceRegions
        .filter((r) => native.includes(r.box))
        .map((region) => ({ region, box: region.box }))
    : protectFigures
      ? planWordFigures(image, lines, sourceRegions, lineHeight)
      : [];
  const previous = native
    ? input.prior
    : figures.length
      ? buildPage(input, options, false, repairTables, repairBarcodes)
      : undefined;
  // 旧路径已经完整保图且没有输出图内文字/表格时，不重排原本正确的页。
  if (
    previous &&
    !native &&
    figures.every(
      (f) =>
        leafBlocks(previous).some((b) => b.kind === 'image' && lineShareIn(f.box, b.box) >= 0.9) &&
        !leafBlocks(previous).some((b) => b.kind !== 'image' && lineShareIn(b.box, f.box) >= 0.2),
    )
  )
    return donePage(previous);
  // 原生整图：图里的字只有画进了剪图才归图。和剪图外的原生字（nativeText）重叠的识别行留作正文，
  // 不然一段只有一部分在图里的 PDF 文字（轴标签和图旁的说明连在一起）在图里、正文里都没有。
  const owns = (box: Box) =>
    native
      ? figures.some((f) => lineShareIn(box, f.box) > 0.8) &&
        !input.nativeText?.some((t) => lineShareIn(box, t) >= 0.5)
      : figureOwns(box, figures);
  const available = figures.length ? lines.filter((l) => !owns(l)) : lines;
  // 表单的点线（填写处）先从找线、组表用的图里抹掉，后面接进标签那一行（EU 样本 021）。
  const { dots, erased: working } = leaderDots(
    figureWorkingImage(image, figures, lineHeight),
    lines,
    lineHeight,
  );
  // 抹掉图形不能顺带改变图外网格的坐标系；倾斜仍按原图估计。
  const tableSkew = input.skew ?? (figures.length ? findLines(image).skew : undefined);
  const layout = figures.length
    ? sourceRegions.flatMap((r) => {
        const owned = figures.find((f) => f.region === r);
        if (owned) return [{ ...r, box: owned.box }];
        return r.kind !== 'image' && owns(r.box) ? [] : [r];
      })
    : sourceRegions;
  return nextStage({
    join,
    image,
    paper,
    fontWidthPx,
    lines,
    joinParagraph,
    rotated,
    lineHeight,
    cropLineHeight,
    native,
    figures,
    previous,
    owns,
    available,
    dots,
    working,
    tableSkew,
    layout,
  });
}
export type PreparePageState = StageState<ReturnType<typeof preparePage>>;

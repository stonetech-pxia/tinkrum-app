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

/** Isolate full images and prepare pixels, paper, and recognition lines. */
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
  // Estimate font width based on Word paper width: narrow PDFs use their physical width; landscape
  // pages (landscape A4 PDFs, landscape photos) use 842 points width instead of portrait A4's 595
  // points, otherwise text scales down to 0.71x its original size. Pages larger than A3 have
  // already been scaled by fitPaper and will not be enlarged by this.
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
  // Do not re-layout originally correct pages when the legacy path already preserves the image completely and outputs no in-image text/tables.
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
  // Native full image: text inside the image belongs to the image only if rendered inside the
  // clipping. Recognition lines overlapping native text outside the clipping (nativeText) are
  // retained as body text, preventing PDF text that is partially inside an image (such as axis
  // labels connected to descriptions beside graphs) from being lost in both the image and body
  // text.
  const owns = (box: Box) =>
    native
      ? figures.some((f) => lineShareIn(box, f.box) > 0.8) &&
        !input.nativeText?.some((t) => lineShareIn(box, t) >= 0.5)
      : figureOwns(box, figures);
  const available = figures.length ? lines.filter((l) => !owns(l)) : lines;
  // Erase dotted lines (fill-in areas) from the line-finding and table-grouping image first, then attach them back to the corresponding label line (EU sample 021).
  const { dots, erased: working } = leaderDots(
    figureWorkingImage(image, figures, lineHeight),
    lines,
    lineHeight,
  );
  // Erasing graphics must not alter the coordinate system of grids outside images; skew is still estimated from the original image.
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

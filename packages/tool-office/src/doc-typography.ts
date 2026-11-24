import { type PageBuildContext, type StageState, nextStage } from './doc-build-state';
import { type PreparePageState } from './doc-prepare';
import { type PageRegionsState } from './doc-regions';
import { type RuledTablesState } from './doc-ruled-tables';
import {
  A4_WIDTH_PT,
  BODY_MAX,
  BODY_MIN,
  BODY_SNAP,
  BOLD_RATIO,
  BOX_TO_FONT,
  DENSE_LINES,
  type DocLeaf,
  type DocParagraph,
  type DocStyle,
  FORM_MIN,
  HEADING_RATIO,
  PROSE_LINE,
  PROSE_SHARE,
  SHORT_TEXT,
  type Unit,
  WIDTH_CLAMP,
  WIDTH_SNAP,
  WIDTH_SPREAD,
  fontSizeOf,
  hasUnderline,
  median,
  reconcileTextGroups,
  strokeRatio,
  textColor,
  widthSizeOf,
} from './doc-support';
import { type TextLinesState } from './doc-text-lines';
import { type TextTablesState } from './doc-text-tables';
import { findLines } from './lines';
import { pageSlope } from './text-table';
import { type OcrBox } from './types';

/** Estimate font size, boldness, color, and underlines for body text and paragraphs. */
export function measurePageTypography(
  state: Pick<TextTablesState, 'free' | 'repairBaseline'> &
    Pick<TextLinesState, 'synthetic' | 'orig'> &
    Pick<
      PreparePageState,
      'image' | 'lines' | 'lineHeight' | 'tableSkew' | 'previous' | 'fontWidthPx' | 'join'
    > &
    Pick<PageRegionsState, 'groups' | 'images'> &
    Pick<RuledTablesState, 'tables'> &
    Pick<PageBuildContext, 'input'>,
) {
  const {
    free,
    synthetic,
    orig,
    image,
    lines,
    lineHeight,
    tableSkew,
    repairBaseline,
    previous,
    fontWidthPx,
    tables,
    images,
    input,
    join,
  } = state;
  let { groups } = state;

  // Font size and stroke: first measure the page body font size and stroke weight, then compare against them.
  const strokes = new Map<OcrBox, number>();
  for (const l of free) strokes.set(l, synthetic.has(orig(l)) ? 0 : strokeRatio(image, orig(l)));
  const pageStroke = median([...strokes.values()].filter((v) => v > 0));
  // Line height used for estimating font size (same as D-521): after straightening scans, a slight
  // skew (0.3–1°) remains, causing long-line recognition boxes to be taller than the font height by
  // width × slope; footers and similar long lines would be measured as heading size (EU sample
  // 050), so they are deducted. Counted only if skews estimated from characters and lines match
  // (when two-column body baselines are offset, character-based slope estimation is inaccurate;
  // borderless pages are not deducted).
  const tilt = Math.min(
    Math.abs(pageSlope(lines, lineHeight)),
    Math.abs(Math.tan(((tableSkew ?? findLines(image).skew) * Math.PI) / 180)),
  );
  const sizeHeight = (l: OcrBox) => Math.max(0.6 * l.height, l.height - tilt * l.width);
  const bodyHeight = median(groups.filter((g) => !g.title).flatMap((g) => g.lines.map(sizeHeight)));
  const bodyH = bodyHeight || lineHeight;
  // Body page versus form page (D-335): count the proportion of characters in long lines (at least 40% page width) relative to the entire page (including tables).
  const charsOf = (ls: readonly OcrBox[]) => ls.reduce((n, l) => n + l.text.length, 0);
  const prose =
    charsOf(lines.filter((l) => l.width >= PROSE_LINE * image.width)) >=
    PROSE_SHARE * charsOf(lines);
  // Modify only image ownership; do not let the removal of intra-image labels alter the default font size of the entire page.
  const bodySize =
    repairBaseline?.bodySize ??
    previous?.bodySize ??
    Math.min(
      BODY_MAX,
      Math.max(
        prose && lines.length < DENSE_LINES ? BODY_MIN : FORM_MIN,
        fontSizeOf(bodyH, fontWidthPx),
      ),
    );
  // Body line height scaled by paper width, unconstrained raw font size.
  const rawBodySize = (bodyH * A4_WIDTH_PT * BOX_TO_FONT) / fontWidthPx;
  // Estimate font size by character width (D-463): used only when body line estimates are sufficiently consistent.
  const bodyWidths = groups
    .filter((g) => !g.title)
    .flatMap((g) => g.lines.map(widthSizeOf))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const bodyW = median(bodyWidths);
  const widthTrusted =
    bodyWidths.length >= 3 &&
    bodyWidths[Math.floor(bodyWidths.length * 0.75)]! -
      bodyWidths[Math.floor(bodyWidths.length * 0.25)]! <=
      WIDTH_SPREAD * bodyW;
  // Left and right boundaries of page text (used for determining centering).
  const textLeft = Math.min(...free.map((l) => l.x), ...tables.map((t) => t.box.x));
  const textRight = Math.max(
    ...free.map((l) => l.x + l.width),
    ...tables.map((t) => t.box.x + t.box.width),
  );
  // Pre-arrange reading order of blocks (regions, tables, images), keeping paragraphs inside blocks top-to-bottom.
  const units: Unit[] = [
    ...tables.map((t) => ({ box: t.box, blocks: [t] as DocLeaf[] })),
    ...images.map((im) => ({ box: im.box, blocks: [im] as DocLeaf[] })),
  ];
  const alignment = new Map<DocParagraph, { h: number; rows: number }>();
  const styleOf = (paraLines: readonly OcrBox[], text: string, title: number) => {
    const h = median(paraLines.map(sizeHeight));
    const short = (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < SHORT_TEXT && !title;
    const byHeight = h / bodyH;
    const w = widthTrusted ? median(paraLines.map(widthSizeOf).filter((v) => v > 0)) : 0;
    const byWidth =
      w > 0 && w / bodyW <= byHeight * WIDTH_CLAMP && w / bodyW >= byHeight / WIDTH_CLAMP
        ? w / bodyW
        : 0;
    let size = Math.min(48, Math.max(6, Math.round(bodySize * (byWidth || byHeight) * 2) / 2));
    const snap = byWidth ? WIDTH_SNAP : BODY_SNAP;
    if (short || Math.abs(size - bodySize) <= snap * bodySize) size = bodySize;
    // When paper dimensions are known, prevent the minimum body font size from scaling up large headings proportionally again.
    if (input.paper && !short && size >= HEADING_RATIO * bodySize) {
      // All-caps lines lack descenders and have shorter bounding boxes than same-size lines; using
      // their own box height makes them read too small (e.g., 16.3 pt read as 13 pt): preserve
      // character width proportionality, removing only the padding added to body text by the
      // minimum font size constraint.
      if (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text))
        size = Math.min(size, Math.max(6, Math.round(((size * rawBodySize) / bodySize) * 2) / 2));
      else size = Math.min(size, fontSizeOf(h, fontWidthPx));
    }
    const bold =
      pageStroke > 0 && median(paraLines.map((l) => strokes.get(l) ?? 0)) > BOLD_RATIO * pageStroke;
    const color = textColor(image, orig(paraLines[0]!));
    // Underline: present beneath every line (D-463).
    const underline = paraLines.every((l) => hasUnderline(image, orig(l)));
    const style: DocStyle = {
      ...(size !== bodySize ? { size } : {}),
      ...(bold ? { bold: true } : {}),
      ...(underline ? { underline: true } : {}),
      ...(color ? { color } : {}),
    };
    return { h, short, size, style };
  };
  // Dense pages retain their original groupings to avoid disrupting existing multi-page layout; only fragments with consistent inferred font sizes, bold styles, etc., are spliced.
  const origin = new Map(groups.flatMap((group) => group.lines.map((l) => [l, group] as const)));
  if (lines.length < DENSE_LINES)
    groups = reconcileTextGroups(groups, free, lineHeight, (a, b) => {
      const left = styleOf(a, join(a).trim(), 0);
      const right = styleOf(b, join(b).trim(), 0);
      return left.size === right.size && JSON.stringify(left.style) === JSON.stringify(right.style);
    });
  return nextStage({ bodySize, textLeft, textRight, units, alignment, styleOf, origin, groups });
}
export type PageTypographyState = StageState<ReturnType<typeof measurePageTypography>>;

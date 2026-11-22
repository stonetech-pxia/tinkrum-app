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

/** 估计正文和段落的字号、粗体、颜色及下划线。 */
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

  // 字号和笔画：先量出整页的正文字号和笔画粗细，再和它比。
  const strokes = new Map<OcrBox, number>();
  for (const l of free) strokes.set(l, synthetic.has(orig(l)) ? 0 : strokeRatio(image, orig(l)));
  const pageStroke = median([...strokes.values()].filter((v) => v > 0));
  // 估字号用的行高（同 D-521）：扫描件拉正以后还剩一点斜（0.3–1°），长行的识别框比字高出 宽 × 斜率 一截，
  // 页脚这样的长行会被量成标题那么大（EU 样本 050），扣掉。按字估的斜率和按线估的都斜才算
  // （两栏正文的基线错开时，按字估的斜率不准；没有线的页不扣）。
  const tilt = Math.min(
    Math.abs(pageSlope(lines, lineHeight)),
    Math.abs(Math.tan(((tableSkew ?? findLines(image).skew) * Math.PI) / 180)),
  );
  const sizeHeight = (l: OcrBox) => Math.max(0.6 * l.height, l.height - tilt * l.width);
  const bodyHeight = median(groups.filter((g) => !g.title).flatMap((g) => g.lines.map(sizeHeight)));
  const bodyH = bodyHeight || lineHeight;
  // 正文页还是表单页（D-335）：数长行（至少四成页宽）里的字占整页（含表格）的多少。
  const charsOf = (ls: readonly OcrBox[]) => ls.reduce((n, l) => n + l.text.length, 0);
  const prose =
    charsOf(lines.filter((l) => l.width >= PROSE_LINE * image.width)) >=
    PROSE_SHARE * charsOf(lines);
  // 只改图的归属，不让移除图内标签改变整页的默认字号。
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
  // 正文行高按纸宽换算、还没限制范围的字号。
  const rawBodySize = (bodyH * A4_WIDTH_PT * BOX_TO_FONT) / fontWidthPx;
  // 按字宽估字号（D-463）：正文行的估计够一致时才用。
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
  // 整页文字的左右边（判断居中）。
  const textLeft = Math.min(...free.map((l) => l.x), ...tables.map((t) => t.box.x));
  const textRight = Math.max(
    ...free.map((l) => l.x + l.width),
    ...tables.map((t) => t.box.x + t.box.width),
  );
  // 先排好块（区域、表格、图片）的阅读顺序，块里的段落保持从上到下。
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
    // 已知纸张尺寸时，不能让正文的最小字号把大标题按比例再次放大。
    if (input.paper && !short && size >= HEADING_RATIO * bodySize) {
      // 全大写的行没有下伸的字母，框比同字号的行矮，按自己的框高会读小（16.3 磅读成 13 磅）：
      // 保留按字宽的比例，只去掉正文被最小字号抬高的那一截。
      if (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text))
        size = Math.min(size, Math.max(6, Math.round(((size * rawBodySize) / bodySize) * 2) / 2));
      else size = Math.min(size, fontSizeOf(h, fontWidthPx));
    }
    const bold =
      pageStroke > 0 && median(paraLines.map((l) => strokes.get(l) ?? 0)) > BOLD_RATIO * pageStroke;
    const color = textColor(image, orig(paraLines[0]!));
    // 下划线：每一行下面都有（D-463）。
    const underline = paraLines.every((l) => hasUnderline(image, orig(l)));
    const style: DocStyle = {
      ...(size !== bodySize ? { size } : {}),
      ...(bold ? { bold: true } : {}),
      ...(underline ? { underline: true } : {}),
      ...(color ? { color } : {}),
    };
    return { h, short, size, style };
  };
  // 密集页保留原来的分组，避免改动已有的跨页排版；只拼接推断字号、粗体等一致的碎片。
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

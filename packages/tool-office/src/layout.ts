import type { Box, OcrBox, RgbaImage } from './types';

// Layout analysis for scan-to-Word (D-328): PP-DocLayout-S (layout extension pack)
// preprocessing/postprocessing, region sorting, and reading order. The model has been updated to
// use a float32 input (1x3x480x480, resized without preserving aspect ratio, ImageNet normalized)
// and a float32 output (Nx6: category, score, x1, y1, x2, y2, with coordinates in 480x480 input
// space; NMS performed in model), runnable directly via app modelRun.

/** Side length of model input (PP-DocLayout-S). */
export const LAYOUT_INPUT = 480;

/** Model's 23 categories (in official inference.yml order). */
export const LAYOUT_LABELS = [
  'paragraph_title',
  'image',
  'text',
  'number',
  'abstract',
  'content',
  'figure_title',
  'formula',
  'table',
  'table_title',
  'reference',
  'doc_title',
  'footnote',
  'header',
  'algorithm',
  'footer',
  'seal',
  'chart_title',
  'chart',
  'formula_number',
  'header_image',
  'footer_image',
  'aside_text',
] as const;

/** Region types used in Word export: title, text, table, image, pageNumber (not written to file). */
export type RegionKind = 'title' | 'text' | 'table' | 'image' | 'pageNumber';

export interface LayoutRegion {
  kind: RegionKind;
  /** Model's original category (doc_title is a primary heading). */
  label: string;
  score: number;
  box: Box;
  /** Images retained only by combining scores from multiple co-occurring categories rather than meeting image thresholds independently (D-524): must not contain any text inside. */
  fused?: boolean;
  /** Three-class weak score recovery is for Word export only: adding shared column lines to worksheets might alter existing column widths and print pagination. */
  wordOnly?: true;
}

const KIND_OF: Record<string, RegionKind> = {
  paragraph_title: 'title',
  doc_title: 'title',
  table: 'table',
  image: 'image',
  chart: 'image',
  seal: 'image',
  header_image: 'image',
  footer_image: 'image',
  number: 'pageNumber',
};

/** Score threshold: in experiments (word-exp), 0.5 misses many text blocks while 0.3 misses fewer; images and tables have more false positives, requiring a higher threshold. */
const MIN_SCORE = 0.3;
const MIN_SCORE_IMAGE = 0.45;
/**
 * Models frequently split an image's score across multiple categories (image / chart /
 * header_image / footer_image), yielding 0.2-0.4 on roughly the same box, failing image
 * thresholds individually (D-524): such co-occurring detections are summed by category (taking
 * the highest score per category) and compared against the image threshold. Sporadic detections
 * below FIGURE_PART_MIN are excluded; duplicate detections within the same category are not
 * stacked; stamps are excluded (having their own rules).
 */
const FIGURE_PART_MIN = 0.15;
/** Intersection over Union threshold required to consider two boxes as the "same box". */
const FIGURE_SAME_BOX_IOU = 0.7;
/** Weaker auxiliary classes follow a separate independent recovery path: primary class >= 0.3, at least three classes >= 0.1 each, total score >= 0.55, and nearly overlapping boxes. */
const FIGURE_SUPPORT_MIN = 0.1;
const FIGURE_SUPPORT_SUM = 0.55;
const FIGURE_SUPPORT_IOU = 0.9;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/** Model input: full image bilinearly resized to side x side (without preserving aspect ratio, same as training), channel-normalized, CHW format. */
export function layoutInput(image: RgbaImage, side = LAYOUT_INPUT): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(3 * side * side);
  const plane = side * side;
  const sx = width / side;
  const sy = height / side;
  for (let y = 0; y < side; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < side; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      const a = (y0 * width + x0) * 4;
      const b = (y0 * width + x1) * 4;
      const c = (y1 * width + x0) * 4;
      const d = (y1 * width + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = data[a + ch]! * (1 - wx) + data[b + ch]! * wx;
        const bottom = data[c + ch]! * (1 - wx) + data[d + ch]! * wx;
        const v = (top * (1 - wy) + bottom * wy) / 255;
        out[ch * plane + y * side + x] = (v - MEAN[ch]!) / STD[ch]!;
      }
    }
  }
  return out;
}

/** Model output (Nx6) -> regions in original image coordinates; discard useless categories and low-scoring results. */
export function parseLayout(
  output: ArrayLike<number>,
  size: { width: number; height: number },
  side = LAYOUT_INPUT,
): LayoutRegion[] {
  const kx = size.width / side;
  const ky = size.height / side;
  const regions: LayoutRegion[] = [];
  const parts: LayoutRegion[] = [];
  for (let i = 0; i + 5 < output.length; i += 6) {
    const label = LAYOUT_LABELS[Math.round(output[i]!)];
    const score = output[i + 1]!;
    if (!label) continue;
    const kind = KIND_OF[label] ?? 'text';
    const figurePart = kind === 'image' && label !== 'seal' && score >= FIGURE_SUPPORT_MIN;
    if (score < (kind === 'image' || kind === 'table' ? MIN_SCORE_IMAGE : MIN_SCORE) && !figurePart)
      continue;
    const x1 = Math.max(0, output[i + 2]! * kx);
    const y1 = Math.max(0, output[i + 3]! * ky);
    const x2 = Math.min(size.width, output[i + 4]! * kx);
    const y2 = Math.min(size.height, output[i + 5]! * ky);
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    const region = { kind, label, score, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } };
    (figurePart ? parts : regions).push(region);
  }
  // Existing images continue to use original inputs and scores; auxiliary classes cannot alter accepted boxes, scores, or deduplication order.
  const figures = fuseFigures(parts.filter((p) => p.score >= FIGURE_PART_MIN));
  const existing = [...regions.filter((r) => r.kind === 'image'), ...figures];
  return [...regions, ...figures, ...corroboratedFigures(parts, existing)];
}

/** Accepted only when corroborated by three nearly identical boxes; does not replace any old images, marked as fused, and subsequently restricted to boxes completely free of text. */
function corroboratedFigures(
  parts: readonly LayoutRegion[],
  existing: readonly LayoutRegion[],
): LayoutRegion[] {
  const recovered: LayoutRegion[] = [];
  for (const anchor of [...parts].sort((a, b) => b.score - a.score)) {
    if (anchor.score < MIN_SCORE) break;
    if (
      [...existing, ...recovered].some(
        (r) => overlap(r.box, anchor.box) > 0.5 * Math.min(area(r.box), area(anchor.box)),
      )
    )
      continue;
    const best = new Map<string, number>();
    for (const p of parts) {
      if (iou(anchor.box, p.box) >= FIGURE_SUPPORT_IOU)
        best.set(p.label, Math.max(best.get(p.label) ?? 0, p.score));
    }
    const score = [...best.values()].reduce((a, b) => a + b, 0);
    if (best.size >= 3 && score >= FIGURE_SUPPORT_SUM)
      recovered.push({ ...anchor, score, fused: true, wordOnly: true });
  }
  return recovered;
}

/** Image detections merged by overlapping boxes: sorted by score from highest to lowest, merging boxes with sufficient IoU with a leading group box; group score = sum of highest scores per category, discarding those below image threshold. */
function fuseFigures(parts: readonly LayoutRegion[]): LayoutRegion[] {
  const groups: LayoutRegion[][] = [];
  for (const p of [...parts].sort((a, b) => b.score - a.score)) {
    const g = groups.find((m) => iou(m[0]!.box, p.box) >= FIGURE_SAME_BOX_IOU);
    if (g) g.push(p);
    else groups.push([p]);
  }
  return groups.flatMap((g) => {
    const best = new Map<string, number>();
    for (const p of g) best.set(p.label, Math.max(best.get(p.label) ?? 0, p.score));
    const score = [...best.values()].reduce((a, b) => a + b, 0);
    if (score < MIN_SCORE_IMAGE) return [];
    return [
      g[0]!.score >= MIN_SCORE_IMAGE ? { ...g[0]!, score } : { ...g[0]!, score, fused: true },
    ];
  });
}

const area = (b: Box) => b.width * b.height;
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const iou = (a: Box, b: Box) => {
  const inter = overlap(a, b);
  return inter / (area(a) + area(b) - inter || 1);
};

/** Proportion of a text line located within this region (calculated by line area). */
export const lineShareIn = (line: Box, region: Box) => overlap(line, region) / (area(line) || 1);

/** Maximum number of text lines permitted in an image region (logos, text inside photos); excess is treated as misrecognized body text. */
const IMAGE_MAX_LINES = 3;
/** Maximum total character count permitted inside an image. */
const IMAGE_MAX_CHARS = 30;
/**
 * Stamps (model seal, D-463) inherently consist entirely of text (a circle of institution name
 * and address), recognized as garbled text ("WPANTIMN"), cropped as images and placed into the
 * file (just like originals); restricted to this line count and character limit, with excess
 * treated as misrecognized body text.
 */
const SEAL_MAX_LINES = 6;
const SEAL_MAX_CHARS = 100;
/** Maximum page share an image can occupy: an entire page being an "image" indicates dense forms or misrecognized body text (5 out of 19 pages in experiments). */
const IMAGE_MAX_PAGE_SHARE = 0.5;

/**
 * Organize model-provided regions (D-328): reject images with too much text or occupying half a
 * page (those text lines are formatted as body text; stamps with slightly more text remain
 * images, D-463); model tables are ignored (tables rely on line detection, same as Excel export,
 * D-272; borderless tables are left to phase 3), and their text is formatted as body text; a text
 * line can belong to only one region.
 */
export function cleanRegions(
  regions: readonly LayoutRegion[],
  lines: readonly OcrBox[],
  size: { width: number; height: number },
  image?: RgbaImage,
  protectedImages: ReadonlySet<LayoutRegion> = new Set(),
): LayoutRegion[] {
  const pageArea = size.width * size.height;
  // The same image is frequently recognized as two regions (image and header_image): discard those
  // overlapping more than half with a higher-scoring image. "Images" occupying over half a page are
  // excluded: they are slated for deletion anyway and must not drag along real small inner images
  // as duplicates (D-524).
  const images = regions
    .filter(
      (r) =>
        r.kind === 'image' &&
        (protectedImages.has(r) || area(r.box) <= IMAGE_MAX_PAGE_SHARE * pageArea),
    )
    .sort((a, b) => b.score - a.score);
  const duplicate = new Set(
    images.filter((r, i) =>
      images
        .slice(0, i)
        .some((s) => overlap(r.box, s.box) > 0.5 * Math.min(area(r.box), area(s.box))),
    ),
  );
  return regions.filter((r) => {
    if (duplicate.has(r)) return false;
    if (r.kind === 'table') return false;
    if (r.kind !== 'image') return true;
    if (protectedImages.has(r)) return true;
    if (area(r.box) > IMAGE_MAX_PAGE_SHARE * pageArea) return false;
    const inside = lines.filter((l) => lineShareIn(l, r.box) >= 0.5);
    const chars = inside.reduce((n, l) => n + [...l.text.trim()].length, 0);
    if (r.label === 'seal') return inside.length <= SEAL_MAX_LINES && chars <= SEAL_MAX_CHARS;
    // Image evidence retained solely through co-occurrence score boosting is weak: untrusted if it contains text (text would be swallowed into the image; form grid lines are also short text with borders), and does not use the schematic path (D-524).
    if (r.fused) return inside.length === 0;
    if (inside.length <= IMAGE_MAX_LINES && chars <= IMAGE_MAX_CHARS) return true;
    return image !== undefined && isDiagram(image, r.box, inside);
  });
}

/** Diagram annotation text: maximum characters per line, maximum median characters, and maximum line count. */
const DIAGRAM_LINE_CHARS = 28;
const DIAGRAM_MEDIAN_CHARS = 16;
const DIAGRAM_MAX_LINES = 60;
/** Pixels occupied by graphics (lines, arrows, color blocks) other than text inside the box must account for at least this proportion. */
const DIAGRAM_MIN_INK = 0.12;

/**
 * Diagrams and flowcharts with numerous annotations (recognized as images by the model, but
 * containing more text than logos): text consists entirely of short annotations (no continuous
 * text lines), and the box contains substantial lines, arrows, or color blocks in addition to
 * text - whereas misrecognized "images" in forms consist of text lines with a few horizontal
 * lines, with graphics occupying very little space. Such items are cropped as images, leaving
 * annotation text inside the image.
 */
export function isDiagram(image: RgbaImage, box: Box, inside: readonly OcrBox[]): boolean {
  if (inside.length === 0 || inside.length > DIAGRAM_MAX_LINES) return false;
  const lens = inside.map((l) => [...l.text.trim()].length).sort((a, b) => a - b);
  if (
    lens.at(-1)! > DIAGRAM_LINE_CHARS ||
    lens[Math.floor(lens.length / 2)]! > DIAGRAM_MEDIAN_CHARS
  )
    return false;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  // Sample a point every few pixels; enough to determine the ratio.
  const step = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 200));
  let total = 0;
  let ink = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      total++;
      if (inside.some((l) => x >= l.x && x <= l.x + l.width && y >= l.y && y <= l.y + l.height))
        continue;
      const o = (y * image.width + x) * 4;
      const r = image.data[o]!;
      const g = image.data[o + 1]!;
      const b = image.data[o + 2]!;
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum < 200 || chroma > 25) ink++;
    }
  }
  return total > 0 && ink / total >= DIAGRAM_MIN_INK;
}

/**
 * Determines which region each text line belongs to (index; -1 when it belongs to no region): a
 * line is at least half inside a region; when multiple regions enclose it, choose the one with
 * the maximum coverage, and when tied, choose the smaller one (title boxes are often inside body
 * boxes).
 */
export function assignLines(lines: readonly Box[], regions: readonly { box: Box }[]): number[] {
  return lines.map((line) => {
    let best = -1;
    let bestShare = 0.5;
    for (const [i, r] of regions.entries()) {
      const share = lineShareIn(line, r.box);
      if (
        share > bestShare + 0.01 ||
        (best >= 0 && Math.abs(share - bestShare) <= 0.01 && area(r.box) < area(regions[best]!.box))
      ) {
        best = i;
        bestShare = Math.max(share, bestShare);
      }
    }
    return best;
  });
}

/**
 * Groups a set of intervals into segments based on overlaps, breaking only at the widest gaps
 * (and those of similar width): smaller gaps are left for the next layer to split (adjacent
 * two-column paragraphs also have narrow horizontal gaps; splitting horizontally there first
 * would interleave the two-column paragraphs). Gaps below `gap` are not considered gaps.
 */
function bands(
  spans: readonly [number, number][],
  gap: number,
): { groups: number[][]; widest: number } {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a]![0] - spans[b]![0]);
  const runs: { members: number[]; gapBefore: number }[] = [];
  let end = -Infinity;
  for (const i of order) {
    const [a, b] = spans[i]!;
    if (runs.length && a < end + gap) {
      runs.at(-1)!.members.push(i);
      end = Math.max(end, b);
    } else {
      runs.push({ members: [i], gapBefore: runs.length ? a - end : 0 });
      end = b;
    }
  }
  const widest = Math.max(0, ...runs.map((r) => r.gapBefore));
  const groups: number[][] = [];
  for (const run of runs) {
    if (groups.length && run.gapBefore < 0.8 * widest) groups.at(-1)!.push(...run.members);
    else groups.push([...run.members]);
  }
  return { groups, widest };
}

/** Maximum height in lines for a header row shared across columns. */
const HEADER_ROW_LINES = 3;

/**
 * Among several columns split vertically, if one column contains only a top row of short text
 * (column titles in a boxed form like "CONCEPTO BASE TIPO APORTACIÓN", with no text in the entry
 * areas below, EU sample 016): this row is a shared header across columns, not a single-column
 * block. Text falling entirely within this row is ordered first (by x-coordinate), and the
 * remaining text is ordered afterwards; otherwise, right-hand column titles would be ordered
 * after all left-hand items. This row does not exceed `HEADER_ROW_LINES` line heights, and at
 * least two columns each contain a complete block within this row (two-column body paragraphs are
 * taller than this row and remain unaffected).
 */
function headerRow<T extends { box: Box }>(
  items: readonly T[],
  groups: readonly number[][],
  gap: number,
  lineHeight: number,
): [T[], T[]] | null {
  const bottomOf = (it: T) => it.box.y + it.box.height;
  const top = Math.min(...items.map((it) => it.box.y));
  const bottoms = groups.map((g) => Math.max(...g.map((i) => bottomOf(items[i]!))));
  // Columns restricted to this single row: the entire column does not exceed `HEADER_ROW_LINES` line heights.
  const short = bottoms.filter((b) => b - top <= HEADER_ROW_LINES * lineHeight);
  if (!short.length || short.length === bottoms.length) return null;
  const row = Math.max(...short);
  const inRow = (it: T) => bottomOf(it) <= row + gap;
  if (groups.filter((g) => g.some((i) => inRow(items[i]!))).length < 2) return null;
  const head = items.filter(inRow);
  // All text resides within this single row (EU sample 077): there is no distinction between header and body below; columns are ordered as usual, otherwise `readingOrder` recurses as before.
  if (head.length === items.length) return null;
  return [head, items.filter((it) => !inRow(it))];
}

/**
 * Reading order (XY cut): splits into top-and-bottom segments from top-to-bottom if horizontally
 * separable, and into left-to-right columns if vertically separable. When both cuts are possible,
 * choose the one with the wider gap (the inter-column gap is wider than the intra-paragraph gap).
 * When neither is separable, sort by top edge then left edge. `gap` is the minimum width
 * considered a gap (preventing tightly adjacent blocks from being split).
 */
export function readingOrder<T extends { box: Box }>(
  items: readonly T[],
  gap = 0,
  /** Body line height: recognized for shared headers across columns (`headerRow`) only when provided. */
  lineHeight?: number,
): T[] {
  if (items.length <= 1) return [...items];
  const rows = bands(
    items.map((it) => [it.box.y, it.box.y + it.box.height]),
    gap,
  );
  const cols = bands(
    items.map((it) => [it.box.x, it.box.x + it.box.width]),
    gap,
  );
  const split =
    rows.groups.length > 1 && (cols.groups.length < 2 || rows.widest >= cols.widest)
      ? rows.groups
      : cols.groups.length > 1
        ? cols.groups
        : null;
  if (!split) return [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (split !== rows.groups && lineHeight) {
    const head = headerRow(items, split, gap, lineHeight);
    if (head)
      return [...readingOrder(head[0], gap, lineHeight), ...readingOrder(head[1], gap, lineHeight)];
  }
  return split.flatMap((group) =>
    readingOrder(
      group.map((i) => items[i]!),
      gap,
      lineHeight,
    ),
  );
}

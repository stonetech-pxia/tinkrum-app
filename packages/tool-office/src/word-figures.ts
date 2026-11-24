import { lineShareIn, type LayoutRegion } from './layout';
import type { Box, OcrBox, RgbaImage } from './types';

// Word figure attribution: captions or sufficiently strong graphical pixel evidence, combined with
// absence of body text/data table conflicts, protect text and lines within figures. This is a
// build-time temporary plan; it does not alter layout model thresholds or get written into
// document/worksheet formats.
const captionStart = /^(?:fig(?:ure)?\.?\s*\d+[\s:：.)]|[图圖]\s*\d+[\s:：.、])/iu;
const captionLabels = new Set(['figure_title', 'chart_title']);
const area = (b: Box) => b.width * b.height;
/** Figures without captions occupy at most this fraction of the page (large cover photos are about 60%, NIST cover illustrations 0.54). */
const FIGURE_MAX_PAGE_SHARE = 0.8;
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

export interface WordFigure {
  region: LayoutRegion;
  box: Box;
  caption?: OcrBox;
}

/** Combine raw model figure boxes with pixel/text evidence; weak boxes conflicting with body text and tables remain on their original paths. */
export function planWordFigures(
  image: RgbaImage,
  lines: readonly OcrBox[],
  regions: readonly LayoutRegion[],
  h: number,
): WordFigure[] {
  const captions = regions
    .filter((r) => captionLabels.has(r.label))
    .flatMap((r) =>
      lines.filter((l) => lineShareIn(l, r.box) >= 0.5 && captionStart.test(l.text.trim())),
    );
  const result: WordFigure[] = [];
  for (const r of regions) {
    const b = r.box;
    if (r.kind !== 'image' || r.label === 'seal' || (r.fused && r.score < 0.6)) continue;
    const caption = captions
      .filter(
        (l) =>
          l.y >= b.y + b.height - 0.3 * h &&
          l.y - b.y - b.height <= 3 * h &&
          l.x + l.width / 2 >= b.x - h &&
          l.x + l.width / 2 <= b.x + b.width + h &&
          overlap({ ...b, y: l.y, height: l.height }, l) >=
            0.6 * Math.min(b.width, l.width) * l.height,
      )
      .sort((a, c) => a.y - c.y)[0];
    // Image/table conflicts require separate context determination; data table crops cannot be generated based solely on captions.
    if (
      regions.some(
        (t) => t.kind === 'table' && overlap(t.box, b) >= 0.5 * Math.min(area(t.box), area(b)),
      )
    )
      continue;
    const inside = lines.filter((l) => l !== caption && lineShareIn(l, b) >= 0.5);
    // A "figure" without a caption that covers nearly the entire page is the page itself (cover
    // photo background and color blocks), not a single figure: taking over would swallow all text
    // on the page (EU sample 036 cover, leaving zero text). When a page contains no text, treat it
    // as a full-page figure as usual.
    if (!caption && inside.length && area(b) > FIGURE_MAX_PAGE_SHARE * image.width * image.height)
      continue;
    // Uncaptioned large color blocks may also be multi-cell forms; a large number of short fields cannot be treated as illustration labels.
    if (
      !caption &&
      (inside.length > 12 || inside.reduce((n, l) => n + [...l.text.trim()].length, 0) > 100)
    )
      continue;
    // Wide body text lines are strong conflict evidence; do not take over even if the model claims it is an image.
    if (inside.some((l) => l.width >= 0.6 * b.width && [...l.text.trim()].length >= 15)) continue;
    // Graphical evidence comes from original pixels outside OCR boxes; sparse arrows can be minimal, but boxes containing only text are still not taken over.
    const step = Math.max(1, Math.round(Math.max(b.width, b.height) / 180));
    let ink = 0,
      samples = 0;
    for (
      let y = Math.max(0, Math.floor(b.y));
      y < Math.min(image.height, b.y + b.height);
      y += step
    ) {
      for (
        let x = Math.max(0, Math.floor(b.x));
        x < Math.min(image.width, b.x + b.width);
        x += step
      ) {
        samples++;
        if (inside.some((l) => x >= l.x && x <= l.x + l.width && y >= l.y && y <= l.y + l.height))
          continue;
        const off = (y * image.width + x) * 4;
        const rr = image.data[off]!,
          g = image.data[off + 1]!,
          bb = image.data[off + 2]!;
        if (
          (rr * 299 + g * 587 + bb * 114) / 1000 < 200 ||
          Math.max(rr, g, bb) - Math.min(rr, g, bb) > 25
        )
          ink++;
      }
    }
    if (!samples || ink / samples < 0.02) continue;
    // Uncaptioned, weakly fused, or large illustrations require stronger pixel evidence; forms with only short text and thin frame lines cannot be taken over.
    if ((!caption || r.fused || area(b) > 0.5 * image.width * image.height) && ink / samples < 0.12)
      continue;
    let box = { ...b };
    let conflict = false;
    for (const l of lines) {
      if (l === caption || !overlap(l, b)) continue;
      if (lineShareIn(l, b) < 0.2) continue;
      const within =
        l.x >= b.x - 0.75 * h &&
        l.y >= b.y - 0.75 * h &&
        l.x + l.width <= b.x + b.width + 0.75 * h &&
        l.y + l.height <= b.y + b.height + 0.75 * h;
      if (!within) {
        conflict = true;
        break;
      }
      box = union(box, l);
    }
    // Do not expand into captions, nor allow two figures to contend for the same content.
    if (
      conflict ||
      (caption && box.y + box.height + 0.3 * h > caption.y) ||
      result.some((f) => overlap(f.box, box) > 0)
    )
      continue;
    result.push({ region: r, box, ...(caption ? { caption } : {}) });
  }
  return result;
}

export const figureOwns = (line: Box, figures: readonly WordFigure[]): boolean =>
  figures.some((f) => lineShareIn(line, f.box) >= 0.5);

/** Darkness threshold considered as a line (same absolute threshold for line finding, 0.75 brightness). */
const RULE_INK = 191;

/** Line finding, unbordered tables, and barcodes inspect only the working copy; original images are still used for font measurement and final cropping. */
export function figureWorkingImage(
  image: RgbaImage,
  figures: readonly WordFigure[],
  h: number,
): RgbaImage {
  if (!figures.length) return image;
  const { width, height } = image;
  const src = image.data;
  const data = src.slice();
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return (src[i]! * 299 + src[i + 1]! * 587 + src[i + 2]! * 114) / 1000 < RULE_INK;
  };
  // Dark strips (columns) immediately adjacent to both sides of a figure box: these are table
  // gridlines passing through the figure box (PDF logo bounding box crossing the top/bottom borders
  // of the header cell, EU sample 090), which must not be erased; otherwise, this cell merges with
  // cells below, disrupting the merged cells of the entire table. Large dark areas on both sides
  // (figures resting on color blocks) are not considered lines and are erased as usual.
  const run = Math.max(3, Math.round(0.5 * h));
  const thin = Math.max(3, Math.round(0.25 * h));
  const through = (ink: (k: number) => boolean) => {
    for (let k = 1; k <= run; k++) if (!ink(k)) return false;
    return true;
  };
  const rules = (from: number, to: number, crosses: (at: number) => boolean) => {
    const kept = new Set<number>();
    for (let at = from; at < to;) {
      if (!crosses(at)) {
        at++;
        continue;
      }
      let end = at;
      while (end < to && crosses(end)) end++;
      if (end - at <= thin) for (let k = at; k < end; k++) kept.add(k);
      at = end;
    }
    return kept;
  };
  for (const f of figures) {
    const pad = 0.15 * h,
      x0 = Math.max(0, Math.floor(f.box.x - pad)),
      x1 = Math.min(width, Math.ceil(f.box.x + f.box.width + pad)),
      y0 = Math.max(0, Math.floor(f.box.y - pad)),
      y1 = Math.min(height, Math.ceil(f.box.y + f.box.height + pad));
    const rows = rules(
      y0,
      y1,
      (y) =>
        x0 - run >= 0 &&
        x1 + run <= width &&
        through((k) => dark(x0 - k, y)) &&
        through((k) => dark(x1 - 1 + k, y)),
    );
    const cols = rules(
      x0,
      x1,
      (x) =>
        y0 - run >= 0 &&
        y1 + run <= height &&
        through((k) => dark(x, y0 - k)) &&
        through((k) => dark(x, y1 - 1 + k)),
    );
    for (let y = y0; y < y1; y++) {
      if (rows.has(y)) continue;
      data.fill(255, (y * width + x0) * 4, (y * width + x1) * 4);
      for (const x of cols)
        data.set(src.subarray((y * width + x) * 4, (y * width + x + 1) * 4), (y * width + x) * 4);
    }
  }
  return { ...image, data };
}

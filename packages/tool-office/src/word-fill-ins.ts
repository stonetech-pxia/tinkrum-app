import type { PageLines, RuleLine } from './lines';
import type { Box, OcrBox, RgbaImage } from './types';

// Fill-in areas left in forms (EU samples 021, 030): a string of dots following a label ("Name
// ……………"), or a horizontal line to the right of a label (L-shaped answer lines, baseline of boxed
// character grids). When OCR fails to detect them (dots read as "..." or omitted entirely), only
// the label remains, leaving no space to write; large blank gaps also cause the label and centered
// notes below to look like two columns, completely messing up the reading order. Once detected,
// they are appended after the row's label as a string of "." (dots) or "_" (underscores) matching
// their original length: Word recognizes them as fillable and editable directly. This row thus
// spans the full line width and is not treated as a narrow label column; lines with attached
// fill-ins remain single lines and do not merge into the following paragraph.

export interface FillIn extends Box {
  kind: 'dots' | 'rule';
}

/** Dot: connected ink blob whose dimensions do not exceed this many line heights in width and height. */
const DOT_MAX = 0.3;
/** Maximum distance between centers of two adjacent dots in line heights; vertical offset between dots in the same row must not exceed this many line heights. */
const DOT_PITCH = 0.7;
const DOT_ROW = 0.15;
/** Aspect ratio (median) of a dot sequence does not exceed this value. */
const DOT_ROUND = 1.8;
/** A dot sequence contains at least this many dots and spans at least this many line heights in length. */
const DOTS_MIN = 6;
const FILL_MIN = 2.5;
/** No ink larger than a dot (character strokes) may appear within this many line heights above or below the dot sequence: excludes dots above 'i' or periods within text. */
const DOT_CLEAR = 0.25;
/** Horizontal lines must be at least this many line heights long (shorter lines are mostly graphics or watermark strokes). */
const RULE_MIN = 4;
/** Horizontal line: thickness does not exceed this many line heights. */
const RULE_MAX_THICKNESS = 0.3;
/** At least this fraction of points in the specified vertical range (80% of this many line heights) above the fill-in area must be white. */
const BLANK_ABOVE = 0.8;
const BLANK_SHARE = 0.9;
/** Vertical lines of at least this length (line heights) connected to both ends of a horizontal line indicate a frame border. */
const FRAME_SIDE = 1.5;
/** A horizontal line connected to a frame border at one end is considered a fill-in line extending to the border when its left end is within this many line heights of the label in the same row. */
const LAST_FILL_GAP = 2;
/** At least this proportion of the horizontal line is darker than its upper and lower surroundings by more than LINE_CONTRAST (0-255). */
const RULE_INK_SHARE = 0.6;
const LINE_CONTRAST = 30;
/** Proportion of ink-containing segments along the horizontal line must be at least this high (solid line). */
const RULE_SOLID = 0.9;
/** Maximum distance to the label on the left of the horizontal line in line heights (form labels in one column, fill-in areas in another; short labels are further apart). */
const LABEL_GAP = 16;
/** A sequence of "." or "_" is slightly shorter than the original dots/lines to prevent wrapping to the next line when font size is enlarged or font is changed in Word. */
const FILL_SLACK = 0.85;
/** Font size (pixels) ≈ OCR box height × this ratio (same as BOX_TO_FONT in doc.ts). */
const BOX_TO_FONT = 0.9;
/** Width (in em) of '.' and '_' in Arial. '…' is replaced by a Chinese font when standing as its own paragraph in LibreOffice, so it is not used. */
const RUN_EM = { dots: 0.278, rule: 0.556 } as const;
const RUN_CHAR = { dots: '.', rule: '_' } as const;
/** Characters belonging to the dot/line fill-in itself (OCR reads dots as '...', '...', spaces). */
const LEADER_CHAR = /^[\s.…·_]$/u;
/** A line ending with a run of fill-in slots (paragraphsOf: such lines are individual lines, not concatenated with the next line). */
export const ENDS_WITH_FILL = /(?:\.{4,}|_{4,})\s*$/u;
/** A run of fill-in slots (ignored as text when comparing font layout across two passes). */
export const FILL_RUN = /(?:\.{4,}|_{4,})/gu;

/** Connected ink components (4-adjacency), keeping only bounding box and pixel count. */
function components(image: RgbaImage): { box: Box; count: number }[] {
  const { width, height, data } = image;
  const label = new Int32Array(width * height).fill(-1);
  // Temporary labels during 4-adjacency numbering are at most half the pixel count (checkerboard).
  const parent = new Int32Array((width * height) / 2 + 2);
  let next = 0;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const ink = Math.min(data[o]!, data[o + 1]!, data[o + 2]!);
      if (ink >= 140) continue;
      const p = y * width + x;
      const left = x > 0 ? label[p - 1]! : -1;
      const up = y > 0 ? label[p - width]! : -1;
      if (left < 0 && up < 0) {
        label[p] = next;
        parent[next] = next;
        next++;
      } else if (left >= 0 && up >= 0) {
        const a = find(left);
        const b = find(up);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        label[p] = Math.min(a, b);
      } else label[p] = left >= 0 ? left : up;
    }
  }
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  for (let p = 0; p < label.length; p++) {
    if (label[p]! < 0) continue;
    const root = find(label[p]!);
    const x = p % width;
    const y = (p - x) / width;
    const b = boxes.get(root);
    if (!b) boxes.set(root, { x0: x, y0: y, x1: x, y1: y, n: 1 });
    else {
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y > b.y1) b.y1 = y;
      b.n++;
    }
  }
  return [...boxes.values()].map((b) => ({
    box: { x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1 },
    count: b.n,
  }));
}

const dotsCache = new WeakMap<RgbaImage, Map<number, { dots: FillIn[]; erased: RgbaImage }>>();

/**
 * Dot lines on a page, and the image with dot lines erased (used for finding table lines: dot
 * lines would otherwise be treated as light horizontal rules, and several aligned dot lines merge
 * into a fake table). Calculated once per image and line height (converting to Word rebuilds the
 * same page several times); erased image is also cached per image for line detection.
 */
export function leaderDots(
  image: RgbaImage,
  lines: readonly OcrBox[],
  lineHeight: number,
): { dots: FillIn[]; erased: RgbaImage } {
  let byHeight = dotsCache.get(image);
  if (!byHeight) dotsCache.set(image, (byHeight = new Map()));
  let found = byHeight.get(lineHeight);
  if (!found) {
    // Recognized letters or numbers at the position of these dot lines are treated as text (very small text in scans appears as tiny ink blobs), not as dot lines.
    const dots = findDots(image, lineHeight).filter((d) => !readAsText(d, lines, lineHeight));
    let erased = image;
    if (dots.length) {
      const data = image.data.slice();
      const pad = 1;
      for (const d of dots) {
        for (let y = Math.max(0, d.y - pad); y < Math.min(image.height, d.y + d.height + pad); y++)
          for (let x = Math.max(0, d.x - pad); x < Math.min(image.width, d.x + d.width + pad); x++)
            data.fill(255, (y * image.width + x) * 4, (y * image.width + x) * 4 + 3);
      }
      erased = { width: image.width, height: image.height, data };
    }
    byHeight.set(lineHeight, (found = { dots, erased }));
  }
  return found;
}

/**
 * Thin line score (not a block edge): the ratio of columns where every point along the line is
 * darker than points slightly above and below. Light fill-in lines (EU sample 001) have white
 * paper on both sides; edges of light shading have only one light side.
 */
function lineShare(image: RgbaImage, box: Box): number {
  const ink = (x: number, y: number) => {
    const o = (Math.max(0, Math.min(image.height - 1, y)) * image.width + x) * 4;
    return Math.min(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!);
  };
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const top = Math.round(box.y) - 1;
  const bottom = Math.round(box.y + box.height) + 1;
  let thin = 0;
  for (let x = x0; x < x1; x++) {
    let line = 255;
    for (let y = top; y <= bottom; y++) line = Math.min(line, ink(x, y));
    if (ink(x, top - 3) - line >= LINE_CONTRAST && ink(x, bottom + 3) - line >= LINE_CONTRAST)
      thin++;
  }
  return x1 > x0 ? thin / (x1 - x0) : 0;
}

/** Ratio of light pixels (all three channels bright) inside the box. */
function lightShare(image: RgbaImage, box: Box): number {
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(image.height, Math.round(box.y + box.height));
  let light = 0;
  let all = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      all++;
      if (Math.min(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!) >= 170) light++;
    }
  }
  return all ? light / all : 0;
}

/** More than 20% of the recognized characters overlapping this dot run on the same row are letters or numbers. */
function readAsText(d: FillIn, lines: readonly OcrBox[], lineHeight: number): boolean {
  let letters = 0;
  let all = 0;
  for (const l of lines) {
    if (!sameRow(l, d, lineHeight) || l.x >= d.x + d.width || l.x + l.width <= d.x) continue;
    for (const c of charsOf(l)) {
      const x = l.x + c.at * l.width;
      if (x < d.x || x > d.x + d.width || !c.text.trim()) continue;
      all++;
      if (/[\p{L}\p{N}]/u.test(c.text)) letters++;
    }
  }
  return letters > 0.2 * all;
}

/** A run of dots (leader line): small ink dots on the same row with similar spacing and no text in between. */
function findDots(image: RgbaImage, lineHeight: number): FillIn[] {
  const all = components(image);
  const max = DOT_MAX * lineHeight;
  // Two closely spaced dots often merge into a single blob in the image (flattened), which is still counted as a dot; whether the entire run consists of circular dots is determined below via the median.
  const small = all.filter((c) => c.count >= 2 && c.box.width <= max && c.box.height <= max);
  // Text: ink taller than a dot.
  const big = all.filter((c) => c.count >= 2 && c.box.height > max).map((c) => c.box);
  const cx = (b: Box) => b.x + b.width / 2;
  const cy = (b: Box) => b.y + b.height / 2;
  const chains: Box[][] = [];
  for (const { box } of [...small].sort((a, b) => cx(a.box) - cx(b.box))) {
    let best: Box[] | undefined;
    for (const chain of chains) {
      const last = chain.at(-1)!;
      if (cx(box) - cx(last) > DOT_PITCH * lineHeight) continue;
      if (Math.abs(cy(box) - cy(last)) > DOT_ROW * lineHeight) continue;
      if (!best || cx(last) > cx(best.at(-1)!)) best = chain;
    }
    if (best) best.push(box);
    else chains.push([box]);
  }
  const out: FillIn[] = [];
  for (const chain of chains) {
    if (chain.length < DOTS_MIN) continue;
    const x0 = chain[0]!.x;
    const x1 = chain.at(-1)!.x + chain.at(-1)!.width;
    if (x1 - x0 < FILL_MIN * lineHeight) continue;
    // Roughly uniform spacing (80% of spacings fall between half and 1.5 times the median).
    const pitches = chain
      .slice(1)
      .map((b, i) => cx(b) - cx(chain[i]!))
      .sort((a, b) => a - b);
    const p = pitches[pitches.length >> 1]!;
    // Circular dots (short dashed lines in a ticket or table separator are flattened and are not fill-in slots).
    const aspects = chain.map((b) => b.width / b.height).sort((a, b) => a - b);
    if (aspects[aspects.length >> 1]! > DOT_ROUND) continue;
    if (pitches.filter((d) => d >= 0.5 * p && d <= 1.6 * p).length < 0.8 * pitches.length) continue;
    const y = Math.min(...chain.map((b) => b.y));
    const bottom = Math.max(...chain.map((b) => b.y + b.height));
    const mid = (y + bottom) / 2;
    const clear = DOT_CLEAR * lineHeight;
    if (
      big.some(
        (b) => b.x < x1 && b.x + b.width > x0 && b.y < mid + clear && b.y + b.height > mid - clear,
      )
    )
      continue;
    out.push({ kind: 'dots', x: x0, y, width: x1 - x0, height: bottom - y });
  }
  return out;
}

/**
 * Fill-in areas left on the page: a dot run (leaderDots) or a thin horizontal line not inside a
 * table (with a label on the same row to the left and no text pressing down from above,
 * distinguishing it from underlines or separators). Exclude items in boxes (tables, images).
 */
export function findFillIns(
  image: RgbaImage,
  dots: readonly FillIn[],
  rules: PageLines,
  lines: readonly OcrBox[],
  lineHeight: number,
  exclude: readonly Box[],
): FillIn[] {
  const inside = (b: Box) =>
    exclude.some(
      (e) =>
        b.x + b.width / 2 >= e.x &&
        b.x + b.width / 2 <= e.x + e.width &&
        b.y + b.height / 2 >= e.y - 0.5 * lineHeight &&
        b.y + b.height / 2 <= e.y + e.height + 0.5 * lineHeight,
    );
  const t = Math.tan((rules.skew * Math.PI) / 180);
  // Disconnected segments of the same line are joined first (separators on skewed receipts break into pieces; an intermediate piece cannot be treated as a standalone fill-in slot).
  const joined: RuleLine[] = [];
  for (const h of [...rules.horizontal]
    .filter((h) => !h.band && h.thickness <= RULE_MAX_THICKNESS * lineHeight)
    .sort((a, b) => a.from - b.from)) {
    const prev = joined.find(
      (j) => Math.abs(j.pos - h.pos) <= 0.3 * lineHeight && h.from - j.to <= 0.8 * lineHeight,
    );
    if (prev) {
      prev.to = Math.max(prev.to, h.to);
      prev.spans = [...prev.spans, ...h.spans];
    } else joined.push({ ...h, spans: [...h.spans] });
  }
  const solid: FillIn[] = joined
    .filter(
      (h) =>
        h.to - h.from >= RULE_MIN * lineHeight &&
        // Solid line (dashed lines are mostly separators in receipts or tables).
        h.spans.reduce((n, [a, b]) => n + b - a, 0) >= RULE_SOLID * (h.to - h.from),
    )
    .map((h) => {
      // Map straightened coordinates back to the original image (lines are short, conversion uses the midpoint).
      const mid = (h.from + h.to) / 2;
      const y = h.pos + mid * t;
      const x = h.from - y * t;
      return {
        kind: 'rule' as const,
        x,
        y: y - h.thickness / 2,
        width: h.to - h.from,
        height: h.thickness,
      };
    })
    .filter((r) => {
      // An edge of a box connected at both ends to long vertical lines (outer border of a form
      // section, with the title pressing down on the top edge) is not a fill-in slot; L-shaped
      // answer lines and number box vertical lines are very short.
      const ends = [r.x, r.x + r.width];
      const framedAt = ends.map((e) =>
        rules.vertical.some((v) => {
          const vx = v.pos - (r.y + r.height / 2) * t;
          return (
            Math.abs(vx - e) <= 0.3 * lineHeight &&
            v.from <= r.y + 0.3 * lineHeight &&
            v.to >= r.y - 0.3 * lineHeight &&
            v.to - v.from >= FRAME_SIDE * lineHeight
          );
        }),
      );
      // Only when the right end connects to the box border and the left side directly abuts a
      // same-row label: the fill line after the last label in a row extends all the way to the
      // right border of the box (e.g., 'Provincia ...', 'E-mail ...' in EU sample 046), rather than
      // being a box border.
      const afterLabel =
        !framedAt[0] &&
        lines.some(
          (l) =>
            sameRow(l, r, lineHeight) &&
            l.x + l.width <= r.x + 0.5 * lineHeight &&
            r.x - (l.x + l.width) <= LAST_FILL_GAP * lineHeight,
        );
      if (framedAt.some(Boolean) && !afterLabel) return false;
      // Exclude lines overlaid by text: underlines of text, completed answers (text within about
      // one line height above the line), and 'lines' formed by connected bold text strokes (where
      // the line lies inside the text box).
      const covered = lines.some(
        (l) =>
          Math.min(l.x + l.width, r.x + r.width) - Math.max(l.x, r.x) > lineHeight &&
          r.y >= l.y &&
          r.y <= l.y + l.height + 1.3 * lineHeight,
      );
      return !covered;
    });
  // Dot lines are also detected as light lines by line finding: discard lines that overlap with a dot run.
  const lone = solid.filter(
    (r) =>
      !dots.some(
        (d) =>
          Math.abs(d.y + d.height / 2 - (r.y + r.height / 2)) <= 0.4 * lineHeight &&
          Math.min(d.x + d.width, r.x + r.width) - Math.max(d.x, r.x) > 0.5 * r.width,
      ),
  );
  // Blank paper above the fill-in slot (excluded if on a dark background or overlaid by text).
  const blank = (f: FillIn) =>
    lightShare(image, {
      x: f.x,
      y: f.y - BLANK_ABOVE * lineHeight,
      width: f.width,
      height: 0.8 * BLANK_ABOVE * lineHeight,
    }) >= BLANK_SHARE;
  // Horizontal lines must be thin: borders of light-shaded areas are also detected as very faint lines during line finding (e.g., bill table in EU sample 025).
  const inked = (f: FillIn) =>
    f.kind === 'dots' ||
    lineShare(image, { x: f.x, y: f.y, width: f.width, height: Math.max(1, f.height) }) >=
      RULE_INK_SHARE;
  return [...dots, ...lone].filter((f) => !inside(f) && blank(f) && inked(f));
}

/**
 * Text on the same row as this fill-in slot: the bottom edge of the fill-in slot falls between
 * the lower third of the text and less than one line height below it (horizontal lines across the
 * middle of characters are form borders pressing on titles).
 */
const sameRow = (l: OcrBox, f: Box, lineHeight: number) => {
  const base = f.y + f.height;
  return base >= l.y + 0.65 * l.height && base <= l.y + l.height + 0.8 * lineHeight;
};

/** Run length estimation: estimated based on the font size of the current line, slightly shorter than the original. */
function runOf(kind: FillIn['kind'], width: number, fontPx: number): string {
  const n = Math.max(4, Math.floor((width / (RUN_EM[kind] * fontPx)) * FILL_SLACK));
  return RUN_CHAR[kind].repeat(n);
}

/**
 * Merge fill-in slots into recognized lines: same-row slots following a label are merged into the
 * label's line (dots in the middle of a line of text replace OCR-detected dots and spaces); dot
 * runs without text on a row form their own line. Horizontal lines must have a nearby label to
 * the left, otherwise they might be separators and are ignored. Returns new lines, along with
 * mapping from new lines to original recognized lines (stroke measurements, colors, and
 * underlines still reference the original box).
 */
export function withFillIns(
  input: readonly OcrBox[],
  fills: readonly FillIn[],
  lineHeight: number,
): { lines: OcrBox[]; source: Map<OcrBox, OcrBox> } {
  const source = new Map<OcrBox, OcrBox>();
  // First remove OCR-detected '...' and '…' originating from dot lines (dots and spaces landing on dot lines); discard lines consisting entirely of these.
  const cleaned = input.flatMap((l): OcrBox[] => {
    const on = fills.filter(
      (f) =>
        f.kind === 'dots' &&
        sameRow(l, f, lineHeight) &&
        f.x < l.x + l.width &&
        f.x + f.width > l.x,
    );
    if (!on.length) return [l];
    const c = withoutLeader(l, on, lineHeight);
    if (c === l) return [l];
    if (c) source.set(c, l);
    return c ? [c] : [];
  });
  const lines = cleaned;
  const owned = new Map<OcrBox, FillIn[]>();
  const alone: FillIn[] = [];
  // Left-to-right progression: the second line on the same row attaches after the label that has already attached to the first line.
  const reach = new Map<OcrBox, number>();
  const right = (l: OcrBox) => reach.get(l) ?? l.x + l.width;
  for (const f of [...fills].sort((a, b) => a.x - b.x)) {
    const row = lines.filter((l) => sameRow(l, f, lineHeight));
    // Owner: dots within a line of text box ('od ... do'), or dot lines starting from the end of
    // text. Horizontal lines only attach to labels on their left (lines overlaid by text have
    // already been removed).
    let owner =
      f.kind === 'dots'
        ? row.find((l) => f.x > l.x && f.x + 0.5 * f.width > l.x && f.x < right(l))
        : undefined;
    if (!owner) {
      const left = row.filter(
        (l) =>
          right(l) <= f.x + 0.5 * lineHeight &&
          f.x - right(l) <= LABEL_GAP * lineHeight &&
          !row.some((m) => m !== l && m.x >= right(l) && m.x < f.x),
      );
      // Two-line labels: attach to the line whose bottom edge is closest to the fill-in slot (horizontal lines drawn under the second line).
      const base = f.y + f.height;
      const far = (l: OcrBox) => Math.abs(l.y + l.height - base);
      owner = left.sort((a, b) => far(a) - far(b) || right(b) - right(a))[0];
    }
    if (owner) {
      owned.set(owner, [...(owned.get(owner) ?? []), f]);
      reach.set(owner, Math.max(right(owner), f.x + f.width));
    } else if (f.kind === 'dots' && !lines.some((l) => overlaps(l, f))) alone.push(f);
  }
  const out = lines.map((l) => {
    const mine = owned.get(l);
    if (!mine) return l;
    const merged = mergeFills(l, mine, lineHeight);
    source.set(merged, source.get(l) ?? l);
    return merged;
  });
  for (const f of alone) {
    const height = lineHeight;
    const text = runOf(f.kind, f.width, BOX_TO_FONT * height);
    out.push({
      text,
      x: f.x,
      y: f.y + f.height - 0.85 * height,
      width: f.width,
      height,
      chars: [...text].map((ch, i) => ({ text: ch, at: (i + 0.5) / text.length })),
    });
  }
  return { lines: out, source };
}

/** Characters of a line (evenly distributed by character count when character positions are unavailable). */
const charsOf = (line: OcrBox) =>
  line.chars?.length === [...line.text].length
    ? line.chars
    : [...line.text].map((ch, i, all) => ({ text: ch, at: (i + 0.5) / all.length }));

/**
 * Identify which characters belong to the dot line itself: dots and spaces falling on the dot
 * line (extending 0.3 line heights on either side), and contiguous dots and spaces outward
 * (OCR-detected '...' often starts slightly ahead of the dot line start).
 */
function leaderChars(
  chars: readonly { x: number; text: string }[],
  fills: readonly FillIn[],
  lineHeight: number,
): boolean[] {
  const pad = 0.3 * lineHeight;
  const leader = chars.map((c) => LEADER_CHAR.test(c.text));
  const junk = chars.map(
    (c, i) => leader[i]! && fills.some((f) => c.x >= f.x - pad && c.x <= f.x + f.width + pad),
  );
  for (let i = 1; i < chars.length; i++) if (junk[i - 1] && leader[i]) junk[i] = true;
  for (let i = chars.length - 2; i >= 0; i--) if (junk[i + 1] && leader[i]) junk[i] = true;
  return junk;
}

/**
 * Remove dots and spaces falling on dot lines (OCR-detected '...'): shrink box to remaining
 * characters. Returns null if no letters or numbers remain, or returns the original if nothing
 * needed removal.
 */
function withoutLeader(line: OcrBox, fills: readonly FillIn[], lineHeight: number): OcrBox | null {
  const all = charsOf(line).map((c) => ({ ...c, x: line.x + c.at * line.width }));
  const junk = leaderChars(all, fills, lineHeight);
  const kept = all.filter((_, i) => !junk[i]);
  if (kept.length === all.length) return line;
  while (kept[0] && !kept[0].text.trim()) kept.shift();
  while (kept.at(-1) && !kept.at(-1)!.text.trim()) kept.pop();
  if (!kept.some((c) => /[\p{L}\p{N}]/u.test(c.text))) return null;
  const half = line.width / Math.max(1, all.length) / 2;
  // Shrink only on the end where text was removed.
  const x = kept[0] === all[0] ? line.x : Math.max(line.x, kept[0]!.x - half);
  const end =
    kept.at(-1) === all.at(-1)
      ? line.x + line.width
      : Math.min(line.x + line.width, kept.at(-1)!.x + half);
  const width = end - x;
  return {
    ...line,
    text: kept.map((c) => c.text).join(''),
    x,
    width,
    chars: kept.map((c) => ({ text: c.text, at: (c.x - x) / width })),
  };
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Merge a line of text with several fill-in slots embedded within or attached to it: the box expands only to the right, keeping top and bottom unchanged (font size calculated from original line height). */
function mergeFills(line: OcrBox, fills: readonly FillIn[], lineHeight: number): OcrBox {
  const fontPx = BOX_TO_FONT * line.height;
  const chars = charsOf(line);
  const end = line.x + line.width;
  const used = fills.filter((f) => f.width >= FILL_MIN * lineHeight);
  // Center of each character in the original image; dots and spaces falling within dot lines are part of the dot line itself (OCR-detected '...') and are removed.
  const placed = chars.map((c) => ({ x: line.x + c.at * line.width, text: c.text }));
  const junk = leaderChars(
    placed,
    used.filter((f) => f.kind === 'dots'),
    lineHeight,
  );
  const tokens: { x: number; text: string; fill?: FillIn }[] = placed.filter((_, i) => !junk[i]);
  for (const f of used) tokens.push({ x: f.x, text: runOf(f.kind, f.width, fontPx), fill: f });
  tokens.sort((a, b) => a.x - b.x);
  const x = Math.min(line.x, ...fills.map((f) => f.x));
  const width = Math.max(end, ...fills.map((f) => f.x + f.width)) - x;
  // Join characters between gaps as-is; add a space before and after each fill-in slot, with its characters evenly distributing across the original dot line positions (used when splitting along column lines).
  const out: { text: string; at: number }[] = [];
  const space = (at: number) => {
    if (out.length && out.at(-1)!.text !== ' ') out.push({ text: ' ', at });
  };
  for (const tk of tokens) {
    if (tk.fill) {
      while (out.at(-1)?.text === ' ') out.pop();
      space((tk.x - x) / width);
      const n = tk.text.length;
      const w = tk.fill.x + tk.fill.width - tk.x;
      for (let i = 0; i < n; i++)
        out.push({ text: tk.text[i]!, at: (tk.x + ((i + 0.5) / n) * w - x) / width });
      space((tk.x + w - x) / width);
    } else if (tk.text.trim() || out.at(-1)?.text !== ' ') {
      out.push({ text: tk.text, at: (tk.x - x) / width });
    }
  }
  while (out[0]?.text === ' ') out.shift();
  while (out.at(-1)?.text === ' ') out.pop();
  return {
    ...line,
    text: out.map((c) => c.text).join(''),
    x,
    width,
    chars: out,
  };
}

/** Shaded fill-in block: at least this many line heights wide, occupying this proportion of the gap between two text segments. */
const BOX_MIN = 1.5;
const BOX_SHARE = 0.5;
/** Maximum number of line heights for the gap between two text segments. */
const BOX_GAP_MAX = 12;
/** Shaded column definition: at least this fraction of points in the column (middle section of the row) match the shading color. */
const BOX_FILLED = 0.85;
/** Color tolerance (0–255 per channel) to be considered the same color. */
const BOX_TOLERANCE = 40;
/** Shading coverage: at least this proportion under two text segments has this shading color (indicating text lies on shading, not in a gap). */
const ON_FILL = 0.3;
/** Maximum height of shading in line heights: gaps in upper and lower rows merge when aligned (EU sample 082); taller blocks are solid color regions. */
const BOX_MAX_HEIGHT = 2.3;
/** Brighter than this (in every channel) is white paper, not shading color. */
const PAPER = 235;

/**
 * Fill-in regions in the middle of sentences represented by background shading (cyan or grey
 * blanks in contract templates, Word form fields exported to PDF, EU sample 082): OCR splits
 * there, turning one line into multiple segments. Subsequent segments might be taller than the
 * first, sorting to the front of the entire block, or segments might be treated as side-by-side
 * columns/cells. Segments on the same row separated by such shading are merged into a single
 * line, inserting a run of '_' where the shading is (same as line fill-in slots, indicating
 * required input in Word). Shading only one line high: separate gaps above solid color blocks
 * (column backgrounds) are not merged.
 */
export function joinShadedBlanks(
  image: RgbaImage,
  input: readonly OcrBox[],
  lineHeight: number,
): { lines: OcrBox[]; source: Map<OcrBox, OcrBox> } {
  const source = new Map<OcrBox, OcrBox>();
  const { width, height, data } = image;
  const at = (x: number, y: number) => {
    const o =
      (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4;
    return [data[o]!, data[o + 1]!, data[o + 2]!] as const;
  };
  const paper = (c: readonly number[]) => c.every((v) => v >= PAPER);
  const near = (a: readonly number[], b: readonly number[]) =>
    a.every((v, i) => Math.abs(v - b[i]!) <= BOX_TOLERANCE);
  /** Check if the gap between a and b contains one line-height of shading: returns its left and right bounds. */
  const boxBetween = (a: OcrBox, b: OcrBox) => {
    const x0 = Math.ceil(a.x + a.width);
    const x1 = Math.floor(b.x);
    const gap = x1 - x0;
    if (gap < BOX_MIN * lineHeight || gap > BOX_GAP_MAX * lineHeight) return null;
    const top = Math.max(a.y, b.y);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const y0 = Math.round(top + 0.25 * (bottom - top));
    const y1 = Math.round(bottom - 0.25 * (bottom - top));
    if (y1 <= y0) return null;
    // Shading color: the color of the exact center point of the gap (not white paper).
    const color = at(Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2));
    if (paper(color)) return null;
    let best: [number, number] | null = null;
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      let n = 0;
      for (let y = y0; y < y1; y++) if (near(at(x, y), color)) n++;
      const filled = x < x1 && n >= BOX_FILLED * (y1 - y0);
      if (filled && start < 0) start = x;
      if (!filled && start >= 0) {
        if (!best || x - start > best[1] - best[0]) best = [start, x];
        start = -1;
      }
    }
    if (!best || best[1] - best[0] < Math.max(BOX_MIN * lineHeight, BOX_SHARE * gap)) return null;
    // Text segments themselves on white paper: when characters also rest on this shading, it
    // represents full-row shading (light green table rows in bill, EU sample 025), not fillable
    // blanks inside sentences.
    const under = (l: OcrBox, from: number, to: number) => {
      let n = 0;
      let all = 0;
      for (let x = Math.round(from); x < Math.round(to); x += 2)
        for (let y = y0; y < y1; y++) {
          all++;
          if (near(at(x, y), color)) n++;
        }
      return all ? n / all : 0;
    };
    const reach = Math.min(2 * lineHeight, a.width, b.width);
    if (
      under(a, a.x + a.width - reach, a.x + a.width) > ON_FILL ||
      under(b, b.x, b.x + reach) > ON_FILL
    )
      return null;
    // Line height: measure height upward and downward at several points in the shading, taking the
    // minimum (spaces in upper and lower rows often touch, merging into two line heights; solid
    // color blocks are much taller everywhere).
    const cy = Math.round((y0 + y1) / 2);
    const limit = Math.ceil(BOX_MAX_HEIGHT * lineHeight);
    const tall = (x: number) => {
      let up = 0;
      while (up <= limit && near(at(x, cy - up - 1), color)) up++;
      let down = 0;
      while (down <= limit && near(at(x, cy + down + 1), color)) down++;
      return up + down + 1;
    };
    const span = best[1] - best[0];
    const heights = [0.1, 0.3, 0.5, 0.7, 0.9].map((k) => tall(Math.round(best![0] + k * span)));
    if (Math.min(...heights) > limit) return null;
    return best;
  };
  const sameRow = (a: OcrBox, b: OcrBox) =>
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >=
      0.6 * Math.min(a.height, b.height) &&
    Math.max(a.height, b.height) <= 2 * Math.min(a.height, b.height);
  const lines = [...input];
  const used = new Set<OcrBox>();
  const out: OcrBox[] = [];
  for (const first of [...lines].sort((a, b) => a.x - b.x)) {
    if (used.has(first)) continue;
    let line = first;
    // Compare with the newly merged segment (merged lines are much taller than a single 'y').
    let last = first;
    for (;;) {
      const right = last.x + last.width;
      const next = lines
        .filter((l) => !used.has(l) && l !== first && l.x >= right && sameRow(last, l))
        .sort((a, b) => a.x - b.x)[0];
      const box = next && boxBetween(last, next);
      if (!next || !box) break;
      used.add(next);
      line = joinAcross(line, next, box);
      last = next;
    }
    used.add(first);
    if (line !== first) source.set(line, first);
    out.push(line);
  }
  return { lines: out, source };
}

/** Merge two text segments and the intervening shading into a single line: insert a run of '_' at the shading, and do not add a space if the subsequent segment starts with punctuation. */
function joinAcross(a: OcrBox, b: OcrBox, box: [number, number]): OcrBox {
  const x = a.x;
  const right = b.x + b.width;
  const w = right - x;
  const fontPx = BOX_TO_FONT * a.height;
  const run = runOf('rule', box[1] - box[0], fontPx);
  const place = (l: OcrBox) =>
    charsOf(l).map((c) => ({ text: c.text, at: (l.x + c.at * l.width - x) / w }));
  const chars = [
    ...place(a),
    { text: ' ', at: (a.x + a.width - x) / w },
    ...[...run].map((ch, i) => ({
      text: ch,
      at: (box[0] + ((i + 0.5) / run.length) * (box[1] - box[0]) - x) / w,
    })),
    ...(/^[.,;:)]/u.test(b.text) ? [] : [{ text: ' ', at: (box[1] - x) / w }]),
    ...place(b),
  ];
  const y = Math.min(a.y, b.y);
  return {
    ...a,
    text: chars.map((c) => c.text).join(''),
    x,
    y,
    width: w,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    chars,
  };
}

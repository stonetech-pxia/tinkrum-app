import { findSkew, localStats, sauvolaThreshold } from '@morph/tool-image';

import type { Box, RgbaImage } from './types';

// Find table lines (D-272): local threshold binarization (using the same Sauvola algorithm as
// scanned document enhancement's black-and-white mode), finding long dark segments row by row and
// column by column, connecting adjacent segments into lines, and retaining only those connected to
// other lines: horizontal and vertical lines intersecting into a grid (plus T-shaped lines touching
// only one line in the grid), or at least 3 left-right aligned horizontal lines (for tables with
// only horizontal lines). Standalone horizontal lines (underlines beneath text, strikethroughs,
// separators) are not considered table lines. Photos may have a slight tilt: scanned at the angle
// estimated by `findSkew`, with line coordinates adjusted to be upright (x' = x + y·t, y' = y -
// x·t).

/** A line: for horizontal lines, `pos` is y, `from` and `to` are x; for vertical lines, the reverse. Coordinates are post-rectification. */
export interface RuleLine {
  pos: number;
  from: number;
  to: number;
  thickness: number;
  /** Ink-containing segments (ordered by `from`, non-overlapping). */
  spans: [number, number][];
  /** Upper and lower edges of solid horizontal bars (D-501). */
  band?: 'top' | 'bottom';
}

export interface PageLines {
  width: number;
  height: number;
  /** Tilt angle (in degrees); coordinates are already rectified accordingly. */
  skew: number;
  horizontal: RuleLine[];
  vertical: RuleLine[];
}

/** Lines and bounds of a table (post-rectification coordinates). */
export interface TableLines {
  hs: RuleLine[];
  vs: RuleLine[];
  box: Box;
}

/** The long side of the image used for analysis does not exceed this size; if it exceeds it, it is downscaled first. */
export const LINE_MAX_SIDE = 2000;
/** Allowed gaps within segments (in pixels). */
const MAX_GAP = 3;
/**
 * Minimum line length: max(24 pixels, 1.5% of page width or height). In real forms, a row is only
 * 30 pixels high, so vertical lines must also be recognized; "lines" formed by connected bold
 * text are removed in `build.ts` via `dropTextStrokes`.
 */
const MIN_LENGTH = 24;
const MIN_LENGTH_SHARE = 0.015;
/** Thickness exceeding 1.5% of the page is a color block, not a line. */
const MAX_THICKNESS_SHARE = 0.015;
/** Merge adjacent segments into a single line: position difference does not exceed 0.4% of the long side. */
const MERGE_SHARE = 0.004;
/**
 * Two segments on the same line are joined when the gap between them does not exceed max(8
 * pixels, 0.5% of page width) (photocopies frequently have broken lines). A larger gap would
 * wrongly connect the borders of vertically adjacent boxes (which are 15–20 pixels apart in
 * payslips).
 */
const JOIN_MIN = 8;
const JOIN_SHARE = 0.005;
/** Lines are considered connected: endpoints are no more than 0.5% of the long side away from another line (adjacent boxes are not considered connected). */
const TOUCH_SHARE = 0.005;
/**
 * Solid horizontal bars (D-501: dark background bars in payslips and invoice headers containing
 * white text): thicker than lines, not exceeding 6% of page height, at least twice as long as
 * they are thick, and consisting of ink for over 60% (with white text). Considered part of the
 * table only when at least two vertical lines start or end at their top and bottom edges (table
 * column lines): treated as a box where top and bottom edges are horizontal lines and left and
 * right ends are vertical lines. The line of text inside the bar is not covered by vertical
 * lines, and cells are divided according to upper and lower column lines (white gaps between
 * header cells are often invisible in photos and cannot be relied upon). Erased before finding
 * vertical lines, otherwise vertical lines drawn downward from it would merge with it into a
 * large block and be entirely discarded as a color block. Page edge black borders, colored arrow
 * bars, and logos lack starting/ending vertical lines and are excluded.
 */
const BAND_MAX_SHARE = 0.06;
const BAND_MIN_ELONGATION = 2;
const BAND_MIN_FILL = 0.6;
const BAND_MIN_ANCHORS = 2;
const BAND_RULED_GAP = 3;
const BAND_RULED_MIN = 2;
/** Vertical lines reaching this proportion of the page height (95%) are paper edges or gutters and are excluded from table grouping. */
const PAGE_EDGE_SHARE = 0.95;
/** Tables with only horizontal lines: left and right alignment error tolerance (2% of page width), with adjacent lines separated by at most 40% of page height (table bodies in three-line tables are very tall). */
const ALIGN_SHARE = 0.02;
const RULED_GAP_SHARE = 0.4;
const RULED_MIN = 3;
/**
 * Sequences of horizontal-only lines where the first two lines are separated by at most 10% of
 * page height: only the header row sits between the top line and header line of a three-line
 * table, and only table bodies can be very tall. Those separated by a large gap from the start
 * are bottom lines of section form boxes or fill-in lines (EU sample 014), not a table.
 */
const RULED_HEAD_GAP_SHARE = 0.1;
/** Equidistant sequences (maximum spacing does not exceed `RULED_EVEN` times the minimum) are split upon encountering a gap exceeding `RULED_SPLIT_STEPS` times the spacing. */
const RULED_EVEN = 1.3;
const RULED_SPLIT_STEPS = 2.5;

/**
 * Very faint table lines (for Word conversion, `findLines` light mode): digital invoice templates
 * and forms commonly use light gray lines (darkest channel 0.75–0.86), while Sauvola's threshold
 * on white paper is around 0.7, failing to find them. When paper is very white (over half the
 * page points have at least `LIGHT_PAPER` brightness: digital documents, clean scans), points
 * darker than the paper by `LIGHT_CONTRAST` are also counted, but only for thin elements:
 * vertically connected points within `LIGHT_THICKNESS` when scanning horizontally (and vice versa
 * for vertical lines). Wide and tall cells or color blocks with light shading are excluded
 * (otherwise shaded cells would be treated as horizontal bars and split the table). Photos with
 * insufficiently white paper are unaffected.
 */
const LIGHT_PAPER = 0.95;
const LIGHT_CONTRAST = 0.1;
const LIGHT_THICKNESS_SHARE = 0.004;

/** Page paper brightness: median ink darkness (binned in 1/256 increments). */
function paperOf(ink: Float32Array): number {
  const counts = new Uint32Array(257);
  for (let p = 0; p < ink.length; p++) counts[Math.round(ink[p]! * 256)]!++;
  let seen = 0;
  for (let v = 0; v <= 256; v++) {
    seen += counts[v]!;
    if (seen * 2 >= ink.length) return v / 256;
  }
  return 1;
}

/**
 * Adds light thin lines to the mask: points darker than paper by `LIGHT_CONTRAST`, continuously
 * connected along the `across` direction for at most `max` points, flanked by white paper. When
 * `vertical` is true, points are connected along columns (for horizontal lines), otherwise along
 * rows (for vertical lines).
 */
function addThinLight(
  mask: Uint8Array,
  ink: Float32Array,
  width: number,
  height: number,
  paper: number,
  max: number,
  vertical: boolean,
): Uint8Array {
  const limit = paper - LIGHT_CONTRAST;
  const bright = paper - LIGHT_CONTRAST / 2;
  const out = mask.slice();
  const outer = vertical ? width : height;
  const inner = vertical ? height : width;
  const at = (o: number, i: number) => (vertical ? i * width + o : o * width + i);
  for (let o = 0; o < outer; o++) {
    let start = -1;
    for (let i = 0; i <= inner; i++) {
      const dark = i < inner && ink[at(o, i)]! < limit;
      if (dark && start < 0) start = i;
      else if (!dark && start >= 0) {
        // Both sides must still be white paper separated by one point (the gray fringe along line edges): noise in light shading or narrow strips of shading sandwiched between two text rows are excluded.
        const before = ink[at(o, Math.max(0, start - 2))]!;
        const after = ink[at(o, Math.min(inner - 1, i + 1))]!;
        if (i - start <= max && before >= bright && after >= bright)
          for (let k = start; k < i; k++) out[at(o, k)] = 1;
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Colors with brightness reaching this level are background colors rather than ink: yellow, light
 * green, and light blue shaded cells (such as the yellow merged cell #FFCB35 in Italian
 * electricity bills, EU sample 057) have very dark darkest channels, which would otherwise cause
 * them to merge into large blocks with adjacent table lines, causing entire lines to be discarded
 * as color blocks and preventing table recognition.
 */
const FILL_LUMA = 0.7;
/** Also requires high color saturation (difference between brightest and darkest channels reaches this value): light blue grid lines, light gray shading, and artifacts around text are excluded, retaining evaluation by darkest channel as usual. */
const FILL_CHROMA = 0.3;

/**
 * Ink darkness: the darkest of the three channels (0 black - 1 white), including red and blue
 * text lines; bright and saturated colors (`FILL_LUMA`, `FILL_CHROMA`: yellow and orange-yellow
 * backgrounds) are evaluated by brightness, while light colored lines are still found as light
 * lines in light mode.
 */
function inkOf(image: RgbaImage): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    out[p] = luma >= FILL_LUMA && (max - min) / 255 >= FILL_CHROMA ? luma : min / 255;
  }
  return out;
}

/** Integer-factor downscaling (taking the darkest point in each block so that thin lines are not averaged out). */
function shrink(image: RgbaImage, k: number): RgbaImage {
  const width = Math.max(1, Math.floor(image.width / k));
  const height = Math.max(1, Math.floor(image.height / k));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = 255 * 3 + 1;
      let at = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * image.width + x * k + dx) * 4;
          const s = image.data[i]! + image.data[i + 1]! + image.data[i + 2]!;
          if (s < best) {
            best = s;
            at = i;
          }
        }
      }
      const o = (y * width + x) * 4;
      data[o] = image.data[at]!;
      data[o + 1] = image.data[at + 1]!;
      data[o + 2] = image.data[at + 2]!;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Binarization: Sauvola local threshold (charts are at half resolution), where 1 is black. */
function darkMask(ink: Float32Array, width: number, height: number): Uint8Array {
  const stats = localStats(ink, width, height);
  const sw = stats.width;
  const thresholds = new Float32Array(sw * stats.height);
  for (let p = 0; p < thresholds.length; p++) {
    const mean = stats.data[p * 4]! / 255;
    const sd = stats.data[p * 4 + 1]! / 255 / 2;
    // Add an absolute threshold: light grey background shading and paper texture are not counted.
    thresholds[p] = Math.min(sauvolaThreshold(mean, sd), 0.75);
  }
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(stats.height - 1, y >> 1);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(sw - 1, x >> 1);
      if (ink[y * width + x]! < thresholds[sy * sw + sx]!) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Solid horizontal bar: first and last are the upper and lower scanning row numbers, from and to are left and right (after deskewing, before conversion). */
interface Band {
  first: number;
  last: number;
  from: number;
  to: number;
  spans: [number, number][];
}

interface Building {
  first: number;
  last: number;
  posSum: number;
  weight: number;
  from: number;
  to: number;
  spans: [number, number][];
  /** Sum of segment lengths for each row (starting from first). */
  lengths: number[];
  /** Left and right extent of ink for each row (starting from first). */
  ends: [number, number][];
}

/**
 * A small patch of color touching a line (e.g., an amount highlighted with a highlighter, a red
 * circle around a name, EU sample 067): if connected, it is too thick and the entire line would
 * be dropped as a color block. Within a too-thick block, if lines whose length reaches CORE_SHARE
 * of the longest row are sufficiently thin while other rows fall short of CORE_REST, take those
 * specific rows as the line.
 */
const CORE_SHARE = 0.8;
const CORE_REST = 0.5;
/** Mark both ends of a line as being at least this many pixels away (e.g., highlighter-marked amount inside a box, several pixels away from the right-hand line). */
const CORE_END_MARGIN = 3;
/** A block must have at least this many rows adjacent to the line end to be valid (rejecting rough 1-2 pixel fringes on the edge of a line). */
const CORE_END_ROWS = 3;

/**
 * Thin lines touching color blocks within a too-thick block (CORE_SHARE, CORE_REST). When a color
 * block spans from one line to the next (with markings at the bottom of the previous row and top
 * of the next row), a single block may contain multiple lines, each processed independently.
 */
function thinCores(l: Building, maxThickness: number): Building[] {
  // One or two inkless rows in between are considered empty.
  const lengths = Array.from(l.lengths, (n) => n ?? 0);
  const longest = Math.max(...lengths);
  const isCore = lengths.map((n) => n >= CORE_SHARE * longest);
  if (lengths.some((n, i) => !isCore[i] && n > CORE_REST * longest)) return [];
  // A block touching a line end (such as a numbering box on a corner, EU sample 068) is part of the box, not a marking on the line.
  const from = Math.min(...l.ends.filter((_, i) => isCore[i]).map((e) => e[0]));
  const to = Math.max(...l.ends.filter((_, i) => isCore[i]).map((e) => e[1]));
  // Rough 1-2 pixel fringes on the edge of a line (slightly slanted lines with only a segment on adjacent rows) are ignored.
  const atEnd = l.ends.filter(
    (e, i) => e && !isCore[i] && (e[0] - from < CORE_END_MARGIN || to - e[1] < CORE_END_MARGIN),
  ).length;
  if (atEnd >= CORE_END_ROWS) return [];
  const runs: [number, number][] = [];
  isCore.forEach((c, i) => {
    if (!c) return;
    const run = runs[runs.length - 1];
    if (run && run[1] === i - 1) run[1] = i;
    else runs.push([i, i]);
  });
  if (runs.some(([first, last]) => last - first + 1 > maxThickness)) return [];
  return runs.map(([first, last]) => {
    const rows = lengths.slice(first, last + 1);
    return {
      ...l,
      first: l.first + first,
      last: l.first + last,
      posSum: rows.reduce((sum, n, i) => sum + (l.first + first + i) * n, 0),
      weight: rows.reduce((a, b) => a + b, 0),
      lengths: rows,
      ends: l.ends.slice(first, last + 1),
    };
  });
}

/** Add a span to a set of spans (non-overlapping, sorted), merging overlapping or adjacent ones (within gap). */
export function addSpan(spans: [number, number][], a: number, b: number, gap: number): void {
  let i = 0;
  while (i < spans.length && spans[i]![1] + gap < a) i++;
  let lo = a;
  let hi = b;
  let j = i;
  while (j < spans.length && spans[j]![0] - gap <= hi) {
    lo = Math.min(lo, spans[j]![0]);
    hi = Math.max(hi, spans[j]![1]);
    j++;
  }
  spans.splice(i, j - i, [lo, hi]);
}

/** Length covered by a set of spans within [a, b]. */
export function coveredLength(spans: readonly (readonly [number, number])[], a: number, b: number) {
  let sum = 0;
  for (const [s, e] of spans) {
    const lo = Math.max(s, a);
    const hi = Math.min(e, b);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

/**
 * Line scan in one direction. When horizontal, scan each row along x (row number is deskewed y);
 * otherwise, scan each column along y. t is the tangent of the tilt angle: for horizontal lines y
 * = r + x*t, for vertical lines x = c - y*t.
 */
function scan(
  mask: Uint8Array,
  width: number,
  height: number,
  t: number,
  horizontal: boolean,
  /** If provided, collect solid horizontal bars (BAND_MAX_SHARE) and do not treat them as lines. */
  bands?: Band[],
  /**
   * When finding vertical lines: points covered by already found horizontal lines. Scanning
   * vertically, breaks in ink separated only by horizontal lines (where lines intersect) are not
   * counted as breaks; when a gap contains white paper yet connects to horizontal lines, those
   * horizontal points are also included in the gap (see markLines).
   */
  crossing?: Uint8Array,
  /** When finding horizontal lines: record points covered by found horizontal lines here for use in finding vertical lines. */
  marks?: Uint8Array,
): RuleLine[] {
  const along = horizontal ? width : height;
  const across = horizontal ? height : width;
  const minLength = Math.max(MIN_LENGTH, along * MIN_LENGTH_SHARE);
  const maxThickness = Math.max(3, across * MAX_THICKNESS_SHARE);
  const slope = horizontal ? t : -t;
  const lo = Math.floor(Math.min(0, -along * slope));
  const hi = Math.ceil(Math.max(across, across - along * slope));
  const done: Building[] = [];
  let open: Building[] = [];
  for (let r = lo; r < hi; r++) {
    // Long segments in this row (or column).
    const runs: [number, number][] = [];
    let start = -1;
    let lastDark = -1;
    // The previous non-horizontal-line ink point and whether there has been white space since: in
    // densely packed tables, vertical strokes of text across adjacent rows are separated only by a
    // "white gap + row line + white gap", and a gap of a few pixels would merge them into a single
    // vertical line (EU sample 090). The row line itself is not ink; the gap is measured from the
    // previous stroke.
    let lastInk = -1;
    let white = false;
    for (let i = 0; i <= along; i++) {
      let dark = false;
      let across_ = false;
      if (i < along) {
        const j = Math.round(r + i * slope);
        if (j >= 0 && j < across) {
          const p = horizontal ? j * width + i : i * width + j;
          dark = mask[p] === 1;
          across_ = dark && crossing?.[p] === 1;
        }
      }
      if (dark) {
        // After the previous stroke, if separated by white paper and a horizontal line exceeding MAX_GAP in total, break and start a new segment here.
        if (start >= 0 && !across_ && white && i - lastInk - 1 > MAX_GAP) {
          if (lastInk - start + 1 >= minLength) runs.push([start, lastInk]);
          start = -1;
        }
        if (start < 0) {
          start = i;
          lastInk = i;
          white = false;
        }
        lastDark = i;
        if (!across_) {
          lastInk = i;
          white = false;
        }
      } else {
        if (start >= 0) white = true;
        if (
          start >= 0 &&
          (i - lastDark > MAX_GAP || i === along || (white && i - lastInk > MAX_GAP))
        ) {
          if (lastDark - start + 1 >= minLength) runs.push([start, lastDark]);
          start = -1;
        }
      }
    }
    for (const [a, b] of runs) {
      let target: Building | undefined;
      for (const line of open) {
        const overlap = Math.min(b, line.to) - Math.max(a, line.from);
        if (line.last >= r - 2 && overlap >= 0.5 * Math.min(b - a, line.to - line.from)) {
          target = line;
          break;
        }
      }
      const length = b - a + 1;
      if (target) {
        target.last = r;
        target.posSum += r * length;
        target.weight += length;
        target.from = Math.min(target.from, a);
        target.to = Math.max(target.to, b);
        addSpan(target.spans, a, b, MAX_GAP);
        target.lengths[r - target.first] = (target.lengths[r - target.first] ?? 0) + length;
        const end = target.ends[r - target.first];
        target.ends[r - target.first] = end ? [Math.min(end[0], a), Math.max(end[1], b)] : [a, b];
      } else {
        open.push({
          first: r,
          last: r,
          posSum: r * length,
          weight: length,
          from: a,
          to: b,
          spans: [[a, b]],
          lengths: [length],
          ends: [[a, b]],
        });
      }
    }
    const still: Building[] = [];
    for (const line of open) (line.last < r - 2 ? done : still).push(line);
    open = still;
  }
  done.push(...open);
  if (bands) {
    for (const l of done) {
      const thickness = l.last - l.first + 1;
      const length = l.to - l.from + 1;
      if (
        thickness > maxThickness &&
        thickness <= across * BAND_MAX_SHARE &&
        length >= BAND_MIN_ELONGATION * thickness &&
        l.weight >= BAND_MIN_FILL * length * thickness
      )
        bands.push({ first: l.first, last: l.last, from: l.from, to: l.to, spans: l.spans });
    }
  }
  // Coordinates along the line direction are also converted to deskewed coordinates: for horizontal lines x' ≈ x + y'*t, for vertical lines y' ≈ y - x'*t.
  const kept = done.flatMap((l) => {
    if (l.last - l.first + 1 <= maxThickness) return [l];
    return thinCores(l, maxThickness);
  });
  if (marks)
    for (const l of kept)
      for (let r = l.first; r <= l.last; r++)
        for (const [a, b] of l.spans)
          for (let i = Math.max(0, a); i <= Math.min(along - 1, b); i++) {
            const j = Math.round(r + i * slope);
            if (j >= 0 && j < across) marks[horizontal ? j * width + i : i * width + j] = 1;
          }
  const lines = kept.map((l) => {
    const pos = l.posSum / l.weight;
    const shift = horizontal ? pos * t : -pos * t;
    return {
      pos,
      from: l.from + shift,
      to: l.to + shift,
      thickness: l.last - l.first + 1,
      spans: l.spans.map(([a, b]) => [a + shift, b + shift] as [number, number]),
    };
  });
  return joinCollinear(
    lines,
    Math.max(2, Math.max(width, height) * MERGE_SHARE),
    Math.max(JOIN_MIN, along * JOIN_SHARE),
  );
}

/** Join multiple segments at the same position into a single line (broken lines or lines interrupted at intersections with other lines). */
function joinCollinear(lines: RuleLine[], posTol: number, gapTol: number): RuleLine[] {
  const out = [...lines].sort((a, b) => a.pos - b.pos || a.from - b.from);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (b.pos - a.pos > posTol) break;
        const gap = Math.max(a.from, b.from) - Math.min(a.to, b.to);
        if (gap > gapTol) continue;
        const la = a.to - a.from;
        const lb = b.to - b.from;
        const spans = a.spans.map((s) => [...s] as [number, number]);
        for (const [s, e] of b.spans) addSpan(spans, s, e, MAX_GAP);
        out[i] = {
          pos: (a.pos * la + b.pos * lb) / Math.max(1, la + lb),
          from: Math.min(a.from, b.from),
          to: Math.max(a.to, b.to),
          thickness: Math.max(a.thickness, b.thickness),
          spans,
          ...(a.band || b.band ? { band: a.band ?? b.band } : {}),
        };
        out.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Erase horizontal bars (points at scan row number r at y = r + x*t). */
function eraseBands(
  mask: Uint8Array,
  width: number,
  height: number,
  t: number,
  bands: readonly Band[],
): Uint8Array {
  if (!bands.length) return mask;
  const out = mask.slice();
  for (const b of bands) {
    for (let r = b.first; r <= b.last; r++) {
      for (let x = Math.max(0, b.from); x <= Math.min(width - 1, b.to); x++) {
        const y = Math.round(r + x * t);
        if (y >= 0 && y < height) out[y * width + x] = 0;
      }
    }
  }
  return out;
}

/** Number of vertical lines starting/ending at the top and bottom edges of a horizontal bar (positions that match are counted as one: a vertical line passing through the bar is cut into two segments). */
function bandAnchors(band: Band, vertical: readonly RuleLine[], t: number, tol: number): number {
  const shift = ((band.first + band.last) / 2) * t;
  const at: number[] = [];
  for (const v of vertical) {
    if (v.pos < band.from + shift - tol || v.pos > band.to + shift + tol) continue;
    const starts = Math.abs(v.from - band.last) <= tol;
    const ends = Math.abs(v.to - band.first) <= tol;
    if ((starts || ends) && at.every((p) => Math.abs(p - v.pos) > tol)) at.push(v.pos);
  }
  return at.length;
}

/**
 * A series of horizontal lines immediately below a horizontal bar and aligned with both of its
 * left and right ends (e.g., timetables or price lists where dark headers have only horizontal
 * lines underneath and at most one or two column lines, EU sample 024): treated as a single
 * bounding line. The first line is within BAND_RULED_GAP bar thicknesses of the bar's bottom
 * edge, there are at least BAND_RULED_MIN lines, and adjacent lines are no further apart.
 */
function bandRuledBelow(
  band: Band,
  horizontal: readonly RuleLine[],
  t: number,
  tol: number,
): number {
  const thick = band.last - band.first + 1;
  const shift = band.last * t;
  const below = horizontal
    .filter(
      (h) =>
        h.pos > band.last &&
        Math.abs(h.from - (band.from + shift)) <= tol &&
        Math.abs(h.to - (band.to + shift)) <= tol,
    )
    .sort((a, b) => a.pos - b.pos);
  let at = band.last;
  let n = 0;
  for (const h of below) {
    if (h.pos - at > BAND_RULED_GAP * thick) break;
    at = h.pos;
    n++;
  }
  return n >= BAND_RULED_MIN ? 1 : 0;
}

/** Treat the top and bottom edges of a horizontal bar as two horizontal lines (coordinates converted to deskewed space, same as scan). */
function bandEdges(band: Band, t: number): RuleLine[] {
  return [band.first, band.last].map((pos, i) => {
    const shift = pos * t;
    return {
      pos,
      from: band.from + shift,
      to: band.to + shift,
      thickness: 1,
      spans: band.spans.map(([a, b]) => [a + shift, b + shift] as [number, number]),
      band: i === 0 ? ('top' as const) : ('bottom' as const),
    };
  });
}

/** Treat the left and right ends of a horizontal bar as two vertical lines (coordinates same as scan: x' = x + y'*t, where y' along the line is the scan row number). */
function bandSides(band: Band, t: number): RuleLine[] {
  const shift = ((band.first + band.last) / 2) * t;
  return [band.from, band.to].map((x) => ({
    pos: x + shift,
    from: band.first,
    to: band.last,
    thickness: 1,
    spans: [[band.first, band.last]],
  }));
}

/**
 * Find horizontal and vertical lines in a page. If skew is not provided, estimate it using
 * findSkew (enhanced images are already deskewed and can pass 0 directly). If the image is too
 * large, downscale it first; returned coordinates remain in full-resolution image pixels.
 */
export function findLines(
  image: RgbaImage,
  options: { skew?: number; light?: boolean } = {},
): PageLines {
  const k = Math.max(1, Math.ceil(Math.max(image.width, image.height) / (LINE_MAX_SIDE * 1.05)));
  const work = k > 1 ? shrink(image, k) : image;
  const { width, height } = work;
  const ink = inkOf(work);
  const skew = options.skew ?? findSkew(ink, width, height);
  const t = Math.tan((skew * Math.PI) / 180);
  const mask = darkMask(ink, width, height);
  // Use separate images for horizontal and vertical lines: light thin lines are added only to the image corresponding to that search direction (light).
  let hMask = mask;
  let vMask = mask;
  const paper = options.light ? paperOf(ink) : 0;
  if (paper >= LIGHT_PAPER) {
    const max = Math.max(3, Math.round(Math.max(width, height) * LIGHT_THICKNESS_SHARE));
    hMask = addThinLight(mask, ink, width, height, paper, max, true);
    vMask = addThinLight(mask, ink, width, height, paper, max, false);
  }
  const candidates: Band[] = [];
  const crossing = new Uint8Array(width * height);
  const horizontal = scan(hMask, width, height, t, true, candidates, undefined, crossing);
  let vertical = scan(
    eraseBands(vMask, width, height, t, candidates),
    width,
    height,
    t,
    false,
    undefined,
    crossing,
  );
  const tol = Math.max(4, Math.max(width, height) * TOUCH_SHARE);
  const bands = candidates.filter(
    (b) =>
      bandAnchors(b, vertical, t, tol) + bandRuledBelow(b, horizontal, t, tol) >= BAND_MIN_ANCHORS,
  );
  // Do not erase horizontal bars that are excluded (erasing them would cut vertical lines passing through them).
  if (bands.length < candidates.length)
    vertical = scan(
      eraseBands(vMask, width, height, t, bands),
      width,
      height,
      t,
      false,
      undefined,
      crossing,
    );
  if (bands.length) {
    const posTol = Math.max(2, Math.max(width, height) * MERGE_SHARE);
    horizontal.splice(
      0,
      horizontal.length,
      ...joinCollinear(
        [...horizontal, ...bands.flatMap((b) => bandEdges(b, t))],
        posTol,
        Math.max(JOIN_MIN, width * JOIN_SHARE),
      ),
    );
    vertical.push(...bands.flatMap((b) => bandSides(b, t)));
  }
  const scale = (l: RuleLine): RuleLine =>
    k === 1
      ? l
      : {
          pos: l.pos * k,
          from: l.from * k,
          to: l.to * k + k - 1,
          thickness: l.thickness * k,
          spans: l.spans.map(([a, b]) => [a * k, b * k + k - 1]),
          ...(l.band ? { band: l.band } : {}),
        };
  return {
    width: image.width,
    height: image.height,
    skew,
    horizontal: horizontal.map(scale),
    vertical: vertical.map(scale),
  };
}

/** Two lines (one horizontal, one vertical) are connected: their intersection lies on both lines (endpoints allowed to differ by tol). */
const touches = (h: RuleLine, v: RuleLine, tol: number) =>
  v.pos >= h.from - tol && v.pos <= h.to + tol && h.pos >= v.from - tol && h.pos <= v.to + tol;

/** The segment of a vertical line between the a-th and b-th segments (excluding b). */
function piece(v: RuleLine, a: number, b: number): RuleLine {
  const spans = v.spans.slice(a, b);
  return { ...v, from: spans[0]![0], to: spans.at(-1)![1], spans };
}

/**
 * A white gap on a vertical line starting at one horizontal line and ending at another represents
 * boundaries of upper and lower boxes respectively (e.g., a 10-pixel white gap below the product
 * table in an invoice separating the tax table and total box, EU sample 054); break here rather
 * than bridging it as a broken line from a photocopy.
 */
function splitAtBoxGaps(vs: readonly RuleLine[], hs: readonly RuleLine[], near: number) {
  const ruleAt = (x: number, y: number) => {
    let best: RuleLine | undefined;
    for (const h of hs) {
      if (Math.abs(h.pos - y) > near || x < h.from - near || x > h.to + near) continue;
      if (!best || Math.abs(h.pos - y) < Math.abs(best.pos - y)) best = h;
    }
    return best;
  };
  return vs.flatMap((v) => {
    const pieces: RuleLine[] = [];
    let start = 0;
    for (let k = 1; k < v.spans.length; k++) {
      const above = ruleAt(v.pos, v.spans[k - 1]![1]);
      const below = ruleAt(v.pos, v.spans[k]![0]);
      if (above && below && above !== below) {
        pieces.push(piece(v, start, k));
        start = k;
      }
    }
    if (!start) return [v];
    pieces.push(piece(v, start, v.spans.length));
    return pieces;
  });
}

/** The segment of a vertical line (or horizontal line) within [lo, hi]. */
function clip(v: RuleLine, lo: number, hi: number): RuleLine {
  if (v.from >= lo && v.to <= hi) return v;
  const from = Math.max(v.from, lo);
  const to = Math.min(v.to, hi);
  return {
    ...v,
    from,
    to,
    spans: v.spans
      .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
      .filter(([a, b]) => b > a),
  };
}

/**
 * Boundary between stacked tables (converting to Word): a horizontal line spanning the entire
 * table where internal vertical lines (excluding left/right outer borders) stop above it,
 * internal vertical lines start below it, and upper/lower column lines differ (the line above
 * stops and has no continuation below, while the line below starts and has no continuation
 * above). Simple tables where a header row spans all columns (no vertical lines above) and column
 * lines run all the way down are not split.
 */
function stackedCuts(hs: readonly RuleLine[], vs: readonly RuleLine[], tol: number): number[] {
  const left = Math.min(...hs.map((h) => h.from), ...vs.map((v) => v.pos));
  const right = Math.max(...hs.map((h) => h.to), ...vs.map((v) => v.pos));
  const inner = vs.filter((v) => v.pos > left + tol && v.pos < right - tol);
  const cuts: number[] = [];
  for (const h of hs) {
    if (h.from > left + tol || h.to < right - tol) continue;
    const ending = inner.filter((v) => Math.abs(v.to - h.pos) <= tol && v.from < h.pos - tol);
    const starting = inner.filter((v) => Math.abs(v.from - h.pos) <= tol && v.to > h.pos + tol);
    const at = (list: readonly RuleLine[], x: number) =>
      list.some((v) => Math.abs(v.pos - x) <= tol);
    if (
      ending.some((v) => !at(starting, v.pos)) &&
      starting.some((v) => !at(ending, v.pos)) &&
      cuts.every((c) => Math.abs(c - h.pos) > tol)
    )
      cuts.push(h.pos);
  }
  return cuts;
}

/**
 * Side-by-side tables (converting to Word): share a top header (full-page title box, a row like
 * "Dati paziente"), separated by a white gap between the left and right tables below, with
 * respective horizontal lines ending at the edges of the white gap and unaligned rows (laboratory
 * request form, EU sample 090). When connected into a grid, row and column lines intertwine, and
 * multi-column grids chop up text. If there is a vertical line drawn down the full height on each
 * side of the white gap (with at least three horizontal lines terminating at it), no vertical
 * lines or text inside the white gap, and no horizontal lines crossing below the final horizontal
 * line traversing the white gap: cut at that horizontal line, yielding one table on top and
 * left/right tables below. Do not split if lower horizontal lines reconnect the two sides (where
 * the middle column is just a merged large cell).
 */
function sideBySide(
  t: TableLines,
  tol: number,
  text: readonly { x: number; y: number; width: number; height: number }[],
): TableLines[] | null {
  const xs = [...new Set(t.vs.map((v) => Math.round(v.pos)))].sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k++) {
    const [a, b] = [xs[k]!, xs[k + 1]!];
    if (b - a < 2 * tol) continue;
    const crossing = t.hs.filter((h) => h.from < a - tol && h.to > b + tol);
    if (!crossing.length) continue;
    const y = Math.max(...crossing.map((h) => h.pos));
    const below = t.hs.filter((h) => h.pos > y + tol);
    const ending = below.filter((h) => Math.abs(h.to - a) <= tol);
    const starting = below.filter((h) => Math.abs(h.from - b) <= tol);
    if (ending.length < 3 || starting.length < 3) continue;
    const bottom = Math.max(...below.map((h) => h.pos));
    // Vertical lines on both sides of the white gap extend downward from the cut to cover the major portion of each of the two tables.
    const side = (x: number, lines: readonly RuleLine[]) =>
      t.vs.some(
        (v) =>
          Math.abs(v.pos - x) <= tol &&
          v.from <= y + tol &&
          v.to >= Math.max(...lines.map((h) => h.pos)) - tol,
      );
    if (!side(a, ending) || !side(b, starting)) continue;
    if (
      text.some((l) => {
        const cx = l.x + l.width / 2;
        const cy = l.y + l.height / 2;
        return cx > a + tol && cx < b - tol && cy > y && cy < bottom;
      })
    )
      continue;
    const top: TableLines['hs'] = t.hs.filter((h) => h.pos <= y + tol);
    const topV = t.vs.filter((v) => v.from < y - tol).map((v) => clip(v, -Infinity, y));
    const part = (hs: RuleLine[], vs: RuleLine[]): TableLines[] => {
      if (hs.length < 2) return [];
      const left = Math.min(...hs.map((h) => h.from), ...vs.map((v) => v.pos));
      const right = Math.max(...hs.map((h) => h.to), ...vs.map((v) => v.pos));
      const y0 = Math.min(...hs.map((h) => h.pos), ...vs.map((v) => v.from));
      const y1 = Math.max(...hs.map((h) => h.pos), ...vs.map((v) => v.to));
      return [
        {
          hs: hs.sort((p, q) => p.pos - q.pos),
          vs: vs.sort((p, q) => p.pos - q.pos),
          box: { x: left, y: y0, width: right - left, height: y1 - y0 },
        },
      ];
    };
    const lower = (lo: number, hi: number) => {
      const hs = t.hs
        .filter((h) => h.pos >= y - tol && h.to > lo + tol && h.from < hi - tol)
        .map((h) => clip(h, lo, hi));
      const vs = t.vs
        .filter((v) => v.pos >= lo - tol && v.pos <= hi + tol && v.to > y + tol)
        .map((v) => clip(v, y, Infinity));
      return part(hs, vs);
    };
    return [...part(top, topV), ...lower(-Infinity, a), ...lower(b, Infinity)];
  }
  return null;
}

/**
 * Only lines connected to other lines are considered table lines, and connected lines form a
 * table: a horizontal line intersects at least 2 vertical lines, and a vertical line intersects
 * at least 2 horizontal lines; or at least 3 left-right aligned, closely spaced horizontal lines
 * (table with only horizontal lines).
 */
export function findTables(
  page: PageLines,
  options: {
    /**
     * Convert to Word: when stacked tables share an outer border (e.g., separate tables within a
     * full-page form box, EU sample 004), split at horizontal lines where column lines change,
     * see stackedCuts. Do not split for Excel (shared column lines across the full page).
     */
    splitStacked?: boolean;
    /** Text on the page (in the same coordinate system as lines): evenly spaced fill-in horizontal lines are broken at large gaps only when there is at most one short label per cell. */
    text?: readonly { x: number; y: number; width: number; height: number }[];
  } = {},
): TableLines[] {
  const long = Math.max(page.width, page.height);
  const tol = Math.max(4, long * TOUCH_SHARE);
  const hs = page.horizontal;
  // Endpoint falls on a horizontal line: distance from it does not exceed this amount (line width plus anti-aliased edge, without crossing the white gap).
  const near = Math.max(MAX_GAP, tol * 0.4);
  // Vertical lines running almost from page top to page bottom are page margins or centerfolds
  // (photographed two-page side-by-side manual, EU sample 100), not column lines of a table:
  // otherwise, horizontal table lines within tol of it would cause half a page of text and the
  // table to be treated as a single massive grid.
  const vs = splitAtBoxGaps(
    page.vertical.filter((v) => v.to - v.from < PAGE_EDGE_SHARE * page.height),
    hs,
    near,
  );
  const onRule = (x: number, y: number) =>
    hs.some((h) => Math.abs(h.pos - y) <= near && x >= h.from - near && x <= h.to + near);
  const ends = new Map(vs.map((v) => [v, [onRule(v.pos, v.from), onRule(v.pos, v.to)]] as const));
  // Once an endpoint of a vertical line lands on a horizontal line, it is no longer considered to meet horizontal lines outside that endpoint separated by a white gap (preventing adjacent stacked boxes from merging into a single table).
  const meets = (h: RuleLine, v: RuleLine) => {
    const [top, bottom] = ends.get(v)!;
    return (
      touches(h, v, tol) && !(top && h.pos < v.from - near) && !(bottom && h.pos > v.to + near)
    );
  };
  // Grid: repeatedly remove insufficiently connected lines until stable.
  const hOk = hs.map(() => true);
  const vOk = vs.map(() => true);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [i, h] of hs.entries()) {
      if (!hOk[i]) continue;
      if (vs.filter((v, j) => vOk[j] && meets(h, v)).length < 2) {
        hOk[i] = false;
        changed = true;
      }
    }
    for (const [j, v] of vs.entries()) {
      if (!vOk[j]) continue;
      if (hs.filter((h, i) => hOk[i] && meets(h, v)).length < 2) {
        vOk[j] = false;
        changed = true;
      }
    }
  }
  // Disjoint-set data structure: horizontal lines 0..H-1, vertical lines H..H+V-1.
  const parent = [...hs, ...vs].map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const used = new Set<number>();
  for (const [i, h] of hs.entries()) {
    if (!hOk[i]) continue;
    for (const [j, v] of vs.entries()) {
      if (vOk[j] && meets(h, v)) {
        union(i, hs.length + j);
        used.add(i).add(hs.length + j);
      }
    }
  }
  // Lines that touch only a single line and lie entirely inside the grid are also included (T-shapes: vertical lines in headers that do not extend to the top, horizontal lines spanning only half a row).
  const extent = new Map<number, { l: number; r: number; t: number; b: number }>();
  for (const i of used) {
    const root = find(i);
    const e = extent.get(root) ?? { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
    if (i < hs.length) {
      const h = hs[i]!;
      e.l = Math.min(e.l, h.from);
      e.r = Math.max(e.r, h.to);
      e.t = Math.min(e.t, h.pos);
      e.b = Math.max(e.b, h.pos);
    } else {
      const v = vs[i - hs.length]!;
      e.l = Math.min(e.l, v.pos);
      e.r = Math.max(e.r, v.pos);
      e.t = Math.min(e.t, v.from);
      e.b = Math.max(e.b, v.to);
    }
    extent.set(root, e);
  }
  const within = (root: number, x0: number, x1: number, y0: number, y1: number) => {
    const e = extent.get(root)!;
    return x0 >= e.l - tol && x1 <= e.r + tol && y0 >= e.t - tol && y1 <= e.b + tol;
  };
  for (const [j, v] of vs.entries()) {
    if (vOk[j]) continue;
    const i = hs.findIndex((h, k) => hOk[k] && meets(h, v));
    if (i >= 0 && within(find(i), v.pos, v.pos, v.from, v.to)) {
      vOk[j] = true;
      union(hs.length + j, i);
      used.add(hs.length + j);
    }
  }
  for (const [i, h] of hs.entries()) {
    if (hOk[i]) continue;
    const j = vs.findIndex((v, k) => vOk[k] && meets(h, v));
    if (j >= 0 && within(find(hs.length + j), h.from, h.to, h.pos, h.pos)) {
      hOk[i] = true;
      union(i, hs.length + j);
      used.add(i);
    }
  }
  // Tables with only horizontal lines: ordered by vertical position, left and right ends aligned with the previous line and close by, merged into a chain.
  const align = page.width * ALIGN_SHARE;
  const maxGap = page.height * RULED_GAP_SHARE;
  const maxHeadGap = page.height * RULED_HEAD_GAP_SHARE;
  // Row height of a grid: median spacing between adjacent horizontal lines in the grid.
  const rowGapOf = (i: number) => {
    const ys = hs
      .filter((_, k) => hOk[k] && find(k) === find(i))
      .map((g) => g.pos)
      .sort((a, b) => a - b);
    const gaps = ys
      .slice(1)
      .map((y, k) => y - ys[k]!)
      .filter((g) => g > tol);
    return gaps.length ? gaps.sort((a, b) => a - b)[gaps.length >> 1]! : Infinity;
  };
  const chains: number[][] = [];
  const order = hs.map((_, i) => i).sort((a, b) => hs[a]!.pos - hs[b]!.pos);
  for (const i of order) {
    const h = hs[i]!;
    const chain = chains.find((c) => {
      const lastIndex = c.at(-1)!;
      const last = hs[lastIndex]!;
      const gap = h.pos - last.pos;
      if (gap > maxGap || Math.abs(h.from - last.from) > align || Math.abs(h.to - last.to) > align)
        return false;
      if (c.length === 1 && !hOk[i] && !hOk[lastIndex] && gap > maxHeadGap) return false;
      // Horizontal lines separated by a large gap (more than double the spacing of the chain) with
      // another grid sandwiched in between: treated as two separate chains, not bridged across the
      // grid (e.g., fill-in horizontal lines on the right side of an invoice separated by the
      // entire product column in the middle, EU sample 001). Lines passing continuously through the
      // grid are bridged as usual (e.g., IRS Schedule B amount column lines where each cell has a
      // line, and sectional dividers are also grid lines).
      const step = c.length >= 2 ? last.pos - hs[c.at(-2)!]!.pos : null;
      if (
        !hOk[i] &&
        step !== null &&
        gap > 2 * step &&
        hs.some(
          (g, k) =>
            hOk[k] &&
            g.pos > last.pos + tol &&
            g.pos < h.pos - tol &&
            Math.min(g.to, h.to) - Math.max(g.from, h.from) > 0.5 * (h.to - h.from),
        )
      )
        return false;
      // An evenly spaced sequence of fill-in horizontal lines (with similar spacing) followed by a
      // large gap (exceeding RULED_SPLIT_STEPS times the spacing, or 10% of page height): the
      // middle contains titles or clauses, not table rows (e.g., authorization form in EU sample
      // 041: bold "erteile hiermit Vollmacht an" between two groups of fill-in lines). Tables with
      // inherently varying row heights (cells wrapped across multiple lines) are connected as
      // usual.
      if (!hOk[i] && !hOk[lastIndex] && c.length >= RULED_MIN && gap > maxHeadGap) {
        const steps = c.slice(1).map((k, n) => hs[k]!.pos - hs[c[n]!]!.pos);
        const lo = Math.min(...steps);
        // Header rows ("Libellé Nombre Débit Crédit") containing multiple text blocks or a wide row: treated as part of the table and connected downward.
        const labelsOnly = c.slice(1).every((k, n) => {
          const [y0, y1] = [hs[c[n]!]!.pos, hs[k]!.pos];
          const inside = (options.text ?? []).filter(
            (t) =>
              t.y + t.height / 2 > y0 &&
              t.y + t.height / 2 < y1 &&
              t.x + t.width > last.from &&
              t.x < last.to,
          );
          return inside.length <= 1 && inside.every((t) => t.width < 0.5 * (last.to - last.from));
        });
        if (labelsOnly && Math.max(...steps) <= RULED_EVEN * lo && gap > RULED_SPLIT_STEPS * lo)
          return false;
      }
      // Two grids (each with vertical lines) of equal width stacked vertically are not merged into one (often separated by a block of text).
      if (hOk[i] && hOk[lastIndex]) return find(i) === find(lastIndex);
      // Connecting from grid lines to non-grid lines (or vice versa): connect only when spacing is
      // similar to the previous cell (less than 2x), such as tables with vertical headers and only
      // horizontal lines below; do not connect a table with only horizontal lines located below a
      // grid separated by a title.
      if (hOk[i] !== hOk[lastIndex]) {
        // Vertical lines spanning multiple rows of the grid before stopping (more than two rows,
        // unlike headers): the grid ends here, and lines below consisting only of horizontal lines
        // belong to a separate table (intermediate titles plus whitespace might be less than two
        // rows high).
        if (hOk[lastIndex] && c.filter((k) => hOk[k] && find(k) === find(lastIndex)).length > 3)
          return false;
        const prev = c.length >= 2 ? last.pos - hs[c.at(-2)!]!.pos : null;
        // Connecting a sequence of horizontal-only lines above a grid downward: spacing must also
        // roughly match the grid's row height (header rows above). Section dividers beneath section
        // titles are separated by entire paragraphs, much larger than the grid row height, and do
        // not belong to the table.
        if (hOk[i] && !c.some((k) => hOk[k]) && prev !== null && prev > 2 * rowGapOf(i))
          return false;
        return prev !== null && gap <= 2 * prev;
      }
      return true;
    });
    if (chain) chain.push(i);
    else chains.push([i]);
  }
  // Three-line tables (top line, adjacent header line, bottom line below table body with no
  // horizontal lines inside the body) end at the bottom line: a large gap below the bottom line
  // (totals, payment rows) followed by another pair of closely spaced lines (header line and bottom
  // line of another table, e.g., hotel bill tax column, EU sample 050) represents a separate table
  // and is not connected.
  for (let n = 0; n < chains.length; n++) {
    const c = chains[n]!;
    if (c.length < 5 || c.slice(0, 5).some((k) => hOk[k])) continue;
    const [s1, s2, s3, s4] = [1, 2, 3, 4].map((k) => hs[c[k]!]!.pos - hs[c[k - 1]!]!.pos) as [
      number,
      number,
      number,
      number,
    ];
    if (s2 >= 3 * s1 && s3 > maxHeadGap && s3 >= 3 * s4 && s4 <= 2 * s1)
      chains.splice(n, 1, c.slice(0, 3), c.slice(3));
  }
  // Fill-in horizontal lines within sentences ("(DNI/NIE ______),": lines positioned on the text
  // baseline, immediately adjacent to text on the left or right within the same line, EU sample
  // 095) are not table lines. Most horizontal-only line sequences are of this type and are not
  // treated as tables (otherwise, coincidental alignment of fill-in line ends would form a tall
  // pseudo-table enclosing intervening body text).
  const inline = (h: RuleLine) =>
    (options.text ?? []).some(
      (t) =>
        h.pos >= t.y + 0.4 * t.height &&
        h.pos <= t.y + 1.3 * t.height &&
        ((t.x + t.width >= h.from - t.height && t.x + t.width <= h.from + 0.5 * t.height) ||
          (t.x >= h.to - 0.5 * t.height && t.x <= h.to + t.height)),
    );
  for (let n = chains.length - 1; n >= 0; n--) {
    const c = chains[n]!;
    if (!c.some((k) => hOk[k]) && 2 * c.filter((k) => inline(hs[k]!)).length >= c.length)
      chains.splice(n, 1);
  }
  for (const chain of chains) {
    if (chain.length < RULED_MIN) continue;
    for (const i of chain) {
      union(i, chain[0]!);
      used.add(i);
    }
  }
  // Column lines within a horizontal-only line sequence (e.g., time column vertical line in a
  // timetable without outer borders): each horizontal line intersects only that single vertical
  // line, which grid rules fail to catch. Vertical lines that span the entire range of the sequence
  // and intersect at least two horizontal lines of the sequence are considered column lines of the
  // table.
  for (const chain of chains) {
    if (chain.length < RULED_MIN) continue;
    const rules = chain.map((i) => hs[i]!);
    const l = Math.min(...rules.map((h) => h.from));
    const r = Math.max(...rules.map((h) => h.to));
    const t = Math.min(...rules.map((h) => h.pos));
    const b = Math.max(...rules.map((h) => h.pos));
    for (const [j, v] of vs.entries()) {
      if (vOk[j] || used.has(hs.length + j)) continue;
      if (v.pos < l + tol || v.pos > r - tol || v.from < t - tol || v.to > b + tol) continue;
      if (rules.filter((h) => meets(h, v)).length < 2) continue;
      union(hs.length + j, chain[0]!);
      used.add(hs.length + j);
    }
  }
  // A table nested inside another table (a small table drawn within a large form box): merged into a single table, otherwise the outer one would absorb all interior text.
  const boxOf = (members: number[]) => {
    const th = members.filter((i) => i < hs.length).map((i) => hs[i]!);
    const tv = members.filter((i) => i >= hs.length).map((i) => vs[i - hs.length]!);
    return {
      left: Math.min(...th.map((h) => h.from), ...tv.map((v) => v.pos)),
      right: Math.max(...th.map((h) => h.to), ...tv.map((v) => v.pos)),
      top: Math.min(...th.map((h) => h.pos), ...tv.map((v) => v.from)),
      bottom: Math.max(...th.map((h) => h.pos), ...tv.map((v) => v.to)),
    };
  };
  let merged = true;
  while (merged) {
    merged = false;
    const groups = new Map<number, number[]>();
    for (const i of used) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    }
    const list = [...groups.values()].map((m) => ({ root: find(m[0]!), box: boxOf(m) }));
    for (const a of list) {
      for (const b of list) {
        if (a.root === b.root || find(a.root) === find(b.root)) continue;
        const inside =
          b.box.left >= a.box.left - tol &&
          b.box.right <= a.box.right + tol &&
          b.box.top >= a.box.top - tol &&
          b.box.bottom <= a.box.bottom + tol;
        if (inside) {
          union(b.root, a.root);
          merged = true;
        }
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of used) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  const tables: TableLines[] = [];
  for (const members of groups.values()) {
    const allH = members.filter((i) => i < hs.length).map((i) => hs[i]!);
    const allV = members.filter((i) => i >= hs.length).map((i) => vs[i - hs.length]!);
    // Solid horizontal bars in the middle of a table (D-501): vertical lines terminate at their
    // upper edge, acting as the header for another table below (e.g., payroll detail table followed
    // by summary table with different columns), split into two tables at the upper edge.
    const cuts: number[] = allH
      .filter(
        (h) =>
          h.band === 'top' &&
          allV.some((v) => Math.abs(v.to - h.pos) <= tol && v.from < h.pos - tol),
      )
      .map((h) => h.pos);
    if (options.splitStacked) cuts.push(...stackedCuts(allH, allV, tol));
    cuts.sort((a, b) => a - b);
    const bounds = [-Infinity, ...cuts, Infinity];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const [lo, hi] = [bounds[k]!, bounds[k + 1]!];
      const th = allH.filter((h) => h.pos >= lo - tol && h.pos <= hi + tol);
      // When separating stacked tables, vertical lines crossing the boundary (outer left/right borders, shared vertical numbering column lines) have a segment on each side.
      const tv = options.splitStacked
        ? allV.filter((v) => v.from < hi - tol && v.to > lo + tol).map((v) => clip(v, lo, hi))
        : allV.filter((v) => (v.from + v.to) / 2 > lo && (v.from + v.to) / 2 < hi);
      if (th.length < 2) continue;
      const left = Math.min(...th.map((h) => h.from), ...tv.map((v) => v.pos));
      const right = Math.max(...th.map((h) => h.to), ...tv.map((v) => v.pos));
      const top = Math.min(...th.map((h) => h.pos), ...tv.map((v) => v.from));
      const bottom = Math.max(...th.map((h) => h.pos), ...tv.map((v) => v.to));
      const table = {
        hs: th.sort((a, b) => a.pos - b.pos),
        vs: tv.sort((a, b) => a.pos - b.pos),
        box: { x: left, y: top, width: right - left, height: bottom - top },
      };
      tables.push(
        ...((options.splitStacked && sideBySide(table, tol, options.text ?? [])) || [table]),
      );
    }
  }
  return tables.sort((a, b) => a.box.y - b.box.y);
}

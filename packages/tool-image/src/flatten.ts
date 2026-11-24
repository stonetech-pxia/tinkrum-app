import { clamp } from '@morph/core/math';
// Pure geometric computation for scanned page flattening (D-274): after four-corner rectification,
// UVDoc estimates paper curvature (45x31 deformation mesh), then refines by text lines (full-page
// deskew + row-by-row straightening), combining three steps into one triangle mesh for single-pass
// resampling via Skia's drawVertices in the app. Model inference and rendering run in-app (ONNX
// Runtime, Skia); this module handles small images and coordinates for direct testing in Node.
//
// Coordinates are strictly "pixel indices": center of pixel 0 is 0, last is width - 1 (same as
// OpenCV remap); 0.5 is added when passed to Skia (Skia's pixel center is at 0.5). Approach and
// parameters originate from 2026-10-29 experiments (dewarp-exp/REPORT.md rounds 1 & 2 in
// side-session-notes: rectification -> padding + UVDoc -> text line detection -> deskew + row
// straightening).

import type { Size } from './geometry';
import type { Point } from './quad';
import type { RgbaImage } from './scan-enhance';

/** Dark border padded around the sides before feeding into UVDoc (6% of long side): without padding, the model treats the rectified image as "paper + background" and crops inward. */
export const FLATTEN_PAD_SHARE = 0.06;
/** Padding color (RGB values are all 40). */
export const FLATTEN_PAD_GRAY = 40;
/** UVDoc input size (width 488, height 712, scaled this way regardless of whether page is landscape or portrait, matching official usage). */
export const UVDOC_INPUT: Size = { width: 488, height: 712 };
/** UVDoc output grid (width 31, height 45 points, values are source image coordinates in -1...1, four corners aligned). */
export const UVDOC_GRID: Size = { width: 31, height: 45 };

/** Refinement: pages with fewer than this number of text lines are not refined (only flattened). */
export const REFINE_MIN_LINES = 5;
/** Refinement: upper limit for full-page deskew angle (degrees); less than 0.1° is not deskewed. */
export const DESKEW_LIMIT = 0.5;
const DESKEW_MIN = 0.1;
/** Refinement: displacement does not exceed 2% of the long side. */
export const SHIFT_LIMIT_SHARE = 0.02;
/** Step size of displacement grid (also triangle mesh for final rendering): approximately 190 cells on long side (corresponds to ~24 pixels per cell at ~4500 pixels long side in experiments). */
const MESH_CELLS_LONG = 190;
/** Maximum vertices per mesh (indices are 16-bit). */
const MAX_VERTICES = 65_000;

/** Padding width (pixels, uniform on all four sides). */
export function padMargin(page: Size): number {
  return Math.floor(FLATTEN_PAD_SHARE * Math.max(page.width, page.height));
}

/** Size after padding. */
export function paddedSize(page: Size): Size {
  const m = padMargin(page);
  return { width: page.width + 2 * m, height: page.height + 2 * m };
}

/**
 * UVDoc input tensor [1, 3, 712, 488]: BGR, /255. image is RGBA, padded and scaled to 488x712.
 */
export function uvdocInput(image: RgbaImage): Float32Array {
  const { width, height, data } = image;
  if (width !== UVDOC_INPUT.width || height !== UVDOC_INPUT.height) {
    throw new Error(`UVDoc input must be ${UVDOC_INPUT.width}×${UVDOC_INPUT.height}`);
  }
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  const k = 1 / 255;
  for (let o = 0, i = 0; o < plane; o++, i += 4) {
    out[o] = data[i + 2]! * k;
    out[plane + o] = data[i + 1]! * k;
    out[2 * plane + o] = data[i]! * k;
  }
  return out;
}

/** UVDoc result: grid ([2, 45, 31]) and its corresponding page (rectified image) size. */
export interface UvdocWarp {
  grid: Float32Array;
  page: Size;
}

/**
 * Position on rectified image for a point on flattened image (page pixel index, flattened image
 * and rectified image are same size): grid bilinear interpolation aligned to four corners (same
 * as official upscaling of grid to output size), scaled to padded image, minus border width;
 * points outside paper are clamped to edge.
 */
export function uvdocSource(warp: UvdocWarp, x: number, y: number): Point {
  const { grid, page } = warp;
  const gw = UVDOC_GRID.width;
  const gh = UVDOC_GRID.height;
  const gx = clamp((x / Math.max(1, page.width - 1)) * (gw - 1), 0, gw - 1);
  const gy = clamp((y / Math.max(1, page.height - 1)) * (gh - 1), 0, gh - 1);
  const x0 = Math.min(Math.floor(gx), gw - 2);
  const y0 = Math.min(Math.floor(gy), gh - 2);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (c: number, yy: number, xx: number) => grid[c * gw * gh + yy * gw + xx]!;
  const lerp = (c: number) =>
    (at(c, y0, x0) * (1 - fx) + at(c, y0, x0 + 1) * fx) * (1 - fy) +
    (at(c, y0 + 1, x0) * (1 - fx) + at(c, y0 + 1, x0 + 1) * fx) * fy;
  const padded = paddedSize(page);
  const m = padMargin(page);
  return {
    x: clamp(((lerp(0) + 1) / 2) * (padded.width - 1) - m, 0, page.width - 1),
    y: clamp(((lerp(1) + 1) / 2) * (padded.height - 1) - m, 0, page.height - 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Text lines and table lines

/** A horizontal text line or table line: center of each column (page pixels). */
export interface PageLine {
  xs: number[];
  ys: number[];
  /** Line height (text lines); 0 for table lines. */
  thickness: number;
  /** Horizontal span (page pixels). */
  length: number;
  /** Long line (length >= 8x line height), its angle is used for full-page deskew. */
  long: boolean;
  /** Fitted line angle (degrees, y downwards, positive means sloping down-right). */
  angle: number;
}

/** Least squares polynomial (x is pre-normalized to avoid ill-conditioning with large numbers), returns evaluation function. */
export function polyfit(xs: readonly number[], ys: readonly number[], degree: number) {
  const n = xs.length;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= Math.max(1, n);
  let spread = 0;
  for (const x of xs) spread = Math.max(spread, Math.abs(x - mean));
  spread = spread || 1;
  const d = Math.max(0, Math.min(degree, n - 1));
  const m = d + 1;
  // Normal equations A c = b.
  const A = Array.from({ length: m }, () => new Float64Array(m));
  const b = new Float64Array(m);
  const pw = new Float64Array(2 * m);
  for (let i = 0; i < n; i++) {
    const t = (xs[i]! - mean) / spread;
    pw[0] = 1;
    for (let k = 1; k < 2 * m; k++) pw[k] = pw[k - 1]! * t;
    for (let r = 0; r < m; r++) {
      b[r]! += pw[r]! * ys[i]!;
      for (let c = 0; c < m; c++) A[r]![c]! += pw[r + c]!;
    }
  }
  // Gaussian elimination (partial pivoting).
  const c = new Float64Array(m);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    const p = A[col]![col]!;
    if (Math.abs(p) < 1e-12) continue;
    for (let r = col + 1; r < m; r++) {
      const f = A[r]![col]! / p;
      for (let k = col; k < m; k++) A[r]![k]! -= f * A[col]![k]!;
      b[r]! -= f * b[col]!;
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < m; k++) s -= A[r]![k]! * c[k]!;
    c[r] = Math.abs(A[r]![r]!) < 1e-12 ? 0 : s / A[r]![r]!;
  }
  const evaluate = (x: number) => {
    const t = (x - mean) / spread;
    let v = 0;
    for (let k = m - 1; k >= 0; k--) v = v * t + c[k]!;
    return v;
  };
  return { evaluate, slope: m > 1 ? c[1]! / spread : 0 };
}

const angleOf = (xs: readonly number[], ys: readonly number[]) =>
  (Math.atan(polyfit(xs, ys, 1).slope) * 180) / Math.PI;

/**
 * Find text line probability map (PP-OCR det output, probability per pixel x 255) -> horizontal
 * text blocks: pixels with > 0.3 probability grouped into 8-connected components; blocks with
 * width at least 4x height, at least 4% of image width, and average probability at least 0.6 have
 * their centers taken column-wise. Coordinates converted to page pixels.
 */
export function textLinesFromProb(
  prob: Uint8Array,
  width: number,
  height: number,
  page: Size,
): PageLine[] {
  const sx = page.width / width;
  const sy = page.height / height;
  const labels = new Int32Array(width * height);
  const stack: number[] = [];
  const lines: PageLine[] = [];
  let label = 0;
  // Pixel count and sum of y coordinates per column in a block.
  const count = new Int32Array(width);
  const sum = new Float64Array(width);
  for (let start = 0; start < prob.length; start++) {
    if (labels[start] || prob[start]! <= 76) continue;
    label++;
    labels[start] = label;
    stack.push(start);
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;
    let area = 0;
    let psum = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      area++;
      psum += prob[p]!;
      count[x]!++;
      sum[x]! += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (!labels[q] && prob[q]! > 76) {
            labels[q] = label;
            stack.push(q);
          }
        }
      }
    }
    const ww = x1 - x0 + 1;
    const hh = y1 - y0 + 1;
    const keep = ww >= 4 * hh && ww >= 0.04 * width && psum / area >= 0.6 * 255;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = x0; x <= x1; x++) {
      if (keep && count[x]! > 0) {
        xs.push(x * sx);
        ys.push((sum[x]! / count[x]!) * sy);
      }
      count[x] = 0;
      sum[x] = 0;
    }
    if (!keep) continue;
    const thick = area / ww;
    lines.push({
      xs,
      ys,
      thickness: thick * sy,
      length: ww * sx,
      long: ww >= 8 * hh,
      angle: angleOf(xs, ys),
    });
  }
  return lines;
}

/** Grayscale (same weights as OpenCV RGB -> GRAY). */
export function grayOf(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = (data[i]! * 4899 + data[i + 1]! * 9617 + data[i + 2]! * 1868 + 8192) >> 14;
  }
  return out;
}

/**
 * Long lines of tables (horizontal line width >= 25% of image width, vertical line height >= 15%
 * of image width): local mean thresholding finds dark pixels, keeping only sufficiently long
 * horizontal (vertical) continuous segments, slightly dilating them, then blocking them and
 * taking the center by column (or row for vertical lines). Parameters are based on a 2000-pixel
 * long side, scaled proportionally for other sizes. Returns page pixels; vertical line xs / ys
 * are also page coordinates (angle is the offset angle relative to the vertical direction).
 */
export function ruleLines(
  gray: Uint8Array,
  width: number,
  height: number,
  page: Size,
  vertical: boolean,
): PageLine[] {
  // Vertical lines: transposed and searched as horizontal lines.
  const w = vertical ? height : width;
  const h = vertical ? width : height;
  // Transposed into a single continuous memory block (JS on mobile lacks JIT, so per-pixel function calls are expensive).
  let g = gray;
  if (vertical) {
    g = new Uint8Array(w * h);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) g[x * w + y] = gray[y * width + x]!;
    }
  }
  const s = Math.max(width, height) / 2000;
  const half = Math.max(1, Math.round((31 * s - 1) / 2));
  // Local mean (integral image, window clipped within the image).
  const W1 = w + 1;
  const integral = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const o = (y + 1) * W1;
    const p = y * W1;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      row += g[r + x]!;
      integral[o + x + 1] = integral[p + x + 1]! + row;
    }
  }
  const xa = new Int32Array(w);
  const xb = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    xa[x] = x - half < 0 ? 0 : x - half;
    xb[x] = x + half + 1 > w ? w : x + half + 1;
  }
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = (y - half < 0 ? 0 : y - half) * W1;
    const yb = (y + half + 1 > h ? h : y + half + 1) * W1;
    const rows = yb / W1 - ya / W1;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = xa[x]!;
      const b = xb[x]!;
      const total = integral[yb + b]! - integral[ya + b]! - integral[yb + a]! + integral[ya + a]!;
      const area = rows * (b - a);
      // g <= mean - 12, multiplied by area on both sides to avoid division.
      if (g[r + x]! * area <= total - 12 * area) dark[r + x] = 1;
    }
  }
  // Keep only horizontal continuous segments of length at least L (morphological opening), then add 1 row above and below, and reach columns left and right.
  const L = Math.max(2, Math.floor(w / (vertical ? 14 : 12)));
  const reach = Math.max(1, Math.round(7 * s));
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!dark[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && dark[y * w + e]) e++;
      if (e - x >= L) {
        const a = Math.max(0, x - reach);
        const b = Math.min(w - 1, e - 1 + reach);
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
          mask.fill(1, yy * w + a, yy * w + b + 1);
        }
      }
      x = e;
    }
  }
  // Blocking (8-connected).
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const count = new Int32Array(w);
  const sum = new Float64Array(w);
  const out: PageLine[] = [];
  const maxThick = 60 * s;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      count[x]!++;
      sum[x]! += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const keep = x1 - x0 + 1 >= (vertical ? 0.15 : 0.25) * w && y1 - y0 + 1 <= maxThick;
    const along: number[] = [];
    const across: number[] = [];
    for (let x = x0; x <= x1; x++) {
      if (keep && count[x]! > 0) {
        along.push(x);
        across.push(sum[x]! / count[x]!);
      }
      count[x] = 0;
      sum[x] = 0;
    }
    if (!keep) continue;
    const angle = angleOf(along, across);
    // Scaled to page pixels.
    const kx = page.width / width;
    const ky = page.height / height;
    const xs = vertical ? across.map((v) => v * kx) : along.map((v) => v * kx);
    const ys = vertical ? along.map((v) => v * ky) : across.map((v) => v * ky);
    out.push({
      xs,
      ys,
      thickness: 0,
      length: (x1 - x0 + 1) * (vertical ? ky : kx),
      long: true,
      angle,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Refinement result: deskew angle and displacement grid (in flattened image pixels, one point per step pixels).

/** Refinement result: deskew angle and displacement grid (in flattened image pixels, one point per step pixels). */
export interface Refinement {
  /** Full-page deskew angle (degrees, positive means lines slope down to the right and need to be rotated counterclockwise back). */
  angle: number;
  step: number;
  cols: number;
  rows: number;
  /** At each grid point: output (x, y) takes pre-refinement (post-deskew) (x + dx, y + dy). */
  dx: Float32Array;
  dy: Float32Array;
  /** Number of text lines used for straightening; fewer than REFINE_MIN_LINES means no straightening (displacements are all 0) and no rotation. */
  lines: number;
}

/** Step size of the displacement grid (pixels). */
export function meshStep(page: Size): number {
  const long = Math.max(page.width, page.height);
  let step = Math.max(4, Math.round(long / MESH_CELLS_LONG));
  while ((Math.floor(page.width / step) + 2) * (Math.floor(page.height / step) + 2) > MAX_VERTICES)
    step++;
  return step;
}

/** Length-weighted median (same writing as numpy's searchsorted: the one where cumulative weight first reaches half). */
function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  let total = 0;
  for (const w of weights) total += w;
  let acc = 0;
  for (const i of order) {
    acc += weights[i]!;
    if (acc >= total / 2) return values[i]!;
  }
  return values[order.at(-1)!] ?? 0;
}

/**
 * Full-page deskew angle: angle of long text lines and table horizontal lines, using
 * length-weighted median. Fewer than 5 lines or less than 0.1 deg is not rotated; bounded within
 * +/-0.5 deg; when there is only a single vertical line, do not rotate (when correcting residual
 * shear after straightening, rotating by text would tilt this vertical line).
 */
export function deskewAngle(
  text: readonly PageLine[],
  rulesH: readonly PageLine[],
  rulesV: readonly PageLine[],
): number {
  const used = [...text.filter((l) => l.long), ...rulesH];
  if (used.length < REFINE_MIN_LINES || rulesV.length === 1) return 0;
  const a = weightedMedian(
    used.map((l) => l.angle),
    used.map((l) => l.length),
  );
  if (Math.abs(a) < DESKEW_MIN) return 0;
  return clamp(a, -DESKEW_LIMIT, DESKEW_LIMIT);
}

/** Rotate by angle degrees around the page center (positive: lines sloping down to the right become horizontal). inverse is the reverse. */
export function rotatePoint(page: Size, angle: number, p: Point, inverse = false): Point {
  if (!angle) return p;
  const a = ((inverse ? -angle : angle) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = page.width / 2;
  const cy = page.height / 2;
  const x = p.x - cx;
  const y = p.y - cy;
  return { x: c * x + s * y + cx, y: -s * x + c * y + cy };
}

function rotateLine(page: Size, angle: number, line: PageLine): PageLine {
  if (!angle) return line;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < line.xs.length; i++) {
    const p = rotatePoint(page, angle, { x: line.xs[i]!, y: line.ys[i]! });
    xs.push(p.x);
    ys.push(p.y);
  }
  return { ...line, xs, ys, angle: line.angle - angle };
}

/** Connect broken segments of the same line: horizontally adjacent, gap less than 4x line height, height difference at interface less than 0.6x line height, similar line heights. */
export function chainLines(lines: readonly PageLine[]): PageLine[] {
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  };
  const lo = (v: readonly number[]) => v.reduce((a, b) => (b < a ? b : a), Infinity);
  const hi = (v: readonly number[]) => v.reduce((a, b) => (b > a ? b : a), -Infinity);
  const sorted = lines
    .map((l) => ({ l, x: lo(l.xs) }))
    .sort((a, b) => a.x - b.x)
    .map((e) => e.l);
  const starts = sorted.map((l) => lo(l.xs));
  // Median height of the starting segment of each line (within 3x line height), counted only once.
  const heads = sorted.map((l, j) => {
    const x0 = starts[j]!;
    return median(l.ys.filter((_, k) => l.xs[k]! <= x0 + 3 * l.thickness));
  });
  const used = sorted.map(() => false);
  const out: PageLine[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let xs = [...sorted[i]!.xs];
    let ys = [...sorted[i]!.ys];
    let h = sorted[i]!.thickness;
    for (;;) {
      const xe = hi(xs);
      const ye = median(ys.filter((_, k) => xs[k]! >= xe - 3 * h));
      let best: { gap: number; j: number } | null = null;
      for (let j = 0; j < sorted.length; j++) {
        if (used[j]) continue;
        const b = sorted[j]!;
        const gap = starts[j]! - xe;
        if (gap < -h || gap > 4 * h) continue;
        const yb = heads[j]!;
        if (
          Math.abs(yb - ye) < 0.6 * Math.min(h, b.thickness) &&
          Math.abs(b.thickness - h) < 0.5 * h &&
          (!best || gap < best.gap)
        ) {
          best = { gap, j };
        }
      }
      if (!best) break;
      const b = sorted[best.j]!;
      used[best.j] = true;
      xs = xs.concat(b.xs);
      ys = ys.concat(b.ys);
      h = (h + b.thickness) / 2;
    }
    const length = hi(xs) - lo(xs);
    out.push({ ...sorted[i]!, xs, ys, thickness: h, length, angle: angleOf(xs, ys) });
  }
  return out;
}

/** Moving median (window size, edges take nearest values). */
function medianFilter(v: Float64Array, size: number): Float64Array {
  const r = size >> 1;
  const out = new Float64Array(v.length);
  const win: number[] = [];
  for (let i = 0; i < v.length; i++) {
    win.length = 0;
    for (let k = -r; k <= r; k++) win.push(v[clamp(i + k, 0, v.length - 1)]!);
    win.sort((a, b) => a - b);
    out[i] = win[r]!;
  }
  return out;
}

/** 1D Gaussian smoothing (truncated to 4 sigma, edges take nearest values). */
function gaussian1d(v: Float64Array, sigma: number): Float64Array {
  const r = Math.round(4 * sigma);
  const k = new Float64Array(2 * r + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) total += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += v[clamp(i + j, 0, v.length - 1)]! * k[j + r]!;
    out[i] = s / total;
  }
  return out;
}

/** Linear interpolation (xp increasing; endpoints take boundary values, same as numpy.interp). */
function interp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (x <= xp[0]!) return fp[0]!;
  if (x >= xp[n - 1]!) return fp[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const span = xp[hi]! - xp[lo]!;
  return span > 0 ? fp[lo]! + ((fp[hi]! - fp[lo]!) * (x - xp[lo]!)) / span : fp[lo]!;
}

/** Sample for straightening a line: its target position (height for horizontal lines), left/right range, and displacement at each location. */
interface Sample {
  target: number;
  from: number;
  to: number;
  shift: (along: number) => number;
}

/** Sample for a text line: moving median + Gaussian smoothing for long lines (>= 25% page width), 2nd-order polynomial for short lines; target is its average height. */
function lineSample(line: PageLine, pageWidth: number): Sample {
  const order = line.xs.map((_, i) => i).sort((a, b) => line.xs[a]! - line.xs[b]!);
  const x = order.map((i) => line.xs[i]!);
  const y = order.map((i) => line.ys[i]!);
  if (line.length > 0.25 * pageWidth) {
    const step = Math.max(line.thickness / 3, 1);
    const n = Math.floor((x.at(-1)! + 1 - x[0]!) / step - 1e-9) + 1;
    const xs = new Float64Array(n);
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = x[0]! + i * step;
      raw[i] = interp(xs[i]!, x, y);
    }
    const ys = gaussian1d(medianFilter(raw, 7), 6);
    let mean = 0;
    for (const v of ys) mean += v;
    mean /= n;
    return {
      target: mean,
      from: xs[0]!,
      to: xs[n - 1]!,
      shift: (v) => interp(v, xs, ys) - mean,
    };
  }
  const fit = polyfit(x, y, 2);
  let mean = 0;
  for (const v of x) mean += fit.evaluate(v);
  mean /= x.length;
  return {
    target: mean,
    from: x[0]!,
    to: x.at(-1)!,
    shift: (v) => fit.evaluate(v) - mean,
  };
}

/** Sample for a table line: 2nd-order polynomial (vertical lines are polynomials of x with respect to y). */
function ruleSample(line: PageLine, vertical: boolean): Sample {
  const along = vertical ? line.ys : line.xs;
  const across = vertical ? line.xs : line.ys;
  const fit = polyfit(along, across, 2);
  let mean = 0;
  for (const v of along) mean += fit.evaluate(v);
  mean /= along.length;
  return {
    target: mean,
    from: Math.min(...along),
    to: Math.max(...along),
    shift: (v) => fit.evaluate(v) - mean,
  };
}

/**
 * Sample -> displacement field (rows x cols, stored by row): for each column along the line
 * direction, lines covering it are sorted by target position, linearly interpolated between
 * lines, taking constants at both ends; columns without lines are interpolated from adjacent
 * left/right columns. When transposed, major is y (vertical lines).
 */
function field(
  samples: readonly Sample[],
  nMajor: number,
  nMinor: number,
  step: number,
  spread: number,
): Float32Array {
  const F = new Float64Array(nMinor * nMajor).fill(NaN);
  const filled: number[] = [];
  for (let j = 0; j < nMajor; j++) {
    const x = j * step;
    const pts: { d: number; u: number }[] = [];
    for (const s of samples) {
      if (s.from - spread <= x && x <= s.to + spread) {
        pts.push({ d: s.shift(clamp(x, s.from, s.to)), u: s.target });
      }
    }
    if (!pts.length) continue;
    pts.sort((a, b) => a.u - b.u);
    const us = pts.map((p) => p.u);
    const ds = pts.map((p) => p.d);
    for (let i = 0; i < nMinor; i++) F[i * nMajor + j] = interp(i * step, us, ds);
    filled.push(j);
  }
  const out = new Float32Array(nMinor * nMajor);
  if (!filled.length) return out;
  const vals = new Float64Array(filled.length);
  for (let i = 0; i < nMinor; i++) {
    for (let k = 0; k < filled.length; k++) vals[k] = F[i * nMajor + filled[k]!]!;
    for (let j = 0; j < nMajor; j++) out[i * nMajor + j] = interp(j, filled, vals);
  }
  return out;
}

/** 2D Gaussian smoothing (separable, edges using OpenCV's BORDER_REFLECT_101), sx / sy are sigma in both directions (grid units). */
function blur2d(f: Float32Array, cols: number, rows: number, sx: number, sy: number): Float32Array {
  const kernel = (sigma: number) => {
    const r = Math.floor((Math.round(sigma * 8 + 1) | 1) / 2);
    const k = new Float64Array(2 * r + 1);
    let t = 0;
    for (let i = -r; i <= r; i++) t += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i]! /= t;
    return { r, k };
  };
  const reflect = (i: number, n: number) => {
    if (n === 1) return 0;
    while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
    return i;
  };
  const kx = kernel(sx);
  const ky = kernel(sy);
  const tmp = new Float32Array(f.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let s = 0;
      for (let j = -kx.r; j <= kx.r; j++)
        s += f[y * cols + reflect(x + j, cols)]! * kx.k[j + kx.r]!;
      tmp[y * cols + x] = s;
    }
  }
  const out = new Float32Array(f.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let s = 0;
      for (let j = -ky.r; j <= ky.r; j++)
        s += tmp[reflect(y + j, rows) * cols + x]! * ky.k[j + ky.r]!;
      out[y * cols + x] = s;
    }
  }
  return out;
}

/**
 * Refinement plan: first calculate the full-page deskew angle, rotate lines and table lines by it
 * (without searching again), then straighten line by line: each line (>= 6% page width, broken
 * ones connected first) targets a horizontal line, vertical displacement = center line - target;
 * table horizontal lines are similar; when there are two or more vertical lines, use the same
 * method to calculate horizontal displacement to straighten vertical lines. After smoothing, the
 * displacement grid is clamped within 2% of the long side.
 */
export function planRefinement(
  page: Size,
  text: readonly PageLine[],
  rulesH: readonly PageLine[] = [],
  rulesV: readonly PageLine[] = [],
): Refinement {
  const step = meshStep(page);
  const cols = Math.floor(page.width / step) + 2;
  const rows = Math.floor(page.height / step) + 2;
  const zero = {
    angle: 0,
    step,
    cols,
    rows,
    dx: new Float32Array(cols * rows),
    dy: new Float32Array(cols * rows),
  };
  const W = page.width;
  const H = page.height;
  const counted = chainLines(text.filter((l) => l.length >= 0.02 * W)).filter(
    (l) => l.length >= 0.06 * W,
  );
  if (counted.length < REFINE_MIN_LINES) return { ...zero, lines: 0 };
  const angle = deskewAngle(text, rulesH, rulesV);
  const turn = (l: PageLine) => rotateLine(page, angle, l);
  const lines = chainLines(text.map(turn).filter((l) => l.length >= 0.02 * W)).filter(
    (l) => l.length >= 0.06 * W,
  );
  const hs = [
    ...lines.map((l) => lineSample(l, W)),
    ...rulesH.map(turn).map((l) => ruleSample(l, false)),
  ];
  let dy: Float32Array = field(hs, cols, rows, step, 0.03 * W);
  let dx: Float32Array = new Float32Array(cols * rows);
  if (rulesV.length >= 2) {
    const vs = rulesV.map(turn).map((l) => ruleSample(l, true));
    const t = field(vs, rows, cols, step, 0.03 * H);
    // Field arranged as [cols rows, rows cols] (major is y), transposed back to [rows, cols].
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) dx[j * cols + i] = t[i * rows + j]!;
  }
  dy = blur2d(dy, cols, rows, 1.5, 0.7);
  dx = blur2d(dx, cols, rows, 0.7, 1.5);
  const lim = SHIFT_LIMIT_SHARE * Math.max(W, H);
  for (let i = 0; i < dy.length; i++) {
    dy[i] = clamp(dy[i]!, -lim, lim);
    dx[i] = clamp(dx[i]!, -lim, lim);
  }
  return { angle, step, cols, rows, dx, dy, lines: lines.length };
}

/** Value of the displacement grid at a point (bilinear, edges take edge values). */
function shiftAt(r: Refinement, x: number, y: number): Point {
  const gx = clamp(x / r.step, 0, r.cols - 1);
  const gy = clamp(y / r.step, 0, r.rows - 1);
  const x0 = Math.min(Math.floor(gx), r.cols - 2);
  const y0 = Math.min(Math.floor(gy), r.rows - 2);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (f: Float32Array, yy: number, xx: number) => f[yy * r.cols + xx]!;
  const lerp = (f: Float32Array) =>
    (at(f, y0, x0) * (1 - fx) + at(f, y0, x0 + 1) * fx) * (1 - fy) +
    (at(f, y0 + 1, x0) * (1 - fx) + at(f, y0 + 1, x0 + 1) * fx) * fy;
  return { x: lerp(r.dx), y: lerp(r.dy) };
}

/**
 * Point on output image -> position on straightened image (three steps combined): first add
 * refinement displacement, then rotate back by deskew angle, and finally look up UVDoc grid.
 * Skipped when there is no UVDoc (refinement only) or no refinement (flattening only).
 */
export function flattenSource(
  page: Size,
  warp: UvdocWarp | null,
  refine: Refinement | null,
  x: number,
  y: number,
): Point {
  let p = { x, y };
  if (refine) {
    const d = shiftAt(refine, x, y);
    p = rotatePoint(page, refine.angle, { x: x + d.x, y: y + d.y }, true);
  }
  return warp
    ? uvdocSource(warp, p.x, p.y)
    : { x: clamp(p.x, 0, page.width - 1), y: clamp(p.y, 0, page.height - 1) };
}

/**
 * Point on straightened image -> position on output image (reverse of flattenSource, used to map
 * found text lines to the flattened image): fixed-point iteration, displacement field is very
 * smooth, converges in a few iterations. Used only in the step without UVDoc (refinement).
 */
export function refinedPosition(page: Size, refine: Refinement, p: Point): Point {
  const q = rotatePoint(page, refine.angle, p);
  let out = q;
  for (let i = 0; i < 6; i++) {
    const d = shiftAt(refine, out.x, out.y);
    out = { x: q.x - d.x, y: q.y - d.y };
  }
  return out;
}

/** For Skia's drawVertices: triangle vertices (positions on output image), texture coordinates (positions on source image), and indices. */
export interface WarpMesh {
  positions: Float32Array;
  texcoords: Float32Array;
  indices: Uint16Array;
}

/**
 * Triangle mesh synthesized from three steps: vertices evenly distributed on the output image
 * (one per step pixels, four sides hugging the canvas edges), texture coordinates from
 * flattenSource. out is the size to be drawn (can be smaller than the page, e.g., small image for
 * finding text lines), coordinates scaled proportionally; Skia's pixel center is at 0.5.
 */
export function flattenMesh(
  page: Size,
  warp: UvdocWarp | null,
  refine: Refinement | null,
  out: Size = page,
  step = meshStep(page),
): WarpMesh {
  const xs: number[] = [];
  for (let v = 0; v < page.width; v += step) xs.push(v);
  xs.push(page.width);
  const ys: number[] = [];
  for (let v = 0; v < page.height; v += step) ys.push(v);
  ys.push(page.height);
  const nx = xs.length;
  const ny = ys.length;
  const positions = new Float32Array(nx * ny * 2);
  const texcoords = new Float32Array(nx * ny * 2);
  const kx = out.width / page.width;
  const ky = out.height / page.height;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const o = (j * nx + i) * 2;
      positions[o] = xs[i]! * kx;
      positions[o + 1] = ys[j]! * ky;
      // Pixel indices corresponding to canvas edges (continuous coordinates): center at +0.5.
      const s = flattenSource(page, warp, refine, xs[i]! - 0.5, ys[j]! - 0.5);
      texcoords[o] = s.x + 0.5;
      texcoords[o + 1] = s.y + 0.5;
    }
  }
  const indices = new Uint16Array((nx - 1) * (ny - 1) * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices.set([a, b, c, b, d, c], k);
      k += 6;
    }
  }
  return { positions, texcoords, indices };
}

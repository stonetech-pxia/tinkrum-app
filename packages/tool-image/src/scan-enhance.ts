import { clamp } from '@morph/core/math';
// Pure algorithm for scanned document enhancement (D-266): estimates paper background, black/white
// endpoints, color vs. grayscale, and text skew angle on a downscaled analysis image. For
// black-and-white mode, it also computes the mean and standard deviation required for local
// thresholding. Full-resolution pixel-by-pixel operations are delegated to the Skia shader in the
// app; only the small image is processed here so it can be tested directly in Node. Despeckling is
// the only part run at full resolution (checking black dots only).
//
// Approach referenced from ScanTailor's illumination normalization (background -> division) and
// projection-based deskewing, FairScan's paper color whitening, and Sauvola. All implemented from
// papers and public algorithms without copying their code (both are GPL).

import type { Size } from './geometry';

/** RGBA pixels (4 bytes per pixel, matching Skia's RGBA_8888). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type ScanLook = 'auto' | 'gray' | 'bw';

/** Output type: color, grayscale, or black-and-white. */
export type ScanOutput = 'color' | 'gray' | 'bw';

export interface ScanPlan {
  output: ScanOutput;
  /** Paper background (one color per cell, RGBA). Bilinearly interpolated across the full image using cell centers; pixels are divided by this. */
  background: RgbaImage;
  /** Black and white points after background division (around 0-1): `lo` maps to black, `hi` maps to white. */
  lo: number;
  hi: number;
  /** Text line skew angle (in degrees, image coordinates y downward, positive means slanting down-right); straightening requires rotating by `-skew`. Defaults to 0 when uncertain. */
  skew: number;
  /** Local statistics for black-and-white mode (`R = mean × 255`, `G = standard deviation × 2 × 255`), null for other modes. */
  stats: RgbaImage | null;
}

/**
 * Number of cells along the long side for the background grid. At 800 for the long side of the
 * analysis image, each cell is about 8 pixels: wider than a stroke, yet able to hug shadow hard
 * edges (page and hand shadows). At 48 cells, 50-pixel-wide gray bands would remain on both sides
 * of hard edges (D-275 experiments). Cells that are too dense or entirely filled with text are
 * patched by the outlier removal below.
 */
const GRID_LONG = 96;
/** Darken midtones slightly (γ) for color and grayscale to make faint text clearer. The shader uses the same value. */
export const SCAN_MIDTONE_GAMMA = 1.3;
/**
 * Soft knee near the white point (D-275): below `1 - knee` remains unchanged after stretching,
 * while values above smoothly transition to 1 using a quadratic curve ending at `1 + knee`. The
 * paper (approx. 1.06) remains pure white, but faint text only slightly darker than the paper
 * (red text in reflections, tiny characters) is not thresholded away into white. Experiments show
 * enhanced mistyped characters decrease (screen capture page 2 -> 0), whereas hard cutoff
 * increases them (2 -> 8).
 */
export const SCAN_KNEE = 0.12;

/** Soft knee curve after stretching by black and white endpoints (`t`: 0 is black point, 1 is white point), result in 0-1. The shader uses the same formula. */
export function scanTone(t: number, knee = SCAN_KNEE): number {
  const a = 1 - knee;
  const u = Math.min(t, 1 + knee);
  const v = u < a ? u : u - ((u - a) * (u - a)) / (4 * knee);
  return clamp(v, 0, 1);
}
/** Take the top 10% brightest pixels in each cell as paper (text is dark and generally occupies only a small fraction). */
const PAPER_SHARE = 0.1;
/** Cells darker than surrounding paper by more than half are treated as images or large dark blocks and filled using surrounding paper colors; less dark ones are treated as shadows and whitened as usual. */
const OUTLIER_RATIO = 0.5;
/** Background floor limit (relative to full-page paper color) to prevent division from amplifying dark regions into white. */
const BACKGROUND_FLOOR = 0.3;

/** Color determination: if the proportion of blocks with sufficiently rich color (`max - min`) exceeds this, it is classified as color (FairScan uses 0.03%, here calculated on 4×4 blocks and slightly relaxed). */
const COLOR_CHROMA = 0.15;
const COLOR_SHARE = 0.001;

/** Deskewing: searches only within ±7°, using a 1° coarse search first, followed by a 0.1° fine search within 1° of the best angle. Skews less than 0.15° are not rotated. */
const SKEW_RANGE = 7;
const SKEW_COARSE = 1;
const SKEW_FINE = 0.1;
const SKEW_MIN = 0.15;
/** Cell width in pixels for counting dark points: at 7°, each cell differs by only 1 pixel at both ends. */
const SKEW_CELL = 8;
/** Confidence threshold: the score of the best angle must be at least this many times the average score of all angles to be considered confident (does not rotate when there are images without aligned text lines). */
const SKEW_CONFIDENCE = 1.6;

/** Sauvola: larger `k` makes it easier to classify as white; window size is proportional to the long side of the statistics image. */
export const SAUVOLA_K = 0.3;
const SAUVOLA_WINDOW_SHARE = 1 / 24;

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Pixel range `[start, end)` covered by the `i`-th cell: cells are evenly distributed, matching shader sampling at cell centers. */
function cellRange(i: number, cells: number, size: number): [number, number] {
  return [Math.floor((i * size) / cells), Math.floor(((i + 1) * size) / cells)];
}

export function gridSize(size: Size, long = GRID_LONG): Size {
  const k = long / Math.max(size.width, size.height);
  return {
    width: Math.max(1, Math.round(size.width * k)),
    height: Math.max(1, Math.round(size.height * k)),
  };
}

/** Bilinear sampling on the grid image using 0-1 coordinates (clamped to edge values outside), identical to Skia's linear sampling + clamp. */
export function sampleGrid(grid: RgbaImage, u: number, v: number, out: Float32Array): void {
  const gx = clamp(u * grid.width - 0.5, 0, grid.width - 1);
  const gy = clamp(v * grid.height - 0.5, 0, grid.height - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, grid.width - 1);
  const y1 = Math.min(y0 + 1, grid.height - 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const d = grid.data;
  const w = grid.width;
  for (let c = 0; c < 3; c++) {
    const a = d[(y0 * w + x0) * 4 + c]!;
    const b = d[(y0 * w + x1) * 4 + c]!;
    const e = d[(y1 * w + x0) * 4 + c]!;
    const f = d[(y1 * w + x1) * 4 + c]!;
    out[c] = ((a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy) / 255;
  }
}

/** Weighted box blur on small cells (cells with weight 0 are excluded, effectively filled using surroundings). */
function maskedBlur(
  values: Float32Array,
  weights: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let wsum = 0;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          const w = weights[yy * width + xx]!;
          sum += values[yy * width + xx]! * w;
          wsum += w;
        }
      }
      out[y * width + x] = wsum > 0 ? sum / wsum : NaN;
    }
  }
  return out;
}

/**
 * Weighted median on small cells (considering only cells with non-zero weight; values are 0-255
 * luminance, rounded and processed using a sliding histogram adding/removing only one column per
 * step, remaining fast even on Hermes without JIT).
 */
function maskedMedian(
  values: Float32Array,
  weights: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(width * height);
  const hist = new Int32Array(256);
  const bin = (j: number) => Math.min(255, Math.max(0, Math.round(values[j]!)));
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - radius);
    const yb = Math.min(height - 1, y + radius);
    hist.fill(0);
    let count = 0;
    // Sliding median (Huang): remembers the current candidate value `m` and the count of values
    // smaller than it (`below`), making minor adjustments each time the window shifts instead of
    // counting from 0 to the median at every cell (crucial for performance when cell count is
    // high). Results are identical to counting from scratch.
    let m = 0;
    let below = 0;
    const column = (xx: number, d: number) => {
      for (let yy = ya; yy <= yb; yy++) {
        const j = yy * width + xx;
        if (weights[j]! > 0) {
          const v = bin(j);
          hist[v]! += d;
          count += d;
          if (v < m) below += d;
        }
      }
    };
    for (let xx = 0; xx <= Math.min(width - 1, radius); xx++) column(xx, 1);
    for (let x = 0; x < width; x++) {
      if (x > 0) {
        if (x - radius - 1 >= 0) column(x - radius - 1, -1);
        if (x + radius < width) column(x + radius, 1);
      }
      if (count === 0) {
        out[y * width + x] = NaN;
        continue;
      }
      const need = (count >> 1) + 1;
      // The median is the value where the cumulative count first reaches `need` (up to 255).
      while (m > 0 && below >= need) {
        m--;
        below -= hist[m]!;
      }
      while (m < 255 && below + hist[m]! < need) {
        below += hist[m]!;
        m++;
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

/**
 * Estimates paper background: for each cell, takes the average color of the brightest 10% of
 * pixels, filters out cells much darker than their surroundings (dense text, images, dark
 * blocks), and finally smooths. Channels are estimated separately, so after division, the paper
 * becomes neutral white (incidentally correcting white balance).
 */
export function estimateBackground(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  const grid = gridSize(image);
  const gw = grid.width;
  const gh = grid.height;
  const n = gw * gh;
  const cell = [new Float32Array(n), new Float32Array(n), new Float32Array(n)] as const;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  // Luminance of each pixel computed once (integer, Rec.601 weights × 256).
  const y8 = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    y8[p] = (77 * data[p * 4]! + 150 * data[p * 4 + 1]! + 29 * data[p * 4 + 2]! + 128) >> 8;
  }
  for (let gy = 0; gy < gh; gy++) {
    const [y0, y1] = cellRange(gy, gh, height);
    for (let gx = 0; gx < gw; gx++) {
      const [x0, x1] = cellRange(gx, gw, width);
      hist.fill(0);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) hist[y8[y * width + x]!]!++;
        count += x1 - x0;
      }
      const g = gy * gw + gx;
      if (count === 0) continue;
      // Threshold for the top 10% brightest pixels.
      let need = Math.max(1, Math.round(count * PAPER_SHARE));
      let cut = 255;
      for (; cut > 0; cut--) {
        need -= hist[cut]!;
        if (need <= 0) break;
      }
      let r = 0;
      let gr = 0;
      let b = 0;
      let m = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (y8[y * width + x]! >= cut) {
            const i = (y * width + x) * 4;
            r += data[i]!;
            gr += data[i + 1]!;
            b += data[i + 2]!;
            m++;
          }
        }
      }
      cell[0][g] = r / m;
      cell[1][g] = gr / m;
      cell[2][g] = b / m;
      lum[g] = luma(r / m, gr / m, b / m);
    }
  }

  // Removes cells much darker than surrounding paper (dense text, images, dark blocks) by comparing
  // against a wide-range median (using median so reference values are not pulled up when
  // reflections are nearby, preventing paper around reflections from being falsely deleted, D-266),
  // iterating until stable.
  const weights = new Float32Array(n).fill(1);
  const wide = Math.max(2, Math.round(Math.max(gw, gh) / 4));
  // Large images are stripped ring by ring from the edges inward, requiring a few extra iterations (cells are few, so it runs very quickly).
  for (let pass = 0; pass < 12; pass++) {
    const ref = maskedMedian(lum, weights, gw, gh, wide);
    let changed = false;
    for (let g = 0; g < n; g++) {
      const ok = !(lum[g]! < OUTLIER_RATIO * ref[g]!);
      if ((weights[g] === 1) !== ok) changed = true;
      weights[g] = ok ? 1 : 0;
    }
    if (!changed) break;
  }
  if (!weights.some((w) => w > 0)) weights.fill(1);

  // Full-page paper color: the median luminance of valid cells, used to set the lower bound.
  const valid = Array.from(lum).filter((_, g) => weights[g]! > 0);
  valid.sort((a, b) => a - b);
  const paper = valid[Math.floor(valid.length / 2)] ?? 255;

  const out = new Uint8Array(n * 4);
  const smooth = cell.map((ch) => {
    // Fills invalid cells using valid ones via `maskedBlur`, followed by slight overall smoothing.
    const filled = maskedBlur(ch, weights, gw, gh, 1);
    // A wider patching range is needed only when the entire surrounding ring is invalid (the center of a large image).
    let wider: Float32Array | null = null;
    for (let g = 0; g < n; g++) {
      if (weights[g]! > 0) filled[g] = ch[g]!;
      else if (Number.isNaN(filled[g]!)) {
        wider ??= maskedBlur(ch, weights, gw, gh, wide);
        filled[g] = wider[g]!;
      }
      if (Number.isNaN(filled[g]!)) filled[g] = paper;
    }
    return maskedBlur(filled, new Float32Array(n).fill(1), gw, gh, 1);
  });
  const floor = Math.max(10, paper * BACKGROUND_FLOOR);
  for (let g = 0; g < n; g++) {
    for (let c = 0; c < 3; c++) out[g * 4 + c] = Math.round(clamp(smooth[c]![g]!, floor, 255));
    out[g * 4 + 3] = 255;
  }
  return { width: gw, height: gh, data: out };
}

/** Color after dividing by background (around 0-1, paper is approx. 1). Background is bilinearly interpolated using cell centers, just like `sampleGrid`, but pre-calculated row by row. */
export function normalizeByBackground(image: RgbaImage, background: RgbaImage): Float32Array {
  const { width, height, data } = image;
  const gw = background.width;
  const gh = background.height;
  const bd = background.data;
  const out = new Float32Array(width * height * 3);
  // Column position of each pixel within the cells.
  const cx0 = new Int32Array(width);
  const cx1 = new Int32Array(width);
  const cfx = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const gx = clamp(((x + 0.5) / width) * gw - 0.5, 0, gw - 1);
    cx0[x] = Math.floor(gx);
    cx1[x] = Math.min(cx0[x]! + 1, gw - 1);
    cfx[x] = gx - cx0[x]!;
  }
  // Interpolated cell color of the current row in the vertical direction.
  const row = new Float32Array(gw * 3);
  for (let y = 0; y < height; y++) {
    const gy = clamp(((y + 0.5) / height) * gh - 0.5, 0, gh - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(y0 + 1, gh - 1);
    const fy = gy - y0;
    for (let gx = 0; gx < gw; gx++) {
      for (let c = 0; c < 3; c++) {
        row[gx * 3 + c] =
          (bd[(y0 * gw + gx) * 4 + c]! * (1 - fy) + bd[(y1 * gw + gx) * 4 + c]! * fy) / 255;
      }
    }
    for (let x = 0; x < width; x++) {
      const a = cx0[x]! * 3;
      const b = cx1[x]! * 3;
      const f = cfx[x]!;
      const i = (y * width + x) * 4;
      const o = (y * width + x) * 3;
      out[o] = data[i]! / 255 / (row[a]! + (row[b]! - row[a]!) * f);
      out[o + 1] = data[i + 1]! / 255 / (row[a + 1]! + (row[b + 1]! - row[a + 1]!) * f);
      out[o + 2] = data[i + 2]! / 255 / (row[a + 2]! + (row[b + 2]! - row[a + 2]!) * f);
    }
  }
  return out;
}

const LEVEL_BINS = 512;
const LEVEL_MAX = 2;

/**
 * Black and white endpoints: white point takes a slightly lower value than the paper peak
 * (luminance histogram peak above 0.6) so paper noise directly becomes white; black point takes
 * the darkest 0.5%, capped at half the white point to prevent blank pages from being stretched
 * into patches of noise.
 */
export function levelsOf(normalized: Float32Array): { lo: number; hi: number } {
  const hist = new Uint32Array(LEVEL_BINS);
  const pixels = normalized.length / 3;
  for (let p = 0; p < pixels; p++) {
    const y = luma(normalized[p * 3]!, normalized[p * 3 + 1]!, normalized[p * 3 + 2]!);
    hist[Math.min(LEVEL_BINS - 1, Math.floor((y / LEVEL_MAX) * LEVEL_BINS))]!++;
  }
  const binOf = (v: number) => Math.floor((v / LEVEL_MAX) * LEVEL_BINS);
  let peak = binOf(0.6);
  for (let b = peak; b < LEVEL_BINS; b++) if (hist[b]! > hist[peak]!) peak = b;
  const paper = ((peak + 0.5) / LEVEL_BINS) * LEVEL_MAX;
  const hi = clamp(paper * 0.94, 0.5, 1.2);
  let need = pixels * 0.005;
  let b = 0;
  for (; b < LEVEL_BINS - 1; b++) {
    need -= hist[b]!;
    if (need <= 0) break;
  }
  const lo = clamp(((b + 0.5) / LEVEL_BINS) * LEVEL_MAX, 0, hi * 0.5);
  return { lo, hi };
}

/** Luminance (0-1) after stretching by black and white endpoints. */
export function leveledLuma(normalized: Float32Array, lo: number, hi: number): Float32Array {
  const pixels = normalized.length / 3;
  const out = new Float32Array(pixels);
  const span = hi - lo;
  for (let p = 0; p < pixels; p++) {
    const y = luma(normalized[p * 3]!, normalized[p * 3 + 1]!, normalized[p * 3 + 2]!);
    out[p] = clamp((y - lo) / span, 0, 1);
  }
  return out;
}

/**
 * Ink darkness for black-and-white mode: the darkest of the three channels (0-1) after
 * stretching. Red or blue text has one very dark channel, which would be treated as light and
 * disappear during binarization if calculated by luminance; calculating by the darkest channel
 * treats it just like black text. White paper has bright channels across all three and remains
 * unaffected.
 */
export function leveledInk(normalized: Float32Array, lo: number, hi: number): Float32Array {
  const pixels = normalized.length / 3;
  const out = new Float32Array(pixels);
  const span = hi - lo;
  for (let p = 0; p < pixels; p++) {
    const m = Math.min(normalized[p * 3]!, normalized[p * 3 + 1]!, normalized[p * 3 + 2]!);
    out[p] = clamp((m - lo) / span, 0, 1);
  }
  return out;
}

/**
 * Color vs. grayscale: after background division (where paper is already neutral white), averages
 * are taken over 4×4 blocks (suppressing noise and moiré patterns). If blocks that are neither
 * too dark nor too bright and have sufficient color saturation account for more than 0.1%, color
 * is retained.
 */
export function looksColored(
  normalized: Float32Array,
  width: number,
  height: number,
  lo: number,
  hi: number,
): boolean {
  const B = 4;
  const span = hi - lo;
  let colored = 0;
  let blocks = 0;
  for (let by = 0; by + B <= height; by += B) {
    for (let bx = 0; bx + B <= width; bx += B) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const o = (y * width + x) * 3;
          r += normalized[o]!;
          g += normalized[o + 1]!;
          b += normalized[o + 2]!;
        }
      }
      const k = 1 / (B * B);
      r = clamp((r * k - lo) / span, 0, 1);
      g = clamp((g * k - lo) / span, 0, 1);
      b = clamp((b * k - lo) / span, 0, 1);
      blocks++;
      const y = luma(r, g, b);
      if (y < 0.12 || y > 0.9) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > COLOR_CHROMA) colored++;
    }
  }
  return blocks > 0 && colored / blocks > COLOR_SHARE;
}

/**
 * Finds text skew using projection methods (ScanTailor approach): shears dark points by candidate
 * angles and counts them row by row; the difference in counts between adjacent rows is maximized
 * when text lines are aligned. Returns 0 if uncertain or no rotation is needed.
 */
export function findSkew(lumaImage: Float32Array, width: number, height: number): number {
  let dark = 0;
  for (let p = 0; p < lumaImage.length; p++) if (lumaImage[p]! < 0.5) dark++;
  // Skips rotation if text is too sparse (or almost entirely black).
  if (dark < 200 || dark > lumaImage.length * 0.5) return 0;
  // Dark points are not sampled individually; instead, they are counted in buckets of `SKEW_CELL`
  // pixels horizontally per row: dark point counts per cell are projected at cell centers. Avoids
  // sampling every few points in scan order, which could form slanted grid patterns from solid dark
  // blocks (like dark header bars) and falsely estimate skew by several degrees. Random sampling,
  // on the other hand, adds noise to each row that overrides text lines.
  const cols = Math.ceil(width / SKEW_CELL);
  const counts = new Float64Array(height * cols);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (lumaImage[y * width + x]! < 0.5) counts[y * cols + Math.floor(x / SKEW_CELL)]!++;
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (let y = 0; y < height; y++)
    for (let c = 0; c < cols; c++) {
      const w = counts[y * cols + c]!;
      if (!w) continue;
      const left = c * SKEW_CELL;
      xs.push(left + (Math.min(width, left + SKEW_CELL) - left) / 2 - width / 2);
      ys.push(y);
      ws.push(w);
    }
  const pad = Math.ceil((width / 2) * Math.tan((SKEW_RANGE * Math.PI) / 180)) + 2;
  const rows = new Float64Array(height + pad * 2);
  const score = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    rows.fill(0);
    for (let i = 0; i < xs.length; i++) rows[Math.round(ys[i]! - xs[i]! * t) + pad]! += ws[i]!;
    let s = 0;
    for (let r = 1; r < rows.length; r++) {
      const d = rows[r]! - rows[r - 1]!;
      s += d * d;
    }
    return s;
  };
  let best = 0;
  let bestScore = -1;
  let total = 0;
  let tried = 0;
  for (let deg = -SKEW_RANGE; deg <= SKEW_RANGE + 1e-9; deg += SKEW_COARSE) {
    const s = score(deg);
    total += s;
    tried++;
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  if (bestScore < (total / tried) * SKEW_CONFIDENCE) return 0;
  const center = best;
  for (let deg = center - SKEW_COARSE; deg <= center + SKEW_COARSE + 1e-9; deg += SKEW_FINE) {
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      best = deg;
    }
  }
  best = Math.round(best * 100) / 100;
  return Math.abs(best) < SKEW_MIN ? 0 : best;
}

/** Canvas size large enough to hold the entire image after rotating by `deg` degrees (without cutting off corners). */
export function rotatedSize(size: Size, deg: number): Size {
  const a = Math.abs((deg * Math.PI) / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    width: Math.ceil(size.width * c + size.height * s - 1e-6),
    height: Math.ceil(size.width * s + size.height * c - 1e-6),
  };
}

/**
 * Local statistics for black-and-white mode: `leveledInk` is first downscaled 2×2, then integral
 * images are used to compute window mean and standard deviation (for Sauvola). With a large
 * window (approx. 1/24 of the long side), statistics are interpolated across the full image with
 * negligible error.
 */
export function localStats(lumaImage: Float32Array, width: number, height: number): RgbaImage {
  const sw = Math.max(1, Math.floor(width / 2));
  const sh = Math.max(1, Math.floor(height / 2));
  const small = new Float64Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const x0 = Math.min(width - 1, x * 2);
      const y0 = Math.min(height - 1, y * 2);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      small[y * sw + x] =
        (lumaImage[y0 * width + x0]! +
          lumaImage[y0 * width + x1]! +
          lumaImage[y1 * width + x0]! +
          lumaImage[y1 * width + x1]!) /
        4;
    }
  }
  const W = sw + 1;
  const sum = new Float64Array(W * (sh + 1));
  const sq = new Float64Array(W * (sh + 1));
  for (let y = 0; y < sh; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < sw; x++) {
      const v = small[y * sw + x]!;
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1]! + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1]! + rq;
    }
  }
  const half = Math.max(3, Math.round((Math.max(sw, sh) * SAUVOLA_WINDOW_SHARE) / 2));
  const out = new Uint8Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const ya = Math.max(0, y - half);
    const yb = Math.min(sh, y + half + 1);
    for (let x = 0; x < sw; x++) {
      const xa = Math.max(0, x - half);
      const xb = Math.min(sw, x + half + 1);
      const area = (yb - ya) * (xb - xa);
      const s = sum[yb * W + xb]! - sum[ya * W + xb]! - sum[yb * W + xa]! + sum[ya * W + xa]!;
      const q = sq[yb * W + xb]! - sq[ya * W + xb]! - sq[yb * W + xa]! + sq[ya * W + xa]!;
      const mean = s / area;
      const sd = Math.sqrt(Math.max(0, q / area - mean * mean));
      const o = (y * sw + x) * 4;
      out[o] = Math.round(clamp(mean, 0, 1) * 255);
      out[o + 1] = Math.round(clamp(sd * 2, 0, 1) * 255);
      out[o + 3] = 255;
    }
  }
  return { width: sw, height: sh, data: out };
}

/** Sauvola threshold (ink darkness values are 0-1, R = 0.5): values below this are black. The shader uses the same formula. */
export function sauvolaThreshold(mean: number, sd: number, k = SAUVOLA_K): number {
  return mean * (1 + k * (sd / 0.5 - 1));
}

/** Computes full-page enhancement parameters from the downscaled analysis image. */
export function planScanEnhance(image: RgbaImage, look: ScanLook): ScanPlan {
  const background = estimateBackground(image);
  const normalized = normalizeByBackground(image, background);
  const { lo, hi } = levelsOf(normalized);
  const leveled = leveledLuma(normalized, lo, hi);
  const skew = findSkew(leveled, image.width, image.height);
  const output: ScanOutput =
    look === 'bw'
      ? 'bw'
      : look === 'gray'
        ? 'gray'
        : looksColored(normalized, image.width, image.height, lo, hi)
          ? 'color'
          : 'gray';
  const stats =
    output === 'bw' ? localStats(leveledInk(normalized, lo, hi), image.width, image.height) : null;
  return { output, background, lo, hi, skew, stats };
}

/**
 * Despeckling for black-and-white pages (full resolution, RGBA, `R < 128` considered black):
 * small 8-connected black blobs (width and height both not exceeding `maxSide`) are painted white
 * if no other large blobs (text) exist within `reach` pixels; small dots close to text (dot on
 * 'i', periods) are preserved. Returns the count of removed items.
 */
export function despeckle(
  image: RgbaImage,
  { maxSide, reach }: { maxSide: number; reach: number },
): number {
  const { width, height, data } = image;
  const labels = new Int32Array(width * height);
  // Disjoint-set data structure (index 0 unused).
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (data[p * 4]! >= 128) continue;
      let label = 0;
      const look = (q: number) => {
        const l = labels[q]!;
        if (l === 0) return;
        if (label === 0) label = l;
        else if (l !== label) union(label, l);
      };
      if (x > 0) look(p - 1);
      if (y > 0) {
        if (x > 0) look(p - width - 1);
        look(p - width);
        if (x < width - 1) look(p - width + 1);
      }
      if (label === 0) {
        if (next >= parent.length) {
          const grown = new Int32Array(parent.length * 2);
          grown.set(parent);
          parent = grown;
        }
        parent[next] = next;
        label = next++;
      }
      labels[p] = label;
    }
  }
  const count = next;
  const minX = new Int32Array(count).fill(width);
  const minY = new Int32Array(count).fill(height);
  const maxX = new Int32Array(count).fill(-1);
  const maxY = new Int32Array(count).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (labels[p] === 0) continue;
      const r = find(labels[p]!);
      labels[p] = r;
      if (x < minX[r]!) minX[r] = x;
      if (x > maxX[r]!) maxX[r] = x;
      if (y < minY[r]!) minY[r] = y;
      if (y > maxY[r]!) maxY[r] = y;
    }
  }
  const small = (r: number) => maxX[r]! - minX[r]! < maxSide && maxY[r]! - minY[r]! < maxSide;
  let removed = 0;
  for (let r = 1; r < count; r++) {
    if (parent[r] !== r || maxX[r]! < 0 || !small(r)) continue;
    const x0 = Math.max(0, minX[r]! - reach);
    const x1 = Math.min(width - 1, maxX[r]! + reach);
    const y0 = Math.max(0, minY[r]! - reach);
    const y1 = Math.min(height - 1, maxY[r]! + reach);
    let near = false;
    for (let y = y0; y <= y1 && !near; y++) {
      for (let x = x0; x <= x1; x++) {
        const l = labels[y * width + x]!;
        if (l !== 0 && l !== r && !small(l)) {
          near = true;
          break;
        }
      }
    }
    if (near) continue;
    for (let y = minY[r]!; y <= maxY[r]!; y++) {
      for (let x = minX[r]!; x <= maxX[r]!; x++) {
        const p = y * width + x;
        if (labels[p] === r) {
          data[p * 4] = 255;
          data[p * 4 + 1] = 255;
          data[p * 4 + 2] = 255;
        }
      }
    }
    removed++;
  }
  return removed;
}

/**
 * Boxes recognized on the pre-enhancement image mapped to the enhanced image (D-267): enhancement
 * first downscales to `base`, centers and rotates by `-skew` degrees into the canvas (matching
 * Skia's drawing order). Since the rotation angle is very small, boxes only shift their center
 * while keeping width and height unchanged.
 */
export function boxesToEnhanced<T extends { x: number; y: number; width: number; height: number }>(
  boxes: readonly T[],
  from: Size,
  base: Size,
  skew: number,
  canvas: Size,
): T[] {
  const kx = base.width / from.width;
  const ky = base.height / from.height;
  const a = (-skew * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return boxes.map((box) => {
    const w = box.width * kx;
    const h = box.height * ky;
    const cx = (box.x + box.width / 2) * kx - base.width / 2;
    const cy = (box.y + box.height / 2) * ky - base.height / 2;
    const x = cx * cos - cy * sin + canvas.width / 2;
    const y = cx * sin + cy * cos + canvas.height / 2;
    return { ...box, x: x - w / 2, y: y - h / 2, width: w, height: h };
  });
}

// Layout calculations for stitching, grids, and watermarks. The app renders using Skia based on these rectangles, while this only computes positions.

import type { Rect, Size } from './geometry';

// ---- Long image stitching ----

export interface StitchOptions {
  direction: 'vertical' | 'horizontal';
  gapPx: number;
  /** Maximum side length for single-output (GPU texture limit). */
  maxSide?: number;
  /** Uniform width for vertical stitching; defaults to the width of the narrowest image (no upscaling). */
  outputWidth?: number;
  /** Uniform height for horizontal stitching; defaults to the height of the shortest image. */
  outputHeight?: number;
}

export interface StitchPlacement extends Rect {
  /** Input image index. */
  index: number;
  /** Image split during vertical stitching: starting row and row count on the source image. */
  srcY?: number;
  srcHeight?: number;
  /** Image split during horizontal stitching: starting column and column count on the source image. */
  srcX?: number;
  srcWidth?: number;
}

export interface StitchSegment {
  width: number;
  height: number;
  placements: StitchPlacement[];
}

/**
 * Arrange in sequence after unifying width (vertical stitching) or height (horizontal stitching);
 * split into multiple outputs when the total length exceeds maxSide. When a single image exceeds
 * maxSide, split it across segments, using src sub-regions to describe which part of the source
 * image each segment takes.
 */
export function layoutStitch(
  sizes: readonly Size[],
  options: StitchOptions,
): { segments: StitchSegment[] } {
  const { direction, gapPx, maxSide = 16384 } = options;
  const vertical = direction === 'vertical';
  const across = (s: Size) => (vertical ? s.width : s.height);
  const along = (s: Size) => (vertical ? s.height : s.width);
  if (sizes.length === 0) return { segments: [] };
  const wanted = vertical ? options.outputWidth : options.outputHeight;
  const cross = Math.min(maxSide, Math.round(wanted ?? Math.min(...sizes.map(across))));
  if (!(cross >= 1)) throw new RangeError('outputSize');

  const segments: StitchSegment[] = [];
  let placements: StitchPlacement[] = [];
  let length = 0;
  const close = () => {
    segments.push(
      vertical
        ? { width: cross, height: length, placements }
        : { width: length, height: cross, placements },
    );
    placements = [];
    length = 0;
  };

  sizes.forEach((size, index) => {
    const src = along(size);
    const total = Math.max(1, Math.round((src * cross) / across(size)));
    let done = 0;
    while (done < total) {
      const start = placements.length > 0 ? length + gapPx : 0;
      const rest = total - done;
      if (rest > maxSide - start && placements.length > 0) {
        close(); // Switch to a new segment if it does not fit, avoiding splitting images whenever possible
        continue;
      }
      const piece = Math.min(rest, maxSide - start);
      const placement: StitchPlacement = vertical
        ? { index, x: 0, y: start, width: cross, height: piece }
        : { index, x: start, y: 0, width: piece, height: cross };
      if (piece < total) {
        const from = Math.round((done * src) / total);
        const to = Math.round(((done + piece) * src) / total);
        if (vertical) {
          placement.srcY = from;
          placement.srcHeight = to - from;
        } else {
          placement.srcX = from;
          placement.srcWidth = to - from;
        }
      }
      placements.push(placement);
      length = start + piece;
      done += piece;
      if (done < total) close();
    }
  });
  if (placements.length > 0) close();
  return { segments };
}

// ---- Grid collage ----

export interface GridOptions {
  columns: number;
  /** Cell width/height ratio. */
  cellAspect: number;
  gapPx: number;
  paddingPx: number;
  outputWidth: number;
}

/** Arrange grid by column count with uniform cell sizes, distributing the remaining rounded pixels evenly to both sides. */
export function layoutGrid(
  count: number,
  options: GridOptions,
): { width: number; height: number; cells: Rect[] } {
  const { columns, cellAspect, gapPx, paddingPx, outputWidth } = options;
  if (!(columns >= 1) || !(cellAspect > 0)) throw new RangeError('grid');
  const cellW = Math.floor((outputWidth - 2 * paddingPx - (columns - 1) * gapPx) / columns);
  if (cellW < 1) throw new RangeError('outputWidth');
  const cellH = Math.max(1, Math.round(cellW / cellAspect));
  const rows = Math.ceil(count / columns);
  const left = Math.floor((outputWidth - (columns * cellW + (columns - 1) * gapPx)) / 2);
  const cells: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const c = i % columns;
    const r = Math.floor(i / columns);
    cells.push({
      x: left + c * (cellW + gapPx),
      y: paddingPx + r * (cellH + gapPx),
      width: cellW,
      height: cellH,
    });
  }
  const height = 2 * paddingPx + rows * cellH + Math.max(0, rows - 1) * gapPx;
  return { width: outputWidth, height, cells };
}

// ---- Watermark ----

export type WatermarkPosition = 'bottomRight' | 'bottomLeft' | 'topRight' | 'topLeft' | 'center';

export interface WatermarkOptions {
  mode: 'corner' | 'tile';
  corner: WatermarkPosition;
  /** Watermark width as a proportion of the image's short side. */
  relativeSize: number;
  /** Width/height ratio of the watermark (rendered text image or logo). */
  markAspect: number;
  /** Rotation angle around respective centers; defaults to 0° for corners and -30° for tiling. */
  angleDeg?: number;
}

export interface WatermarkLayout {
  /** Watermark position when unrotated; the app draws after rotating around the rectangle center by angleDeg, cropping any overflow. */
  rects: Rect[];
  angleDeg: number;
}

/** Place a single watermark in corner mode; tile across the entire image with staggered offsets in tiled mode (including corners that become exposed after rotation). */
export function layoutWatermark(size: Size, options: WatermarkOptions): WatermarkLayout {
  const { width, height } = size;
  const { mode, corner, relativeSize, markAspect } = options;
  if (!(relativeSize > 0) || !(markAspect > 0)) throw new RangeError('watermark');
  const angleDeg = options.angleDeg ?? (mode === 'tile' ? -30 : 0);
  const short = Math.min(width, height);
  const margin = Math.round(short * 0.03);
  // Watermark must not exceed the image bounds minus margins.
  let markW = Math.min(
    relativeSize * short,
    width - 2 * margin,
    (height - 2 * margin) * markAspect,
  );
  markW = Math.max(1, Math.round(markW));
  const markH = Math.max(1, Math.round(markW / markAspect));

  if (mode === 'corner') {
    const xs = {
      left: margin,
      right: width - margin - markW,
      mid: Math.round((width - markW) / 2),
    };
    const ys = {
      top: margin,
      bottom: height - margin - markH,
      mid: Math.round((height - markH) / 2),
    };
    const [x, y] = {
      topLeft: [xs.left, ys.top] as const,
      topRight: [xs.right, ys.top] as const,
      bottomLeft: [xs.left, ys.bottom] as const,
      bottomRight: [xs.right, ys.bottom] as const,
      center: [xs.mid, ys.mid] as const,
    }[corner];
    return { rects: [{ x, y, width: markW, height: markH }], angleDeg };
  }

  // Use the rotated bounding box to calculate step size, ensuring adjacent watermarks do not overlap; odd rows are staggered by half a cell.
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const boxW = markW * cos + markH * sin;
  const boxH = markW * sin + markH * cos;
  const gap = Math.max(1, markH * 1.5);
  const stepX = boxW + gap;
  const stepY = boxH + gap;
  const cols = Math.ceil((width / 2 + boxW) / stepX);
  const rows = Math.ceil((height / 2 + boxH) / stepY);
  const rects: Rect[] = [];
  for (let j = -rows; j <= rows; j++) {
    for (let i = -cols - 1; i <= cols; i++) {
      const cx = width / 2 + i * stepX + (Math.abs(j) % 2 === 1 ? stepX / 2 : 0);
      const cy = height / 2 + j * stepY;
      // Keep only watermarks whose rotated bounding box intersects the image.
      if (cx + boxW / 2 < 0 || cx - boxW / 2 > width) continue;
      if (cy + boxH / 2 < 0 || cy - boxH / 2 > height) continue;
      rects.push({
        x: Math.round(cx - markW / 2),
        y: Math.round(cy - markH / 2),
        width: markW,
        height: markH,
      });
    }
  }
  return { rects, angleDeg };
}

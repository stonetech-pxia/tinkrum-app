import { clamp } from '@morph/core/math';
// Pure calculations for dimensions and cropping. Results are integer pixels, handed directly by the app to expo-image-manipulator.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeSpec =
  | { mode: 'longEdge'; px: number }
  | { mode: 'width'; px: number }
  | { mode: 'height'; px: number }
  | { mode: 'percent'; percent: number }
  | { mode: 'fit'; width: number; height: number };

const MIN_CROP = 16;

function assertPositive(...values: number[]): void {
  for (const v of values) if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(String(v));
}

/** Scale only without cropping: maintain aspect ratio, do not upscale by default. */
export function resizeDimensions(
  size: Size,
  spec: ResizeSpec,
  { allowUpscale = false }: { allowUpscale?: boolean } = {},
): Size {
  const { width, height } = size;
  assertPositive(width, height);
  let factor: number;
  switch (spec.mode) {
    case 'longEdge':
      assertPositive(spec.px);
      factor = spec.px / Math.max(width, height);
      break;
    case 'width':
      assertPositive(spec.px);
      factor = spec.px / width;
      break;
    case 'height':
      assertPositive(spec.px);
      factor = spec.px / height;
      break;
    case 'percent':
      assertPositive(spec.percent);
      factor = spec.percent / 100;
      break;
    case 'fit':
      // Fit completely into the box without cropping; result may have one side smaller than the box.
      assertPositive(spec.width, spec.height);
      factor = Math.min(spec.width / width, spec.height / height);
      break;
  }
  if (!allowUpscale) factor = Math.min(factor, 1);
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** Maximum crop box obtainable centered, according to aspect (width/height). */
export function centeredCropForAspect(size: Size, aspect: number): Rect {
  assertPositive(size.width, size.height, aspect);
  let width = size.width;
  let height = size.height;
  if (width / height > aspect) width = clamp(Math.round(height * aspect), 1, size.width);
  else height = clamp(Math.round(width / aspect), 1, size.height);
  return {
    x: Math.floor((size.width - width) / 2),
    y: Math.floor((size.height - height) / 2),
    width,
    height,
  };
}

/**
 * Clamp crop box inside the image, minimum side 16px (use image dimensions as base when smaller).
 * When aspect is given, maintain center and approximate area, converting to that ratio; rounded
 * ratio may differ by 1px.
 */
export function clampCrop(rect: Rect, size: Size, { aspect }: { aspect?: number } = {}): Rect {
  assertPositive(size.width, size.height);
  const minW = Math.min(MIN_CROP, size.width);
  const minH = Math.min(MIN_CROP, size.height);
  let width = Math.max(1, rect.width);
  let height = Math.max(1, rect.height);
  if (aspect !== undefined) {
    assertPositive(aspect);
    const max = centeredCropForAspect(size, aspect);
    width = Math.sqrt(width * height * aspect);
    height = width / aspect;
    // First upscale to minimum side, then downscale to maximum proportional box the image can accommodate.
    const grow = Math.max(1, minW / width, minH / height);
    const shrink = Math.min(1, max.width / (width * grow), max.height / (height * grow));
    width = clamp(Math.round(width * grow * shrink), 1, max.width);
    height = clamp(Math.round(height * grow * shrink), 1, max.height);
  } else {
    width = clamp(Math.round(width), minW, size.width);
    height = clamp(Math.round(height), minH, size.height);
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: clamp(Math.round(cx - width / 2), 0, size.width - width),
    y: clamp(Math.round(cy - height / 2), 0, size.height - height),
    width,
    height,
  };
}

export interface CropPlan {
  crop: Rect;
  /** Target dimensions to scale to after cropping; null when already equal to output dimensions. */
  resize: Size | null;
  /** Crop box is smaller than output dimensions, requiring upscaling (id photo prompt "original image resolution insufficient"). */
  upscale: boolean;
}

/** Translate "crop box -> fixed output size" into two steps: crop first, then scale. */
export function cropToOutput(rect: Rect, output: Size): CropPlan {
  const same = rect.width === output.width && rect.height === output.height;
  return {
    crop: rect,
    resize: same ? null : { width: output.width, height: output.height },
    upscale: rect.width < output.width || rect.height < output.height,
  };
}

/** iOS WebView canvas supports at most approx. 16.78M pixels; scale down proportionally within upper limit when exceeded. */
export function capPixels(size: Size, maxPixels = 16_777_216): Size {
  assertPositive(size.width, size.height, maxPixels);
  if (size.width * size.height <= maxPixels) return { width: size.width, height: size.height };
  const f = Math.sqrt(maxPixels / (size.width * size.height));
  let width = Math.max(1, Math.floor(size.width * f));
  let height = Math.max(1, Math.floor(size.height * f));
  // Extremely slender image: once one side is clamped to 1px, recalculate the other side according to the limit.
  width = Math.max(1, Math.min(width, Math.floor(maxPixels / height)));
  height = Math.max(1, Math.min(height, Math.floor(maxPixels / width)));
  return { width, height };
}

/** GPU offscreen canvas single-side limit: iOS simulator Metal texture limit is 8192 (real device 16384), calculated based on the smaller one. */
export const MAX_SURFACE_SIDE = 8192;

/**
 * Ratio (<= 1) to scale down overall when offscreen canvas cannot fit: single side not exceeding
 * MAX_SURFACE_SIDE, total pixels not exceeding 16.77M. Exceeding the Metal limit causes the app
 * to crash directly, so it must be calculated before every offscreen draw.
 */
export function surfaceScale(size: Size, maxPixels = 16_777_216): number {
  assertPositive(size.width, size.height, maxPixels);
  return Math.min(
    1,
    MAX_SURFACE_SIDE / size.width,
    MAX_SURFACE_SIDE / size.height,
    Math.sqrt(maxPixels / (size.width * size.height)),
  );
}

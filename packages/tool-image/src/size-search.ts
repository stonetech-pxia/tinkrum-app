// Encodes once using the given quality (0-1) and scale (≤1), returning the encoded byte size. Real
// encoding is performed by the app (`expo-image-manipulator`), while this function only decides
// what quality and scale to use and ensures call counts have an upper limit.

/** Encodes once with the given quality (0-1) and scale (<=1), returning the encoded byte count. */
export type EncodeFn = (quality: number, scale: number) => Promise<number>;

export interface TargetSizeOptions {
  encode: EncodeFn;
  targetBytes: number;
  minQuality?: number;
  maxQuality?: number;
  /** Maximum number of encode calls (including the final re-encode). */
  maxEncodes?: number;
  /** Lower bound for scale, default 0.05; apps should pass the original image dimensions to avoid scaling down to a few pixels. */
  minScale?: number;
}

export interface SharedTargetOptions extends Omit<TargetSizeOptions, 'encode'> {
  /** Encodes all images using the same quality and scale, returning the sum of byte counts. */
  encodeAll: EncodeFn;
  /** Container overhead (such as PDF structure), included in the total size. */
  overheadBytes: number;
}

export interface TargetSizeResult {
  quality: number;
  scale: number;
  /** Returns the byte count corresponding to the parameters (includes overheadBytes for shared search). */
  bytes: number;
  /** Whether the target is met; returns the smallest tried result when not met. */
  met: boolean;
  encodes: number;
}

interface Trial {
  quality: number;
  scale: number;
  bytes: number;
}

const QUALITY_ROUNDS = 7;
/** Stop binary searching when the quality range is smaller than this value. */
const QUALITY_STEP = 0.01;
/** Leave a 5% margin when scaling down to reduce the probability of needing another scale-down. */
const SCALE_MARGIN = 0.95;

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function search(
  encode: EncodeFn,
  target: number,
  options: Omit<TargetSizeOptions, 'encode' | 'targetBytes'>,
): Promise<{ trial: Trial; met: boolean; encodes: number }> {
  const { minQuality = 0.3, maxQuality = 0.92, maxEncodes = 16, minScale = 0.05 } = options;
  const budget = Math.max(1, Math.floor(maxEncodes));
  const trials: Trial[] = [];
  const run = async (quality: number, scale: number): Promise<Trial> => {
    const trial = { quality, scale, bytes: await encode(quality, scale) };
    trials.push(trial);
    return trial;
  };
  // Always reserve one call for final re-encoding with the best parameters.
  const canSearch = () => trials.length < budget - 1;

  const first = await run(maxQuality, 1);
  let fit: Trial | undefined = first.bytes <= target ? first : undefined;

  // Estimate scale by area when the lowest quality is still too large, until the lowest quality fits.
  let scale = 1;
  while (!fit && canSearch()) {
    const low = await run(minQuality, scale);
    if (low.bytes <= target) {
      fit = low;
      break;
    }
    if (scale <= minScale) break;
    const factor = target > 0 ? Math.sqrt(target / low.bytes) * SCALE_MARGIN : 0.5;
    scale = Math.max(minScale, round(scale * factor, 4));
  }

  // Binary search quality at the found scale, taking the highest quality that fits.
  if (fit && fit !== first) {
    let lo = fit.quality;
    let hi = maxQuality;
    for (let i = 0; i < QUALITY_ROUNDS && canSearch() && hi - lo > QUALITY_STEP; i++) {
      const mid = round((lo + hi) / 2, 3);
      const trial = await run(mid, fit.scale);
      if (trial.bytes <= target) {
        fit = trial;
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }

  let best = fit ?? trials.reduce((a, b) => (b.bytes < a.bytes ? b : a));
  // The app keeps only the final output: re-encode once if the best result is not the last one.
  if (best !== trials.at(-1)) best = await run(best.quality, best.scale);
  return { trial: best, met: best.bytes <= target, encodes: trials.length };
}

/**
 * Search for the highest quality encoding not exceeding targetBytes: try highest quality at
 * original size first, then binary search quality, and scale down and search again if the lowest
 * quality still does not fit. The parameters of the final encode call always equal the return
 * value.
 */
export async function searchForTargetSize(options: TargetSizeOptions): Promise<TargetSizeResult> {
  const { encode, targetBytes, ...rest } = options;
  if (!(targetBytes > 0)) throw new RangeError('targetBytes');
  const { trial, met, encodes } = await search(encode, targetBytes, rest);
  return { ...trial, met, encodes };
}

/** Multiple images share a quality and scale (e.g., "convert images to PDF <= X MB"), with total size including container overhead. */
export async function searchSharedQuality(options: SharedTargetOptions): Promise<TargetSizeResult> {
  const { encodeAll, targetBytes, overheadBytes, ...rest } = options;
  if (!(targetBytes > 0)) throw new RangeError('targetBytes');
  const { trial, encodes } = await search(encodeAll, targetBytes - overheadBytes, rest);
  const bytes = trial.bytes + overheadBytes;
  return { ...trial, bytes, met: bytes <= targetBytes, encodes };
}

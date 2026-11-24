import { VISION_ERRORS, type MorphVisionModule } from '../../modules/morph-vision';
import type { ImageLabel } from './platform';

// JS part of VisionPlatform.classifyImage (what is in the photo, used for recommendations on photos
// without text, not yet wired into recommendations): assign a taskId to the native task,
// immediately finish the Promise and notify native to stop when signal is cancelled; unify and tidy
// results from both platforms.

/** Default maximum number of tags. */
export const CLASSIFY_MAX_RESULTS = 10;
/** Default minimum confidence threshold (ML Kit defaults to 0.5; use a lower value to leave filtering to the recommendations module). */
export const CLASSIFY_MIN_CONFIDENCE = 0.1;

type NativeClassifier = Required<Pick<MorphVisionModule, 'classifyImage'>> &
  Pick<MorphVisionModule, 'cancelClassify'>;

let taskCounter = 0;

const cancelledError = () => Object.assign(new Error('Cancelled'), { code: 'cancelled' });

/** Remove non-numeric tags, clamp confidence to 0-1, keep highest confidence for duplicate tags, sort descending by confidence, apply filter threshold and limit count. */
export function tidyLabels(
  labels: readonly { id: string; confidence: number }[],
  maxResults: number,
  minConfidence: number,
): ImageLabel[] {
  const best = new Map<string, number>();
  for (const { id, confidence } of labels) {
    if (!id || !Number.isFinite(confidence)) continue;
    const c = Math.min(1, Math.max(0, confidence));
    if (c < minConfidence) continue;
    best.set(id, Math.max(best.get(id) ?? 0, c));
  }
  return [...best]
    .map(([id, confidence]) => ({ id, confidence }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(0, maxResults));
}

export async function classifyImageWith(
  native: NativeClassifier,
  uri: string,
  options: { maxResults?: number; minConfidence?: number; signal?: AbortSignal } = {},
): Promise<ImageLabel[]> {
  const {
    maxResults = CLASSIFY_MAX_RESULTS,
    minConfidence = CLASSIFY_MIN_CONFIDENCE,
    signal,
  } = options;
  if (signal?.aborted) throw cancelledError();
  const taskId = `classify-${Date.now()}-${++taskCounter}`;
  const work = native.classifyImage(taskId, uri, { maxResults, minConfidence }).catch((e) => {
    throw (e as { code?: string }).code === VISION_ERRORS.cancelled ? cancelledError() : e;
  });
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      native.cancelClassify?.(taskId);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const { labels } = await Promise.race([work, aborted]);
    return tidyLabels(labels, maxResults, minConfidence);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Ignore late-arriving results or errors from native side after cancellation.
    work.catch(() => undefined);
  }
}

import { MEDIA_LIMITS, inMemorySizeProblem } from './limits';
import { mediaKindOf } from './media';
import { RunError } from './workflow/engine';

const MB = 1024 * 1024;

/** Video and audio files: streamed and processed via native modules without entering JS memory (D-142). */
export const isMediaFile = (f: { name: string; mimeType?: string | null }) => {
  const kind = mediaKindOf(f.mimeType, f.name);
  return kind === 'video' || kind === 'audio';
};

/**
 * Files that must be loaded entirely into JS memory for processing: Check size limits (P-006;
 * single PDF 100 MB, total 200 MB, others 50 / 100, D-601). Selectors might not provide file
 * sizes, so check again after copying. Videos and audios use separate MEDIA_LIMITS: single 4 GB,
 * up to 10 files, excluded from total size limits (D-142). Quick actions and merged PDFs on the
 * all-files page both use this function, with a single set of thresholds (R04).
 */
export function checkSizes(
  sizes: readonly { name: string; size: number | null; mimeType?: string | null }[],
): void {
  const media = sizes.filter(isMediaFile);
  for (const f of media) {
    if ((f.size ?? 0) > MEDIA_LIMITS.maxFileBytes) {
      throw new RunError('tooLarge', { name: f.name, mb: MEDIA_LIMITS.maxFileBytes / MB });
    }
  }
  if (media.length > MEDIA_LIMITS.maxCount) {
    throw new RunError('tooMany', { max: MEDIA_LIMITS.maxCount });
  }
  const problem = inMemorySizeProblem(sizes.filter((f) => !isMediaFile(f)));
  if (problem?.code === 'tooLarge')
    throw new RunError('tooLarge', { name: problem.name, mb: problem.mb });
  if (problem) throw new RunError('tooLargeTotal', { mb: problem.mb });
}

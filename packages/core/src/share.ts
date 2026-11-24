import { MEDIA_LIMITS, inMemorySizeProblem } from './limits';
import { OFFICE_MIME_TYPES, mediaKindOf } from './media';
import type { Workflow } from './schema';
import { FILE_ACCEPT, MAX_PICK } from './tools/io';
import type { FileValueType } from './workflow/engine';

// A file shared into Morph (TOOLS_DESIGN §11, D-114–D-118): files shared from other apps are passed
// to the designated workflow. Files serve only as input for the workflow's first step (in.photos /
// in.files), without modifying the workflow format, and are invisible to the AI.

/** Information for a file shared into the app; mimeType is auto-completed based on extension. */
export interface SharedFileInfo {
  name: string;
  mimeType: string;
  size: number | null;
}

export type ShareFit =
  | { ok: true; type: FileValueType }
  /** First step accepts no files (inputs text, reads records), or file type is incorrect. */
  | { ok: false; reason: 'type' }
  | { ok: false; reason: 'tooFew'; min: number }
  | { ok: false; reason: 'tooMany'; max: number };

const isImage = (mime: string) => mime.startsWith('image/');
const isPdf = (mime: string) => mime === 'application/pdf';
const isZip = (mime: string) =>
  mime === 'application/zip' || mime === 'application/x-zip-compressed';
const isVideo = (mime: string) => mime.startsWith('video/');
const isAudio = (mime: string) => mime.startsWith('audio/');
/** Video and audio are processed by native modules using MEDIA_LIMITS (D-142). */
const isMedia = (f: SharedFileInfo) => {
  const kind = mediaKindOf(f.mimeType, f.name);
  return kind === 'video' || kind === 'audio';
};

/** Whether the accept filter of in.files accepts this mimeType. */
export function acceptsSharedFile(accept: string, mimeType: string): boolean {
  switch (accept) {
    case 'pdf':
      return isPdf(mimeType);
    case 'images':
      return isImage(mimeType);
    case 'pdfOrImages':
      return isPdf(mimeType) || isImage(mimeType);
    case 'zip':
      return isZip(mimeType);
    case 'videos':
      return isVideo(mimeType);
    case 'audio':
      return isAudio(mimeType);
    case 'documents':
      return OFFICE_MIME_TYPES.includes(mimeType);
    case 'any':
      return true;
    default:
      return false;
  }
}

/**
 * File-receiving input actions: type and acceptance rules when a shared file serves as its
 * result. Add a row here for new input actions (such as future "select audio").
 */
const SHARE_INPUTS: Readonly<
  Record<
    string,
    (params: Record<string, unknown>) => { type: FileValueType; accepts(mime: string): boolean }
  >
> = {
  // Photo library, camera, and scanning all count: shared photos are not auto-straightened, which will be handled by subsequent edge-detection steps.
  'in.photos': () => ({ type: 'images', accepts: isImage }),
  'in.videos': () => ({ type: 'video', accepts: isVideo }),
  // Audio recording source counts: shared audio is used directly without opening the recording interface (D-154).
  'in.audio': () => ({ type: 'audio', accepts: isAudio }),
  'in.files': (params) => {
    const accept = String(params.accept);
    return {
      type: (FILE_ACCEPT[accept] ?? 'files') as FileValueType,
      accepts: (mime) => acceptsSharedFile(accept, mime),
    };
  },
};

/** Whether a shared file can directly serve as the result of this input step (both type and count must match). */
export function shareFitsInput(
  actionId: string,
  params: Record<string, unknown>,
  files: readonly SharedFileInfo[],
): ShareFit {
  const input = SHARE_INPUTS[actionId];
  if (!input) return { ok: false, reason: 'type' };
  const { type, accepts } = input(params);
  if (files.length === 0 || !files.every((f) => accepts(f.mimeType))) {
    return { ok: false, reason: 'type' };
  }
  const min = Number(params.min ?? 1);
  const max = Number(params.max ?? Infinity);
  if (files.length < min) return { ok: false, reason: 'tooFew', min };
  if (files.length > max) return { ok: false, reason: 'tooMany', max };
  return { ok: true, type };
}

/** Can the workflow accept these files: check the first step. */
export function shareFit(workflow: Workflow, files: readonly SharedFileInfo[]): ShareFit {
  const first = workflow.steps[0];
  if (!first) return { ok: false, reason: 'type' };
  return shareFitsInput(first.action, first.params, files);
}

/**
 * Size upper limit (P-006): same as files chosen by the selector: single PDF 100 MB, total 200
 * MB; single other file 50 MB, total 100 MB; calculated independently (D-601). Video and audio
 * are calculated separately (D-142): single 4 GB, up to 10 files, not counted towards the total.
 * Returns null when everything is fine.
 */
export function sharedSizeProblem(
  files: readonly SharedFileInfo[],
):
  | { code: 'tooLarge'; detail: { name: string; mb: number } }
  | { code: 'tooLargeTotal'; detail: { mb: number } }
  | { code: 'tooMany'; detail: { max: number } }
  | null {
  if (files.length > MAX_PICK) return { code: 'tooMany', detail: { max: MAX_PICK } };
  const mb = (bytes: number) => bytes / 1024 / 1024;
  const media = files.filter(isMedia);
  for (const f of media) {
    if ((f.size ?? 0) > MEDIA_LIMITS.maxFileBytes) {
      return { code: 'tooLarge', detail: { name: f.name, mb: mb(MEDIA_LIMITS.maxFileBytes) } };
    }
  }
  if (media.length > MEDIA_LIMITS.maxCount) {
    return { code: 'tooMany', detail: { max: MEDIA_LIMITS.maxCount } };
  }
  const problem = inMemorySizeProblem(files.filter((f) => !isMedia(f)));
  if (problem?.code === 'tooLarge')
    return { code: 'tooLarge', detail: { name: problem.name, mb: problem.mb } };
  if (problem) return { code: 'tooLargeTotal', detail: { mb: problem.mb } };
  return null;
}

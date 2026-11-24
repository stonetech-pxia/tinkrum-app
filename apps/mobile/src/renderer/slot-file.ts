import type { FilePlatform, PickedFile } from '../runtime/platform';
import { copyUserFiles, type ImportProblem } from '../storage/copy-files';
import type { WorkspaceRepo } from '../storage/types';

// Where to select from: camera (attachments only), photos (as-is, no re-encoding), and "files".
// File entry points (D-257) and attachment fields (D-263): user-selected files are copied and
// stored as user files (assets/<id>/<filename>), leaving originals untouched (AGENTS.md "File
// ownership"). Selection happens here, and copying into the app happens in storage/copy-files.ts
// (R11).

/** Where to select from: camera (attachments only), photos (as-is, no re-encoding), and "files". */
export type SlotSource = 'camera' | 'photos' | 'files';

export type { ImportProblem };

export type SlotImport =
  { kind: 'saved'; assetId: string } | { kind: 'cancelled' } | { kind: ImportProblem };

/** Number of files selected at once: stored files maintain the selected order; stops immediately if an error occurs mid-way, with problem indicating the reason. */
export type FilesImport =
  { kind: 'cancelled' } | { kind: 'done'; assetIds: string[]; problem?: ImportProblem };

async function pick(
  source: SlotSource,
  max: number,
  files: FilePlatform,
): Promise<PickedFile[] | null> {
  if (source === 'camera') {
    const photo = await files.takePhoto();
    return photo ? [photo] : null;
  }
  return source === 'photos' ? files.pickMedia(max) : files.pickDocuments(['*/*'], max > 1);
}

/** Select at most max files and copy them into the app one by one. */
export async function importUserFiles(
  source: SlotSource,
  max: number,
  files: FilePlatform,
  repo: WorkspaceRepo,
): Promise<FilesImport> {
  const picked = (await pick(source, max, files))?.slice(0, max);
  if (!picked || picked.length === 0) return { kind: 'cancelled' };
  try {
    return { kind: 'done', ...(await copyUserFiles(picked, files, repo)) };
  } finally {
    // Delete the copy placed into cache by the selector (videos can be very large) after use; photo library originals and content:// URIs are outside the cache and remain untouched.
    await files.removePickedCopies(picked.map((p) => p.uri)).catch(() => undefined);
  }
}

/** File entry point: select a file and copy it into the app. */
export async function importSlotFile(
  source: Exclude<SlotSource, 'camera'>,
  files: FilePlatform,
  repo: WorkspaceRepo,
): Promise<SlotImport> {
  const result = await importUserFiles(source, 1, files, repo);
  if (result.kind === 'cancelled') return result;
  if (result.problem) return { kind: result.problem };
  return { kind: 'saved', assetId: result.assetIds[0]! };
}

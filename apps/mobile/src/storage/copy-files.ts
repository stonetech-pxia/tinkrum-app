import { MEDIA_LIMITS, sanitizeFileName, uniqueFileName } from '@morph/core';

import { newAssetId } from '../runtime/ids';
import { mimeOf } from '../runtime/mime';
import type { FilePlatform, PickedFile } from '../runtime/platform';
import { indexAssetText } from './asset-text';
import type { WorkspaceRepo } from './types';

// Copies files selected/shared by the user into the App to become user files
// (assets/<id>/<filename>), leaving originals untouched (AGENTS.md "File ownership"). Copying uses
// native File.copy for streaming read/write without loading files into JS memory, thus bypassing
// pdf-lib's 50 MB limit, subject only to video limits (D-142) and available device storage checks.
// Located at the storage layer: used by document library (keep-files), record pages, and renderer
// file slots (R11).

export type ImportProblem = 'tooLarge' | 'noSpace' | 'copyFailed';

/** Storage margin reserved on the phone during copying: filling storage completely causes issues for the system and other apps. */
const SPACE_MARGIN = 200 * 1024 * 1024;

/**
 * Copies multiple files one by one as user files, leaving originals untouched and undeleted
 * (copies from inbox batches are deleted when released by the inbox page, D-392). Stored in
 * order; stops on the first error, with problem describing the cause.
 */
export async function copyUserFiles(
  picked: readonly PickedFile[],
  files: FilePlatform,
  repo: WorkspaceRepo,
): Promise<{ assetIds: string[]; created: string[]; problem?: ImportProblem }> {
  const assetIds: string[] = [];
  // Newly copied files in this batch (excluding those already stored in the document library upon opening and used directly, D-455): callers delete only these upon cancellation.
  const created: string[] = [];
  const toIndex: { path: string; mimeType: string }[] = [];
  const done = (problem?: ImportProblem) => {
    // File text is read asynchronously in the background so the user doesn't have to wait (D-455).
    void (async () => {
      for (const asset of toIndex) await indexAssetText(files, asset);
    })();
    return problem ? { assetIds, created, problem } : { assetIds, created };
  };
  for (const file of picked) {
    if (file.assetId) {
      assetIds.push(file.assetId);
      continue;
    }
    const size = file.size ?? 0;
    if (size > MEDIA_LIMITS.maxFileBytes) return done('tooLarge');
    // Re-checks remaining storage space after each file copy (as previous copies have consumed space).
    const free = files.freeDiskBytes();
    if (free !== null && size + SPACE_MARGIN > free) return done('noSpace');
    const clean = sanitizeFileName(file.name);
    // File extension is preserved as-is (case is also unchanged).
    const ext = /\.([^./]+)$/.exec(clean)?.[1] ?? 'bin';
    const existing = (await repo.listAssets()).map((a) => a.name);
    const name = uniqueFileName(clean.replace(/\.[^.]+$/, '') || 'untitled', ext, existing);
    const id = newAssetId();
    let stored;
    try {
      // Deletes partial files upon native copy failure (expo-platform's importFile).
      stored = await files.importFile(file, id, name);
    } catch {
      return done('copyFailed');
    }
    try {
      await repo.addAsset({
        id,
        name,
        mimeType: mimeOf(name, file.mimeType),
        size: stored.size,
        path: stored.path,
        source: 'picked',
        createdAt: Date.now(),
      });
    } catch {
      // A copy was imported successfully but registration in the database failed: delete this
      // specific copy (otherwise it cannot be seen or deleted on the storage space page);
      // previously registered copies remain as-is and originals are untouched (R10).
      await files.removeAssetFile(stored.path).catch(() => undefined);
      return done('copyFailed');
    }
    assetIds.push(id);
    created.push(id);
    toIndex.push({ path: stored.path, mimeType: mimeOf(name, file.mimeType) });
  }
  return done();
}

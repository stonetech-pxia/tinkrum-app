import { sanitizeFileName } from '@morph/core';

import type { FilePlatform, PickedFile } from '../runtime/platform';
import { copyUserFiles } from './copy-files';
import type { WorkspaceRepo } from './types';

/**
 * Files opened or shared into the app are all stored in the document library (D-455): a copy is
 * stored for each file (thumbnails generated upon saving), recording their assetId for direct use
 * when saved as records later. Files with identical name, size, and content digest (SHA-256,
 * computed natively on the fly) that were already opened into the document library are not
 * duplicated; files with the same name and size but different content are treated as distinct
 * files and stored separately (R01). When content digest cannot be computed, treat as a new file,
 * preferring to store an extra copy rather than link incorrectly. Files that fail to store (too
 * large, insufficient space, copy failure) still enter the inbox page, just not the document
 * library. Text is read asynchronously by copyUserFiles (non-blocking). Originals remain
 * untouched (invariant 4); this is part of the user's open/share operation (invariant 16).
 */
/** Already existing in the document library and identical to this file: same name, size, and content digest. */
async function findSameFile(file: PickedFile, files: FilePlatform, repo: WorkspaceRepo) {
  if (file.size === null) return undefined;
  const name = sanitizeFileName(file.name);
  const candidates = (await repo.listAssets()).filter(
    (a) => a.source === 'picked' && a.name === name && a.size === file.size,
  );
  if (candidates.length === 0) return undefined;
  const digestOf = (uri: string) => files.contentDigest(uri).catch(() => null);
  const mine = await digestOf(file.uri);
  if (mine === null) return undefined;
  for (const candidate of candidates) {
    if ((await digestOf(files.fileUri(candidate.path))) === mine) return candidate;
  }
  return undefined;
}

export async function keepIncomingFiles(
  picked: readonly PickedFile[],
  files: FilePlatform,
  repo: WorkspaceRepo,
  /** Number of files successfully stored (displays progress when opening many photos at once). */
  onProgress?: (done: number, total: number) => void,
): Promise<PickedFile[]> {
  const kept: PickedFile[] = [];
  const total = picked.length;
  const push = (file: PickedFile) => {
    kept.push(file);
    onProgress?.(kept.length, total);
  };
  for (const file of picked) {
    if (file.assetId) {
      push(file);
      continue;
    }
    const same = await findSameFile(file, files, repo);
    if (same) {
      push({ ...file, assetId: same.id });
      continue;
    }
    const { assetIds } = await copyUserFiles([file], files, repo);
    const id = assetIds[0];
    if (!id) {
      push(file);
      continue;
    }
    push({ ...file, assetId: id });
  }
  return kept;
}

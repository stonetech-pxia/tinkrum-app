import { FILE_LIMITS, sanitizeFileName, uniqueFileName } from '@morph/core';

import type { FilePlatform } from '../runtime/platform';
import { newAssetId } from '../runtime/ids';
import type { WorkspaceRepo } from '../storage/types';

// Photos selected by the user on the page (image component D-046, image background D-258): select
// one from the photo library, re-encode and resize it, and save it as a user file; only the file ID
// is recorded in the config. Photos are not deleted with version changes (like other user files).

export type PickedPicture =
  { kind: 'saved'; assetId: string } | { kind: 'cancelled' } | { kind: 'tooLarge' };

export async function pickPicture(
  files: FilePlatform,
  repo: WorkspaceRepo,
  maxSide?: number,
): Promise<PickedPicture> {
  const picked = await files.pickImage(maxSide);
  if (!picked) return { kind: 'cancelled' };
  if ((picked.size ?? 0) > FILE_LIMITS.maxFileBytes) return { kind: 'tooLarge' };
  const id = newAssetId();
  const clean = sanitizeFileName(picked.name);
  const ext = /\.([^.]+)$/.exec(clean)?.[1] ?? 'jpg';
  const existing = (await repo.listAssets()).map((a) => a.name);
  const name = uniqueFileName(clean.replace(/\.[^.]+$/, ''), ext, existing);
  const stored = await files.importFile(picked, id, name);
  try {
    await repo.addAsset({
      id,
      name,
      mimeType: picked.mimeType ?? 'image/jpeg',
      size: stored.size,
      path: stored.path,
      source: 'picked',
      createdAt: Date.now(),
    });
  } catch (e) {
    // If a copy was successfully copied in but failed to register: delete this new copy so that no orphaned files are left behind (R10).
    await files.removeAssetFile(stored.path).catch(() => undefined);
    throw e;
  }
  return { kind: 'saved', assetId: id };
}

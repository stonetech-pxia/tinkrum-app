import { checkSizes, sanitizeFileName, uniqueFileName } from '@morph/core';
import { mergePdfs } from '@morph/tool-pdf';

import { guard } from '../runtime/pdf-errors';
import type { FilePlatform } from '../runtime/platform';
import { indexAssetText } from './asset-text';
import type { AssetRecord, WorkspaceRepo } from './types';

// Delete user files (Settings -> Storage, D-264): delete physical files on disk first, then
// database records. If the disk file is deleted but the database record fails to delete, the file
// remains listed in storage and can be deleted again; the reverse order leaves orphaned, invisible,
// undeletable files.

export async function deleteUserFiles(
  ids: readonly string[],
  repo: WorkspaceRepo,
  files: FilePlatform,
): Promise<void> {
  for (const id of ids) {
    const asset = await repo.getAsset(id);
    if (!asset) continue;
    await files.removeAssetFile(asset.path);
    await repo.deleteAsset(id);
  }
}

/**
 * Rename a user file (all files view, D-472): modifies the user-visible name only, preserving the
 * extension ("contract" -> "contract.pdf"); returns false if the name is empty or unchanged.
 */
export async function renameUserFile(
  asset: AssetRecord,
  base: string,
  repo: WorkspaceRepo,
): Promise<boolean> {
  const ext = /\.([^./]+)$/.exec(asset.name)?.[1] ?? '';
  // Do not modify empty strings (sanitizeFileName turns empty names into untitled).
  if (!base.trim().replace(/^\.+/, '')) return false;
  const clean = sanitizeFileName(base.trim().replace(/^\.+/, ''));
  const name = ext ? `${clean}.${ext}` : clean;
  if (name === asset.name) return false;
  await repo.renameAsset(asset.id, name);
  return true;
}

/**
 * Combine several PDFs into a new user file in order (all file pages, D-472): original files are
 * left untouched. The new file is rendered with thumbnails (saveRunFile) and read for text
 * (D-455) just like quick action outputs. Unreadable or password-protected PDFs throw RunError
 * (same description as "Merge PDFs"); oversized ones (single 100 MB, total 200 MB, D-601) also
 * throw RunError before reading the files.
 */
export async function mergeUserPdfs(
  assets: readonly AssetRecord[],
  name: string,
  repo: WorkspaceRepo,
  files: FilePlatform,
  ctx: { now(): Date; newId(): string },
): Promise<AssetRecord> {
  // pdf-lib reads the entire file into memory: just like quick actions, it checks for single 100 MB
  // / total 200 MB limits upfront (P-006, D-601) and rejects before reading the file. Sizes use the
  // values recorded when stored in the document library (runner's copyHandedFiles checks them the
  // same way).
  checkSizes(assets.map((a) => ({ name: a.name, size: a.size, mimeType: a.mimeType })));
  const inputs: { name: string; bytes: Uint8Array }[] = [];
  for (const a of assets) inputs.push({ name: a.name, bytes: await files.readBytes(a.path) });
  const merged = await guard('', () => mergePdfs(inputs));
  const existing = (await repo.listAssets()).map((a) => a.name);
  const fileName = uniqueFileName(sanitizeFileName(name), 'pdf', existing);
  const id = ctx.newId();
  const runId = `merge-${id}`;
  try {
    const temp = await files.writeRunFile(runId, fileName, merged.bytes);
    const stored = await files.saveRunFile(temp.uri, id, fileName);
    const asset: AssetRecord = {
      id,
      name: fileName,
      mimeType: 'application/pdf',
      size: stored.size,
      path: stored.path,
      source: 'generated',
      createdAt: ctx.now().getTime(),
    };
    try {
      await repo.addAsset(asset);
    } catch (e) {
      // The combined file was already stored in the document library directory but could not be registered in the database: delete it so no invisible copy is left behind (R10); original files remain untouched.
      await files.removeAssetFile(stored.path).catch(() => undefined);
      throw e;
    }
    void indexAssetText(files, asset);
    return asset;
  } finally {
    await files.removeRun(runId).catch(() => undefined);
  }
}

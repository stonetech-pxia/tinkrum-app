import { decodeUtf8, newDesk, type Desk, type DeskBlob, type DeskFile } from '@morph/core';
import { parseDocDoc, parseTableDoc, type DocDoc } from '@morph/tool-office';

import { saveItems } from '../runtime/actions/io';
import { baseName, extOf } from '../runtime/actions/helpers';
import type { FilePlatform } from '../runtime/platform';
import type { AssetRecord, WorkspaceRepo } from '../storage/types';
import { SOURCE_NAME, writeSavedSource, type SavedSource } from './saved-source-file';
import {
  deskFileUri,
  mapSourcePaths,
  newDeskId,
  saveDesk,
  sourcePaths,
  loadDeskSource,
} from './store';

// Can be placed back on the desk for editing after being saved as a user file (file-room §10
// question 6, founder agreed on 2026-10-30 to do in R2, D-367): when saving xlsx / docx, place the
// intermediate format and its referenced images into the user file's own directory assets/<id>/,
// let "Settings -> Storage" count them toward this file, and delete the entire directory when
// deleting the file (removeAssetFile). When placing "On Desk" from storage, copy a copy back to the
// desk (user files remain unchanged). The intermediate format contains recognized text stored only
// locally; the AI cannot see it.

type Files = Pick<
  FilePlatform,
  'desk' | 'readUri' | 'readBytes' | 'writeBytes' | 'saveRunFile' | 'freeDiskBytes' | 'imageSize'
>;

/** Directory ID where the user file is located (assets/<id>/name); null if not matching this path format. */
const assetDirOf = (asset: Pick<AssetRecord, 'path'>) => {
  const [root, id] = asset.path.split('/');
  return root === 'assets' && id ? id : null;
};

/**
 * "Finish -> Save to file", toolbar "Save": save these desk items as user files; if an
 * intermediate format exists, save it and its images alongside. Return the saved file IDs (in
 * order; used for record attachment restoration, D-395).
 */
export async function saveDeskFiles(
  files: Files,
  repo: WorkspaceRepo,
  desk: Desk,
  list: readonly DeskFile[],
  ctx: { now(): Date; newId(): string },
): Promise<string[]> {
  const saved = await saveItems(
    { files: files as FilePlatform, repo, grantee: 'desk' },
    list.map((f) => ({
      uri: deskFileUri(files, desk, f.path),
      name: f.name,
      ext: f.ext,
      mimeType: f.mimeType,
      size: f.size,
    })),
    ctx,
  );
  for (const [i, file] of list.entries()) {
    const assetId = saved[i]?.assetId;
    // Intermediate formats read from external docx / xlsx (D-509) are not saved: saved files are read again the next time they are opened (only one copy is stored, invariant 14).
    if (!file.source || file.source.imported || !assetId) continue;
    const source = await loadDeskSource(files, desk, file);
    if (!source) continue;
    await writeSavedSource(files, assetId, source, file.source.pagesWithoutTables);
  }
  return saved.flatMap((item) => (item.assetId ? [item.assetId] : []));
}

async function readSaved(files: Pick<FilePlatform, 'readBytes'>, asset: AssetRecord) {
  const id = assetDirOf(asset);
  if (!id) return null;
  try {
    const body = JSON.parse(
      decodeUtf8(await files.readBytes(`assets/${id}/${SOURCE_NAME}`)),
    ) as SavedSource;
    if (body?.version !== 1 || (body.kind !== 'table' && body.kind !== 'doc')) return null;
    return { id, body };
  } catch {
    return null;
  }
}

/** Total size of the intermediate format and images combined when this user file carries an intermediate format (added to its storage size); null otherwise. */
export async function savedSourceBytes(
  files: Pick<FilePlatform, 'readBytes'>,
  asset: AssetRecord,
): Promise<number | null> {
  if (!/\.(xlsx|docx)$/i.test(asset.name)) return null;
  return (await readSaved(files, asset))?.body.bytes ?? null;
}

/**
 * Intermediate format of previously saved Word documents (images replaced with readable URIs),
 * displayed on the preview page according to the editor layout (D-470); null if missing or
 * unreadable.
 */
export async function savedWordDoc(
  files: Pick<FilePlatform, 'readBytes' | 'fileUri'>,
  asset: AssetRecord,
): Promise<DocDoc | null> {
  if (!/\.docx$/i.test(asset.name)) return null;
  const saved = await readSaved(files, asset);
  if (!saved || saved.body.kind !== 'doc') return null;
  const doc = parseDocDoc(JSON.stringify(saved.body.doc));
  if (!doc) return null;
  return mapSourcePaths({ kind: 'doc', doc }, (name) =>
    name ? files.fileUri(`assets/${saved.id}/${name}`) : name,
  ).doc as DocDoc;
}

/** Place back on the desk from storage: copy this file, intermediate format, and images into a new workspace (user files remain unchanged). Returns null if uneditable. */
export async function placeAssetOnDesk(
  files: Files,
  asset: AssetRecord,
  now: number,
  deskId = newDeskId(),
): Promise<Desk | null> {
  const saved = await readSaved(files, asset);
  if (!saved) return null;
  const raw = JSON.stringify(saved.body.doc);
  const parsed =
    saved.body.kind === 'table'
      ? ((doc) => (doc ? ({ kind: 'table', doc } as const) : null))(parseTableDoc(raw))
      : ((doc) => (doc ? ({ kind: 'doc', doc } as const) : null))(parseDocDoc(raw));
  if (!parsed) return null;
  const ext = extOf(asset.name) || 'bin';
  const write = (path: string, bytes: Uint8Array) =>
    files.desk.writeBytes(`${deskId}/${path}`, bytes);
  try {
    const size = await write(`v1-0.${ext}`, await files.readBytes(asset.path));
    const assets: DeskBlob[] = [];
    const paths = new Map<string, string>();
    for (const [k, name] of [...sourcePaths(parsed)].entries()) {
      const path = `assets/v1-0-${k}.${extOf(name) || 'jpg'}`;
      const bytes = await files.readBytes(`assets/${saved.id}/${name}`);
      assets.push({ path, size: await write(path, bytes) });
      paths.set(name, path);
    }
    const doc = mapSourcePaths(parsed, (name) => paths.get(name) ?? '').doc;
    const jsonSize = await files.desk.writeText(`${deskId}/v1-0.json`, JSON.stringify(doc));
    const file: DeskFile = {
      id: 'f1-0',
      name: baseName(asset.name) || asset.name,
      ext,
      mimeType: asset.mimeType,
      size,
      path: `v1-0.${ext}`,
      source: {
        kind: parsed.kind,
        path: 'v1-0.json',
        size: jsonSize,
        assets,
        ...(saved.body.pagesWithoutTables?.length
          ? { pagesWithoutTables: saved.body.pagesWithoutTables }
          : {}),
      },
    };
    const desk = newDesk(deskId, [file], now);
    await saveDesk(files, desk);
    return desk;
  } catch (error) {
    await files.desk.removeDesk(deskId);
    throw error;
  }
}

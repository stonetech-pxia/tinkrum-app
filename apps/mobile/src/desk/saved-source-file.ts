import { decodeUtf8, type RunItem } from '@morph/core';
import { parseDocDoc, parseTableDoc } from '@morph/tool-office';

import { extOf } from '../runtime/actions/helpers';
import type { FilePlatform } from '../runtime/platform';
import { mapSourcePaths, sourcePaths, type DeskSourceDoc } from './store';

// Intermediate format files alongside user files (D-367, D-400): assets/<id>/morph-source.json and
// its referenced images morph-source-<n>.<ext> (with filenames in the same directory specified in
// the JSON). The storage in rooms, "Save" on result pages, and save steps in quick actions all
// write this file, which is read when placing items "On Desk" from storage (saved-source.ts). As a
// standalone file: used by save steps (runtime/actions/io.ts), while saved-source.ts also relies on
// io.ts's saveItems.

/** Intermediate format filename (located in the same directory as user files). */
export const SOURCE_NAME = 'morph-source.json';

export interface SavedSource {
  version: 1;
  kind: DeskSourceDoc['kind'];
  doc: unknown;
  pagesWithoutTables?: number[];
  /** Total size of the intermediate format and images combined (added to this file in storage). */
  bytes: number;
}

type Files = Pick<FilePlatform, 'readUri' | 'writeBytes'>;

/** Save the intermediate format (where images have currently readable URIs) and its referenced images into the user file's assetId directory. */
export async function writeSavedSource(
  files: Files,
  assetId: string,
  source: DeskSourceDoc,
  pagesWithoutTables?: readonly number[],
): Promise<void> {
  // Replace images with filenames in the same directory, making a copy of each.
  const names = new Map<string, string>();
  let bytes = 0;
  for (const [k, path] of [...sourcePaths(source)].entries()) {
    const ext = extOf(path.split('?')[0]!) || 'jpg';
    const name = `morph-source-${k}.${ext}`;
    let data: Uint8Array;
    try {
      data = await files.readUri(path);
    } catch {
      // Unreadable images are not saved (leaving those images empty), but the intermediate format is saved anyway; otherwise, putting the file back on the desk would prevent further editing (D-470).
      continue;
    }
    const written = await files.writeBytes(assetId, name, data);
    bytes += written.size;
    names.set(path, name);
  }
  const doc = mapSourcePaths(source, (path) => names.get(path) ?? '').doc;
  const docJson = JSON.stringify(doc);
  const body: SavedSource = {
    version: 1,
    kind: source.kind,
    doc,
    ...(pagesWithoutTables?.length ? { pagesWithoutTables: [...pagesWithoutTables] } : {}),
    // Images plus the intermediate format itself (excluding fields outside the JSON).
    bytes: bytes + new TextEncoder().encode(docJson).length,
  };
  await files.writeBytes(assetId, SOURCE_NAME, new TextEncoder().encode(JSON.stringify(body)));
}

/**
 * "Save" on result pages, save steps in quick actions (D-400): when Excel or Word conversion
 * results carry an intermediate format, save a copy along with it. If the intermediate format no
 * longer corresponds to this file (modified by subsequent steps) or cannot be read, save only the
 * file, just like placing it on the desk. Intermediate formats and images in the runtime
 * directory are only copied (deleted when the runtime page is closed).
 */
export async function saveRunItemSource(
  files: Files,
  item: RunItem,
  assetId: string,
): Promise<void> {
  const kind =
    item.tableDoc?.for === item.uri ? 'table' : item.docDoc?.for === item.uri ? 'doc' : null;
  if (!kind) return;
  let source: DeskSourceDoc | null = null;
  try {
    const text = decodeUtf8(
      await files.readUri(kind === 'table' ? item.tableDoc!.uri : item.docDoc!.uri),
    );
    if (kind === 'table') {
      const doc = parseTableDoc(text);
      if (doc) source = { kind, doc };
    } else {
      const doc = parseDocDoc(text);
      if (doc) source = { kind, doc };
    }
  } catch {
    source = null;
  }
  if (!source) return;
  await writeSavedSource(
    files,
    assetId,
    source,
    kind === 'table' ? item.tableDoc?.pagesWithoutTables : undefined,
  );
}

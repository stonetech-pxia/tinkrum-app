import type { RunItem, Workflow } from '@morph/core';
import { create } from 'zustand';

import { isMediaFile } from '../runtime/actions/helpers';
import type { FilePlatform, PickedFile } from '../runtime/platform';

// Shared to Morph (TOOLS_DESIGN §11): files shared from other apps that have not yet been
// processed. Kept in memory only; does not enter the config, database, or AI; cleared after the
// user closes the inbox or execution page (D-116).

export interface IncomingShare {
  /** A new ID for each share: allows the inbox page to determine whether a new batch has been shared. */
  id: number;
  files: PickedFile[];
  source: 'share' | 'picker' | 'result';
  /** Independent temporary copy of the result and source config, kept locally only. */
  result?: { runId: string; workflow: Workflow };
  /** Android: copies (file://) conveniently created in the app cache directory by native modules, deleted together after use. */
  copies: string[];
}

interface IncomingState {
  share: IncomingShare | null;
  receive(
    files: PickedFile[],
    copies?: string[],
    source?: IncomingShare['source'],
    result?: IncomingShare['result'],
  ): void;
  clear(): void;
}

let seq = 0;
const batches = new Map<number, IncomingShare>();

export const useIncoming = create<IncomingState>()((set) => ({
  share: null,
  receive: (files, copies = [], source = 'share', result) => {
    const share: IncomingShare = {
      id: ++seq,
      files,
      copies,
      source,
      ...(result ? { result } : {}),
    };
    batches.set(share.id, share);
    set({ share });
  },
  clear: () => set({ share: null }),
}));

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Data from expo-share-intent native module -> file list formatted for the picker. iOS is a JSON
 * string (file:// path copied by the share extension to the App Group shared directory); Android
 * is an object using content:// addresses (read permission granted by sender; filePath is often
 * an external storage path the app lacks permission to read). Text and URLs are ignored (Morph
 * processes files only), returning an empty list.
 */
export function normalizeShare(raw: unknown): PickedFile[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const files = (value as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  const out: PickedFile[] = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const uri = str(o.contentUri) ?? str(o.path);
    if (!uri || !/^(file|content):\/\//.test(uri)) continue;
    const width = num(o.width);
    const height = num(o.height);
    out.push({
      uri,
      name: str(o.fileName) ?? decodeURIComponent(uri.split('/').pop() ?? 'file'),
      size: num(o.fileSize) ?? num(o.size),
      mimeType: str(o.mimeType),
      ...(width && height ? { width, height } : {}),
    });
  }
  return out;
}

/**
 * When the Android module of expo-share-intent cannot read the original path, it copies the file
 * to the root of the app cache directory (using the original filename). We use content://
 * addresses instead of these copies, but they must be tracked for deletion (D-116).
 */
export function nativeCopies(raw: unknown): string[] {
  const files = (raw as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const path = str(o.filePath);
    return str(o.contentUri) && path?.includes('/cache/') ? [`file://${path}`] : [];
  });
}

/**
 * After using a batch of shared files (D-116): clear them from memory and delete the copies in
 * the shared directory. If another batch is shared during this process, clear only this batch and
 * retain the new one.
 */
export async function releaseShare(
  files: Pick<FilePlatform, 'removeShared' | 'removeRun' | 'removePickedCopies'>,
  id: number,
): Promise<void> {
  const batch = batches.get(id);
  if (!batch) return;
  batches.delete(id);
  const current = useIncoming.getState().share;
  if (current?.id === id) useIncoming.getState().clear();
  if (batch.result) {
    await files.removeRun(batch.result.runId).catch(() => undefined);
    return;
  }
  // Selected within the app: delete only the copies placed in the cache by the picker; originals in the photo library and "Files" remain untouched.
  if (batch.source === 'picker') {
    await files.removePickedCopies(batch.files.map((f) => f.uri)).catch(() => undefined);
    return;
  }
  const keep = current && current.id !== id ? current.files.map((f) => f.uri) : [];
  await files.removeShared(keep, batch?.copies ?? []).catch(() => undefined);
}

/**
 * Move into a new execution directory before handover: closing the previous page deletes its
 * original execution directory, so its URI cannot be directly passed down. Video and audio
 * directly produced by the previous run are moved directly (which may be several GBs, D-142),
 * while others are copied.
 */
export async function copyResults(
  files: Pick<FilePlatform, 'copyToRun' | 'adoptIntoRun' | 'removeRun'>,
  items: readonly RunItem[],
  runId: string,
  fromRunId?: string,
): Promise<PickedFile[]> {
  const ownDir = fromRunId ? `runs/${fromRunId}/` : null;
  try {
    const picked: PickedFile[] = [];
    for (const [index, item] of items.entries()) {
      const ext = item.ext.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
      const fileName = `result-${index}.${ext}`;
      const own = ownDir !== null && item.uri.includes(ownDir);
      const copy =
        own && isMediaFile({ name: `${item.name}.${item.ext}`, mimeType: item.mimeType })
          ? await files.adoptIntoRun(item.uri, runId, fileName)
          : await files.copyToRun(item.uri, runId, fileName);
      picked.push({
        ...copy,
        name: `${item.name}.${item.ext}`,
        mimeType: item.mimeType,
        ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
        ...(item.durationMs ? { durationMs: item.durationMs } : {}),
      });
    }
    return picked;
  } catch (error) {
    await files.removeRun(runId).catch(() => undefined);
    throw error;
  }
}

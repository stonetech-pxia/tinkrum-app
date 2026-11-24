import { RunError, sanitizeFileName, uniqueFileName } from '@morph/core';

import type { MorphShareModule, SavedToFolder } from '../../modules/morph-share';
import type { FolderItem } from './platform';

// Output destination (D-119, D-120): sharing multiple files at once, saving to a folder selected by
// the user in Files. Uses local module MorphShare when available; otherwise (Expo Go) falls back to
// expo-sharing to open panels one by one, and saving to a folder falls back to expo-file-system's
// folder picker. Each quick action remembers its own folder (D-196), falling back to the last
// selected one if none is set (D-123): native modules persist in the system, whereas Expo Go
// remembers it only during the current app session. Dependencies are passed in from outside and
// mocked in tests.

/** Folder selected by the user (fallback in Expo Go). */
export interface PickedFolder {
  /** Display name of the folder. */
  name: string;
  /** File names already existing in the folder, do not overwrite them. */
  names(): string[];
  /** Create a new file and write the source file contents; throws an error with code ERR_FOLDER_NOT_WRITABLE if writing fails. */
  write(name: string, mimeType: string, sourceUri: string): Promise<void>;
}

export interface ShareDeps {
  native: MorphShareModule | null;
  /**
   * Files that can be handed directly to native sharing (D-466): Android's FileProvider exposes
   * only runs/, preview/, and share/ in the cache, while files on the desktop and in document
   * libraries are excluded (sharing desktop files on Samsung real devices throws ERR_UNEXPECTED).
   * iOS allows handing over any file directly.
   */
  shareable(uri: string): boolean;
  /** Copy the file to be shared as name (placed in share/, clearing the previous one before each share), returning the copy's URI. */
  stageCopy(uri: string, name: string, first: boolean): Promise<string>;
  /** Open a share panel once with a single file (expo-sharing). */
  shareOne(item: { uri: string; mimeType: string }): Promise<void>;
  /** Prompt the user to select a folder; returns null on cancellation. */
  pickFolder(): Promise<PickedFolder | null>;
  /** Last selected folder in Expo Go (in-memory only). */
  remembered: PickedFolder | null;
  /** Folders remembered by each quick action in Expo Go (in-memory only). */
  rememberedBy: Map<string, PickedFolder>;
}

/** Name of the folder where the quick action key will be stored: its own, or the last selected one if none exists. */
export function rememberedFolder(deps: ShareDeps, key: string): string | null {
  if (deps.native) return deps.native.rememberedFolder(key);
  return (deps.rememberedBy.get(key) ?? deps.remembered)?.name ?? null;
}

/** Forget folders of quick actions that have been deleted (keep: quick actions that still exist). */
export function forgetFolders(deps: ShareDeps, keep: readonly string[]): void {
  if (deps.native) {
    deps.native.forgetFolders(keep);
    return;
  }
  for (const key of [...deps.rememberedBy.keys()]) {
    if (!keep.includes(key)) deps.rememberedBy.delete(key);
  }
}

export const FOLDER_NOT_WRITABLE = 'ERR_FOLDER_NOT_WRITABLE';

/** Default file name when sharing: use name and extension when available (desktop files are saved with names like v2-0.docx, D-466). */
function sharedName(item: { uri: string; name?: string; ext?: string }): string {
  const own = decodeURIComponent(item.uri.replace(/^.*\//, ''));
  if (!item.name) return own;
  return sanitizeFileName(item.ext ? `${item.name}.${item.ext}` : item.name);
}

/**
 * Prior to native sharing, place the file in a shareable location with the correct name (D-466):
 * create a copy (appending -2 for name collisions) if it cannot be shared directly or its file
 * name differs from what the user sees. Hand over other files as-is (do not copy large videos).
 */
export async function stageForShare(
  deps: ShareDeps,
  items: readonly { uri: string; mimeType: string; name?: string; ext?: string }[],
): Promise<{ uri: string; mimeType: string }[]> {
  const taken: string[] = [];
  let first = true;
  const out: { uri: string; mimeType: string }[] = [];
  for (const item of items) {
    const name = sharedName(item);
    const own = decodeURIComponent(item.uri.replace(/^.*\//, ''));
    if (deps.shareable(item.uri) && sanitizeFileName(own) === name) {
      out.push({ uri: item.uri, mimeType: item.mimeType });
      continue;
    }
    const dot = name.lastIndexOf('.');
    const unique = dot > 0 ? uniqueFileName(name.slice(0, dot), name.slice(dot + 1), taken) : name;
    taken.push(unique);
    out.push({ uri: await deps.stageCopy(item.uri, unique, first), mimeType: item.mimeType });
    first = false;
  }
  return out;
}

export async function shareAll(
  deps: ShareDeps,
  items: readonly { uri: string; mimeType: string; name?: string; ext?: string }[],
): Promise<void> {
  if (items.length === 0) return;
  if (deps.native) {
    const ready = await stageForShare(deps, items);
    await deps.native.shareFiles(
      ready.map((i) => i.uri),
      ready.map((i) => i.mimeType),
    );
    return;
  }
  for (const item of items) await deps.shareOne(item);
}

export const NO_VIEWER = 'ERR_NO_VIEWER';

/** Open a file using system preview (D-238); falls back to the share panel in Expo Go (iOS panels allow viewing files). */
export async function previewFile(
  deps: ShareDeps,
  item: { uri: string; mimeType: string; name: string },
): Promise<void> {
  if (!deps.native) {
    await deps.shareOne(item);
    return;
  }
  try {
    await deps.native.previewFile(item.uri, item.mimeType, item.name);
  } catch (e) {
    if ((e as { code?: string }).code === NO_VIEWER) throw new RunError('noViewer');
    // Do not expose other native errors (file unreadable, permissions) error codes to the user.
    throw new RunError('previewFailed');
  }
}

/**
 * Save to the quick action key's folder: when choose is false, save directly to the remembered
 * folder if present (its own, or the last selected one if none exists); otherwise (or when choose
 * is true) prompt the user to select one, remember it for the action, and record it as the last
 * selected one. Returns null if the user cancels.
 */
export async function saveAllToFolder(
  deps: ShareDeps,
  items: readonly FolderItem[],
  key: string,
  choose: boolean,
): Promise<SavedToFolder | null> {
  if (items.length === 0) return { saved: 0, folder: rememberedFolder(deps, key) ?? '' };
  try {
    if (deps.native) {
      return await deps.native.exportFiles(
        items.map((i) => i.uri),
        items.map((i) => sanitizeFileName(`${i.name}.${i.ext}`)),
        items.map((i) => i.mimeType),
        !choose,
        key,
      );
    }
    const kept = choose ? null : (deps.rememberedBy.get(key) ?? deps.remembered);
    const folder = kept ?? (await deps.pickFolder());
    if (!folder) return null;
    if (!kept) deps.remembered = folder;
    deps.rememberedBy.set(key, folder);
    const taken = folder.names();
    for (const item of items) {
      const name = uniqueFileName(sanitizeFileName(item.name), item.ext, taken);
      taken.push(name);
      await folder.write(name, item.mimeType, item.uri);
    }
    return { saved: items.length, folder: folder.name };
  } catch (e) {
    if ((e as { code?: string }).code === FOLDER_NOT_WRITABLE) {
      throw new RunError('folderNotWritable');
    }
    throw new RunError('saveFailed', { detail: e instanceof Error ? e.message : String(e) });
  }
}

import {
  RunError,
  isFileValue,
  sanitizeFileName,
  type Calendar,
  type Collection,
  type RunItem,
  type RunValue,
} from '@morph/core';
import { capPixels } from '@morph/tool-image';

import type { WorkspaceRepo } from '../../storage/types';
import type { FilePlatform, PickedFile } from '../platform';
import type { PackRuntime } from '../../packs/bridge';
import type { LocalUi } from '../local';

// Environment and utility functions injected into action implementations per run.

/** Environment injected into action implementations per run. */
export interface RunServices {
  runId: string;
  files: FilePlatform;
  repo: WorkspaceRepo;
  /** Who is authorized to access saved files: tool ID, or the user's own workflow `workflow:<id>` (§7G). */
  grantee: string;
  ui: LocalUi;
  /** Data tables in the current config (used for reading records and generating reports). */
  collections: readonly Collection[];
  /** When a day or week starts (D-286); defaults to midnight and Monday when absent. */
  calendar?: Calendar;
  /** Packs (pdf.js in WebView, OpenCV, tesseract); null when absent. */
  packs: { runtime: PackRuntime; isInstalled(id: string): Promise<boolean> } | null;
  /**
   * Used when an action only discovers the need to download content midway through execution
   * (converting compressed PDF to images requires PDF preview, D-145): returns true if already
   * downloaded or user confirms download completion, false if user declines.
   */
  ensurePack?: (packId: string, options?: { optional?: boolean }) => Promise<boolean>;
  /** Files shared from other apps: step one (in.photos / in.files) uses them directly without opening a picker (D-115). */
  incoming?: readonly PickedFile[] | null;
}

export const MB = 1024 * 1024;

export { baseName, extOf, extOfMime, isImageMime, mimeOf, mimeOfExt } from '../mime';

/** Input is guaranteed to be files (validator ensures the type). */
export function fileItems(input: RunValue | null): RunItem[] {
  if (!isFileValue(input)) throw new RunError('unexpected', { detail: 'no files' });
  return input.items;
}

let counter = 0;
/**
 * Relative path for temporary files: each intermediate result is placed in its own subdirectory
 * (preventing overwriting previous inputs), with the display name as the filename, ensuring
 * correct names are displayed when sharing or saving to Files.
 */
export const freshName = (name: string, ext: string) =>
  `${++counter}/${sanitizeFileName(name)}.${ext}`;

/** Write a block of bytes into a temporary file for the current run. */
export async function writeItem(
  services: RunServices,
  bytes: Uint8Array,
  item: Omit<RunItem, 'uri' | 'size'>,
): Promise<RunItem> {
  const stored = await services.files.writeRunFile(
    services.runId,
    freshName(item.name, item.ext),
    bytes,
  );
  return { ...item, uri: stored.uri, size: stored.size };
}

// Size checks reside in core (file-size-check.ts): shared between quick actions and the all-files page PDF merger, with a single unified threshold.
export { checkSizes, isMediaFile } from '@morph/core';

export async function readItem(services: RunServices, item: RunItem): Promise<Uint8Array> {
  try {
    return await services.files.readUri(item.uri);
  } catch {
    throw new RunError('accessDenied', { name: `${item.name}.${item.ext}` });
  }
}

/** Image used for text recognition (D-267): pre-enhancement image recorded by scan.enhance, valid only if the image is still the pre-enhanced version. */
export function ocrSourceOf(item: RunItem): NonNullable<RunItem['ocrSource']> | null {
  return item.ocrSource && item.ocrSource.for === item.uri ? item.ocrSource : null;
}

/** Pre-enhancement image treated as a run item (size unknown, read on demand). */
export function ocrSourceItem(item: RunItem, source: NonNullable<RunItem['ocrSource']>): RunItem {
  const { width: _w, height: _h, ocrSource: _o, ...rest } = item;
  return { ...rest, uri: source.uri };
}

/** Temporary file from current run -> filename (displayed on errors). */
export const displayName = (item: RunItem) => `${item.name}.${item.ext}`;

/**
 * Images sent to pack pages (WebView): re-encoded to JPG (straightening orientation, removing
 * metadata as WebViews may not recognize HEIC), scaled down below iOS canvas 16.7 million pixel
 * limit, with the long side not exceeding maxSide.
 */
export async function imageForPage(
  services: RunServices,
  item: RunItem,
  maxSide: number,
): Promise<RunItem> {
  let size = item.width && item.height ? { width: item.width, height: item.height } : null;
  try {
    size ??= await services.files.imageSize(item.uri);
    const fit = capPixels(size);
    const k = Math.min(1, maxSide / Math.max(size.width, size.height), fit.width / size.width);
    const resize = {
      width: Math.max(1, Math.round(size.width * k)),
      height: Math.max(1, Math.round(size.height * k)),
    };
    const out = await services.files.transformImage(
      item.uri,
      k < 1 ? { resize } : {},
      { format: 'jpeg', quality: 0.92 },
      services.runId,
      freshName(item.name, 'jpg'),
    );
    return {
      ...item,
      uri: out.uri,
      ext: 'jpg',
      mimeType: 'image/jpeg',
      size: out.size,
      width: out.width,
      height: out.height,
    };
  } catch {
    throw new RunError('unreadable', { name: displayName(item) });
  }
}

/** Base64 from pack page -> bytes. */
export const fromBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

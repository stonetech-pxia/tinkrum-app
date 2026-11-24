import type { PackNeed } from '@morph/core';

import type { FilePlatform } from '../runtime/platform';
import type { WorkspaceRepo } from '../storage/types';
import type { PackStore } from './store';

/**
 * File bundle offer all-at-once (D-456): after the first scan, share, or file open, a dialog
 * lists the packs required for file processing on this phone (OCR model, PDF preview, page
 * flattening, layout analysis, deskewing without doc camera), downloaded in a single batch. Once
 * asked (user taps download or remind me later), it is never asked again; subsequently downloaded
 * under "Settings → Downloaded Content". This group is bundled with the App (D-510) and
 * considered installed: prompted only when missing from the App (dev build) or manifest version
 * changes.
 */
export const FILE_BUNDLE_ASKED = 'packs:file-bundle-asked';

/** Uninstalled packs needed for file processing on this phone. */
export async function fileBundleMissing(files: FilePlatform, store: PackStore): Promise<string[]> {
  const v = files.vision;
  const wanted = [
    v?.ocrModel?.pack,
    'pdfview',
    v?.flattenModel?.pack,
    v?.layoutModel?.pack,
    v && !v.canFindPaper && !v.documentCamera ? 'scan' : undefined,
  ].filter((id): id is string => typeof id === 'string');
  const have = new Set((await store.installed()).map((p) => p.id));
  return wanted.filter((id) => !have.has(id));
}

/** Returns packs to list if not yet asked and downloads are needed; otherwise empty. Read-only, does not write data. */
export async function fileBundleToOffer(
  repo: Pick<WorkspaceRepo, 'getMeta'>,
  files: FilePlatform,
  store: PackStore,
): Promise<string[]> {
  if ((await repo.getMeta(FILE_BUNDLE_ASKED)) !== null) return [];
  return fileBundleMissing(files, store);
}

/**
 * Ensures runtime packs are present (D-064, D-299): prompts only for required ones; optional ones
 * (flattening, layout, text layer, naming by text) that are missing are skipped directly without
 * prompting on every run (D-456, revising D-274's per-run prompts). Returns uninstalled optional
 * packs; null indicates required packs were not downloaded (canceling execution).
 */
export async function ensureRunPacks(
  store: PackStore,
  needs: readonly PackNeed[],
  ask: (needs: readonly PackNeed[]) => Promise<string[] | null>,
): Promise<string[] | null> {
  const have = new Set((await store.installed()).map((p) => p.id));
  const missing = needs.filter((n) => !have.has(n.pack));
  const skipped = missing.filter((n) => n.optional).map((n) => n.pack);
  const required = missing.filter((n) => !n.optional);
  if (required.length === 0) return skipped;
  const left = await ask(required);
  return left === null ? null : [...left, ...skipped];
}

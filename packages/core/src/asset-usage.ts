import { RECORD_LIMITS, attachmentIds, type DataRecord } from './data';
import { allComponents, type Collection, type WorkspaceConfig } from './schema';

// "Settings -> Storage" (D-264): Where each user file saved by Morph is currently used. Only checks
// file IDs, ignoring file names and content; this page is displayed locally only and is never sent
// to the AI.

/** Where a file is used. */
export type AssetUse =
  /** An attachment on a record (D-263). deleted: in "Recently deleted" (recoverable within 30 days). */
  | { kind: 'record'; collectionId: string; recordId: string; deleted: boolean }
  /** A block: image, file slot (entry's opens.file), card image background (D-045, D-257, D-258). */
  | { kind: 'component'; pageId: string; componentId: string }
  /** A page's image background (D-258). */
  | { kind: 'page'; pageId: string };

export interface AssetUsage {
  uses: AssetUse[];
  /** Not used anywhere currently, but used in historical versions (will be used again when restoring the old version). */
  inOldVersions: boolean;
}

/**
 * All IDs pointing to user files in a config JSON snippet (regardless of nesting level). v34 has
 * only four places (D-377): image block show.asset, card style.backdrop.assetId, page
 * backdrop.assetId, file slot opens.file; historical versions might be v33 configs, where they
 * were all called assetId.
 */
function collectAssetIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectAssetIds(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (ASSET_KEYS.has(k) && typeof v === 'string') into.add(v);
      else collectAssetIds(v, into);
    }
  }
}
const ASSET_KEYS = new Set(['assetId', 'asset', 'file']);

/** All IDs pointing to user files in a historical version's config JSON, collected into into. */
export const assetIdsIn = collectAssetIds;

/** Pages and blocks using files in the current config. */
export function configAssetUses(config: WorkspaceConfig): Map<string, AssetUse[]> {
  const uses = new Map<string, AssetUse[]>();
  const add = (id: string, use: AssetUse) => uses.set(id, [...(uses.get(id) ?? []), use]);
  for (const page of config.containers.pages) {
    if (page.backdrop?.assetId) add(page.backdrop.assetId, { kind: 'page', pageId: page.id });
    for (const c of allComponents(page)) {
      const ids = new Set<string>();
      // Group child blocks are calculated separately and are not counted towards the group itself.
      collectAssetIds({ ...c, children: [] }, ids);
      for (const id of ids) add(id, { kind: 'component', pageId: page.id, componentId: c.id });
    }
  }
  return uses;
}

/**
 * Where each file is used. records includes all records (including those in "Recently deleted");
 * collections are the table structures where these records reside (both current config and
 * historical-only tables), used to find attachment fields. revisions contains the config JSONs of
 * historical versions. Records in recently deleted for more than 30 days are excluded (about to
 * be purged).
 */
export function assetUsage(input: {
  assetIds: readonly string[];
  config: WorkspaceConfig;
  collections: readonly Collection[];
  records: readonly (DataRecord & { deletedAt: number | null })[];
  revisions: readonly unknown[];
  /** When there are many historical versions, read page by page and collect on the fly: file IDs used by already collected old versions (collected using assetIdsIn). */
  oldAssetIds?: ReadonlySet<string>;
  now: Date;
}): Map<string, AssetUsage> {
  const { config, now } = input;
  const result = new Map<string, AssetUsage>(
    input.assetIds.map((id) => [id, { uses: [], inOldVersions: false }]),
  );
  const add = (id: string, use: AssetUse) => result.get(id)?.uses.push(use);

  for (const [id, uses] of configAssetUses(config)) for (const use of uses) add(id, use);

  const fileFields = new Map<string, string[]>();
  for (const c of [...config.data.tables, ...input.collections]) {
    if (fileFields.has(c.id)) continue;
    fileFields.set(
      c.id,
      c.fields.filter((f) => f.type === 'file').map((f) => f.id),
    );
  }
  const oldest = now.getTime() - RECORD_LIMITS.deletedRetentionDays * 24 * 3600 * 1000;
  for (const r of input.records) {
    if (r.deletedAt !== null && r.deletedAt < oldest) continue;
    const ids = new Set(
      (fileFields.get(r.collectionId) ?? []).flatMap((f) => attachmentIds(r.values[f])),
    );
    for (const id of ids)
      add(id, {
        kind: 'record',
        collectionId: r.collectionId,
        recordId: r.id,
        deleted: r.deletedAt !== null,
      });
  }

  const old = new Set<string>(input.oldAssetIds);
  for (const rev of input.revisions) collectAssetIds(rev, old);
  for (const [id, usage] of result) usage.inOldVersions = usage.uses.length === 0 && old.has(id);
  return result;
}

/** Currently not in use anywhere: neither the current config, non-deleted records, nor recently deleted records use it (usage in historical versions also counts as not in use). */
export const isUnused = (usage: AssetUsage | undefined) => !usage || usage.uses.length === 0;

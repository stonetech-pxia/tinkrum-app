import {
  assetIdsIn,
  assetUsage,
  type AssetUsage,
  type Collection,
  type DataRecord,
  type WorkspaceConfig,
} from '@morph/core';

import { revisionTables } from '../workspace/revision-tables';
import { eachRevisionPage } from './revision-pages';
import type { WorkspaceRepo } from './types';

/**
 * Where user files are used (D-264): tables and records (including those in trash), and pages in
 * current and old versions. Listed on the storage space page and used for warnings prior to
 * deletion on the all-files page (D-472). Read-only.
 */
export async function loadAssetUsage(
  repo: WorkspaceRepo,
  config: WorkspaceConfig,
  assetIds: readonly string[],
): Promise<{
  usage: Map<string, AssetUsage>;
  tables: Map<string, Collection>;
  records: (DataRecord & { deletedAt: number | null })[];
}> {
  const deleted = await repo.listDeletedRecords();
  const ids = new Set([
    ...config.data.tables.map((c) => c.id),
    ...(await repo.countRecords()).map((r) => r.collectionId),
    ...deleted.map((r) => r.collectionId),
  ]);
  const active = (await Promise.all([...ids].map((id) => repo.listRecords(id)))).flat();
  // Tables existing only in older versions: retrieves structure from historical versions (same as
  // "Settings -> Data"); files used by old versions are collected accordingly. Reads all history
  // page by page (R02), keeping only what is needed per version without loading thousands of
  // configurations into memory simultaneously.
  const tables = new Map<string, Collection>();
  const oldAssetIds = new Set<string>();
  await eachRevisionPage(repo, (page) => {
    for (const rev of page) {
      assetIdsIn(rev.config, oldAssetIds);
      for (const table of revisionTables(rev.config))
        if (!tables.has(table.id)) tables.set(table.id, table);
    }
  });
  for (const c of config.data.tables) tables.set(c.id, c);
  const records = [...active.map((r) => ({ ...r, deletedAt: null })), ...deleted];
  const usage = assetUsage({
    assetIds,
    config,
    collections: [...tables.values()],
    records,
    revisions: [],
    oldAssetIds,
    now: new Date(),
  });
  return { usage, tables, records };
}

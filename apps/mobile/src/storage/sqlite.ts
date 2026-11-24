import type { DataRecord } from '@morph/core';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  RevisionConflictError,
  type AssetRecord,
  type ChangeRequestRecord,
  type CommitInput,
  type RevisionRecord,
  type SavedPreset,
  type StoredRecord,
  type ToolRunRecord,
  type WorkspaceRepo,
  type RecordImport,
  type RecordRange,
  type RecordWrite,
} from './types';
import { sameValues } from './record-values';

// SQLite implementation. Database schema is managed via PRAGMA user_version, with each element representing a migration step.

export const DB_MIGRATIONS: string[] = [
  `CREATE TABLE workspace_head (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     revision_id INTEGER NOT NULL REFERENCES revisions(id)
   );
   CREATE TABLE revisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     parent_id INTEGER REFERENCES revisions(id),
     schema_version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     source TEXT NOT NULL,
     summary TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE change_requests (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     input TEXT NOT NULL,
     plan_json TEXT,
     status TEXT NOT NULL,
     base_revision_id INTEGER,
     result_revision_id INTEGER,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  `CREATE TABLE assets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     mime_type TEXT NOT NULL,
     size INTEGER NOT NULL,
     path TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE asset_grants (
     tool_id TEXT NOT NULL,
     asset_id TEXT NOT NULL REFERENCES assets(id),
     created_at INTEGER NOT NULL,
     PRIMARY KEY (tool_id, asset_id)
   );
   CREATE TABLE tool_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     tool_id TEXT NOT NULL,
     workflow_id TEXT NOT NULL,
     revision_id INTEGER NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     output_asset_id TEXT,
     started_at INTEGER NOT NULL,
     finished_at INTEGER
   );`,
  // User records: outside of configuration, not restored with version rollbacks (docs/DATA_DESIGN.md).
  `CREATE TABLE records (
     id TEXT PRIMARY KEY,
     collection_id TEXT NOT NULL,
     values_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   );
   CREATE INDEX records_by_collection ON records (collection_id, deleted_at, created_at);`,
  // Device-local metadata: usage statistics and similar items (D-127), not restored with version rollbacks.
  `CREATE TABLE app_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // Saved presets (D-410): not part of configuration, not restored with version rollbacks, and never sent to the AI.
  `CREATE TABLE saved_presets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     schema_version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // Batches of records imported from spreadsheet files (D-574): batch ID, timestamp, target table
  // name, count, file name (displayed to users only), and record IDs in each batch. Only two new
  // tables are added; existing rows in records and other tables remain completely untouched.
  // record_id does not use a foreign key: clearing the trash or permanently deleting a table
  // deletes the corresponding rows in records, and orphaned rows left here are naturally excluded
  // from counts.
  `CREATE TABLE record_imports (
     id TEXT PRIMARY KEY,
     collection_id TEXT NOT NULL,
     file_name TEXT NOT NULL,
     record_count INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX record_imports_by_collection ON record_imports (collection_id, created_at);
   CREATE TABLE import_items (
     import_id TEXT NOT NULL REFERENCES record_imports(id),
     record_id TEXT NOT NULL,
     PRIMARY KEY (import_id, record_id)
   );`,
];

/** Trigger a transaction rollback when a write in applyRecordWrites expected "still be this version" but no longer matches. */
class BatchConflict extends Error {}

interface RecordRow {
  id: string;
  collection_id: string;
  values_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function toStoredRecord(row: RecordRow): StoredRecord {
  let values: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.values_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      values = parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupted records display as empty rather than crashing the page.
  }
  return {
    id: row.id,
    collectionId: row.collection_id,
    values,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  for (let v = row?.user_version ?? 0; v < DB_MIGRATIONS.length; v++) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(DB_MIGRATIONS[v]!);
      await txn.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

interface RevisionRow {
  id: number;
  parent_id: number | null;
  schema_version: number;
  config_json: string;
  source: RevisionRecord['source'];
  summary: string;
  created_at: number;
}

function toRevision(row: RevisionRow): RevisionRecord {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    config = null; // Corrupted snapshots are rejected by prepareSnapshot
  }
  return {
    id: row.id,
    parentId: row.parent_id,
    schemaVersion: row.schema_version,
    config,
    source: row.source,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

interface PresetRow {
  id: string;
  name: string;
  schema_version: number;
  config_json: string;
  created_at: number;
}

function toPreset(row: PresetRow): SavedPreset {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    config = null; // Corrupted presets are rejected by preparePreset
  }
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    schemaVersion: row.schema_version,
    config,
  };
}

interface ChangeRequestRow {
  id: number;
  input: string;
  plan_json: string | null;
  status: ChangeRequestRecord['status'];
  base_revision_id: number | null;
  result_revision_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export class SQLiteWorkspaceRepo implements WorkspaceRepo {
  constructor(private readonly db: SQLiteDatabase) {}

  /** Full export (D-600): save the entire database as a consistent copy (VACUUM INTO, including unwritten WAL data). dest is a local path; the file must not exist yet. */
  async snapshotTo(dest: string): Promise<void> {
    await this.db.runAsync('VACUUM INTO ?', dest);
  }

  /** Metadata included in the full export (D-600) description: database version, current configuration version, and record count (excluding deleted ones). */
  async backupInfo(): Promise<{
    userVersion: number;
    schemaVersion: number | null;
    records: number;
  }> {
    const version = await this.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const head = await this.db.getFirstAsync<{ schema_version: number }>(
      'SELECT r.schema_version FROM workspace_head h JOIN revisions r ON r.id = h.revision_id WHERE h.singleton = 1',
    );
    const count = await this.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM records WHERE deleted_at IS NULL',
    );
    return {
      userVersion: version?.user_version ?? 0,
      schemaVersion: head?.schema_version ?? null,
      records: count?.n ?? 0,
    };
  }

  /** Close the database (prior to data directory restore/switch). */
  async close(): Promise<void> {
    await this.db.closeAsync();
  }

  async getHead() {
    const row = await this.db.getFirstAsync<RevisionRow>(
      'SELECT r.* FROM workspace_head h JOIN revisions r ON r.id = h.revision_id WHERE h.singleton = 1',
    );
    return row ? toRevision(row) : null;
  }

  async getRevision(id: number) {
    const row = await this.db.getFirstAsync<RevisionRow>(
      'SELECT * FROM revisions WHERE id = ?',
      id,
    );
    return row ? toRevision(row) : null;
  }

  async listRevisions(limit: number, beforeId?: number) {
    const rows =
      beforeId === undefined
        ? await this.db.getAllAsync<RevisionRow>(
            'SELECT * FROM revisions ORDER BY id DESC LIMIT ?',
            limit,
          )
        : await this.db.getAllAsync<RevisionRow>(
            'SELECT * FROM revisions WHERE id < ? ORDER BY id DESC LIMIT ?',
            beforeId,
            limit,
          );
    return rows.map(toRevision);
  }

  async commitRevision(input: CommitInput) {
    let record: RevisionRecord | null = null;
    await this.db.withExclusiveTransactionAsync(async (txn) => {
      const head = await txn.getFirstAsync<{ revision_id: number }>(
        'SELECT revision_id FROM workspace_head WHERE singleton = 1',
      );
      const headId = head?.revision_id ?? null;
      if (headId !== input.baseId) throw new RevisionConflictError(input.baseId, headId);
      const createdAt = Date.now();
      const result = await txn.runAsync(
        'INSERT INTO revisions (parent_id, schema_version, config_json, source, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        input.baseId,
        input.config.schemaVersion,
        JSON.stringify(input.config),
        input.source,
        input.summary,
        createdAt,
      );
      await txn.runAsync(
        'INSERT INTO workspace_head (singleton, revision_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET revision_id = excluded.revision_id',
        result.lastInsertRowId,
      );
      record = {
        id: result.lastInsertRowId,
        parentId: input.baseId,
        schemaVersion: input.config.schemaVersion,
        config: input.config,
        source: input.source,
        summary: input.summary,
        createdAt,
      };
    });
    return record!;
  }

  async createChangeRequest(input: Parameters<WorkspaceRepo['createChangeRequest']>[0]) {
    const now = Date.now();
    const result = await this.db.runAsync(
      'INSERT INTO change_requests (input, plan_json, status, base_revision_id, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.input,
      JSON.stringify(input.plan ?? null),
      input.status,
      input.baseRevisionId,
      input.error ?? null,
      now,
      now,
    );
    return result.lastInsertRowId;
  }

  async updateChangeRequest(
    id: number,
    patch: Parameters<WorkspaceRepo['updateChangeRequest']>[1],
  ) {
    await this.db.runAsync(
      'UPDATE change_requests SET status = ?, result_revision_id = COALESCE(?, result_revision_id), error = COALESCE(?, error), updated_at = ? WHERE id = ?',
      patch.status,
      patch.resultRevisionId ?? null,
      patch.error ?? null,
      Date.now(),
      id,
    );
  }

  async getChangeRequest(id: number) {
    const row = await this.db.getFirstAsync<ChangeRequestRow>(
      'SELECT * FROM change_requests WHERE id = ?',
      id,
    );
    if (!row) return null;
    return {
      id: row.id,
      input: row.input,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
      status: row.status,
      baseRevisionId: row.base_revision_id,
      resultRevisionId: row.result_revision_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async addAsset(asset: AssetRecord) {
    await this.db.runAsync(
      'INSERT INTO assets (id, name, mime_type, size, path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      asset.id,
      asset.name,
      asset.mimeType,
      asset.size,
      asset.path,
      asset.source,
      asset.createdAt,
    );
  }

  async getAsset(id: string) {
    const row = await this.db.getFirstAsync<AssetRow>('SELECT * FROM assets WHERE id = ?', id);
    return row ? toAsset(row) : null;
  }

  async listAssets() {
    const rows = await this.db.getAllAsync<AssetRow>(
      'SELECT * FROM assets ORDER BY created_at DESC, rowid DESC',
    );
    return rows.map(toAsset);
  }

  async renameAsset(id: string, name: string) {
    await this.db.runAsync('UPDATE assets SET name = ? WHERE id = ?', name, id);
  }

  async deleteAsset(id: string) {
    // Grants referencing assets (foreign keys) are deleted first.
    await this.db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync('DELETE FROM asset_grants WHERE asset_id = ?', id);
      await txn.runAsync(
        'UPDATE tool_runs SET output_asset_id = NULL WHERE output_asset_id = ?',
        id,
      );
      await txn.runAsync('DELETE FROM assets WHERE id = ?', id);
    });
  }

  async grantAsset(toolId: string, assetId: string) {
    await this.db.runAsync(
      'INSERT OR IGNORE INTO asset_grants (tool_id, asset_id, created_at) VALUES (?, ?, ?)',
      toolId,
      assetId,
      Date.now(),
    );
  }

  async hasGrant(toolId: string, assetId: string) {
    const row = await this.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM asset_grants WHERE tool_id = ? AND asset_id = ?',
      toolId,
      assetId,
    );
    return (row?.n ?? 0) > 0;
  }

  async revokeToolGrants(toolId: string) {
    await this.db.runAsync('DELETE FROM asset_grants WHERE tool_id = ?', toolId);
  }

  async startToolRun(input: { toolId: string; workflowId: string; revisionId: number }) {
    const result = await this.db.runAsync(
      "INSERT INTO tool_runs (tool_id, workflow_id, revision_id, status, started_at) VALUES (?, ?, ?, 'running', ?)",
      input.toolId,
      input.workflowId,
      input.revisionId,
      Date.now(),
    );
    return result.lastInsertRowId;
  }

  async finishToolRun(id: number, result: Parameters<WorkspaceRepo['finishToolRun']>[1]) {
    await this.db.runAsync(
      'UPDATE tool_runs SET status = ?, error = ?, output_asset_id = ?, finished_at = ? WHERE id = ?',
      result.status,
      result.error ?? null,
      result.outputAssetId ?? null,
      Date.now(),
      id,
    );
  }

  async listPresets() {
    const rows = await this.db.getAllAsync<PresetRow>(
      'SELECT * FROM saved_presets ORDER BY created_at DESC, id DESC',
    );
    return rows.map(toPreset);
  }

  async getPreset(id: string) {
    const row = await this.db.getFirstAsync<PresetRow>(
      'SELECT * FROM saved_presets WHERE id = ?',
      id,
    );
    return row ? toPreset(row) : null;
  }

  async insertPreset(preset: SavedPreset) {
    await this.db.runAsync(
      'INSERT INTO saved_presets (id, name, schema_version, config_json, created_at) VALUES (?, ?, ?, ?, ?)',
      preset.id,
      preset.name,
      preset.schemaVersion,
      JSON.stringify(preset.config),
      preset.createdAt,
    );
  }

  async renamePreset(id: string, name: string) {
    await this.db.runAsync('UPDATE saved_presets SET name = ? WHERE id = ?', name, id);
  }

  async deletePreset(id: string) {
    await this.db.runAsync('DELETE FROM saved_presets WHERE id = ?', id);
  }

  async getMeta(key: string) {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_meta WHERE key = ?',
      key,
    );
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string) {
    await this.db.runAsync(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  async countSucceededRuns() {
    const rows = await this.db.getAllAsync<{ workflowId: string; count: number; lastAt: number }>(
      "SELECT workflow_id AS workflowId, COUNT(*) AS count, MAX(started_at) AS lastAt FROM tool_runs WHERE status = 'succeeded' GROUP BY workflow_id",
    );
    return new Map(rows.map(({ workflowId, count, lastAt }) => [workflowId, { count, lastAt }]));
  }

  async listToolRuns(limit: number) {
    const rows = await this.db.getAllAsync<ToolRunRow>(
      'SELECT * FROM tool_runs ORDER BY id DESC LIMIT ?',
      limit,
    );
    return rows.map((r): ToolRunRecord => ({
      id: r.id,
      toolId: r.tool_id,
      workflowId: r.workflow_id,
      revisionId: r.revision_id,
      status: r.status,
      error: r.error,
      outputAssetId: r.output_asset_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  async listRecords(collectionId: string) {
    const rows = await this.db.getAllAsync<RecordRow>(
      'SELECT * FROM records WHERE collection_id = ? AND deleted_at IS NULL',
      collectionId,
    );
    return rows.map(toStoredRecord);
  }

  async listRecordsInRange(collectionId: string, range: RecordRange) {
    const base = 'SELECT * FROM records WHERE collection_id = ? AND deleted_at IS NULL';
    const column = { createdAt: 'created_at', updatedAt: 'updated_at' }[range.by];
    const rows =
      column !== undefined
        ? await this.db.getAllAsync<RecordRow>(
            `${base} AND ${column} >= ? AND ${column} < ?`,
            collectionId,
            range.fromMs,
            range.untilMs,
          )
        : range.endBy
          ? await this.db.getAllAsync<RecordRow>(
              `${base} AND json_extract(values_json, ?) < ? AND (json_extract(values_json, ?) >= ? OR json_extract(values_json, ?) >= ?)`,
              collectionId,
              `$."${range.by}"`,
              range.until,
              `$."${range.by}"`,
              range.from,
              `$."${range.endBy}"`,
              range.from,
            )
          : await this.db.getAllAsync<RecordRow>(
              // Field IDs contain only lowercase letters, numbers, and hyphens; wrap in quotes when inserting into JSON paths.
              `${base} AND json_extract(values_json, ?) >= ? AND json_extract(values_json, ?) < ?`,
              collectionId,
              `$."${range.by}"`,
              range.from,
              `$."${range.by}"`,
              range.until,
            );
    return rows.map(toStoredRecord);
  }

  async getRecord(id: string) {
    const row = await this.db.getFirstAsync<RecordRow>('SELECT * FROM records WHERE id = ?', id);
    return row ? toStoredRecord(row) : null;
  }

  async insertRecord(record: DataRecord) {
    await this.db.runAsync(
      'INSERT INTO records (id, collection_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      record.id,
      record.collectionId,
      JSON.stringify(record.values),
      record.createdAt,
      record.updatedAt,
    );
  }

  async updateRecord(id: string, values: Record<string, unknown>, updatedAt: number) {
    await this.db.runAsync(
      'UPDATE records SET values_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(values),
      updatedAt,
      id,
    );
  }

  async applyRecordWrites(
    writes: readonly RecordWrite[],
    meta?: { key: string; value: string },
  ): Promise<'applied' | 'conflict'> {
    try {
      await this.db.withExclusiveTransactionAsync(async (txn) => {
        for (const w of writes) {
          if (w.kind === 'insert') {
            await txn.runAsync(
              'INSERT INTO records (id, collection_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
              w.record.id,
              w.record.collectionId,
              JSON.stringify(w.record.values),
              w.record.createdAt,
              w.record.updatedAt,
            );
            continue;
          }
          if (w.kind === 'remove') {
            const row = await txn.getFirstAsync<RecordRow>(
              'SELECT * FROM records WHERE id = ?',
              w.id,
            );
            if (
              !row ||
              row.deleted_at !== null ||
              !sameValues(toStoredRecord(row).values, w.expected)
            )
              throw new BatchConflict();
            await txn.runAsync('DELETE FROM records WHERE id = ?', w.id);
            continue;
          }
          if (w.expected) {
            const row = await txn.getFirstAsync<RecordRow>(
              'SELECT * FROM records WHERE id = ?',
              w.id,
            );
            if (
              !row ||
              row.deleted_at !== null ||
              !sameValues(toStoredRecord(row).values, w.expected)
            )
              throw new BatchConflict();
          }
          await txn.runAsync(
            'UPDATE records SET values_json = ?, updated_at = ? WHERE id = ?',
            JSON.stringify(w.values),
            w.updatedAt,
            w.id,
          );
        }
        if (meta)
          await txn.runAsync(
            'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            meta.key,
            meta.value,
          );
      });
      return 'applied';
    } catch (e) {
      if (e instanceof BatchConflict) return 'conflict';
      throw e;
    }
  }

  async updateRecordIfUnchanged(
    id: string,
    expected: Record<string, unknown>,
    values: Record<string, unknown>,
    updatedAt: number,
  ) {
    let result: 'updated' | 'conflict' | 'gone' = 'gone';
    await this.db.withExclusiveTransactionAsync(async (txn) => {
      const row = await txn.getFirstAsync<RecordRow>('SELECT * FROM records WHERE id = ?', id);
      if (!row || row.deleted_at !== null) return;
      if (!sameValues(toStoredRecord(row).values, expected)) {
        result = 'conflict';
        return;
      }
      await txn.runAsync(
        'UPDATE records SET values_json = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(values),
        updatedAt,
        id,
      );
      result = 'updated';
    });
    return result;
  }

  async deleteRecord(id: string, deletedAt: number) {
    await this.db.runAsync('UPDATE records SET deleted_at = ? WHERE id = ?', deletedAt, id);
  }

  async restoreRecord(id: string) {
    await this.db.runAsync('UPDATE records SET deleted_at = NULL WHERE id = ?', id);
  }

  async listDeletedRecords() {
    const rows = await this.db.getAllAsync<RecordRow>(
      'SELECT * FROM records WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    );
    return rows.map(toStoredRecord);
  }

  async purgeDeletedRecords(before: number) {
    const result = await this.db.runAsync(
      'DELETE FROM records WHERE deleted_at IS NOT NULL AND deleted_at < ?',
      before,
    );
    return result.changes;
  }

  async countRecords() {
    return this.db.getAllAsync<{ collectionId: string; count: number }>(
      'SELECT collection_id AS collectionId, COUNT(*) AS count FROM records WHERE deleted_at IS NULL GROUP BY collection_id',
    );
  }

  async purgeCollection(collectionId: string) {
    await this.db.runAsync('DELETE FROM records WHERE collection_id = ?', collectionId);
  }

  async importRecords(
    batch: Omit<RecordImport, 'count' | 'present'>,
    records: readonly DataRecord[],
  ) {
    await this.db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync(
        'INSERT INTO record_imports (id, collection_id, file_name, record_count, created_at) VALUES (?, ?, ?, ?, ?)',
        batch.id,
        batch.collectionId,
        batch.fileName,
        records.length,
        batch.createdAt,
      );
      for (const r of records) {
        await txn.runAsync(
          'INSERT INTO records (id, collection_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          r.id,
          r.collectionId,
          JSON.stringify(r.values),
          r.createdAt,
          r.updatedAt,
        );
        await txn.runAsync(
          'INSERT INTO import_items (import_id, record_id) VALUES (?, ?)',
          batch.id,
          r.id,
        );
      }
    });
  }

  async listImports(collectionId: string) {
    const rows = await this.db.getAllAsync<ImportRow>(
      `SELECT i.id, i.collection_id, i.file_name, i.record_count, i.created_at,
         (SELECT COUNT(*) FROM import_items m JOIN records r ON r.id = m.record_id
           WHERE m.import_id = i.id AND r.deleted_at IS NULL) AS present
       FROM record_imports i WHERE i.collection_id = ? ORDER BY i.created_at DESC, i.rowid DESC`,
      collectionId,
    );
    return rows.map((r): RecordImport => ({
      id: r.id,
      collectionId: r.collection_id,
      fileName: r.file_name,
      count: r.record_count,
      present: r.present,
      createdAt: r.created_at,
    }));
  }

  async deleteImport(id: string, deletedAt: number) {
    const result = await this.db.runAsync(
      `UPDATE records SET deleted_at = ? WHERE deleted_at IS NULL
         AND id IN (SELECT record_id FROM import_items WHERE import_id = ?)`,
      deletedAt,
      id,
    );
    return result.changes;
  }
}

interface ImportRow {
  id: string;
  collection_id: string;
  file_name: string;
  record_count: number;
  created_at: number;
  present: number;
}

interface AssetRow {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  path: string;
  source: AssetRecord['source'];
  created_at: number;
}

function toAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    path: row.path,
    source: row.source,
    createdAt: row.created_at,
  };
}

interface ToolRunRow {
  id: number;
  tool_id: string;
  workflow_id: string;
  revision_id: number;
  status: ToolRunRecord['status'];
  error: string | null;
  output_asset_id: string | null;
  started_at: number;
  finished_at: number | null;
}

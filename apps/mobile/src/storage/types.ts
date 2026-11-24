import type { DataRecord, WorkspaceConfig } from '@morph/core';

// Local storage contract (M1/M2 treating device-local as the sole authoritative source, §5.4).
// SQLite implementation is used for the app, memory implementation for tests; both must satisfy
// identical semantics.

/** A single write operation for applyRecordWrites. */
export type RecordWrite =
  | { kind: 'insert'; record: DataRecord }
  | {
      kind: 'update';
      id: string;
      values: Record<string, unknown>;
      updatedAt: number;
      /** If provided, requires the current stored value to still match this version, otherwise rejects the entire batch. */
      expected?: Record<string, unknown>;
    }
  /**
   * Undo a newly created record (D-566, D-567): hard delete, bypassing the Recycle Bin (it is a
   * tool-generated value, not user-input content, D-303). Requires the current stored value to
   * still match expected (its state upon creation), otherwise rejects the entire batch.
   */
  | { kind: 'remove'; id: string; expected: Record<string, unknown> };

export type RevisionSource = 'seed' | 'ai' | 'user' | 'restore' | 'rollback' | 'recovery';

export interface RevisionRecord {
  id: number;
  parentId: number | null;
  schemaVersion: number;
  /** Raw JSON: must pass through prepareSnapshot (migration + validation) before use after reading. */
  config: unknown;
  source: RevisionSource;
  summary: string;
  createdAt: number;
}

export type ChangeStatus =
  'previewing' | 'committed' | 'cancelled' | 'rejected' | 'failed' | 'rolled_back';

export interface ChangeRequestRecord {
  id: number;
  input: string;
  plan: unknown;
  status: ChangeStatus;
  baseRevisionId: number | null;
  resultRevisionId: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expectedBase: number | null,
    readonly actualHead: number | null,
  ) {
    super(`workspace changed: expected head ${expectedBase}, found ${actualHead}`);
  }
}

export interface CommitInput {
  /** Head revision seen when generating this change; commit fails if it differs from the current head (§7D baseRevision). */
  baseId: number | null;
  config: WorkspaceConfig;
  source: RevisionSource;
  summary: string;
}

/**
 * User file (§6 UserAsset): belongs to the workspace, not restored with version rollbacks, and
 * neither rollbacks nor tool uninstalls will delete it; can only be deleted by the user in
 * Settings -> Storage (D-264).
 */
export interface AssetRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Path relative to the app documents directory. */
  path: string;
  source: 'picked' | 'generated';
  createdAt: number;
}

export type ToolRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Workflow execution record (§6 ToolRun): records status and error codes only, excluding file contents. */
export interface ToolRunRecord {
  id: number;
  toolId: string;
  workflowId: string;
  revisionId: number;
  status: ToolRunStatus;
  error: string | null;
  outputAssetId: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** A single user data record (docs/DATA_DESIGN.md). Belongs to no version: undo and restore operations never modify it. */
export interface StoredRecord extends DataRecord {
  /** Soft deletion timestamp; null indicates active. */
  deletedAt: number | null;
}

/**
 * User-saved preset (D-410): a kernel configuration snapshot without records or file references.
 * Exists locally only and is not part of configuration, so it is never sent to cloud AI
 * (Invariants 1, 2).
 */
export interface SavedPreset {
  id: string;
  name: string;
  createdAt: number;
  schemaVersion: number;
  /** Raw JSON: may be an older version; must pass through preparePreset (migration + validation) before use after reading. */
  config: unknown;
}

export type SucceededRuns = Map<string, { count: number; lastAt: number }>;

export interface WorkspaceRepo {
  getHead(): Promise<RevisionRecord | null>;
  getRevision(id: number): Promise<RevisionRecord | null>;
  /** Retrieve up to limit versions from newest to oldest; if beforeId is provided, retrieve only versions older than it (pagination: next page uses the ID of the last item on the previous page). */
  /** Retrieve up to limit versions from newest to oldest; if beforeId is provided, retrieve only versions older than it (pagination: next page uses the ID of the last item on the previous page). */
  listRevisions(limit: number, beforeId?: number): Promise<RevisionRecord[]>;
  /** Atomic operation: check head, write new revision, advance head. Throws RevisionConflictError on conflict. */
  commitRevision(input: CommitInput): Promise<RevisionRecord>;

  createChangeRequest(input: {
    input: string;
    plan: unknown;
    status: ChangeStatus;
    baseRevisionId: number | null;
    error?: string;
  }): Promise<number>;
  updateChangeRequest(
    id: number,
    patch: { status: ChangeStatus; resultRevisionId?: number; error?: string },
  ): Promise<void>;
  getChangeRequest(id: number): Promise<ChangeRequestRecord | null>;

  addAsset(asset: AssetRecord): Promise<void>;
  getAsset(id: string): Promise<AssetRecord | null>;
  /** Retrieve up to limit versions from newest to oldest; if beforeId is provided, retrieve only versions older than it (pagination: next page uses the ID of the last item on the previous page). */
  listAssets(): Promise<AssetRecord[]>;
  /**
   * Permanently delete a user file record and its permissions (Settings -> Storage, D-264);
   * clears references in execution logs. The physical file on disk is removed by
   * FilePlatform.removeAssetFile (deleteUserFiles in storage/user-files.ts performs both steps
   * together).
   */
  deleteAsset(id: string): Promise<void>;
  /** Rename a user-visible file name (Rename in all files view): physical files on disk, thumbnails, and intermediate formats remain unchanged. */
  renameAsset(id: string, name: string): Promise<void>;

  /** AssetGrant (§7G): tools can only read files explicitly granted to them. */
  grantAsset(toolId: string, assetId: string): Promise<void>;
  hasGrant(toolId: string, assetId: string): Promise<boolean>;
  /** Uninstalling a tool removes its permissions only, without deleting files. */
  revokeToolGrants(toolId: string): Promise<void>;

  startToolRun(input: { toolId: string; workflowId: string; revisionId: number }): Promise<number>;
  finishToolRun(
    id: number,
    result: { status: Exclude<ToolRunStatus, 'running'>; error?: string; outputAssetId?: string },
  ): Promise<void>;
  listToolRuns(limit: number): Promise<ToolRunRecord[]>;
  countSucceededRuns(): Promise<SucceededRuns>;

  // ---- Device-local settings (not part of configuration, excluded from versioning, e.g., usage statistics D-127) ----
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  // ---- Saved presets (D-410): managed exclusively by the user in Settings -> My Presets ----
  /** Retrieve up to limit versions from newest to oldest; if beforeId is provided, retrieve only versions older than it (pagination: next page uses the ID of the last item on the previous page). */
  listPresets(): Promise<SavedPreset[]>;
  getPreset(id: string): Promise<SavedPreset | null>;
  insertPreset(preset: SavedPreset): Promise<void>;
  renamePreset(id: string, name: string): Promise<void>;
  deletePreset(id: string): Promise<void>;

  // ---- User records: read and written solely via user page actions, never processed by AI ----
  /** Active (non-deleted) records in a given table (order is not guaranteed, sorted by caller). */
  listRecords(collectionId: string): Promise<DataRecord[]>;
  /**
   * Read records within a date range only (calendar month view, D-305): when querying by date or
   * datetime fields, matches stored text via from <= value < until; when querying by createdAt or
   * updatedAt, matches timestamps via fromMs <= time < untilMs.
   */
  listRecordsInRange(collectionId: string, range: RecordRange): Promise<DataRecord[]>;
  getRecord(id: string): Promise<StoredRecord | null>;
  insertRecord(record: DataRecord): Promise<void>;
  updateRecord(id: string, values: Record<string, unknown>, updatedAt: number): Promise<void>;
  /**
   * Conditional write (R05): writes only if the currently stored record value still matches
   * expected (the state when the form was opened); returns 'conflict' and skips writing if
   * modified elsewhere; returns 'gone' if missing or in the Recycle Bin. Check and write occur
   * within a single transaction without interleaving writes.
   */
  updateRecordIfUnchanged(
    id: string,
    expected: Record<string, unknown>,
    values: Record<string, unknown>,
    updatedAt: number,
  ): Promise<'updated' | 'conflict' | 'gone'>;
  /**
   * Writes multiple record updates (and an optional flag) atomically within a single
   * transaction—all succeed or all fail (R06, R09). Throws an error and rolls back prior writes
   * if any single write fails; returns 'conflict' if expected values mismatch (modified or
   * deleted) for updates carrying an expected state, rejecting the entire batch. meta is a flag
   * that takes effect alongside the writes (e.g., "this tap has been processed").
   */
  applyRecordWrites(
    writes: readonly RecordWrite[],
    meta?: { key: string; value: string },
  ): Promise<'applied' | 'conflict'>;
  /** Soft delete: undoable, retained in the Recycle Bin for 30 days. */
  deleteRecord(id: string, deletedAt: number): Promise<void>;
  restoreRecord(id: string): Promise<void>;
  /** Recently deleted items first. */
  listDeletedRecords(): Promise<StoredRecord[]>;
  /** Permanently purge records soft-deleted before the specified timestamp, returning the count of cleared records. */
  purgeDeletedRecords(before: number): Promise<number>;
  /** Active (non-deleted) record count per table (including tables no longer present in configuration). */
  countRecords(): Promise<{ collectionId: string; count: number }[]>;
  /** Permanently delete all records of a table upon user confirmation. */
  purgeCollection(collectionId: string): Promise<void>;

  // ---- Import from spreadsheet files (D-574): operated exclusively by the user in Settings -> Data ----
  /** Write these records and the batch marker within a single transaction—all succeed or all fail. */
  importRecords(
    batch: Omit<RecordImport, 'count' | 'present'>,
    records: readonly DataRecord[],
  ): Promise<void>;
  /** Imports for a table, newest first (including those with present count of 0, leaving visibility decisions to the caller). */
  listImports(collectionId: string): Promise<RecordImport[]>;
  /**
   * Undo an import and delete the batch: soft-deletes active records currently in this batch
   * (moving to Recycle Bin for 30 days, matching individual deletion), including any subsequent
   * modifications; excludes already deleted records. Returns the number of deleted records.
   */
  deleteImport(id: string, deletedAt: number): Promise<number>;
}

/**
 * A batch of records imported from a spreadsheet file (D-574): stored solely in the local
 * database, excluded from configuration and version rollbacks, and never sent to AI (Invariants
 * 1, 2, 14). The file name is solely for user reference regarding the import session.
 */
export interface RecordImport {
  id: string;
  collectionId: string;
  fileName: string;
  /** Number of items written during import. */
  count: number;
  /** Number of items currently present (not deleted and not in Recycle Bin). */
  present: number;
  createdAt: number;
}

/** Range specification for listRecordsInRange (core's monthQueryRange plus target field specification). */
export interface RecordRange {
  /** Cross-day records: read as long as start and end overlap with the range. */
  endBy?: string | undefined;
  by: string;
  from: string;
  until: string;
  fromMs: number;
  untilMs: number;
}

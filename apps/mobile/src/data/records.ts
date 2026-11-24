import {
  RECORD_LIMITS,
  expandCollection,
  linkedCollectionIds,
  loadComputedRecords,
  loadLinkResolver,
  monthQueryRange,
  dayQueryRange,
  type DayRange,
  prepareRecordValues,
  relatedCollectionIds,
  type Calendar,
  type Collection,
  type DataRecord,
  type FieldIssue,
  type LinkResolver,
} from '@morph/core';
import { useEffect, useMemo, useState } from 'react';

import { t } from '../i18n';
import { newAssetId } from '../runtime/ids';
import type { StoredRecord, WorkspaceRepo } from '../storage/types';
import { useCalendar, useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { RecordToast, WorkspaceState } from '../workspace/store/types';

// Read and write operations for user records. Triggered exclusively by user actions on pages,
// writing directly to the database without passing through AI or generating versions
// (`docs/DATA_DESIGN.md`). The AI only receives `WorkspaceConfig`, while records never enter the
// configuration.

/**
 * Current version of a table (D-555): the count of "unknown table write" events plus the table's
 * own write count. Changes only after this specific table (or any table) is modified.
 */
export const tableVersion = (s: WorkspaceState, collectionId: string) =>
  `${s.recordsAll}.${s.tableVersions[collectionId] ?? 0}`;

/**
 * Used by components reading these tables: joins their versions into a string, changing only
 * after any of the tables is written (if other tables change, components do not re-render).
 * Returns table ID -> version map. `ids` must be stable (`useMemo`), producing identical results
 * when order and content match.
 */
function useTableVersions(ids: readonly string[]): ReadonlyMap<string, string> {
  const key = useWorkspace((s) => ids.map((id) => tableVersion(s, id)).join(','));
  return useMemo(() => {
    const versions = key.split(',');
    return new Map(ids.map((id, i) => [id, versions[i] ?? '']));
  }, [ids, key]);
}

/**
 * Reading table records. Multiple components reading simultaneously within the same version
 * (`tableVersion`) share a single read operation, discarding results afterward (R13): after a
 * write, all components displaying this table re-read together rather than each component
 * re-reading the entire table individually. Sharing applies only to ongoing reads: different
 * versions are not shared (reads after a write always start post-write), and completed reads are
 * not cached (subsequent writes elsewhere remain visible). Each component receives its own array
 * (record objects are shared, read-only).
 */
const tableReads = new WeakMap<WorkspaceRepo, Map<string, Promise<DataRecord[]>>>();

export function readTable(
  repo: WorkspaceRepo,
  version: number | string,
  collectionId: string,
): Promise<DataRecord[]> {
  let reads = tableReads.get(repo);
  if (!reads) tableReads.set(repo, (reads = new Map()));
  const key = `${version}|${collectionId}`;
  let read = reads.get(key);
  if (!read) {
    const started = repo.listRecords(collectionId);
    read = started;
    reads.set(key, started);
    const done = () => {
      if (reads.get(key) === started) reads.delete(key);
    };
    started.then(done, done);
  }
  return read.then((rows) => rows.slice());
}

/** Reads according to table versions (sharing ongoing reads); tables absent from `versions` are read directly without sharing. */
const readAt =
  (repo: WorkspaceRepo, versions: ReadonlyMap<string, string>) =>
  (id: string): Promise<DataRecord[]> => {
    const version = versions.get(id);
    return version === undefined ? repo.listRecords(id) : readTable(repo, version, id);
  };

/**
 * Computed records for a table (lookups, rollups, previous entry, D-291). Multiple blocks reading
 * this table on the same page share a single computation (D-555). Like `readTable`, sharing
 * applies only to ongoing computations: shared only when all target tables have identical
 * versions, use the same configuration (a different one during draft preview), and share calendar
 * settings; discarded after computation finishes. Each block receives its own array (record
 * objects are shared, read-only).
 */
interface Computation {
  collections: readonly Collection[];
  collection: Collection;
  result: Promise<{ view: Collection; records: DataRecord[] }>;
}
const computations = new WeakMap<WorkspaceRepo, Map<string, Computation>>();

function computeTable(
  repo: WorkspaceRepo,
  versions: ReadonlyMap<string, string>,
  collections: readonly Collection[],
  collection: Collection,
  calKey: string,
): Promise<{ view: Collection; records: DataRecord[] }> {
  let running = computations.get(repo);
  if (!running) computations.set(repo, (running = new Map()));
  const key = `${collection.id}|${[...versions].join(';')}|${calKey}`;
  let entry = running.get(key);
  if (!entry || entry.collections !== collections || entry.collection !== collection) {
    const started: Computation = {
      collections,
      collection,
      result: loadComputedRecords(
        readAt(repo, versions),
        collections,
        collection,
        new Date(),
        JSON.parse(calKey) as Calendar,
      ),
    };
    entry = started;
    running.set(key, started);
    const done = () => {
      if (running.get(key) === started) running.delete(key);
    };
    started.result.then(done, done);
  }
  return entry.result.then((r) => ({ view: r.view, records: r.records.slice() }));
}

/** All undeleted records of a table; automatically refreshed after records are added, deleted, or modified. Null indicates loading is in progress. */
export function useRecords(collectionId: string): DataRecord[] | null {
  const { repo } = useWorkspaceContext();
  const version = useWorkspace((s) => tableVersion(s, collectionId));
  const [records, setRecords] = useState<DataRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    void readTable(repo, version, collectionId).then((r) => alive && setRecords(r));
    return () => {
      alive = false;
    };
  }, [repo, collectionId, version]);
  return records;
}

/** Tables required for computing a table (itself, plus tables required by lookups, rollups, previous entry, and formulas: `relatedCollectionIds`). */
const NO_TABLES: readonly string[] = [];
function useRelatedIds(collections: readonly Collection[], collection: Collection | undefined) {
  return useMemo(
    () => (collection ? relatedCollectionIds(collections, collection) : NO_TABLES),
    [collections, collection],
  );
}

/**
 * A table's records along with computed values for lookups, rollups, and previous entries (D-291,
 * calculated locally via `related.ts`), plus display tables (replacing those field types with
 * their display equivalents). Reads records of dependent tables; recalculates when those tables
 * are modified or table definitions change (D-555: writes to unrelated tables do not trigger
 * recalculation). `collections` and `cal` use the page's active configuration (the draft during
 * draft preview). Record writing still uses the original tables.
 */
export function useComputedRecords(
  collections: readonly Collection[],
  collection: Collection | undefined,
  cal: Calendar,
): { view: Collection | undefined; records: DataRecord[] | null } {
  const { repo } = useWorkspaceContext();
  const versions = useTableVersions(useRelatedIds(collections, collection));
  const [loaded, setLoaded] = useState<{ view: Collection; records: DataRecord[] } | null>(null);
  const calKey = JSON.stringify(cal);
  useEffect(() => {
    if (!collection) return;
    let alive = true;
    void computeTable(repo, versions, collections, collection, calKey).then(
      (r) => alive && setLoaded(r),
    );
    return () => {
      alive = false;
    };
  }, [repo, collections, collection, calKey, versions]);
  const view = useMemo(
    () => collection && expandCollection(collections, collection),
    [collections, collection],
  );
  // After switching tables, the old instance is no longer used.
  return { view, records: loaded && loaded.view === view ? loaded.records : null };
}

/**
 * Records for the calendar (D-305): read according to the day range of a month or week (reads an
 * extra day, see monthQueryRange / dayQueryRange), with cross-day records read based on overlap.
 * When the table involves lookups, aggregates, or previous-record references requiring other
 * records to compute, reads the entire table and then computes (same as useComputedRecords); also
 * reads the entire table when dateField is not a stored date, datetime, or system field. The
 * caller precisely partitions records into calendar days and filters using recordDay.
 */
export function useMonthRecords(
  collections: readonly Collection[],
  collection: Collection | undefined,
  dateField: string,
  month: string,
  cal: Calendar,
  options?: { range?: DayRange; until?: string | undefined },
): { view: Collection | undefined; records: DataRecord[] | null } {
  const { repo } = useWorkspaceContext();
  const version = [...useTableVersions(useRelatedIds(collections, collection)).values()].join(',');
  const [loaded, setLoaded] = useState<{
    key: string;
    view: Collection;
    records: DataRecord[];
  } | null>(null);
  const calKey = JSON.stringify(cal);
  const rangeKey = options?.range ? `${options.range.start}|${options.range.end}` : '';
  const endBy = options?.until;
  const key = `${month}|${dateField}|${rangeKey}|${endBy ?? ''}`;
  useEffect(() => {
    if (!collection) return;
    let alive = true;
    const stored =
      dateField === 'createdAt' ||
      dateField === 'updatedAt' ||
      collection.fields.some(
        (f) => f.id === dateField && (f.type === 'date' || f.type === 'datetime'),
      );
    // Lookups, rollups, and previous entries require other records (the previous entry might be in the previous month); formulas only depend on the current entry, allowing month-only reads.
    const whole =
      !stored ||
      collection.fields.some(
        (f) => f.type === 'lookup' || f.type === 'rollup' || f.type === 'previous',
      );
    const [start, end] = rangeKey.split('|');
    const range = {
      by: dateField,
      ...(start && end ? dayQueryRange({ start, end }) : monthQueryRange(month)),
      endBy,
    };
    void loadComputedRecords(
      (id) =>
        whole || id !== collection.id ? repo.listRecords(id) : repo.listRecordsInRange(id, range),
      collections,
      collection,
      new Date(),
      JSON.parse(calKey) as Calendar,
    ).then((r) => alive && setLoaded({ key, ...r }));
    return () => {
      alive = false;
    };
  }, [repo, collections, collection, calKey, version, key, dateField, month, rangeKey, endBy]);
  const view = useMemo(
    () => collection && expandCollection(collections, collection),
    [collections, collection],
  );
  return {
    view,
    records: loaded && loaded.view === view && loaded.key === key ? loaded.records : null,
  };
}

/**
 * Reference fields (D-250) displaying referenced record titles: reads records of tables
 * referenced by this table (undeleted ones), refreshing when those tables change (D-555). Deleted
 * referenced records cannot be found and display "Deleted record"; they become queryable again
 * upon restoration.
 */
export function useLinkResolver(collection: Collection | undefined): LinkResolver | undefined {
  const { repo, locale } = useWorkspaceContext();
  const collections = useWorkspace((s) => s.config?.data.tables);
  const linked = useMemo(
    () => (collection ? linkedCollectionIds(collection) : NO_TABLES),
    [collection],
  );
  const versions = useTableVersions(linked);
  const targets = linked.join(',');
  // Tracks the tables for which readers were initialized: after switching tables, old readers are discarded.
  const [loaded, setLoaded] = useState<{ targets: string; resolver: LinkResolver } | null>(null);
  useEffect(() => {
    if (!targets || !collections) return;
    let alive = true;
    void loadLinkResolver(readAt(repo, versions), collections, targets.split(','), locale).then(
      (resolver) => alive && setLoaded({ targets, resolver }),
    );
    return () => {
      alive = false;
    };
  }, [repo, collections, targets, locale, versions]);
  return loaded && loaded.targets === targets ? loaded.resolver : undefined;
}

/** Result of creating a new record entry. */
export type AddResult =
  { ok: true; id: string } | { ok: false; issues: FieldIssue[] } | { ok: false; full: true };

export type SaveResult =
  | AddResult
  /** The record was modified elsewhere after being opened (R05): not saved; `latest` is the currently stored version. */
  | { ok: false; conflict: StoredRecord }
  /** The record no longer exists (has been deleted): not saved. */
  | { ok: false; gone: true };

export function useRecordActions() {
  const { repo, locale } = useWorkspaceContext();
  const bump = useWorkspace((s) => s.bumpRecords);
  const showToast = useWorkspace((s) => s.showToast);
  const cal = useCalendar();

  async function update(
    collection: Collection,
    record: DataRecord,
    input: Record<string, unknown>,
  ): Promise<SaveResult> {
    const now = new Date();
    const prepared = prepareRecordValues(collection, input, record.values, now, cal);
    if (!prepared.ok) return { ok: false, issues: prepared.issues };
    // Writes only if the record still matches the initial version (when the form was opened): prevents overwriting if modified elsewhere during this time by other entry points (notification buttons, widgets) (R05).
    const written = await repo.updateRecordIfUnchanged(
      record.id,
      record.values,
      prepared.values,
      now.getTime(),
    );
    if (written === 'gone') return { ok: false, gone: true };
    if (written === 'conflict') {
      const latest = await repo.getRecord(record.id);
      if (!latest || latest.deletedAt !== null) return { ok: false, gone: true };
      return { ok: false, conflict: latest };
    }
    bump([record.collectionId]);
    return { ok: true, id: record.id };
  }

  return {
    async add(collection: Collection, input: Record<string, unknown>): Promise<AddResult> {
      const counts = await repo.countRecords();
      const count = counts.find((c) => c.collectionId === collection.id)?.count ?? 0;
      if (count >= RECORD_LIMITS.perCollection) return { ok: false, full: true };
      const now = new Date();
      const prepared = prepareRecordValues(collection, input, null, now, cal);
      if (!prepared.ok) return { ok: false, issues: prepared.issues };
      const id = newAssetId();
      await repo.insertRecord({
        id,
        collectionId: collection.id,
        values: prepared.values,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      });
      bump([collection.id]);
      return { ok: true, id };
    },

    update,

    /**
     * Modifies specific fields of a record (e.g., checking an item in a list): updates based on
     * the currently stored version, modifying only items in `input`, while keeping concurrently
     * modified fields up to date. Re-reads if modified between read and write (up to three
     * times).
     */
    async patch(
      collection: Collection,
      id: string,
      input: Record<string, unknown>,
    ): Promise<SaveResult> {
      let result: SaveResult = { ok: false, gone: true };
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await repo.getRecord(id);
        if (!stored || stored.deletedAt !== null) return { ok: false, gone: true };
        result = await update(collection, stored, input);
        if (!('conflict' in result)) return result;
      }
      return result;
    },

    /** Soft delete, allowing undo from the toast message. */
    async remove(record: DataRecord): Promise<void> {
      await repo.deleteRecord(record.id, Date.now());
      bump([record.collectionId]);
      showToast({ message: t(locale, 'recordDeleted'), restoreRecordId: record.id });
    },

    // Restoration requires only the record ID: reloads all tables together (D-555).
    async restore(id: string): Promise<void> {
      await repo.restoreRecord(id);
      bump();
    },

    /**
     * Undoes multi-field edits or batch creations (D-566, D-567): single transaction, requiring
     * each entry to still match its post-completion state; aborts and notifies if modified.
     */
    async undo(undo: NonNullable<RecordToast['undo']>): Promise<void> {
      let outcome: 'applied' | 'conflict';
      try {
        outcome = await repo.applyRecordWrites(undo.writes);
      } catch {
        outcome = 'conflict';
      }
      if (outcome === 'conflict') showToast({ message: t(locale, undo.failed) });
      else bump(undo.tables);
    },

    /**
     * Undoes an import batch (D-574): soft deletes still-existing records from this batch into
     * "Recently deleted" for 30 days (imported items are user content, unlike hard-deleted batch
     * creations).
     */
    async undoImport(batch: NonNullable<RecordToast['undoImport']>): Promise<void> {
      await repo.deleteImport(batch.id, Date.now());
      bump([batch.table]);
      showToast({ message: t(locale, 'importUndone') });
    },

    /** Restores multiple simultaneously deleted entries together (D-547). */
    async restoreMany(ids: readonly string[]): Promise<void> {
      for (const id of ids) await repo.restoreRecord(id);
      bump();
    },
  };
}

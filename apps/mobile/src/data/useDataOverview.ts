import {
  localDate,
  appConfigFile,
  appConfigFileName,
  LAYOUT_STORE_KEY,
  layoutCount,
  layoutStoreFile,
  parseLayoutStore,
  parsePickStore,
  PICK_STORE_KEY,
  pickCount,
  readLayoutStoreFile,
  readPickStoreFile,
  RECORD_LIMITS,
  serializeLayoutStore,
  serializePickStore,
  calendarOf,
  linkedCollectionIds,
  loadComputedRecords,
  loadLinkResolver,
  recordsToCsv,
  type Collection,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { useRecordActions } from '@/data/records';
import { t } from '@/i18n';
import { usePalette } from '@/renderer/theme';
import { useWorkflowChange } from '@/run/workflow-change';
import { findRevisionTables } from '@/storage/revision-pages';
import type { RecordImport, StoredRecord } from '@/storage/types';
import { useWorkspace, useWorkspaceContext } from '@/workspace/context';

/**
 * Data and operations shared between "Settings -> Data" and its subpages (previously all in
 * data.tsx before being split into several pages in D-614): row counts and import batches for
 * each table, tables not in the UI, recently deleted entries, fill history; CSV export, app
 * design export, restore and clearing fill history, etc. Provided by the core, cannot be modified
 * by the AI (invariant 8).
 */
export function useDataOverview() {
  const { repo, files, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const version = useWorkspace((s) => s.recordsVersion);
  const bump = useWorkspace((s) => s.bumpRecords);
  const palette = usePalette(config.theme);
  const actions = useRecordActions();
  const change = useWorkflowChange();
  const router = useRouter();
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [orphans, setOrphans] = useState<
    { collection: Collection | null; id: string; count: number }[]
  >([]);
  const [deleted, setDeleted] = useState<StoredRecord[]>([]);
  // Import batches for each table from files (D-574), keeping only those with remaining records.
  const [imports, setImports] = useState<Map<string, RecordImport[]>>(new Map());
  const [known, setKnown] = useState<Map<string, Collection>>(new Map());
  const [layouts, setLayouts] = useState(0);
  // Candidates tapped in the new record form (D-394): one per field.
  const [picks, setPicks] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = await repo.countRecords();
      const deletedRows = await repo.listDeletedRecords();
      // Data tables removed from the UI: retrieve their structure from version history (versions are append-only, never deleted).
      const missing = new Set(
        [...rows.map((r) => r.collectionId), ...deletedRows.map((r) => r.collectionId)].filter(
          (id) => !config.data.tables.some((c) => c.id === id),
        ),
      );
      const found = await findRevisionTables(repo, missing);
      const batches = new Map<string, RecordImport[]>();
      for (const c of config.data.tables)
        batches.set(
          c.id,
          (await repo.listImports(c.id)).filter((b) => b.present > 0),
        );
      if (!alive) return;
      setImports(batches);
      setCounts(new Map(rows.map((r) => [r.collectionId, r.count])));
      setOrphans(
        rows
          .filter((r) => missing.has(r.collectionId))
          .map((r) => ({
            id: r.collectionId,
            count: r.count,
            collection: found.get(r.collectionId) ?? null,
          })),
      );
      // Records exceeding the retention period but not yet cleared at the next startup are no longer displayed.
      const cutoff = Date.now() - RECORD_LIMITS.deletedRetentionDays * 24 * 60 * 60 * 1000;
      setDeleted(deletedRows.filter((r) => r.deletedAt! >= cutoff));
      setKnown(new Map([...found, ...config.data.tables.map((c) => [c.id, c] as const)]));
      setLayouts(layoutCount(parseLayoutStore(await repo.getMeta(LAYOUT_STORE_KEY))));
      setPicks(pickCount(parsePickStore(await repo.getMeta(PICK_STORE_KEY))));
    })();
    return () => {
      alive = false;
    };
  }, [repo, config, version]);

  async function exportCsv(collection: Collection) {
    // Values computed by finding, summarizing, or previous exports (D-291).
    const { view, records } = await loadComputedRecords(
      (id) => repo.listRecords(id),
      config.data.tables,
      collection,
      new Date(),
      calendarOf(config),
    );
    records.sort((a, b) => a.createdAt - b.createdAt);
    // Titles of referenced records exported by reference fields (D-250).
    const links = await loadLinkResolver(
      (id) => repo.listRecords(id),
      config.data.tables,
      linkedCollectionIds(view),
      locale,
    );
    await files.shareText(
      `${collection.name}.csv`,
      recordsToCsv(view, records, locale, links),
      'text/csv',
    );
  }

  /** Date in the filename (local time), ensuring multiple exports do not overwrite each other. */

  async function exportConfig() {
    const now = new Date();
    await files.shareText(appConfigFileName(now), appConfigFile(config, now), 'application/json');
  }

  async function exportMemory() {
    const now = new Date();
    const store = parseLayoutStore(await repo.getMeta(LAYOUT_STORE_KEY));
    const tapped = parsePickStore(await repo.getMeta(PICK_STORE_KEY));
    await files.shareText(
      `tinkrum-prefill-memory-${localDate(now)}.json`,
      layoutStoreFile(store, now, tapped),
      'application/json',
    );
  }

  async function restoreMemory() {
    const picked = await files.pickDocuments(['application/json', 'text/plain'], false);
    const file = picked?.[0];
    if (!file) return;
    let store = null;
    let fromFile = null;
    try {
      const text = await files.readPickedText(file.uri);
      store = readLayoutStoreFile(text);
      fromFile = readPickStoreFile(text);
    } catch {
      store = null;
    }
    if (!store) {
      Alert.alert(t(locale, 'prefillMemoryRestore'), t(locale, 'prefillMemoryRestoreInvalid'));
      return;
    }
    const count = layoutCount(store);
    Alert.alert(
      t(locale, 'prefillMemoryRestore'),
      t(locale, 'prefillMemoryRestoreConfirm', { count }),
      [
        { text: t(locale, 'cancel'), style: 'cancel' },
        {
          text: t(locale, 'prefillMemoryRestore'),
          onPress: () =>
            void repo
              .setMeta(LAYOUT_STORE_KEY, serializeLayoutStore(store))
              .then(() => repo.setMeta(PICK_STORE_KEY, serializePickStore(fromFile ?? {})))
              .then(() => {
                setLayouts(count);
                setPicks(pickCount(fromFile ?? {}));
                Alert.alert(t(locale, 'prefillMemoryRestored', { count }));
              }),
        },
      ],
    );
  }

  /** "Auto-read attachments" on the table (D-397): enabled by default, not written unless disabled (written as false). Can be undone in change history. */
  const setReadAttachments = (c: Collection, on: boolean) =>
    change(
      [{ op: 'updateData', table: c.id, changes: { readAttachments: on ? null : false } }],
      t(locale, on ? 'describeReadAttachmentsOn' : 'describeReadAttachmentsOff', { name: c.name }),
    );

  /** "Attachment is" on the table (D-421): others are not written, only generic rules. */
  const setPrefillRules = (c: Collection, rules: Collection['prefillRules']) =>
    change(
      [{ op: 'updateData', table: c.id, changes: { prefillRules: rules ?? null } }],
      t(
        locale,
        rules === 'receipt'
          ? 'describePrefillRulesReceipt'
          : rules === 'card'
            ? 'describePrefillRulesCard'
            : 'describePrefillRulesGeneral',
        { name: c.name },
      ),
    );

  function clearMemory() {
    Alert.alert(t(locale, 'prefillMemoryClear'), t(locale, 'prefillMemoryClearConfirm'), [
      { text: t(locale, 'cancel'), style: 'cancel' },
      {
        text: t(locale, 'prefillMemoryClear'),
        style: 'destructive',
        onPress: () =>
          void repo
            .setMeta(LAYOUT_STORE_KEY, serializeLayoutStore({}))
            .then(() => repo.setMeta(PICK_STORE_KEY, serializePickStore({})))
            .then(() => {
              setLayouts(0);
              setPicks(0);
            }),
      },
    ]);
  }

  /** Delete an import batch (D-574): prompt first; records from this batch that still exist go to "Recently deleted" for 30 days, along with any modified later. */
  function deleteImport(c: Collection, batch: RecordImport) {
    Alert.alert(
      t(locale, 'importDeleteBatch'),
      t(locale, 'importDeleteBatchConfirm', { n: batch.present, file: batch.fileName }),
      [
        { text: t(locale, 'cancel'), style: 'cancel' },
        {
          text: t(locale, 'delete'),
          style: 'destructive',
          onPress: () => void repo.deleteImport(batch.id, Date.now()).then(() => bump([c.id])),
        },
      ],
    );
  }

  function deleteForever(id: string, name: string, count: number) {
    Alert.alert(t(locale, 'deleteForever'), t(locale, 'deleteForeverConfirm', { name, count }), [
      { text: t(locale, 'cancel'), style: 'cancel' },
      {
        text: t(locale, 'deleteForever'),
        style: 'destructive',
        onPress: () => void repo.purgeCollection(id).then(() => bump()),
      },
    ]);
  }

  const name = (c: Collection | null, id: string) => c?.name ?? t(locale, 'unknownTable', { id });

  return {
    repo,
    files,
    locale,
    config,
    palette,
    actions,
    router,
    counts,
    orphans,
    deleted,
    imports,
    known,
    layouts,
    picks,
    name,
    exportCsv,
    exportConfig,
    exportMemory,
    restoreMemory,
    setReadAttachments,
    setPrefillRules,
    clearMemory,
    deleteImport,
    deleteForever,
  };
}

import {
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
 * 「设置 → 数据」和它的子页面共用的数据和操作（D-614 拆成几页前都在 data.tsx 里）：
 * 每张表的条数和导入批次、不在界面里的表、最近删除、填写记忆；导出 CSV、导出 App 设计、恢复和清空填写记忆等。
 * 由内核提供，AI 不能修改（底线 8）。
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
  // 每张表从文件导入的批次（D-574），只留还有记录在的。
  const [imports, setImports] = useState<Map<string, RecordImport[]>>(new Map());
  const [known, setKnown] = useState<Map<string, Collection>>(new Map());
  const [layouts, setLayouts] = useState(0);
  // 新记录表单里点过的候选（D-394）：一个字段算一个。
  const [picks, setPicks] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = await repo.countRecords();
      const deletedRows = await repo.listDeletedRecords();
      // 已移出界面的数据表：从历史版本里找回它的结构（版本只追加、不删除）。
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
      // 超过保留期、但还没到下次启动清除的记录不再显示。
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
    // 查找、汇总、上一条导出算出来的值（D-291）。
    const { view, records } = await loadComputedRecords(
      (id) => repo.listRecords(id),
      config.data.tables,
      collection,
      new Date(),
      calendarOf(config),
    );
    records.sort((a, b) => a.createdAt - b.createdAt);
    // 引用字段导出被引用记录的标题（D-250）。
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

  /** 文件名里的日期（本地时间），导出几次不会互相覆盖。 */
  const today = (now: Date) =>
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  async function exportConfig() {
    const now = new Date();
    await files.shareText(appConfigFileName(now), appConfigFile(config, now), 'application/json');
  }

  async function exportMemory() {
    const now = new Date();
    const store = parseLayoutStore(await repo.getMeta(LAYOUT_STORE_KEY));
    const tapped = parsePickStore(await repo.getMeta(PICK_STORE_KEY));
    await files.shareText(
      `tinkrum-prefill-memory-${today(now)}.json`,
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

  /** 表上的「自动读取附件」（D-397）：默认打开，不写；关掉才写 false。能在改动记录里撤销。 */
  const setReadAttachments = (c: Collection, on: boolean) =>
    change(
      [{ op: 'updateData', table: c.id, changes: { readAttachments: on ? null : false } }],
      t(locale, on ? 'describeReadAttachmentsOn' : 'describeReadAttachmentsOff', { name: c.name }),
    );

  /** 表上的「附件是」（D-421）：其他不写，只有通用规则。 */
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

  /** 删除一次导入（D-574）：先问；这一批还在的记录进「最近删除」30 天，之后改过的也一起。 */
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

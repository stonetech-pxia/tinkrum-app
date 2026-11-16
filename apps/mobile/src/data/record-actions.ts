import {
  MAX_CREATE_ALL,
  MAX_SET_ALL,
  RECORD_LIMITS,
  createAllInputs,
  createInput,
  loadComputedRecords,
  prepareRecordValues,
  rowUpdateInput,
  setAllChanges,
  expandCollection,
  isOpenUse,
  recordToolOf,
  tapAlsoOf,
  tapWrites,
  toolReadsEntry,
  type ActionContext,
  type Collection,
  type DataRecord,
  type OpenUse,
  type RecordTool,
  type RecordToolUse,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { Alert } from 'react-native';

import { t } from '../i18n';
import { newAssetId } from '../runtime/ids';
import type { RecordWrite } from '../storage/types';
import { openRow } from '../renderer/open-row';
import { useCalendar, useWorkspace, useWorkspaceContext } from '../workspace/context';
import { useRecordActions } from './records';

// 一键记录操作（D-300–D-304）：用户点了按钮或列表里的行按钮才执行，直接写数据库（和表单一样不经过 AI、
// 不生成版本）。提示条只说做了什么，不带撤销：只有删除弹撤销，记下的、改过的用户自己删掉或改回去（底线 11，D-385）。
// 操作由 AI 配置，值在这里按当时的时间和记录算出来。

// 一次只执行一个：连点几下 +1 时一个接一个算，不会两次都从同一个旧值加。桌面小组件的点按也排在这里（D-323）。
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function useRecordActionRunner() {
  const { repo, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config);
  const bump = useWorkspace((s) => s.bumpRecords);
  const showToast = useWorkspace((s) => s.showToast);
  const actions = useRecordActions();
  const cal = useCalendar();
  const router = useRouter();

  const openNew = (collectionId: string, prefill?: Record<string, unknown>) =>
    router.push({
      pathname: '/record/[collectionId]',
      params: { collectionId, ...(prefill ? { prefill: JSON.stringify(prefill) } : {}) },
    });
  const openRecord = (collectionId: string, recordId: string) =>
    router.push({ pathname: '/record/[collectionId]', params: { collectionId, recordId } });

  /**
   * 「这一条」（D-565）：工具读它的字段时（抄、从它的日期起算、加它的数字），在点的那一刻读出来、算好
   * （公式、查找、汇总都有值）。已经不在了时没有。
   */
  async function entryOf(
    tool: RecordTool,
    id: string | undefined,
    now: Date,
  ): Promise<ActionContext['entry']> {
    if (!config || !id || !toolReadsEntry(tool)) return undefined;
    const stored = await repo.getRecord(id);
    const table = stored && config.data.tables.find((c) => c.id === stored.collectionId);
    if (!stored || stored.deletedAt !== null || !table) return undefined;
    const { view, records } = await loadComputedRecords(
      (cid) => repo.listRecords(cid),
      config.data.tables,
      table,
      now,
      cal,
    );
    const record = records.find((r) => r.id === id);
    return record ? { record, view } : undefined;
  }

  async function create(
    tool: Extract<RecordTool, { do: 'create' }>,
    ctx: { rowId?: string | undefined; recordId?: string | undefined },
  ) {
    const collection = config?.data.tables.find((c) => c.id === tool.table);
    if (!collection) return;
    const now = new Date();
    // 「这一条」：工具作用的那一条，没有时是记录页的那一条。
    const entry = await entryOf(tool, ctx.rowId ?? ctx.recordId, now);
    const input = createInput(collection, tool.values, { now, cal, ...ctx, entry });
    // D-338：打开新记录的表单，预设的值先填好，用户补完再保存（表单自己保存，不弹提示条）。
    // Q6：按钮模式的「添加」（原 recordForm button）也预填预设值。
    if (tool.ask !== undefined) return void openNew(collection.id, input);
    const result = await actions.add(collection, input);
    if (result.ok) {
      showToast({ message: t(locale, 'recordActionAdded', { table: collection.name }) });
    } else if ('full' in result) {
      Alert.alert(t(locale, 'tableFull'));
    } else {
      // 存不进去（旧配置里必填字段没有值）：打开表单让用户补上。
      openNew(collection.id);
    }
  }

  async function setAll(tool: Extract<RecordTool, { do: 'setAll' }>, label: string) {
    const collection = config?.data.tables.find((c) => c.id === tool.table);
    if (!config || !collection) return;
    const now = new Date();
    const { records } = await loadComputedRecords(
      (id) => repo.listRecords(id),
      config.data.tables,
      collection,
      now,
      cal,
    );
    const view = expandCollection(config.data.tables, collection);
    const changes = setAllChanges(tool, collection, view, records, { now, cal });
    if (changes.length === 0) {
      showToast({ message: t(locale, 'recordActionNothing') });
      return;
    }
    if (changes.length > MAX_SET_ALL) {
      Alert.alert(label, t(locale, 'recordActionTooMany', { max: MAX_SET_ALL, n: changes.length }));
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) =>
      Alert.alert(
        label,
        t(locale, 'recordActionConfirm', { n: changes.length }),
        [
          { text: t(locale, 'cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t(locale, 'recordActionConfirmButton'), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
    if (!confirmed) return;
    // 在一个事务里全改；每条都要求「现在还是算出这些改动时的样子」（确认的时候别处改过的不覆盖）。
    // 失败或有记录变了：一条也不改（R09）。
    const at = Date.now();
    let outcome: 'applied' | 'conflict';
    try {
      outcome = await repo.applyRecordWrites(
        changes.map((c) => ({
          kind: 'update' as const,
          id: c.id,
          values: c.after,
          updatedAt: at,
          expected: c.before,
        })),
      );
    } catch {
      showToast({ message: t(locale, 'recordActionFailed') });
      return;
    }
    bump([collection.id]);
    showToast({
      message:
        outcome === 'applied'
          ? t(locale, 'recordActionChanged', { n: changes.length })
          : t(locale, 'recordActionChangedMeanwhile'),
    });
  }

  /**
   * 点一下改这一条的几处（D-566）：先按现在存的这一条算出全部改动，在一个事务里一起写（要求这一条还是读到的样子），
   * 一处写不了就一处也不写。之后提示条上有「撤销」：放回这一条原来的样子、删掉新建的那条（都要求还是做完时的样子）。
   */
  async function tapMany(use: RecordToolUse, record: DataRecord) {
    const row = config?.data.tables.find((c) => c.id === record.collectionId);
    if (!config || !row) return;
    const stored = await repo.getRecord(record.id);
    if (!stored || stored.deletedAt !== null) {
      showToast({ message: t(locale, 'recordActionGone') });
      bump();
      return;
    }
    const now = new Date();
    const tools = tapWrites(use, row.id);
    const readsEntry = tools.some(toolReadsEntry);
    const entry = readsEntry
      ? await entryOf(tools.find(toolReadsEntry)!, record.id, now)
      : undefined;
    const ctx = { now, cal, rowId: record.id, entry };
    // 改这一条的几处按顺序合在一起（各改各的字段）。
    let input: Record<string, unknown> = {};
    let created: { collection: Collection; values: Record<string, unknown> } | undefined;
    for (const tool of tools) {
      if (tool.do === 'create') {
        const target = config.data.tables.find((c) => c.id === tool.table);
        if (!target) return;
        const prepared = prepareRecordValues(
          target,
          createInput(target, tool.values, ctx),
          null,
          now,
          cal,
        );
        if (!prepared.ok) return void showToast({ message: t(locale, 'recordActionFailed') });
        created = { collection: target, values: prepared.values };
        continue;
      }
      if (tool.do === 'setAll' || tool.do === 'createAll') continue;
      const next = rowUpdateInput(tool, row, { ...stored.values, ...input }, ctx);
      if (!next) return;
      input = { ...input, ...next };
    }
    const prepared = prepareRecordValues(row, input, stored.values, now, cal);
    if (!prepared.ok) return void openRecord(row.id, record.id);
    if (created) {
      const counts = await repo.countRecords();
      const count = counts.find((c) => c.collectionId === created!.collection.id)?.count ?? 0;
      if (count >= RECORD_LIMITS.perCollection) return void Alert.alert(t(locale, 'tableFull'));
    }
    const at = now.getTime();
    const newId = newAssetId();
    const writes: RecordWrite[] = [
      {
        kind: 'update',
        id: record.id,
        values: prepared.values,
        updatedAt: at,
        expected: stored.values,
      },
      ...(created
        ? [
            {
              kind: 'insert' as const,
              record: {
                id: newId,
                collectionId: created.collection.id,
                values: created.values,
                createdAt: at,
                updatedAt: at,
              },
            },
          ]
        : []),
    ];
    let outcome: 'applied' | 'conflict';
    try {
      outcome = await repo.applyRecordWrites(writes);
    } catch {
      return void showToast({ message: t(locale, 'recordActionFailed') });
    }
    if (outcome === 'conflict')
      return void showToast({ message: t(locale, 'recordActionChangedMeanwhile') });
    const tables = [row.id, ...(created ? [created.collection.id] : [])];
    bump(tables);
    showToast({
      message: t(locale, 'recordActionDone', { label: use.label ?? '' }),
      undo: {
        writes: [
          {
            kind: 'update',
            id: record.id,
            values: stored.values,
            updatedAt: Date.now(),
            expected: prepared.values,
          },
          ...(created ? [{ kind: 'remove' as const, id: newId, expected: created.values }] : []),
        ],
        tables,
        failed: 'recordUndoFailed',
      },
    });
  }

  /**
   * 批量新建（D-567）：筛出来的每一条来源各新建一条（引擎一条一条算，配置里没有循环）。没有就说一声；超过 200 条说上限、
   * 什么都不做；否则先问「将在 B 新建 N 条」，确认后在一个事务里全部建好。提示条上的「撤销」删掉这一批（每条都要求还是
   * 建好时的样子，改过就一条也不删）。存不进去的那几条（旧配置里必填项没有值）跳过。
   */
  async function createAll(tool: Extract<RecordTool, { do: 'createAll' }>, label: string) {
    const target = config?.data.tables.find((c) => c.id === tool.table);
    const source = config?.data.tables.find((c) => c.id === tool.from);
    if (!config || !target || !source) return;
    const now = new Date();
    const { view, records } = await loadComputedRecords(
      (id) => repo.listRecords(id),
      config.data.tables,
      source,
      now,
      cal,
    );
    const planned = createAllInputs(tool, target, view, records, { now, cal }).flatMap(
      ({ input }) => {
        const prepared = prepareRecordValues(target, input, null, now, cal);
        return prepared.ok ? [prepared.values] : [];
      },
    );
    if (planned.length === 0) {
      showToast({ message: t(locale, 'recordCreateAllNothing') });
      return;
    }
    if (planned.length > MAX_CREATE_ALL) {
      Alert.alert(
        label,
        t(locale, 'recordCreateAllTooMany', { max: MAX_CREATE_ALL, n: planned.length }),
      );
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) =>
      Alert.alert(
        label,
        t(locale, 'recordCreateAllConfirm', { n: planned.length, table: target.name }),
        [
          { text: t(locale, 'cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t(locale, 'recordCreateAllConfirmButton'), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
    if (!confirmed) return;
    const counts = await repo.countRecords();
    const count = counts.find((c) => c.collectionId === target.id)?.count ?? 0;
    if (count + planned.length > RECORD_LIMITS.perCollection)
      return void Alert.alert(t(locale, 'tableFull'));
    const at = Date.now();
    const created = planned.map((values) => ({ id: newAssetId(), values }));
    try {
      await repo.applyRecordWrites(
        created.map(({ id, values }) => ({
          kind: 'insert' as const,
          record: { id, collectionId: target.id, values, createdAt: at, updatedAt: at },
        })),
      );
    } catch {
      return void showToast({ message: t(locale, 'recordActionFailed') });
    }
    bump([target.id]);
    showToast({
      message: t(locale, 'recordCreateAllDone', { n: created.length, table: target.name }),
      undo: {
        writes: created.map(({ id, values }) => ({
          kind: 'remove' as const,
          id,
          expected: values,
        })),
        tables: [target.id],
        failed: 'recordUndoBulkFailed',
      },
    });
  }

  return {
    /**
     * 块本身的工具（button 的 tools[0]）：不作用在某一条上。recordId 是记录页打开的那一条（"$record"，
     * 和抄它的字段，D-342、D-565）。
     */
    runButton(use: RecordToolUse, label: string, recordId?: string): Promise<void> {
      return serial(async () => {
        const tool = recordToolOf(use);
        if (tool.do === 'setAll') return setAll(tool, label);
        if (tool.do === 'createAll') return createAll(tool, label);
        if (tool.do === 'create') await create(tool, recordId ? { recordId } : {});
      });
    },

    /**
     * 一条记录上的工具（button、tap、check、drag）。record 是列表上显示的那条（可能已经不在了，按 ID 重新读）；
     * 写哪张表看工具自己的 table（关系规则 12）。group 是拖到的那一栏（"$group"）。
     * message 换掉提示条上的「{label}：已记下」（看板移动卡片用，D-314）。
     */
    runRow(
      use: RecordToolUse | OpenUse,
      record: DataRecord,
      options: { message?: string; group?: string | null } = {},
    ): Promise<void> {
      return serial(async () => {
        if (isOpenUse(use)) return void openRow(router, use.opens, record.collectionId, record.id);
        if (tapAlsoOf(use).length > 0) return tapMany(use, record);
        const tool = recordToolOf(use);
        if (tool.do === 'create') return create(tool, { rowId: record.id });
        if (tool.do === 'setAll') return setAll(tool, use.label ?? '');
        if (tool.do === 'createAll') return createAll(tool, use.label ?? '');
        const collection = config?.data.tables.find((c) => c.id === tool.table);
        if (!collection) return;
        const stored = await repo.getRecord(record.id);
        if (!stored || stored.deletedAt !== null) {
          showToast({ message: t(locale, 'recordActionGone') });
          bump();
          return;
        }
        const now = new Date();
        const input = rowUpdateInput(tool, collection, stored.values, {
          now,
          cal,
          rowId: record.id,
          group: options.group,
          entry: await entryOf(tool, record.id, now),
        });
        if (!input) return;
        const prepared = prepareRecordValues(collection, input, stored.values, now, cal);
        if (!prepared.ok) return void openRecord(collection.id, record.id);
        await repo.updateRecord(record.id, prepared.values, now.getTime());
        bump([stored.collectionId]);
        showToast({
          message: options.message ?? t(locale, 'recordActionDone', { label: use.label ?? '' }),
        });
      });
    },
  };
}

import {
  MAX_CREATE_ALL,
  MAX_SET_ALL,
  RECORD_LIMITS,
  checkInput,
  checkOverwrites,
  createAllInputs,
  createInput,
  pickCreateInputs,
  pickedAlready,
  formatValue,
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
  type FieldIssue,
  type Locale,
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

// One-touch record operations (D-300–D-304): executed only when the user taps a button or a row
// action in a list, writing directly to the database (like forms, bypassing AI and version
// generation). The toast message only describes what was done without undo: only deletion shows an
// undo toast, while recorded or modified entries are deleted or reverted by the user themselves
// (invariant 11, D-385). The operation is configured by the AI, and values are computed here based
// on the current time and record.

/**
 * Tapping would push the number out of the field's range (D-570): outputs "Nothing changed:
 * "Quantity" cannot exceed 10.", without opening the form (since the reason wouldn't be apparent
 * on the form). Returns null for other issues (missing required fields, old config), opening the
 * entry as usual for the user to edit.
 */
function rangeMessage(
  collection: Collection,
  issues: readonly FieldIssue[],
  locale: Locale,
): string | null {
  const first = issues[0];
  if (!first || !issues.every((i) => i.code === 'tooSmall' || i.code === 'tooLarge')) return null;
  const field = collection.fields.find((f) => f.id === first.fieldId);
  if (!field || first.limit === undefined) return null;
  return t(locale, first.code === 'tooSmall' ? 'recordActionTooSmall' : 'recordActionTooLarge', {
    field: field.name,
    limit: formatValue(field, first.limit, locale),
  });
}

// Execute one at a time: when tapping +1 rapidly several times, calculations queue up sequentially so it never derives twice from the same old value. Widget taps are also queued here (D-323).
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
   * "This entry" (D-565): when a tool reads its fields (copying, calculating from its date,
   * adding its numbers), they are read and computed at the exact moment of the tap (formulas,
   * lookups, and rollups all have values). Returns nothing if the entry no longer exists.
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
    /** Values computed for "$here" on check-in grid cells (D-610): for this row, this day, and equality conditions in filters. */
    here: Record<string, unknown> = {},
  ) {
    const collection = config?.data.tables.find((c) => c.id === tool.table);
    if (!collection) return;
    const now = new Date();
    // "This entry": the entry acted upon by the tool, or the entry on the record page if none is specified.
    const entry = await entryOf(tool, ctx.rowId ?? ctx.recordId, now);
    const input = { ...createInput(collection, tool.values, { now, cal, ...ctx, entry }), ...here };
    // D-338: Opens the new record form with preset values pre-filled; the user completes them
    // before saving (the form saves itself without showing a toast). Q6: Button mode "Add"
    // (formerly recordForm button) also pre-fills preset values.
    if (tool.ask !== undefined) return void openNew(collection.id, input);
    const result = await actions.add(collection, input);
    if (result.ok) {
      showToast({ message: t(locale, 'recordActionAdded', { table: collection.name }) });
    } else if ('full' in result) {
      Alert.alert(t(locale, 'tableFull'));
    } else {
      // Fails to save (required fields in old config have no value): opens the form for the user to fill them in.
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
    // Modify everything within a single transaction; each entry requires "still looks like it did
    // when these changes were computed" (preventing overwrites if modified elsewhere during
    // confirmation). On failure or if any record changed: modifies zero entries (R09).
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
   * Modify several aspects of this entry at once (D-566): first computes all changes based on the
   * currently stored entry, writes them together in a single transaction (requiring the entry to
   * still match the read state), and writes nothing if any part fails. Afterwards, an "Undo"
   * toast is shown: restores the entry to its original state and deletes any newly created
   * entries (both requiring the state at completion).
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
    // Combines multiple modifications to this entry in sequence (each modifying its respective fields).
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
      if (tool.do === 'setAll' || tool.do === 'createAll' || tool.do === 'remove') continue;
      const next = rowUpdateInput(tool, row, { ...stored.values, ...input }, ctx);
      if (!next) return;
      input = { ...input, ...next };
    }
    // If all target values are empty and no new entry was created: writes nothing and provides no undo.
    if (Object.keys(input).length === 0 && !created)
      return void showToast({ message: t(locale, 'recordActionNoValue') });
    const prepared = prepareRecordValues(row, input, stored.values, now, cal);
    if (!prepared.ok) {
      const range = rangeMessage(row, prepared.issues, locale);
      return void (range ? showToast({ message: range }) : openRecord(row.id, record.id));
    }
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
   * Checklist check with "also" (D-617): when checked, writes the checkbox and "also" values
   * together; when unchecked, writes the checkbox and clears the "also" fields, computed against
   * the currently stored entry and written in a single transaction (same transaction; aborts with
   * a notice if modified elsewhere). No undo toast: unchecking clears all checked changes and
   * checking again restores them (invariant 11); an undo toast is shown only when checking
   * overwrites existing, differing values (unchecking only clears and cannot restore that value),
   * with undo restoring the entry's original state.
   */
  async function check(use: RecordToolUse, record: DataRecord) {
    const row = config?.data.tables.find((c) => c.id === use.table);
    if (!config || !row) return;
    const stored = await repo.getRecord(record.id);
    if (!stored || stored.deletedAt !== null || stored.collectionId !== row.id) {
      showToast({ message: t(locale, 'recordActionGone') });
      bump();
      return;
    }
    const now = new Date();
    const tools = tapWrites(use, row.id);
    const reads = tools.find(toolReadsEntry);
    const entry = reads ? await entryOf(reads, record.id, now) : undefined;
    const input = checkInput(use, row, stored.values, { now, cal, rowId: record.id, entry });
    if (!input) return;
    const prepared = prepareRecordValues(row, input, stored.values, now, cal);
    if (!prepared.ok) return void openRecord(row.id, record.id);
    let outcome: 'applied' | 'conflict';
    try {
      outcome = await repo.applyRecordWrites([
        {
          kind: 'update',
          id: record.id,
          values: prepared.values,
          updatedAt: now.getTime(),
          expected: stored.values,
        },
      ]);
    } catch {
      return void showToast({ message: t(locale, 'recordActionFailed') });
    }
    if (outcome === 'conflict')
      return void showToast({ message: t(locale, 'recordActionChangedMeanwhile') });
    bump([row.id]);
    if (!checkOverwrites(use, stored.values, prepared.values)) return;
    showToast({
      message: t(locale, 'recordCheckOverwrote'),
      undo: {
        writes: [
          {
            kind: 'update',
            id: record.id,
            values: stored.values,
            updatedAt: Date.now(),
            expected: prepared.values,
          },
        ],
        tables: [row.id],
        failed: 'recordUndoFailed',
      },
    });
  }

  /**
   * Batch creation (D-567): creates a new entry for each source item matched by filters (computed
   * one by one by the engine; no loops in config). Shows a message if empty; says limit reached
   * and does nothing if exceeding 200 items; otherwise prompts "Will create N entries in B", and
   * after confirmation builds all within a single transaction. The "Undo" toast deletes this
   * batch (each entry must still match its post-creation state; if modified, deletes none). Skips
   * items that cannot be saved (required fields missing in old config).
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
    return createBatch(target, planned, label);
  }

  /**
   * Picker creation (D-616): creates a new entry for each source item selected by the user under
   * "Add" below the list (passing "here" values from this section). Re-reads this section at the
   * moment of the tap, skipping already linked items (preventing duplicates if added elsewhere).
   * The picker page button "Add N items to B" serves as the confirmation prompt (invariant 11,
   * founder 2026-11-21 "compute, drop the second"), so no secondary confirmation prompt is shown
   * here; thereafter behaves like batch creation: maximum 200 items, single transaction, toast
   * allows undoing the batch. Returns true upon successful creation (closing the picker page);
   * returns false on cancellation or if nothing was built.
   */
  async function pickCreate(
    tool: Extract<RecordTool, { do: 'createAll' }>,
    here: Record<string, unknown>,
    sourceIds: readonly string[],
    label: string,
  ): Promise<boolean> {
    const target = config?.data.tables.find((c) => c.id === tool.table);
    const source = config?.data.tables.find((c) => c.id === tool.from);
    if (!config || !target || !source) return false;
    const now = new Date();
    const { view, records } = await loadComputedRecords(
      (id) => repo.listRecords(id),
      config.data.tables,
      source,
      now,
      cal,
    );
    const picked = sourceIds.flatMap((id) => records.filter((r) => r.id === id));
    const already = pickedAlready(tool, target, await repo.listRecords(target.id), here);
    const planned = pickCreateInputs(tool, target, view, picked, here, already, {
      now,
      cal,
    }).flatMap(({ input }) => {
      const prepared = prepareRecordValues(target, input, null, now, cal);
      return prepared.ok ? [prepared.values] : [];
    });
    return createBatch(
      target,
      planned,
      label || t(locale, 'recordPickTitle', { table: source.name }),
      false,
    );
  }

  /**
   * Second half of batch creation (D-567, D-616): shows a message if empty, states the limit if
   * exceeded, prompts first, builds in a single transaction, and provides an undo toast for the
   * batch. If ask is false, only supports picker creation: the user has just tapped the button
   * specifying count and table on the picker page, which counts as asking.
   */
  async function createBatch(
    target: Collection,
    planned: Record<string, unknown>[],
    label: string,
    ask = true,
  ): Promise<boolean> {
    if (planned.length === 0) {
      showToast({ message: t(locale, 'recordCreateAllNothing') });
      return false;
    }
    if (planned.length > MAX_CREATE_ALL) {
      Alert.alert(
        label,
        t(locale, 'recordCreateAllTooMany', { max: MAX_CREATE_ALL, n: planned.length }),
      );
      return false;
    }
    const confirmed =
      !ask ||
      (await new Promise<boolean>((resolve) =>
        Alert.alert(
          label,
          t(locale, 'recordCreateAllConfirm', { n: planned.length, table: target.name }),
          [
            { text: t(locale, 'cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: t(locale, 'recordCreateAllConfirmButton'), onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      ));
    if (!confirmed) return false;
    const counts = await repo.countRecords();
    const count = counts.find((c) => c.collectionId === target.id)?.count ?? 0;
    if (count + planned.length > RECORD_LIMITS.perCollection) {
      Alert.alert(t(locale, 'tableFull'));
      return false;
    }
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
      showToast({ message: t(locale, 'recordActionFailed') });
      return false;
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
    return true;
  }

  /**
   * Check-in grid (D-610): moves the single entry in the cell to "Recently deleted", behaving
   * just like a manual deletion by the user (soft delete, recoverable within 30 days), with an
   * undo toast (invariant 11: deletions show undo). Deletes only from the tool's table (relation
   * rule 12); notifies if already missing.
   */
  async function removeOne(tool: Extract<RecordTool, { do: 'remove' }>, record: DataRecord) {
    const stored = await repo.getRecord(record.id);
    if (!stored || stored.deletedAt !== null) {
      showToast({ message: t(locale, 'recordActionGone') });
      bump();
      return;
    }
    if (stored.collectionId !== tool.table) return;
    const collection = config?.data.tables.find((c) => c.id === tool.table);
    await repo.deleteRecord(record.id, Date.now());
    bump([stored.collectionId]);
    showToast({
      message: t(locale, 'recordActionRemoved', { table: collection?.name ?? '' }),
      restoreRecordId: record.id,
    });
  }

  return {
    /** Checklist check action (as check, D-617): checks with "also" are written here in a single operation; those without are handled directly by the list modifying the checkbox. */
    runCheck(use: RecordToolUse, record: DataRecord): Promise<void> {
      return serial(() => check(use, record));
    },

    /**
     * Picker creation (D-616): tapping "Add N items to B" on the picker page. `use` is "Add"
     * below the list (`as addHere`, `pick: true`), `here` contains values from this section, and
     * `sourceIds` follow the selection order.
     */
    runPick(
      use: RecordToolUse,
      here: Record<string, unknown>,
      sourceIds: readonly string[],
    ): Promise<boolean> {
      return serial(async () => {
        const tool = recordToolOf(use);
        if (tool.do !== 'createAll' || !tool.pick) return false;
        return pickCreate(tool, here, sourceIds, use.label ?? '');
      });
    },

    /**
     * Tapping a cell on the check-in grid (D-610): `create` adds an entry in this cell (`here`
     * holds the "this row, this day" values computed for the cell), with no undo toast (tapping
     * again deletes it, invariant 11); `remove` moves the single entry in the cell to "Recently
     * deleted", showing an undo toast.
     */
    runCell(
      use: RecordToolUse,
      cell: { here: Record<string, unknown> } | { record: DataRecord },
    ): Promise<void> {
      return serial(async () => {
        const tool = recordToolOf(use);
        if (tool.do === 'create' && 'here' in cell) return create(tool, {}, cell.here);
        if (tool.do === 'remove' && 'record' in cell) return removeOne(tool, cell.record);
      });
    },

    /**
     * Block-level tools (`tools[0]` of a button): do not act on a specific entry. `recordId` is
     * the entry opened on the record page (`"$record"`, used for copying its fields, D-342,
     * D-565).
     */
    runButton(use: RecordToolUse, label: string, recordId?: string): Promise<void> {
      return serial(async () => {
        const tool = recordToolOf(use);
        if (tool.do === 'setAll') return setAll(tool, label);
        if (tool.do === 'createAll') return void (await createAll(tool, label));
        if (tool.do === 'create') await create(tool, recordId ? { recordId } : {});
      });
    },

    /**
     * Tools acting on a single record (button, tap, check, drag). `record` is the entry displayed
     * in the list (re-read by ID if it may no longer exist); target table depends on the tool's
     * own table setting (relation rule 12). `group` is the target column dropped into
     * (`"$group"`). `message` overrides the default toast message "{label}: recorded" (used for
     * Kanban card moving, D-314).
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
        if (tool.do === 'createAll') return void (await createAll(tool, use.label ?? ''));
        // Deletion only applies to check-in grids (`runCell`), and cannot occur here (blocked by validation).
        if (tool.do === 'remove') return;
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
        // Target values are empty (interval or date fields for this entry are not yet filled, D-565): writes nothing, reports factually, and omits "Recorded".
        if (Object.keys(input).length === 0)
          return void showToast({ message: t(locale, 'recordActionNoValue') });
        const prepared = prepareRecordValues(collection, input, stored.values, now, cal);
        if (!prepared.ok) {
          const range = rangeMessage(collection, prepared.issues, locale);
          return void (range
            ? showToast({ message: range })
            : openRecord(collection.id, record.id));
        }
        await repo.updateRecord(record.id, prepared.values, now.getTime());
        bump([stored.collectionId]);
        showToast({
          message: options.message ?? t(locale, 'recordActionDone', { label: use.label ?? '' }),
        });
      });
    },
  };
}

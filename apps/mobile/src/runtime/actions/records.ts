import {
  MAX_ATTACHMENTS,
  RECORD_LIMITS,
  RunCancelled,
  RunError,
  appendPrefill,
  attachRoom,
  attachmentIds,
  isFileValue,
  prepareRecordValues,
  recordTargets,
  spokenTextTarget,
  type ActionImpl,
  type Collection,
  type RunItem,
} from '@morph/core';

import { deleteUserFiles } from '../../storage/user-files';
import { newAssetId } from '../ids';
import { saveItems } from './io';
import type { RunServices } from './helpers';

// Log an expense / entry (D-187, D-397): add a record to a table using current files (or text). The
// form is filled by the user at runtime, and files are first saved as Morph files before being
// placed into attachment fields. Records are written directly to the database without entering the
// config, generating versions, or being sent to the AI (D-036).

type Impl = ActionImpl<RunServices>;

// Which field receives files or text: core's recordTargets (uses the same rules when appending to existing records).
export { recordTargets };

export const RECORD_IMPLS: Record<string, Impl> = {
  async 'out.addRecord'(input, params, ctx) {
    const { collectionId, each, into } = params as {
      collectionId: string;
      each?: boolean;
      into?: 'new' | 'existing';
    };
    const { repo, ui, files, collections } = ctx.services;
    const collection = collections.find((c) => c.id === collectionId);
    if (!collection) throw new RunError('unexpected', { detail: `no data table ${collectionId}` });
    if (into === 'existing') return addToExisting(input, collection, ctx);
    const { fileField, textField } = recordTargets(collection);
    const items = isFileValue(input) ? input.items : null;
    // Default to placing current files into the same record (a two-page contract is one record,
    // D-397); specify each to create a record per file. If the table has no attachment fields,
    // files cannot be placed, prompting a form per file for the user to fill out.
    const together = items !== null && fileField !== undefined && each !== true;
    const entries: RunItem[][] =
      items === null
        ? [[]]
        : together
          ? [items.slice(0, MAX_ATTACHMENTS)]
          : items.map((item) => [item]);
    const stored = new Map<RunItem, RunItem>();
    for (const [i, entry] of entries.entries()) {
      ctx.throwIfCancelled();
      const counts = await repo.countRecords();
      if (
        (counts.find((c) => c.collectionId === collection.id)?.count ?? 0) >=
        RECORD_LIMITS.perCollection
      ) {
        throw new RunError('tooMany', { max: RECORD_LIMITS.perCollection });
      }
      const prefill: Record<string, unknown> = {};
      // Place user spoken text into fields like notes (D-576) rather than primary text fields like merchant.
      const spokenField =
        input?.type === 'text' && input.spoken ? spokenTextTarget(collection) : undefined;
      const intoField = spokenField ?? textField;
      if (items === null && input?.type === 'text' && intoField) prefill[intoField] = input.text;
      // Save as user files before opening the form so the form can read them (D-394). Newly saved
      // items in this step are copies for this form: those not entered into records (skipped,
      // closed, removed from form, write failure) are deleted; files saved by previous steps are
      // excluded.
      const saved = fileField ? await saveItems(ctx.services, entry, ctx) : entry;
      const unused = new Set(
        saved.filter((_, n) => !entry[n]!.assetId).map((file) => file.assetId!),
      );
      try {
        if (fileField && saved.length > 0) prefill[fileField] = saved.map((f) => f.assetId!);
        const answer = await ui.open('recordEntry', {
          collection,
          prefill,
          ...(!fileField && entry[0] ? { file: entry[0] } : {}),
          ...(together && items.length > MAX_ATTACHMENTS ? { overflow: true } : {}),
          ...(items === null && input?.type === 'text' && input.spoken
            ? { heard: input.text }
            : {}),
          index: i,
          total: entries.length,
        });
        if (!answer) throw new RunCancelled();
        if ('skip' in answer) continue;
        const values = { ...prefill, ...answer.values };
        const now = ctx.now();
        const prepared = prepareRecordValues(collection, values, null, now, ctx.services.calendar);
        // The form was already validated with the same rules; an error here indicates the table schema changed at runtime.
        if (!prepared.ok) throw new RunError('badField', { name: prepared.issues[0]!.fieldId });
        await repo.insertRecord({
          id: newAssetId(),
          collectionId: collection.id,
          values: prepared.values,
          createdAt: now.getTime(),
          updatedAt: now.getTime(),
        });
        const used = fileField ? attachmentIds(values[fileField]) : [];
        for (const [n, file] of saved.entries()) {
          if (!file.assetId || !used.includes(file.assetId)) continue;
          unused.delete(file.assetId);
          stored.set(entry[n]!, file);
          ctx.saved.push(file.assetId);
        }
      } finally {
        await deleteUserFiles([...unused], repo, files);
      }
      ctx.progress(i + 1, entries.length);
    }
    return items !== null
      ? ({ ...(input as object), items: items.map((item) => stored.get(item) ?? item) } as never)
      : input!;
  },
};

/**
 * Add to existing record (D-443): the user selects a record in this table at runtime, appending
 * files after its attachments and text after its text, then reviews and saves via the form.
 * Append-only: existing files and text are neither replaced nor deleted (modifying them in the
 * form is up to the user). Newly saved files in this step are copies for this form: those not
 * written to records (canceled, record deleted, write failure) are deleted, excluding files saved
 * by previous steps.
 */
async function addToExisting(
  input: Parameters<Impl>[0],
  collection: Collection,
  ctx: Parameters<Impl>[2],
) {
  const { repo, ui, files, calendar } = ctx.services;
  const { fileField, textField } = recordTargets(collection);
  const items = isFileValue(input) ? input.items : null;
  const text = input?.type === 'text' ? input.text : null;
  // Unwritable items (corresponding fields missing in the table) are caught by config validation; this error indicates the table changed at runtime.
  if ((items !== null && fileField === undefined) || (text !== null && textField === undefined))
    throw new RunError('unexpected', { detail: `no place in ${collection.id}` });
  ctx.throwIfCancelled();
  const all = await repo.listRecords(collection.id);
  if (all.length === 0) throw new RunError('notFound', { name: collection.name });
  const picked = await ui.open('recordPick', { collection, records: all });
  if (!picked) throw new RunCancelled();
  ctx.throwIfCancelled();
  const record = await repo.getRecord(picked.recordId);
  if (!record || record.deletedAt !== null)
    throw new RunError('notFound', { name: collection.name });

  // Attachment capacity check: abort execution if full, avoiding saving and subsequently deleting files.
  let toAdd: RunItem[] = [];
  if (items !== null) {
    const room = attachRoom(collection, record.values);
    if (room === 0) throw new RunError('recordFull', { max: MAX_ATTACHMENTS });
    toAdd = items.slice(0, room);
  }
  const saved = items !== null ? await saveItems(ctx.services, toAdd, ctx) : [];
  const unused = new Set(saved.filter((_, n) => !toAdd[n]!.assetId).map((file) => file.assetId!));
  try {
    const prefill = appendPrefill(collection, record.values, {
      ...(items !== null ? { fileIds: saved.map((f) => f.assetId!) } : {}),
      ...(text !== null ? { text } : {}),
    });
    const answer = await ui.open('recordEntry', {
      collection,
      prefill,
      existing: record,
      ...(items !== null && items.length > toAdd.length ? { overflow: true } : {}),
      index: 0,
      total: 1,
    });
    if (!answer || 'skip' in answer) throw new RunCancelled();
    // The record might have been deleted while the form was open: write nothing.
    const fresh = await repo.getRecord(record.id);
    if (!fresh || fresh.deletedAt !== null)
      throw new RunError('notFound', { name: collection.name });
    const now = ctx.now();
    const prepared = prepareRecordValues(
      collection,
      { ...answer.values },
      fresh.values,
      now,
      calendar,
    );
    if (!prepared.ok) throw new RunError('badField', { name: prepared.issues[0]!.fieldId });
    await repo.updateRecord(record.id, prepared.values, now.getTime());
    const used = fileField ? attachmentIds(prepared.values[fileField]) : [];
    for (const file of saved) {
      if (!file.assetId || !used.includes(file.assetId)) continue;
      unused.delete(file.assetId);
      ctx.saved.push(file.assetId);
    }
  } finally {
    await deleteUserFiles([...unused], repo, files);
  }
  // Pass files to the next step as-is (using the saved copy, same as creation).
  if (items === null) return input!;
  const stored = new Map(toAdd.map((item, n) => [item, saved[n]!] as const));
  return { ...(input as object), items: items.map((item) => stored.get(item) ?? item) } as never;
}

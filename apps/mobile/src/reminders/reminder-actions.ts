import {
  RECORD_LIMITS,
  calendarOf,
  linkTitle,
  loadComputedRecords,
  migrateWorkspace,
  prepareRecordValues,
  reminderButtons,
  reminderDoneInput,
  reminderTable,
  remindersOf,
  snoozeId,
  toolReadsEntry,
  type Locale,
  type WorkspaceConfig,
} from '@morph/core';

import { t } from '../i18n';
import { newAssetId } from '../runtime/ids';
import type { RecordWrite, WorkspaceRepo } from '../storage/types';
import type { NotificationPlatform, ReminderAction } from './platform';
import { syncReminders } from './useReminders';

// Buttons on reminder notifications (D-318): "Done" executes the quick action configured in the
// reminder for this record, "Snooze" reminds again in a few minutes. Executed only upon user tap;
// writes records directly (like forms, directly to database, bypassing AI and version generation),
// does not run quick actions or open AI. The app might be awakened in the background by the system,
// so config is read live from the database without relying on the UI.

export interface ReminderActionDeps {
  repo: WorkspaceRepo;
  platform: NotificationPlatform;
  locale: Locale;
  now: () => Date;
}

export type ReminderActionResult =
  | { kind: 'done'; title: string }
  | { kind: 'snoozed' }
  /** Record still exists, but "Done" failed to save (table full, required field in old config missing value): nothing written, user must be notified. */
  | { kind: 'notSaved' }
  /** Already handled, reminder or record no longer exists, or nothing to do: nothing written. */
  | { kind: 'skipped' };

/** Handled clicks (a single click might be delivered via two paths); stored on device so app restart won't re-execute. */
const HANDLED_KEY = 'reminderActionsHandled';
const HANDLED_KEEP = 30;
/** Fallback when snoozeMinutes is unspecified (won't happen in old config, insurance only). */
const DEFAULT_SNOOZE = 10;

let queue: Promise<unknown> = Promise.resolve();

/** Process one after another: double-tapping "Done" will not add from the same old value twice. */
export function handleReminderAction(
  action: ReminderAction,
  deps: ReminderActionDeps,
): Promise<ReminderActionResult> {
  const next = queue.then(
    () => handle(action, deps),
    () => handle(action, deps),
  );
  queue = next.catch(() => undefined);
  return next;
}

async function handled(repo: WorkspaceRepo): Promise<string[]> {
  try {
    const raw = await repo.getMeta(HANDLED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function loadConfig(repo: WorkspaceRepo): Promise<WorkspaceConfig | null> {
  const head = await repo.getHead();
  if (!head) return null;
  const migrated = migrateWorkspace(head.config);
  return migrated.ok ? (migrated.config as WorkspaceConfig) : null;
}

async function handle(
  action: ReminderAction,
  { repo, platform, locale, now }: ReminderActionDeps,
): Promise<ReminderActionResult> {
  const seen = await handled(repo);
  if (seen.includes(action.key)) return { kind: 'skipped' };
  // Marker for "this click has been handled": record writing and the marker are saved in the same
  // transaction (either both saved or neither saved), so if writing fails this click can be
  // executed again (the system will redeliver the latest click on next startup), avoiding the
  // scenario where the record is written but the marker is not, causing a duplicate addition (R06).
  const mark = {
    key: HANDLED_KEY,
    value: JSON.stringify([...seen, action.key].slice(-HANDLED_KEEP)),
  };
  // Notification is dismissed here (Android notification does not auto-dismiss when button is tapped): action succeeded or nothing left to do.
  const dismiss = () => platform.dismiss(action.notificationId).catch(() => undefined);
  const nothing = async (
    kind: 'skipped' | 'notSaved' = 'skipped',
  ): Promise<ReminderActionResult> => {
    await repo.setMeta(mark.key, mark.value);
    await dismiss();
    return { kind };
  };

  // If the record is modified elsewhere (form, widget) between read and write, re-read and recalculate, up to three times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const config = await loadConfig(repo);
    const r = config
      ? remindersOf(config).find((x) => x.id === action.reminderId && 'each' in x.when)
      : undefined;
    const table = r && reminderTable(r)?.table;
    const collection = config?.data.tables.find((c) => c.id === table);
    const record = await repo.getRecord(action.recordId);
    if (!config || !r || !collection || !record || record.deletedAt !== null) return nothing();
    const at = now();
    const title = linkTitle(record, collection, locale);

    if (action.button === 'snooze') {
      const minutes = r.snoozeMinutes ?? DEFAULT_SNOOZE;
      const buttons = reminderButtons(r);
      // Snoozed reminders for the same record share an ID, and rescheduling is a replacement, so if scheduled but the marker is not written, tapping again will not produce two reminders.
      await platform.snooze({
        id: snoozeId(r.id, record.id),
        reminderId: r.id,
        title,
        body: r.title,
        trigger: { kind: 'date', at: at.getTime() + minutes * 60_000 },
        opens: r.opens,
        recordId: record.id,
        ...(buttons ? { buttons } : {}),
      });
      await repo.setMeta(mark.key, mark.value);
      await dismiss();
      return { kind: 'snoozed' };
    }

    if (!r.done) return nothing();
    const cal = calendarOf(config);
    // done reads fields of this entry (copied, calculated from its date, D-565): compute this entry first (formulas, lookup, aggregation).
    const computed = toolReadsEntry(r.done)
      ? (
          await loadComputedRecords(
            (id) => repo.listRecords(id),
            config.data.tables,
            collection,
            at,
            cal,
          )
        ).records.find((x) => x.id === record.id)
      : undefined;
    const planned = reminderDoneInput(r.done, config, collection, record, at, computed ?? record);
    if (!planned) return nothing();
    let write: RecordWrite;
    if (planned.kind === 'create') {
      const counts = await repo.countRecords();
      const count = counts.find((c) => c.collectionId === planned.collection.id)?.count ?? 0;
      if (count >= RECORD_LIMITS.perCollection) return nothing('notSaved');
      const prepared = prepareRecordValues(planned.collection, planned.input, null, at, cal);
      // Failed to save (required field in old config missing value): background cannot open form, writing nothing.
      if (!prepared.ok) return nothing('notSaved');
      write = {
        kind: 'insert',
        record: {
          id: newAssetId(),
          collectionId: planned.collection.id,
          values: prepared.values,
          createdAt: at.getTime(),
          updatedAt: at.getTime(),
        },
      };
    } else {
      const prepared = prepareRecordValues(collection, planned.input, record.values, at, cal);
      if (!prepared.ok) return nothing('notSaved');
      write = {
        kind: 'update',
        id: record.id,
        values: prepared.values,
        updatedAt: at.getTime(),
        expected: record.values,
      };
    }
    if ((await repo.applyRecordWrites([write], mark)) === 'conflict') continue;
    await dismiss();
    // Completed: snoozed reminder for this item is no longer needed; record changed, reminder rescheduled (D-316).
    await platform.cancel(snoozeId(r.id, record.id)).catch(() => undefined);
    await syncReminders(platform, config, (id) => repo.listRecords(id), locale, at);
    return { kind: 'done', title };
  }
  // Other writes kept intervening: do not mark as handled, execute again when redelivered next time.
  throw new Error('the entry kept changing while the reminder button was handled');
}

/**
 * Notification button entry point (background.ts): if not successful (write failed, error)
 * immediately pop up a notification so the user doesn't think it was recorded (Health Check 2.5).
 * When throwing an error, this click is not marked handled, and tapping again after opening the
 * app will not repeat.
 */
export async function runReminderAction(
  action: ReminderAction,
  deps: ReminderActionDeps,
): Promise<ReminderActionResult | null> {
  const tell = () =>
    deps.platform
      .alert(
        t(deps.locale, action.button === 'done' ? 'reminderNotSaved' : 'reminderNotSnoozed'),
        t(deps.locale, 'reminderActionFailedBody'),
      )
      .catch(() => undefined);
  try {
    const result = await handleReminderAction(action, deps);
    if (result.kind === 'notSaved') await tell();
    return result;
  } catch {
    await tell();
    return null;
  }
}

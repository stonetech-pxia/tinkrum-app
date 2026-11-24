import { calendarOf, dateOfDayNumber, todayNumber, weekStartOf, type Calendar } from './calendar';
import { conditionProblems } from './conditions';
import {
  filterRecords,
  isSystemField,
  linkTitle,
  localDate,
  readValue,
  recordDay,
  scheduleDoneDays,
  scheduleOptionsOf,
  type DataRecord,
} from './data';
import { dayNumber } from './formula';
import { t } from './messages';
import { createInput, recordToolProblems, rowUpdateInput, type RecordTool } from './record-ops';
import { expandCollection } from './related';
import { scheduleOccurrences, type ScheduleRule } from './schedule';
import {
  pageIdOf,
  quickActionsOf,
  remindersOf,
  toolTargetId,
  type Collection,
  type Locale,
  type Reminder,
  type ReminderTarget,
  type WorkspaceConfig,
} from './schema';

// Reminders (D-251): use local notifications, no push, no server needed. Config contains only
// reminder settings (AI can create and modify); expiration reminder records are read locally, body
// is generated locally, record content does not enter config and is not sent to AI. Tapping a
// notification only opens the corresponding page or quick action, never automatically runs anything
// (inbox auto-run restriction unchanged; relation rules 13, 14: reminders have no steps, cannot
// trigger other tools, and cannot take data out of the app. "Done" is just a one-tap logging tool
// acting on this entry ($row)).

/** iOS schedules at most 64 local notifications simultaneously: expiration reminders queue up to this many (most recent first), filling in the rest each time the app is opened. */
export const MAX_DATE_NOTIFICATIONS = 48;
/** System pending notification limit (iOS 64, D-319): total reminders plus snoozes together cannot exceed this; if exceeded, only the most recent are scheduled. */
export const MAX_PENDING_NOTIFICATIONS = 64;
/** Maximum number of record-based reminders (scheduleField) to schedule (D-319, pending founder confirmation): most recent first. */
export const MAX_RECORD_NOTIFICATIONS = 40;
/** Maximum number of future occurrences per record (subsequent ones wait for the app's next rescheduling). */
export const RECORD_OCCURRENCES = 7;

/** Reminder target opening quick action tool:<id> → id (only exposes it, does not run); null if not. */
export const reminderToolId = (target: ReminderTarget): string | null => toolTargetId(target);

/** Tables and fields checked by expiration reminders (when.before, days or minutes), record-based reminders (when.each), and post-creation reminders (when.after, based on creation time). */
export const reminderTable = (r: Reminder): { table: string; field: string } | undefined =>
  'before' in r.when
    ? r.when.before
    : 'each' in r.when
      ? r.when.each
      : 'after' in r.when
        ? { table: r.when.after.table, field: 'createdAt' }
        : undefined;

/** Check if reminder settings have issues: target to open, tables to watch, and date fields must all exist. */
export function reminderProblems(r: Reminder, config: WorkspaceConfig): string[] {
  const problems: string[] = [];
  const where = `reminder ${r.id}`;
  const when = r.when;
  if ('before' in when && 'minutes' in when) {
    // Minutes before (D-562) needs hour/minute: must be a datetime field.
    const collection = config.data.tables.find((c) => c.id === when.before.table);
    if (!collection) problems.push(`${where}: data table ${when.before.table} does not exist`);
    else if (collection.fields.find((f) => f.id === when.before.field)?.type !== 'datetime')
      problems.push(
        `${where}: when.before.field must be a datetime field of ${collection.id} when minutes is set (use days and at for a date)`,
      );
  } else if ('before' in when) {
    const collection = config.data.tables.find((c) => c.id === when.before.table);
    if (!collection) problems.push(`${where}: data table ${when.before.table} does not exist`);
    else if (
      !['date', 'dateOffset'].includes(
        collection.fields.find((f) => f.id === when.before.field)?.type ?? '',
      )
    )
      problems.push(
        `${where}: when.before.field must be a date or computed date field of ${collection.id}`,
      );
  }
  if ('after' in when && !config.data.tables.some((c) => c.id === when.after.table))
    problems.push(`${where}: data table ${when.after.table} does not exist`);
  if ('each' in when) problems.push(...recordReminderProblems(r, when.each, config));
  else {
    // Daily and weekly reminders can have unless (D-563), but since there is no "this entry", link is not allowed.
    if ('every' in when && r.unless) {
      problems.push(...unlessProblems(r, undefined, config));
      if (r.unless.link !== undefined)
        problems.push(`${where}: unless.link only works with when.each (there is no entry here)`);
    } else if (r.unless)
      problems.push(`${where}: unless only works with when.each, when.every day, week or month`);
    if (r.done || r.snoozeMinutes !== undefined)
      problems.push(`${where}: done and snoozeMinutes only work with when.each`);
  }
  const toolId = reminderToolId(r.opens);
  if (toolId !== null) {
    if (!quickActionsOf(config).some((w) => w.id === toolId))
      problems.push(`${where}: opens missing quick action ${toolId}`);
  } else {
    const pageId = pageIdOf(r.opens);
    const page = pageId === null ? undefined : config.containers.pages.find((p) => p.id === pageId);
    if (pageId !== null && !page) problems.push(`${where}: opens missing page ${pageId}`);
    // D-342: Page for a single record does not know which entry to open.
    if (page?.of)
      problems.push(
        `${where}: opens page ${pageId}, which shows one entry of ${page.of}; open another page`,
      );
  }
  return problems;
}

/** Record-based reminders (D-316–D-318): schedule fields, unless conditions, and tools for the "Done" button. */
function recordReminderProblems(
  r: Reminder,
  each: { table: string; field: string },
  config: WorkspaceConfig,
): string[] {
  const where = `reminder ${r.id}`;
  const collection = config.data.tables.find((c) => c.id === each.table);
  if (!collection) return [`${where}: data table ${each.table} does not exist`];
  const problems: string[] = [];
  if (collection.fields.find((f) => f.id === each.field)?.type !== 'schedule')
    problems.push(`${where}: when.each.field must be a schedule field of ${collection.id}`);
  problems.push(...unlessProblems(r, collection, config));
  // Relation rules 12, 13: "Done" acts on this entry ($row, an entry from when.each.table), serving merely as a one-tap logging tool.
  if (r.done)
    problems.push(
      ...recordToolProblems(r.done, config, {
        label: `${where} done`,
        rowOf: collection,
        direct: true,
      }),
    );
  return problems;
}

/** unless table, filter, date field; link must point to collection (the record-based reminder table, D-317). */
function unlessProblems(
  r: Reminder,
  collection: Collection | undefined,
  config: WorkspaceConfig,
): string[] {
  const where = `reminder ${r.id}`;
  const u = r.unless;
  if (!u) return [];
  const other = config.data.tables.find((c) => c.id === u.table);
  if (!other) return [`${where} unless: data table ${u.table} does not exist`];
  const problems = conditionProblems(u.filter, expandCollection(config.data.tables, other)).map(
    (x) => `${where} unless: ${x}`,
  );
  const date = u.date;
  const dateType = date && other.fields.find((f) => f.id === date)?.type;
  if (date && !isSystemField(date) && dateType !== 'date' && dateType !== 'datetime')
    problems.push(`${where} unless: date must be a date or datetime field of ${other.id}`);
  if (u.link !== undefined && collection) {
    const link = other.fields.find((f) => f.id === u.link);
    if (link?.type !== 'link' || link.table !== collection.id)
      problems.push(
        `${where} unless: link must be a link field of ${other.id} pointing to ${collection.id}`,
      );
  }
  return problems;
}

export type NotificationTrigger =
  | { kind: 'daily'; hour: number; minute: number }
  /** weekday: 1 = Monday ... 7 = Sunday (converted to expo-notifications' 1 = Sunday when passed by the app). */
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'date'; at: number };

export interface PlannedNotification {
  /** Stable ID: reminder ID, weekly reminder plus weekday, expiration reminder plus record ID. */
  id: string;
  reminderId: string;
  title: string;
  body: string;
  trigger: NotificationTrigger;
  opens: ReminderTarget;
  /** Record-based reminder: which record it is (used by "Done" and "Snooze" buttons). */
  recordId?: string;
  /** Buttons on the notification (D-318): Done, Snooze, or both. */
  buttons?: NotificationButtons;
}

export type NotificationButtons = 'done' | 'snooze' | 'doneSnooze';

/** Which buttons are present on the reminder. */
export function reminderButtons(r: Reminder): NotificationButtons | undefined {
  if (r.done && r.snoozeMinutes !== undefined) return 'doneSnooze';
  if (r.done) return 'done';
  return r.snoozeMinutes !== undefined ? 'snooze' : undefined;
}

export interface PlanOptions {
  /** Occupied pending notifications (snoozed), deducted from the limit. */
  reserved?: number;
}

const hm = (time: string) => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return { hour, minute };
};

/**
 * Local notifications to schedule (pure function, re-run every time the app opens or
 * reminders/records change). records: records of tables used by expiration reminders (not
 * deleted). Expiration reminders: time of date minus daysBefore days, past ones are not
 * scheduled; at most MAX_DATE_NOTIFICATIONS items, most recent first.
 */
export function planNotifications(
  config: WorkspaceConfig,
  records: ReadonlyMap<string, readonly DataRecord[]>,
  now: Date,
  locale: Locale,
  options: PlanOptions = {},
): PlannedNotification[] {
  const repeating: PlannedNotification[] = [];
  const dated: PlannedNotification[] = [];
  const perRecord: PlannedNotification[] = [];
  const cal = calendarOf(config);
  for (const r of remindersOf(config)) {
    if (!r.enabled || reminderProblems(r, config).length > 0) continue;
    const when = r.when;
    const base = { reminderId: r.id, title: r.title, opens: r.opens };
    if ('after' in when) {
      // Remind once minutes minutes after adding a record (D-391); past ones are not scheduled. Body only writes table name (P-043 ②).
      const collection = config.data.tables.find((c) => c.id === when.after.table)!;
      for (const record of records.get(collection.id) ?? []) {
        const at = record.createdAt + when.minutes * 60_000;
        if (at <= now.getTime()) continue;
        dated.push({
          ...base,
          id: `${r.id}-${record.id}`,
          body: t(locale, 'reminderAddedAgo', { table: collection.name, n: when.minutes }),
          trigger: { kind: 'date', at },
        });
      }
      continue;
    }
    if ('before' in when && 'minutes' in when) {
      // Minutes minutes before the datetime moment (D-562); past ones are not scheduled. Body only writes table name and time (P-043 ②).
      const collection = config.data.tables.find((c) => c.id === when.before.table)!;
      const field = collection.fields.find((f) => f.id === when.before.field)!;
      for (const record of records.get(collection.id) ?? []) {
        const value = readValue(field, record.values[field.id]);
        if (typeof value !== 'string') continue;
        const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
        const { hour, minute } = hm(value.slice(11, 16));
        const at = new Date(y, m - 1, d, hour, minute).getTime() - when.minutes * 60_000;
        if (at <= now.getTime()) continue;
        dated.push({
          ...base,
          id: `${r.id}-${record.id}`,
          body: t(locale, 'reminderStartsIn', {
            table: collection.name,
            time: value.slice(11, 16),
            n: when.minutes,
          }),
          trigger: { kind: 'date', at },
        });
      }
      continue;
    }
    const { hour, minute } = hm(when.at);
    if ('each' in when) {
      perRecord.push(
        ...planRecordReminder(r, { ...when.each, at: when.at }, config, records, now, locale, cal),
      );
    } else if ('every' in when && (r.unless || when.every === 'month')) {
      // Daily and weekly reminders with unless (D-563): cannot be delegated to system daily
      // repetition, scheduled day by day, skipping days that already have records. Monthly date
      // reminders (D-577): system lacks monthly repeating notifications, scheduled this way for the
      // next few occurrences (also skipping when unless is present).
      const today = dayNumber(localDate(now))!;
      const span = when.every === 'month' ? 366 : 7 * 8;
      let added = 0;
      for (let day = today; added < RECORD_OCCURRENCES && day < today + span; day++) {
        const [y, m, d] = dateOfDayNumber(day).split('-').map(Number) as [number, number, number];
        const weekday = new Date(y, m - 1, d).getDay() || 7;
        if (when.every === 'week' && !when.days.includes(weekday)) continue;
        if (when.every === 'month' && d !== when.day) continue;
        const time = new Date(y, m - 1, d, hour, minute).getTime();
        if (time <= now.getTime()) continue;
        // Which day this time belongs to (times earlier than day start hour belong to the previous day, D-286).
        const logical = hour < cal.dayStartHour ? day - 1 : day;
        if (reminderSkipped(r, null, logical, config, records, now)) continue;
        dated.push({
          ...base,
          id: `${r.id}-${day}`,
          body: '',
          trigger: { kind: 'date', at: time },
        });
        added++;
      }
    } else if ('every' in when && when.every === 'day') {
      repeating.push({ ...base, id: r.id, body: '', trigger: { kind: 'daily', hour, minute } });
    } else if ('every' in when && when.every === 'week') {
      for (const weekday of [...new Set(when.days)].sort()) {
        repeating.push({
          ...base,
          id: `${r.id}-${weekday}`,
          body: '',
          trigger: { kind: 'weekly', weekday, hour, minute },
        });
      }
    } else {
      const collection = config.data.tables.find((c) => c.id === when.before.table)!;
      const before = when.days;
      for (const record of records.get(collection.id) ?? []) {
        // Calculated date (D-550) computed on the fly, not stored.
        const due = recordDay(record, collection, when.before.field, now, cal);
        if (typeof due !== 'string') continue;
        const [y, m, d] = due.split('-').map(Number) as [number, number, number];
        const at = new Date(y, m - 1, d - before, hour, minute);
        if (at.getTime() <= now.getTime()) continue;
        // Notifications appear on the lock screen: body only writes the table name, not the record title (P-043 ②).
        const table = collection.name;
        const body =
          before === 0
            ? t(locale, 'reminderDueToday', { table })
            : t(locale, 'reminderDueIn', {
                table,
                n: before,
                date: localDate(new Date(y, m - 1, d)),
              });
        dated.push({
          ...base,
          id: `${r.id}-${record.id}`,
          body,
          trigger: { kind: 'date', at: at.getTime() },
        });
      }
    }
  }
  const at = (n: PlannedNotification) => (n.trigger as { at: number }).at;
  const byTime = (a: PlannedNotification, b: PlannedNotification) => at(a) - at(b);
  dated.sort(byTime);
  perRecord.sort(byTime);
  // System limit (D-319): recurring reminders take one slot each and are scheduled first; remaining slots go to expiration and record-based reminders, most recent first.
  const room = Math.max(0, MAX_PENDING_NOTIFICATIONS - (options.reserved ?? 0) - repeating.length);
  const timed = [
    ...dated.slice(0, MAX_DATE_NOTIFICATIONS),
    ...perRecord.slice(0, MAX_RECORD_NOTIFICATIONS),
  ].sort(byTime);
  return [...repeating.slice(0, MAX_PENDING_NOTIFICATIONS), ...timed.slice(0, room)];
}

/** hour:minute of that day (local time). For times earlier than day start hour, belongs to the next calendar day (D-286). */
function atDay(day: number, hour: number, minute: number, cal: Calendar): number {
  const [y, m, d] = dateOfDayNumber(day).split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + (hour < cal.dayStartHour ? 1 : 0), hour, minute).getTime();
}

/** The day / week / month containing this day (days, inclusive of both ends). */
function periodAround(day: number, within: 'day' | 'week' | 'month', cal: Calendar) {
  if (within === 'day') return [day, day] as const;
  if (within === 'week') return [weekStartOf(day, cal), weekStartOf(day, cal) + 6] as const;
  const [y, m] = dateOfDayNumber(day).split('-').map(Number) as [number, number];
  return [
    dayNumber(localDate(new Date(y, m - 1, 1)))!,
    dayNumber(localDate(new Date(y, m, 0)))!,
  ] as const;
}

/**
 * unless (D-317): whether to skip day for this record. Checks if any record matching the filter
 * in the unless table (same table checks only self; if link is present, checks only those
 * pointing to this entry) falls within the time range of that day. Daily and weekly reminders
 * (D-563) have no entry (null), checking the whole table.
 */
export function reminderSkipped(
  r: Reminder,
  record: DataRecord | null,
  day: number,
  config: WorkspaceConfig,
  records: ReadonlyMap<string, readonly DataRecord[]>,
  now: Date,
): boolean {
  const u = r.unless;
  if (!u) return false;
  const table = config.data.tables.find((c) => c.id === u.table);
  if (!table) return false;
  const cal = calendarOf(config);
  const view = expandCollection(config.data.tables, table);
  const [from, to] = periodAround(day, u.within, cal);
  const candidates = (records.get(table.id) ?? []).filter((x) =>
    record === null
      ? true
      : table.id === reminderTable(r)?.table
        ? x.id === record.id
        : u.link === undefined || x.values[u.link] === record.id,
  );
  return filterRecords(candidates, view, u.filter, now, cal).some((x) => {
    const date = recordDay(x, view, u.date ?? 'createdAt', now, cal);
    const n = date === undefined ? undefined : dayNumber(date);
    return n !== undefined && n >= from && n <= to;
  });
}

/**
 * Notifications to schedule for a when.each reminder (D-316): each record follows its own
 * schedule for the next few occurrences, each at at; past ones or those skipped by unless are not
 * scheduled. Title is the record title, assembled locally (AI cannot see records), body is the
 * reminder title.
 */
function planRecordReminder(
  r: Reminder,
  each: { table: string; field: string; at: string },
  config: WorkspaceConfig,
  records: ReadonlyMap<string, readonly DataRecord[]>,
  now: Date,
  locale: Locale,
  cal: Calendar,
): PlannedNotification[] {
  const collection = config.data.tables.find((c) => c.id === each.table)!;
  const field = collection.fields.find((f) => f.id === each.field) as Extract<
    Collection['fields'][number],
    { type: 'schedule' }
  >;
  const today = todayNumber(now, cal);
  const buttons = reminderButtons(r);
  const out: PlannedNotification[] = [];
  for (const record of records.get(collection.id) ?? []) {
    const rule = readValue(field, record.values[field.id]) as ScheduleRule | undefined;
    if (!rule) continue;
    // Record's own time takes priority (D-346), falling back to reminder's at if absent.
    const { hour, minute } = hm(rule.time ?? each.at);
    const done = scheduleDoneDays(record, collection, field, now, cal);
    // Calculate extra: fill in with subsequent ones when today's time has passed.
    const days = scheduleOccurrences(
      rule,
      done,
      today,
      RECORD_OCCURRENCES + 1,
      cal,
      scheduleOptionsOf(record, field, cal),
    );
    const title = linkTitle(record, collection, locale);
    let added = 0;
    for (const day of days) {
      if (added >= RECORD_OCCURRENCES) break;
      const time = atDay(day, hour, minute, cal);
      if (time <= now.getTime() || reminderSkipped(r, record, day, config, records, now)) continue;
      out.push({
        id: `${r.id}-${record.id}-${day}`,
        reminderId: r.id,
        title,
        body: r.title,
        trigger: { kind: 'date', at: time },
        opens: r.opens,
        recordId: record.id,
        ...(buttons ? { buttons } : {}),
      });
      added++;
    }
  }
  return out;
}

/**
 * What the "Done" button should write (D-318): create is form input for a new record ("$row"
 * refers to this one), set / toggle / increment are values to modify on this record. Null if
 * fields or tables no longer exist (or are disallowed by setAll checks). Result is then passed to
 * prepareRecordValues.
 */
export function reminderDoneInput(
  done: RecordTool,
  config: WorkspaceConfig,
  collection: Collection,
  record: DataRecord,
  now: Date,
  /** Computed entry (D-565: used when done copies its fields or calculates from its date; when omitted, only reads stored values). */
  computed: DataRecord = record,
):
  | { kind: 'create'; collection: Collection; input: Record<string, unknown> }
  | { kind: 'update'; input: Record<string, unknown> }
  | null {
  const cal = calendarOf(config);
  const entry = { record: computed, view: expandCollection(config.data.tables, collection) };
  if (done.do === 'create') {
    const target = config.data.tables.find((c) => c.id === done.table);
    if (!target) return null;
    return {
      kind: 'create',
      collection: target,
      input: createInput(target, done.values, { now, cal, rowId: record.id, entry }),
    };
  }
  if (done.do === 'setAll' || done.do === 'createAll' || done.do === 'remove') return null;
  const input = rowUpdateInput(done, collection, record.values, {
    now,
    cal,
    rowId: record.id,
    entry,
  });
  return input ? { kind: 'update', input } : null;
}

/** Notification ID for snooze (one per record, preserved during reordering, cancelled when 'Done' is tapped). */
export const snoozeId = (reminderId: string, recordId: string) =>
  `snooze-${reminderId}-${recordId}`;

/**
 * Tables whose records should be read by due date reminders and record-based reminders
 * (record-based ones compute target records: e.g., a schedule's lastDone might be an aggregate,
 * and an unless filter might use looked-up values).
 */
export const reminderCollections = (config: WorkspaceConfig): string[] => [
  ...new Set(
    remindersOf(config).flatMap((r) => {
      const on = reminderTable(r);
      // Daily and weekly reminders with an unless condition (D-563) only read the unless table.
      if (r.enabled && r.unless && 'every' in r.when) return [r.unless.table];
      if (!r.enabled || !on) return [];
      return r.unless && 'each' in r.when ? [on.table, r.unless.table] : [on.table];
    }),
  ),
];

/** Whether there are any active reminders (does not request notification permissions when none exist). */
export const hasActiveReminders = (config: WorkspaceConfig) =>
  remindersOf(config).some((r) => r.enabled);

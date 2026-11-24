import { z } from 'zod';

import {
  DEFAULT_CALENDAR,
  dateOfDayNumber,
  twoWeekStartOf,
  weekStartOf,
  type Calendar,
} from './calendar';
import { dayNumber } from './formula';
import { localeTag } from './localization';
import { t } from './messages';
import type { Locale } from './schema-primitives';

// Schedules (D-292–D-296): Each record stores a repetition rule (daily, specific days of the week,
// N times per week, specific days of the month, every N days, specific day of the year). The next
// occurrence, whether it is due today, and days overdue are calculated from the rule and completed
// dates. Pure logic: day numbers are added/subtracted for dates, and "today" and "this week" are
// determined by the calendar (D-286). Rules are compact whitelist JSON, not rrule strings. D-340
// adds "once": do only once, can be scheduled for a specific day or have no date; ends (marked as
// finished) after being done once.

const perDay = z.number().int().min(1).max(20).optional();
/** Time of day (D-346): Can be included in any rule, e.g., "tomorrow at 03:00", "every Monday at 09:00"; used by record-based reminders. */
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .optional();

/** Days of the week: 1 = Monday … 7 = Sunday (ISO). */
const Weekday = z.number().int().min(1).max(7);
/** Days of the month: 1–31, -1 = last day. Days greater than the number of days in the month fall on the last day. */
const MonthDay = z.union([z.number().int().min(1).max(31), z.literal(-1)]);

/** Maximum occurrences per time period (at most once per day, e.g., at most 7 times per week). */
const TIMES_LIMIT = { week: 7, twoWeeks: 14, month: 31, year: 366 } as const;
export type SchedulePer = keyof typeof TIMES_LIMIT;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Date for "once" (YYYY-MM-DD), must be a valid date. */
const OnceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (d) => {
      const n = dayNumber(d);
      return n !== undefined && dateOfDayNumber(n) === d;
    },
    { message: 'not a real date' },
  );

export const ScheduleRuleSchema = z.discriminatedUnion('repeat', [
  // D-340: Do only once, date omitted = no date (do when possible). No perDay property.
  z.strictObject({ repeat: z.literal('once'), date: OnceDate.optional(), time }),
  z.strictObject({ repeat: z.literal('daily'), perDay, time }),
  z.strictObject({
    repeat: z.literal('weekdays'),
    days: z.array(Weekday).min(1).max(7),
    perDay,
    time,
  }),
  z
    .strictObject({
      repeat: z.literal('times'),
      per: z.enum(['week', 'twoWeeks', 'month', 'year']),
      count: z.number().int().min(1).max(366),
      perDay,
      time,
    })
    .refine((r) => r.count <= TIMES_LIMIT[r.per], {
      message: 'count can be at most 7 a week, 14 every two weeks, 31 a month, 366 a year',
    }),
  z.strictObject({
    repeat: z.literal('monthDays'),
    days: z.array(MonthDay).min(1).max(32),
    perDay,
    time,
  }),
  z.strictObject({
    repeat: z.literal('interval'),
    every: z.number().int().min(1).max(60),
    perDay,
    time,
  }),
  z
    .strictObject({
      repeat: z.literal('yearly'),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      perDay,
      time,
    })
    .refine((r) => r.day <= DAYS_IN_MONTH[r.month - 1]!, { message: 'no such day in that month' }),
]);
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

const KEYS: Record<ScheduleRule['repeat'], readonly string[]> = {
  once: ['date'],
  daily: [],
  weekdays: ['days'],
  times: ['per', 'count'],
  monthDays: ['days'],
  interval: ['every'],
  yearly: ['month', 'day'],
};

/**
 * Permissive reading (values stored in records, form inputs): keeps only recognized rule
 * properties, sorts and deduplicates days, omits perDay 1; returns undefined for unmatched values
 * (simply not displayed).
 */
export function readSchedule(raw: unknown): ScheduleRule | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const keys = KEYS[r.repeat as ScheduleRule['repeat']];
  if (!keys) return undefined;
  const picked: Record<string, unknown> = { repeat: r.repeat };
  for (const k of keys) {
    const v = r[k];
    if (v === undefined) continue;
    picked[k] = Array.isArray(v)
      ? [...new Set(v)].sort((a, b) => (a === -1 ? 99 : a) - (b === -1 ? 99 : b))
      : v;
  }
  if (r.perDay !== undefined && r.perDay !== 1 && r.repeat !== 'once') picked.perDay = r.perDay;
  if (typeof r.time === 'string' && r.time !== '') picked.time = r.time;
  const parsed = ScheduleRuleSchema.safeParse(picked);
  return parsed.success ? parsed.data : undefined;
}

// ---- Calculations ----

const utc = (day: number) => new Date(day * 86_400_000);
/** Day of the week: 1 = Monday … 7 = Sunday. Day 0 (1970-01-01) is Thursday. */
const isoWeekday = (day: number) => ((((day + 3) % 7) + 7) % 7) + 1;
const monthLength = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const dayOfUtc = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 86_400_000;

/** Day of the month where the schedule falls (-1 and day numbers exceeding the month both mean the end of the month). */
const clampDay = (x: number, length: number) => (x === -1 ? length : Math.min(x, length));

/** Whether this day is one of the days in the rule (used only for fixed days: every day, certain days of the week, specific dates of the month, or specific dates of the year). */
function matches(rule: ScheduleRule, day: number): boolean {
  const d = utc(day);
  const dom = d.getUTCDate();
  const length = monthLength(d.getUTCFullYear(), d.getUTCMonth());
  switch (rule.repeat) {
    case 'daily':
      return true;
    case 'weekdays':
      return rule.days.includes(isoWeekday(day));
    case 'monthDays':
      return rule.days.some((x) => clampDay(x, length) === dom);
    case 'yearly':
      return d.getUTCMonth() === rule.month - 1 && clampDay(rule.day, length) === dom;
    default:
      return false;
  }
}

/** The first day in the rule starting from 'from' (inclusive). For February 29th in leap years, it may look ahead up to 4 years. */
function firstMatch(rule: ScheduleRule, from: number): number {
  for (let day = from; day < from + 1500; day++) if (matches(rule, day)) return day;
  return from;
}

/** Time period for "N times": the first and last day (in days) of the period containing today. */
function periodOf(per: SchedulePer, today: number, cal: Calendar): [number, number] {
  if (per === 'week') return [weekStartOf(today, cal), weekStartOf(today, cal) + 6];
  if (per === 'twoWeeks') return [twoWeekStartOf(today, cal), twoWeekStartOf(today, cal) + 13];
  const d = utc(today);
  const y = d.getUTCFullYear();
  if (per === 'year') return [dayOfUtc(y, 0, 1), dayOfUtc(y, 11, 31)];
  const m = d.getUTCMonth();
  return [dayOfUtc(y, m, 1), dayOfUtc(y, m + 1, 0)];
}

export interface ScheduleStatus {
  /**
   * Next occurrence (in days): the uncompleted occurrence; if past due, it is the due date. An
   * occurrence has no next date if it has no fixed date or is already completed (D-340).
   */
  next: number | undefined;
  /** Due today (including already overdue ones). */
  dueToday: boolean;
  /** Number of days overdue (0 = not overdue). "N times" rules are not considered overdue. */
  overdueDays: number;
  /** "Once" occurrence is already completed (D-340): no longer has a next occurrence, and pending due filters exclude it. */
  finished?: true;
}

export interface ScheduleOptions {
  /**
   * Early completion counts as this occurrence (D-341, schedule field countEarly): only affects
   * fixed days (every day, certain days of the week, specific dates of the month, specific dates
   * of the year). When disabled, follows D-293: next occurrence = the first day in the rule after
   * the last completion; early completions do not count (e.g., paying the 1st's bill on the 28th
   * still leaves the 1st due).
   */
  countEarly?: boolean;
  /** Start date of this rule (in days, the creation day of the record): countEarly counts from the first rule day on or after this date. */
  since?: number;
}

/**
 * Status of the rule today. 'done' is the completed days (in days, as many as completions; days
 * after today are excluded).
 * - Once (D-340): completes once done; when not done, the next occurrence is its due date, or has
 * no next date if it has no fixed date.
 * - Every N days: N days after the last completion; today if never done.
 * - Fixed days: the first rule day after the last completion (may already be past = overdue); the
 * first rule day from today if never done. When countEarly is enabled, follows Todoist's
 * algorithm: the first rule day on or after 'since' is the "target occurrence", and each
 * completion (regardless of whether it's early or late) advances the target to the first rule day
 * after the later of the current target and the completion date, so early completions also count
 * towards the current occurrence.
 * - N times per week/two weeks/month/year: completed days in this period are less than N; today
 * if not yet done today, tomorrow if already done today (or the first day of the next period if
 * done on the last day of this period); or the first day of the next period if target count is
 * reached.
 * - perDay times per day: considered done only when completed `perDay` times on that day.
 */
export function scheduleStatus(
  rule: ScheduleRule,
  done: readonly number[],
  today: number,
  cal: Calendar = DEFAULT_CALENDAR,
  options: ScheduleOptions = {},
): ScheduleStatus {
  const times = rule.repeat === 'once' ? 1 : (rule.perDay ?? 1);
  const counts = new Map<number, number>();
  for (const day of done) if (day <= today) counts.set(day, (counts.get(day) ?? 0) + 1);
  const full = (day: number) => (counts.get(day) ?? 0) >= times;
  const last = counts.size === 0 ? undefined : Math.max(...counts.keys());

  let next: number;
  if (rule.repeat === 'once') {
    if (last !== undefined)
      return { next: undefined, dueToday: false, overdueDays: 0, finished: true };
    const day = rule.date === undefined ? undefined : dayNumber(rule.date);
    if (day === undefined) return { next: undefined, dueToday: false, overdueDays: 0 };
    return { next: day, dueToday: day <= today, overdueDays: Math.max(0, today - day) };
  }
  if (rule.repeat === 'times') {
    const [start, end] = periodOf(rule.per, today, cal);
    let daysDone = 0;
    for (let day = start; day <= today; day++) if (full(day)) daysDone++;
    if (daysDone >= rule.count) next = end + 1;
    else if (!full(today)) next = today;
    else next = today + 1;
    return { next, dueToday: next <= today, overdueDays: 0 };
  }
  if (rule.repeat === 'interval') {
    next = last === undefined ? today : full(last) ? last + rule.every : last;
  } else if (options.countEarly && last !== undefined && full(last)) {
    const doneDays = [...counts.keys()].filter(full).sort((a, b) => a - b);
    const first = doneDays[0]!;
    let due = firstMatch(rule, Math.min(options.since ?? first, first));
    for (const day of doneDays) due = firstMatch(rule, Math.max(due, day) + 1);
    next = due;
  } else {
    next = firstMatch(rule, last === undefined ? today : full(last) ? last + 1 : last);
  }
  return { next, dueToday: next <= today, overdueDays: Math.max(0, today - next) };
}

/**
 * Next count occurrences (in days, starting today, D-316): the first is the next occurrence from
 * scheduleStatus (today if overdue), and subsequent ones are calculated assuming each is
 * completed on time (`perDay` completions on that due date). Used for sorting reminders:
 * recalculates when the user actually performs the action and records change. "Once" has at most
 * one occurrence (D-340): when a date is set and not yet done, it is that date (today if
 * overdue).
 */
export function scheduleOccurrences(
  rule: ScheduleRule,
  done: readonly number[],
  today: number,
  count: number,
  cal: Calendar = DEFAULT_CALENDAR,
  options: ScheduleOptions = {},
): number[] {
  const assumed = [...done];
  const days: number[] = [];
  let from = today;
  for (let i = 0; i < count; i++) {
    const next = scheduleStatus(rule, assumed, from, cal, options).next;
    if (next === undefined) break;
    const day = Math.max(next, from);
    days.push(day);
    for (let k = 0; k < (rule.repeat === 'once' ? 1 : (rule.perDay ?? 1)); k++) assumed.push(day);
    from = day;
  }
  return days;
}

// ---- Display ----

/** A single sentence for the rule (complete sentences for all three languages, singular/plural determined by isSingular). */
export function scheduleText(rule: ScheduleRule, locale: Locale): string {
  const base = ruleText(rule, locale);
  const text = rule.time ? t(locale, 'scheduleAtTime', { rule: base, time: rule.time }) : base;
  return rule.repeat !== 'once' && rule.perDay
    ? t(locale, 'schedulePerDay', { rule: text, n: rule.perDay })
    : text;
}

const TIMES_KEY = {
  week: 'scheduleTimesWeek',
  twoWeeks: 'scheduleTimesTwoWeeks',
  month: 'scheduleTimesMonth',
  year: 'scheduleTimesYear',
} as const;

function ruleText(rule: ScheduleRule, locale: Locale): string {
  const list = (items: string[]) => items.join(t(locale, 'separatorList'));
  switch (rule.repeat) {
    case 'once': {
      const day = rule.date === undefined ? undefined : dayNumber(rule.date);
      return day === undefined
        ? t(locale, 'scheduleOnceAnytime')
        : t(locale, 'scheduleOnceOn', { date: shortDate(day, day, locale) });
    }
    case 'daily':
      return t(locale, 'scheduleDaily');
    case 'weekdays':
      return t(locale, 'scheduleWeekdays', {
        days: list(rule.days.map((day) => weekdayName(day, locale))),
      });
    case 'times':
      return t(locale, TIMES_KEY[rule.per], { n: rule.count });
    case 'monthDays':
      return t(locale, 'scheduleMonthDays', {
        days: list(
          rule.days.map((x) =>
            x === -1 ? t(locale, 'scheduleLastDay') : t(locale, 'scheduleMonthDay', { day: x }),
          ),
        ),
      });
    case 'interval':
      return t(locale, 'scheduleInterval', { n: rule.every });
    case 'yearly':
      return t(locale, 'scheduleYearly', { date: monthDayName(rule.month, rule.day, locale) });
  }
}

/** Short weekday name (Mon, Mon, lun.). 2024-01-01 is Monday. */
export function weekdayName(day: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { weekday: 'short', timeZone: 'UTC' }).format(
    utc(dayOfUtc(2024, 0, day)),
  );
}

/** Month and day (March 5, March 5, 5 mars), using leap year 2024 so February 29 is valid. */
export function monthDayName(month: number, day: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(utc(dayOfUtc(2024, month - 1, day)));
}

/** Month name (used when selecting a day of the year). */
export function monthName(month: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { month: 'short', timeZone: 'UTC' }).format(
    utc(dayOfUtc(2024, month - 1, 1)),
  );
}

/** Format a date as a short date (Nov 5, Nov 5, 5 nov.), including the year if not the current year. */
export function shortDate(day: number, today: number, locale: Locale): string {
  const sameYear = dateOfDayNumber(day).slice(0, 4) === dateOfDayNumber(today).slice(0, 4);
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(utc(day));
}

/**
 * Description of the next occurrence: today, tomorrow, overdue by X days, or the next date (with
 * year if not current year). For "Once" (D-340), displays the date itself (without "Next"),
 * "Completed" when finished, or "Unscheduled" if it has no date.
 */
export function scheduleStatusText(
  status: ScheduleStatus,
  today: number,
  locale: Locale,
  once = false,
): string {
  if (status.finished) return t(locale, 'scheduleFinished');
  if (status.next === undefined) return t(locale, 'scheduleNoDate');
  if (status.overdueDays > 0) return t(locale, 'scheduleOverdue', { n: status.overdueDays });
  if (status.dueToday) return t(locale, 'scheduleToday');
  if (status.next === today + 1) return t(locale, 'scheduleTomorrow');
  const date = shortDate(status.next, today, locale);
  return once ? date : t(locale, 'scheduleNext', { date });
}

/**
 * Due filter values (D-294): due today (including overdue), overdue, due this week (up to the
 * last day of the week, including overdue); pending (D-340) = not yet completed: has a rule, not
 * a completed "once" (unscheduled items also count).
 */
export const SCHEDULE_DUE = ['today', 'overdue', 'thisWeek', 'pending'] as const;
export type ScheduleDue = (typeof SCHEDULE_DUE)[number];

/** Whether the status matches the due filter value. */
export function scheduleDue(
  status: ScheduleStatus,
  due: ScheduleDue,
  today: number,
  cal: Calendar = DEFAULT_CALENDAR,
): boolean {
  if (due === 'pending') return !status.finished;
  if (due === 'overdue') return status.overdueDays > 0;
  if (due === 'today') return status.dueToday;
  return status.next !== undefined && status.next <= weekStartOf(today, cal) + 6;
}

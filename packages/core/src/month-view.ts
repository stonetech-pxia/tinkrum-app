import { dateOfDayNumber, todayNumber, weekStartOf, type Calendar } from './calendar';
import {
  aggregateRecords,
  fieldOf,
  readValue,
  recordDay,
  scheduleDoneDays,
  scheduleOptionsOf,
  type DataRecord,
} from './data';
import { dayNumber } from './formula';
import { localeTag } from './localization';
import { scheduleOccurrences, type ScheduleRule } from './schedule';
import type { DayRange } from './page-period';
import type { Collection, Locale } from './schema';

// Month calendar view for record lists (D-305): a grid of months, showing record counts and
// color-coded by a single-choice field per day. Pure logic: which weeks, daily records, light/dark
// tiers, month and weekday names; the app only handles rendering the grid. Days are compared using
// dayNumber, and record day assignment uses recordDay (what hour a day starts from, D-286). v34:
// date is block's source.group.by (defaults to dateFieldOf if omitted), and coloring is show.color.
// D-348: date can also be a schedule field, with an entry falling on each subsequent occurrence
// (expired ones fall on today, and completed occurrences are not displayed).

/** Maximum number of subsequent occurrences for a schedule in the month calendar (daily rule is roughly one year). */
const MAX_OCCURRENCES = 370;

/** Which days a record falls on within [first, last]. */
function daysOf(
  record: DataRecord,
  collection: Collection,
  dateField: string,
  first: number,
  last: number,
  now: Date,
  cal: Calendar,
  until?: string,
): number[] {
  const field = fieldOf(collection, dateField);
  if (field?.type !== 'schedule') {
    const date = recordDay(record, collection, dateField, now, cal);
    const n = date === undefined ? undefined : dayNumber(date);
    if (n === undefined) return [];
    const endText = until ? recordDay(record, collection, until, now, cal) : undefined;
    const end = endText === undefined ? n : Math.max(n, dayNumber(endText) ?? n);
    const from = Math.max(n, first),
      to = Math.min(end, last);
    return from > to ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const rule = readValue(field, record.values[field.id]) as ScheduleRule | undefined;
  const today = todayNumber(now, cal);
  if (!rule || last < today) return [];
  const done = scheduleDoneDays(record, collection, field, now, cal);
  const options = scheduleOptionsOf(record, field, cal);
  const days: number[] = [];
  // Batch generation, continuing up to the last day of the current month.
  for (const day of scheduleOccurrences(rule, done, today, MAX_OCCURRENCES, cal, options)) {
    if (day > last) break;
    if (day >= first) days.push(day);
  }
  return days;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Month containing today (YYYY-MM), based on the configured day start hour. */
export const currentMonth = (now: Date, cal: Calendar): string =>
  dateOfDayNumber(todayNumber(now, cal)).slice(0, 7);

/** Shift forward or backward by a number of months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** First and last day of this month (day numbers). */
function monthBounds(month: string): [number, number] {
  const first = dayNumber(`${month}-01`)!;
  const last = dayNumber(`${shiftMonth(month, 1)}-01`)! - 1;
  return [first, last];
}

/** Weeks to render (7 day numbers per week), from the week containing the first day of the month to the week containing the last day; week start follows cal. */
export function monthWeeks(month: string, cal: Calendar): number[][] {
  const [first, last] = monthBounds(month);
  const weeks: number[][] = [];
  for (let start = weekStartOf(first, cal); start <= last; start += 7)
    weeks.push(Array.from({ length: 7 }, (_, i) => start + i));
  return weeks;
}

/**
 * Range to query when reading records for this month (fetching only necessary records): dates
 * from the 1st to before the 2nd of the next month; date-times and creation times follow the same
 * rule, reading an extra day because when a day starts at a given morning hour, records from the
 * early hours of the 1st of the next month still count towards the last day of the current month
 * (D-286). from / until compare stored date or date-time strings, while fromMs / untilMs compare
 * creation time (local timezone midnight).
 */
export function monthQueryRange(month: string): {
  from: string;
  until: string;
  fromMs: number;
  untilMs: number;
} {
  const [, last] = monthBounds(month);
  return dayQueryRange({ start: `${month}-01`, end: dateOfDayNumber(last) });
}

/** Database read boundaries for precise day ranges; reads an extra day at the end to cover dayStart. */
export function dayQueryRange(range: DayRange) {
  const from = range.start;
  const until = dateOfDayNumber(dayNumber(range.end)! + 2);
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getTime();
  };
  return { from, until, fromMs: ms(from), untilMs: ms(until) };
}

export interface MonthDay {
  count: number;
  value?: number;
  /** Option ID of the coloring single-choice field on the last record of this day; null if unselected (or option was deleted). Also null when no coloring field is present. */
  optionId: string | null;
  /** Records for this day, latest first (ordered by date-time, then by creation time). */
  records: DataRecord[];
}

/** Records for each day of the month (only days with records), and the maximum number of records on any single day. date is the date field, color is the coloring single-choice field. */
export function monthDays(
  records: readonly DataRecord[],
  collection: Collection,
  spec: {
    date: string;
    color?: string | undefined;
    until?: string | undefined;
    day?: { aggregate: 'count' | 'sum'; field?: string | undefined } | undefined;
  },
  month: string | DayRange,
  now: Date,
  cal: Calendar,
): { days: Map<number, MonthDay>; max: number } {
  const [first, last] =
    typeof month === 'string'
      ? monthBounds(month)
      : [dayNumber(month.start)!, dayNumber(month.end)!];
  const color = spec.color ? fieldOf(collection, spec.color) : undefined;
  const byDay = new Map<number, { record: DataRecord; key: string }[]>();
  for (const record of records) {
    // Ordering within the same day: date-time fields ordered by their value, schedules by hour, and remaining items by creation time.
    const raw = record.values[spec.date];
    const at =
      typeof raw === 'string'
        ? raw
        : typeof (raw as { time?: unknown } | undefined)?.time === 'string'
          ? (raw as { time: string }).time
          : '';
    const key = `${at}|${String(record.createdAt).padStart(15, '0')}`;
    for (const n of daysOf(record, collection, spec.date, first, last, now, cal, spec.until)) {
      const list = byDay.get(n);
      if (list) list.push({ record, key });
      else byDay.set(n, [{ record, key }]);
    }
  }
  const days = new Map<number, MonthDay>();
  let max = 0;
  for (const [n, list] of byDay) {
    list.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const latest = list[0]!.record;
    const option = color?.type === 'choice' ? readValue(color, latest.values[color.id]) : undefined;
    const value =
      spec.day?.aggregate === 'sum'
        ? (aggregateRecords(
            list.map((x) => x.record),
            collection,
            'sum',
            spec.day.field,
          ) ?? 0)
        : list.length;
    days.set(n, {
      ...(spec.day ? { value } : {}),
      count: list.length,
      optionId: typeof option === 'string' ? option : null,
      records: list.map((x) => x.record),
    });
    max = Math.max(max, Math.abs(value));
  }
  return { days, max };
}

/** Grid intensity level when no coloring field is present: 0 is no records, levels 1-4 are tiered based on the day with the most records in the month. */
export function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}

/** Month title: October 2026, October 2026, octobre 2026. */
export function monthTitle(month: string, locale: Locale): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Weekday header (shortest form: e.g., M, L), starting from the first day of the week. */
export function weekdayLabels(cal: Calendar, locale: Locale): string[] {
  const format = new Intl.DateTimeFormat(localeTag(locale), { weekday: 'narrow', timeZone: 'UTC' });
  // Day number 4 is 1970-01-05, a Monday.
  const start = cal.weekStart === 'monday' ? 4 : 3;
  return Array.from({ length: 7 }, (_, i) => format.format(new Date((start + i) * 86_400_000)));
}

/** Full date for a given day (title when listing records for that day): Thursday, October 29, jeudi 29 octobre. */
export function dayTitle(day: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(day * 86_400_000));
}

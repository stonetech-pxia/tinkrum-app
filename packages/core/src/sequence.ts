import { DEFAULT_CALENDAR, todayNumber, weekStartOf, type Calendar } from './calendar';
import { readValue, recordDay, fieldOf, type DataRecord } from './data';
import { round } from './field-values';
import { dayNumber } from './formula';
import { type Collection, type Days, type SequenceAggregate, type StreakUnit } from './schema';

// Sequential aggregates (D-284): check which days records fall on rather than summing values. Pure
// logic, interface is "set of records + date field + parameters -> value": currently used by
// statistics and charts, and will be used by summary fields (P3) in the future. Days are converted
// to dayNumber for comparison, categorized by "start hour of day, start day of week" (D-286).

export { isSequenceAggregate, sequenceText } from './sequence-text';

/** Streak rule: requirement of at least perUnit entries per unit (day/week/month) to count as achieved; records with the skip option count as "skipped". */
export interface StreakRule {
  unit: StreakUnit;
  perUnit: number;
  skip?: Days['skip'];
}

/**
 * Date to use for calculations (Days.date, group.by for charts grouped by time, group.by for
 * calendars): use if specified; otherwise, use the first date field in the table, falling back to
 * the first datetime field (D-279), and finally creation time.
 */
export function dateFieldOf(collection: Collection, date: string | undefined): string {
  return (
    date ??
    collection.fields.find((f) => f.type === 'date')?.id ??
    collection.fields.find((f) => f.type === 'datetime')?.id ??
    'createdAt'
  );
}

export interface SequenceContext {
  /** Date to use: date field, datetime field (D-279), or createdAt / updatedAt (classified into a day based on the start hour of the day). */
  dateField: string;
  now: Date;
  cal?: Calendar;
}

/** Day numbers for each record; records without dates are excluded. */
function recordDays(records: readonly DataRecord[], collection: Collection, ctx: SequenceContext) {
  const cal = ctx.cal ?? DEFAULT_CALENDAR;
  return records.flatMap((r) => {
    const v = recordDay(r, collection, ctx.dateField, ctx.now, cal);
    const day = typeof v === 'string' ? dayNumber(v) : undefined;
    return day === undefined ? [] : [{ record: r, day }];
  });
}

/** Which unit a day falls into (unit ID, adjacent units differ by 1). */
function unitOf(day: number, unit: StreakUnit, cal: Calendar): number {
  if (unit === 'day') return day;
  if (unit === 'week') return Math.floor(weekStartOf(day, cal) / 7);
  const d = new Date(day * 86_400_000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * Current and best streaks (according to Streaks rules): achieving enough entries in a unit
 * increments +1; units with only "skipped" entries neither break nor increment; current unit
 * (today/this week/this month) does not break until it has passed without fulfillment. Records
 * after today are ignored.
 */
export function streakOf(
  records: readonly DataRecord[],
  collection: Collection,
  rule: StreakRule,
  ctx: SequenceContext,
): { current: number; best: number } {
  const cal = ctx.cal ?? DEFAULT_CALENDAR;
  const today = todayNumber(ctx.now, cal);
  const skipField = rule.skip ? fieldOf(collection, rule.skip.field) : undefined;
  const done = new Map<number, number>();
  const skipped = new Set<number>();
  for (const { record, day } of recordDays(records, collection, ctx)) {
    if (day > today) continue;
    const unit = unitOf(day, rule.unit, cal);
    const isSkip =
      skipField !== undefined &&
      // Multi-select (D-607): selecting the "skip" item counts as skipped.
      [readValue(skipField, record.values[skipField.id])].flat().includes(rule.skip!.option);
    if (isSkip) skipped.add(unit);
    else done.set(unit, (done.get(unit) ?? 0) + 1);
  }
  const units = [...done.keys(), ...skipped];
  if (units.length === 0) return { current: 0, best: 0 };
  const last = unitOf(today, rule.unit, cal);
  const state = (u: number) =>
    (done.get(u) ?? 0) >= rule.perUnit ? 'done' : skipped.has(u) ? 'skip' : 'missed';
  let best = 0;
  let run = 0;
  for (let u = Math.min(...units); u <= last; u++) {
    const s = state(u);
    if (s === 'done') best = Math.max(best, ++run);
    else if (s === 'missed' && u !== last) run = 0;
  }
  return { current: run, best };
}

/** Days since the most recent entry (before or on today); null if no records. */
export function daysSince(
  records: readonly DataRecord[],
  collection: Collection,
  ctx: SequenceContext,
): number | null {
  const today = todayNumber(ctx.now, ctx.cal ?? DEFAULT_CALENDAR);
  const past = recordDays(records, collection, ctx).filter((d) => d.day <= today);
  return past.length === 0 ? null : today - Math.max(...past.map((d) => d.day));
}

/** Distinct days with records, sorted from earliest to latest. */
const distinctDayList = (
  records: readonly DataRecord[],
  collection: Collection,
  ctx: SequenceContext,
) => [...new Set(recordDays(records, collection, ctx).map((d) => d.day))].sort((a, b) => a - b);

/** Average interval in days between adjacent recorded days (one decimal place); null if fewer than two recorded days. */
export function avgInterval(
  records: readonly DataRecord[],
  collection: Collection,
  ctx: SequenceContext,
): number | null {
  const days = distinctDayList(records, collection, ctx);
  return days.length < 2 ? null : round((days.at(-1)! - days[0]!) / (days.length - 1), 1);
}

/** Number of days with records. */
export const distinctDays = (
  records: readonly DataRecord[],
  collection: Collection,
  ctx: SequenceContext,
): number => distinctDayList(records, collection, ctx).length;

/**
 * Value displayed by number blocks and summary fields: streak is the current streak, with best
 * provided separately; others have only value. Dates follow days.date (dateFieldOf); days.unit,
 * perUnit, and skip apply only to streak.
 */
export function sequenceValue(
  records: readonly DataRecord[],
  collection: Collection,
  aggregate: SequenceAggregate,
  days: Days | undefined,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): { value: number | null; best?: number } {
  const ctx: SequenceContext = { dateField: dateFieldOf(collection, days?.date), now, cal };
  switch (aggregate) {
    case 'streak': {
      // skip requires both field and option to be specified (same as v33).
      const skip = days?.skip?.field && days.skip.option ? days.skip : undefined;
      const rule = { unit: days?.unit ?? 'day', perUnit: days?.perUnit ?? 1, skip };
      const { current, best } = streakOf(records, collection, rule, ctx);
      return { value: current, best };
    }
    case 'daysSince':
      return { value: daysSince(records, collection, ctx) };
    case 'avgInterval':
      return { value: avgInterval(records, collection, ctx) };
    case 'distinctDays':
      return { value: distinctDays(records, collection, ctx) };
  }
}

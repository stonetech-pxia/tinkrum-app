import { localDate } from './field-values';
import { dayNumber } from './formula';
import type { CalendarSettings, WorkspaceConfig } from './schema';

// Defines when a day or week starts (D-286). All day- or week-based aggregation calculations (time
// periods, chart groupings, consecutive days, default "today" value for date fields, which day
// creation time falls under) retrieve "today" and "this week" from here. Dates are added and
// subtracted using day numbers (integer day count in UTC) rather than milliseconds, preventing
// daylight saving time transitions from adding or removing an extra day.

export interface Calendar {
  /** Hour at which a day starts (0-6): 2 means 1:30 AM still counts as the previous day. */
  dayStartHour: number;
  weekStart: 'monday' | 'sunday';
  /** Starting day for two-week periods (thisTwoWeeks); defaults to a fixed day falling on the first day of the week. */
  twoWeekStart?: string;
}

export const DEFAULT_CALENDAR: Calendar = { dayStartHour: 0, weekStart: 'monday' };

/** Configuration settings, using default values for any omitted properties. */
export function calendarOf(config: Pick<WorkspaceConfig, 'data'>): Calendar {
  const c: CalendarSettings = config.data.calendar ?? {};
  return {
    dayStartHour: c.dayStartHour ?? DEFAULT_CALENDAR.dayStartHour,
    weekStart: c.weekStart ?? DEFAULT_CALENDAR.weekStart,
    ...(c.twoWeekStart ? { twoWeekStart: c.twoWeekStart } : {}),
  };
}

/** Day number -> YYYY-MM-DD. */
export const dateOfDayNumber = (n: number): string =>
  new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Determines which calendar day a given timestamp falls under (YYYY-MM-DD): timestamps before the day-start hour count toward the previous day. */
export function dayOf(d: Date, cal: Calendar = DEFAULT_CALENDAR): string {
  const day = localDate(d);
  return d.getHours() < cal.dayStartHour ? dateOfDayNumber(dayNumber(day)! - 1) : day;
}

/** Day number of today. */
export const todayNumber = (now: Date, cal: Calendar = DEFAULT_CALENDAR): number =>
  dayNumber(dayOf(now, cal))!;

/** First day (as a day number) of the week containing the specified day. Day number 0 is 1970-01-01, Thursday. */
export function weekStartOf(day: number, cal: Calendar = DEFAULT_CALENDAR): number {
  const sinceStart = (((day + (cal.weekStart === 'monday' ? 3 : 4)) % 7) + 7) % 7;
  return day - sinceStart;
}

/** When twoWeekStart is unspecified, two-week periods start from the first day of the week containing 2024-01-01 (Monday). */
const DEFAULT_TWO_WEEK_ANCHOR = dayNumber('2024-01-01')!;

/** First day (as a day number) of the two-week period containing the specified day. Days prior to the anchor date are stepped backward in 14-day intervals. */
export function twoWeekStartOf(day: number, cal: Calendar = DEFAULT_CALENDAR): number {
  const anchored = cal.twoWeekStart === undefined ? undefined : dayNumber(cal.twoWeekStart);
  const anchor = anchored ?? weekStartOf(DEFAULT_TWO_WEEK_ANCHOR, cal);
  return anchor + 14 * Math.floor((day - anchor) / 14);
}

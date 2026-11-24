import {
  dateOfDayNumber,
  todayNumber,
  weekStartOf,
  type Calendar,
  DEFAULT_CALENDAR,
} from './calendar';
import { filterRecords, periodRange, recordDay, type DataRecord } from './data';
import { dayNumber } from './formula';
import { previousPeriodRange } from './compare';
import { PAGE_PERIODS, type PagePeriod } from './schema-primitives';
import type { Collection, Condition, GroupUnit } from './schema';
import { dateFieldOf } from './sequence';

// User-selected: a fixed period or custom start/end dates (inclusive of both ends, YYYY-MM-DD).

/** User-selected: a fixed period or custom start/end dates (inclusive of both ends, YYYY-MM-DD). */
export type PageChoice = { period: PagePeriod } | { start: string; end: string };

/** A date range (inclusive of both ends). */
export interface DayRange {
  start: string;
  end: string;
}

const isPeriod = (c: PageChoice): c is { period: PagePeriod } => 'period' in c;

/** Currently selected range: current week spans Monday to Sunday (including future days in the current week, rendered as 0 on charts), and the last N days up to today. */
export function choiceRange(
  choice: PageChoice,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): DayRange {
  if (!isPeriod(choice)) return { start: choice.start, end: choice.end };
  const [start, end] = periodRange(choice.period, now, cal);
  return { start, end };
}

/**
 * Previous period for charts: the immediately preceding contiguous period for one-to-one
 * comparison (this week vs. last week, this month vs. last month, this year vs. last year, last N
 * days vs. preceding N days, custom period vs. an equally long preceding period).
 */
export function previousFullRange(
  choice: PageChoice,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): DayRange {
  const { start, end } = choiceRange(choice, now, cal);
  const startDay = dayNumber(start)!;
  const days = dayNumber(end)! - startDay + 1;
  const shift = (by: number, length: number): DayRange => ({
    start: dateOfDayNumber(startDay - by),
    end: dateOfDayNumber(startDay - by + length - 1),
  });
  if (!isPeriod(choice)) return shift(days, days);
  const [y, m] = start.split('-').map(Number) as [number, number];
  switch (choice.period) {
    case 'today':
      return shift(1, 1);
    case 'thisWeek':
      return shift(7, 7);
    case 'thisMonth':
    case 'lastMonth': {
      const last = new Date(Date.UTC(y, m - 1, 0));
      const prev = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
      return { start: `${prev}-01`, end: `${prev}-${String(last.getUTCDate()).padStart(2, '0')}` };
    }
    case 'thisYear':
    case 'lastYear':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    default:
      return shift(days, days);
  }
}

/** Previous period for number cards: matches existing "period-over-period comparison" (D-308); this month up to the 29th is compared against last month's 1-29. Custom compared against an equally long preceding period. */
export function previousToDateRange(
  choice: PageChoice,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): DayRange {
  if (!isPeriod(choice)) return previousFullRange(choice, now, cal);
  const [start, end] = previousPeriodRange(choice.period, now, cal);
  return { start, end };
}

/** Time grouping unit for charts: daily if range is <= 31 days, weekly if <= half a year, monthly otherwise. */
export function rangeUnit(range: DayRange): GroupUnit {
  const days = dayNumber(range.end)! - dayNumber(range.start)! + 1;
  return days <= 31 ? 'day' : days <= 184 ? 'week' : 'month';
}

/** Start dates for each segment in the range (from earliest to latest): weekly segments start on the Monday (or Sunday) of the week containing the range's start date; monthly segments start on the 1st of each month. */
export function rangeStarts(
  range: DayRange,
  unit: GroupUnit,
  cal: Calendar = DEFAULT_CALENDAR,
): string[] {
  const first = dayNumber(range.start)!;
  const last = dayNumber(range.end)!;
  const out: string[] = [];
  if (unit === 'day') {
    for (let d = first; d <= last; d++) out.push(dateOfDayNumber(d));
  } else if (unit === 'week') {
    for (let d = weekStartOf(first, cal); d <= last; d += 7) out.push(dateOfDayNumber(d));
  } else {
    const [sy, sm] = range.start.split('-').map(Number) as [number, number];
    const [ey, em] = range.end.split('-').map(Number) as [number, number];
    for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? (y++, (m = 1)) : m++)
      out.push(`${y}-${String(m).padStart(2, '0')}-01`);
  }
  return out;
}

/** Records falling within this date range (determined by the date field specified in ref; creation time or date/time fields also work). Records without dates fall outside all ranges. */
export function recordsInRange(
  records: readonly DataRecord[],
  collection: Collection,
  ref: string,
  range: DayRange,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): DataRecord[] {
  return records.filter((r) => {
    const day = recordDay(r, collection, ref, now, cal);
    return day !== undefined && day >= range.start && day <= range.end;
  });
}

/**
 * Record blocks following the page time range (D-561): like number cards, the inPeriod filter is
 * no longer used, while other conditions remain unchanged; filters by the selected range using
 * the date field from the original inPeriod, falling back to the table's first date field (or
 * creation time if none exist).
 */
export function recordsFollowingRange(
  records: readonly DataRecord[],
  collection: Collection,
  filter: readonly Condition[] | undefined,
  choice: PageChoice,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): DataRecord[] {
  const rest = (filter ?? []).filter((c) => c.op !== 'inPeriod');
  const ref =
    (filter ?? []).find((c) => c.op === 'inPeriod')?.field ?? dateFieldOf(collection, undefined);
  const based = filterRecords(records, collection, rest, now, cal);
  return recordsInRange(based, collection, ref, choiceRange(choice, now, cal), now, cal);
}

/** Whether the selection is a valid range: custom start/end are valid dates, start is not later than end, and maximum duration is five years. */
export function validChoice(choice: PageChoice): boolean {
  if (isPeriod(choice)) return (PAGE_PERIODS as readonly string[]).includes(choice.period);
  const a = dayNumber(choice.start);
  const b = dayNumber(choice.end);
  return a !== undefined && b !== undefined && a <= b && b - a < 366 * 5;
}

/** Today's date text (used for displaying "Today" or "This week" on pages). */
export const todayText = (now: Date, cal: Calendar = DEFAULT_CALENDAR): string =>
  dateOfDayNumber(todayNumber(now, cal));

/** End date (inclusive) of a time segment (a bar on the chart) starting from start and spanning unit: one day, one week (7 days), or end of the month. */
export function unitRange(start: string, unit: GroupUnit): DayRange {
  if (unit === 'day') return { start, end: start };
  if (unit === 'week') return { start, end: dateOfDayNumber(dayNumber(start)! + 6) };
  const [y, m] = start.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${start.slice(0, 8)}${String(last).padStart(2, '0')}` };
}

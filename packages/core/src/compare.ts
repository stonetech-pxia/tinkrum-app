import { dateOfDayNumber, todayNumber, type Calendar } from './calendar';
import { periodRange } from './data';
import { dayNumber } from './formula';
import { t } from './messages';
import type { Condition, Locale, Period } from './schema';

// "Compare to previous period" statistics (D-308): when the filter has an inPeriod condition,
// replace it with the previous period and recompute. Compare calendar periods (this week, this
// month, this year, etc.) to the corresponding previous period: this month up to the 29th compares
// to last month's 1-29, otherwise mid-month always looks like "50% less than last month"; today
// compares to all of yesterday; last N days compares to the preceding N days. Day and week starts
// follow D-286. Yesterday, last week, last month, last year and tomorrow, next week, next month
// (D-559) are full periods comparing to the full period preceding them.

/** Date range of the corresponding previous period (inclusive). */
export function previousPeriodRange(period: Period, now: Date, cal: Calendar): [string, string] {
  const today = todayNumber(now, cal);
  const [startText, endText] = periodRange(period, now, cal);
  const start = dayNumber(startText)!;
  const days = dayNumber(endText)! - start + 1;
  const toDate = today - start + 1;
  const shift = (by: number, length: number): [string, string] => [
    dateOfDayNumber(start - by),
    dateOfDayNumber(start - by + length - 1),
  ];
  const [y, m, d] = dateOfDayNumber(today).split('-').map(Number) as [number, number, number];
  const ymd = (yy: number, mm: number, dd: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return dateOfDayNumber(Math.round(Date.UTC(yy, mm - 1, Math.min(dd, last)) / 86_400_000));
  };
  switch (period) {
    case 'today':
      return shift(1, 1);
    case 'thisWeek':
      return shift(7, toDate);
    case 'thisTwoWeeks':
      return shift(14, toDate);
    case 'thisHalfMonth':
      // First half of the month compares to last month's second half (starting on the 16th), second half compares to this month's first half; both go up to the same day number, not exceeding that half-month.
      return d <= 15
        ? [ymd(y, m - 1, 16), ymd(y, m - 1, 15 + d)]
        : [`${dateOfDayNumber(today).slice(0, 7)}-01`, ymd(y, m, Math.min(15, d - 15))];
    case 'thisMonth':
      return [ymd(y, m - 1, 1), ymd(y, m - 1, d)];
    case 'thisYear':
      return [`${y - 1}-01-01`, ymd(y - 1, m, d)];
    // Last month, next month, last year (D-559) are full periods, compared to the full period preceding them (last month compares to the month before, next month compares to this month).
    case 'lastMonth':
    case 'nextMonth': {
      const [sy, sm] = startText.split('-').map(Number) as [number, number];
      return [ymd(sy, sm - 1, 1), ymd(sy, sm, 0)];
    }
    case 'lastYear':
      return [`${y - 2}-01-01`, `${y - 2}-12-31`];
    default:
      // Last N days: the preceding N days.
      return shift(days, days);
  }
}

/**
 * Previous period filter: replaces the single inPeriod condition with the corresponding previous
 * period (greater than the day before, less than the day after), leaving other conditions
 * unchanged. If there are zero or multiple inPeriod conditions, there is nothing comparable
 * (check catches such configurations).
 */
export function previousFilter(
  filter: readonly Condition[] | undefined,
  now: Date,
  cal: Calendar,
): { filter: Condition[]; period: Period } | null {
  const periods = (filter ?? []).filter((c) => c.op === 'inPeriod');
  if (periods.length !== 1) return null;
  const cond = periods[0]!;
  const period = cond.value as Period;
  const [from, to] = previousPeriodRange(period, now, cal);
  const before = dateOfDayNumber(dayNumber(from)! - 1);
  const after = dateOfDayNumber(dayNumber(to)! + 1);
  return {
    period,
    filter: (filter ?? []).flatMap((c) =>
      c === cond
        ? [
            { field: c.field, op: 'gt' as const, value: before },
            { field: c.field, op: 'lt' as const, value: after },
          ]
        : [c],
    ),
  };
}

/** Change: increase, decrease, or unchanged, percentage rounded; no percentage when the previous period is 0. None when either side has no value. */
export function compareChange(
  current: number | null,
  previous: number | null,
): { direction: 'up' | 'down' | 'same'; percent: number | null } | null {
  if (current === null || previous === null) return null;
  const direction = current > previous ? 'up' : current < previous ? 'down' : 'same';
  if (previous === 0) return { direction, percent: direction === 'same' ? 0 : null };
  return {
    direction,
    percent: Math.round((Math.abs(current - previous) / Math.abs(previous)) * 100),
  };
}

/** Previous period description and value: "Last month same period: ¥100.00", "30 days prior: 12". */
export function previousLabel(period: Period, value: string, locale: Locale): string {
  // The previous period for next N days (D-537) is also the preceding N days.
  const days = /^(?:last|next)(\d+)days$/.exec(period);
  if (days) return t(locale, 'compare_lastDays', { n: Number(days[1]), value });
  return t(locale, `compare_${period as Exclude<Period, `${'last' | 'next'}${number}days`>}`, {
    value,
  });
}

/** Change text: ↑ 12%, ↓ 5%, flat; when the previous period is 0, write only "↑ Increase". */
export function changeLabel(
  change: ReturnType<typeof compareChange>,
  locale: Locale,
): string | null {
  if (!change) return null;
  if (change.direction === 'same') return t(locale, 'compareSame');
  if (change.percent === null)
    return change.direction === 'up' ? t(locale, 'compareUpNoPercent') : null;
  return t(locale, change.direction === 'up' ? 'compareUp' : 'compareDown', { n: change.percent });
}

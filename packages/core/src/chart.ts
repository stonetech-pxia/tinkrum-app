import { pad } from './field-values';
import {
  DEFAULT_CALENDAR,
  dateOfDayNumber,
  todayNumber,
  weekStartOf,
  type Calendar,
} from './calendar';
import {
  aggregateRecords,
  groupRecords,
  localDate,
  recordDay,
  type DataRecord,
  type LinkedGroups,
} from './data';
import type { ChartSource } from './components/chart';
import { CHART_COLOR_FAMILIES, OPTION_COLORS, type OptionColor } from './option-colors';
import { rangeStarts, rangeUnit, type DayRange } from './page-period';
import type { Collection, GroupUnit } from './schema';
import { latestValue } from './related';
import { t } from './messages';
import { dateFieldOf, distinctDays } from './sequence';

/** Default number of recent periods displayed when group.last is omitted: 7 days, 8 weeks, 6 months. */
export const DEFAULT_PERIODS: Record<GroupUnit, number> = {
  day: 7,
  week: 8,
  month: 6,
};
export const MAX_PERIODS = 31;

/**
 * Category colors for pie charts (used in a fixed sequence without looping): 8 hues from the
 * dataviz reference palette, ensuring adjacent colors remain distinguishable under
 * color-blindness simulation; separate sets for light and dark themes. When categories exceed 7,
 * the 8th slice is labeled "Other" and rendered in neutral gray.
 */
export const CHART_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
  other: { light: '#8a8a85', dark: '#9a9a94' },
} as const;
export const MAX_PIE_SLICES = 8;

/**
 * Determines the display color for a single-select option (D-568): options with an explicit color
 * use that named color; unassigned options take category colors by index. When an index falls
 * outside the category colors (starting from the 8th, unselected, or "Other" as -1), neutral gray
 * is used. Used by value-based coloring, calendars, and pie charts. options represents all
 * available options for this field (D-571): when some options specify colors, unassigned options
 * take category colors from the palette (CHART_COLOR_FAMILIES) in order, avoiding the color
 * families already used, ensuring consistent coloring across views; remaining options fall back
 * to neutral gray. If no options specify colors (or options is omitted), behavior matches
 * previous versions entirely.
 */
export function optionColor(
  option: { id?: string; color?: OptionColor | undefined } | undefined,
  index: number,
  dark: boolean,
  options?: readonly { id: string; color?: OptionColor | undefined }[],
): string {
  if (option?.color) return OPTION_COLORS[option.color][dark ? 'dark' : 'light'];
  const scheme: readonly string[] = dark ? CHART_COLORS.dark : CHART_COLORS.light;
  const grey = CHART_COLORS.other[dark ? 'dark' : 'light'];
  const used = new Set(options?.flatMap((o) => (o.color ? [o.color] : [])) ?? []);
  if (used.size === 0 || index < 0) return (index >= 0 ? scheme[index] : undefined) ?? grey;
  const free = scheme.filter((_, i) => !CHART_COLOR_FAMILIES[i]?.some((f) => used.has(f)));
  const k = options!.filter((o) => !o.color).findIndex((o) => o.id === option?.id);
  return (k >= 0 ? free[k] : undefined) ?? grey;
}

/** Pie charts and split charts share option ordering within fields; skipping earlier options does not shift color assignments. */
export function chartOptionColor(
  key: string | null,
  options: readonly { id: string; color?: OptionColor | undefined }[],
  dark: boolean,
  fallbackIndex = -1,
): string {
  const index = options.findIndex((o) => o.id === key);
  return optionColor(options[index], options.length ? index : fallbackIndex, dark, options);
}

export interface ChartPoint {
  /** Start date of the time period (YYYY-MM-DD) or option ID; "Other" and "Unassigned" are null. */
  key: string | null;
  label: string;
  value: number;
  /** Indicates whether the period contains statistically valid data (for averages with no data, value is 0, but displayed as "—"). */
  empty: boolean;
  /** Parts split by single-select within the same time period; maintains identical ordering across all time periods. */
  parts?: ChartPoint[];
}

/**
 * Defines how a chart calculates its data (derived from chart block source excluding table and
 * filters): when group has unit, groups by time (using by as the date field, defaulting to
 * dateFieldOf); without unit, groups by single-select or reference field by (D-336); distinctDays
 * counts unique days using days.date when grouping by field.
 */
export type ChartSpec = Pick<
  ChartSource,
  'aggregate' | 'field' | 'group' | 'days' | 'running' | 'split'
>;

/**
 * Start dates for the most recent n periods (from oldest to newest, with the final period
 * including today). Today and the start of the week follow cal (D-286), matching data filtering.
 */
export function periodStarts(
  group: GroupUnit,
  n: number,
  now: Date,
  cal: Calendar,
  /** Offset for earlier periods (used for previous-period comparison, D-439): 0 represents the most recent n periods. */
  shift = 0,
): Date[] {
  const todayNum = todayNumber(now, cal);
  const [y, m, d] = dateOfDayNumber(todayNum).split('-').map(Number) as [number, number, number];
  const weekStart = d - (todayNum - weekStartOf(todayNum, cal));
  const starts: Date[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const i = k + shift;
    if (group === 'day') starts.push(new Date(y, m - 1, d - i));
    else if (group === 'week') starts.push(new Date(y, m - 1, weekStart - 7 * i));
    else starts.push(new Date(y, m - 1 - i, 1));
  }
  return starts;
}

const periodLabel = (group: GroupUnit, d: Date) =>
  group === 'month'
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Chart data points. Time grouping: the most recent group.last periods, with one point per period
 * (0 for periods with no records). Single-select grouping: one point per option (in option
 * order), with records lacking a selection grouped separately (labeled noChoice). Reference
 * fields also use this path (D-336): one point per record in the referenced table, requiring
 * linked records. previous (D-439, time grouping only): represents the n periods immediately
 * preceding the most recent n periods, allowing direct comparison of the i-th point against the
 * i-th point of the recent n periods. range (D-440, page-selected time range): ignores group.unit
 * and last, automatically determining grouping by day, week, or month (rangeUnit) based on range
 * length, with one point per period and excluding records outside the range.
 */
export function chartSeries(
  records: readonly DataRecord[],
  collection: Collection,
  spec: ChartSpec,
  now: Date,
  noChoice: string,
  cal: Calendar = DEFAULT_CALENDAR,
  linked?: LinkedGroups,
  previous = false,
  range?: DayRange,
  otherLabel: string = t('en', 'chartOther'),
): ChartPoint[] {
  const { group } = spec;
  const unit = group.unit;
  const dateRef = dateFieldOf(collection, unit ? group.by : spec.days?.date);
  const point = (key: string | null, label: string, list: DataRecord[]): ChartPoint => {
    const value =
      spec.aggregate === 'latest'
        ? (() => {
            const v = spec.field && latestValue(list, collection, spec.field, dateRef, now, cal);
            return typeof v === 'number' ? v : null;
          })()
        : spec.aggregate === 'distinctDays'
          ? distinctDays(list, collection, { dateField: dateRef, now, cal })
          : aggregateRecords(list, collection, spec.aggregate, spec.field);
    return { key, label, value: value ?? 0, empty: value === null };
  };
  const compute = () => {
    if (!unit) {
      if (!group.by) return [];
      return groupRecords(records, collection, group.by, noChoice, linked).map((g) =>
        point(g.optionId, g.label, g.records),
      );
    }
    if (range) return rangeSeries(records, collection, range, point, dateRef, now, cal);
    const n = Math.min(MAX_PERIODS, group.last ?? DEFAULT_PERIODS[unit]);
    const shift = previous ? n : 0;
    const starts = periodStarts(unit, n, now, cal, shift).map(localDate);
    // The previous period ends on the day before the start of the most recent n periods.
    const end = previous
      ? (() => {
          const [y, m, d] = localDate(periodStarts(unit, n, now, cal)[0]!)
            .split('-')
            .map(Number) as [number, number, number];
          return localDate(new Date(y, m - 1, d - 1));
        })()
      : dateOfDayNumber(todayNumber(now, cal));
    const buckets = starts.map(() => [] as DataRecord[]);
    for (const r of records) {
      const v = recordDay(r, collection, dateRef, now, cal);
      if (v === undefined || v < starts[0]! || v > end) continue;
      // Falls within the period whose start date is the latest one not later than it.
      let i = starts.length - 1;
      while (i > 0 && starts[i]! > v) i--;
      buckets[i]!.push(r);
    }
    return starts.map((start, i) => {
      const [y, m, d] = start.split('-').map(Number) as [number, number, number];
      return point(start, periodLabel(unit, new Date(y, m - 1, d)), buckets[i]!);
    });
  };
  const points = compute();
  if (spec.running && unit && points.length) {
    const edge = range?.start ?? points[0]!.key!;
    let value =
      spec.running === 'all'
        ? point(
            null,
            '',
            records.filter((r) => {
              const day = recordDay(r, collection, dateRef, now, cal);
              return day !== undefined && day < edge;
            }),
          ).value
        : 0;
    for (const p of points) {
      value += p.value;
      p.value = value;
      p.empty = false;
    }
  }
  if (spec.split && unit && points.length) {
    const f = collection.fields.find((f) => f.id === spec.split!.by);
    if (f?.type === 'choice') {
      const end = range?.end ?? dateOfDayNumber(todayNumber(now, cal));
      const start = range?.start ?? points[0]!.key!;
      const visible = records.filter((r) => {
        const d = recordDay(r, collection, dateRef, now, cal);
        return d !== undefined && d >= start && d <= end;
      });
      const groups = groupRecords(visible, collection, f.id, noChoice).filter((g) => g.count > 0);
      const ranked = [...groups].sort(
        (a, b) =>
          Math.abs(point(b.optionId, b.label, b.records).value) -
          Math.abs(point(a.optionId, a.label, a.records).value),
      );
      const kept =
        groups.length <= MAX_PIE_SLICES
          ? groups
          : groups.filter((g) => ranked.slice(0, MAX_PIE_SLICES - 1).includes(g));
      const rest = groups.filter((g) => !kept.includes(g));
      const series = [
        ...kept.map((g) => ({ key: g.optionId, label: g.label, records: g.records })),
        ...(rest.length
          ? [{ key: '$other', label: otherLabel, records: rest.flatMap((g) => g.records) }]
          : []),
      ];
      for (const p of points) p.parts = [];
      for (const group of series) {
        const part = chartSeries(
          group.records,
          collection,
          { ...spec, split: undefined },
          now,
          noChoice,
          cal,
          undefined,
          previous,
          range,
          otherLabel,
        );
        points.forEach((p, i) =>
          p.parts!.push({ ...part[i]!, key: group.key, label: group.label }),
        );
      }
    }
  }
  return points;
}

/** When a time range is selected on the page (D-440): one data point per period (day/week/month, based on range length) within the range; records outside the range are excluded, and the first and last periods may be partial. */
function rangeSeries(
  records: readonly DataRecord[],
  collection: Collection,
  range: DayRange,
  point: (key: string | null, label: string, list: DataRecord[]) => ChartPoint,
  dateRef: string,
  now: Date,
  cal: Calendar,
): ChartPoint[] {
  const unit = rangeUnit(range);
  const starts = rangeStarts(range, unit, cal);
  const buckets = starts.map(() => [] as DataRecord[]);
  for (const r of records) {
    const v = recordDay(r, collection, dateRef, now, cal);
    if (v === undefined || v < range.start || v > range.end) continue;
    let i = starts.length - 1;
    while (i > 0 && starts[i]! > v) i--;
    buckets[i]!.push(r);
  }
  return starts.map((start, i) => {
    const [y, m, d] = start.split('-').map(Number) as [number, number, number];
    return point(start, periodLabel(unit, new Date(y, m - 1, d)), buckets[i]!);
  });
}

/** Pie chart: positive values only; when exceeding MAX_PIE_SLICES, combines the smallest slices into an "Other" category. */
export function pieSlices(points: readonly ChartPoint[], other: string): ChartPoint[] {
  const positive = points.filter((p) => p.value > 0);
  if (positive.length <= MAX_PIE_SLICES) return positive;
  const keep = [...positive].sort((a, b) => b.value - a.value).slice(0, MAX_PIE_SLICES - 1);
  const kept = positive.filter((p) => keep.includes(p));
  const rest = positive.filter((p) => !keep.includes(p)).reduce((s, p) => s + p.value, 0);
  return [...kept, { key: null, label: other, value: rest, empty: false }];
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** Line chart: maps values into a width × height bounding box (0 at the bottom baseline, maximum value at top with padding). A single point is rendered as a point marker. */
export function linePath(
  values: readonly number[],
  width: number,
  height: number,
  padding = 6,
): string {
  if (values.length === 0) return '';
  const { x, y } = lineScale(values, width, height, padding);
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${num(x(i))} ${num(y(v))}`).join(' ');
}

/** Shared scale for line and bar charts: minimum value is bounded at or below 0 (shifting the 0-line upward when negative values exist). */
export function lineScale(values: readonly number[], width: number, height: number, padding = 6) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - 2 * padding) / (values.length - 1) : 0;
  return {
    x: (i: number) => (values.length > 1 ? padding + i * step : width / 2),
    y: (v: number) => padding + (1 - (v - min) / span) * (height - 2 * padding),
    zero: padding + (1 - (0 - min) / span) * (height - 2 * padding),
  };
}

/**
 * SVG path for each slice of a pie chart (centered at cx, cy with radius r, clockwise from 12
 * o'clock). A single slice forms a full circle. White borders between slices are drawn by the app
 * using surface-colored strokes.
 */
export function piePaths(values: readonly number[], cx: number, cy: number, r: number): string[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => '');
  const nonZero = values.filter((v) => v > 0).length;
  let angle = -Math.PI / 2;
  return values.map((v) => {
    if (v <= 0) return '';
    if (nonZero === 1)
      return `M${num(cx - r)} ${num(cy)} A${num(r)} ${num(r)} 0 1 1 ${num(cx + r)} ${num(cy)} A${num(r)} ${num(r)} 0 1 1 ${num(cx - r)} ${num(cy)} Z`;
    const sweep = (v / total) * Math.PI * 2;
    const [x1, y1] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    angle += sweep;
    const [x2, y2] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    const large = sweep > Math.PI ? 1 : 0;
    return `M${num(cx)} ${num(cy)} L${num(x1)} ${num(y1)} A${num(r)} ${num(r)} 0 ${large} 1 ${num(x2)} ${num(y2)} Z`;
  });
}

/** Y-axis range for bar and line charts (D-438): always includes 0 (bars start from 0 without truncation), leaving a small top margin above the maximum value. Defaults to 0 to 1 when no data is present. */
export function chartYDomain(values: readonly number[]): [number, number] {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (hi === lo) return [lo, lo + 1];
  return [lo, hi + (hi - lo) * 0.08];
}

/** Y-axis tick numbers: 1200 → 1.2k, 2500000 → 2.5M, at most one decimal place. Numbers only, no currency symbol. */
export function axisTickText(value: number): string {
  const a = Math.abs(value);
  const r = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  if (a >= 1_000_000) return `${r(value / 1_000_000, 1)}M`;
  if (a >= 1_000) return `${r(value / 1_000, 1)}k`;
  return r(value, a < 10 ? 1 : 0);
}

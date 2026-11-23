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

/** 不写 group.last 时显示最近几段：7 天、8 周、6 个月。 */
export const DEFAULT_PERIODS: Record<GroupUnit, number> = {
  day: 7,
  week: 8,
  month: 6,
};
export const MAX_PERIODS = 31;

/**
 * 饼图的分类色（按固定顺序用，不循环）：dataviz 参考调色板的 8 个色相，相邻两色在色盲模拟下也分得开；
 * 浅色、深色界面各一套。超过 7 类时第 8 块是「其他」，用中性灰。
 */
export const CHART_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
  other: { light: '#8a8a85', dark: '#9a9a94' },
} as const;
export const MAX_PIE_SLICES = 8;

/**
 * 一个单选选项画成什么颜色（D-568）：写了 color 的用那个有名字的颜色，没写的按 index 取分类色，
 * index 不在分类色里（第 8 个起、没选、「其他」是 -1）时是中性灰。按值上色、月历、饼图都用它。
 * options 是这个字段的全部选项（D-571）：其中有写了颜色的时，没写颜色的按它在没写颜色的选项里的顺序，
 * 取不和那些颜色同一色系的分类色（CHART_COLOR_FAMILIES），在哪里画都是同一个颜色；取完了是中性灰。
 * 一个都没写颜色（或者不传 options）时和以前完全一样。
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

/** 饼图和拆分图共用字段中的选项顺序；筛掉前面的选项不能让颜色换位。 */
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
  /** 时间段的开始日期（YYYY-MM-DD）或选项 ID；「其他」和「未选」是 null。 */
  key: string | null;
  label: string;
  value: number;
  /** 这一段有没有可统计的数（平均值没有数时 value 是 0，但显示「—」）。 */
  empty: boolean;
  /** 同一时间段按单选拆分的部分；所有时间段保持相同的顺序。 */
  parts?: ChartPoint[];
}

/**
 * 图表怎么算（图表块的 source 去掉表和筛选）：group 有 unit 时按时间分（by 是日期字段，不写用 dateFieldOf 的默认），
 * 没有 unit 时按单选或引用字段 by 分（D-336）；distinctDays 在按字段分时按 days.date 数日子。
 */
export type ChartSpec = Pick<
  ChartSource,
  'aggregate' | 'field' | 'group' | 'days' | 'running' | 'split'
>;

/**
 * 最近 n 段的开始日期（从早到晚，最后一段包含今天）。今天和一周的第一天按 cal（D-286），和数据筛选一样。
 */
export function periodStarts(
  group: GroupUnit,
  n: number,
  now: Date,
  cal: Calendar,
  /** 再往前几段（上一期对比用，D-439）：0 是最近 n 段。 */
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
 * 图表的数据。时间分组：最近 group.last 段，每段一个点（没有记录的段是 0）。
 * 单选分组：每个选项一个点（按选项顺序），没选的记录有的话另算一个点（label 用 noChoice）。
 * 引用字段也走这里（D-336）：被引用的表里每条记录一个点，要 linked。
 * previous（D-439，只有时间分组）：不是最近 n 段，而是它前面紧挨着的 n 段，第 i 个点和最近 n 段的第 i 个点对着比。
 * range（D-440，页面上选的时间范围）：不看 group.unit 和 last，按范围的长短自己选按天、周、月（rangeUnit），
 * 每段一个点，范围外的记录不算。
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
    // 上一期结束在最近 n 段开始的前一天。
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
      // 落在最后一个开始日期不晚于它的那一段。
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

/** 页面上选了时间范围（D-440）：范围里每一段（天 / 周 / 月，按范围长短）一个点；范围外的记录不算，第一段和最后一段可能只有一部分。 */
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

/** 饼图：只要正数；超过 MAX_PIE_SLICES 块时最小的几块合成「其他」（other）。 */
export function pieSlices(points: readonly ChartPoint[], other: string): ChartPoint[] {
  const positive = points.filter((p) => p.value > 0);
  if (positive.length <= MAX_PIE_SLICES) return positive;
  const keep = [...positive].sort((a, b) => b.value - a.value).slice(0, MAX_PIE_SLICES - 1);
  const kept = positive.filter((p) => keep.includes(p));
  const rest = positive.filter((p) => !keep.includes(p)).reduce((s, p) => s + p.value, 0);
  return [...kept, { key: null, label: other, value: rest, empty: false }];
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** 折线：值映射到 width × height 的框里（0 在底边，最大值在顶边留 pad）。只有一个点时是一个点。 */
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

/** 折线和柱子共用的比例尺：最小值不高于 0（有负数时 0 线往上移）。 */
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
 * 饼图每一块的路径（圆心 cx, cy，半径 r，从 12 点钟方向顺时针）。只有一块时是整个圆。
 * 块与块之间的白缝由 App 用表面色描边画出来。
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

/** 柱状图和折线图的 Y 轴范围（D-438）：总是包含 0（柱子从 0 画起，不截断），最大值上留一点空白。没有数据时 0 到 1。 */
export function chartYDomain(values: readonly number[]): [number, number] {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (hi === lo) return [lo, lo + 1];
  return [lo, hi + (hi - lo) * 0.08];
}

/** Y 轴刻度上的数字：1200 → 1.2k，2500000 → 2.5M，小数最多一位。只有数字，没有货币符号。 */
export function axisTickText(value: number): string {
  const a = Math.abs(value);
  const r = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  if (a >= 1_000_000) return `${r(value / 1_000_000, 1)}M`;
  if (a >= 1_000) return `${r(value / 1_000, 1)}k`;
  return r(value, a < 10 ? 1 : 0);
}

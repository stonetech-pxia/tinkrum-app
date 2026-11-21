import { dateOfDayNumber, dayOf, todayNumber, type Calendar } from './calendar';
import { DEFAULT_PERIODS, MAX_PERIODS, periodStarts } from './chart';
import type { GridAcross } from './components/records';
import { aggregateRecords, fieldOf, recordDay, type DataRecord, type LinkedGroups } from './data';
import { localDate, localDateTime } from './field-values';
import { dayNumber } from './formula';
import { filterPresets, listGroups } from './list-groups';
import { localeTag } from './localization';
import { t } from './messages';
import { dayTitle, monthTitle } from './month-view';
import { isRecordToolUse, type ToolUse } from './record-ops-schema';
import { shortDate } from './schedule';
import type { Collection, Condition, Grouping, Locale } from './schema';
import { dateFieldOf } from './sequence';

// 打卡格（D-610，创始人 2026-11-20 定）：一张表的记录排成「行 × 时间列」，每一格是这一行在这一天（周、月）的记录。
// 行和看板、分段一样来自 source.group（单选的每个选项，或引用的那张表的每一条，listGroups）；列和图表一样是最近几段
// （periodStarts，最后一列是今天所在的那一段，一周从哪天开始跟着 data.calendar）。
// 纯逻辑：哪几列、哪几行、每格有哪几条、点一下做什么、在这一格新建时填什么。数字每次画的时候算，不存（底线 14），
// 看、翻页什么都不写（底线 15）；写在用户点了以后由 App 做（record-actions.ts）。

/** 一列：一天、一周或一个月。 */
export interface GridColumn {
  /** 开始那天（YYYY-MM-DD），也是列的键。 */
  key: string;
  /** 开始和结束的天数（含）。 */
  start: number;
  end: number;
  /** 表头：一天是星期几（短），一周是开始那天，一个月是月份（短）。 */
  label: string;
  /** 表头第二行：一天的几号。 */
  detail?: string;
  /** 完整的说法（读屏、打开格子时的标题）。 */
  title: string;
  /** 今天在这一列里。 */
  current: boolean;
  /** 整列都在今天之后（不能点）。 */
  future: boolean;
}

/** 一行：一个选项或被引用的一条。 */
export interface GridRow {
  key: string;
  label: string;
  /** 在这一行新建时分组字段写什么：选项 ID 或被引用那条的 ID。 */
  value: string;
  /** 每一列的记录（和 columns 一一对应）。 */
  cells: DataRecord[][];
  /** show.format progress 的目标：固定数，或这一行（被引用的那条）的数字字段；没有时为 undefined。 */
  goal?: number;
}

export interface GridRead {
  /** 分行的字段（source.group.by）。 */
  by: string;
  /** 分列的日期或日期时间字段（source.across.by，不写是第一个日期字段，没有就第一个日期时间字段）。 */
  date: string;
  columns: GridColumn[];
  rows: GridRow[];
}

const UNIT_DAYS = 86_400_000;
const utc = (day: number) => new Date(day * UNIT_DAYS);

function format(day: number, locale: Locale, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone: 'UTC' }).format(
    utc(day),
  );
}

/**
 * 最近几列（从早到晚），和图表的时间分组同一种算法：不写 last 是 7 天、8 周、6 个月，最多 31 列。page 往前翻几页
 * （一页 = last 列，0 是最近的一页）；只往前翻，所以最近一页的最后一列是今天所在的那一段，后面没有列。
 */
export function gridColumns(
  across: GridAcross,
  now: Date,
  cal: Calendar,
  locale: Locale,
  page = 0,
): GridColumn[] {
  const unit = across.unit;
  const n = Math.min(MAX_PERIODS, across.last ?? DEFAULT_PERIODS[unit]);
  const today = todayNumber(now, cal);
  return periodStarts(unit, n, now, cal, Math.max(0, page) * n).map((d) => {
    const key = localDate(d);
    const start = dayNumber(key)!;
    const end =
      unit === 'day'
        ? start
        : unit === 'week'
          ? start + 6
          : dayNumber(localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)))!;
    const head =
      unit === 'day'
        ? {
            label: format(start, locale, { weekday: 'short' }),
            detail: String(Number(key.slice(8))),
            title: dayTitle(start, locale),
          }
        : unit === 'week'
          ? {
              label: shortDate(start, today, locale),
              title: t(locale, 'groupWeek', { date: shortDate(start, today, locale) }),
            }
          : { label: format(start, locale, { month: 'short' }), title: monthTitle(key, locale) };
    return {
      key,
      start,
      end,
      ...head,
      current: start <= today && today <= end,
      future: start > today,
    };
  });
}

/** 表头上这一页的范围：第一列的第一天到最后一列的最后一天（不是今年的带年份）。 */
export function gridRange(
  columns: readonly Pick<GridColumn, 'start' | 'end'>[],
  now: Date,
  cal: Calendar,
  locale: Locale,
): string {
  const today = todayNumber(now, cal);
  return t(locale, 'gridRange', {
    from: shortDate(columns[0]!.start, today, locale),
    to: shortDate(columns.at(-1)!.end, today, locale),
  });
}

/** 分列用的字段：source.across.by，不写是第一个日期字段，没有就第一个日期时间字段。 */
export const gridDateField = (view: Collection, across: GridAcross): string =>
  across.by ?? dateFieldOf(view, undefined);

/**
 * 打卡格读出来的样子。records 是这张表筛选过的记录（算好的）；linked 是按引用分行时被引用的表（已经按 group.filter 筛过）。
 * 行和分段一样：选项的顺序，或被引用的每条按创建时间从旧到新；showEmpty 时没有记录的行也列出。
 * 没有行值的、指向不在行里的那条的记录不显示（格子只有行 × 列）。分行字段不是单选或引用时为 undefined。
 */
export function gridRead(
  records: readonly DataRecord[],
  view: Collection,
  source: {
    group?: Pick<Grouping, 'by' | 'showEmpty'> | undefined;
    across?: GridAcross | undefined;
  },
  show: {
    format?: { kind: string; goal?: number | string } | undefined;
  },
  options: {
    now: Date;
    cal: Calendar;
    locale: Locale;
    linked?: LinkedGroups | undefined;
    page?: number;
  },
): GridRead | undefined {
  const { group, across } = source;
  const by = group?.by;
  const field = by === undefined ? undefined : fieldOf(view, by);
  if (!across || !by || (field?.type !== 'choice' && field?.type !== 'link')) return undefined;
  const { now, cal, locale, linked } = options;
  const date = gridDateField(view, across);
  const columns = gridColumns(across, now, cal, locale, options.page);
  const first = columns[0]!.start;
  const last = columns.at(-1)!.end;
  const goalOf = (value: string): number | undefined => {
    const format = show.format;
    if (format?.kind !== 'progress' || format.goal === undefined) return undefined;
    if (typeof format.goal === 'number') return format.goal;
    const v = linked?.records.find((r) => r.id === value)?.values[format.goal];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const groups = listGroups(
    records,
    view,
    { by, ...(group?.showEmpty ? { showEmpty: true as const } : {}) },
    { locale, now, cal, linked },
  );
  return {
    by,
    date,
    columns,
    rows: groups.flatMap((g): GridRow[] => {
      if (typeof g.preset !== 'string') return [];
      const cells = columns.map(() => [] as DataRecord[]);
      for (const r of g.records) {
        const day = recordDay(r, view, date, now, cal);
        const n = day === undefined ? undefined : dayNumber(day);
        if (n === undefined || n < first || n > last) continue;
        const i = columns.findIndex((c) => c.start <= n && n <= c.end);
        if (i >= 0) cells[i]!.push(r);
      }
      const goal = goalOf(g.preset);
      return [
        {
          key: g.key,
          label: g.label,
          value: g.preset,
          cells,
          ...(goal === undefined ? {} : { goal }),
        },
      ];
    }),
  };
}

/** 一格显示的数：有 show.trailing（数字类字段）时是它的合计，没有是几条。 */
export function gridCellValue(
  cell: readonly DataRecord[],
  view: Collection,
  trailing: string | undefined,
): number {
  if (trailing === undefined) return cell.length;
  return aggregateRecords(cell, view, 'sum', trailing) ?? 0;
}

/**
 * 点一格做什么（D-610）：今天以后的格子不能点；有 remove 时正好一条就把它移到「最近删除」（带撤销），两条以上列出
 * 这一格的记录（不一次删几条）；其余有 create 就在这一格加一条（没有 remove 时就是多记一次）；什么工具都没有时有记录就列出。
 */
export type GridTap = 'create' | 'remove' | 'open' | 'none';

export function gridTap(
  tools: readonly ToolUse[] | undefined,
  count: number,
  column: Pick<GridColumn, 'future'>,
): GridTap {
  if (column.future) return 'none';
  const has = (kind: string) =>
    (tools ?? []).some((u) => u.as === 'tap' && isRecordToolUse(u) && u.do === kind);
  if (has('remove') && count === 1) return 'remove';
  if (has('remove') && count > 1) return 'open';
  if (has('create')) return 'create';
  return count > 0 ? 'open' : 'none';
}

/**
 * 在一格新建（values "$here"）时填什么：列表筛选里的等于条件（filterPresets），这一行的值，和这一列的日子。
 * 日期字段：今天所在的那一列是今天，别的列是它的第一天；日期时间字段：今天所在的那一列是现在，别的列是那一天中午 12 点
 * （一天从几点开始最晚是 6 点，中午总落在这一天里）。
 */
export function gridHereValues(
  view: Collection,
  filter: readonly Condition[] | undefined,
  read: Pick<GridRead, 'by' | 'date'>,
  row: Pick<GridRow, 'value'>,
  column: Pick<GridColumn, 'start' | 'current'>,
  now: Date,
  cal: Calendar,
): Record<string, unknown> {
  const values = filterPresets(view, filter);
  values[read.by] = row.value;
  const type = fieldOf(view, read.date)?.type;
  const day = column.current ? dayOf(now, cal) : dateOfDayNumber(column.start);
  if (type === 'date') values[read.date] = day;
  else if (type === 'datetime')
    values[read.date] = column.current ? localDateTime(now) : `${day}T12:00`;
  return values;
}

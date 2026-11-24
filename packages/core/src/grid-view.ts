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

// Check-in grid (D-610, decided by founder 2026-11-20): table records arranged as rows × time
// columns, each cell representing the record for that row on that day (week, month). Rows come from
// source.group (each radio option, or each entry of referenced table, listGroups) just like kanban
// and sections; columns are the recent segments like charts (periodStarts, last column is the
// segment containing today, week start day follows data.calendar). Pure logic: which columns, which
// rows, which entries per cell, action on tap, initial values when creating in a cell. Numbers
// calculated on render, not stored (Invariant 14); viewing and paging write nothing (Invariant 15);
// writes are performed by App after user tap (record-actions.ts).

/** A column: a day, week, or month. */
export interface GridColumn {
  /** Start day (YYYY-MM-DD), also the column key. */
  key: string;
  /** Start and end day counts (inclusive). */
  start: number;
  end: number;
  /** Header label: day of week (short) for days, start date for weeks, month (short) for months. */
  label: string;
  /** Second row of the table header: day number of the month. */
  detail?: string;
  /** Full description (used for screen readers, title when opening a cell). */
  title: string;
  /** Today falls within this column. */
  current: boolean;
  /** The entire column is in the future (non-clickable). */
  future: boolean;
}

/** A single row: either an option or a referenced entry. */
export interface GridRow {
  key: string;
  label: string;
  /** Value for the grouping field when creating a new entry in this row: option ID or the ID of the referenced entry. */
  value: string;
  /** Records for each column (corresponding 1:1 with columns). */
  cells: DataRecord[][];
  /** Target for show.format progress: a fixed number, or a numeric field of this row (the referenced entry); undefined if none. */
  goal?: number;
}

export interface GridRead {
  /** Field used for row grouping (source.group.by). */
  by: string;
  /** Date or datetime field used for column splitting (source.across.by; defaults to the first date field, falling back to the first datetime field). */
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
 * Recent columns (from earliest to latest), using the same algorithm as chart time grouping: if
 * last is omitted, defaults to 7 days, 8 weeks, or 6 months, up to a maximum of 31 columns. page
 * specifies how many pages to go back (one page = last columns, where 0 is the most recent page);
 * navigation only goes backward, so the last column of the latest page is the interval containing
 * today, with no subsequent columns.
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

/** Range of the current page on the table header: from the first day of the first column to the last day of the last column (without year if it is the current year). */
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

/** Field used for column splitting: source.across.by; defaults to the first date field, falling back to the first datetime field. */
export const gridDateField = (view: Collection, across: GridAcross): string =>
  across.by ?? dateFieldOf(view, undefined);

/**
 * Rendered appearance of a check-in cell. records contains filtered records for this table
 * (pre-calculated); linked contains the referenced table grouped by reference (already filtered
 * by group.filter). Rows behave like sections: ordered by option or by creation time (oldest to
 * newest) for referenced items; when showEmpty is enabled, rows with no records are also listed.
 * Records lacking row values or pointing to entries outside the rows are not displayed (cells
 * consist strictly of rows × columns). Returns undefined if the row grouping field is neither a
 * single-select nor a reference.
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

/** Value displayed in a cell: total sum when show.trailing is present (numeric fields), or the record count otherwise. */
export function gridCellValue(
  cell: readonly DataRecord[],
  view: Collection,
  trailing: string | undefined,
): number {
  if (trailing === undefined) return cell.length;
  return aggregateRecords(cell, view, 'sum', trailing) ?? 0;
}

/**
 * Behavior when tapping a cell (D-610): cells in the future are not clickable; when remove is
 * present and there is exactly one record, it is moved to "Recently Deleted" (with undo); if
 * there are two or more records, the cell's records are listed (never deleting multiple records
 * at once); otherwise, if create is present, a new record is added to this cell (equivalent to
 * logging another entry when remove is absent); if no tools are available and records exist, they
 * are listed.
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
 * Values populated when creating a new record in a cell (values "$here"): equal conditions from
 * list filtering (filterPresets), the row's value, and the column's date. Date field: today's
 * column uses today, other columns use their first day; datetime field: today's column uses the
 * current time, other columns use 12:00 PM on that day (days begin at a configured start hour, at
 * latest 6 AM, so noon always falls within that day).
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

import { boardColumns, boardField, MAX_TILES, type BoardColumn } from './board-view';
import { calendarOf, dateOfDayNumber, todayNumber, weekStartOf, type Calendar } from './calendar';
import { chartSeries, type ChartPoint } from './chart';
import { previousFilter } from './compare';
import type { ChartSource } from './components/chart';
import type { NumberSource } from './components/number';
import type { RecordLook, RecordSource } from './components/records';
import {
  aggregateRecords,
  fieldOf,
  filterRecords,
  groupRecords,
  matchesCondition,
  sortRecords,
  type Aggregate as ValueAggregate,
  type DataRecord,
  type LinkedGroups,
  perCurrencyText,
} from './data';
import { FILES_COLLECTION, FILES_TABLE, fileKindOf } from './files-table';
import { gridRead, type GridRead } from './grid-view';
import { filterPresets, listGroups } from './list-groups';
import { t } from './messages';
import { currentMonth, monthDays, type MonthDay } from './month-view';
import { computeRecords, expandCollection, relatedCollectionIds } from './related';
import {
  RECORD_REF,
  type Collection,
  type Condition,
  type Locale,
  type Period,
  type WorkspaceConfig,
} from './schema';
import { dateFieldOf, isSequenceAggregate, sequenceValue } from './sequence';
import { calculatedNumber, latestNumber } from './stat-calc';
import { recordsInRange, type DayRange } from './page-period';
export { latestNumber } from './stat-calc';

// Shared reader logic (v34 D-370 rule 2): what a block's source reads. The 6 record block
// appearances, numbers, charts, and file lists all read from here, and the app only handles
// rendering (previously each component implemented its own filtering, sorting, and grouping).
// Filtering, sorting, grouping, and days calculations each have a single implementation: here the
// source is passed to algorithms in data.ts, list-groups.ts, board-view.ts, month-view.ts,
// chart.ts, compare.ts, sequence.ts, and stat-minus.ts. Lookups, rollups, and previous values are
// computed via related.ts (read-only). Pure function: records come from the caller (undeleted
// records in the app database), never enter the configuration, and are never sent to the AI
// (D-042).

export interface SourceContext {
  config: WorkspaceConfig;
  /** Table ID -> stored, undeleted records (must include tables listed in sourceTableIds). Lookups, rollups, and previous values are computed here. */
  records: ReadonlyMap<string, readonly DataRecord[]>;
  now: Date;
  /** If omitted, uses configuration settings (calendarOf). */
  cal?: Calendar;
  locale: Locale;
  /** The specific record opened by a record-specific page (page.of, D-342): "$record" in filters is replaced with it. */
  recordId?: string;
  /** Range selected on the page (desktop widgets use their own filters when omitted). */
  range?: DayRange;
}

/** Read representation of a table: stored table (for modifying records), display table (lookups and rollups replaced with their display fields), and computed records. */
export interface TableRead {
  table: Collection;
  view: Collection;
  records: DataRecord[];
}

const tableCache = new WeakMap<SourceContext, Map<string, TableRead | undefined>>();

const calOf = (ctx: SourceContext): Calendar => ctx.cal ?? calendarOf(ctx.config);

/** Computed records for a table (computed once per ctx); undefined if the table does not exist. */
export function readTable(ctx: SourceContext, tableId: string): TableRead | undefined {
  let cache = tableCache.get(ctx);
  if (!cache) tableCache.set(ctx, (cache = new Map()));
  if (cache.has(tableId)) return cache.get(tableId);
  const tables = ctx.config.data.tables;
  const table = tables.find((c) => c.id === tableId);
  const read = table && {
    table,
    view: expandCollection(tables, table),
    records: computeRecords(tables, tableId, ctx.records, ctx.now, calOf(ctx)),
  };
  cache.set(tableId, read);
  return read;
}

/** Replaces "$spec" or "$record" in filters with the opened record (if no record is opened, leaves unchanged and conditions evaluate to nothing). */
function bind(filter: readonly Condition[] | undefined, ctx: SourceContext): Condition[] {
  return (filter ?? []).map((c) =>
    c.value === RECORD_REF && ctx.recordId !== undefined ? { ...c, value: ctx.recordId } : c,
  );
}

/** The referenced table and its computed records when grouping by a reference field (D-336); undefined when not a reference field. */
function linkedOf(
  ctx: SourceContext,
  view: Collection,
  by: string | undefined,
  filter?: readonly Condition[],
): LinkedGroups | undefined {
  const field = by === undefined ? undefined : fieldOf(view, by);
  if (field?.type !== 'link') return undefined;
  const target = readTable(ctx, field.table);
  if (!target) return undefined;
  const records = filter?.length
    ? filterRecords(target.records, target.table, filter, ctx.now, calOf(ctx))
    : target.records;
  return { collection: target.table, records, locale: ctx.locale };
}

/**
 * Table records required to read this source (app reads them first then calls functions here):
 * this table and tables required by its lookups and aggregates, referenced tables when grouped by
 * reference fields, and tables from minus and calc.with.
 */
export function sourceTableIds(
  source: {
    table: string;
    group?: { by?: string | undefined } | undefined;
    minus?: { table: string } | undefined;
    calc?: { with: readonly { table: string }[] } | undefined;
  },
  config: WorkspaceConfig,
): string[] {
  const tables = config.data.tables;
  const ids = new Set<string>();
  const add = (id: string | undefined) => {
    const c = id === undefined ? undefined : tables.find((x) => x.id === id);
    if (c) for (const x of relatedCollectionIds(tables, c)) ids.add(x);
  };
  add(source.table);
  const own = tables.find((x) => x.id === source.table);
  const by = source.group?.by;
  const link = own && by !== undefined ? fieldOf(own, by) : undefined;
  if (link?.type === 'link') add(link.table);
  add(source.minus?.table);
  for (const total of source.calc?.with ?? []) add(total.table);
  return [...ids];
}

// ---- Record blocks (list cards checklist tiles board calendar table gallery grid) ----

/** A list section (source.group): count is the total number of items in this section, records up to limit items. */
export interface SourceGroup {
  key: string;
  label: string;
  /** Preset for grouping fields when adding in this section (preset in list-groups.ts). */
  preset?: unknown;
  count: number;
  records: DataRecord[];
}

/** Month or day range for the calendar: daily records (without limit truncation), where max represents the maximum count or maximum absolute daily numerical value. */
export interface MonthRead {
  month: string;
  days: Map<number, MonthDay>;
  max: number;
}

export interface RecordsRead {
  table: Collection;
  view: Collection;
  /** Filter with "$record" replaced (includes equality conditions for inline creation, hereValues). */
  filter: Condition[];
  /** Grouping field: group.by for sections and boards, date for calendars (defaults to default date field when by is omitted). */
  by?: string;
  /** All filtered and sorted records. */
  rows: DataRecord[];
  /** Displayed items when ungrouped: up to limit items (at most MAX_TILES for large tile blocks). */
  shown: DataRecord[];
  /** When list / cards / checklist has source.group: per section. */
  groups?: SourceGroup[];
  /** board: per column (at most limit items per column); absent when grouping field is invalid. */
  columns?: BoardColumn[];
  /** calendar: this month (options.month, defaults to month containing today). */
  days?: MonthRead;
  /** grid (D-610): rows x columns (options.page offset pagination); absent when row grouping field is invalid. */
  grid?: GridRead;
}

/** Read output of a record block; undefined if table does not exist. */
export function readRecords(
  block: {
    look: RecordLook;
    source: RecordSource;
    show?: {
      color?: string | undefined;
      day?: { aggregate: 'count' | 'sum'; field?: string | undefined } | undefined;
      span?: 'month' | 'week' | undefined;
      format?: { kind: string; goal?: number | string } | undefined;
    };
  },
  ctx: SourceContext,
  options: { month?: string; page?: number; range?: DayRange } = {},
): RecordsRead | undefined {
  const { source, look } = block;
  const read = readTable(ctx, source.table);
  if (!read) return undefined;
  const { table, view, records } = read;
  const { now, locale } = ctx;
  const cal = calOf(ctx);
  const filter = bind(source.filter, ctx);
  const filtered = filterRecords(records, view, filter, now, cal);
  const rows = sortRecords(filtered, view, source.sort, now, cal);
  const limit = look === 'tiles' ? Math.min(source.limit, MAX_TILES) : source.limit;
  const base: RecordsRead = { table, view, filter, rows, shown: rows.slice(0, limit) };
  const group = source.group;
  if (look === 'tiles' || !group) return base;
  if (look === 'board') {
    const field = boardField(view, group.by);
    if (!field) return base;
    const linked = linkedOf(ctx, view, field.id, bind(group.filter, ctx));
    return { ...base, by: field.id, columns: boardColumns(field, rows, source.limit, linked) };
  }
  if (look === 'grid') {
    const linked = linkedOf(ctx, view, group.by, bind(group.filter, ctx));
    const grid = gridRead(filtered, view, source, block.show ?? {}, {
      now,
      cal,
      locale,
      linked,
      ...(options.page === undefined ? {} : { page: options.page }),
    });
    return grid ? { ...base, by: grid.by, grid } : base;
  }
  if (look === 'calendar') {
    const date = dateFieldOf(view, group.by);
    const month = options.month ?? currentMonth(now, cal);
    const start = weekStartOf(todayNumber(now, cal), cal);
    const range =
      options.range ??
      (block.show?.span === 'week'
        ? { start: dateOfDayNumber(start), end: dateOfDayNumber(start + 6) }
        : undefined);
    // Order within the same day is determined by monthDays (independent of sorting).
    const { days, max } = monthDays(
      filtered,
      view,
      { date, color: block.show?.color, until: group.until, day: block.show?.day },
      range ?? month,
      now,
      cal,
    );
    return { ...base, by: date, days: { month, days, max } };
  }
  const by = dateFieldOf(view, group.by);
  const groups = listGroups(rows, view, group, {
    locale,
    now,
    cal,
    linked: linkedOf(ctx, view, by),
  }).map((g) => ({ ...g, count: g.records.length, records: g.records.slice(0, source.limit) }));
  return { ...base, by, groups };
}

/** Records listed for the calendar's selected day: sorted by source.sort if present, up to limit items. */
export function dayShown(
  read: RecordsRead,
  source: RecordSource,
  day: number,
  ctx: SourceContext,
): DataRecord[] {
  const list = read.days?.days.get(day)?.records ?? [];
  return (
    source.sort ? sortRecords(list, read.view, source.sort, ctx.now, calOf(ctx)) : list
  ).slice(0, source.limit);
}

/** Default preset for date fields when adding from a calendar date: date field is set to that day, events are set to "once, that day", date-times and system fields have no preset. */
export function dayValue(read: RecordsRead, day: number): unknown {
  const type = read.by === undefined ? undefined : fieldOf(read.view, read.by)?.type;
  const date = dateOfDayNumber(day);
  return type === 'date' ? date : type === 'schedule' ? { repeat: 'once', date } : undefined;
}

/**
 * "$here" (inline creation, D-349): filter presets in list filters plus values from this section,
 * column, or day (groupValue: section preset, column option, dayValue; undefined / null leaves
 * unpreset).
 */
export function hereValues(read: RecordsRead, groupValue?: unknown): Record<string, unknown> {
  const values = filterPresets(read.view, read.filter);
  if (read.by !== undefined && groupValue !== undefined && groupValue !== null)
    values[read.by] = groupValue;
  return values;
}

// ---- Number (number) ----

export interface NumberGroup {
  /** Option ID (reference fields use the ID of the referenced entry); null means "unselected". */
  optionId: string | null;
  label: string;
  count: number;
  value: number | null;
  /** Text formatted separately per currency when users choose their own currency per entry (D-429). */
  text?: string;
  best?: number;
  /** compare: value from the previous period corresponding to this group. */
  previous?: number | null;
}

export interface NumberRead {
  view: Collection;
  /** Computed minus / calc value; returns null when uncomputable. */
  value: number | null;
  /** Custom text written separately per currency when the user selects a currency per entry (D-429); displayed if present. */
  text?: string;
  /** The best streak count. */
  best?: number;
  /** compare: The value from the corresponding period in the previous cycle (replacing the only inPeriod filter with the previous period). */
  previous?: { period: Period; value: number | null };
  /** source.group: One row per option (D-248, D-336). */
  groups?: NumberGroup[];
}

/**
 * Latest value for a number block (D-618): The field value of the latest entry, sharing the same
 * definition of "latest" as summary fields (latestValue in related.ts; date is days.date, or
 * defaults to the first date field in the table if unspecified). Returns null if not a number
 * (validation restricts this to numeric fields only).
 */
/** Value of a number block (D-248, D-284, D-307, D-308, D-337); returns undefined if the table does not exist. */
export function readNumber(source: NumberSource, ctx: SourceContext): NumberRead | undefined {
  const read = readTable(ctx, source.table);
  if (!read) return undefined;
  const { table, view, records } = read;
  const { now } = ctx;
  const cal = calOf(ctx);
  const filter = bind(source.filter, ctx);
  const valueOf = (list: DataRecord[]): { value: number | null; best?: number } =>
    isSequenceAggregate(source.aggregate)
      ? sequenceValue(list, view, source.aggregate, source.days, now, cal)
      : source.aggregate === 'latest'
        ? { value: latestNumber(list, table, view, source, now, cal) }
        : {
            value: aggregateRecords(list, view, source.aggregate as ValueAggregate, source.field),
          };
  const range = source.period === 'page' ? ctx.range : undefined;
  const based = filterRecords(
    records,
    view,
    range ? filter.filter((c) => c.op !== 'inPeriod') : filter,
    now,
    cal,
  );
  const date =
    filter.find((c) => c.op === 'inPeriod')?.field ?? dateFieldOf(table, source.days?.date);
  const matched = range ? recordsInRange(based, view, date, range, now, cal) : based;
  const own = calculatedNumber(
    {
      ...source,
      filter,
      ...(source.minus
        ? { minus: { ...source.minus, filter: bind(source.minus.filter, ctx) } }
        : {}),
      ...(source.calc
        ? {
            calc: {
              ...source.calc,
              with: source.calc.with.map((total) => ({
                ...total,
                filter: bind(total.filter, ctx),
              })),
            },
          }
        : {}),
    },
    read,
    (id) => {
      const other = readTable(ctx, id);
      return other;
    },
    now,
    cal,
    range,
  );
  const out: NumberRead = { view, value: own.value };
  const split = perCurrencyText(matched, view, source.aggregate, source.field, ctx.locale);
  if (split !== null) out.text = split;
  if (own.best !== undefined) out.best = own.best;
  const previous = source.compare ? previousFilter(filter, now, cal) : null;
  const before = previous && filterRecords(records, view, previous.filter, now, cal);
  if (previous && before) out.previous = { period: previous.period, value: valueOf(before).value };
  const by = source.group?.by;
  if (by !== undefined) {
    const noChoice = t(ctx.locale, 'statNoChoice');
    const linked = linkedOf(ctx, view, by);
    const earlier =
      before &&
      new Map(
        groupRecords(before, view, by, noChoice, linked).map((g) => [
          g.optionId,
          valueOf(g.records).value,
        ]),
      );
    out.groups = groupRecords(matched, view, by, noChoice, linked).map((g) => {
      const v = valueOf(g.records);
      const text = perCurrencyText(g.records, view, source.aggregate, source.field, ctx.locale);
      return {
        optionId: g.optionId,
        label: g.label,
        count: g.count,
        value: v.value,
        ...(text === null ? {} : { text }),
        ...(v.best === undefined ? {} : { best: v.best }),
        ...(earlier ? { previous: earlier.get(g.optionId) ?? null } : {}),
      };
    });
  }
  return out;
}

// ---- Charts ----

/** Data points for a chart (pie charts are further processed by pieSlices); returns undefined if the table does not exist. */
export function readChart(
  source: ChartSource,
  ctx: SourceContext,
): { view: Collection; points: ChartPoint[] } | undefined {
  const read = readTable(ctx, source.table);
  if (!read) return undefined;
  const { view, records } = read;
  const cal = calOf(ctx);
  const range = source.period === 'page' ? ctx.range : undefined;
  const filter = bind(source.filter, ctx);
  const matched = filterRecords(
    records,
    view,
    range ? filter.filter((c) => c.op !== 'inPeriod') : filter,
    ctx.now,
    cal,
  );
  const linked = source.group.unit ? undefined : linkedOf(ctx, view, source.group.by);
  const scoped =
    range && !source.group.unit
      ? recordsInRange(matched, view, dateFieldOf(view, source.days?.date), range, ctx.now, cal)
      : matched;
  const points = chartSeries(
    scoped,
    view,
    source,
    ctx.now,
    t(ctx.locale, 'statNoChoice'),
    cal,
    linked,
    false,
    source.group.unit ? range : undefined,
    t(ctx.locale, 'chartOther'),
  );
  return { view, points };
}

// ---- File list (files, reading $files) ----

/** File metadata required by the file list (app file records contain these properties). */
export interface FileMeta {
  mimeType: string;
  name: string;
  size: number;
  createdAt: number;
  source: 'picked' | 'generated';
}

interface FilesSource {
  table?: typeof FILES_TABLE;
  filter?: readonly Condition[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
}

/** Treat a file as a single record in $files (kind is identified by MIME type via fileKindOf). */
const fileRecord = (f: FileMeta): DataRecord => ({
  id: '',
  collectionId: FILES_TABLE,
  values: { name: f.name, kind: fileKindOf(f.mimeType), size: f.size, source: f.source },
  createdAt: f.createdAt,
  updatedAt: f.createdAt,
});

/** Filter for the file list (source.filter, conditions are joined by AND). */
export function filesFilter(
  source: FilesSource,
  now: Date = new Date(),
  cal?: Calendar,
): (file: FileMeta) => boolean {
  const filter = source.filter ?? [];
  return (file) => {
    const r = fileRecord(file);
    return filter.every((c) => matchesCondition(r, FILES_COLLECTION, c, now, cal));
  };
}

/** Determines which files to display in the file list: filtered, sorted (defaults to creation time from newest to oldest), up to a maximum limit. */
export function readFiles<T extends FileMeta>(
  source: FilesSource,
  files: readonly T[],
  now: Date = new Date(),
  cal?: Calendar,
): T[] {
  const keep = filesFilter(source, now, cal);
  const kept = files.filter(keep);
  const byRecord = new Map(kept.map((f) => [fileRecord(f), f]));
  const sorted = sortRecords([...byRecord.keys()], FILES_COLLECTION, source.sort, now, cal);
  return sorted.slice(0, source.limit ?? sorted.length).map((r) => byRecord.get(r)!);
}

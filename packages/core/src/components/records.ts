import { z } from 'zod';

import { fieldDefinition } from '../fields';
import { GROUP_BY_TYPES } from '../list-groups-schema';
import { t } from '../messages';
import { hasRecordCurrency } from '../money-currency';
import { ToolUseSchema } from '../record-ops-schema';
import {
  boundedText,
  ConditionSchema,
  FieldRefSchema,
  filterSchema,
  GROUP_UNITS,
  GroupingSchema,
  IdSchema,
  SortKeysSchema,
  sortList,
} from '../schema-base';
import { followChoiceProblems, isTimeTabs } from './tabs';
import {
  collectionName,
  type CheckContext,
  type CheckProblem,
  type LookDefinitionOf,
  type LookMeta,
  type Pin,
  defineLook,
  isSystemField,
  NUMERIC_FIELD_TYPES,
} from './define';

/**
 * Display format for right-side fields (D-306): elapsed = time elapsed from this datetime (or
 * creation time) until now, or until until, ticking every second when until is absent; progress =
 * ratio of this value to a target (fixed number or another number field in this record), rendered
 * as a ring (default) or bar.
 */
export const TrailingFormatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('elapsed'), until: IdSchema.optional() }),
  z.strictObject({
    kind: z.literal('progress'),
    goal: z.union([z.number().positive().max(1_000_000_000), IdSchema]),
    style: z.enum(['ring', 'bar']).optional(),
  }),
]);

/**
 * Horizontal time axis for habit/check-in grid (D-610): unit makes each column a day, week, or
 * month; by is a date or datetime field from this table (defaults to the first date field, or
 * first datetime field if none); last is the number of columns (same as charts, defaults to 7
 * days, 8 weeks, 6 months; last column is the period containing today). Week start day follows
 * "Settings -> Date" (data.calendar.weekStart). Applies to look grid only.
 */
export const GridAcrossSchema = z.strictObject({
  unit: z.enum(GROUP_UNITS),
  by: IdSchema.optional(),
  last: z.number().int().min(2).max(31).optional(),
});
export type GridAcross = z.infer<typeof GridAcrossSchema>;

/** What record block reads: a table, filter, sort, limit, and optional grouping (group per section / column / day). limit is the maximum number of items per section / column. */
export const RecordSourceSchema = z.strictObject({
  table: IdSchema,
  filter: filterSchema().optional(),
  sort: SortKeysSchema.optional(),
  /**
   * Follows the page time range (D-561, same as number cards and charts, D-440): requires a
   * time tabs on the same page; inPeriod in filters is no longer used, filtering by the
   * selected range using that period's date field (falls back to the first date field in the
   * table). Incompatible with calendars and lists with show.browse.period.
   */
  period: z.literal('page').optional(),
  /**
   * Follows the page-level option tabs (D-573): the page must have tabs by a choice field reading the
   * same table; calculates only records where this field matches the selected item ("All" adds no
   * condition). Grouping by the same field is not allowed.
   */
  choice: z.literal('page').optional(),
  // Defaults to 30 items when omitted (models occasionally omit it; an entire modification should not be rejected for this).
  limit: z.number().int().min(1).max(100).default(30),
  group: GroupingSchema.optional(),
  /** Horizontal time axis for check-in grid (D-610): each column is a day, week, or month. Applies to look grid only. */
  across: GridAcrossSchema.optional(),
});
export type RecordSource = z.infer<typeof RecordSourceSchema>;

/** Record card for each entry (repeated nesting, D-369 Q4): fixed slots. */
const SlotsSchema = z.strictObject({
  span: z.enum(['month', 'week']).optional(),
  day: z
    .strictObject({ aggregate: z.enum(['count', 'sum']), field: IdSchema.optional() })
    .optional(),
  title: FieldRefSchema,
  subtitles: z.array(FieldRefSchema).max(2).optional(),
  /** Field displayed on the right, e.g., amount. */
  trailing: FieldRefSchema.optional(),
  format: TrailingFormatSchema.optional(),
  /** Color by this single-select field: calendars color each day (option of the last entry of the day), other appearances draw a small dot before the title (D-541). */
  color: IdSchema.optional(),
  /** Items satisfying these conditions (AND, <=3) have their right-side values (or title if no right-side field) rendered in alert color (D-541). */
  highlight: z.array(ConditionSchema).min(1).max(3).optional(),
  /** Columns following the title column in tables (D-539); defaults to subtitle and right-side field when omitted. */
  columns: z.array(FieldRefSchema).min(1).max(7).optional(),
  emptyText: boundedText(1, 80).optional(),
  /**
   * Temporary search and switching views for users in lists (D-424, list, cards, and checklist
   * only): search provides a search box; sort and group are switchable fields. Changes apply only
   * while rendering this block and reset to source sorting and grouping upon leaving, storing
   * nothing (invariant 15). filter: single-select or tag fields, a row of clickable values,
   * selectable one at a time (decided by founder 2026-11-04). pin: fixes the search box and these
   * rows at the top of the page. When browse is present, source.limit is the batch size per
   * render, loading the next batch upon scrolling to the bottom (limit without browse is a hard
   * cap).
   */
  browse: z
    .strictObject({
      search: z.literal(true).optional(),
      sort: z.array(FieldRefSchema).min(1).max(6).optional(),
      group: z.array(FieldRefSchema).min(1).max(6).optional(),
      filter: z.array(IdSchema).min(1).max(3).optional(),
      /** A row of "All / This Week / This Month / This Year", toggled by this date field (or createdAt, updatedAt) (D-437). */
      period: FieldRefSchema.optional(),
      pin: z.literal(true).optional(),
    })
    .optional(),
});

const shape = {
  source: RecordSourceSchema,
  show: SlotsSchema,
  /** Tools on each entry (<=3 buttons + check / tap / drag / inline add) and buttons above the list (<=3, D-428), checked in record-ops.ts. */
  tools: z.array(ToolUseSchema).min(1).max(8).optional(),
  /** Tap an entry to open this page (D-342, page.of is this table), defaults to the edit page when omitted. */
  opens: IdSchema.optional(),
};

export const RECORD_LOOKS = [
  'list',
  'cards',
  'checklist',
  'tiles',
  'board',
  'calendar',
  'table',
  'gallery',
  'grid',
] as const;
export type RecordLook = (typeof RECORD_LOOKS)[number];

type RecordBlock = z.infer<z.ZodObject<typeof shape>> & {
  id: string;
  look: RecordLook;
  pin?: Pin | undefined;
};

const refs = {
  'source.table': { to: 'table' },
  'source.group.until': { to: 'field', types: ['date', 'datetime'] },
  'show.day.field': { to: 'field', types: ['number', 'money', 'rating', 'duration', 'formula'] },
  'show.title': { to: 'field' },
  'show.subtitles': { to: 'field', role: 'subtitleField' },
  'show.trailing': { to: 'field', role: 'trailingField' },
  'show.color': { to: 'field', role: 'colorField', types: ['choice'], one: true },
  'show.columns': { to: 'field', role: 'show.columns' },
  'show.browse.sort': { to: 'field', role: 'show.browse.sort' },
  'show.browse.group': { to: 'field', role: 'show.browse.group' },
  'show.browse.period': { to: 'field', role: 'show.browse.period', types: ['date', 'datetime'] },
  'show.browse.filter': { to: 'field', role: 'show.browse.filter', types: ['tags', 'choice'] },
  'source.across.by': { to: 'field', role: 'source.across.by', types: ['date', 'datetime'] },
  'source.filter': { to: 'filter' },
} as const;

/** Fields available for group switching in lists: groupable types plus text (grouped by company, with each distinct value forming a section, D-424). */
const BROWSE_GROUP_TYPES: readonly string[] = [...GROUP_BY_TYPES, 'text'];

/** Requirements specific to each record appearance (handled by check bar in v33, written into respective looks in v34, rule E6). */
function recordProblems(c: RecordBlock, ctx: CheckContext): CheckProblem[] {
  const { collection, config } = ctx;
  const problems: string[] = [];
  const table = c.source.table;
  if (c.opens !== undefined) {
    const target = config.containers.pages.find((p) => p.id === c.opens);
    if (!target) problems.push(`opens ${c.opens} is not a page`);
    else if (target.of !== table)
      problems.push(`opens ${c.opens} must be a page for one entry of ${table} (of: "${table}")`);
  }
  const field = (id: string) => collection!.fields.find((f) => f.id === id);
  const typeOf = (id: string) => (isSystemField(id) ? 'datetime' : field(id)?.type);
  if (c.look !== 'table' && c.show.columns !== undefined)
    problems.push('show.columns only applies to look "table"');
  const browse = c.show.browse;
  if (browse) {
    if (c.look !== 'list' && c.look !== 'cards' && c.look !== 'checklist')
      problems.push('show.browse only applies to looks "list", "cards" and "checklist"');
    if (
      browse.search === undefined &&
      !browse.sort &&
      !browse.group &&
      !browse.filter &&
      !browse.period
    )
      problems.push('show.browse needs search, sort, group, filter or period');
    if (browse.pin) {
      if (ctx.parent)
        problems.push('show.browse.pin only works on a top-level list, not inside a group');
      const pinned = ctx.page.blocks.filter(
        (b) => (b as { show?: { browse?: { pin?: true } } }).show?.browse?.pin === true,
      );
      if (pinned.length > 1)
        problems.push(`page ${ctx.page.id} can pin the search of only one list`);
    }
    // Lists with infinite loading must be in the middle of scrolling and cannot be fixed in place.
    if (c.pin !== undefined)
      problems.push('a list with show.browse scrolls in the middle of the page: no pin');
    for (const id of browse.sort ?? []) {
      const f = field(id);
      if (f && fieldDefinition(f.type).sort === false)
        problems.push(`show.browse.sort: can't sort by the ${f.type} field ${id}`);
    }
    for (const id of browse.group ?? []) {
      const type = typeOf(id);
      if (type && !BROWSE_GROUP_TYPES.includes(type))
        problems.push(
          `show.browse.group ${id} must be a ${BROWSE_GROUP_TYPES.join(', ')} field or createdAt / updatedAt`,
        );
    }
  }
  if (c.source.across !== undefined && c.look !== 'grid')
    problems.push('source.across only applies to look "grid"');
  const format = c.look === 'grid' ? undefined : c.show.format;
  const trailing = c.show.trailing;
  const trailingType = trailing ? typeOf(trailing) : undefined;
  if (format && !trailing) problems.push(`show.format ${format.kind} needs show.trailing`);
  else if (format?.kind === 'elapsed') {
    if (trailingType !== 'datetime')
      problems.push(
        'show.format elapsed needs show.trailing set to a datetime field or "createdAt" (the start)',
      );
    if (format.until !== undefined && field(format.until)?.type !== 'datetime')
      problems.push(`show.format until must be a datetime field of ${collection!.id} (the end)`);
  } else if (format?.kind === 'progress') {
    if (!trailingType || !NUMERIC_FIELD_TYPES.includes(trailingType))
      problems.push(
        'show.format progress needs show.trailing set to a number, money, rating, duration, formula or rollup field',
      );
    const goal = typeof format.goal === 'string' ? field(format.goal) : undefined;
    if (typeof format.goal === 'string' && (!goal || !NUMERIC_FIELD_TYPES.includes(goal.type)))
      problems.push(
        `show.format goal ${format.goal} must be a number or a number field of ${collection!.id}`,
      );
  }
  if (c.look !== 'calendar' && (c.show.day || c.show.span || c.source.group?.until))
    problems.push('show.day, show.span and group.until only apply to a calendar');
  if (c.look === 'calendar') {
    const day = c.show.day;
    const f = field(day?.field ?? '');
    if (
      day?.aggregate === 'sum' &&
      (!f || !NUMERIC_FIELD_TYPES.includes(f.type) || hasRecordCurrency(f))
    )
      problems.push('show.day sum needs a numeric field with one fixed currency');
    if (day?.aggregate === 'count' && day.field)
      problems.push('show.day count does not read a field');
    const until = c.source.group?.until;
    if (until) {
      if (
        !['date', 'datetime'].includes(field(until)?.type ?? '') ||
        !['date', 'datetime'].includes(field(c.source.group?.by ?? '')?.type ?? '')
      )
        problems.push('group.until needs explicit date or datetime start and end fields');
      if (day?.aggregate === 'sum')
        problems.push(
          'show.day sum cannot combine with group.until: it would count the same amount on every day',
        );
    }
  }
  const group = c.source.group;
  const by = group?.by;
  const byType = by === undefined ? undefined : isSystemField(by) ? 'date' : field(by)?.type;
  if (by !== undefined && !isSystemField(by) && !field(by))
    problems.push(`source.group.by ${by} is not a field of ${collection!.id}`);
  if (group?.last !== undefined) problems.push('source.group.last only applies to a chart');
  if (c.look === 'grid') {
    problems.push(...gridProblems(c, ctx, byType));
  } else if (c.look === 'calendar') {
    if (group?.unit !== 'day')
      problems.push('a calendar needs source.group {unit: "day", by?: a date field}');
    else if (
      by !== undefined &&
      byType &&
      !['date', 'datetime', 'schedule', 'dateOffset'].includes(byType)
    )
      problems.push(
        `source.group.by ${by} must be a date or datetime or schedule field (or a dateOffset) of ${collection!.id}`,
      );
    if (group?.showEmpty || group?.filter)
      problems.push('a calendar groups by day only: no showEmpty or filter');
  } else if (c.look === 'board') {
    if (!group || by === undefined || (byType !== 'choice' && byType !== 'link'))
      problems.push('a board needs source.group.by set to a choice or link field');
    if (group?.unit || group?.showEmpty)
      problems.push('a board has one column per option: no unit or showEmpty');
    if (group?.filter && byType !== 'link')
      problems.push('source.group.filter only applies when grouping by a link field');
  } else if (c.look === 'tiles') {
    if (group) problems.push('tiles are not grouped: no source.group');
  } else if (group) {
    if (by === undefined && group.unit === undefined)
      problems.push('source.group needs by (a field) or unit');
    else if (byType && !GROUP_BY_TYPES.includes(byType))
      problems.push(
        `source.group.by ${by} must be a ${GROUP_BY_TYPES.join(', ')} field or createdAt / updatedAt`,
      );
    const dated = byType !== 'choice' && byType !== 'link';
    if (group.unit && !dated)
      problems.push('source.group.unit only applies when grouping by a date or schedule field');
    if (group.showEmpty && dated)
      problems.push('source.group.showEmpty only applies when grouping by a choice or link field');
    if (group.filter) problems.push('source.group.filter only applies to a board');
  }
  if (c.source.period !== undefined) {
    if (c.look === 'grid') problems.push('a grid has its own columns of time: no source.period');
    if (!ctx.page.blocks.some(isTimeTabs))
      problems.push(
        'source.period "page" needs time tabs (a tabs block with show.periods) on the same page',
      );
    if (c.look === 'calendar') problems.push('a calendar moves by month itself: no source.period');
    if (c.show.browse?.period !== undefined)
      problems.push(
        "this list follows the page's time range: no show.browse.period (keep one of the two)",
      );
  }
  problems.push(...followChoiceProblems(c.source, ctx.page, c.show.browse?.filter));
  const seen = new Set<string>();
  for (const key of sortList(c.source.sort)) {
    const sorted = field(key.field);
    if (!isSystemField(key.field) && !sorted)
      problems.push(`sort field ${key.field} is not a field of ${table}`);
    if (sorted && fieldDefinition(sorted.type).sort === false)
      problems.push(`can't sort by the ${sorted.type} field ${key.field}`);
    if (seen.has(key.field)) problems.push(`sort lists ${key.field} more than once`);
    seen.add(key.field);
  }
  return problems;
}

/**
 * Requirements specific to check-in grid (D-610): rows are source.group.by (each option of a
 * single-select, or each entry of the referenced table; like Kanban, group.filter can pre-filter
 * that table, showEmpty lists rows without records), columns are source.across (date or datetime
 * field, defaults to the first). Cell values are counts, or sums when show.trailing (number
 * field) is present; show.format progress goal is a fixed number or a number field from the row's
 * table (per-habit goal), without using show.trailing. Tools support tap only: at most one {do:
 * "create", values: "$here"} (fills this row and day) and one {do: "remove"} (moves to "Recently
 * Deleted" when exactly one entry is in the cell); no when, also, and label can be omitted
 * (screen reader reads the cell position).
 */
function gridProblems(c: RecordBlock, ctx: CheckContext, byType: string | undefined): string[] {
  const { collection, config } = ctx;
  const table = collection!;
  const problems: string[] = [];
  const group = c.source.group;
  if (!group || group.by === undefined || (byType !== 'choice' && byType !== 'link'))
    problems.push(
      'a grid needs source.group.by set to a choice or link field (one row per option or per linked entry)',
    );
  // Multi-select fields (D-607) would span multiple rows; unchecking a cell deletes it across all those rows simultaneously: rows use single-select or relation only.
  const byField = group?.by === undefined ? undefined : table.fields.find((f) => f.id === group.by);
  if (byField?.type === 'choice' && byField.multiple)
    problems.push(
      `a grid has one row per option: source.group.by ${byField.id} picks several options (multiple), use a single choice or a link field`,
    );
  if (group?.unit) problems.push('a grid has one row per option: no source.group.unit');
  if (group?.filter && byType !== 'link')
    problems.push('source.group.filter only applies when grouping by a link field');
  const across = c.source.across;
  if (!across)
    problems.push(
      'a grid needs source.across {unit: "day"|"week"|"month", by?: a date or datetime field, last?: 2-31}',
    );
  else if (
    across.by === undefined &&
    !table.fields.some((f) => f.type === 'date' || f.type === 'datetime')
  )
    problems.push(
      `a grid needs a date or datetime field in ${table.id} for its columns (source.across.by)`,
    );
  const trailing = c.show.trailing;
  const trailingType = trailing ? table.fields.find((f) => f.id === trailing)?.type : undefined;
  if (trailing !== undefined && (!trailingType || !NUMERIC_FIELD_TYPES.includes(trailingType)))
    problems.push(
      'on a grid show.trailing is summed in each cell: a number, money, duration, formula or rollup field (leave it out to count entries)',
    );
  const format = c.show.format;
  if (format?.kind === 'elapsed') problems.push('a grid has no show.format elapsed');
  if (format?.kind === 'progress' && typeof format.goal === 'string') {
    const link =
      byType === 'link'
        ? table.fields.find((f) => f.id === group?.by && f.type === 'link')
        : undefined;
    const rows =
      link?.type === 'link' ? config.data.tables.find((x) => x.id === link.table) : undefined;
    const goal = rows?.fields.find((f) => f.id === format.goal);
    if (!goal || !NUMERIC_FIELD_TYPES.includes(goal.type))
      problems.push(
        rows
          ? `show.format goal ${format.goal} must be a number or a number field of ${rows.id} (each row's own goal)`
          : `show.format goal ${format.goal}: rows by a choice field have no goal field; use a number`,
      );
  }
  const tools = c.tools ?? [];
  const creates = tools.filter((u) => 'do' in u && u.do === 'create');
  const removes = tools.filter((u) => 'do' in u && u.do === 'remove');
  if (creates.length > 1 || removes.length > 1)
    problems.push('a grid has at most one create and one remove (both as: "tap")');
  for (const u of tools) {
    if ('when' in u && u.when !== undefined) problems.push('a grid tap has no when');
    if ('also' in u && u.also !== undefined) problems.push('a grid tap makes one change: no also');
    if ('do' in u && u.do === 'create' && u.values !== '$here')
      problems.push(
        `a grid adds in the tapped cell: {as: "tap", do: "create", table: ${table.id}, values: "$here"} (fills the row and the day)`,
      );
  }
  return problems;
}

/**
 * Shared syntax across the six record block types (written once in prompt, each appearance's
 * ai.doc writes its own section). limit is the maximum number of items per section / column /
 * day.
 */
export const RECORD_LOOK_DOC =
  'source {table, filter?, sort? {field, direction: "asc"|"desc"} or a list of 1-3 of them (sorted by the first, ties by the next: "by priority, then due date"), period?: "page" (follows the time tabs of the page, rule 56; not on a calendar), choice?: "page" (follows the tabs by a choice field of the page, rule 65), limit? (1-100, default 30; per section, column or day when grouped), group?}, show {title, subtitles? (≤2), trailing? (shown on the right, e.g. an amount), format? (rule 46), color? (a choice field: a dot in the colour of its option; on a calendar the day colour), highlight? (1-3 conditions like filter: matching entries show trailing, or the title, in the warning colour, e.g. over budget), emptyText?, browse? {search?: true, sort?: [fields], group?: [fields], filter?: [tags or choice fields], period?: a date field or createdAt / updatedAt, pin?: true} (list, cards and checklist only: a search box over every field, the fields the user can switch to, a row of values to tap for filter, and a row All / This week / This month / This year over that date field (period); all temporary, nothing is written; pin keeps them fixed above the scrolling list; with browse, limit is how many to show at a time and scrolling to the bottom shows more; set it when the user asks to search, sort, group or filter a list themselves)}, tools? (createAll only as the addHere with pick: true, rule 70), opens? (a page for one entry, rule 48)';

const DOCS: Record<RecordLook, string> = {
  list: 'rows; tapping a row opens the built-in editor (or the page in opens)',
  cards: 'cards, one per entry',
  checklist:
    'rows with a check box: needs one tool {as: "check", do: "toggle", table, field: <a checkbox field>, also?: [{do: "set", field, value}] (1-2 fields of this entry set when ticked and cleared when unticked, rule 71)}',
  tiles:
    'a grid of big circles, one per entry, show.title under each (at most 24 shown) ("习惯做成大圆块，点一下打卡", "Streaks-style habit grid"): a tap runs the first {as: "tap", label, when?, …} tool whose when matches (rule 44; e.g. on a habits table {as: "tap", label: "Done", do: "create", table: "check-ins", values: {habit: "$row"}}, or an increment); without one a tap opens the entry. show.trailing + show.format progress (rule 46) draws a ring around the circle that fills at the goal (e.g. a rollup "done today" with goal "daily-goal"); otherwise the trailing value is shown inside. Tiles never change entries by themselves',
  board:
    'a board with one column per option of source.group.by (a choice or link field; link: rule 45) plus "not set"; dragging a card needs {as: "drag", do: "set", table, field: <the same field>, value: "$group"}, without it the board is read-only (rule 45)',
  calendar:
    'a month or week calendar: source.group {unit: "day", by?: a date, datetime, dateOffset or schedule field, until?: an end date/datetime field (explicit date/datetime by required; inclusive multi-day entries)}, show.color? a choice field, show.span?: "month"|"week" (default month), show.day?: {aggregate: "count"|"sum", field? (sum: numeric with fixed currency; not together with until)} (rules 45, 79)',
  table:
    'a spreadsheet-like table, one row per entry under a header of field names: show.title is the first column (kept in view), show.columns? (1-7 fields) the others (default: subtitles and trailing); scrolls sideways; read-only cells, tapping a row opens the entry',
  gallery:
    "a grid of pictures, 2 per row: the first image in each entry's attachments with show.title under it (no image: a placeholder with the title); tapping one opens the entry",
  grid: 'a check-in grid (rule 68): rows × time columns over one table, each cell = the entries of that row in that day, week or month. source.group {by: a link or choice field, not a multiple one (one row per linked entry or option), showEmpty?: true, filter? (link only, on the linked table)} and source.across {unit: "day"|"week"|"month", by?: a date or datetime field (default the first date field), last?: 2-31 columns (default 7 days, 8 weeks, 6 months; the newest is the current one)}. A cell shows a mark when it has entries and the count from 2; show.trailing? (a number field) sums it instead of counting; show.format {kind: "progress", goal: a number or a number field of the linked table} draws a ring. show.title is the title of the entries listed when a cell is opened. tools: {as: "tap", do: "create", table, values: "$here"} adds an entry for that row and day; {as: "tap", do: "remove", table} makes a tap on a cell with exactly one entry move it to the trash (with undo); without remove a tap adds one more (counting) and a long press lists the entries',
};

const META: Record<RecordLook, NonNullable<LookMeta['tools']>> = {
  list: {
    as: ['button', 'addHere', 'list'],
    do: ['create', 'set', 'toggle', 'increment', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 7,
  },
  cards: {
    as: ['button', 'addHere', 'list'],
    do: ['create', 'set', 'toggle', 'increment', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 7,
  },
  checklist: {
    as: ['check', 'button', 'addHere', 'list'],
    do: ['create', 'set', 'toggle', 'increment', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 8,
  },
  tiles: { as: ['tap'], do: ['create', 'set', 'toggle', 'increment'], open: true, max: 3 },
  board: {
    as: ['drag', 'button', 'addHere'],
    do: ['create', 'set', 'toggle', 'increment', 'createAll'],
    open: true,
    max: 5,
  },
  calendar: {
    as: ['button', 'addHere'],
    do: ['create', 'set', 'toggle', 'increment', 'createAll'],
    open: true,
    max: 4,
  },
  // Table cells are read-only (D-539): no per-row buttons. createAll is simply the checkbox creation under "Add" (D-616).
  table: {
    as: ['addHere', 'list'],
    do: ['create', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 4,
  },
  // Gallery (D-540) has images and titles only: no per-item buttons.
  gallery: {
    as: ['addHere', 'list'],
    do: ['create', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 4,
  },
  // Check-in grid (D-610): tap cells only, to add an entry in that cell ($here) or remove the sole entry in that cell.
  grid: { as: ['tap'], do: ['create', 'remove'], max: 2 },
};

function recordLook<L extends RecordLook>(look: L): LookDefinitionOf<L, typeof shape> {
  return defineLook({
    look,
    shape,
    kind: 'container',
    layer: 'record',
    reads: 'table',
    writes: true,
    tools: META[look],
    refs,
    check: (c, ctx) => recordProblems(c as RecordBlock, ctx),
    describe: (c, config, ctx) =>
      t(ctx.locale, 'describe_list_0b528', { v0: collectionName(c.source.table, config) }),
    edit: { text: [], style: ['tone'] },
    ai: {
      doc: DOCS[look],
    },
    example: {
      source: {
        table: 'expenses',
        sort: { field: 'date', direction: 'desc' },
        limit: 30,
        ...(look === 'calendar'
          ? { group: { unit: 'day' as const } }
          : look === 'board'
            ? { group: { by: 'category' } }
            : look === 'grid'
              ? {
                  group: { by: 'category', showEmpty: true as const },
                  across: { unit: 'day' as const, by: 'date', last: 7 },
                }
              : {}),
      },
      show: {
        title: 'category',
        ...(look === 'table'
          ? { columns: ['date', 'amount', 'note'] }
          : { subtitles: ['note', 'date'], trailing: 'amount' }),
      },
      ...(look === 'checklist'
        ? {
            tools: [
              { as: 'check' as const, do: 'toggle' as const, table: 'expenses', field: 'paid' },
            ],
          }
        : look === 'board'
          ? {
              tools: [
                {
                  as: 'drag' as const,
                  do: 'set' as const,
                  table: 'expenses',
                  field: 'category',
                  value: '$group' as const,
                },
              ],
            }
          : {}),
    },
  });
}

export const listComponent = recordLook('list');
export const cardsComponent = recordLook('cards');
export const checklistComponent = recordLook('checklist');
export const tilesComponent = recordLook('tiles');
export const boardComponent = recordLook('board');
export const calendarComponent = recordLook('calendar');
export const tableComponent = recordLook('table');
export const galleryComponent = recordLook('gallery');
export const gridComponent = recordLook('grid');

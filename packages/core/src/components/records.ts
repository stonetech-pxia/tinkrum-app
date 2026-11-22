import { z } from 'zod';

import { fieldDefinition } from '../fields';
import { GROUP_BY_TYPES } from '../list-groups-schema';
import { t } from '../messages';
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
import { followChoiceProblems } from './choices';
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
 * 右侧字段的显示格式（D-306）：elapsed = 从这个日期时间（或创建时间）到现在、或到 until，没有 until 的值时每秒在走；
 * progress = 这个数值和目标（固定数或这条记录的另一个数字类字段）的比例，画成环（默认）或条。
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
 * 打卡格（D-610）横着的时间：unit 一列是一天、一周或一个月，by 是这张表的一个日期或日期时间字段（不写是第一个日期字段，
 * 没有就是第一个日期时间字段），last 是几列（和图表一样，不写是 7 天、8 周、6 个月；最后一列是今天所在的那一段）。
 * 一周从哪天开始跟着「设置 → 日期」（data.calendar.weekStart）。只给 look grid。
 */
export const GridAcrossSchema = z.strictObject({
  unit: z.enum(GROUP_UNITS),
  by: IdSchema.optional(),
  last: z.number().int().min(2).max(31).optional(),
});
export type GridAcross = z.infer<typeof GridAcrossSchema>;

/** 记录块读什么：一张表，筛选、排序、条数，可以分组（每组一段 / 一栏 / 一天）。limit 是每段 / 每栏最多几条。 */
export const RecordSourceSchema = z.strictObject({
  table: IdSchema,
  filter: filterSchema().optional(),
  sort: SortKeysSchema.optional(),
  /**
   * 跟着页面上的时间范围（D-561，和数字卡、图表的一样，D-440）：同一页要有一个 period 块；筛选里的 inPeriod 不再用，
   * 按选的范围、用那个 inPeriod 的日期字段（没有就是表里第一个日期字段）筛。月历和带 show.browse.period 的列表不行。
   */
  period: z.literal('page').optional(),
  /**
   * 跟着页面上的一排选项（D-573）：同一页要有一个 choices 块，读的是同一张表；只算这个字段是选中那一项的记录
   * （「全部」不加条件）。按同一个字段分组的不行。
   */
  choice: z.literal('page').optional(),
  // 不写时 30 条（模型偶尔漏写，不该因此拒绝整份修改）。
  limit: z.number().int().min(1).max(100).default(30),
  group: GroupingSchema.optional(),
  /** 打卡格（D-610）横着的时间：每一列一天、一周或一个月。只给 look grid。 */
  across: GridAcrossSchema.optional(),
});
export type RecordSource = z.infer<typeof RecordSourceSchema>;

/** 每一条的记录卡片（重复嵌套，D-369 Q4）：固定的槽位。 */
const SlotsSchema = z.strictObject({
  title: FieldRefSchema,
  subtitles: z.array(FieldRefSchema).max(2).optional(),
  /** 显示在右侧的字段，例如金额。 */
  trailing: FieldRefSchema.optional(),
  format: TrailingFormatSchema.optional(),
  /** 按这个单选字段上色：月历给每天上色（这一天最后一条的选项），别的外观在标题前画一个小圆点（D-541）。 */
  color: IdSchema.optional(),
  /** 满足这些条件（并且，≤3）的那几条，右侧的值（没有右侧字段时是标题）用警示色（D-541）。 */
  highlight: z.array(ConditionSchema).min(1).max(3).optional(),
  /** 表格（D-539）第一列 title 之后的列；不写时是副标题和右侧字段。 */
  columns: z.array(FieldRefSchema).min(1).max(7).optional(),
  emptyText: boundedText(1, 80).optional(),
  /**
   * 用户在列表上临时找、换着看（D-424，只有 list、cards、checklist）：search 有搜索框，sort、group 是能换的字段。
   * 换了只在这个块画着的时候有效，离开就回到 source 的排序和分组，什么都不写（底线 15）。
   * filter：单选、标签字段，一排可点的值，一次选一个（创始人 2026-11-04 定）。pin：搜索框和这几排固定在页面上方。
   * 有 browse 时 source.limit 是每次显示几条，滚到底再显示下一批（没有 browse 的 limit 是硬上限）。
   */
  browse: z
    .strictObject({
      search: z.literal(true).optional(),
      sort: z.array(FieldRefSchema).min(1).max(6).optional(),
      group: z.array(FieldRefSchema).min(1).max(6).optional(),
      filter: z.array(IdSchema).min(1).max(3).optional(),
      /** 一排「全部 / 本周 / 本月 / 本年」，按这个日期字段（或 createdAt、updatedAt）切换（D-437）。 */
      period: FieldRefSchema.optional(),
      pin: z.literal(true).optional(),
    })
    .optional(),
});

const shape = {
  source: RecordSourceSchema,
  show: SlotsSchema,
  /** 每一条上的工具（≤3 个按钮 + 勾 / 点一下 / 拖动 / 就地添加）和列表上方的按钮（≤3，D-428），检查在 record-ops.ts。 */
  tools: z.array(ToolUseSchema).min(1).max(8).optional(),
  /** 点一条打开这个页面（D-342，page.of 是这张表），不写是编辑页。 */
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

/** 列表上能换着分组的字段：分段能用的，加上文字（按公司分，每个不同的值一段，D-424）。 */
const BROWSE_GROUP_TYPES: readonly string[] = [...GROUP_BY_TYPES, 'text'];

/** 每种记录外观自己的要求（v33 靠 check 拦的，v34 写进各自的 look 里，规则 E6）。 */
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
    // 能一直往下加载的列表要在滚动的中间，固定不住。
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
    if (!ctx.page.blocks.some((b) => b.look === 'period'))
      problems.push('source.period "page" needs a period block on the same page');
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
 * 打卡格（D-610）自己的要求：行是 source.group.by（单选的每个选项，或引用的那张表的每一条，和看板一样可以用 group.filter
 * 先筛那张表、showEmpty 列出没有记录的行），列是 source.across（日期或日期时间字段，不写用第一个）。格子里的值是条数，
 * 有 show.trailing（数字类字段）时是它的合计；show.format progress 的 goal 是固定数，或者行的那张表的数字字段（每个习惯
 * 自己的目标），不用 show.trailing。工具只有点一下：最多一个 {do: "create", values: "$here"}（填这一行、这一天）和一个
 * {do: "remove"}（格子里正好一条时把它移到「最近删除」）；没有 when、also，标签可以不写（读屏说的是这一格）。
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
  // 多选字段（D-607）一条会在几行里，点掉一格就从几行一起删了：行只用单选或引用。
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
 * 六种记录块共用的写法（提示词里写一次，每种外观的 ai.doc 只写自己的部分）。
 * limit 是每段 / 每栏 / 每天最多几条。
 */
export const RECORD_LOOK_DOC =
  'source {table, filter?, sort? {field, direction: "asc"|"desc"} or a list of 1-3 of them (sorted by the first, ties by the next: "by priority, then due date"), period?: "page" (follows the period block of the page, rule 56; not on a calendar), choice?: "page" (follows the choices block of the page, rule 65), limit? (1-100, default 30; per section, column or day when grouped), group?}, show {title, subtitles? (≤2), trailing? (shown on the right, e.g. an amount), format? (rule 46), color? (a choice field: a dot in the colour of its option; on a calendar the day colour), highlight? (1-3 conditions like filter: matching entries show trailing, or the title, in the warning colour, e.g. over budget), emptyText?, browse? {search?: true, sort?: [fields], group?: [fields], filter?: [tags or choice fields], period?: a date field or createdAt / updatedAt, pin?: true} (list, cards and checklist only: a search box over every field, the fields the user can switch to, a row of values to tap for filter, and a row All / This week / This month / This year over that date field (period); all temporary, nothing is written; pin keeps them fixed above the scrolling list; with browse, limit is how many to show at a time and scrolling to the bottom shows more; set it when the user asks to search, sort, group or filter a list themselves)}, tools? (createAll only as the addHere with pick: true, rule 70), opens? (a page for one entry, rule 48)';

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
    'a month calendar: source.group {unit: "day", by?: a date, datetime, dateOffset or schedule field}, show.color? a choice field (rule 45)',
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
  // 表格的格子只读（D-539）：没有每行的按钮。createAll 只是下面「添加」的勾选新建（D-616）。
  table: {
    as: ['addHere', 'list'],
    do: ['create', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 4,
  },
  // 图片墙（D-540）只有图片和标题：没有每张的按钮。
  gallery: {
    as: ['addHere', 'list'],
    do: ['create', 'createAll'],
    ref: ['quickAction'],
    open: true,
    max: 4,
  },
  // 打卡格（D-610）：只有点格子，在这一格加一条（$here）或删掉格子里唯一的那一条。
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

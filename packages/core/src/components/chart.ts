import { z } from 'zod';

import { t } from '../messages';
import { isMultipleChoice, MULTIPLE_CHOICE_NOT_ONE } from '../fields';
import { hasRecordCurrency } from '../money-currency';
import { boundedText, DaysSchema, filterSchema, GroupingSchema, IdSchema } from '../schema-base';
import { followChoiceProblems } from './choices';
import { type LookDefinitionOf, defineLook, isSystemField, NUMERIC_FIELD_TYPES } from './define';

/** 图表读什么：一张表，按时间段或单选 / 引用字段分组（group 必填），每组一个数。 */
export const ChartSourceSchema = z.strictObject({
  table: IdSchema,
  // v33 结构里的 streak / daysSince / avgInterval 在合法配置里不可能出现（E3），v34 去掉。
  aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max', 'latest', 'distinctDays']),
  field: IdSchema.optional(),
  filter: filterSchema().optional(),
  /** distinctDays 按哪个日期算（按单选分组时）；按时间分组时就是 group.by。 */
  days: z.strictObject({ date: DaysSchema.shape.date }).optional(),
  group: GroupingSchema,
  running: z.enum(['shown', 'all']).optional(),
  split: z.strictObject({ by: IdSchema }).optional(),
  /** 和上一期比（D-439）：画上一个同样长的时间段，只有时间分组的柱状图和折线图。 */
  compare: z.literal('previous').optional(),
  /** 跟着页面上的时间范围（D-440）：同一页要有一个 period 块；按选的范围画，group.unit 和 last 不再用（按范围长短自己选按天、周、月）。 */
  period: z.literal('page').optional(),
  /**
   * 跟着页面上的一排选项（D-573）：同一页要有一个 choices 块，读的是同一张表；只算这个字段是选中那一项的记录
   * （「全部」不加条件）。按同一个字段分组的不行。
   */
  choice: z.literal('page').optional(),
});
export type ChartSource = z.infer<typeof ChartSourceSchema>;

const shape = {
  show: z.strictObject({
    kind: z.enum(['bar', 'line', 'pie']),
    title: boundedText(1, 60),
    /**
     * 点一根柱子 / 一个点，页面上的时间范围就改成它那一段（D-585）：同一页要有一个带 custom 的 period 块，
     * 这页上跟着时间范围的数字卡、列表、图表一起变。图表自己按 group.unit 分段，不跟着页面范围（没有 source.period）。
     */
    pickPeriod: z.literal(true).optional(),
  }),
  source: ChartSourceSchema,
};

/**
 * 图表（D-249）：一张表的记录按时间段（最近几天 / 周 / 月，group.unit）或单选字段（group.by）分组，
 * 柱状、折线或饼图。饼图只能按单选分。D-336：也可以是引用字段，被引用的表里每条记录一个点。
 * 只有固定几种画法和聚合，没有表达式；记录只在本机读取。
 */
export const chartComponent: LookDefinitionOf<'chart', typeof shape> = defineLook({
  look: 'chart',
  shape,
  kind: 'container',
  layer: 'table',
  reads: 'table',
  writes: false,
  refs: {
    'source.table': { to: 'table' },
    'source.filter': { to: 'filter' },
    'source.split.by': { to: 'field', types: ['choice'], one: true },
  },
  // D-249：求和、平均要数字字段；按单选分时要单选字段；按时间分时用日期字段；饼图只能按单选分。
  check: (c, { collection, page }) => {
    const problems: string[] = [...followChoiceProblems(c.source, page)];
    if (c.source.group?.until) problems.push('source.group.until only applies to a calendar');
    if (c.source.period !== undefined && !page.blocks.some((b) => b.look === 'period'))
      problems.push('source.period "page" needs a period block on the same page');
    const field = (id: string) => collection!.fields.find((f) => f.id === id);
    const { aggregate, group } = c.source;
    if (c.show.kind === 'pie' && ['latest', 'min', 'max'].includes(aggregate))
      problems.push('a pie chart cannot use latest, min or max');
    if (c.source.running) {
      if (!group.unit || c.show.kind === 'pie' || !['count', 'sum'].includes(aggregate))
        problems.push('running needs a time-grouped bar or line with count or sum');
      if (c.source.running === 'all' && c.source.compare)
        problems.push('running all cannot combine with compare; use shown');
    }
    if (c.source.split) {
      const by = field(c.source.split.by);
      if (!group.unit || c.show.kind === 'pie')
        problems.push('split needs a time-grouped bar or line');
      if (by?.type !== 'choice' || isMultipleChoice(by))
        problems.push('split.by needs a single-choice field');
      if (c.show.kind === 'bar' && !['count', 'sum'].includes(aggregate))
        problems.push('stacked bars need count or sum');
      if (c.source.running || c.source.compare)
        problems.push('split cannot combine with running or compare');
      if (
        c.source.choice &&
        page.blocks.some((b) => b.look === 'choices' && b.source.field === c.source.split!.by)
      )
        problems.push('split cannot follow page choice on the same field');
    }

    if (aggregate !== 'count' && aggregate !== 'distinctDays') {
      const f = c.source.field ? field(c.source.field) : undefined;
      if (!f || !NUMERIC_FIELD_TYPES.includes(f.type))
        problems.push(`${aggregate} needs field set to a number, money, rating or formula field`);
      // D-429：一张图只有一条数轴，不同货币不能画在一起。用数字块（分货币显示）或数笔数。
      if (hasRecordCurrency(f))
        problems.push(
          `${aggregate} can't chart ${f!.id}: each entry has its own currency, and amounts in different currencies can't be added up; use a number block or aggregate "count"`,
        );
    }
    if (c.show.pickPeriod) {
      if (group.unit === undefined || c.show.kind === 'pie')
        problems.push(
          'show.pickPeriod needs a bar or line chart grouped by time (source.group.unit)',
        );
      if (c.source.period !== undefined)
        problems.push(
          'show.pickPeriod can not be used with source.period: the chart would follow the range its own taps set',
        );
      const picker = page.blocks.find((b) => b.look === 'period');
      if (!picker || !(picker as { show: { custom?: boolean } }).show.custom)
        problems.push('show.pickPeriod needs a period block with custom: true on the same page');
    }
    if (group.showEmpty || group.filter)
      problems.push('a chart groups by time (unit) or by a choice or link field (by)');
    if (group.unit === undefined) {
      const type = group.by ? field(group.by)?.type : undefined;
      // 多选（D-607）：一条记录算进几块，各块加起来超过整个圆。
      if (c.show.kind === 'pie' && isMultipleChoice(group.by ? field(group.by) : undefined))
        problems.push(
          `a pie chart can't be grouped by ${group.by}: it ${MULTIPLE_CHOICE_NOT_ONE} and the slices would add up to more than the whole; use a bar chart`,
        );
      if (type !== 'choice' && type !== 'link')
        problems.push(
          'a chart needs source.group {unit: "day"|"week"|"month", by?: a date field} or {by: a choice or link field} (a link field: one point per entry of the linked table)',
        );
      if (group.last !== undefined) problems.push('source.group.last only applies to time groups');
    } else {
      if (c.show.kind === 'pie')
        problems.push('a pie chart can only be grouped by a choice or link field');
      const d = group.by;
      const dType = d === undefined ? undefined : field(d)?.type;
      if (d !== undefined && !isSystemField(d) && dType !== 'date' && dType !== 'datetime')
        problems.push(`source.group.by ${d} must be a date field of ${collection!.id}`);
      if (c.source.days) problems.push('days.date only applies when grouping by a choice field');
    }
    if (c.source.compare !== undefined) {
      if (group.unit === undefined)
        problems.push(
          'compare needs a time group (source.group {unit}): it draws the period before',
        );
      if (c.show.kind === 'pie') problems.push('a pie chart has no previous period: no compare');
      if (c.source.period === undefined && (c.source.filter ?? []).some((x) => x.op === 'inPeriod'))
        problems.push(
          "compare can't be used with an inPeriod filter: the filter would cut off the previous period",
        );
    }
    const date = c.source.days?.date;
    const dateType = date === undefined ? undefined : field(date)?.type;
    if (
      date !== undefined &&
      !isSystemField(date) &&
      dateType !== 'date' &&
      dateType !== 'datetime'
    )
      problems.push(`days.date ${date} must be a date field of ${collection!.id}`);
    return problems;
  },
  describe: (c, _config, ctx) => t(ctx.locale, 'describeChart', { v0: c.show.title }),
  edit: { text: [{ prop: 'title', max: 60 }], style: ['tone'] },
  ai: {
    doc: 'show {kind: "bar"|"line"|"pie", title}, source {table, aggregate: "count"|"sum"|"avg"|"min"|"max"|"latest"|"distinctDays" (days with at least one entry), field? (number, money, rating, duration or formula; for numeric aggregates; latest reads the newest entry in each bucket), filter?, group: {unit: "day"|"week"|"month", by? (a date or datetime field or "createdAt"; default: the first date field), last? (2-31; default 7 days, 8 weeks, 6 months)} or {by: a choice field, or a link field for one point per entry of the linked table}}: a pie chart needs group {by: a choice or link field} (rule 33); compare?: "previous" (only with a time group, bar or line, and no inPeriod filter) also draws the period before, shifted onto the same positions: a dashed line, or pale bars behind ("compared with last month", "和上个月比"); pickPeriod?: true (bar or line grouped by time, not following the page range: tapping a bar or point sets the time range of the page to that day, week or month, and what follows the range changes with it; the page needs a period block with custom: true), period?: "page" follows the time range picked in the period block on the same page (the chart then covers that range, by day, week or month by its length; group.unit and last are ignored; a pie follows it too); running?: "shown"|"all" (time-grouped count/sum: running from zero at the visible edge, or including matching entries before it; compare supports shown only), split?: {by: a single-choice field} (time-grouped stacked bars with count/sum or separate lines with any chart aggregate; no running or compare; at most 8 series, rule 78); choice?: "page" draws only the entries with the option picked in the choices block on the same page (rule 65)',
  },
  example: {
    show: { kind: 'bar', title: 'Spending by month' },
    source: {
      table: 'expenses',
      aggregate: 'sum',
      field: 'amount',
      group: { unit: 'month', by: 'date' },
    },
  },
});

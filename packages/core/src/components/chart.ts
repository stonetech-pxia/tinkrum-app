import { z } from 'zod';

import { t } from '../messages';
import { isMultipleChoice, MULTIPLE_CHOICE_NOT_ONE } from '../fields';
import { hasRecordCurrency } from '../money-currency';
import { boundedText, DaysSchema, filterSchema, GroupingSchema, IdSchema } from '../schema-base';
import { followChoiceProblems, isChoiceTabs, isTimeTabs } from './tabs';
import { type LookDefinitionOf, defineLook, isSystemField, NUMERIC_FIELD_TYPES } from './define';

/** Chart data source: a table, grouped by time period or single-choice / reference field (group is required), with one value per group. */
export const ChartSourceSchema = z.strictObject({
  table: IdSchema,
  // streak / daysSince / avgInterval in v33 structures cannot appear in valid configuration (E3), removed in v34.
  aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max', 'latest', 'distinctDays']),
  field: IdSchema.optional(),
  filter: filterSchema().optional(),
  /** Date field used for distinctDays calculation (when grouping by single-choice); for time grouping, it is group.by. */
  days: z.strictObject({ date: DaysSchema.shape.date }).optional(),
  group: GroupingSchema,
  running: z.enum(['shown', 'all']).optional(),
  split: z.strictObject({ by: IdSchema }).optional(),
  /** Compare to previous period (D-439): renders an equally long preceding time period, only for time-grouped bar and line charts. */
  compare: z.literal('previous').optional(),
  /** Follows the page-level time range (D-440): the page must have time tabs; renders according to the selected range, ignoring group.unit and last (automatically selects day, week, or month based on range length). */
  period: z.literal('page').optional(),
  /**
   * Follows the page-level option tabs (D-573): the page must have tabs by a choice field reading the
   * same table; calculates only records where this field matches the selected item ("All" adds no
   * condition). Grouping by the same field is not allowed.
   */
  choice: z.literal('page').optional(),
});
export type ChartSource = z.infer<typeof ChartSourceSchema>;

const shape = {
  show: z.strictObject({
    kind: z.enum(['bar', 'line', 'pie']),
    title: boundedText(1, 60),
    /**
     * Tapping a bar/point updates the page time range to that period (D-585): the page must have
     * time tabs with custom, synchronizing number cards, lists, and charts on the page that
     * follow the time range. Charts segment themselves by group.unit independently of the page
     * range (no source.period).
     */
    pickPeriod: z.literal(true).optional(),
  }),
  source: ChartSourceSchema,
};

/**
 * Chart (D-249): records of a table grouped by time period (recent days/weeks/months, group.unit)
 * or single-choice field (group.by), displayed as bar, line, or pie charts. Pie charts support
 * only single-choice grouping. D-336: can also be reference fields, with one point per record in
 * the referenced table. Fixed set of visualizations and aggregations only, no expressions;
 * records are read locally.
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
  // D-249: sum and average require numeric fields; single-choice grouping requires single-choice fields; time grouping requires date fields; pie charts require single-choice grouping.
  check: (c, { collection, page }) => {
    const problems: string[] = [...followChoiceProblems(c.source, page)];
    if (c.source.group?.until) problems.push('source.group.until only applies to a calendar');
    if (c.source.period !== undefined && !page.blocks.some(isTimeTabs))
      problems.push(
        'source.period "page" needs time tabs (a tabs block with show.periods) on the same page',
      );
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
        page.blocks.some((b) => isChoiceTabs(b) && b.source.field === c.source.split!.by)
      )
        problems.push('split cannot follow page choice on the same field');
    }

    if (aggregate !== 'count' && aggregate !== 'distinctDays') {
      const f = c.source.field ? field(c.source.field) : undefined;
      if (!f || !NUMERIC_FIELD_TYPES.includes(f.type))
        problems.push(`${aggregate} needs field set to a number, money, rating or formula field`);
      // D-429: a chart has only a single value axis, different currencies cannot be rendered together. Use numeric blocks (displayed per currency) or record counts.
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
      const picker = page.blocks.find(isTimeTabs);
      if (!picker?.show.custom)
        problems.push('show.pickPeriod needs time tabs with custom: true on the same page');
    }
    if (group.showEmpty || group.filter)
      problems.push('a chart groups by time (unit) or by a choice or link field (by)');
    if (group.unit === undefined) {
      const type = group.by ? field(group.by)?.type : undefined;
      // Multiple choice (D-607): a single record counts toward multiple slices, causing the sum of slices to exceed the full circle.
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
    doc: 'show {kind: "bar"|"line"|"pie", title}, source {table, aggregate: "count"|"sum"|"avg"|"min"|"max"|"latest"|"distinctDays" (days with at least one entry), field? (number, money, rating, duration or formula; for numeric aggregates; latest reads the newest entry in each bucket), filter?, group: {unit: "day"|"week"|"month", by? (a date or datetime field or "createdAt"; default: the first date field), last? (2-31; default 7 days, 8 weeks, 6 months)} or {by: a choice field, or a link field for one point per entry of the linked table}}: a pie chart needs group {by: a choice or link field} (rule 33); compare?: "previous" (only with a time group, bar or line, and no inPeriod filter) also draws the period before, shifted onto the same positions: a dashed line, or pale bars behind ("compared with last month", "和上个月比"); pickPeriod?: true (bar or line grouped by time, not following the page range: tapping a bar or point sets the time range of the page to that day, week or month, and what follows the range changes with it; the page needs time tabs with custom: true), period?: "page" follows the time range picked in the time tabs on the same page (the chart then covers that range, by day, week or month by its length; group.unit and last are ignored; a pie follows it too); running?: "shown"|"all" (time-grouped count/sum: running from zero at the visible edge, or including matching entries before it; compare supports shown only), split?: {by: a single-choice field} (time-grouped stacked bars with count/sum or separate lines with any chart aggregate; no running or compare; at most 8 series, rule 78); choice?: "page" draws only the entries with the option picked in the tabs by a choice field on the same page (rule 65)',
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

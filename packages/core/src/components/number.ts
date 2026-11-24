import { z } from 'zod';

import { t } from '../messages';
import { totalFormulaText } from '../stat-calc-text';
import { hasRecordCurrency } from '../money-currency';
import {
  AGGREGATES,
  boundedText,
  DaysSchema,
  filterSchema,
  GroupingSchema,
  IdSchema,
  SEQUENCE_AGGREGATES,
} from '../schema-base';
import { followChoiceProblems } from './choices';
import { type LookDefinitionOf, defineLook, NUMERIC_FIELD_TYPES } from './define';

export const TotalSourceSchema = z.strictObject({
  table: IdSchema,
  aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max', 'latest', 'distinctDays']),
  field: IdSchema.optional(),
  filter: filterSchema().optional(),
  days: z.strictObject({ date: DaysSchema.shape.date }).optional(),
});

/** Summary read methods (shared by number blocks and charts): records filtered from a table count as one number, or one number per group when grouped. */
export const NumberSourceSchema = z.strictObject({
  table: IdSchema,
  calc: z
    .strictObject({
      with: z
        .array(TotalSourceSchema.extend({ id: IdSchema }))
        .min(1)
        .max(3),
      formula: boundedText(1, 500),
      as: z.enum(['percent', 'number']).optional(),
    })
    .optional(),
  aggregate: z.enum(AGGREGATES),
  field: IdSchema.optional(),
  filter: filterSchema().optional(),
  /** Which date to use and how to calculate streaks for date-based aggregation (D-284). */
  days: DaysSchema.optional(),
  /** One row per group for single-select or relation fields (D-248, D-336). */
  group: GroupingSchema.optional(),
  /** Goal (D-307): displays "3 / 5" and progress. */
  goal: z.number().positive().max(1_000_000_000).optional(),
  /** Compare with the same period last cycle (D-308): replaces the only inPeriod condition in the filter with the previous period. */
  compare: z.literal('previous').optional(),
  /** Follows the time range on the page (D-440): there must be a period block on the same page; inPeriod in filters is no longer used, calculated based on the selected range. */
  period: z.literal('page').optional(),
  /**
   * Follows the page-level option tabs (D-573): the page must have a choices block reading the
   * same table; calculates only records where this field matches the selected item ("All" adds no
   * condition). Grouping by the same field is not allowed.
   */
  choice: z.literal('page').optional(),
  /** Subtract another total (D-337): can be another table, e.g., income minus allocated funds. Checked in stat-minus.ts. */
  minus: z
    .strictObject({
      table: IdSchema,
      aggregate: z.enum(['count', 'sum']),
      field: IdSchema.optional(),
      filter: filterSchema().optional(),
    })
    .optional(),
});
export type NumberSource = z.infer<typeof NumberSourceSchema>;

const shape = { show: z.strictObject({ label: boundedText(1, 40) }), source: NumberSourceSchema };

const SEQUENCE: readonly string[] = SEQUENCE_AGGREGATES;

/**
 * Number (formerly stat): counts, sums, averages, finds minimum, or maximum for a table
 * (filterable). group.by (D-248): groups by a single-select or relation field, with one row per
 * option (records with no selection count as a separate row). Sequential aggregation (D-284):
 * streak (current streak, best streak displayed below), daysSince, avgInterval, distinctDays,
 * calculated by days.date (defaults to the first date field, falls back to creation time);
 * days.unit, perUnit, skip apply only to streak. goal (D-307) displays "value / goal" and
 * progress; compare (D-308) compares with the same period last cycle (compare.ts). minus (D-337):
 * displays "this total minus another total", supports count and sum only (stat-minus.ts). latest
 * (D-618): value of the field from the latest entry, sharing the same "latest" logic as summary
 * fields (related.ts latestValue, date is days.date).
 */
export const numberComponent: LookDefinitionOf<'number', typeof shape> = defineLook({
  look: 'number',
  shape,
  kind: 'container',
  layer: 'table',
  reads: 'table',
  writes: false,
  refs: {
    'source.table': { to: 'table' },
    'source.filter': { to: 'filter' },
    'source.group.by': { to: 'field', role: 'groupBy', types: ['choice', 'link'] },
    'source.days.date': { to: 'field', role: 'dateField', types: ['date', 'datetime'] },
    'source.days.skip.field': { to: 'field', role: 'skipField', types: ['choice'] },
  },
  check: (c, { collection, page }) => {
    const { aggregate, field, days, group } = c.source;
    const problems: string[] = [...followChoiceProblems(c.source, page)];
    if (c.source.group?.until) problems.push('source.group.until only applies to a calendar');
    if (c.source.period !== undefined) {
      if (!page.blocks.some((b) => b.look === 'period'))
        problems.push('source.period "page" needs a period block on the same page');
      if (SEQUENCE.includes(aggregate))
        problems.push(`${aggregate} doesn't depend on a period: no source.period`);
    }
    // latest (D-618): a single value from the latest record; amounts where each entry has its own currency cannot clearly determine which currency is used.
    if (aggregate === 'latest' && hasRecordCurrency(collection!.fields.find((f) => f.id === field)))
      problems.push(
        `latest can't be used with ${field}: ${field} has its own currency on each entry; show it in a list of the newest entries instead`,
      );
    // D-429: amounts with different currencies per entry are displayed separately and cannot be compared or subtracted using a single number.
    if (
      hasRecordCurrency(collection!.fields.find((f) => f.id === c.source.field)) &&
      (c.source.goal !== undefined || c.source.compare !== undefined || c.source.minus)
    )
      problems.push(
        `goal, compare and minus can't be used with ${c.source.field}: each entry has its own currency, and amounts in different currencies can't be added up`,
      );
    if (c.source.goal !== undefined && (aggregate === 'daysSince' || aggregate === 'avgInterval'))
      problems.push(`goal can't be used with ${aggregate}: it is a number of days, not an amount`);
    if (c.source.compare !== undefined) {
      if (aggregate === 'streak' || aggregate === 'daysSince' || aggregate === 'avgInterval')
        problems.push(`compare can't be used with ${aggregate}: it doesn't depend on a period`);
      if (
        c.source.period === undefined &&
        (c.source.filter ?? []).filter((x) => x.op === 'inPeriod').length !== 1
      )
        problems.push(
          'compare needs a filter with one inPeriod condition (e.g. thisMonth): that period is compared with the previous one',
        );
    }
    if (group && (group.unit || group.last || group.showEmpty || group.filter || !group.by))
      problems.push('a number groups by a choice or link field only: source.group {by}');
    if (aggregate !== 'count' && !SEQUENCE.includes(aggregate)) {
      const f = field ? collection!.fields.find((x) => x.id === field) : undefined;
      if (!f || !NUMERIC_FIELD_TYPES.includes(f.type))
        problems.push(
          `${aggregate} needs field set to a number, money, rating${aggregate === 'latest' ? ', duration' : ''} or formula field`,
        );
    }
    if (days?.date !== undefined && !SEQUENCE.includes(aggregate) && aggregate !== 'latest')
      problems.push(
        `days.date only applies to aggregate ${SEQUENCE_AGGREGATES.join(', ')} and latest`,
      );
    if (aggregate !== 'streak') {
      if (days && (days.unit !== undefined || days.perUnit !== undefined || days.skip))
        problems.push('days.unit, perUnit and skip only apply to aggregate "streak"');
      return problems;
    }
    const skip = collection!.fields.find((x) => x.id === days?.skip?.field);
    if (
      days?.skip &&
      skip?.type === 'choice' &&
      !skip.options.some((o) => o.id === days.skip!.option)
    )
      problems.push(
        `days.skip.option must be an option id of ${skip.id}: ${skip.options.map((o) => o.id).join(', ')}`,
      );
    return problems;
  },
  describe: (c, config, ctx) => {
    const formula = totalFormulaText(c.source, config, ctx.locale);
    return formula
      ? t(ctx.locale, 'describeCalculatedNumber', { label: c.show.label, formula })
      : t(ctx.locale, 'describe_stat_c1587', { v0: c.show.label });
  },
  edit: { text: [], style: ['tone', 'size'], backdrop: true },
  ai: {
    doc: 'show {label}, source {table, aggregate: "count"|"sum"|"avg"|"min"|"max"|"latest"|"streak"|"daysSince"|"avgInterval"|"distinctDays", field? (a number, money, rating, duration or formula field; only for sum, avg, min, max and latest: the value on the newest entry, rule 72), filter?, group? {by: a choice or link field} (one row per option, e.g. spending per category), days? {date? (for the day-based aggregates and latest: a date or datetime field or "createdAt"; default: the first date field), unit?: "day"|"week"|"month", perUnit? (1-50), skip? {field, option}} (unit, perUnit and skip: streak only), goal? (a number: shows "3 / 5" and progress), compare?: "previous", period?: "page" (follows the time range of the period block on the same page; an inPeriod in the filter is ignored, compare works without one), choice?: "page" (counts only the entries with the option picked in the choices block on the same page, rule 65; minus and calc.with totals are not narrowed), minus? ({table, aggregate: "count"|"sum", field?, filter?}: shows this total minus that one; both follow the page time range), calc? {with: [{id, table, aggregate (as above except streak, daysSince, avgInterval), field?, filter?, days? {date?}}] (1-3, unique ids except total), formula: an existing numeric formula using {total} and {id}, as?: "percent"|"number"} (rule 77)} (rule 33)',
    rule: {
      n: 33,
      text: 'Summaries of a table are number and chart blocks (their source is written as in their look docs); you only choose how they are built and never see the values. Totals per category ("how much per category", "每个分类花了多少") → a number block with source.group {by: that choice field}: one row per option and a "not set" row. A link field works too (D-336): one row per entry of the linked table, as a summary block of its own. When the value belongs on each entry of that linked table instead ("for each habit show …", "每个客户显示…", a streak on each habit when habits are their own table), it is a rollup field on that table, shown in its list (rule 42), not a number block grouped by the link. A number block can\'t be grouped by other fields. Charts ("a chart of spending per month", "pie chart by category") → a chart block on the page that shows the table: amounts over time are kind "bar" or "line" grouped by unit, with last = how many recent days / weeks / months (12 for "the last year by month"); shares of a whole are kind "pie" grouped by a choice field. Use aggregate "sum" with the money field for spending, "count" for how many entries; a single total or a per-category list without a picture is a number block. Habits and "how long since" ("给每个习惯显示连续天数", "days since I last watered each plant", "average cycle length") → a number block with a day-based aggregate: "streak" (current run of days in a row, with the best run under it; today not logged yet does not break it), "daysSince" (days since the latest entry), "avgInterval" (average days between entry days), "distinctDays" (days with at least one entry). One row per habit / plant / car → source.group {by: the choice field that names it} (when they are their own table: the rollup above). "3 times a week" → days {unit: "week", perUnit: 3}. An option meaning "skipped" or "rest day" → days.skip {field, option}: such days neither break nor add. A chart can only use "distinctDays"; the others are number blocks. A goal ("喝水显示今天的进度，目标 8 杯" → sum or count, filter inPeriod "today", goal 8) shows "value / goal" with progress. compare: "previous" ("本月支出和上月比", "vs last week") needs exactly one inPeriod filter; it shows the previous value for the same days so far and ↑/↓ with the percent; not for streak, daysSince or avgInterval. One total minus another ("还剩多少钱可以分配", "balance = income − spending", "stock = in − out") → source.minus: the block\'s own total minus that one, which may come from another table; both aggregates count or sum, the same currency, and no group or compare. Without a period filter both totals cover all entries, so money not spent stays counted month after month (a zero-based budget: categories with assignments and spending as linked tables, "available" = a rollup of everything assigned minus a rollup of everything spent, rule 42).',
    },
  },
  example: {
    show: { label: 'This month' },
    source: {
      table: 'expenses',
      aggregate: 'sum',
      field: 'amount',
      filter: [{ field: 'date', op: 'inPeriod', value: 'thisMonth' }],
    },
  },
});

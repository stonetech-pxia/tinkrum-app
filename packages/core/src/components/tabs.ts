import { z } from 'zod';

import { t } from '../messages';
import { IdSchema } from '../schema-base';
import { PAGE_PERIODS } from '../schema-primitives';
import type { Page } from '../schema';
import { type LookDefinitionOf, defineLook } from './define';

// A row of tabs on the page that narrows what the page's blocks show (D-655
// merged the looks period and choices into this one). Two kinds, told apart by source:
// - time (no source, show.periods; D-440, founder 2026-11-05; record blocks follow, D-561): charts,
//   numbers and record blocks on the page with source.period "page" cover the picked range;
//   custom adds "Custom", which opens a date range picker.
// - by a choice field (source {table, field}; D-573, founder decision 2 on 2026-11-16): the field's
//   options (plus "All"); blocks of the page reading that table with source.choice "page" show
//   only entries whose field is the picked option.
// The pick exists only while the page is drawn and is stored nowhere (invariant 15); nothing runs
// by itself. A page has at most one of each kind, and they sit on the page, not in a group.

const TimeShowSchema = z.strictObject({
  /** The time ranges to pick from, in this order; the first is picked when the page opens unless default says otherwise. */
  periods: z
    .array(z.enum(PAGE_PERIODS))
    .min(1)
    .max(PAGE_PERIODS.length)
    .refine((list) => new Set(list).size === list.length, 'periods must be different'),
  default: z.enum(PAGE_PERIODS).optional(),
  /** Adds "Custom": the user picks the start and end dates. */
  custom: z.literal(true).optional(),
});

const ChoiceShowSchema = z.strictObject({
  /** Which options to show and in what order (option ids); omitted = every option of the field, in its order. */
  options: z
    .array(IdSchema)
    .min(1)
    .max(50)
    .refine((list) => new Set(list).size === list.length, 'options must be different')
    .optional(),
  /** false: no "All", one option is always picked. */
  all: z.literal(false).optional(),
  /** The option picked when the page opens; omitted = "All" (or the first option without "All"). */
  default: IdSchema.optional(),
});

const shape = {
  show: z.union([TimeShowSchema, ChoiceShowSchema]),
  /** Tabs by a choice field: the table and the choice field whose options are the tabs. Omitted = time tabs. */
  source: z.strictObject({ table: IdSchema, field: IdSchema }).optional(),
};

export const tabsComponent: LookDefinitionOf<'tabs', typeof shape> = defineLook({
  look: 'tabs',
  shape,
  kind: 'container',
  layer: 'table',
  reads: 'table',
  writes: false,
  refs: {
    'source.table': { to: 'table' },
    'source.field': { to: 'field', role: 'choiceField', types: ['choice'] },
  },
  check: (c, ctx) => {
    const problems: string[] = [];
    const show = c.show;
    if (!c.source) {
      if (!('periods' in show))
        return [
          'tabs need show.periods (time tabs) or source {table, field} (tabs by a choice field)',
        ];
      if (show.default !== undefined && !show.periods.includes(show.default))
        problems.push(`show.default ${show.default} must be one of show.periods`);
    } else if ('periods' in show) {
      return ['tabs by a choice field (source) take show {options?, all?, default?}, not periods'];
    } else {
      const field = ctx.collection?.fields.find((f) => f.id === c.source!.field);
      const ids = field?.type === 'choice' ? field.options.map((o) => o.id) : undefined;
      if (ids) {
        for (const id of show.options ?? [])
          if (!ids.includes(id))
            problems.push(
              `show.options ${id} is not an option of ${c.source.field}: ${ids.join(', ')}`,
            );
        const shown = show.options ?? ids;
        if (show.default !== undefined && !shown.includes(show.default))
          problems.push(`show.default ${show.default} must be one of: ${shown.join(', ')}`);
      }
    }
    if (ctx.parent) problems.push('a tabs block sits on the page itself, not inside a group');
    const time = c.source === undefined;
    if (ctx.page.blocks.filter((b) => (time ? isTimeTabs(b) : isChoiceTabs(b))).length > 1)
      problems.push(
        `page ${ctx.page.id} has more than one ${time ? 'time tabs' : 'tabs by a choice field'} block; keep one`,
      );
    return problems;
  },
  describe: (c, config, ctx) => {
    if (!c.source)
      return t(ctx.locale, 'describe_period', {
        n:
          ('periods' in c.show ? c.show.periods.length : 0) +
          ('custom' in c.show && c.show.custom ? 1 : 0),
      });
    const table = config.data.tables.find((x) => x.id === c.source!.table);
    const field = table?.fields.find((f) => f.id === c.source!.field);
    return t(ctx.locale, 'describe_choices', { v0: field?.name ?? c.source.field });
  },
  edit: { text: [], style: [] },
  ai: {
    doc: 'a row of tabs on a page that narrows what the page shows; the pick is temporary and never written. Two kinds. Time tabs: show {periods: [1-12 of "today"|"thisWeek"|"thisMonth"|"thisYear"|"last7days"|"last30days"|"last90days"|"last365days"|"yesterday"|"lastWeek"|"lastMonth"|"lastYear"] (the choices, in this order), default? (one of the periods; the first when not set), custom?: true (adds "Custom": the user picks a start and end date)}, no source: charts, number blocks and record blocks (not calendars) on the same page with source.period: "page" follow what the user picks (rule 56). Tabs by a choice field: source {table, field: a choice field of it}, show {options? (option ids of the field, in the order to show; default: all its options in their order), all?: false (no "All" tab: one option is always picked), default? (the option picked when the page opens; default "All", or the first option when all is false)}: one tab per option (with "All" first); record blocks, number blocks and charts on the same page that read the same table and have source.choice: "page" show only the entries whose field is the picked option ("All": every entry) (rule 65). At most one of each kind per page, on the page itself, not in a group.',
    rules: [
      {
        n: 56,
        text: 'Time range on a page: when the user wants to switch what a page covers ("本周 / 本月 看一下", "let me pick this week or this month", "加一个日期范围"), add ONE tabs block {look: "tabs", show: {periods}} with only the choices they name (fewer is better: "本月 本星期" → periods ["thisMonth", "thisWeek"]; add custom: true for "自定义" or "pick my own dates") and set source.period: "page" on EVERY chart and number block already on that page (all of them follow unless the user says one should stay fixed, e.g. "全年合计不用跟着变"); a chart or number block you add later to a page that has time tabs gets source.period: "page" too. addContainer {page, block} for the tabs block; updateContainer {page, block, changes: {source: {...}}} for each chart or number (to take one off the range, set source.period to null). Never leave the existing charts out and only offer to do it later: the user asked for the page to switch, so the charts switch. Changing the choices is updateContainer on the tabs block with changes {show: {periods: [...]}}. A chart that follows the range ignores group.unit and last and picks day, week or month by the length of the range; with compare: "previous" it is drawn against the stretch right before (this week against last week, this month against last month); a number that follows ignores the inPeriod in its filter. A page has at most one time tabs block (and at most one by a choice field, rule 65). Pin it with pin: "top" if the user wants it to stay in view. Record blocks follow it too (list, cards, checklist, tiles, board, table, gallery): set source.period: "page" on every record block on that page, like the charts, unless the user says a list should stay as it is; a list that follows shows only the entries in the picked range, by the date field of the inPeriod in its filter (that inPeriod is then ignored) or else the first date field of the table. A calendar never follows (it moves by month), and a list with its own show.browse.period (rule 38) cannot follow too: keep the one the user asked for.',
      },
      {
        n: 65,
        text: 'Tabs by a choice field on a page: when the user wants to switch a page between the options of one choice field ("tabs for To ship / Shipped / Done", "switch between statuses", "只看待发货 / 已发货", "加一排按状态切换", "des onglets par statut"), add ONE tabs block {look: "tabs", source: {table, field}, show: {}} at the top of the page (pin: "top" if it should stay in view), with show.options only when the user names some of the options or an order, show.all: false only when they do not want "All", and show.default when they say which one opens first. Then set source.choice: "page" on EVERY list, cards, checklist, tiles, board, calendar, table, gallery, number and chart block on that page that reads the same table (all of them follow unless the user says one should stay as it is, e.g. "the total of all orders stays"); a block of that table you add later to such a page gets source.choice: "page" too. addContainer {page, block} for the tabs block; updateContainer {page, block, changes: {source: {choice: "page"}}} for each block (to take one off, set source.choice to null). Never leave the existing blocks out and only offer to do it later. A block that reads another table cannot follow (leave it as it is). A block grouped by that same field (a board with a column per status, a pie or number grouped by it) already shows every option: leave it without source.choice; a list with show.browse.filter on that field keeps its own filter row instead (do not add both). A page has at most one tabs block by a choice field. It works next to time tabs (rule 56): a block may follow both (source.period and source.choice both "page"). Adding right where you look (rule 45, values "$here") then starts the new entry with the picked option.',
      },
    ],
    docAfter: 'chart',
  },
  example: { show: { periods: ['thisWeek', 'thisMonth'], custom: true } },
});

export type TabsBlock = Extract<Page['blocks'][number], { look: 'tabs' }>;
export type TimeTabs = TabsBlock & { show: z.infer<typeof TimeShowSchema>; source?: undefined };
export type ChoiceTabs = TabsBlock & {
  show: z.infer<typeof ChoiceShowSchema>;
  source: { table: string; field: string };
};

/** Time tabs (no source). */
export const isTimeTabs = (b: { look: unknown; source?: unknown }): b is TimeTabs =>
  b.look === 'tabs' && b.source === undefined;
/** Tabs by a choice field (source {table, field}). */
export const isChoiceTabs = (b: { look: unknown; source?: unknown }): b is ChoiceTabs =>
  b.look === 'tabs' && b.source !== undefined;

/**
 * Checks for blocks following the choice tabs (record blocks, numbers, charts): the page must have
 * tabs by a choice field reading the same table; blocks grouped by that same field already show
 * every option and do not follow; a list whose browse.filter uses the same field keeps one of the
 * two (D-561 does the same for time ranges).
 */
export function followChoiceProblems(
  source: {
    table: string;
    choice?: 'page' | undefined;
    group?: { by?: string | undefined } | undefined;
  },
  page: Page,
  browseFilter?: readonly string[],
): string[] {
  if (source.choice === undefined) return [];
  const row = page.blocks.find(isChoiceTabs);
  if (!row)
    return [
      'source.choice "page" needs tabs by a choice field (source {table, field}) on the same page',
    ];
  const { table, field } = row.source;
  if (table !== source.table)
    return [
      `the tabs on this page pick from ${table}, and this block reads ${source.table}: only blocks that read ${table} can follow them, so remove source.choice here`,
    ];
  const problems: string[] = [];
  if (source.group?.by === field)
    problems.push(
      `this block is grouped by ${field}, which already shows every option of it: no source.choice`,
    );
  if (browseFilter?.includes(field))
    problems.push(
      `this list has its own show.browse.filter on ${field}: keep one of the two (remove source.choice, or take ${field} out of show.browse.filter)`,
    );
  return problems;
}

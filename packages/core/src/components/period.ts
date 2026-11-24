import { z } from 'zod';

import { t } from '../messages';
import { PAGE_PERIODS } from '../schema-primitives';
import { type LookDefinitionOf, defineLook } from './define';

// Time range (D-440, set by founder 2026-11-05; record blocks follow suit, D-561): a row of options
// on the page; when the user taps one, chart and number cards on the same page with source.period
// set to "page" render accordingly. Options are determined by config (modifiable by Tink), not the
// dozen-plus Expensify ones; custom adds a "Custom" option which opens a date range picker upon
// tapping. Selection exists only while rendering the page, nothing is stored (invariant 15);
// nothing runs automatically.

const shape = {
  show: z.strictObject({
    /** Selectable time periods, ordered accordingly; the first is the default (unless default is specified). */
    options: z
      .array(z.enum(PAGE_PERIODS))
      .min(1)
      .max(PAGE_PERIODS.length)
      .refine((list) => new Set(list).size === list.length, 'options must be different'),
    default: z.enum(PAGE_PERIODS).optional(),
    /** Adds a "Custom" option: user selects start and end dates themselves. */
    custom: z.literal(true).optional(),
  }),
};

export const periodComponent: LookDefinitionOf<'period', typeof shape> = defineLook({
  look: 'period',
  shape,
  kind: 'container',
  layer: 'record',
  reads: 'none',
  writes: false,
  check: (c, ctx) => {
    const problems: string[] = [];
    if (c.show.default !== undefined && !c.show.options.includes(c.show.default))
      problems.push(`show.default ${c.show.default} must be one of show.options`);
    if (ctx.parent) problems.push('a period block sits on the page itself, not inside a group');
    if (ctx.page.blocks.filter((b) => b.look === 'period').length > 1)
      problems.push(`page ${ctx.page.id} has more than one period block; keep one`);
    return problems;
  },
  describe: (c, _config, ctx) =>
    t(ctx.locale, 'describe_period', { n: c.show.options.length + (c.show.custom ? 1 : 0) }),
  edit: { text: [], style: [] },
  ai: {
    doc: 'show {options: [1-8 of "today"|"thisWeek"|"thisMonth"|"thisYear"|"last7days"|"last30days"|"last90days"|"last365days"|"yesterday"|"lastWeek"|"lastMonth"|"lastYear"] (the choices, in this order), default? (one of the options; the first when not set), custom?: true (adds "Custom": the user picks a start and end date)}: a row of time range choices on a page. Charts, number blocks and record blocks (not calendars) on the same page with source.period: "page" follow what the user picks (rule 56). The choice is temporary and never written.',
    rule: {
      n: 56,
      text: 'Time range on a page: when the user wants to switch what a page covers ("本周 / 本月 看一下", "let me pick this week or this month", "加一个日期范围"), add ONE period block with only the choices they name (fewer is better: "本月 本星期" → options ["thisMonth", "thisWeek"]; add custom: true for "自定义" or "pick my own dates") and set source.period: "page" on EVERY chart and number block already on that page (all of them follow unless the user says one should stay fixed, e.g. "全年合计不用跟着变"); a chart or number block you add later to a page that has a period block gets source.period: "page" too. addContainer {page, block} for the period block; updateContainer {page, block, changes: {source: {...}}} for each chart or number (to take one off the range, set source.period to null). Never leave the existing charts out and only offer to do it later: the user asked for the page to switch, so the charts switch. Changing the choices is updateContainer on the period block with changes {show: {options: [...]}}. A chart that follows the range ignores group.unit and last and picks day, week or month by the length of the range; with compare: "previous" it is drawn against the stretch right before (this week against last week, this month against last month); a number that follows ignores the inPeriod in its filter. A page has at most one period block. Pin it with pin: "top" if the user wants it to stay in view. Record blocks follow it too (list, cards, checklist, tiles, board, table, gallery): set source.period: "page" on every record block on that page, like the charts, unless the user says a list should stay as it is; a list that follows shows only the entries in the picked range, by the date field of the inPeriod in its filter (that inPeriod is then ignored) or else the first date field of the table. A calendar never follows (it moves by month), and a list with its own show.browse.period (rule 38) cannot follow too: keep the one the user asked for.',
    },
    docAfter: 'chart',
  },
  example: { show: { options: ['thisWeek', 'thisMonth'], custom: true } },
});

import { z } from 'zod';

import { t } from '../messages';
import { IdSchema } from '../schema-base';
import type { Page } from '../schema';
import { type LookDefinitionOf, defineLook } from './define';

// A row of option tabs on the page (D-573, founder decision 2 on 2026-11-16): options of a
// single-choice field in a table arranged in a row (plus "All"), where tapping one makes record
// blocks, numbers, and charts on the same page reading this table with source.choice as "page"
// display only records where this field matches that item. Same syntax as time range blocks
// (period, D-440). Selection state exists only while rendering the page, stored nowhere (invariant
// 15); nothing runs automatically. "Pick a record" and "Pick a day" were not approved and are not
// here.

const shape = {
  show: z.strictObject({
    /** Which options to display and in what order (option IDs); omitted means all options of the field, in field order. */
    options: z
      .array(IdSchema)
      .min(1)
      .max(50)
      .refine((list) => new Set(list).size === list.length, 'options must be different')
      .optional(),
    /** false: excludes "All", always selects an item. */
    all: z.literal(false).optional(),
    /** Default selected item (option ID) when opening the page; omitted means "All" (or the first item if "All" is excluded). */
    default: IdSchema.optional(),
  }),
  source: z.strictObject({ table: IdSchema, field: IdSchema }),
};

export const choicesComponent: LookDefinitionOf<'choices', typeof shape> = defineLook({
  look: 'choices',
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
    const field = ctx.collection?.fields.find((f) => f.id === c.source.field);
    const ids = field?.type === 'choice' ? field.options.map((o) => o.id) : undefined;
    if (ids) {
      for (const id of c.show.options ?? [])
        if (!ids.includes(id))
          problems.push(
            `show.options ${id} is not an option of ${c.source.field}: ${ids.join(', ')}`,
          );
      const shown = c.show.options ?? ids;
      if (c.show.default !== undefined && !shown.includes(c.show.default))
        problems.push(`show.default ${c.show.default} must be one of: ${shown.join(', ')}`);
    }
    if (ctx.parent) problems.push('a choices block sits on the page itself, not inside a group');
    if (ctx.page.blocks.filter((b) => b.look === 'choices').length > 1)
      problems.push(`page ${ctx.page.id} has more than one choices block; keep one`);
    return problems;
  },
  describe: (c, config, ctx) => {
    const table = config.data.tables.find((x) => x.id === c.source.table);
    const field = table?.fields.find((f) => f.id === c.source.field);
    return t(ctx.locale, 'describe_choices', { v0: field?.name ?? c.source.field });
  },
  edit: { text: [], style: [] },
  ai: {
    doc: 'show {options? (option ids of the field, in the order to show; default: all its options in their order), all?: false (no "All" choice: one option is always picked), default? (the option picked when the page opens; default "All", or the first option when all is false)}, source {table, field: a choice field of it}: a row of tabs on a page, one per option (with "All" first). Record blocks, number blocks and charts on the same page that read the same table and have source.choice: "page" show only the entries whose field is the picked option ("All": every entry) (rule 65). The pick is temporary and never written.',
    rule: {
      n: 65,
      text: 'Tabs by a choice field on a page: when the user wants to switch a page between the options of one choice field ("tabs for To ship / Shipped / Done", "switch between statuses", "只看待发货 / 已发货", "加一排按状态切换", "des onglets par statut"), add ONE choices block {look: "choices", source: {table, field}} at the top of the page (pin: "top" if it should stay in view), with show.options only when the user names some of the options or an order, show.all: false only when they do not want "All", and show.default when they say which one opens first. Then set source.choice: "page" on EVERY list, cards, checklist, tiles, board, calendar, table, gallery, number and chart block on that page that reads the same table (all of them follow unless the user says one should stay as it is, e.g. "the total of all orders stays"); a block of that table you add later to such a page gets source.choice: "page" too. addContainer {page, block} for the choices block; updateContainer {page, block, changes: {source: {choice: "page"}}} for each block (to take one off, set source.choice to null). Never leave the existing blocks out and only offer to do it later. A block that reads another table cannot follow (leave it as it is). A block grouped by that same field (a board with a column per status, a pie or number grouped by it) already shows every option: leave it without source.choice; a list with show.browse.filter on that field keeps its own filter row instead (do not add both). A page has at most one choices block. It works next to a period block (rule 56): a block may follow both (source.period and source.choice both "page"). Adding right where you look (rule 45, values "$here") then starts the new entry with the picked option.',
    },
    docAfter: 'period',
  },
  example: { show: {}, source: { table: 'expenses', field: 'category' } },
});

/**
 * Checks for blocks following the option row (record blocks, numbers, charts): the page must
 * contain an option row reading the same table; blocks grouped by the same field already render
 * each option individually and are not followed; list browse.filter using the same field leaves
 * one (D-561 does the same for time ranges).
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
  const row = page.blocks.find((b) => b.look === 'choices') as
    { source?: { table?: string; field?: string } } | undefined;
  if (!row) return ['source.choice "page" needs a choices block on the same page'];
  const table = row.source?.table;
  const field = row.source?.field;
  if (table !== source.table)
    return [
      `the choices block on this page picks from ${table}, and this block reads ${source.table}: only blocks that read ${table} can follow it, so remove source.choice here`,
    ];
  const problems: string[] = [];
  if (field !== undefined && source.group?.by === field)
    problems.push(
      `this block is grouped by ${field}, which already shows every option of it: no source.choice`,
    );
  if (field !== undefined && browseFilter?.includes(field))
    problems.push(
      `this list has its own show.browse.filter on ${field}: keep one of the two (remove source.choice, or take ${field} out of show.browse.filter)`,
    );
  return problems;
}

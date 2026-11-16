import { z } from 'zod';

import { t } from '../messages';
import { IdSchema } from '../schema-base';
import type { Page } from '../schema';
import { type LookDefinitionOf, defineLook } from './define';

// 页面上的一排选项（D-573，创始人 2026-11-16 决定 ② 第二步）：一张表的一个单选字段的选项排成一排（加「全部」），
// 用户点一个，同一页里读这张表、source.choice 是 "page" 的记录块、数字和图表只显示这个字段是那一项的记录。
// 和时间范围块（period，D-440）一个写法。选了什么只在页面画着的时候有，什么都不写（底线 15）；没有任何东西自己运行。
// 「选一条记录」「选一天」没批，不在这里。

const shape = {
  show: z.strictObject({
    /** 显示哪些选项、按什么顺序（选项 ID）；不写是这个字段的全部选项，按字段里的顺序。 */
    options: z
      .array(IdSchema)
      .min(1)
      .max(50)
      .refine((list) => new Set(list).size === list.length, 'options must be different')
      .optional(),
    /** false：没有「全部」，总是选着一项。 */
    all: z.literal(false).optional(),
    /** 打开页面时选哪一项（选项 ID）；不写是「全部」（没有「全部」时是第一项）。 */
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
 * 跟着这一排的块（记录块、数字、图表）的检查：页面上要有一排选项，读的是同一张表；按同一个字段分组的块已经把每个
 * 选项都画出来了，不跟；列表自己的 show.browse.filter 用了同一个字段时留一个（D-561 对时间范围也是这样）。
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

import { z } from 'zod';

import { calloutTokens } from '../callout-text';
import { t } from '../messages';
import { hasRecordCurrency } from '../money-currency';
import { ToolUseSchema } from '../record-ops-schema';
import { boundedText, IconValueSchema, openTargetSchema, richText } from '../schema-base';
import { IdSchema, filterSchema } from '../schema-primitives';
import { NUMERIC_FIELD_TYPES, type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({
    title: boundedText(1, 60),
    /** 文字里可以写 {count}（符合条件的有几条）和 {sum:字段}（这些记录某个数字字段的合计）。 */
    text: richText(400),
    icon: IconValueSchema.optional(),
    /** 卡片里「做事」按钮的字（要有 tools）。 */
    actionLabel: boundedText(1, 20).optional(),
    /** 卡片里「打开」按钮的字（要有 opens）。 */
    openLabel: boundedText(1, 20).optional(),
  }),
  /** 卡片说的是哪些记录：这张表里符合 filter 的。 */
  source: z.strictObject({ table: IdSchema, filter: filterSchema(5).optional() }),
  /** 一个就地的一键记录工具，点「做事」按钮时做（和按钮块一样，会先问、能撤销）。 */
  tools: z.array(ToolUseSchema).min(1).max(1).optional(),
  opens: openTargetSchema('opens must be a page, a system entry, tool:<id> or app:<id>', [
    'tool',
    'app',
  ]).optional(),
};

/**
 * 提示卡（D-580）：一张和「提示」同样底色和字样的卡片，说的是一张表里符合条件的记录——文字里的 {count}、{sum:字段}
 * 在画的时候按本机的记录算出来（不存进配置），卡片里最多两个按钮：一个做一键记录（tools），一个打开页面（opens）。
 * 例如「本月订阅待确认：有 3 项，合计 ¥371」+「加入本月」「修改」。要只在有记录时才出现，配 showIf 的 filter（D-579）。
 */
export const calloutComponent: LookDefinitionOf<'callout', typeof shape> = defineLook({
  look: 'callout',
  shape,
  kind: 'container',
  layer: 'table',
  reads: 'table',
  writes: true,
  tools: { as: ['self'], do: ['create', 'setAll', 'createAll'], max: 1 },
  refs: {
    'source.table': { to: 'table' },
    'source.filter': { to: 'filter' },
    opens: { to: 'target' },
  },
  check: (c, { collection }) => {
    const problems: string[] = [];
    for (const token of calloutTokens(c.show.text)) {
      if (token.kind !== 'sum') continue;
      const field = collection?.fields.find((f) => f.id === token.field);
      if (!field)
        problems.push(`show.text: {sum:${token.field}} is not a field of ${c.source.table}`);
      else if (!NUMERIC_FIELD_TYPES.includes(field.type))
        problems.push(`show.text: {sum:${token.field}} needs a number or money field`);
      else if (hasRecordCurrency(field))
        problems.push(
          `show.text: {sum:${token.field}} can't be added up: each entry has its own currency`,
        );
    }
    if (c.tools && !c.show.actionLabel)
      problems.push('show.actionLabel is needed when it has tools');
    if (!c.tools && c.show.actionLabel) problems.push('show.actionLabel needs tools');
    if (c.opens !== undefined && !c.show.openLabel)
      problems.push('show.openLabel is needed when it has opens');
    if (c.opens === undefined && c.show.openLabel) problems.push('show.openLabel needs opens');
    return problems;
  },
  describe: (c, _config, ctx) => t(ctx.locale, 'describeCallout', { v0: c.show.title }),
  edit: {
    text: [
      { prop: 'title', max: 60 },
      { prop: 'text', max: 400, multiline: true, rich: true },
    ],
    style: ['tone'],
  },
  ai: {
    doc: 'show {title, text, icon?, actionLabel?, openLabel?}, source {table, filter?}, tools? [one record tool, needs actionLabel], opens? (needs openLabel): a tinted card about the entries of the table that match the filter. In text, {count} is how many match and {sum:<number or money field id>} is their total, worked out on the device; the card holds up to two buttons, one that runs the record tool (e.g. createAll) and one that opens a page. Use it for "N subscriptions are waiting to be added to this month" with an "Add" and an "Edit" button; put showIf {table, has: "some", filter} on it so it only appears while something matches.',
  },
  example: {
    show: {
      title: 'This month',
      text: '{count} entries, {sum:amount} in total.',
      openLabel: 'Settings',
    },
    source: { table: 'expenses' },
    opens: 'settings',
  },
});

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
    /** Text can include {count} (number of matching records) and {sum:field} (sum of a numeric field for these records). */
    text: richText(400),
    icon: IconValueSchema.optional(),
    /** Label for the "action" button in the card (requires tools). */
    actionLabel: boundedText(1, 20).optional(),
    /** Label for the "open" button in the card (requires opens). */
    openLabel: boundedText(1, 20).optional(),
  }),
  /** Records referred to by the card: records in this table matching the filter. */
  source: z.strictObject({ table: IdSchema, filter: filterSchema(5).optional() }),
  /** An inline one-tap record tool executed when tapping the "action" button (like button blocks, prompts first, supports undo). */
  tools: z.array(ToolUseSchema).min(1).max(1).optional(),
  opens: openTargetSchema('opens must be a page, a system entry, tool:<id> or app:<id>', [
    'tool',
    'app',
  ]).optional(),
};

/**
 * Callout card (D-580): a card with the same background color and typography as "Tips",
 * describing records in a table that match criteria—{count} and {sum:field} in the text are
 * computed at render time from local records (not stored in config), with at most two buttons in
 * the card: one for one-tap records (tools) and one to open a page (opens). For example,
 * "Subscriptions pending confirmation this month: 3 items, total ¥371" + "Add to this month" +
 * "Edit". Appears only when records exist by configuring a showIf filter (D-579).
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

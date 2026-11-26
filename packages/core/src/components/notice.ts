import { z } from 'zod';

import { calloutTokens } from '../callout-text';
import { t } from '../messages';
import { hasRecordCurrency } from '../money-currency';
import { ToolUseSchema } from '../record-ops-schema';
import { boundedText, IconValueSchema, openTargetSchema, richText } from '../schema-base';
import { IdSchema, filterSchema } from '../schema-primitives';
import { ALL_STYLES, NUMERIC_FIELD_TYPES, type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({
    title: boundedText(1, 60).optional(),
    /** With source, the text can hold {count} (matching entries) and {sum:field} (their total of a number field), worked out when drawn. */
    text: richText(600),
    icon: IconValueSchema.optional(),
    /** Label of the button that runs the record tool (needs tools). */
    actionLabel: boundedText(1, 20).optional(),
    /** Label of the button that opens something (needs opens). */
    openLabel: boundedText(1, 20).optional(),
  }),
  /** The entries the card is about (D-580): the entries of this table that match the filter. */
  source: z.strictObject({ table: IdSchema, filter: filterSchema(5).optional() }).optional(),
  /** A one-tap record tool run by the card's action button (asks first like a button block, can be undone). */
  tools: z.array(ToolUseSchema).min(1).max(1).optional(),
  opens: openTargetSchema('opens must be a page, a system entry, tool:<id> or app:<id>', [
    'tool',
    'app',
  ]).optional(),
};

/**
 * Notice: a tinted card with text. With source it is about some entries of a table (the former
 * callout look, D-580; merged by D-655): {count} and
 * {sum:field} in the text are worked out from the entries on the device (never stored in the
 * config), and the card holds up to two buttons, one for a record tool and one that opens a page.
 */
export const noticeComponent: LookDefinitionOf<'notice', typeof shape> = defineLook({
  look: 'notice',
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
    const tokens = calloutTokens(c.show.text);
    if (!c.source && tokens.length > 0)
      problems.push('show.text: {count} and {sum:…} need source {table, filter?}');
    if (!c.source && c.tools) problems.push('tools need source {table, filter?}');
    for (const token of tokens) {
      if (token.kind !== 'sum' || !c.source) continue;
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
  describe: (c, _config, ctx) =>
    c.source && c.show.title
      ? t(ctx.locale, 'describeCallout', { v0: c.show.title })
      : t(ctx.locale, 'describe_notice_f50d5'),
  edit: {
    text: [
      { prop: 'title', max: 60, optional: true },
      { prop: 'text', max: 600, multiline: true, rich: true },
    ],
    style: ALL_STYLES,
    backdrop: true,
  },
  ai: {
    doc: 'show {title?, text, icon?, actionLabel?, openLabel?}, source? {table, filter?}, tools? [one record tool, needs source and actionLabel], opens? (needs openLabel): a tinted card; text is rich text, up to 600 characters. With source it is about the entries of that table that match the filter: in text, {count} is how many match and {sum:<number or money field id>} is their total, worked out on the device; the card holds up to two buttons, one that runs the record tool (e.g. createAll) and one that opens a page. Use that for "N subscriptions are waiting to be added to this month" with an "Add" and an "Edit" button; put showIf {table, has: "some", filter} on it so it only appears while something matches.',
  },
  example: { show: { title: 'Tip', text: 'Long-press to edit.', icon: 'lightbulb' } },
});

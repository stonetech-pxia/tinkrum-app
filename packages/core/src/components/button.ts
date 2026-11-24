import { z } from 'zod';

import { t } from '../messages';
import { ToolUseSchema } from '../record-ops-schema';
import { boundedText, IconValueSchema, openTargetSchema } from '../schema-base';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({
    label: boundedText(1, 40),
    variant: z.enum(['filled', 'outline', 'text', 'icon', 'row']),
    icon: IconValueSchema.optional(),
  }),
  /** An inline one-tap record tool (D-300, formerly action): mutually exclusive with opens, modifies records locally on tap (no undo banner shown, D-385). */
  tools: z.array(ToolUseSchema).min(1).max(1).optional(),
  opens: openTargetSchema('opens must be a page, a system entry, tool:<id> or app:<id>', [
    'tool',
    'app',
  ]).optional(),
};

/**
 * Button: tap to open a page, system entry point, or quick action (opens), or execute an inline
 * one-tap record tool (tools, D-300). Icon displays before text; variant icon shows only a
 * circular icon, leaving text for screen readers (D-230); variant row renders as a full row like
 * settings pages (D-483, opens-only).
 */
export const buttonComponent: LookDefinitionOf<'button', typeof shape> = defineLook({
  look: 'button',
  shape,
  kind: 'container',
  layer: 'record',
  reads: 'none',
  writes: true,
  tools: { as: ['self'], do: ['create', 'setAll', 'createAll'], max: 1 },
  refs: { opens: { to: 'target' } },
  check: (c, ctx) => {
    const problems = [];
    if (c.show.variant === 'icon' && !c.show.icon)
      problems.push({
        code: 'schema',
        message: `icon button ${c.id} on page ${ctx.page.id} needs an icon`,
      });
    if (c.show.variant === 'row' && c.tools)
      problems.push(`a row button ${c.id} on page ${ctx.page.id} opens something, it has no tool`);
    if (c.tools && c.opens !== undefined)
      problems.push(`a button either opens something or has a tool, not both`);
    return problems;
  },
  describe: (c, _config, ctx) => t(ctx.locale, 'describe_button_d79ee', { v0: c.show.label }),
  edit: { text: [{ prop: 'label', max: 40 }], style: ['align'] },
  ai: {
    doc: 'show {label, variant: "filled"|"outline"|"text"|"icon"|"row", icon?}, opens? (a page, a system entry or "tool:<id>") or tools? [one record tool]: icon shows before the label; variant "icon" shows only a round icon (needs icon; the label is still read by screen readers); variant "row" shows a full-width row like the Settings buttons (icon, label, arrow; only with opens, not with tools). opens "tool:<id>" (a quick action in tools[] or a built-in preset id) shows that quick action and the user taps Start; it never runs by itself. Instead of opens, tools: [{do: "create", table, values?, ask?: "all"}] or [{do: "setAll", table, filter?, field, value}] changes entries when tapped (rule 44); or [{do: "createAll", table, from, filter?, values}] creates one entry in table for each matching entry of from (rule 63).',
  },
  example: { show: { label: 'Settings', variant: 'filled' }, opens: 'settings' },
});

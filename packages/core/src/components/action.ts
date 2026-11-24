import { z } from 'zod';

import { t } from '../messages';
import { ToolUseSchema } from '../record-ops-schema';
// Type-only import: importing values from '../schema' would cause a circular dependency (schema → components → action → schema), leaving PageSchema blocks as undefined.
import type { QuickAction } from '../schema';
import { findWorkflowTarget } from '../workflows/presets';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  /**
   * card = card with a "Run" button, row = single row with ▶ on the right, tile = grid tile;
   * automatically selected by position when omitted (D-230). icon = white-background button with
   * icon only, executes immediately on tap (D-449, "Scan" on the new user home screen).
   */
  show: z.strictObject({ shape: z.enum(['card', 'row', 'tile', 'icon']).optional() }).optional(),
  /** A quick action: items in tools[], or preset ID for built-in quick actions (D-236, D-259, no addition needed). */
  tools: z.array(ToolUseSchema).min(1).max(1),
};

/** Displays a quick action block (formerly workflowRunner): tap to run (user-triggered). */
export const actionComponent: LookDefinitionOf<'action', typeof shape> = defineLook({
  look: 'action',
  shape,
  kind: 'container',
  reads: 'none',
  writes: false,
  tools: { as: ['self'], ref: ['quickAction'], max: 1 },
  describe: (c, config, ctx) => {
    const use = c.tools[0]!;
    const id = 'tool' in use ? use.tool : '';
    const wf = findWorkflowTarget(
      config.tools.filter((x): x is QuickAction => x.kind === 'quickAction'),
      id,
      ctx.locale,
    );
    return t(ctx.locale, 'describe_quick_action_1fb38', { v0: wf?.name ?? id });
  },
  edit: { text: [], style: [], backdrop: true },
  ai: {
    doc: 'show? {shape?: "card"|"row"|"tile"}, tools: [{tool: <quick action id>}]: runs a quick action; the id may also be a preset id (the built-in quick action, nothing to add; once the user changes it, their copy runs). card = steps and a Run button, row = one line with a play icon on the right, tile = a small square (side by side two per row). Without shape: tile when it sits next to other action blocks or in a grid/row group, card otherwise.',
  },
  example: { tools: [{ tool: 'pdf-merge' }] },
});

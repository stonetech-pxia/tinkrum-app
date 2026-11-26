import { z } from 'zod';

import { t } from '../messages';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({
    size: z.enum(['small', 'medium', 'large']),
    /** Draws a thin line across the middle of the space (the former divider look, D-new-kernel-available-resources-3ffb5b-1). */
    line: z.literal(true).optional(),
  }),
};

/** Empty space between blocks, optionally with a thin line through it. */
export const spacerComponent: LookDefinitionOf<'spacer', typeof shape> = defineLook({
  look: 'spacer',
  shape,
  kind: 'container',
  reads: 'none',
  writes: false,
  describe: (c, _config, ctx) =>
    t(ctx.locale, c.show.line ? 'describe_divider_7fe10' : 'describe_spacer_9a646'),
  edit: { text: [], style: [] },
  ai: {
    doc: 'show {size: "small"|"medium"|"large", line?: true}: empty space between blocks; line: true draws a thin line across it (a divider)',
  },
  example: { show: { size: 'medium' } },
});

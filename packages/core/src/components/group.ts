import { z } from 'zod';

import { t } from '../messages';
import { boundedText } from '../schema-base';
import { type LookDefinitionOf, defineLook, lookSchema } from './define';
import { LeafComponentSchema } from './leaves';

/** Maximum number of child blocks allowed in a group. */
export const GROUP_MAX_CHILDREN = 12;

const show = z.strictObject({
  title: boundedText(1, 60).optional(),
  layout: z.enum(['stack', 'row', 'grid']),
  columns: z.union([z.literal(2), z.literal(3)]).optional(),
  /**
   * Collapsible (D-578): title becomes a tappable header that collapses or expands on tap; value
   * represents the initial state. Visual-only, collapse state is not persisted (invariant 15).
   * Requires a title; no title means nothing is tappable.
   */
  fold: z.enum(['open', 'closed']).optional(),
});

/** Inner group level inside a group (Q3: allows one more level; nested groups cannot contain further groups). */
export const InnerGroupSchema = lookSchema('group', {
  show,
  children: z.array(LeafComponentSchema).max(GROUP_MAX_CHILDREN),
});

/** Group child blocks: blocks that can be placed inside groups, or a nested group level. */
export const GroupChildSchema = z.discriminatedUnion('look', [
  ...LeafComponentSchema.options,
  InnerGroupSchema,
]);

const shape = { show, children: z.array(GroupChildSchema).max(GROUP_MAX_CHILDREN) };

/** Group: arranges blocks in a vertical, horizontal, or grid layout (layout nesting, D-369 Q3). Groups can contain one nested group level. */
export const groupComponent: LookDefinitionOf<'group', typeof shape> = defineLook({
  look: 'group',
  shape,
  kind: 'container',
  reads: 'none',
  writes: false,
  check: (c) =>
    c.show.fold !== undefined && !c.show.title
      ? [`group ${c.id}: show.fold needs a show.title to tap`]
      : [],
  describe: (c, _config, ctx) => {
    const layout = {
      stack: t(ctx.locale, 'describe_stacked_00ce0'),
      row: t(ctx.locale, 'describe_row_be7f8'),
      grid: t(ctx.locale, 'describe_grid_3f0e7'),
    }[c.show.layout];
    const name = c.show.title ? t(ctx.locale, 'describe__5caf2', { v0: c.show.title }) : '';
    return t(ctx.locale, 'describe_group_86cab', { v0: layout, v1: name });
  },
  edit: { text: [{ prop: 'title', max: 60, optional: true }], style: ['tone', 'align'] },
  ai: {
    doc: 'show {title?, layout: "stack"|"row"|"grid", columns?: 2|3, fold?: "open"|"closed"} with children: [block] (max 12). A group may hold one more group (e.g. a card with two numbers side by side and a button below), but that inner group cannot hold another group. Use it to put things side by side (row) or in a grid. fold (needs a title): the title becomes a header the user taps to fold or unfold what is inside, and the value is how it starts ("closed" for a long list that should stay out of the way).',
  },
  example: { show: { layout: 'row' }, children: [] },
});

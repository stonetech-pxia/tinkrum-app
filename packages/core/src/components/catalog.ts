import { z } from 'zod';

import { localize } from '../localization';
import { t } from '../messages';
import { QUICK_ACTION_CATEGORIES, QUICK_ACTION_KINDS } from '../quick-actions';
import { boundedText, IdSchema } from '../schema-base';
import { duplicates, type LookDefinitionOf, defineLook } from './define';

/**
 * What a catalog block lists (D-new-kernel-available-resources-3ffb5b-1 merged the looks library,
 * packages and apps into this one): the kernel keeps the list, the config only says which one.
 * - quickActions: the quick-action library (mine + presets + those of tools; run, edit and
 *   "+ Add" are kernel tools and do not enter the config); kind narrows it to one category;
 *   recent (D-452) reads run history and shows a row of small capsules, ignoring kind.
 * - packages: tool icons (D-181); a tap on a tool that is not added yet adds it first, then opens
 *   it. Without ids = every catalog tool no other packages grid on the same page lists.
 * - apps: the user's apps (nav.apps, D-644); which ones are listed does not enter the config.
 */
export const CatalogSourceSchema = z.discriminatedUnion('catalog', [
  z.strictObject({
    catalog: z.literal('quickActions'),
    kind: z.enum(QUICK_ACTION_KINDS).optional(),
    recent: z.literal(true).optional(),
  }),
  z.strictObject({
    catalog: z.literal('packages'),
    ids: z.array(IdSchema).min(1).max(30).optional(),
  }),
  z.strictObject({ catalog: z.literal('apps') }),
]);
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

const shape = {
  show: z.strictObject({ title: boundedText(1, 60).optional() }).optional(),
  source: CatalogSourceSchema,
};

const TITLE = [{ prop: 'title', max: 60, optional: true }];

export const catalogComponent: LookDefinitionOf<'catalog', typeof shape> = defineLook({
  look: 'catalog',
  shape,
  kind: 'container',
  layer: 'config',
  reads: 'catalog',
  writes: false,
  refs: { 'source.ids': { to: 'package', in: 'catalog' } },
  check: (c, { page }) => {
    if (c.source.catalog === 'packages')
      return duplicates(c.source.ids ?? []).map((toolId) => ({
        code: 'duplicate',
        message: `tool ${toolId} in component ${c.id}`,
      }));
    if (c.source.catalog === 'apps' && page.app !== undefined)
      return [
        `catalog ${c.id}: the app list belongs on a page outside any app (page ${page.id} has "app")`,
      ];
    return [];
  },
  describe: (c, _config, ctx) => {
    const title = c.show?.title;
    switch (c.source.catalog) {
      case 'packages':
        return title
          ? t(ctx.locale, 'describe_tool_grid_e987a', { v0: title })
          : t(ctx.locale, 'describe_tool_grid_1c74f');
      case 'apps':
        return title
          ? t(ctx.locale, 'describe_app_list_titled', { v0: title })
          : t(ctx.locale, 'describe_app_list');
      default:
        return c.source.recent
          ? t(ctx.locale, 'describe_recent_quick_actions')
          : c.source.kind
            ? t(ctx.locale, 'describe_quick_action_list_kind', {
                v0:
                  localize(QUICK_ACTION_CATEGORIES[c.source.kind].name, ctx.locale) ??
                  c.source.kind,
              })
            : t(ctx.locale, 'describe_quick_action_list');
    }
  },
  edit: { text: TITLE, style: ['align'] },
  // Only the tool grid draws its title by style.align.
  editOf: (c) => ({ text: TITLE, style: c.source.catalog === 'packages' ? ['align'] : [] }),
  ai: {
    doc: 'show? {title?}, source: one of the kernel\'s own lists, which you place and title but never fill. {catalog: "quickActions", kind?: "image"|"video"|"audio"|"document"|"other"}: the quick-action library; without kind the category entries (Photos, Videos, Audio, Documents, Other), with kind that category\'s own quick actions (run, edit), the ready-made ones (add) and those from tools. For "put the photo quick actions on home" add one with kind "image"; for "show what Tinkrum can do on the home page" add one without kind. {catalog: "packages", ids?}: tool icons, three per row; tapping one opens the tool (a tool that isn\'t added yet is added first, shown faded with a "+"). ids lists catalog tool ids in order; without ids the grid shows every catalog tool that no other packages grid on the same page lists (a catch-all "more tools" grid that disappears when it is empty). To move a tool from one grid to another, change both blocks\' source.ids with updateContainer. A new topic on a toolbox ("a group for my favourite tools") is one more packages grid with its own show.title, at the top level of the page like the other grids, not wrapped in a group block. {catalog: "apps"} (only on pages outside any app): the user\'s apps as icons, four per row, like a phone\'s home screen; tapping one opens it. It lists every app in nav.apps by itself (new, imported and removed apps follow), so a home page with it needs no button per app.',
  },
  example: { show: { title: 'Documents' }, source: { catalog: 'packages', ids: ['pdf', 'image'] } },
});

/** Which kernel list a block shows, or null when it is not a catalog block. */
export const catalogOf = (c: {
  look: unknown;
  source?: unknown;
}): CatalogSource['catalog'] | null =>
  c.look === 'catalog' ? (c.source as CatalogSource).catalog : null;

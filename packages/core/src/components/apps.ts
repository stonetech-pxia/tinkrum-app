import { z } from 'zod';

import { t } from '../messages';
import { boundedText } from '../schema-base';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({ title: boundedText(1, 60).optional() }).optional(),
  /** Read the user's apps (nav.apps); which ones are listed does not enter the config. */
  source: z.strictObject({ catalog: z.literal('apps') }),
};

/**
 * App list (D-new-apphome-1): the user's apps as icons, like a phone's home screen. Lives on pages
 * outside any app: inside an app nothing may open or point at another app (D-485).
 */
export const appsComponent: LookDefinitionOf<'apps', typeof shape> = defineLook({
  look: 'apps',
  shape,
  kind: 'container',
  layer: 'config',
  reads: 'catalog',
  writes: false,
  check: (c, { page }) =>
    page.app === undefined
      ? []
      : [
          `apps ${c.id}: the app list belongs on a page outside any app (page ${page.id} has "app")`,
        ],
  describe: (c, _config, ctx) =>
    c.show?.title
      ? t(ctx.locale, 'describe_app_list_titled', { v0: c.show.title })
      : t(ctx.locale, 'describe_app_list'),
  edit: { text: [{ prop: 'title', max: 60, optional: true }], style: [] },
  ai: {
    outsideApps: true,
    doc: 'show? {title?}, source {catalog: "apps"}: the user\'s apps as icons, four per row, like a phone\'s home screen; tapping one opens it. It lists every app in nav.apps by itself (new, imported and removed apps follow), so a home page with this block needs no entry block per app. Only on pages outside any app.',
  },
  example: { source: { catalog: 'apps' } },
});

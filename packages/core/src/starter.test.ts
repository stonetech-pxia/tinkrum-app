import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from './defaults';
import { describeChange } from './describe';
import { homeScreenItems } from './home-screen';
import type { Op } from './ops-schema';
import {
  allComponents,
  catalogOf,
  isKnownComponent,
  quickActionsOf,
  toolGridToolIds,
  type ComponentOf,
  type Locale,
  type WorkspaceConfig,
} from './schema';
import { STARTER_THEME } from './theme';
import { findWorkflowTarget, presetById, presetWorkflow } from './workflows/presets';
import { prepareOps } from './change';
import { STARTER_TOOL_IDS, createStarterWorkspace, paperAppOps } from './starter';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

const catalog = [...registry.tools.keys()];

const ok = (config: WorkspaceConfig, ops: Op[], locale: Locale = 'en') => {
  const result = prepareOps(config, ops, { registry, locale, now: new Date(0) });
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.after;
};
/** A new user after guide step 1: the starter plus the Paper app. */
const withPaper = (locale: Locale = 'en') => {
  const start = createStarterWorkspace(locale, registry);
  return ok(start, paperAppOps(start, locale, registry), locale);
};
const pageOf = (config: WorkspaceConfig, id: string) =>
  config.containers.pages.find((p) => p.id === id)!;

describe('createStarterWorkspace', () => {
  // D-644: the home page is the list of apps and nothing else, empty until the guide builds one.
  it.each(['zh', 'en', 'fr'] as const)(
    'installs the starter tools, a three-item bar and a home page that lists the apps (%s)',
    (locale) => {
      const config = createStarterWorkspace(locale, registry);
      expect(validateWorkspace(config, registry).ok).toBe(true);
      expect(config.packages.map((t) => t.id)).toEqual([...STARTER_TOOL_IDS]);
      expect(config.nav.bar).toEqual(['page:home', 'ai', 'settings']);
      expect(config.nav.apps).toBeUndefined();
      // No title, tool card, toolbox or file entry is on the home page: only the icons.
      expect(pageOf(config, 'home').blocks).toEqual([
        { id: 'apps', look: 'catalog', source: { catalog: 'apps' } },
      ]);
      expect(config.containers.pages.filter((p) => !p.package).map((p) => p.id)).toEqual(['home']);
      expect(quickActionsOf(config).filter((w) => !w.package)).toEqual([]);
    },
  );

  it.each(['zh', 'en'] as const)('a v33 starter still opens (%s, invariant 12)', (locale) => {
    expect(validateWorkspace(fromV33(v33Fixture(`starter-${locale}`)), registry).ok).toBe(true);
    expect(validateWorkspace(fromV33(v33Fixture('starter-files-zh')), registry).ok).toBe(true);
  });

  // D-487: The default theme builds upon Clay: clay cards, subtle warm gradients, and light-themed colored icons; primary colors and fonts remain unchanged.
  it('uses the refined Clay theme by default', () => {
    const { theme } = createStarterWorkspace('en', registry);
    expect(theme).toEqual(STARTER_THEME);
    expect(theme).toMatchObject({
      primaryColor: '#C8623A',
      font: 'clay',
      cardStyle: 'puffy',
      backdrop: 'gradient',
      iconStyle: 'tint',
    });
  });
});

// D-645: the former default home page (D-487) is an app of its own, built by the guide.
describe('paperAppOps', () => {
  it.each(['zh', 'en', 'fr'] as const)(
    'builds the Paper app in the interface language (%s)',
    (locale) => {
      const config = withPaper(locale);
      expect(config.nav.apps).toEqual([
        {
          id: 'paper',
          name: 'Paper',
          icon: 'my:tinkrum-paper',
          bar: ['page:paper-home', 'page:paper-files', 'page:paper-toolbox', 'ai'],
          // Tinkrum's red, like its own icon; the Clay look on a plain backdrop (D-552).
          theme: { ...STARTER_THEME, primaryColor: '#D92D20', backdrop: 'plain' },
        },
      ]);
      // The icon is drawn in the config (D-625).
      expect(config.icons!['tinkrum-paper']!.paths.length).toBeGreaterThan(0);
      for (const id of ['paper-home', 'paper-files', 'paper-toolbox'])
        expect(pageOf(config, id).app).toBe('paper');
      // The home page lists the app by itself: no entry block is added to it.
      expect(pageOf(config, 'home')).toEqual(
        pageOf(createStarterWorkspace(locale, registry), 'home'),
      );
    },
  );

  // D-647: long-pressing the Tinkrum icon on the phone offers the app right away.
  it('puts the app into the menu of the Tinkrum icon on the phone', () => {
    const config = withPaper('en');
    expect(config.nav.phoneHomeScreen).toEqual(['app:paper']);
    expect(homeScreenItems(config)).toMatchObject([
      { id: 'app:paper', title: 'Paper', colors: { background: '#D92D20' } },
    ]);
  });

  it('leaves a full menu as it is', () => {
    const start = createStarterWorkspace('en', registry);
    // Four quick actions fill the menu.
    const presets = ['visa-photo', 'scan-document', 'email-photos', 'combine-documents'];
    const full = ok(start, [
      ...presets.map((id): Op => ({
        op: 'addTool',
        tool: presetWorkflow(presetById(id)!, 'en', id),
      })),
      { op: 'updateContainer', nav: { phoneHomeScreen: presets } },
    ]);
    const config = ok(full, paperAppOps(full, 'en', registry));
    expect(config.nav.phoneHomeScreen).toEqual(presets);
    expect(config.nav.apps!.map((a) => a.id)).toEqual(['paper']);
  });

  // D-487: The first page explains the product, followed by four built-in quick action tiles (scan
  // to PDF / Word / Excel, merge files), and below them the primary-colored "Open files" button,
  // recent operations, and recent files.
  it('puts a header, the four marquee quick actions and an Open files button on its first page', () => {
    const config = withPaper('en');
    const home = pageOf(config, 'paper-home');
    expect(home.blocks[0]).toMatchObject({
      look: 'header',
      show: { title: 'Paper', subtitle: 'Paper in. Clean PDF, Word or Excel out.' },
    });
    expect(home.blocks[1]).toMatchObject({ look: 'group', show: { layout: 'grid', columns: 2 } });
    const children = (home.blocks[1] as ComponentOf<'group'>).children as ComponentOf<'button'>[];
    expect(children).toMatchObject([
      { look: 'button', show: { shape: 'tile' }, tools: [{ tool: 'scan-camera' }] },
      { look: 'button', show: { shape: 'tile' }, tools: [{ tool: 'scan-doc-word' }] },
      { look: 'button', show: { shape: 'tile' }, tools: [{ tool: 'scan-table-excel' }] },
      { look: 'button', show: { shape: 'tile' }, tools: [{ tool: 'combine-documents' }] },
    ]);
    // Each tile is a built-in preset, ready to be tapped without being added first, and (D-552) the
    // four icons are distinct for quick visual differentiation.
    const icons = children.map((c) => {
      const use = c.tools![0] as { tool: string };
      const wf = findWorkflowTarget(quickActionsOf(config), use.tool, 'en')!;
      expect(wf, use.tool).toBeTruthy();
      return wf.icon ?? (wf.package && registry.tools.get(wf.package)?.icon);
    });
    expect(new Set(icons).size).toBe(4);
    expect(home.blocks[2]).toMatchObject({ look: 'button', tools: [{ tool: '$pick.open' }] });
    // Shape is unspecified: A full-width primary-colored button row, rather than a small icon-only block.
    expect((home.blocks[2] as ComponentOf<'button'>).show).toBeUndefined();
    // D-452: Finally, recent operations (reading run logs) and the 3 most recent files.
    expect(home.blocks.slice(3)).toMatchObject([
      {
        look: 'catalog',
        show: { title: 'Recent actions' },
        source: { catalog: 'quickActions', recent: true },
      },
      { look: 'files', show: { title: 'Recent files' }, source: { table: '$files', limit: 3 } },
    ]);
  });

  it('leaves out a scan tile when the scan tool is not installed', () => {
    const start = createStarterWorkspace('en', registry);
    const without = ok(start, [{ op: 'setPackage', package: 'scan', do: 'remove' }]);
    const config = ok(without, paperAppOps(without, 'en', registry));
    const group = pageOf(config, 'paper-home').blocks.find(
      (b) => b.look === 'group',
    ) as ComponentOf<'group'>;
    expect(group.children).toMatchObject([{ tools: [{ tool: 'combine-documents' }] }]);
  });

  it('does nothing when the Paper app is already there', () => {
    expect(paperAppOps(withPaper('zh'), 'zh', registry)).toEqual([]);
  });

  // Replaying the guide on a home page that does not list apps (an existing user): the app gets an entry.
  it('adds an entry on a home page without an app list', () => {
    const start = createDefaultWorkspace('en');
    const config = ok(start, paperAppOps(start, 'en', registry));
    expect(pageOf(config, 'home').blocks.at(-1)).toMatchObject({
      look: 'button',
      opens: 'app:paper',
    });
  });

  it('its toolbox shows every tool in the catalog exactly once', () => {
    const toolbox = pageOf(withPaper('zh'), 'paper-toolbox');
    const shown = allComponents(toolbox).flatMap((c) =>
      isKnownComponent(c) && c.look === 'catalog' && c.source.catalog === 'packages'
        ? toolGridToolIds(c.source, toolbox, catalog)
        : [],
    );
    expect([...shown].sort()).toEqual([...catalog].sort());
  });

  it('adding a tool its toolbox already shows does not add a home card', () => {
    const config = ok(withPaper('zh'), [{ op: 'setPackage', package: 'zip', do: 'add' }], 'zh');
    expect(
      allComponents(pageOf(config, 'home')).some((c) => isKnownComponent(c) && c.look === 'button'),
    ).toBe(false);
    expect(config.packages.some((t) => t.id === 'zip')).toBe(true);
  });

  it('describes adding a tool the toolbox shows without a home card', () => {
    const lines = describeChange(
      [{ op: 'setPackage', package: 'zip', do: 'add' }],
      withPaper('zh'),
      [],
      { registry, locale: 'zh', now: new Date() },
    );
    expect(lines.join('\n')).not.toContain('首页入口');
  });

  it('rejects tool grids with unknown or repeated tools', () => {
    const config = withPaper('zh');
    const grid = pageOf(config, 'paper-toolbox').blocks.find(
      (c): c is ComponentOf<'catalog'> => catalogOf(c) === 'packages',
    )!;
    if (grid.source.catalog !== 'packages') throw new Error('not a packages grid');
    grid.source.ids = ['image', 'image', 'nope'];
    const result = validateWorkspace(config, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code).sort()).toEqual(['duplicate', 'unknown-tool']);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { describeChange } from './describe';
import { applyOps } from './ops';
import {
  allComponents,
  isKnownComponent,
  quickActionsOf,
  toolGridToolIds,
  type ComponentOf,
} from './schema';
import { DEFAULT_THEME, STARTER_THEME } from './theme';
import { findWorkflowTarget } from './workflows/presets';
import { STARTER_TOOL_IDS, createStarterWorkspace, homeFileEntryOps } from './starter';
import { fromV33, registry, v33Fixture, withScanKeep } from './test-helpers';
import { validateWorkspace } from './validate';

const catalog = [...registry.tools.keys()];

describe('createStarterWorkspace', () => {
  it.each(['zh', 'en', 'fr'] as const)(
    'installs the starter tools, a three-item bar and an empty home page (%s)',
    (locale) => {
      const config = createStarterWorkspace(locale, registry);
      expect(validateWorkspace(config, registry).ok).toBe(true);
      expect(config.packages.map((t) => t.id)).toEqual([...STARTER_TOOL_IDS]);
      expect(config.nav.bar).toEqual(['page:home', 'ai', 'settings']);
      const home = config.containers.pages.find((p) => p.id === 'home')!;
      // Home screen starts blank, step 1 of the guide adds the file entry point (D-231); does not preinstall user quick actions.
      expect(home.blocks).toEqual([]);
      expect(quickActionsOf(config).filter((w) => !w.package)).toEqual([]);
    },
  );

  // D-487 only changes the default theme; everything else remains migrated from the v33 starter configuration (Invariant 12).
  it.each(['zh', 'en'] as const)(
    'is the v33 starter, migrated, except the D-487 theme (%s)',
    (locale) => {
      const { theme, ...rest } = createStarterWorkspace(locale, registry);
      const { theme: oldTheme, ...oldRest } = withScanKeep(
        fromV33(v33Fixture(`starter-${locale}`)),
      );
      expect(rest).toEqual(oldRest);
      expect(theme).toEqual(STARTER_THEME);
      expect(oldTheme).toEqual(DEFAULT_THEME);
    },
  );

  // D-487: The default theme builds upon Clay: clay cards, subtle warm gradients, and light-themed colored icons; primary colors and fonts remain unchanged.
  it('uses the refined Clay theme by default', () => {
    const { theme } = createStarterWorkspace('en', registry);
    expect(theme).toMatchObject({
      primaryColor: '#C8623A',
      font: 'clay',
      cardStyle: 'puffy',
      backdrop: 'gradient',
      iconStyle: 'tint',
    });
    expect(validateWorkspace(createStarterWorkspace('en', registry), registry).ok).toBe(true);
  });

  // D-487: The home screen first explains the product, followed by four built-in quick action tiles
  // (scan to PDF / Word / Excel, merge files), and below them the primary-colored "Open files"
  // button, toolbox entry, recent operations, and recent files.
  it('puts a header, the four marquee quick actions and an Open files button on the home page', () => {
    const config = createStarterWorkspace('en', registry);
    const result = applyOps(config, homeFileEntryOps(config, 'en'), { registry, locale: 'en' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateWorkspace(result.config, registry).ok).toBe(true);
    const home = result.config.containers.pages.find((p) => p.id === 'home')!;
    expect(home.blocks[0]).toMatchObject({
      look: 'header',
      show: { title: 'Tinkrum', subtitle: 'Paper in. Clean PDF, Word or Excel out.' },
    });
    expect(home.blocks[1]).toMatchObject({ look: 'group', show: { layout: 'grid', columns: 2 } });
    expect((home.blocks[1] as ComponentOf<'group'>).children).toMatchObject([
      { look: 'action', show: { shape: 'tile' }, tools: [{ tool: 'scan-camera' }] },
      { look: 'action', show: { shape: 'tile' }, tools: [{ tool: 'scan-doc-word' }] },
      { look: 'action', show: { shape: 'tile' }, tools: [{ tool: 'scan-table-excel' }] },
      { look: 'action', show: { shape: 'tile' }, tools: [{ tool: 'combine-documents' }] },
    ]);
    // Each quick action in every tile is a built-in preset, ready to be tapped without needing to be added first.
    for (const c of (home.blocks[1] as ComponentOf<'group'>).children) {
      const use = (c as ComponentOf<'action'>).tools[0]!;
      expect(
        'tool' in use && findWorkflowTarget(quickActionsOf(result.config), use.tool, 'en'),
      ).toBeTruthy();
    }
    // D-552: The four tile icons are distinct (PDF, Word, Excel, merge) for quick visual differentiation; icon retrieval matches tile rendering.
    const icons = (home.blocks[1] as ComponentOf<'group'>).children.map((c) => {
      const use = (c as ComponentOf<'action'>).tools[0]!;
      const wf = findWorkflowTarget(
        quickActionsOf(result.config),
        (use as { tool: string }).tool,
        'en',
      )!;
      return wf.icon ?? (wf.package && registry.tools.get(wf.package)?.icon);
    });
    expect(new Set(icons).size).toBe(4);
    expect(home.blocks[2]).toMatchObject({ look: 'picker', tools: [{ tool: '$pick.open' }] });
    // Shape is unspecified: A full-width primary-colored button row, rather than a small icon-only block.
    expect((home.blocks[2] as ComponentOf<'picker'>).show).toBeUndefined();
    // D-452: Finally, recent operations (reading run logs) and the 3 most recent files.
    expect(home.blocks.slice(4)).toMatchObject([
      { look: 'library', show: { title: 'Recent actions' }, source: { recent: true } },
      { look: 'files', show: { title: 'Recent files' }, source: { table: '$files', limit: 3 } },
    ]);
    expect(homeFileEntryOps(result.config, 'en')).toEqual([]);
  });

  it('leaves out a scan tile when the scan tool is not installed', () => {
    const config = { ...createStarterWorkspace('en', registry) };
    config.packages = config.packages.filter((p) => p.id !== 'scan');
    const result = applyOps(config, homeFileEntryOps(config, 'en'), { registry, locale: 'en' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = result.config.containers.pages.find((p) => p.id === 'home')!;
    const group = home.blocks.find((b) => b.look === 'group') as ComponentOf<'group'>;
    expect(group.children).toMatchObject([{ tools: [{ tool: 'combine-documents' }] }]);
  });

  it('puts a Toolbox button right under the Open files button; it opens the toolbox page', () => {
    const config = createStarterWorkspace('zh', registry);
    const result = applyOps(config, homeFileEntryOps(config, 'zh'), { registry, locale: 'zh' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateWorkspace(result.config, registry).ok).toBe(true);
    const home = result.config.containers.pages.find((p) => p.id === 'home')!;
    expect(home.blocks[3]).toMatchObject({
      look: 'button',
      show: { label: '工具箱', icon: 'apps' },
      opens: 'page:toolbox',
    });
    expect(home.blocks[4]).toMatchObject({ look: 'library' });
  });

  it('the old two pickers from v33 still load (photo library and files)', () => {
    const old = fromV33(v33Fixture('starter-files-zh'));
    expect(validateWorkspace(old, registry).ok).toBe(true);
    expect(homeFileEntryOps(old, 'zh')).toEqual([]);
  });

  it('the toolbox shows every tool in the catalog exactly once', () => {
    const config = createStarterWorkspace('zh', registry);
    const toolbox = config.containers.pages.find((p) => p.id === 'toolbox')!;
    const shown = allComponents(toolbox).flatMap((c) =>
      isKnownComponent(c) && c.look === 'packages' ? toolGridToolIds(c, toolbox, catalog) : [],
    );
    expect([...shown].sort()).toEqual([...catalog].sort());
  });

  it('adding a tool the toolbox already shows does not add a home card', () => {
    const config = createStarterWorkspace('zh', registry);
    const result = applyOps(config, [{ op: 'setPackage', package: 'zip', do: 'add' }], {
      registry,
      locale: 'zh',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = result.config.containers.pages.find((p) => p.id === 'home')!;
    expect(allComponents(home).some((c) => isKnownComponent(c) && c.look === 'entry')).toBe(false);
    expect(result.config.packages.some((t) => t.id === 'zip')).toBe(true);
  });

  it('describes adding a tool the toolbox shows without a home card', () => {
    const config = createStarterWorkspace('zh', registry);
    const lines = describeChange([{ op: 'setPackage', package: 'zip', do: 'add' }], config, [], {
      registry,
      locale: 'zh',
      now: new Date(),
    });
    expect(lines.join('\n')).not.toContain('首页入口');
  });

  it('rejects tool grids with unknown or repeated tools', () => {
    const config = createStarterWorkspace('zh', registry);
    const toolbox = config.containers.pages.find((p) => p.id === 'toolbox')!;
    const grid = toolbox.blocks.find(
      (c): c is ComponentOf<'packages'> => isKnownComponent(c) && c.look === 'packages',
    )!;
    grid.source.ids = ['image', 'image', 'nope'];
    const result = validateWorkspace(config, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code).sort()).toEqual(['duplicate', 'unknown-tool']);
    }
  });
});

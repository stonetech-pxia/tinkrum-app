import { describe, expect, it } from 'vitest';

import { opsForApp } from './app-scope';
import { prepareOps, type ChangeContext } from './change';
import type { Op } from './ops';
import { applyOps } from './ops';
import { THEME_PRESETS } from './presets';
import { sampleOps } from './samples';
import type { WorkspaceConfig } from './schema';
import { createStarterWorkspace } from './starter';
import { registry } from './test-helpers';

// Modifications within an app (D-485, provisional rule): Restricted exclusively to the app's own items, rejecting any out-of-scope changes entirely; modifications without a scope (home) apply workspace-wide.

const ctx = (appId?: string): ChangeContext => ({
  registry,
  locale: 'en',
  now: new Date(2026, 10, 7),
  fromAI: true,
  ...(appId ? { scope: { appId } } : {}),
});

const text = (id: string) => ({ id, name: id, type: 'text' as const });
const table = (id: string, app?: string) => ({
  id,
  name: id,
  ...(app ? { app } : {}),
  fields: [text('title')],
});

/** Home + two apps (fit, cook); home has a shared table notes, and each app has its own table. */
function world(): WorkspaceConfig {
  const ops: Op[] = [
    { op: 'addContainer', app: { id: 'fit', name: 'Fitness' } },
    { op: 'addContainer', app: { id: 'cook', name: 'Cooking' } },
    { op: 'addData', table: table('notes') } as never,
    { op: 'addData', table: table('workouts', 'fit') } as never,
    { op: 'addData', table: table('recipes', 'cook') } as never,
    { op: 'addContainer', page: { id: 'fit-home', title: 'Today', app: 'fit', blocks: [] } },
    { op: 'addContainer', page: { id: 'cook-home', title: 'Menu', app: 'cook', blocks: [] } },
    { op: 'updateContainer', app: { id: 'fit', bar: ['page:fit-home', 'ai'] } },
    { op: 'updateContainer', app: { id: 'cook', bar: ['page:cook-home', 'ai'] } },
  ];
  const result = applyOps(createStarterWorkspace('en', registry), ops, { registry, locale: 'en' });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

const listOf = (id: string, tableId: string) => ({
  id,
  look: 'list',
  source: { table: tableId, limit: 10 },
  show: { title: 'title' },
});

const issuesOf = (config: WorkspaceConfig, ops: Op[], appId?: string) => {
  const result = prepareOps(config, ops, ctx(appId));
  return result.ok ? [] : result.issues;
};

describe('App scope (D-485)', () => {
  it('lets the app change its own pages, tables, bar and style', () => {
    const config = world();
    const result = prepareOps(
      config,
      [
        { op: 'addContainer', page: 'fit-home', block: listOf('w-list', 'workouts') as never },
        { op: 'updateData', table: 'workouts', changes: { name: 'Sessions' } },
        { op: 'setTheme', app: 'fit', primaryColor: '#2255aa' },
        { op: 'updateContainer', app: { id: 'fit', name: 'Gym' } },
      ],
      ctx('fit'),
    );
    expect(result.ok).toBe(true);
  });

  it('tags a new page, table and quick action with the app, and puts the page in its bar', () => {
    const config = world();
    const result = prepareOps(
      config,
      [
        { op: 'addData', table: table('plans') } as never,
        { op: 'addContainer', page: { id: 'fit-plan', title: 'Plan', blocks: [] } },
      ],
      ctx('fit'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.data.tables.find((t) => t.id === 'plans')!.app).toBe('fit');
    expect(result.after.containers.pages.find((p) => p.id === 'fit-plan')!.app).toBe('fit');
    expect(result.after.nav.apps!.find((a) => a.id === 'fit')!.bar).toEqual([
      'page:fit-home',
      'page:fit-plan',
      'ai',
    ]);
    // Home was neither populated with entry points nor modified.
    expect(result.after.containers.pages.find((p) => p.id === 'home')).toEqual(
      config.containers.pages.find((p) => p.id === 'home'),
    );
  });

  it('rejects changes to the home page, the home bar and the home style', () => {
    const config = world();
    const homeBlock = {
      id: 'hi',
      look: 'text',
      show: { text: 'hi' },
    } as never;
    expect(
      issuesOf(config, [{ op: 'addContainer', page: 'home', block: homeBlock }], 'fit'),
    ).not.toEqual([]);
    expect(
      issuesOf(config, [{ op: 'updateContainer', nav: { bar: ['page:home', 'settings'] } }], 'fit'),
    ).not.toEqual([]);
    expect(issuesOf(config, [{ op: 'setTheme', primaryColor: '#ff0000' }], 'fit')).not.toEqual([]);
    // The same operation modified from home is allowed.
    expect(issuesOf(config, [{ op: 'setTheme', primaryColor: '#ff0000' }])).toEqual([]);
  });

  it('rejects touching another app, even through a cascade', () => {
    const config = world();
    expect(
      issuesOf(config, [{ op: 'setTheme', app: 'cook', primaryColor: '#ff0000' }], 'fit'),
    ).not.toEqual([]);
    expect(issuesOf(config, [{ op: 'removeContainer', page: 'cook-home' }], 'fit')).not.toEqual([]);
    expect(
      issuesOf(config, [{ op: 'updateData', table: 'recipes', changes: { name: 'X' } }], 'fit'),
    ).not.toEqual([]);
    // Deleting a shared table still in use by others: cleans up dependent blocks on home and other apps, rejecting the entire change.
    const withUse = applyOps(
      config,
      [{ op: 'addContainer', page: 'home', block: listOf('n-list', 'notes') as never }],
      { registry, locale: 'en' },
    );
    if (!withUse.ok) throw new Error(withUse.error);
    expect(issuesOf(withUse.config, [{ op: 'removeData', table: 'notes' }], 'fit')).not.toEqual([]);
  });

  it('rejects removing itself or moving a thing to another app', () => {
    const config = world();
    expect(issuesOf(config, [{ op: 'removeContainer', app: 'fit' }], 'fit')).not.toEqual([]);
    expect(
      issuesOf(config, [{ op: 'addContainer', app: { id: 'extra', name: 'Extra' } }], 'fit'),
    ).not.toEqual([]);
    expect(
      issuesOf(
        config,
        [{ op: 'addContainer', page: { id: 'sneaky', title: 'S', app: 'cook', blocks: [] } }],
        'fit',
      ),
    ).not.toEqual([]);
  });

  it('only points at its own tables or the home tables', () => {
    const config = world();
    const own = issuesOf(
      config,
      [{ op: 'addContainer', page: 'fit-home', block: listOf('a', 'workouts') as never }],
      'fit',
    );
    const home = issuesOf(
      config,
      [{ op: 'addContainer', page: 'fit-home', block: listOf('b', 'notes') as never }],
      'fit',
    );
    const other = issuesOf(
      config,
      [{ op: 'addContainer', page: 'fit-home', block: listOf('c', 'recipes') as never }],
      'fit',
    );
    expect(own).toEqual([]);
    expect(home).toEqual([]);
    expect(other).not.toEqual([]);
  });

  it('home (no scope) can still change everything, including other apps', () => {
    const config = world();
    expect(
      issuesOf(config, [
        { op: 'setTheme', app: 'cook', primaryColor: '#ff0000' },
        { op: 'removeContainer', app: 'fit' },
      ]),
    ).toEqual([]);
  });

  it('a new page made from home for an app gets a way in from that app bar', () => {
    const config = world();
    const result = prepareOps(
      config,
      [{ op: 'addContainer', page: { id: 'fit-log', title: 'Log', app: 'fit', blocks: [] } }],
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.after.nav.apps!.find((a) => a.id === 'fit')!.bar).toContain('page:fit-log');
  });

  // Founder encountered issues on 2026-11-08 where selecting "Choose style" inside a sub-app and
  // both preset sentences were blocked: built-in rule styles lacked an app specification (making
  // them home styles), and sample apps added entry points to the home bottom bar.
  it('inside an app, a style without "app" is this app\'s style', () => {
    const config = world();
    const ops = opsForApp([{ op: 'setTheme', preset: 'material' }], 'fit');
    const result = prepareOps(config, ops, ctx('fit'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.nav.apps!.find((a) => a.id === 'fit')!.theme).toEqual(
      THEME_PRESETS.material.theme,
    );
    expect(result.after.theme).toEqual(config.theme);
    // Changes targeting other apps continue to be rejected.
    expect(
      issuesOf(
        config,
        opsForApp([{ op: 'setTheme', app: 'cook', preset: 'material' }], 'fit'),
        'fit',
      ),
    ).not.toEqual([]);
  });

  it('writes the app into new pages, tables and quick actions, so replaying them without the scope keeps them in the app', () => {
    const config = world();
    const ops = opsForApp(
      [
        { op: 'addData', table: table('plans') } as never,
        { op: 'addContainer', page: { id: 'fit-plan', title: 'Plan', blocks: [] } },
      ],
      'fit',
    );
    // Draft reapplication runs without scope constraints (draft.ts rebaseDraft).
    const replayed = prepareOps(config, ops, ctx());
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.after.data.tables.find((t) => t.id === 'plans')!.app).toBe('fit');
    expect(replayed.after.containers.pages.find((p) => p.id === 'fit-plan')!.app).toBe('fit');
    expect(replayed.after.containers.pages.find((p) => p.id === 'home')).toEqual(
      config.containers.pages.find((p) => p.id === 'home'),
    );
  });

  it.each(['receipts', 'business-cards'] as const)(
    'the %s sample made inside an app belongs to the app and leaves the home alone',
    (sample) => {
      const config = world();
      const made = sampleOps(sample, config, 'en', 'fit');
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      const result = prepareOps(config, opsForApp(made.ops, 'fit'), ctx('fit'));
      expect(result.ok ? [] : result.issues).toEqual([]);
      if (!result.ok) return;
      const after = result.after;
      const isNew = <T extends { id: string }>(list: readonly T[], old: readonly T[]) =>
        list.filter((x) => !old.some((o) => o.id === x.id));
      const pages = isNew(after.containers.pages, config.containers.pages);
      const tables = isNew(after.data.tables, config.data.tables);
      const tools = isNew(after.tools, config.tools);
      expect(pages.length).toBeGreaterThan(0);
      expect(tables.length).toBeGreaterThan(0);
      expect(tools.length).toBeGreaterThan(0);
      for (const thing of [...pages, ...tables, ...tools]) expect(thing.app).toBe('fit');
      // Home page added to this app's bottom bar (before Tink); home bottom bar and home page remain untouched.
      expect(after.nav.apps!.find((a) => a.id === 'fit')!.bar).toEqual([
        'page:fit-home',
        `page:${made.mainPageId}`,
        'ai',
      ]);
      expect(after.nav.bar).toEqual(config.nav.bar);
      expect(after.containers.pages.find((p) => p.id === 'home')).toEqual(
        config.containers.pages.find((p) => p.id === 'home'),
      );
    },
  );
});

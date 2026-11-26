import { describe, expect, it } from 'vitest';

import { appFileFromWorkspace } from './app-file';
import { buttonKind } from './components';
import { homeScreenFull, homeScreenItems, homeScreenOp } from './home-screen';
import { appOfPage, appViewOf, firstTarget, startAppOf } from './app-view';
import { prepareOps } from './change';
import { migrateWorkspace } from './migrate';
import { applyOps, isFunctionOp, type Op } from './ops';
import { CURRENT_SCHEMA_VERSION, type WorkspaceConfig } from './schema';
import { createStarterWorkspace, paperAppOps } from './starter';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';

// D-485: Multiple apps. The home screen is the top-level bar + theme, and other apps are under nav.apps; pages, tables, and quick actions use the app field to declare ownership.
const base = () => createStarterWorkspace('en', registry);

/** A config with a fitness app: its own pages, tables, bottom bar (app pages + Tink), and theme. */
function withFitness(config: WorkspaceConfig = base()): WorkspaceConfig {
  const next = structuredClone(config);
  next.nav.apps = [
    {
      id: 'fit',
      name: 'Fitness',
      bar: ['page:fit-home', 'page:fit-plan', 'ai'],
      theme: structuredClone(next.theme),
    },
  ];
  next.containers.pages.push(
    { id: 'fit-home', title: 'Today', app: 'fit', blocks: [] },
    { id: 'fit-plan', title: 'Plan', app: 'fit', blocks: [] },
  );
  return next;
}

const codes = (config: unknown) => {
  const result = validateWorkspace(config, registry);
  return result.ok ? [] : result.issues.map((i) => i.code);
};

describe('apps（D-485）', () => {
  it('a config with an app is valid; the home config alone is unchanged', () => {
    expect(codes(withFitness())).toEqual([]);
    expect(base().nav.apps).toBeUndefined();
  });

  it('migrating a v38 config only raises the version (invariant 12)', () => {
    const old = { ...structuredClone(base()), schemaVersion: 38 };
    const result = migrateWorkspace(old);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({ ...old, schemaVersion: CURRENT_SCHEMA_VERSION });
    }
  });

  it('an app, its tables and quick actions may use app:<id> buttons from home', () => {
    const config = withFitness();
    const home = config.containers.pages.find((p) => p.id === 'home')!;
    home.blocks.push({
      id: 'open-fit',
      look: 'button',
      show: { label: 'Fitness', shape: 'row' },
      opens: 'app:fit',
    } as never);
    expect(codes(config)).toEqual([]);
  });

  it('rejects an app: button that points at a missing app', () => {
    const config = withFitness();
    const home = config.containers.pages.find((p) => p.id === 'home')!;
    home.blocks.push({
      id: 'open-x',
      look: 'button',
      show: { label: 'X', shape: 'row' },
      opens: 'app:nope',
    } as never);
    expect(codes(config)).toContain('unknown-app');
  });

  it('rejects an owner that does not exist (invariant 18)', () => {
    const config = withFitness();
    config.containers.pages.find((p) => p.id === 'fit-home')!.app = 'ghost';
    expect(codes(config)).toContain('unknown-app');
  });

  it('rejects a bar entry that is missing or belongs to another app / the home', () => {
    const missing = withFitness();
    missing.nav.apps![0]!.bar = ['page:nope', 'ai'];
    expect(codes(missing)).toContain('unknown-page');

    const foreign = withFitness();
    foreign.nav.apps![0]!.bar = ['page:home', 'ai'];
    expect(codes(foreign)).toContain('app-nav');
  });

  it('rejects an app page in the home bar, and a home page that belongs to an app', () => {
    const config = withFitness();
    config.nav.bar = ['page:home', 'page:fit-home', 'settings'];
    expect(codes(config)).toContain('app-nav');

    const home = withFitness();
    home.containers.pages.find((p) => p.id === 'home')!.app = 'fit';
    expect(codes(home)).toContain('app-home');
  });

  it('does not allow system pages other than Tink in an app bar', () => {
    const config = withFitness();
    (config.nav.apps![0]!.bar as string[]).push('settings');
    expect(codes(config)).toContain('schema');
  });

  it('rejects duplicate app ids', () => {
    const dup = withFitness();
    dup.nav.apps!.push({ ...structuredClone(dup.nav.apps![0]!) });
    expect(codes(dup)).toContain('duplicate');
  });
});

// ---- Operations (inheriting addContainer / updateContainer / removeContainer / setTheme, with the app key added) ----

const run = (config: WorkspaceConfig, ops: Op[]) => {
  const result = applyOps(config, ops, { registry, locale: 'en' });
  if (!result.ok) throw new Error(result.error);
  return result;
};

/** Build a fitness app using operations: pages, a table, a quick action, with an entry point on the home screen. */
function buildFitness(): WorkspaceConfig {
  const table = {
    id: 'workouts',
    name: 'Workouts',
    app: 'fit',
    fields: [{ id: 'name', name: 'Name', type: 'text' }],
  };
  return run(base(), [
    { op: 'addContainer', app: { id: 'fit', name: 'Fitness' } },
    { op: 'addData', table } as never,
    { op: 'addContainer', page: { id: 'fit-home', title: 'Today', app: 'fit', blocks: [] } },
    { op: 'updateContainer', app: { id: 'fit', bar: ['page:fit-home', 'ai'] } },
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'open-fit',
        look: 'button',
        show: { label: 'Fitness', shape: 'row' },
        opens: 'app:fit',
      } as never,
    },
  ]).config;
}

describe('App operations (D-485)', () => {
  it('builds an app from ops and the result is valid', () => {
    const config = buildFitness();
    expect(codes(config)).toEqual([]);
    const app = config.nav.apps![0]!;
    expect(app.bar).toEqual(['page:fit-home', 'ai']);
    // The new app's style is a copy of the home screen's style, not the same object.
    expect(app.theme).toEqual(config.theme);
  });

  it('setTheme with app changes only that app; without app only the home', () => {
    const config = buildFitness();
    const homeBefore = JSON.stringify(config.theme);
    const next = run(config, [{ op: 'setTheme', app: 'fit', primaryColor: '#ff0000' }]).config;
    expect(next.nav.apps![0]!.theme.primaryColor).toBe('#ff0000');
    expect(JSON.stringify(next.theme)).toBe(homeBefore);
    const home = run(next, [{ op: 'setTheme', primaryColor: '#00aa00' }]).config;
    expect(home.theme.primaryColor).toBe('#00aa00');
    expect(home.nav.apps![0]!.theme.primaryColor).toBe('#ff0000');
  });

  it('removing a page takes it off the app bar; an empty bar falls back to Tink', () => {
    const next = run(buildFitness(), [{ op: 'removeContainer', page: 'fit-home' }]).config;
    expect(next.nav.apps![0]!.bar).toEqual(['ai']);
    expect(codes(next)).toEqual([]);
  });

  it('removing an app removes its pages, links and quick actions, and keeps its tables (invariants 5, 18)', () => {
    const result = run(buildFitness(), [{ op: 'removeContainer', app: 'fit' }]);
    const next = result.config;
    expect(next.nav.apps).toBeUndefined();
    expect(next.containers.pages.some((p) => p.id === 'fit-home')).toBe(false);
    // The table still exists and belongs to the home screen; records are stored by table ID and are unaffected.
    const table = next.data.tables.find((t) => t.id === 'workouts')!;
    expect(table.app).toBeUndefined();
    // The button to open this app is removed along with it, leaving no dangling references.
    const home = next.containers.pages.find((p) => p.id === 'home')!;
    expect(JSON.stringify(home.blocks)).not.toContain('app:fit');
    expect(codes(next)).toEqual([]);
    expect(result.notes).toContainEqual({ kind: 'removedApp', tables: ['Workouts'], links: true });
  });

  it('rejects unknown apps and duplicate app ids', () => {
    const config = buildFitness();
    expect(
      applyOps(config, [{ op: 'removeContainer', app: 'nope' }], { registry, locale: 'en' }).ok,
    ).toBe(false);
    expect(
      applyOps(config, [{ op: 'addContainer', app: { id: 'fit', name: 'Again' } }], {
        registry,
        locale: 'en',
      }).ok,
    ).toBe(false);
    expect(
      applyOps(config, [{ op: 'setTheme', app: 'nope', primaryColor: '#ff0000' }], {
        registry,
        locale: 'en',
      }).ok,
    ).toBe(false);
  });

  it('creating or removing an app, and renaming it, are function changes; its bar and style are looks', () => {
    expect(isFunctionOp({ op: 'addContainer', app: { id: 'a', name: 'A' } })).toBe(true);
    expect(isFunctionOp({ op: 'removeContainer', app: 'a' })).toBe(true);
    expect(isFunctionOp({ op: 'updateContainer', app: { id: 'a', name: 'B' } })).toBe(true);
    expect(isFunctionOp({ op: 'updateContainer', app: { id: 'a', bar: ['ai'] } })).toBe(false);
    expect(isFunctionOp({ op: 'setTheme', app: 'a', primaryColor: '#ff0000' })).toBe(false);
  });
});

describe('Current app view (D-485)', () => {
  it('the home view is the top-level bar and theme; an app view is its own', () => {
    const config = withFitness();
    const home = appViewOf(config, null);
    expect(home.appId).toBeNull();
    expect(home.bar).toBe(config.nav.bar);
    expect(home.theme).toBe(config.theme);
    const fit = appViewOf(config, 'fit');
    expect(fit.bar).toEqual(['page:fit-home', 'page:fit-plan', 'ai']);
    expect(fit.floating).toEqual([]);
    expect(fit.theme).toBe(config.nav.apps![0]!.theme);
    expect(firstTarget(fit)).toBe('page:fit-home');
  });

  it('falls back to the home when the app does not exist', () => {
    expect(appViewOf(withFitness(), 'gone').appId).toBeNull();
  });

  it('a new app with only Tink has nothing to show first', () => {
    const config = run(base(), [
      { op: 'addContainer', app: { id: 'blank', name: 'Blank' } },
    ]).config;
    expect(firstTarget(appViewOf(config, 'blank'))).toBe('ai');
  });

  it('tells which app a page belongs to', () => {
    const config = withFitness();
    expect(appOfPage(config, 'fit-home')).toBe('fit');
    expect(appOfPage(config, 'home')).toBeNull();
    expect(appOfPage(config, 'nope')).toBeUndefined();
  });
});

describe('App entry point card (D-485)', () => {
  it('needs no title or icon: they come from the app', () => {
    const config = withFitness();
    config.containers.pages
      .find((p) => p.id === 'home')!
      .blocks.push({ id: 'fit-card', look: 'button', opens: 'app:fit' } as never);
    expect(codes(config)).toEqual([]);
    expect(buttonKind({ opens: 'app:fit' })).toBe('app');
  });
});

describe('Apps in the desktop menu (D-485)', () => {
  it('puts an app on the phone home screen menu next to quick actions', () => {
    const config = buildFitness();
    const next = run(config, [homeScreenOp(config, 'app:fit', true)]).config;
    expect(next.nav.phoneHomeScreen).toEqual(['app:fit']);
    expect(homeScreenItems(next)).toMatchObject([
      { id: 'app:fit', kind: 'app', title: 'Fitness', icon: 'apps' },
    ]);
    expect(codes(next)).toEqual([]);
  });

  // An app icon on the desktop renders its own icon (D-606): the background color is the primary color of the app's own theme, and the icon uses the text color on that primary color.
  it('an app on the menu carries its own icon and the colors of its own theme', () => {
    const config = buildFitness();
    const next = run(config, [
      { op: 'updateContainer', app: { id: 'fit', icon: '🏋️' } },
      { op: 'setTheme', app: 'fit', primaryColor: '#2255AA' },
      // The home screen's primary color is different: the app's desktop icon does not follow the home screen.
      { op: 'setTheme', primaryColor: '#F5D90A' },
      homeScreenOp(config, 'app:fit', true),
    ]).config;
    expect(homeScreenItems(next)).toEqual([
      {
        id: 'app:fit',
        kind: 'app',
        title: 'Fitness',
        icon: '🏋️',
        colors: { background: '#2255AA', foreground: '#FFFFFF' },
      },
    ]);
    // On a light primary color, use a dark icon so it is clearly visible.
    const light = run(next, [{ op: 'setTheme', app: 'fit', primaryColor: '#F5D90A' }]).config;
    expect(homeScreenItems(light)[0]!.colors).toEqual({
      background: '#F5D90A',
      foreground: '#1A1714',
    });
  });

  it('counts apps in the four places, and rejects a missing app', () => {
    let config = buildFitness();
    for (const id of ['a', 'b', 'c', 'd'])
      config = run(config, [
        { op: 'addContainer', app: { id: `x-${id}`, name: id } },
        homeScreenOp(config, `app:x-${id}`, true),
      ]).config;
    expect(homeScreenFull(config)).toBe(true);
    expect(
      applyOps(config, [homeScreenOp(config, 'app:nope', true)], { registry, locale: 'en' }).ok,
    ).toBe(false);
    const five = {
      ...config,
      nav: { ...config.nav, phoneHomeScreen: [...(config.nav.phoneHomeScreen ?? []), 'app:fit'] },
    };
    expect(codes(five)).toContain('homeScreen');
  });

  it('removing the app takes it off the menu (invariant 18)', () => {
    const config = buildFitness();
    const on = run(config, [homeScreenOp(config, 'app:fit', true)]).config;
    const gone = run(on, [{ op: 'removeContainer', app: 'fit' }]).config;
    expect(gone.nav.phoneHomeScreen).toBeUndefined();
    expect(codes(gone)).toEqual([]);
  });

  it("is the home page's to change: Tink inside an app cannot", () => {
    const config = buildFitness();
    const result = prepareOps(config, [homeScreenOp(config, 'app:fit', true)], {
      registry,
      locale: 'en',
      now: new Date(2026, 10, 7),
      fromAI: true,
      scope: { appId: 'fit' },
    });
    expect(result.ok).toBe(false);
  });
});

// D-644: the app list is a home page's block.
describe('the app list block', () => {
  const list = { id: 'list', look: 'catalog' as const, source: { catalog: 'apps' as const } };

  it('is on the new home page and valid with or without apps', () => {
    expect(codes(base())).toEqual([]);
    expect(codes(withFitness())).toEqual([]);
  });

  it('cannot sit on a page of an app, which may not open other apps (D-485)', () => {
    const config = withFitness();
    config.containers.pages.find((p) => p.id === 'fit-home')!.blocks.push(list);
    expect(codes(config)).toContain('data');
  });

  it('cannot sit inside a group on a page of an app either', () => {
    const config = withFitness();
    config.containers.pages
      .find((p) => p.id === 'fit-home')!
      .blocks.push({ id: 'g', look: 'group', show: { layout: 'stack' }, children: [list] });
    expect(codes(config)).toContain('data');
  });

  it('stays behind when a whole setup is turned into an app file', () => {
    const config = base();
    const home = config.containers.pages.find((p) => p.id === 'home')!;
    home.blocks.push({
      id: 'g',
      look: 'group',
      show: { layout: 'stack' },
      children: [{ ...list, id: 'nested' }],
    });
    const file = appFileFromWorkspace(config, { id: 'mine', name: 'Mine' });
    expect(JSON.stringify(file.pages)).not.toContain('"apps"');
  });
});

// D-649: with one app and nothing else on the home page, Tinkrum opens in that app.
describe('the app Tinkrum opens in', () => {
  const paper = () => {
    const start = base();
    const result = applyOps(start, paperAppOps(start, 'en', registry), { registry, locale: 'en' });
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };

  it('is the only app', () => {
    expect(startAppOf(paper())).toBe('paper');
  });

  it('is none without an app, or with two', () => {
    expect(startAppOf(base())).toBeNull();
    const two = paper();
    two.nav.apps!.push({ ...structuredClone(two.nav.apps![0]!), id: 'other' });
    expect(startAppOf(two)).toBeNull();
  });

  it('is none for an app that has only Tink to show', () => {
    const config = paper();
    config.nav.apps![0]!.bar = ['ai'];
    expect(startAppOf(config)).toBeNull();
  });

  it('is none while the home page holds more than the app list, which would go unseen', () => {
    const titled = paper();
    const home = () => titled.containers.pages.find((p) => p.id === 'home')!;
    home().blocks.unshift({ id: 'title', look: 'header', show: { title: 'Mine' } });
    expect(startAppOf(titled)).toBeNull();
    // A hidden block is not seen anyway.
    home().blocks[0]!.hidden = true;
    expect(startAppOf(titled)).toBe('paper');
    const noList = paper();
    noList.containers.pages.find((p) => p.id === 'home')!.blocks = [];
    expect(startAppOf(noList)).toBeNull();
  });

  it('is none while the home bar leads to another home page', () => {
    const config = paper();
    config.containers.pages.push({ id: 'notes', title: 'Notes', blocks: [] });
    config.nav.bar.splice(1, 0, 'page:notes');
    expect(startAppOf(config)).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appFileFromWorkspace,
  appFileOfApp,
  appFileOps,
  appFileText,
  appResetOps,
  readAppFile,
  type AppFile,
  type ImportMode,
} from './app-file';
import { homeScreenOp } from './home-screen';
import { prepareOps } from './change';
import { countFileRefs, newFileRefs } from './file-refs';
import { referenceProblems } from './reference-checks';
import { applyOps } from './ops';
import {
  CURRENT_SCHEMA_VERSION,
  CUSTOM_ICON_NAMES,
  HOME_PAGE_ID,
  quickActionsOf,
  remindersOf,
  type WorkspaceConfig,
} from './schema';
import { createStarterWorkspace } from './starter';
import { registry } from './test-helpers';
import { checkTools } from './tool-check';

// Portal website presentation presets (App files, tinkrum-app, D-485): each preset is an App, added
// to the existing workspace upon import. Each must be readable, importable, conflict-free in IDs,
// free of user files, and result in a self-consistent config; all nine can be installed together
// (Clay added in D-487).

const DIR = join(__dirname, 'fixtures', 'portal-apps');
interface Entry {
  id: string;
  name: string;
  file: string;
  icon: string;
  pages: string[];
  tables: string[];
  reminders: number;
  quickActions: number;
}
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as { apps: Entry[] };
const text = (file: string) => readFileSync(join(DIR, file), 'utf8');
const NOW = new Date(2026, 10, 7);
const ctx = { registry, locale: 'en' as const, now: NOW };
const starter = () => createStarterWorkspace('en', registry);

function importApp(config: WorkspaceConfig, file: AppFile, mode?: ImportMode): WorkspaceConfig {
  const plan = appFileOps(file, config, mode ? { mode } : {});
  if (!plan.ok) throw new Error(plan.error);
  const result = prepareOps(config, plan.ops, ctx);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.after;
}

describe('Preset display (App file)', () => {
  it('lists nine apps, each with its own drawn icon, and every file exists', () => {
    expect(manifest.apps).toHaveLength(9);
    expect(new Set(manifest.apps.map((a) => a.id)).size).toBe(9);
    expect(manifest.apps.map((a) => a.icon).sort()).toEqual([...CUSTOM_ICON_NAMES].sort());
    for (const a of manifest.apps) expect(() => text(a.file)).not.toThrow();
  });

  describe.each(manifest.apps.map((a) => [a.name, a] as const))('%s', (_name, entry) => {
    const file = readAppFile(text(entry.file));

    it('reads, and is on the current version', () => {
      expect(file).not.toBeNull();
      expect(file!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(file!.app.id).toBe(entry.id);
      expect(file!.app.icon).toBe(entry.icon);
    });

    it('imports into a new user workspace as one app, replacing nothing', () => {
      const before = starter();
      const after = importApp(before, file!);
      const app = after.nav.apps!.find((a) => a.id === entry.id)!;
      expect(app.name).toBe(entry.name);
      expect(app.bar[0]).toMatch(/^page:/);
      expect(app.bar.at(-1)).toBe('ai');
      const mine = (owner: string | undefined) => owner === entry.id;
      // Counts and descriptions match; all belong to this App.
      expect(after.containers.pages.filter((p) => mine(p.app)).map((p) => p.title)).toEqual(
        entry.pages,
      );
      expect(after.data.tables.filter((t) => mine(t.app)).map((t) => t.name)).toEqual(entry.tables);
      expect(remindersOf(after).filter((r) => mine(r.app))).toHaveLength(entry.reminders);
      expect(quickActionsOf(after).filter((q) => mine(q.app))).toHaveLength(entry.quickActions);
      // Original pages, tables, and quick actions remain intact; a new user's home page lists the
      // app by itself (D-new-apphome-1), so no entry block is added to it.
      for (const p of before.containers.pages)
        expect(after.containers.pages.find((x) => x.id === p.id)).toEqual(p);
      expect(after.theme).toEqual(before.theme);
    });

    it('is self-contained: no user files, no dangling references, nothing the tool check blocks (invariants 3, 14, 18)', () => {
      const before = starter();
      const after = importApp(before, file!);
      expect(newFileRefs(before, after)).toEqual([]);
      expect(referenceProblems(after, registry)).toEqual([]);
      expect(checkTools(after, registry).issues.filter((i) => i.severity === 'blocker')).toEqual(
        [],
      );
    });

    it("cannot be imported twice (ids are the app's own)", () => {
      const once = importApp(starter(), file!);
      const again = appFileOps(file!, once);
      expect(again.ok).toBe(false);
      expect(!again.ok && again.error).toMatch(/already exist/);
    });

    it('can be removed again, keeping its tables (invariants 5, 18)', () => {
      const once = importApp(starter(), file!);
      const removed = applyOps(once, [{ op: 'removeContainer', app: entry.id }], ctx);
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.config.nav.apps).toBeUndefined();
      expect(removed.config.data.tables.length).toBe(once.data.tables.length);
      const check = prepareOps(once, [{ op: 'removeContainer', app: entry.id }], ctx);
      expect(check.ok).toBe(true);
    });
  });

  it('all nine can live in one workspace', () => {
    let config = starter();
    for (const a of manifest.apps) config = importApp(config, readAppFile(text(a.file))!);
    expect(config.nav.apps).toHaveLength(9);
    expect(referenceProblems(config, registry)).toEqual([]);
  });

  it('migrates an older file (invariant 12)', () => {
    const old = text('tinkrum-app-habits.json').replace(
      `"schemaVersion": ${CURRENT_SCHEMA_VERSION}`,
      '"schemaVersion": 38',
    );
    const file = readAppFile(old);
    expect(file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => importApp(starter(), file!)).not.toThrow();
  });

  it('ignores a file that is not an app file, and a whole-workspace config', () => {
    expect(readAppFile('nope')).toBeNull();
    expect(
      readAppFile(JSON.stringify({ format: 'morph-app-config', version: 1, config: {} })),
    ).toBeNull();
    expect(readAppFile(JSON.stringify({ format: 'tinkrum-app', version: 1 }))).toBeNull();
  });
});

describe('appFileFromWorkspace', () => {
  it('prefixes ids and moves references, but leaves field ids, block ids and text alone', () => {
    const config = applyOps(
      starter(),
      [
        {
          op: 'addData',
          table: {
            id: 'tasks',
            name: 'tasks',
            fields: [{ id: 'tasks', name: 'tasks', type: 'text' }],
          },
        } as never,
        {
          op: 'addContainer',
          page: {
            id: 'board',
            title: 'tasks',
            blocks: [
              {
                id: 'tasks',
                look: 'list',
                source: { table: 'tasks', limit: 5 },
                show: { title: 'tasks' },
              },
            ],
          },
        },
        { op: 'updateContainer', nav: { bar: ['page:home', 'page:board', 'settings'] } },
      ],
      { registry, locale: 'en' },
    );
    if (!config.ok) throw new Error(config.error);
    const file = appFileFromWorkspace(config.config, { id: 'todo', name: 'To-do', icon: 'check' });
    expect(file.app.bar).toEqual(['page:todo-home', 'page:todo-board', 'ai']);
    const table = file.tables.find((t) => t.id === 'todo-tasks')!;
    expect(table.fields[0]!.id).toBe('tasks');
    const page = file.pages.find((p) => p.id === 'todo-board')!;
    const block = page.blocks.find((b) => b.id === 'tasks') as {
      id: string;
      source: { table: string };
      show: { title: string };
    };
    expect(block.id).toBe('tasks');
    expect(block.source.table).toBe('todo-tasks');
    expect(block.show.title).toBe('tasks');
    expect(() => importApp(starter(), file as AppFile)).not.toThrow();
  });
});

// ---- Import home page, reconnect existing tables, and restore initial appearance (D-485) ----

const load = (entry: Entry) => readAppFile(text(entry.file))!;
const run = (config: WorkspaceConfig, ops: Parameters<typeof prepareOps>[1]) => {
  const result = prepareOps(config, ops, ctx);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.after;
};

describe.each(manifest.apps.map((a) => [a.name, a] as const))(
  'Import home page %s',
  (_name, entry) => {
    const file = load(entry);

    it('changes the home style and puts the pages in the bar, without making an app', () => {
      const before = starter();
      const after = importApp(before, file, 'home');
      expect(after.nav.apps).toBeUndefined();
      expect(after.theme).toEqual(file.app.theme);
      expect(after.nav.bar.length).toBeLessThanOrEqual(5);
      // Pages that fit were entered into the navigation bar; the original Home, Tink, and Settings remain.
      const added = after.nav.bar.filter((t) => t.startsWith('page:') && t !== 'page:home');
      expect(added.length).toBeGreaterThan(0);
      expect(after.nav.bar).toContain('page:home');
      expect(after.nav.bar).toContain('settings');
      // Pages, tables, quick actions, and reminders belong to the home page (no app property).
      expect(after.containers.pages.filter((p) => p.app !== undefined)).toEqual([]);
      expect(after.data.tables.filter((t) => t.app !== undefined)).toEqual([]);
      expect(after.data.tables.length).toBe(before.data.tables.length + entry.tables.length);
      expect(remindersOf(after)).toHaveLength(entry.reminders);
    });

    it('keeps every page reachable and the workspace consistent (invariant 18)', () => {
      const before = starter();
      const after = importApp(before, file, 'home');
      expect(referenceProblems(after, registry)).toEqual([]);
      expect(newFileRefs(before, after)).toEqual([]);
      expect(checkTools(after, registry).issues.filter((i) => i.severity === 'blocker')).toEqual(
        [],
      );
    });

    it('cannot be imported into the home twice', () => {
      const once = importApp(starter(), file, 'home');
      const again = appFileOps(file, once, { mode: 'home' });
      expect(again.ok).toBe(false);
    });
  },
);

describe('Reconnect existing tables and restore initial appearance', () => {
  const entry = manifest.apps.find((a) => a.id === 'habits')!;
  const file = load(entry);
  const habits = 'habits-habits';
  /** Original file has one more field than the installed version (App file has been upgraded). */
  const newer: AppFile = {
    ...file,
    tables: file.tables.map((t) =>
      t.id === habits
        ? { ...t, fields: [...t.fields, { id: 'extra', name: 'Extra', type: 'text' as const }] }
        : t,
    ),
  };

  it('imports again after the app was removed: its tables are taken back (invariant 5)', () => {
    const installed = importApp(starter(), file);
    const removed = run(installed, [{ op: 'removeContainer', app: 'habits' }]);
    expect(removed.data.tables.find((t) => t.id === habits)!.app).toBeUndefined();
    const back = importApp(removed, file);
    expect(back.data.tables.find((t) => t.id === habits)!.app).toBe('habits');
    expect(back.data.tables.length).toBe(installed.data.tables.length);
  });

  it('adds a field the file has and the table lacks, and keeps the ones the user added', () => {
    const installed = importApp(starter(), file);
    const edited = run(installed, [
      { op: 'addData', table: habits, field: { id: 'mine', name: 'Mine', type: 'text' } } as never,
    ]);
    const removed = run(edited, [{ op: 'removeContainer', app: 'habits' }]);
    const back = importApp(removed, newer);
    const fields = back.data.tables.find((t) => t.id === habits)!.fields.map((f) => f.id);
    expect(fields).toContain('extra');
    expect(fields).toContain('mine');
  });

  it('refuses a table that belongs to another app', () => {
    const removed = run(importApp(starter(), file), [{ op: 'removeContainer', app: 'habits' }]);
    const owned = run(removed, [
      { op: 'addContainer', app: { id: 'other', name: 'Other' } },
      { op: 'updateData', table: habits, changes: { app: 'other' } } as never,
    ]);
    const clash = appFileOps(file, owned);
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.error).toMatch(/table habits-habits/);
  });

  it('restores the app to the file: pages, style, bar, reminders; user tables stay on the home', () => {
    // A home page without an app list (from before D-new-apphome-1) holds an entry block per app.
    const base = run(starter(), [{ op: 'removeContainer', page: HOME_PAGE_ID, block: 'apps' }]);
    let config = importApp(base, file);
    // Place into the Home Screen menu.
    config = run(config, [homeScreenOp(config, 'app:habits', true)]);
    // The user heavily modified it: deleted a page, added a page, changed style, changed name, added own table, deleted a reminder.
    const reminder = remindersOf(config).find((r) => r.app === 'habits')!;
    config = run(config, [
      { op: 'removeContainer', page: 'habits-insights' },
      { op: 'addContainer', page: { id: 'habits-mine', title: 'Mine', app: 'habits', blocks: [] } },
      { op: 'setTheme', app: 'habits', primaryColor: '#000000' },
      { op: 'updateContainer', app: { id: 'habits', name: 'Changed' } },
      {
        op: 'addData',
        table: {
          id: 'habits-extra',
          name: 'Extra',
          app: 'habits',
          fields: [{ id: 'x', name: 'x', type: 'text' }],
        },
      } as never,
      { op: 'removeTool', tool: reminder.id },
    ]);
    const plan = appResetOps(newer, config, registry);
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    const app = after.nav.apps!.find((a) => a.id === 'habits')!;
    expect(app.name).toBe(entry.name);
    expect(app.theme).toEqual(file.app.theme);
    expect(app.bar).toEqual(file.app.bar);
    expect(
      after.containers.pages
        .filter((p) => p.app === 'habits')
        .map((p) => p.id)
        .sort(),
    ).toEqual(file.pages.map((p) => p.id).sort());
    expect(remindersOf(after).filter((r) => r.app === 'habits')).toHaveLength(entry.reminders);
    // The user's own table is kept, transferred to the home page, and records remain untouched.
    expect(after.data.tables.find((t) => t.id === 'habits-extra')!.app).toBeUndefined();
    // Extra fields from the original file are filled in; Home Screen menu remains; there is only one home page entry point.
    expect(after.data.tables.find((t) => t.id === habits)!.fields.map((f) => f.id)).toContain(
      'extra',
    );
    expect(after.nav.phoneHomeScreen).toEqual(['app:habits']);
    const home = after.containers.pages.find((p) => p.id === HOME_PAGE_ID)!;
    expect(JSON.stringify(home.blocks).match(/app:habits/g)).toHaveLength(1);
    expect(referenceProblems(after, registry)).toEqual([]);
  });

  it('restoring leaves other apps and the home untouched', () => {
    let config = importApp(starter(), file);
    config = importApp(config, load(manifest.apps.find((a) => a.id === 'wallet')!));
    const walletBefore = JSON.stringify([
      config.nav.apps!.find((a) => a.id === 'wallet'),
      config.containers.pages.filter((p) => p.app === 'wallet'),
      config.data.tables.filter((t) => t.app === 'wallet'),
    ]);
    const plan = appResetOps(file, config, registry);
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    expect(
      JSON.stringify([
        after.nav.apps!.find((a) => a.id === 'wallet'),
        after.containers.pages.filter((p) => p.app === 'wallet'),
        after.data.tables.filter((t) => t.app === 'wallet'),
      ]),
    ).toBe(walletBefore);
    expect(after.theme).toEqual(config.theme);
  });

  it('has nothing to restore when the app is not there', () => {
    const plan = appResetOps(file, starter(), registry);
    expect(plan.ok).toBe(false);
  });
});

// Share an installed App (D-545): packaged as an App file containing only structure; when imported by someone else (or on another phone), it is the same App.
describe('appFileOfApp', () => {
  const wallet = readAppFile(text('tinkrum-app-wallet.json'))!;
  const installed = () => importApp(starter(), wallet);
  /** Place an image and a file slot on the first page of the App pointing to the user's files. */
  const withFiles = (config: WorkspaceConfig) => {
    const page = config.containers.pages.find((p) => p.app === 'wallet')!.id;
    const r = applyOps(
      config,
      [
        {
          op: 'addContainer',
          page,
          block: {
            id: 'pic',
            look: 'image',
            show: { asset: 'userphoto1', aspect: 'wide', fit: 'cover' },
          },
        },
        {
          op: 'addContainer',
          page,
          block: {
            id: 'slot',
            look: 'entry',
            show: { title: 'Lease' },
            opens: { file: 'userfile1' },
          },
        },
      ] as never,
      ctx,
    );
    if (!r.ok) throw new Error(r.error);
    return r.config;
  };

  it('round trip: export, read, import into a new workspace gives the same app', () => {
    const config = installed();
    const out = appFileOfApp(config, 'wallet');
    expect(out).not.toBeNull();
    const back = readAppFile(appFileText(out!, NOW));
    expect(back).not.toBeNull();
    expect(Object.keys(JSON.parse(appFileText(out!, NOW))).sort()).toEqual(
      [
        'app',
        'exportedAt',
        'format',
        'pages',
        'schemaVersion',
        'tables',
        'tools',
        // Uses (D-556): for the reader version, not part of the App.
        'uses',
        'version',
      ].sort(),
    );
    const again = importApp(starter(), back!);
    expect(referenceProblems(again, registry)).toEqual([]);
    expect(again.nav.apps!.map((a) => a.id)).toEqual(['wallet']);
    const ids = (c: WorkspaceConfig) => ({
      pages: c.containers.pages.filter((p) => p.app === 'wallet').map((p) => p.id),
      tables: c.data.tables.filter((t) => t.app === 'wallet').map((t) => t.id),
      tools: c.tools.filter((t) => t.app === 'wallet').map((t) => t.id),
    });
    expect(ids(again)).toEqual(ids(config));
    expect(again.nav.apps![0]).toEqual(config.nav.apps![0]);
  });

  it('carries no references to the user’s files: images and file slots come out empty (invariant 3)', () => {
    const config = withFiles(installed());
    const text = appFileText(appFileOfApp(config, 'wallet')!, NOW);
    expect(text).not.toContain('userphoto1');
    expect(text).not.toContain('userfile1');
    const again = importApp(starter(), readAppFile(text)!);
    expect(countFileRefs(again)).toBe(0);
    expect(again.containers.pages.some((p) => p.blocks.some((b) => b.id === 'slot'))).toBe(true);
  });

  it('takes only that app: not the home, not other apps', () => {
    const config = importApp(installed(), readAppFile(text('tinkrum-app-habits.json'))!);
    const out = appFileOfApp(config, 'wallet')!;
    expect(out.pages.every((p) => p.id.startsWith('wallet'))).toBe(true);
    expect(out.tables.every((t) => t.id.startsWith('wallet'))).toBe(true);
    expect(out.tools.every((t) => t.id.startsWith('wallet'))).toBe(true);
    expect(JSON.stringify([out.pages, out.tables, out.tools])).not.toContain('"app":');
  });

  it('has nothing to share when the app is not there', () => {
    expect(appFileOfApp(starter(), 'wallet')).toBeNull();
  });

  // Using something this build does not know is refused as a whole, rather than partially (invariant 18).
  it('a file using something this build does not know is refused as a whole, not half imported', () => {
    const file = readAppFile(text('tinkrum-app-wallet.json'))!;
    const odd = JSON.parse(JSON.stringify(file)) as AppFile;
    (odd.tables[0]!.fields[0] as { type: string }).type = 'fromTheFuture';
    const plan = appFileOps(odd, starter());
    expect(plan.ok).toBe(true);
    const result = prepareOps(starter(), plan.ok ? plan.ops : [], ctx);
    expect(result.ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  appFileOfApp,
  appFileOps,
  appUpdateOps,
  describeAppUpdate,
  type AppFile,
} from './app-file';
import { prepareOps } from './change';
import { homeScreenOp } from './home-screen';
import { referenceProblems } from './reference-checks';
import { CURRENT_SCHEMA_VERSION, HOME_PAGE_ID, type WorkspaceConfig } from './schema';
import { createStarterWorkspace } from './starter';
import { registry } from './test-helpers';

// Update an installed app using a modified app file (D-611): Files returned by another AI retain
// their IDs and reconnect by ID. Pages, quick actions, reminders, styles, and bottom bar are
// replaced by the file contents; tables are matched by ID, fields are added, modified, removed, or
// reordered; records remain untouched (invariant 5).

const ctx = { registry, locale: 'en' as const, now: new Date('2026-11-21T10:00:00Z') };

const run = (config: WorkspaceConfig, ops: Parameters<typeof prepareOps>[1]) => {
  const result = prepareOps(config, ops, ctx);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return result.after;
};

function file(): AppFile {
  return {
    format: 'tinkrum-app',
    version: 1,
    exportedAt: '2026-11-21T10:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    app: {
      id: 'books',
      name: 'Books',
      icon: '📚',
      bar: ['page:books-home', 'ai'],
      theme: createStarterWorkspace('en', registry).theme,
    },
    tables: [
      {
        id: 'books-books',
        name: 'Books',
        fields: [
          { id: 'title', name: 'Title', type: 'text', required: true },
          { id: 'author', name: 'Author', type: 'text' },
          { id: 'pages', name: 'Pages', type: 'number' },
          {
            id: 'state',
            name: 'State',
            type: 'choice',
            options: [
              { id: 'next', label: 'Next' },
              { id: 'reading', label: 'Reading' },
            ],
          },
        ],
      },
      {
        id: 'books-notes',
        name: 'Notes',
        fields: [
          { id: 'book', name: 'Book', type: 'link', table: 'books-books' },
          { id: 'text', name: 'Text', type: 'note' },
        ],
      },
    ],
    pages: [
      {
        id: 'books-home',
        title: 'Shelf',
        blocks: [
          {
            id: 'list',
            look: 'list',
            source: { table: 'books-books' },
            show: { title: 'title', subtitles: ['author'] },
          },
        ],
      },
    ],
    tools: [],
  } as unknown as AppFile;
}

/** A home page without an app list (from before D-new-apphome-1): each app has an entry block there. */
const olderHome = () =>
  run(createStarterWorkspace('en', registry), [
    { op: 'removeContainer', page: HOME_PAGE_ID, block: 'apps' },
  ]);

function installed(base = olderHome()): WorkspaceConfig {
  const plan = appFileOps(file(), base);
  if (!plan.ok) throw new Error(plan.error);
  return run(base, plan.ops);
}

/** Export from an installed app (same as sharing or handing off to another AI), then modify via edit. */
function edited(config: WorkspaceConfig, edit: (f: AppFile) => void): AppFile {
  const out = {
    format: 'tinkrum-app',
    version: 1,
    exportedAt: '2026-11-21T10:00:00.000Z',
    ...appFileOfApp(config, 'books')!,
  } as AppFile;
  const copy = JSON.parse(JSON.stringify(out)) as AppFile;
  edit(copy);
  return copy;
}

const table = (config: WorkspaceConfig, id: string) => config.data.tables.find((t) => t.id === id)!;

describe('appUpdateOps: update the same app with a modified app file', () => {
  it('needs the app to be installed', () => {
    const plan = appUpdateOps(file(), createStarterWorkspace('en', registry), registry);
    expect(plan.ok).toBe(false);
  });

  it('an unchanged file leaves the app as it was', () => {
    const config = installed();
    const plan = appUpdateOps(
      edited(config, () => {}),
      config,
      registry,
    );
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    for (const key of ['books-books', 'books-notes'])
      expect(table(after, key)).toEqual(table(config, key));
    expect(after.containers.pages.filter((p) => p.app === 'books')).toEqual(
      config.containers.pages.filter((p) => p.app === 'books'),
    );
    expect(after.nav.apps).toEqual(config.nav.apps);
  });

  it('applies changes to pages, the table and its fields, by id', () => {
    const config = installed();
    const next = edited(config, (f) => {
      f.app.name = 'My books';
      f.pages[0]!.title = 'Bookshelf';
      const books = f.tables[0]!;
      books.name = 'All books';
      // Rename, add options, add fields, remove fields, reorder, convert numbers to currency (compatible types).
      books.fields = [
        { id: 'title', name: 'Book title', type: 'text', required: true },
        {
          id: 'state',
          name: 'State',
          type: 'choice',
          options: [
            { id: 'next', label: 'Next' },
            { id: 'reading', label: 'Reading' },
            { id: 'done', label: 'Done' },
          ],
        },
        { id: 'pages', name: 'Price', type: 'money', currency: 'EUR' },
        { id: 'rating', name: 'Rating', type: 'rating' },
      ] as never;
      f.pages[0]!.blocks = [
        {
          id: 'list',
          look: 'list',
          source: { table: 'books-books' },
          show: { title: 'title', subtitles: ['state'], trailing: 'rating' },
        },
      ] as never;
    });
    const plan = appUpdateOps(next, config, registry);
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    const books = table(after, 'books-books');
    expect(books.name).toBe('All books');
    expect(books.app).toBe('books');
    expect(books.fields).toEqual(next.tables[0]!.fields);
    expect(after.containers.pages.find((p) => p.id === 'books-home')!.title).toBe('Bookshelf');
    expect(after.nav.apps!.find((a) => a.id === 'books')!.name).toBe('My books');
    expect(referenceProblems(after, registry)).toEqual([]);
  });

  it('refuses a field type that cannot be converted, and says to add a new field', () => {
    const config = installed();
    const next = edited(config, (f) => {
      f.tables[0]!.fields[1] = { id: 'author', name: 'Author', type: 'date' } as never;
      f.pages[0]!.blocks = [] as never;
    });
    const plan = appUpdateOps(next, config, registry);
    if (!plan.ok) throw new Error(plan.error);
    const result = prepareOps(config, plan.ops, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join('\n')).toMatch(/add a new field instead/);
  });

  it('a table the file no longer has moves to the home with its entries, like removing the app', () => {
    const config = installed();
    const next = edited(config, (f) => {
      f.tables = f.tables.filter((t) => t.id !== 'books-notes');
    });
    const plan = appUpdateOps(next, config, registry);
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    expect(table(after, 'books-notes')).toBeDefined();
    expect(table(after, 'books-notes').app).toBeUndefined();
  });

  it('keeps the phone home screen entry and one entry on the home page', () => {
    let config = installed();
    config = run(config, [homeScreenOp(config, 'app:books', true)]);
    const plan = appUpdateOps(
      edited(config, (f) => {
        f.pages[0]!.title = 'Changed';
      }),
      config,
      registry,
    );
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    expect(after.nav.phoneHomeScreen).toEqual(['app:books']);
    const home = after.containers.pages.find((p) => p.id === HOME_PAGE_ID)!;
    expect(JSON.stringify(home.blocks).match(/app:books/g)).toHaveLength(1);
  });

  it('adds no entry to a home page that lists the apps, before or after an update', () => {
    const start = createStarterWorkspace('en', registry);
    const config = installed(start);
    const plan = appUpdateOps(
      edited(config, (f) => {
        f.pages[0]!.title = 'Changed';
      }),
      config,
      registry,
    );
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    for (const c of [config, after])
      expect(c.containers.pages.find((p) => p.id === HOME_PAGE_ID)).toEqual(
        start.containers.pages.find((p) => p.id === HOME_PAGE_ID),
      );
  });

  it('keeps the home page entry where the person put it', () => {
    let config = installed();
    const home = () => config.containers.pages.find((p) => p.id === HOME_PAGE_ID)!;
    const entry = home().blocks.find((b) => JSON.stringify(b).includes('app:books'))!;
    config = run(config, [
      { op: 'removeContainer', page: HOME_PAGE_ID, block: entry.id },
      { op: 'addContainer', page: HOME_PAGE_ID, block: entry, index: 0 } as never,
      {
        op: 'addContainer',
        page: HOME_PAGE_ID,
        block: { id: 'greeting', look: 'header', show: { title: 'Hello' } },
      } as never,
    ]);
    expect(home().blocks[0]!.id).toBe(entry.id);
    const plan = appUpdateOps(
      edited(config, (f) => {
        f.pages[0]!.title = 'Changed';
      }),
      config,
      registry,
    );
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    const blocks = after.containers.pages.find((p) => p.id === HOME_PAGE_ID)!.blocks;
    expect(blocks[0]!.id).toBe(entry.id);
    expect(blocks.map((b) => b.id)).toEqual(home().blocks.map((b) => b.id));
  });

  it('leaves the home and other tables alone', () => {
    const config = installed();
    const plan = appUpdateOps(
      edited(config, (f) => {
        f.pages[0]!.title = 'Changed';
      }),
      config,
      registry,
    );
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    expect(after.theme).toEqual(config.theme);
    expect(after.data.tables.filter((t) => !t.id.startsWith('books-'))).toEqual(
      config.data.tables.filter((t) => !t.id.startsWith('books-')),
    );
  });
});

// In the preview, only state what actually changed, not "Remove App" or "New App" (an update is an operation that first removes and then reinstalls, describing each individual operation would be misleading).
describe('describeAppUpdate', () => {
  it('lists only what really changed', () => {
    const config = installed();
    const next = edited(config, (f) => {
      f.pages[0]!.title = 'Bookshelf';
      const books = f.tables[0]!;
      books.fields = books.fields.filter((x) => x.id !== 'pages');
      books.fields.find((x) => x.id === 'author')!.name = 'Writer';
      books.fields.push({ id: 'rating', name: 'Rating', type: 'rating' } as never);
      f.tables = f.tables.filter((x) => x.id !== 'books-notes');
    });
    const plan = appUpdateOps(next, config, registry);
    if (!plan.ok) throw new Error(plan.error);
    const after = run(config, plan.ops);
    expect(describeAppUpdate(config, after, 'books', 'en')).toEqual([
      'Page “Bookshelf” changed',
      '“Books”: field “Writer” changed',
      '“Books”: new field “Rating”',
      '“Books”: field “Pages” removed (entries keep its values)',
      'Table “Notes” moves to your home with its entries',
    ]);
  });

  it('says nothing changes for the same file', () => {
    const config = installed();
    const plan = appUpdateOps(
      edited(config, () => {}),
      config,
      registry,
    );
    if (!plan.ok) throw new Error(plan.error);
    expect(describeAppUpdate(config, run(config, plan.ops), 'books', 'zh')).toEqual([
      '文件和现在的 App 一样，没有要改的。',
    ]);
  });
});

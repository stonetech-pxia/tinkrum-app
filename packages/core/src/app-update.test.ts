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

// 用改过的 App 文件更新装好的同一个 App（D-611）：别的 AI 改完交回来的文件，ID 不变，按 ID 接上。
// 页面、快捷操作、提醒、风格、底栏换成文件里的；表按 ID 对，字段加、改、去、排序；记录不动（底线 5）。

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

function installed(): WorkspaceConfig {
  const base = createStarterWorkspace('en', registry);
  const plan = appFileOps(file(), base);
  if (!plan.ok) throw new Error(plan.error);
  return run(base, plan.ops);
}

/** 从装好的 App 导出（和分享、交给别的 AI 时一样），再按 edit 改。 */
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

describe('appUpdateOps：用改过的 App 文件更新同一个 App', () => {
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
      // 改名、加选项、加字段、去字段、调顺序、数字换成金额（兼容的类型）。
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
        block: { id: 'hello', look: 'header', show: { title: 'Hello' } },
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

// 预览里只说真正变了的，不说「移除 App」「新建 App」（更新是先移除再装回，逐个操作的说法会误导）。
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fieldDefinition, type DataRecord, type WorkspaceConfig } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp, starterAfterGuide } from '../test-utils/render-app';

// Portal website display presets (App files, D-485): each selected via "Settings -> My presets ->
// Import from file" is added as a new App, leaving the original unchanged; entering this App, every
// navigation bar item, every page, every table's new record page and record page must render
// successfully without errors or rollbacks.

// Each preset has to go through all pages, which is relatively slow when dozens of tests run together.
jest.setTimeout(30000);

const DIR = join(__dirname, '../../../../packages/core/src/fixtures/portal-apps');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
  apps: { id: string; name: string; file: string }[];
};

/** Put three records in each table (fill fields with valid example values according to type, cycle through options, and set relations to point to the first record of the counterpart table). */
async function fillTables(
  repo: MemoryWorkspaceRepo,
  config: WorkspaceConfig,
  mine: (table: WorkspaceConfig['data']['tables'][number]) => boolean,
) {
  const ids = new Map<string, string[]>();
  let n = 0;
  const tables = config.data.tables.filter(mine);
  for (const table of tables)
    ids.set(
      table.id,
      [0, 1, 2].map(() => `fill${String(++n).padStart(5, '0')}`),
    );
  for (const table of tables) {
    for (const [i, id] of ids.get(table.id)!.entries()) {
      const values: Record<string, unknown> = {};
      for (const f of table.fields) {
        const def = fieldDefinition(f.type);
        if (!def.write || f.type === 'file') continue;
        let v: unknown = def.exampleValue;
        if (f.type === 'text') v = `${f.name} ${i + 1}`;
        else if (f.type === 'choice') v = f.options[i % f.options.length]!.id;
        else if (f.type === 'link') v = ids.get(f.table)?.[0];
        if (v !== undefined) values[f.id] = v;
      }
      await repo.insertRecord({
        id,
        collectionId: table.id,
        values,
        createdAt: 1 + i,
        updatedAt: 1 + i,
      } as DataRecord);
    }
  }
  return ids;
}

describe.each(manifest.apps.map((a) => [a.name, a] as const))('app file %s', (_name, entry) => {
  let errors: unknown[][];
  beforeEach(() => {
    errors = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
      errors.push(args);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const fileIds = (() => {
    const f = JSON.parse(readFileSync(join(DIR, entry.file), 'utf8')) as {
      pages: { id: string }[];
      tables: { id: string }[];
    };
    return { pages: new Set(f.pages.map((p) => p.id)), tables: new Set(f.tables.map((t) => t.id)) };
  })();
  // Apps identified by app field for app mode; home imports have no app and are identified by ID in the file.
  let mode: 'app' | 'home' = 'app';
  const ownedPage = (p: { id: string; app?: string | undefined }) =>
    mode === 'app' ? p.app === entry.id : fileIds.pages.has(p.id);
  const ownedTable = (t: { id: string; app?: string | undefined }) =>
    mode === 'app' ? t.app === entry.id : fileIds.tables.has(t.id);
  const readTheme = () =>
    (
      JSON.parse(readFileSync(join(DIR, entry.file), 'utf8')) as {
        app: { theme: { primaryColor: string } };
      }
    ).app.theme.primaryColor;

  /** Selected via "Settings -> My presets" -> "Import from file" (same as user action), tap "Apply". */
  async function importThroughUi(withData: boolean) {
    const repo = new MemoryWorkspaceRepo();
    const files = new FakeFiles();
    const { store } = await renderToolsApp(repo, files, {
      seed: starterAfterGuide,
      locale: 'en',
    });
    await screen.findByTestId('nav-settings');
    const uri = `file:///picked/${entry.file}`;
    files.pickedTexts.set(uri, readFileSync(join(DIR, entry.file), 'utf8'));
    files.nextPick = [{ uri, name: entry.file, size: null, mimeType: 'application/json' }];
    // Ask how to import first (import to home / create new app), then preview, and tap "Apply".
    jest
      .spyOn(Alert, 'alert')
      .mockImplementationOnce(
        (_title, _message, buttons) => void buttons?.[mode === 'home' ? 0 : 1]?.onPress?.(),
      )
      .mockImplementationOnce((_title, _message, buttons) => void buttons?.[1]?.onPress?.());
    await act(() => router.push('/presets'));
    await fireEvent.press(await screen.findByTestId('preset-add'));
    await fireEvent.press(await screen.findByTestId('preset-import'));
    await waitFor(() =>
      expect(
        mode === 'home'
          ? store.getState().config!.theme.primaryColor
          : store.getState().config!.nav.apps?.[0]?.id,
      ).toBe(mode === 'home' ? readTheme() : entry.id),
    );
    const config = store.getState().config!;
    const filled = withData ? await fillTables(repo, config, ownedTable) : null;
    return { repo, store, config, filled };
  }

  async function visitEverything(withData: boolean, how: 'app' | 'home' = 'app') {
    mode = how;
    const { repo, store, config, filled } = await importThroughUi(withData);
    const healthy = () => {
      const s = store.getState();
      expect(s.status).toBe('ready');
      expect(s.renderAttempt).toBe(0);
      expect(errors).toEqual([]);
    };
    const home = config.containers.pages.find((p) => p.id === 'home')!;
    let bar: readonly string[];
    if (mode === 'app') {
      // Import is a version (undoable in change history), and an entry point to this App appears on the home screen.
      expect(JSON.stringify(home.blocks)).toContain(`app:${entry.id}`);
      healthy();
      // Entering this App: every item in the bottom bar.
      await act(async () => store.getState().enterApp(entry.id));
      bar = config.nav.apps!.find((a) => a.id === entry.id)!.bar;
    } else {
      // Import home: style switched to its style, no app was created, its pages entered the home screen navigation bar.
      expect(config.nav.apps).toBeUndefined();
      expect(config.theme.primaryColor).toBe(readTheme());
      expect(config.nav.bar.some((t) => t.startsWith('page:') && t !== 'page:home')).toBe(true);
      healthy();
      bar = config.nav.bar;
    }
    await screen.findByTestId(`nav-${bar[0]}`);
    for (const target of bar) {
      await fireEvent.press(await screen.findByTestId(`nav-${target}`));
      healthy();
      if (target === 'ai') await act(async () => router.back());
    }

    // Each page of this App (a page for a single record takes that single record).
    let n = 0;
    for (const page of config.containers.pages.filter(ownedPage)) {
      let params: Record<string, string> = { pageId: page.id };
      if (page.of !== undefined) {
        let id = filled?.get(page.of)?.[0];
        if (!id) {
          id = `rec${String(++n).padStart(5, '0')}`;
          await repo.insertRecord({
            id,
            collectionId: page.of,
            values: {},
            createdAt: 1,
            updatedAt: 1,
          } as DataRecord);
        }
        params = { ...params, record: id };
      }
      await act(async () => router.push({ pathname: '/page/[pageId]', params }));
      healthy();
      expect(screen.queryAllByTestId('editable-scroll').length).toBeGreaterThan(0);
      await act(async () => router.back());
    }

    // New record page for each table; opens the first record if data is present.
    for (const table of config.data.tables.filter(ownedTable)) {
      await act(async () =>
        router.push({ pathname: '/record/[collectionId]', params: { collectionId: table.id } }),
      );
      healthy();
      await act(async () => router.back());
      const first = filled?.get(table.id)?.[0];
      if (first) {
        await act(async () =>
          router.push({
            pathname: '/record/[collectionId]',
            params: { collectionId: table.id, recordId: first },
          }),
        );
        healthy();
        await act(async () => router.back());
      }
    }
  }

  it('imports from the data screen as one new app and renders everything when it is empty', async () => {
    await visitEverything(false);
  });

  it('renders everything when every table has entries (lists, charts, formulas, calendars)', async () => {
    await visitEverything(true);
  });

  it('imports into the home page from the data screen and renders everything (empty)', async () => {
    await visitEverything(false, 'home');
  });

  it('imports into the home page and renders everything with entries', async () => {
    await visitEverything(true, 'home');
  });
});

describe('restore the original look (D-485)', () => {
  const entry = manifest.apps.find((a) => a.id === 'habits')!;
  afterEach(() => jest.restoreAllMocks());

  it('long-press an imported app in Settings and restore it; a hand-made app has no such item', async () => {
    const repo = new MemoryWorkspaceRepo();
    const files = new FakeFiles();
    const { store } = await renderToolsApp(repo, files, { seed: starterAfterGuide, locale: 'en' });
    await screen.findByTestId('nav-settings');
    const uri = `file:///picked/${entry.file}`;
    files.pickedTexts.set(uri, readFileSync(join(DIR, entry.file), 'utf8'));
    files.nextPick = [{ uri, name: entry.file, size: null, mimeType: 'application/json' }];
    jest
      .spyOn(Alert, 'alert')
      .mockImplementationOnce((_t, _m, buttons) => void buttons?.[1]?.onPress?.())
      .mockImplementationOnce((_t, _m, buttons) => void buttons?.[1]?.onPress?.());
    await act(() => router.push('/presets'));
    await fireEvent.press(await screen.findByTestId('preset-add'));
    await fireEvent.press(await screen.findByTestId('preset-import'));
    await waitFor(() => expect(store.getState().config!.nav.apps?.[0]?.id).toBe('habits'));
    const original = store.getState().config!.nav.apps![0]!;

    // The user modified it: deleted a page, changed style, or renamed it.
    await act(async () => {
      await store.getState().proposeOps(
        [
          { op: 'removeContainer', page: 'habits-insights' },
          { op: 'setTheme', app: 'habits', primaryColor: '#000000' },
          { op: 'updateContainer', app: { id: 'habits', name: 'Changed' } },
        ],
        'edit',
      );
      await store.getState().confirm();
    });
    expect(store.getState().config!.nav.apps![0]!.name).toBe('Changed');

    // Long-press this App: the menu includes "Restore to original appearance"; tap it, then tap "Apply" in the preview.
    jest
      .spyOn(Alert, 'alert')
      .mockImplementationOnce((_t, _m, buttons) => void buttons?.[1]?.onPress?.());
    await act(async () => router.back());
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await fireEvent(await screen.findByTestId('settings-app-habits'), 'longPress');
    await fireEvent.press(await screen.findByText('Restore its original look'));
    await waitFor(() => expect(store.getState().config!.nav.apps![0]!.name).toBe(original.name));
    const after = store.getState().config!;
    expect(after.nav.apps![0]!.theme).toEqual(original.theme);
    expect(after.containers.pages.some((p) => p.id === 'habits-insights')).toBe(true);
    // All tables with records are still present.
    expect(after.data.tables.filter((t) => t.app === 'habits').length).toBeGreaterThan(0);

    // Apps not imported from a file (created manually here) do not have this item.
    await act(async () => {
      await store
        .getState()
        .proposeOps([{ op: 'addContainer', app: { id: 'mine', name: 'Mine' } }], 'add');
      await store.getState().confirm();
    });
    await fireEvent(await screen.findByTestId('settings-app-mine'), 'longPress');
    await screen.findByText('Share this app');
    expect(screen.queryByText('Restore its original look')).toBeNull();
  });
});

import {
  applyOps,
  createDefaultWorkspace,
  createMockAIProvider,
  type Collection,
  type WorkspaceConfig,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router, Stack } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AISettingsProvider } from '../ai/context';
import { createAISettingsStore } from '../ai/settings';
import HistoryRoute from '../app/history';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { loadAssetUsage } from '../storage/asset-uses';
import { findRevisionTables } from '../storage/revision-pages';
import type { WorkspaceRepo } from '../storage/types';
import { FakeFiles } from '../test-utils/fake-files';
import { sqliteRepo } from '../test-utils/node-sqlite';
import { acceptNextAlert, testRegistry } from '../test-utils/render-app';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore } from '../workspace/store';

// R02 (Invariant 7): Change history can always return to any earlier point. History pages have 50
// items per page, scrolling down can reach the very first version; "Settings -> Data" to retrieve
// tables moved out of the interface and storage view for files used in old versions must also read
// the entire history rather than only the latest thousand.

const books: Collection = {
  id: 'books',
  name: '书',
  fields: [{ id: 'title', name: '书名', type: 'text' }],
};

/** First version: has a "Books" table and an entry pointing to oldfile; subsequent versions are blank workspaces (having removed them). */
function firstConfig(): WorkspaceConfig {
  const result = applyOps(
    createDefaultWorkspace('zh'),
    [
      { op: 'addData', table: books },
      {
        op: 'addContainer',
        page: 'home',
        block: { id: 'lease', look: 'entry', show: { title: '合同' }, opens: { file: 'oldfile' } },
      },
    ],
    { registry: testRegistry, locale: 'zh' },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

async function fill(repo: WorkspaceRepo, count: number) {
  let baseId: number | null = null;
  for (let n = 1; n <= count; n++) {
    const r = await repo.commitRevision({
      baseId,
      config: n === 1 ? firstConfig() : createDefaultWorkspace('zh'),
      source: 'user',
      summary: `v${n}`,
    });
    baseId = r.id;
  }
}

describe.each([
  ['memory', async () => new MemoryWorkspaceRepo()],
  ['SQLite', sqliteRepo],
] as const)('listRevisions pagination (%s)', (_name, make: () => Promise<WorkspaceRepo>) => {
  it('beforeId retrieves earlier items with newer ones first, continuing until none remain', async () => {
    const repo = await make();
    await fill(repo, 120);
    const ids = async (limit: number, before?: number) =>
      (await repo.listRevisions(limit, before)).map((r) => r.id);
    expect(await ids(50)).toEqual(Array.from({ length: 50 }, (_, i) => 120 - i));
    expect(await ids(50, 71)).toEqual(Array.from({ length: 50 }, (_, i) => 70 - i));
    expect(await ids(50, 21)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
    expect(await ids(50, 1)).toEqual([]);
  });
});

describe('After over a thousand versions, the earliest version is still retrievable', () => {
  it('Retrieve table structure present only in the first version', async () => {
    const repo = new MemoryWorkspaceRepo();
    await fill(repo, 1100);
    const found = await findRevisionTables(repo, new Set(['books', 'nothing']));
    expect([...found.keys()]).toEqual(['books']);
    expect(found.get('books')!.fields.map((f) => f.id)).toEqual(['title']);
  });

  it('Stop reading further back once retrieval is complete (stops when all are found)', async () => {
    const repo = new MemoryWorkspaceRepo();
    await fill(repo, 30);
    const list = jest.spyOn(repo, 'listRevisions');
    expect((await findRevisionTables(repo, new Set())).size).toBe(0);
    expect(list).not.toHaveBeenCalled();
  });

  it('Storage: files used only in the first version are marked as "Used in old version"', async () => {
    const repo = new MemoryWorkspaceRepo();
    await fill(repo, 1100);
    const config = (await repo.getHead())!.config as WorkspaceConfig;
    const { usage, tables } = await loadAssetUsage(repo, config, ['oldfile', 'neverused']);
    expect(usage.get('oldfile')).toMatchObject({ uses: [], inOldVersions: true });
    expect(usage.get('neverused')).toMatchObject({ uses: [], inOldVersions: false });
    expect(tables.has('books')).toBe(true);
  });
});

describe('Change history page', () => {
  async function renderHistory(count: number) {
    const repo = new MemoryWorkspaceRepo();
    await fill(repo, count);
    const aiSettings = createAISettingsStore({
      secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined },
      serverAvailable: false,
    });
    await aiSettings.getState().load();
    const files = new FakeFiles();
    const store = createWorkspaceStore({
      repo,
      provider: createMockAIProvider(),
      registry: testRegistry,
      locale: 'zh',
      now: () => new Date(2026, 9, 22, 9, 0),
    });
    await store.getState().boot();
    await renderRouter({
      _layout: () => (
        <AISettingsProvider store={aiSettings}>
          <WorkspaceProvider value={{ store, repo, files, registry: testRegistry, locale: 'zh' }}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <Stack />
            </GestureHandlerRootView>
          </WorkspaceProvider>
        </AISettingsProvider>
      ),
      index: () => null,
      history: HistoryRoute,
    });
    // Entered from settings: has a page to go back to (returns to settings after restoring an old version).
    await act(() => router.push('/history'));
    return { store, repo };
  }

  it('Few versions: no "Load more" button', async () => {
    await renderHistory(5);
    expect(await screen.findByTestId('revision-1')).toBeTruthy();
    expect(screen.queryByTestId('history-more')).toBeNull();
  });

  it('120 versions: displays the latest 50 first, tap "Load more" to scroll down to the first version and return to it', async () => {
    const { store } = await renderHistory(120);
    expect(await screen.findByTestId('revision-120')).toBeTruthy();
    expect(screen.getByTestId('revision-71')).toBeTruthy();
    expect(screen.queryByTestId('revision-70')).toBeNull();
    await fireEvent.press(screen.getByTestId('history-more'));
    expect(await screen.findByTestId('revision-70')).toBeTruthy();
    expect(screen.getByTestId('revision-21')).toBeTruthy();
    expect(screen.queryByTestId('revision-20')).toBeNull();
    await fireEvent.press(screen.getByTestId('history-more'));
    expect(await screen.findByTestId('revision-1')).toBeTruthy();
    // No more buttons once pagination is complete.
    expect(screen.queryByTestId('history-more')).toBeNull();

    // The earliest version has the "Books" table; current one does not. Reverting to it appends a new version, preserving all existing ones.
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(false);
    acceptNextAlert();
    await fireEvent.press(screen.getByTestId('restore-1'));
    await waitFor(() => expect(store.getState().head!.id).toBe(121));
    expect(store.getState().head!.source).toBe('restore');
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(true);
    expect((await store.getState().listRevisions(1))[0]!.id).toBe(121);
  });
});

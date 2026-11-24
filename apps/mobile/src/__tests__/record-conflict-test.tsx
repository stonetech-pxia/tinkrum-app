import {
  applyOps,
  createDefaultWorkspace,
  createMockAIProvider,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Alert, type AlertButton } from 'react-native';

import { useRecordActions } from '../data/records';
import { MemoryWorkspaceRepo } from '../storage/memory';
import type { StoredRecord, WorkspaceRepo } from '../storage/types';
import { FakeFiles } from '../test-utils/fake-files';
import { sqliteRepo } from '../test-utils/node-sqlite';
import { renderToolsApp, testRegistry } from '../test-utils/render-app';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore } from '../workspace/store';

// R05: after a form opens, if the same record is modified by another entry point (notification
// button, home screen widget, another page)—it cannot be silently overwritten with old values upon
// saving. At the storage layer, conditional writes are performed based on "values when opened"; on
// conflict, let the user choose: keep my edits / use latest / cancel (decided by founder
// 2026-11-07).

const tasks: Collection = {
  id: 'tasks',
  name: '任务',
  fields: [
    { id: 'name', name: '名字', type: 'text' },
    { id: 'count', name: '次数', type: 'number' },
    { id: 'note', name: '备注', type: 'text' },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(createDefaultWorkspace(locale), [{ op: 'addData', table: tasks }], {
    registry,
    locale,
  });
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const opened = (values: Record<string, unknown> = { name: '跑步', count: 2 }) => ({
  id: 'run00001',
  collectionId: 'tasks',
  values,
  createdAt: 1,
  updatedAt: 1,
});

describe.each([
  ['memory', async () => new MemoryWorkspaceRepo()],
  ['SQLite', sqliteRepo],
] as const)('updateRecordIfUnchanged (%s)', (_name, make: () => Promise<WorkspaceRepo>) => {
  it('Values match opening state: write; different key order is not considered a change', async () => {
    const repo = await make();
    await repo.insertRecord(opened({ name: '跑步', count: 2 }));
    const result = await repo.updateRecordIfUnchanged(
      'run00001',
      { count: 2, name: '跑步' },
      { name: '慢跑', count: 2 },
      5,
    );
    expect(result).toBe('updated');
    expect(await repo.getRecord('run00001')).toMatchObject({
      values: { name: '慢跑', count: 2 },
      updatedAt: 5,
    });
  });

  it('Values have already been modified: do not write, leave as is', async () => {
    const repo = await make();
    await repo.insertRecord(opened());
    await repo.updateRecord('run00001', { name: '跑步', count: 3 }, 2);
    const result = await repo.updateRecordIfUnchanged(
      'run00001',
      { name: '跑步', count: 2 },
      { name: '慢跑', count: 2 },
      5,
    );
    expect(result).toBe('conflict');
    expect(await repo.getRecord('run00001')).toMatchObject({
      values: { name: '跑步', count: 3 },
      updatedAt: 2,
    });
  });

  it('Record already deleted (in recently deleted) or does not exist: gone, do not write', async () => {
    const repo = await make();
    await repo.insertRecord(opened());
    await repo.deleteRecord('run00001', 9);
    expect(await repo.updateRecordIfUnchanged('run00001', opened().values, { name: 'x' }, 5)).toBe(
      'gone',
    );
    expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '跑步', count: 2 });
    expect(await repo.updateRecordIfUnchanged('nothere1', {}, { name: 'x' }, 5)).toBe('gone');
  });
});

async function hookSetup() {
  const repo = new MemoryWorkspaceRepo();
  await repo.commitRevision({
    baseId: null,
    config: seed('zh', testRegistry),
    source: 'user',
    summary: 'seed',
  });
  await repo.insertRecord(opened());
  const store = createWorkspaceStore({
    repo,
    registry: testRegistry,
    provider: createMockAIProvider(),
    locale: 'zh',
    now: () => new Date(),
  });
  await store.getState().boot();
  const files = new FakeFiles();
  const hook = await renderHook(() => useRecordActions(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceProvider value={{ repo, files, store, registry: testRegistry, locale: 'zh' }}>
        {children}
      </WorkspaceProvider>
    ),
  });
  return { repo, hook };
}

describe('Save an existing record', () => {
  it('Form is outdated, modified elsewhere just now: do not overwrite, report conflict with the latest version', async () => {
    const { repo, hook } = await hookSetup();
    const openedRecord = (await repo.getRecord('run00001'))!;
    await repo.updateRecord('run00001', { name: '跑步', count: 3 }, 100);
    let result: Awaited<ReturnType<ReturnType<typeof useRecordActions>['update']>> | undefined;
    await act(async () => {
      result = await hook.result.current.update(tasks, openedRecord, { name: '慢跑' });
    });
    expect(result).toMatchObject({ ok: false, conflict: { values: { name: '跑步', count: 3 } } });
    expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '跑步', count: 3 });
  });

  it('Not modified by anyone: save normally, leave other fields untouched', async () => {
    const { repo, hook } = await hookSetup();
    const openedRecord = (await repo.getRecord('run00001'))!;
    await act(async () => {
      expect(await hook.result.current.update(tasks, openedRecord, { name: '慢跑' })).toEqual({
        ok: true,
        id: 'run00001',
      });
    });
    expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '慢跑', count: 2 });
  });

  it('Toggle on the list (modify single item): update based on current stored version, keep items modified elsewhere up to date', async () => {
    const { repo, hook } = await hookSetup();
    await repo.updateRecord('run00001', { name: '跑步', count: 3 }, 100);
    await act(async () => {
      expect(await hook.result.current.patch(tasks, 'run00001', { note: '下雨' })).toEqual({
        ok: true,
        id: 'run00001',
      });
    });
    expect((await repo.getRecord('run00001'))!.values).toEqual({
      name: '跑步',
      count: 3,
      note: '下雨',
    });
  });

  it('Record deleted while modifying: do not write', async () => {
    const { repo, hook } = await hookSetup();
    const openedRecord = (await repo.getRecord('run00001'))!;
    await repo.deleteRecord('run00001', 9);
    await act(async () => {
      expect(await hook.result.current.update(tasks, openedRecord, { name: '慢跑' })).toEqual({
        ok: false,
        gone: true,
      });
    });
    expect((await repo.getRecord('run00001'))!.values.name).toBe('跑步');
  });
});

describe('Record page: discovered record was just modified elsewhere upon saving', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Open the record page, change name to "Jogging", modify count to 3 elsewhere, then tap save. Returns the popped confirmation dialog. */
  async function conflict(locale: Locale = 'zh') {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord(opened());
    const app = await renderToolsApp(repo, undefined, { locale, seed });
    await act(async () => router.push('/record/tasks?recordId=run00001'));
    await fireEvent.changeText(await screen.findByTestId('editor-name'), '慢跑');
    await repo.updateRecord('run00001', { name: '跑步', count: 3 }, 100);
    let shown: { title: string; buttons: AlertButton[] } | undefined;
    jest.spyOn(Alert, 'alert').mockImplementationOnce((title, _message, buttons) => {
      shown = { title: title ?? '', buttons: buttons ?? [] };
    });
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(() => expect(shown).toBeDefined());
    const press = async (text: string) => {
      await act(async () => shown!.buttons.find((b) => b.text === text)!.onPress?.());
    };
    return { ...app, repo, shown: shown!, press };
  }

  it('Ask first: do not overwrite, three options: keep my changes, use latest, cancel', async () => {
    const { repo, shown } = await conflict();
    expect(shown.title).toBe('这条记录刚被别处改过');
    expect(shown.buttons.map((b) => b.text)).toEqual(['保留我的修改', '用最新的', '取消']);
    expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '跑步', count: 3 });
  });

  it('Use latest: discard my changes, replace form with the latest version, write nothing', async () => {
    const { repo, press } = await conflict();
    await press('用最新的');
    await waitFor(() => expect(screen.getByTestId('editor-name').props.value).toBe('跑步'));
    expect(screen.getByTestId('editor-count').props.value).toBe('3');
    expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '跑步', count: 3 });
  });

  it('Cancel: stay on form, my changes remain, write nothing', async () => {
    const { repo, press } = await conflict();
    await press('取消');
    expect(screen.getByTestId('editor-name').props.value).toBe('慢跑');
    expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '跑步', count: 3 });
  });

  it('French: confirmation dialog is in French', async () => {
    const { shown } = await conflict('fr');
    expect(shown.title).toBe('Cette entrée vient d’être modifiée ailleurs');
    expect(shown.buttons.map((b) => b.text)).toEqual([
      'Garder mes modifications',
      'Utiliser la dernière version',
      'Annuler',
    ]);
  });

  it('Deleted while modifying: report it, nothing stored', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord(opened());
    await renderToolsApp(repo, undefined, { seed });
    await act(async () => router.push('/record/tasks?recordId=run00001'));
    await fireEvent.changeText(await screen.findByTestId('editor-name'), '慢跑');
    await repo.deleteRecord('run00001', 9);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0]![0]).toBe('这条记录在你编辑时被删除了');
    expect(((await repo.getRecord('run00001')) as StoredRecord).values.name).toBe('跑步');
  });

  // Placed last: after saving, the page returns; in test environments the router is global, and returning carries away the next test case's page.
  it('Keep my changes: save only fields I modified, keep modification counts for elsewhere at the latest version', async () => {
    const { repo, press } = await conflict();
    await press('保留我的修改');
    await waitFor(async () =>
      expect((await repo.getRecord('run00001'))!.values).toEqual({ name: '慢跑', count: 3 }),
    );
    // Go back once saved (wait for return before finishing, to prevent the next test case from being affected by its navigation).
    await waitFor(() => expect(screen.queryByTestId('editor-name')).toBeNull());
  });
});

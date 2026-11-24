import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Select multiple items to delete together (D-547): "Settings -> Data", select items to delete on
// each table, enters system-level selection page; prompt before deleting (invariant 11), deleted
// items enter 30-day trash, prompt bar allows undo, individual recovery also available in trash.

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: { id: 'notes', name: '笔记', fields: [{ id: 'title', name: '标题', type: 'text' }] },
      },
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

async function start(titles: string[], locale: Locale = 'zh') {
  const repo = new MemoryWorkspaceRepo();
  for (const [i, title] of titles.entries())
    await repo.insertRecord({
      id: `note${i}aaaa`,
      collectionId: 'notes',
      values: { title },
      createdAt: i + 1,
      updatedAt: i + 1,
    });
  const app = await renderToolsApp(repo, undefined, { seed, locale });
  await screen.findByTestId('nav-settings');
  await act(() => router.push('/data'));
  // One page per table (D-614): deletion selection is within the table page.
  await fireEvent.press(await screen.findByTestId('table-notes'));
  await screen.findByTestId('data-table-screen');
  return app;
}

/** Next prompt: record content, press the button matching label. */
function answerNext(label: string) {
  const asked: {
    title: string | null | undefined;
    message: string | null | undefined;
    buttons: string[];
  } = {
    title: '',
    message: undefined,
    buttons: [],
  };
  jest.spyOn(Alert, 'alert').mockImplementationOnce((title, message, buttons?: AlertButton[]) => {
    asked.title = title;
    asked.message = message;
    asked.buttons = (buttons ?? []).map((b) => b.text ?? '');
    void buttons?.find((b) => b.text === label)?.onPress?.();
  });
  return asked;
}

const alive = async (repo: MemoryWorkspaceRepo) =>
  (await repo.listRecords('notes')).map((r) => r.values.title).sort();

/** Deletion and recovery are asynchronous write steps: let them finish (timers here are mocked). */
async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

afterEach(() => jest.restoreAllMocks());

it('a new user with an empty table is not offered to select', async () => {
  await start([]);
  expect(screen.queryByTestId('select-notes')).toBeNull();
});

it('with data: select two, it asks first; cancel keeps them, delete moves them to the trash, undo brings them back', async () => {
  const { repo, store } = await start(['一', '二', '三']);
  const head = store.getState().head!.id;
  await fireEvent.press(screen.getByTestId('select-notes'));
  expect(await screen.findByTestId('select-records')).toBeTruthy();
  // Delete button disabled when nothing is selected.
  expect(screen.getByTestId('select-delete')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('select-row-note0aaaa'));
  await fireEvent.press(screen.getByTestId('select-row-note2aaaa'));
  expect(screen.getByTestId('select-row-note0aaaa')).toBeChecked();
  expect(screen.getByTestId('select-delete')).toHaveTextContent(/2/);

  const cancelled = answerNext('取消');
  await fireEvent.press(screen.getByTestId('select-delete'));
  expect(cancelled.message).toMatch(/2 条/);
  expect(cancelled.message).not.toMatch(/撤销/);
  expect(await alive(repo)).toEqual(['一', '三', '二'].sort());

  answerNext('删除');
  await fireEvent.press(screen.getByTestId('select-delete'));
  await flush();
  expect(await alive(repo)).toEqual(['二']);
  expect((await repo.listDeletedRecords()).map((r) => r.id).sort()).toEqual([
    'note0aaaa',
    'note2aaaa',
  ]);
  // Deleted items absent from list; prompt bar supports undo.
  expect(screen.queryByTestId('select-row-note0aaaa')).toBeNull();
  expect(await screen.findByTestId('toast')).toHaveTextContent(/已删除 2 条记录/);
  await fireEvent.press(screen.getByTestId('toast-undo'));
  await flush();
  expect(await alive(repo)).toEqual(['一', '三', '二'].sort());
  // Records are not versions: neither deletion nor undo creates new versions.
  expect(store.getState().head!.id).toBe(head);
});

it('deleted ones can be restored one by one in Settings → Data', async () => {
  const { repo } = await start(['一', '二']);
  await fireEvent.press(screen.getByTestId('select-notes'));
  await fireEvent.press(await screen.findByTestId('select-all'));
  answerNext('删除');
  await fireEvent.press(screen.getByTestId('select-delete'));
  await flush();
  expect(await alive(repo)).toEqual([]);
  await act(() => router.back());
  await act(() => router.push('/data-deleted'));
  await fireEvent.press(await screen.findByTestId('restore-record-note1aaaa'));
  await flush();
  expect(await alive(repo)).toEqual(['二']);
});

it('select all toggles back to none, and French uses the singular for one', async () => {
  await start(['un', 'deux'], 'fr');
  await fireEvent.press(screen.getByTestId('select-notes'));
  await fireEvent.press(await screen.findByTestId('select-all'));
  expect(screen.getByTestId('select-row-note1aaaa')).toBeChecked();
  await fireEvent.press(screen.getByTestId('select-all'));
  expect(screen.getByTestId('select-row-note1aaaa')).not.toBeChecked();
  expect(screen.getByTestId('select-delete')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('select-row-note1aaaa'));
  const asked = answerNext('Annuler');
  await fireEvent.press(screen.getByTestId('select-delete'));
  expect(asked.message).toMatch(/1 entrée/);
  expect(asked.message).not.toMatch(/entrées/);
});

import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 选几条一起删（D-547）：「设置 → 数据」每张表上「选几条删除」，进系统层的选择页；
// 删之前先问（底线 11），删了进 30 天的回收站，提示条能撤销，回收站里也能一条条恢复。

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
  // 每张表一页（D-614）：选择删除在表的页面里。
  await fireEvent.press(await screen.findByTestId('table-notes'));
  await screen.findByTestId('data-table-screen');
  return app;
}

/** 下一个提问：记下内容，按 label 那个按钮。 */
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

/** 删除和恢复是几步异步的写：让它们走完（这里的计时器是假的）。 */
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
  // 没选的时候删除按钮不能点。
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
  // 删掉的不在列表里了；提示条能撤销。
  expect(screen.queryByTestId('select-row-note0aaaa')).toBeNull();
  expect(await screen.findByTestId('toast')).toHaveTextContent(/已删除 2 条记录/);
  await fireEvent.press(screen.getByTestId('toast-undo'));
  await flush();
  expect(await alive(repo)).toEqual(['一', '三', '二'].sort());
  // 记录不是版本：删和撤销都不产生新版本。
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

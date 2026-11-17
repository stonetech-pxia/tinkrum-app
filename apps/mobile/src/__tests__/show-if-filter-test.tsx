import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 块只在有符合条件的记录时显示（D-579）：待确认的订阅不在了，提示就不画；只读，不写任何东西（底线 15）。

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'subs',
          name: '订阅',
          fields: [
            { id: 'name', name: '名称', type: 'text' },
            { id: 'paused', name: '暂停', type: 'checkbox' },
          ],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'banner',
          look: 'text',
          show: { text: '有订阅等你确认' },
          showIf: {
            table: 'subs',
            has: 'some',
            filter: [{ field: 'paused', op: 'isNot', value: true }],
          },
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'calm',
          look: 'text',
          show: { text: '都确认过了' },
          showIf: {
            table: 'subs',
            has: 'none',
            filter: [{ field: 'paused', op: 'isNot', value: true }],
          },
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const add = (repo: MemoryWorkspaceRepo, id: string, paused: boolean | undefined) => {
  const at = Date.now();
  return repo.insertRecord({
    id,
    collectionId: 'subs',
    values: { name: id, ...(paused === undefined ? {} : { paused }) },
    createdAt: at,
    updatedAt: at,
  });
};

it('draws the block only while an entry matches the filter, and the none side the other way round', async () => {
  const repo = new MemoryWorkspaceRepo();
  // Only a paused subscription: there are entries, but none matches.
  await add(repo, 's1aaaaaa', true);
  await renderToolsApp(repo, undefined, { seed });
  expect(await screen.findByText('都确认过了')).toBeTruthy();
  expect(screen.queryByText('有订阅等你确认')).toBeNull();
});

it('draws it when an entry that was never touched matches (the checkbox has no stored value)', async () => {
  const repo = new MemoryWorkspaceRepo();
  await add(repo, 's1aaaaaa', true);
  await add(repo, 's2aaaaaa', undefined);
  await renderToolsApp(repo, undefined, { seed });
  expect(await screen.findByText('有订阅等你确认')).toBeTruthy();
  expect(screen.queryByText('都确认过了')).toBeNull();
});

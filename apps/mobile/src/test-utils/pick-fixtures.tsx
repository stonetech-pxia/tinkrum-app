import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import type { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from './render-app';

// 勾选新建（D-613）的测试用的：菜谱、食材、菜谱用料；菜谱页上用料列表下面的「添加食材」是 {do: "createAll", pick: true}。

export const tables: Collection[] = [
  { id: 'recipes', name: '菜谱', fields: [{ id: 'name', name: '名字', type: 'text' }] },
  { id: 'ingredients', name: '食材', fields: [{ id: 'name', name: '名字', type: 'text' }] },
  {
    id: 'recipe-items',
    name: '菜谱用料',
    fields: [
      { id: 'recipe', name: '菜谱', type: 'link', table: 'recipes', required: true },
      { id: 'ingredient', name: '食材', type: 'link', table: 'ingredients' },
      { id: 'amount', name: '用量', type: 'number' },
    ],
  },
];

export const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      ...tables.map((table) => ({ op: 'addData' as const, table })),
      {
        op: 'addContainer' as const,
        page: {
          id: 'recipe',
          title: '菜谱',
          of: 'recipes',
          blocks: [
            {
              id: 'items',
              look: 'list',
              source: {
                table: 'recipe-items',
                filter: [{ field: 'recipe', op: 'is', value: '$record' }],
                limit: 30,
              },
              show: { title: 'ingredient', trailing: 'amount' },
              tools: [
                {
                  as: 'addHere',
                  label: '添加食材',
                  do: 'createAll',
                  table: 'recipe-items',
                  from: 'ingredients',
                  pick: true,
                  values: { ingredient: '$row' },
                },
              ],
            },
          ],
        },
      },
      {
        op: 'addContainer' as const,
        page: 'home',
        block: {
          id: 'recipes',
          look: 'list',
          source: { table: 'recipes', limit: 30 },
          show: { title: 'name' },
          opens: 'recipe',
        },
      },
    ] as never,
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

export const put = (repo: MemoryWorkspaceRepo, id: string, collectionId: string, values: object) =>
  repo.insertRecord({ id, collectionId, values: { ...values }, createdAt: 1, updatedAt: 1 });

/** 首页点菜谱 r1，在它的页面上点「添加食材」，等勾选页面读完。 */
export async function openPicker(repo: MemoryWorkspaceRepo, locale: Locale = 'zh') {
  const { router } = await renderToolsApp(repo, undefined, { seed, locale });
  await screen.findByTestId('record-r1');
  await act(async () => {});
  await fireEvent.press(screen.getByTestId('record-r1'));
  await waitFor(() => expect(router.getPathname()).toBe('/page/recipe'));
  await fireEvent.press(await screen.findByText('添加食材'));
  await waitFor(() => expect(router.getPathname()).toBe('/pick-records'));
  await screen.findByTestId('pick-records');
  await act(async () => {});
  return router;
}

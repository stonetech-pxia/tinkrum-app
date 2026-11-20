import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 单选可以选多个（D-607）：表单里点几项存成列表；列表上按选项顺序显示名字；分段里一条算进它选的每一项；
// 改成多选以前存的一项照样显示，编辑时还在。

const meals: Collection = {
  id: 'meals',
  name: 'Meals',
  fields: [
    { id: 'name', name: 'Name', type: 'text', required: true },
    {
      id: 'days',
      name: 'Days',
      type: 'choice',
      multiple: true,
      options: [
        { id: 'mon', label: 'Monday' },
        { id: 'tue', label: 'Tuesday' },
        { id: 'thu', label: 'Thursday' },
      ],
    },
    { id: 'servings', name: 'Servings', type: 'number' },
  ],
};

const seed = (block: object) => (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData' as const, table: meals },
      { op: 'addContainer' as const, page: 'home', block: block as NewComponent },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const listBlock = (source: object = {}) => ({
  id: 'meals-list',
  look: 'list',
  source: { table: 'meals', limit: 30, ...source },
  show: { title: 'name', subtitles: ['days'] },
  tools: [{ as: 'addHere', do: 'create', table: 'meals', ask: 'all', values: '$here' }],
});

const put = (repo: MemoryWorkspaceRepo, id: string, values: object, at = 1) =>
  repo.insertRecord({
    id,
    collectionId: 'meals',
    values: { ...values },
    createdAt: at,
    updatedAt: at,
  });

it('a new user picks several options in the form and the entry stores them in option order', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, {
    locale: 'en',
    seed: seed(listBlock()),
  });
  await screen.findByTestId('list-add-here');
  await act(() =>
    router.push({ pathname: '/record/[collectionId]', params: { collectionId: 'meals' } }),
  );
  await fireEvent.changeText(await screen.findByTestId('editor-name'), 'Soup');
  await fireEvent.press(screen.getByTestId('editor-days-thu'));
  await fireEvent.press(screen.getByTestId('editor-days-mon'));
  await fireEvent.press(screen.getByTestId('editor-days-tue'));
  // 再点一次去掉。
  await fireEvent.press(screen.getByTestId('editor-days-tue'));
  expect(screen.getByTestId('editor-days-mon')).toBeChecked();
  expect(screen.getByTestId('editor-days-tue')).not.toBeChecked();
  await fireEvent.press(screen.getByTestId('editor-save'));
  await waitFor(async () => expect(await repo.listRecords('meals')).toHaveLength(1));
  const [saved] = await repo.listRecords('meals');
  expect(saved!.values).toEqual({ name: 'Soup', days: ['mon', 'thu'] });
});

it('with data: rows show the labels in option order; sections count an entry in each option', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'soup', { name: 'Soup', days: ['thu', 'mon'] }, 1);
  await put(repo, 'salad', { name: 'Salad', days: ['mon', 'tue', 'thu'] }, 2);
  await put(repo, 'toast', { name: 'Toast' }, 3);
  // 一个后来删掉的选项：不显示，不算。
  await put(repo, 'stew', { name: 'Stew', days: ['gone', 'tue'] }, 4);
  await renderToolsApp(repo, undefined, {
    locale: 'en',
    seed: seed(listBlock({ group: { by: 'days' } })),
  });
  expect(await screen.findByTestId('group-mon')).toHaveTextContent(/Monday.*2/);
  expect(screen.getByTestId('group-tue')).toHaveTextContent(/Tuesday.*2/);
  expect(screen.getByTestId('group-thu')).toHaveTextContent(/Thursday.*2/);
  expect(screen.getByTestId('group-none')).toHaveTextContent(/1/);
  expect(screen.getAllByText('Monday, Thursday').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Monday, Tuesday, Thursday').length).toBeGreaterThan(0);
});

it('a list filtered to one option shows the entries that have it, and adding there picks it', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'soup', { name: 'Soup', days: ['mon', 'thu'] }, 1);
  await put(repo, 'curry', { name: 'Curry', days: ['tue'] }, 2);
  const app = await renderToolsApp(repo, undefined, {
    locale: 'en',
    seed: seed(listBlock({ filter: [{ field: 'days', op: 'is', value: 'thu' }] })),
  });
  expect(await screen.findByText('Soup')).toBeTruthy();
  expect(screen.queryByText('Curry')).toBeNull();
  await act(async () => {});
  await fireEvent.press(screen.getByTestId('list-add-here'));
  await waitFor(() => expect(app.router.getPathname()).toBe('/record/meals'));
  expect(await screen.findByTestId('editor-days-thu')).toBeChecked();
});

it('an entry saved before the field took several options keeps its option when edited', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'old', { name: 'Pasta', days: 'tue' });
  await renderToolsApp(repo, undefined, {
    locale: 'en',
    seed: seed(listBlock()),
  });
  expect(await screen.findByText('Tuesday')).toBeTruthy();
  await act(() =>
    router.push({
      pathname: '/record/[collectionId]',
      params: { collectionId: 'meals', recordId: 'old' },
    }),
  );
  expect(await screen.findByTestId('editor-days-tue')).toBeChecked();
  await fireEvent.press(screen.getByTestId('editor-days-mon'));
  await fireEvent.press(screen.getByTestId('editor-save'));
  await waitFor(async () =>
    expect((await repo.getRecord('old'))?.values.days).toEqual(['mon', 'tue']),
  );
});

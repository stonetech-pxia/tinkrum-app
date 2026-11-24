import {
  applyOps,
  createDefaultWorkspace,
  localDate,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';
import { widgetRowAction } from '../widgets/ops';

// Tap to modify multiple properties of this entry simultaneously (D-566, founder 2026-11-16 ③):
// "Ship" changes status to shipped, sets shipping date to today, and logs an event simultaneously.
// All changes succeed together or none do; banner subsequently shows "Undo" (new invariant 11
// syntax): restores this entry to its original state and deletes the newly created record; if this
// entry was modified during this time, it will not overwrite and will report that it cannot be
// undone. Modifying only a single property still has no undo.

const orders: Collection = {
  id: 'orders',
  name: '订单',
  fields: [
    { id: 'item', name: '商品', type: 'text' },
    {
      id: 'status',
      name: '状态',
      type: 'choice',
      options: [
        { id: 'new', label: '新' },
        { id: 'shipped', label: '已发货' },
      ],
    },
    { id: 'sent', name: '发货日', type: 'date' },
  ],
};
const events: Collection = {
  id: 'events',
  name: '事件',
  fields: [
    { id: 'order', name: '订单', type: 'link', table: 'orders' },
    { id: 'on', name: '日期', type: 'date' },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: orders },
      { op: 'addData', table: events },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'order-list',
          look: 'list',
          source: { table: 'orders', limit: 10 },
          show: { title: 'item' },
          tools: [
            {
              as: 'button',
              label: '发货',
              do: 'set',
              table: 'orders',
              field: 'status',
              value: 'shipped',
              when: [{ field: 'status', op: 'is', value: 'new' }],
              also: [
                { do: 'set', field: 'sent', value: 'today' },
                { do: 'create', table: 'events', values: { order: '$row', on: 'today' } },
              ],
            },
            {
              as: 'button',
              label: '退回',
              do: 'set',
              table: 'orders',
              field: 'status',
              value: 'new',
            },
          ],
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const put = (repo: MemoryWorkspaceRepo, id: string, values: object) =>
  repo.insertRecord({
    id,
    collectionId: 'orders',
    values: { ...values },
    createdAt: 1,
    updatedAt: 1,
  });

async function ship(locale: Locale = 'zh') {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'o1', { item: '台灯', status: 'new' });
  const app = await renderToolsApp(repo, undefined, { seed, locale });
  await act(async () => {});
  await fireEvent.press(await screen.findByTestId('row-action-o1'));
  await screen.findByTestId('toast-undo');
  return { ...app, repo };
}

it('one tap makes all its changes together and offers undo', async () => {
  const { repo } = await ship();
  expect((await repo.getRecord('o1'))?.values).toEqual({
    item: '台灯',
    status: 'shipped',
    sent: localDate(new Date()),
  });
  expect((await repo.listRecords('events')).map((r) => r.values)).toEqual([
    { order: 'o1', on: localDate(new Date()) },
  ]);
  expect(screen.getByTestId('toast')).toHaveTextContent(/发货：已记下/);
});

it('undo puts the entry back exactly and removes the entry the tap created', async () => {
  const { repo } = await ship();
  await fireEvent.press(screen.getByTestId('toast-undo'));
  await waitFor(async () =>
    expect((await repo.getRecord('o1'))?.values).toEqual({ item: '台灯', status: 'new' }),
  );
  expect(await repo.listRecords('events')).toEqual([]);
  // Deleted item is the one created by the tool, does not enter "Recently Deleted" (not user-input content, D-303).
  expect(await repo.listDeletedRecords()).toEqual([]);
});

it('if the entry changed in between, undo does not overwrite it and says so', async () => {
  const { repo } = await ship();
  await repo.updateRecord(
    'o1',
    { item: '台灯（大）', status: 'shipped', sent: '2026-01-01' },
    Date.now(),
  );
  await fireEvent.press(screen.getByTestId('toast-undo'));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/之后又改过，没有撤销/);
  expect((await repo.getRecord('o1'))?.values.item).toBe('台灯（大）');
  expect(await repo.listRecords('events')).toHaveLength(1);
});

it('when one of the writes cannot be made, none is', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'o1', { item: '台灯', status: 'new' });
  await renderToolsApp(repo, undefined, { seed });
  await act(async () => {});
  jest.spyOn(repo, 'applyRecordWrites').mockRejectedValueOnce(new Error('disk write failed'));
  await fireEvent.press(await screen.findByTestId('row-action-o1'));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/一条也没改/);
  expect((await repo.getRecord('o1'))?.values).toEqual({ item: '台灯', status: 'new' });
  expect(await repo.listRecords('events')).toEqual([]);
  jest.restoreAllMocks();
});

it('a tap that changes one thing still shows no undo', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'o1', { item: '台灯', status: 'shipped' });
  await renderToolsApp(repo, undefined, { seed });
  await act(async () => {});
  await fireEvent.press(await screen.findByTestId('row-action-o1'));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/退回：已记下/);
  expect(screen.queryByTestId('toast-undo')).toBeNull();
  expect((await repo.getRecord('o1'))?.values.status).toBe('new');
});

it('French says it could not undo in a whole sentence', async () => {
  const { repo } = await ship('fr');
  await repo.updateRecord('o1', { item: 'x', status: 'shipped' }, Date.now());
  await fireEvent.press(screen.getByTestId('toast-undo'));
  expect(await screen.findByTestId('toast')).toHaveTextContent(
    /Cette entrée a été modifiée depuis : rien n’a été annulé\./,
  );
});

it('a widget opens the app for a tap that makes several changes', () => {
  expect(
    widgetRowAction({
      as: 'tap',
      label: 'x',
      do: 'set',
      table: 'orders',
      field: 'status',
      value: 'shipped',
      also: [{ do: 'set', field: 'sent', value: 'today' }],
    }),
  ).toBeUndefined();
});

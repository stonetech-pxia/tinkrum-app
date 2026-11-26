import {
  applyOps,
  createDefaultWorkspace,
  localDate,
  type Collection,
  type Locale,
  type Op,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router as nav } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';
import { widgetRowAction } from '../widgets/ops';

// Values writable by one-tap record tool (D-565): date calculated from today or this entry's date,
// copy fields of this entry at the moment of tapping (computed ones allowed), add to a numeric
// field of this entry.

const cards: Collection = {
  id: 'cards',
  name: '卡片',
  fields: [
    { id: 'front', name: '正面', type: 'text' },
    { id: 'due', name: '复习日', type: 'date' },
    { id: 'interval', name: '间隔', type: 'number' },
    { id: 'score', name: '分数', type: 'number' },
  ],
};
const products: Collection = {
  id: 'products',
  name: '商品',
  fields: [
    { id: 'name', name: '名字', type: 'text' },
    { id: 'price', name: '价格', type: 'money', currency: 'EUR' },
    { id: 'qty', name: '常买数量', type: 'number' },
    { id: 'gross', name: '含税价', type: 'formula', expression: '{price} * 1.2' },
  ],
};
const orders: Collection = {
  id: 'orders',
  name: '订单',
  fields: [
    { id: 'product', name: '商品', type: 'link', table: 'products' },
    { id: 'what', name: '品名', type: 'note' },
    { id: 'price', name: '价格', type: 'money', currency: 'EUR' },
    { id: 'qty', name: '数量', type: 'number' },
  ],
};

const block = (page: string, b: object): Op => ({ op: 'addContainer', page, block: b }) as Op;

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: cards },
      { op: 'addData', table: products },
      { op: 'addData', table: orders },
      { op: 'addContainer', page: { id: 'product', title: '商品', of: 'products', blocks: [] } },
      block('home', {
        id: 'card-list',
        look: 'list',
        source: { table: 'cards', limit: 10 },
        show: { title: 'front' },
        tools: [
          {
            as: 'button',
            label: '记住了',
            do: 'set',
            table: 'cards',
            field: 'due',
            value: { from: 'today', add: 'interval', unit: 'days' },
            when: [{ field: 'score', op: 'lt', value: 10 }],
          },
          {
            as: 'button',
            label: '加分',
            do: 'increment',
            table: 'cards',
            field: 'score',
            by: 'interval',
          },
        ],
      }),
      block('home', {
        id: 'product-list',
        look: 'list',
        source: { table: 'products', limit: 10 },
        show: { title: 'name' },
        opens: 'product',
        tools: [
          {
            as: 'button',
            label: '下单',
            do: 'create',
            table: 'orders',
            values: {
              product: '$row',
              price: { copy: 'gross' },
              qty: { copy: 'qty' },
              what: { copy: 'name' },
            },
          },
        ],
      }),
      block('product', {
        id: 'order-here',
        look: 'button',
        show: { label: '按现价下单', shape: 'filled' },
        tools: [
          {
            do: 'create',
            table: 'orders',
            values: { product: '$record', price: { copy: 'price' } },
          },
        ],
      }),
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const put = (repo: MemoryWorkspaceRepo, id: string, collectionId: string, values: object) =>
  repo.insertRecord({ id, collectionId, values: { ...values }, createdAt: 1, updatedAt: 1 });

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
};

it('next review = today + this card’s interval, with no undo', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'c1', 'cards', { front: 'chat', interval: 3, score: 2 });
  await renderToolsApp(repo, undefined, { seed });
  await fireEvent.press(await screen.findByTestId('row-action-c1'));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/记住了/);
  expect((await repo.getRecord('c1'))?.values.due).toBe(inDays(3));
  expect(screen.queryByTestId('toast-undo')).toBeNull();
});

it('a card with no interval: nothing is written and the banner says so, not "done"', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'c2', 'cards', { front: 'chien', score: 2 });
  await renderToolsApp(repo, undefined, { seed });
  await fireEvent.press(await screen.findByTestId('row-action-c2'));
  const toast = await screen.findByTestId('toast');
  expect(toast).toHaveTextContent(/什么都没改/);
  expect(toast).not.toHaveTextContent(/记住了/);
  // Unwritten: both value and modification time remain unchanged.
  const stored = await repo.getRecord('c2');
  expect(stored?.values).toEqual({ front: 'chien', score: 2 });
  expect(stored?.updatedAt).toBe(1);
});

it('an order copies the product’s values at the moment of the tap, a computed price included', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'p1', 'products', { name: '咖啡豆', price: 12.5, qty: 2 });
  await renderToolsApp(repo, undefined, { seed });
  await fireEvent.press(await screen.findByTestId('row-action-p1'));
  await screen.findByTestId('toast');
  const [order] = await repo.listRecords('orders');
  expect(order!.values).toEqual({ product: 'p1', price: 15, qty: 2, what: '咖啡豆' });
  // Product price increases later, price on order remains unchanged: copies values, not references.
  await repo.updateRecord('p1', { name: '咖啡豆', price: 20, qty: 2 }, Date.now());
  expect((await repo.getRecord(order!.id))?.values.price).toBe(15);
});

it('a button on a page for one entry links to it ("$record") and copies its fields', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'p1', 'products', { name: '咖啡豆', price: 12.5, qty: 2 });
  const { router } = await renderToolsApp(repo, undefined, { seed });
  await act(async () => {});
  await screen.findByTestId('row-action-p1');
  await act(async () => nav.push('/page/product?record=p1'));
  await waitFor(() => expect(router.getPathname()).toBe('/page/product'));
  await fireEvent.press(await screen.findByText('按现价下单'));
  await waitFor(async () =>
    expect((await repo.listRecords('orders')).map((r) => r.values)).toEqual([
      { product: 'p1', price: 12.5 },
    ]),
  );
});

it('a widget does not run a tool that reads this entry: it opens the app instead', () => {
  expect(
    widgetRowAction({
      as: 'tap',
      label: 'x',
      do: 'increment',
      table: 'cards',
      field: 'score',
      by: 'interval',
    }),
  ).toBeUndefined();
  expect(
    widgetRowAction({
      as: 'tap',
      label: 'x',
      do: 'set',
      table: 'cards',
      field: 'due',
      value: { from: 'today', add: 7, unit: 'days' },
    }),
  ).toBeDefined();
});

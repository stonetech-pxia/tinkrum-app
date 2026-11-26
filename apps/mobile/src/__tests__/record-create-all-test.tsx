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
import { Alert } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';
import { widgetButtonAction } from '../widgets/ops';

// Batch create (D-567, founder 2026-11-16 ④): on the 1st of each month, click "Create this month's
// orders", create an order for each regular customer referencing that customer, copy the customer's
// typical amount (D-565). Ask first, max 200 items; after creation, banner allows undoing this
// entire batch at once (invariant 11).

const customers: Collection = {
  id: 'customers',
  name: '客户',
  fields: [
    { id: 'name', name: '名字', type: 'text' },
    { id: 'regular', name: '老客户', type: 'checkbox' },
    { id: 'usual', name: '常用金额', type: 'money', currency: 'EUR' },
  ],
};
const orders: Collection = {
  id: 'orders',
  name: '订单',
  fields: [
    { id: 'customer', name: '客户', type: 'link', table: 'customers' },
    { id: 'amount', name: '金额', type: 'money', currency: 'EUR' },
    { id: 'on', name: '日期', type: 'date' },
  ],
};
const monthly = {
  do: 'createAll',
  table: 'orders',
  from: 'customers',
  filter: [{ field: 'regular', op: 'is', value: true }],
  values: { customer: '$row', amount: { copy: 'usual' }, on: 'today' },
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: customers },
      { op: 'addData', table: orders },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'monthly',
          look: 'button',
          show: { label: '新建本月订单', shape: 'filled' },
          tools: [monthly as never],
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const put = (repo: MemoryWorkspaceRepo, id: string, collectionId: string, values: object) =>
  repo.insertRecord({ id, collectionId, values: { ...values }, createdAt: 1, updatedAt: 1 });

async function withCustomers(n = 5) {
  const repo = new MemoryWorkspaceRepo();
  for (let i = 1; i <= n; i++)
    await put(repo, `c${i}`, 'customers', { name: `客户${i}`, regular: true, usual: i * 10 });
  await put(repo, 'cx', 'customers', { name: '偶尔', regular: false, usual: 99 });
  return repo;
}

function answer(label: string) {
  const spy = jest.spyOn(Alert, 'alert');
  spy.mockImplementation((_title, _message, buttons) => {
    buttons?.find((b) => b.text === label)?.onPress?.();
  });
  return spy;
}
afterEach(() => jest.restoreAllMocks());

async function press(repo: MemoryWorkspaceRepo, locale: Locale = 'zh') {
  await renderToolsApp(repo, undefined, { seed, locale });
  await act(async () => {});
  await fireEvent.press(await screen.findByText('新建本月订单'));
}

it('asks first with the count, then creates one order per regular customer, copying its amount', async () => {
  const repo = await withCustomers();
  const alert = answer('新建');
  await press(repo);
  expect(alert).toHaveBeenCalledWith(
    '新建本月订单',
    '将在「订单」新建 5 条记录。',
    expect.anything(),
    expect.anything(),
  );
  expect(await screen.findByTestId('toast')).toHaveTextContent(/已在「订单」新建 5 条记录/);
  const created = await repo.listRecords('orders');
  expect(created.map((r) => r.values).sort((a, b) => Number(a.amount) - Number(b.amount))).toEqual(
    [1, 2, 3, 4, 5].map((i) => ({ customer: `c${i}`, amount: i * 10, on: localDate(new Date()) })),
  );
  expect(screen.getByTestId('toast-undo')).toBeTruthy();
});

it('nothing matching, or more than 200, creates nothing', async () => {
  const repo = new MemoryWorkspaceRepo();
  const alert = answer('新建');
  await press(repo);
  expect(await screen.findByTestId('toast')).toHaveTextContent(/没有符合条件的记录，什么都没建/);
  for (let i = 0; i < 201; i++) await put(repo, `m${i}`, 'customers', { regular: true });
  await fireEvent.press(screen.getByText('新建本月订单'));
  expect(alert).toHaveBeenCalledWith('新建本月订单', '一次最多新建 200 条，这次会新建 201 条。');
  expect(await repo.listRecords('orders')).toEqual([]);
});

it('French and one entry use the singular', async () => {
  const repo = await withCustomers(1);
  const alert = answer('Créer');
  await press(repo, 'fr');
  expect(alert).toHaveBeenCalledWith(
    '新建本月订单',
    'Cela crée 1 entrée dans « 订单 ».',
    expect.anything(),
    expect.anything(),
  );
});

it('cancelling creates nothing', async () => {
  const repo = await withCustomers();
  answer('取消');
  await press(repo);
  await act(async () => {});
  expect(await repo.listRecords('orders')).toEqual([]);
});

it('undo removes exactly the entries this batch created', async () => {
  const repo = await withCustomers(3);
  await put(repo, 'o0', 'orders', { amount: 1 });
  answer('新建');
  await press(repo);
  await fireEvent.press(await screen.findByTestId('toast-undo'));
  await waitFor(async () =>
    expect((await repo.listRecords('orders')).map((r) => r.id)).toEqual(['o0']),
  );
  expect(await repo.listDeletedRecords()).toEqual([]);
});

it('if one of them was edited since, undo removes none and says so', async () => {
  const repo = await withCustomers(2);
  answer('新建');
  await press(repo);
  await screen.findByTestId('toast-undo');
  const [first] = await repo.listRecords('orders');
  await repo.updateRecord(first!.id, { ...first!.values, amount: 77 }, Date.now());
  await fireEvent.press(screen.getByTestId('toast-undo'));
  await waitFor(() =>
    expect(screen.getByTestId('toast')).toHaveTextContent(/其中有记录之后又改过，一条也没有撤销/),
  );
  expect(await repo.listRecords('orders')).toHaveLength(2);
});

it('a widget opens the app for it (it has to ask first)', () => {
  expect(
    widgetButtonAction({
      id: 'b',
      look: 'button',
      show: { label: 'x', shape: 'filled' },
      tools: [monthly],
    } as never),
  ).toBeNull();
});

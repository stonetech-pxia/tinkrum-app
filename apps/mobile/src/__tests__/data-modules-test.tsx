import {
  applyOps,
  createDefaultWorkspace,
  formatNumber,
  formatValue,
  localDate,
  type Collection,
  type NewComponent,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { statText } from '../renderer/data';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// New capability for data components: group statistics by options (D-248). Records are read locally only, and components only reference tables and fields.

const expenses: Collection = {
  id: 'expenses',
  name: '账目',
  fields: [
    { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
    {
      id: 'category',
      name: '分类',
      type: 'choice',
      options: [
        { id: 'food', label: '餐饮' },
        { id: 'transport', label: '交通' },
        { id: 'fun', label: '娱乐' },
      ],
    },
    { id: 'date', name: '日期', type: 'date' },
  ],
};

/** Place these components on the home screen using the expenses table. */
const seedWith =
  (...components: NewComponent[]) =>
  (locale: Locale, registry: Registry) => {
    const result = applyOps(
      createDefaultWorkspace(locale),
      [
        { op: 'addData', table: expenses },
        ...components.map((block) => ({
          op: 'addContainer' as const,
          page: 'home',
          block,
        })),
      ],
      { registry, locale },
    );
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };

async function withRecords(values: Record<string, unknown>[]) {
  const repo = new MemoryWorkspaceRepo();
  for (const [i, v] of values.entries()) {
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'expenses',
      values: v,
      createdAt: i,
      updatedAt: i,
    });
  }
  return repo;
}

describe('stat grouped by a choice field', () => {
  it('shows one row per option, in option order, plus the entries without a category', async () => {
    const repo = await withRecords([
      { amount: 30, category: 'food', date: '2026-10-20' },
      { amount: 12.5, category: 'food', date: '2026-10-21' },
      { amount: 4, category: 'transport', date: '2026-10-21' },
      { amount: 99, date: '2026-10-22' },
    ]);
    await renderToolsApp(repo, undefined, {
      seed: seedWith({
        id: 'by-category',
        look: 'number',
        show: { label: '按分类' },
        source: {
          table: 'expenses',
          aggregate: 'sum',
          field: 'amount',
          group: { by: 'category' },
        },
      }),
    });
    expect((await screen.findByTestId('stat-group-expenses-food')).props.children).toBe('¥42.50');
    expect(screen.getByTestId('stat-group-expenses-transport').props.children).toBe('¥4.00');
    // Options with no records are also listed (totaling 0).
    expect(screen.getByTestId('stat-group-expenses-fun').props.children).toBe('¥0.00');
    expect(screen.getByTestId('stat-group-expenses-none').props.children).toBe('¥99.00');
    expect(screen.getByText('未选')).toBeTruthy();
  });

  it('a new user with no entries sees every option at zero', async () => {
    await renderToolsApp(new MemoryWorkspaceRepo(), undefined, {
      seed: seedWith({
        id: 'by-category',
        look: 'number',
        show: { label: '笔数' },
        source: { table: 'expenses', aggregate: 'count', group: { by: 'category' } },
      }),
    });
    expect((await screen.findByTestId('stat-group-expenses-food')).props.children).toBe('0');
    expect(screen.queryByTestId('stat-group-expenses-none')).toBeNull();
  });
});

describe('chart (D-249)', () => {
  // Charts calculate recent periods relative to the real current date: record dates are also evaluated relative to today.
  const daysAgo = (n: number) => {
    const d = new Date();
    return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
  };
  const label = (n: number) => daysAgo(n).slice(5);

  it('bar chart of the last 7 days: today is read out, tapping a bar reads that day', async () => {
    const repo = await withRecords([
      { amount: 30, category: 'food', date: daysAgo(0) },
      { amount: 12, category: 'food', date: daysAgo(2) },
      { amount: 8, category: 'transport', date: daysAgo(2) },
      { amount: 500, category: 'fun', date: daysAgo(30) },
    ]);
    await renderToolsApp(repo, undefined, {
      seed: seedWith({
        id: 'week',
        look: 'chart',
        show: { kind: 'bar', title: '最近 7 天' },
        source: {
          table: 'expenses',
          aggregate: 'sum',
          field: 'amount',
          group: { by: 'date', unit: 'day' },
        },
      }),
    });
    const readout = await screen.findByTestId('chart-readout-expenses');
    expect(readout.props.children).toBe(`${label(0)}：¥30.00`);
    expect(screen.getByLabelText(`${label(2)}：¥20.00`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('chart-bar-4'));
    expect(screen.getByTestId('chart-readout-expenses').props.children).toBe(`${label(2)}：¥20.00`);
  });

  it('pie chart lists every category with its share, so color is not the only cue', async () => {
    const repo = await withRecords([
      { amount: 30, category: 'food' },
      { amount: 10, category: 'transport' },
    ]);
    await renderToolsApp(repo, undefined, {
      seed: seedWith({
        id: 'share',
        look: 'chart',
        show: { kind: 'pie', title: '花在哪里' },
        source: {
          table: 'expenses',
          aggregate: 'sum',
          field: 'amount',
          group: { by: 'category' },
        },
      }),
    });
    expect(await screen.findByText('¥30.00（75%）')).toBeTruthy();
    expect(screen.getByText('¥10.00（25%）')).toBeTruthy();
    // Categories with no records are not rendered.
    expect(screen.queryByTestId('chart-slice-fun')).toBeNull();
  });

  it('a new user sees a short note instead of an empty plot', async () => {
    await renderToolsApp(new MemoryWorkspaceRepo(), undefined, {
      seed: seedWith({
        id: 'trend',
        look: 'chart',
        show: { kind: 'line', title: '每月笔数' },
        source: {
          table: 'expenses',
          aggregate: 'count',
          group: { by: 'date', unit: 'month' },
        },
      }),
    });
    expect(await screen.findByText('还没有可以显示的记录')).toBeTruthy();
    expect(screen.queryByTestId('chart-point-0')).toBeNull();
  });
});

describe('link to another table (D-250)', () => {
  const clients: Collection = {
    id: 'clients',
    name: '客户',
    fields: [{ id: 'name', name: '名字', type: 'text' }],
  };
  const orders: Collection = {
    id: 'orders',
    name: '订单',
    fields: [
      { id: 'item', name: '商品', type: 'text' },
      { id: 'client', name: '客户', type: 'link', table: 'clients' },
    ],
  };
  const seed = (locale: Locale, registry: Registry) => {
    const result = applyOps(
      createDefaultWorkspace(locale),
      [
        { op: 'addData', table: clients },
        { op: 'addData', table: orders },
        {
          op: 'addContainer',
          page: 'home',
          block: {
            id: 'order-list',
            look: 'list',
            source: { table: 'orders', limit: 20 },
            show: { title: 'item', subtitles: ['client'] },
          },
        },
        {
          op: 'addContainer',
          page: 'home',
          block: {
            id: 'add-order',
            look: 'form',
            show: { mode: 'inline' },
            tools: [
              {
                as: 'submit',
                label: '记下',
                do: 'create',
                table: 'orders',
                ask: ['item', 'client'],
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

  it('lists the linked client by name, says when it was deleted, and shows it again after undo', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord({
      id: 'c1',
      collectionId: 'clients',
      values: { name: '王小明' },
      createdAt: 1,
      updatedAt: 1,
    });
    await repo.insertRecord({
      id: 'o1',
      collectionId: 'orders',
      values: { item: '书', client: 'c1' },
      createdAt: 2,
      updatedAt: 2,
    });
    const { store } = await renderToolsApp(repo, undefined, { seed });
    expect(await screen.findByText('王小明')).toBeTruthy();

    await repo.deleteRecord('c1', 3);
    store.getState().bumpRecords();
    expect(await screen.findByText('已删除的记录')).toBeTruthy();
    // References within orders are preserved, and customer names reappear after the customer table is restored.
    expect((await repo.listRecords('orders'))[0]!.values.client).toBe('c1');
    await repo.restoreRecord('c1');
    store.getState().bumpRecords();
    expect(await screen.findByText('王小明')).toBeTruthy();
  });

  it('the form picks a client from the other table and stores only its id', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord({
      id: 'c1',
      collectionId: 'clients',
      values: { name: '王小明' },
      createdAt: 1,
      updatedAt: 1,
    });
    await repo.insertRecord({
      id: 'c2',
      collectionId: 'clients',
      values: { name: '李华' },
      createdAt: 2,
      updatedAt: 2,
    });
    await renderToolsApp(repo, undefined, { seed });
    await fireEvent.changeText(await screen.findByTestId('form-add-order-item'), '茶叶');
    await fireEvent.press(screen.getByTestId('form-add-order-client'));
    await fireEvent.press(await screen.findByTestId('form-add-order-client-option-c2'));
    await fireEvent.press(screen.getByTestId('form-add-order-submit'));
    const saved = await repo.listRecords('orders');
    expect(saved.map((r) => r.values)).toEqual([{ item: '茶叶', client: 'c2' }]);
    expect(await screen.findByText('李华')).toBeTruthy();
  });

  it('with an empty client table the picker says so', async () => {
    await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { seed });
    await fireEvent.press(await screen.findByTestId('form-add-order-client'));
    expect(await screen.findByText('「客户」里还没有记录。')).toBeTruthy();
  });
});

// "Add new" in linked fields (D-546): opens the new record page for that table, and upon saving, returns with it selected; cancelling changes nothing.
describe('a new linked record from the picker', () => {
  const clients: Collection = {
    id: 'clients',
    name: '客户',
    fields: [{ id: 'name', name: '名字', type: 'text' }],
  };
  const orders: Collection = {
    id: 'orders',
    name: '订单',
    fields: [
      { id: 'item', name: '商品', type: 'text' },
      { id: 'client', name: '客户', type: 'link', table: 'clients' },
    ],
  };
  const seed = (locale: Locale, registry: Registry) => {
    const result = applyOps(
      createDefaultWorkspace(locale),
      [
        { op: 'addData', table: clients },
        { op: 'addData', table: orders },
        {
          op: 'addContainer',
          page: 'home',
          block: {
            id: 'add-order',
            look: 'form',
            show: { mode: 'inline' },
            tools: [
              {
                as: 'submit',
                label: '记下',
                do: 'create',
                table: 'orders',
                ask: ['item', 'client'],
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

  async function addClientThroughPicker(name: string) {
    await fireEvent.press(await screen.findByTestId('form-add-order-client'));
    await fireEvent.press(await screen.findByTestId('form-add-order-client-new'));
    await fireEvent.changeText(await screen.findByTestId('editor-name'), name);
    await fireEvent.press(screen.getByTestId('editor-save'));
  }

  it('a new user adds the first client from the order form; it is selected and the order keeps its id', async () => {
    const repo = new MemoryWorkspaceRepo();
    await renderToolsApp(repo, undefined, { seed });
    await fireEvent.press(await screen.findByTestId('form-add-order-client'));
    expect(await screen.findByTestId('form-add-order-client-new')).toHaveTextContent(
      '在「客户」里新加一条',
    );
    await fireEvent.press(screen.getByTestId('form-add-order-client'));
    await addClientThroughPicker('赵六');
    const [client] = await repo.listRecords('clients');
    expect(client!.values).toEqual({ name: '赵六' });
    // Return to the order form: the new customer is selected, but the order is not yet saved (saving the order requires a separate click).
    expect(await screen.findByTestId('form-add-order-client')).toHaveTextContent(/赵六/);
    expect(await repo.listRecords('orders')).toEqual([]);
    await fireEvent.changeText(screen.getByTestId('form-add-order-item'), '茶叶');
    await fireEvent.press(screen.getByTestId('form-add-order-submit'));
    expect((await repo.listRecords('orders')).map((r) => r.values)).toEqual([
      { item: '茶叶', client: client!.id },
    ]);
  });

  it('with clients already there, the new one replaces the earlier choice', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord({
      id: 'c1',
      collectionId: 'clients',
      values: { name: '王小明' },
      createdAt: 1,
      updatedAt: 1,
    });
    await renderToolsApp(repo, undefined, { seed });
    await fireEvent.press(await screen.findByTestId('form-add-order-client'));
    await fireEvent.press(await screen.findByTestId('form-add-order-client-option-c1'));
    expect(screen.getByTestId('form-add-order-client')).toHaveTextContent(/王小明/);
    await addClientThroughPicker('李华');
    expect(await screen.findByTestId('form-add-order-client')).toHaveTextContent(/李华/);
    expect(await repo.listRecords('clients')).toHaveLength(2);
  });

  it('works from the full new-record page too: two forms stacked, the first gets the new client', async () => {
    const repo = new MemoryWorkspaceRepo();
    await renderToolsApp(repo, undefined, { seed });
    await screen.findByTestId('form-add-order-client');
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await act(() =>
      router.push({ pathname: '/record/[collectionId]', params: { collectionId: 'orders' } }),
    );
    await screen.findByTestId('editor-save');
    await fireEvent.changeText(await screen.findByTestId('editor-item'), '书');
    await fireEvent.press(screen.getByTestId('editor-client'));
    await fireEvent.press(await screen.findByTestId('editor-client-new'));
    await fireEvent.changeText(await screen.findByTestId('editor-name'), '周七');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('editor-client')).toHaveTextContent(/周七/);
    expect(screen.getByTestId('editor-item').props.value).toBe('书');
    const [client] = await repo.listRecords('clients');
    expect(await repo.listRecords('orders')).toEqual([]);
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect((await repo.listRecords('orders')).map((r) => r.values)).toEqual([
      { item: '书', client: client!.id },
    ]);
  });

  it('leaving the new record form without saving changes nothing', async () => {
    const repo = new MemoryWorkspaceRepo();
    await renderToolsApp(repo, undefined, { seed });
    await fireEvent.press(await screen.findByTestId('form-add-order-client'));
    await fireEvent.press(await screen.findByTestId('form-add-order-client-new'));
    await screen.findByTestId('editor-save');
    await act(() => router.back());
    expect(await screen.findByTestId('form-add-order-client')).toHaveTextContent(/没有选/);
    expect(await repo.listRecords('clients')).toEqual([]);
    expect(await repo.listRecords('orders')).toEqual([]);
  });
});

describe('stat and chart values follow the interface language', () => {
  it('French shows amounts and numbers the way the record list does', () => {
    const money = expenses.fields[0]!;
    const weight = { id: 'kg', name: 'Poids', type: 'number', decimals: 1, unit: 'kg' } as const;
    expect(statText(1234.5, 'sum', money, 'fr')).toBe(formatValue(money, 1234.5, 'fr'));
    expect(statText(1234.5, 'sum', weight, 'fr')).toBe(formatValue(weight, 1234.5, 'fr'));
    expect(statText(1234, 'count', money, 'fr')).toBe(formatNumber(1234, undefined, 'fr'));
  });
});

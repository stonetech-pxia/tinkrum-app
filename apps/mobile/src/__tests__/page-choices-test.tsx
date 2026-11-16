import { applyOps, createDefaultWorkspace, type Locale, type Op, type Registry } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 页面上的一排选项（D-573，创始人 2026-11-16 决定 ② 第二步）：点「待发货」，下面跟着的列表、合计和图表都只剩待发货的；
// 不跟着的照旧；在列表下面添加时新的一条预设成选中的那一项；列表上方的工具交出的是现在显示的记录。什么都不写（底线 15）。

const orders = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'item', name: 'Item', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'number' },
    {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'to-ship', label: 'To ship', color: 'orange' },
        { id: 'shipped', label: 'Shipped' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: orders },
      {
        op: 'addTool',
        tool: {
          id: 'to-excel',
          kind: 'quickAction',
          name: 'To Excel',
          steps: [
            { id: 'x', action: 'records.toExcel', params: {} },
            { id: 's', action: 'out.share', params: {} },
          ],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'sales',
          title: 'Sales',
          blocks: [
            {
              id: 'tabs',
              look: 'choices',
              show: { options: ['to-ship', 'shipped', 'done'] },
              source: { table: 'orders', field: 'status' },
            },
            {
              id: 'following',
              look: 'list',
              source: { table: 'orders', choice: 'page', limit: 30 },
              show: { title: 'item' },
              tools: [
                { as: 'addHere', do: 'create', table: 'orders', ask: 'all', values: '$here' },
                { as: 'list', tool: 'to-excel' },
              ],
            },
            {
              id: 'total',
              look: 'number',
              show: { label: 'Total' },
              source: { table: 'orders', aggregate: 'sum', field: 'amount', choice: 'page' },
            },
            {
              id: 'fixed',
              look: 'cards',
              source: { table: 'orders', limit: 30 },
              show: { title: 'item' },
            },
          ],
        },
      },
    ] as Op[],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(200);
    await Promise.resolve();
  });

async function open(records: Record<string, unknown>[], locale: Locale = 'en') {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  for (const [i, values] of records.entries())
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'orders',
      values,
      createdAt: 100 + i,
      updatedAt: 100 + i,
    });
  const app = await renderToolsApp(repo, undefined, { locale, seed });
  await settle();
  await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'sales' } }));
  await settle();
  return { repo, app };
}

afterEach(() => useGuide.setState({ stage: null, repo: null }));

describe('a row of choices that the blocks of the page follow (D-573)', () => {
  it('no entries: the row opens on All, in the language of the app', async () => {
    await open([], 'fr');
    expect(await screen.findByTestId('choices-all')).toHaveTextContent('Tout');
    expect(screen.getByTestId('choices-all').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('choices-to-ship')).toHaveTextContent('To ship');
    // 字段里有选项写了颜色：每一项前面一个点。
    expect(screen.getByTestId('choices-dot-shipped')).toBeTruthy();
  });

  it('picking an option narrows the list, the total and the list tool; others keep all', async () => {
    const { repo } = await open([
      { item: 'Desk', amount: 100, status: 'to-ship' },
      { item: 'Lamp', amount: 20, status: 'shipped' },
      { item: 'Chair', amount: 50, status: 'to-ship' },
      { item: 'Mug', amount: 5 },
    ]);
    await screen.findByTestId('choices-all');
    expect(screen.getByTestId('stat-value-orders-Total')).toHaveTextContent('175');
    expect(screen.getByTestId('list-tool-count')).toHaveTextContent('All 4 entries in this list');

    await fireEvent.press(screen.getByTestId('choices-to-ship'));
    await settle();
    expect(screen.getByTestId('stat-value-orders-Total')).toHaveTextContent('150');
    expect(screen.getByTestId('list-tool-count')).toHaveTextContent('All 2 entries in this list');
    // 跟着的列表只有待发货的两条；不跟着的卡片四条都在。
    expect(screen.getAllByText('Desk')).toHaveLength(2);
    expect(screen.getAllByText('Lamp')).toHaveLength(1);
    expect(screen.getAllByText('Mug')).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('choices-done'));
    await settle();
    expect(screen.getByTestId('stat-value-orders-Total')).toHaveTextContent('0');
    expect(screen.getAllByText('Desk')).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('choices-all'));
    await settle();
    expect(screen.getByTestId('stat-value-orders-Total')).toHaveTextContent('175');
    // 选来选去什么都不写。
    const stored = await repo.listRecords('orders');
    expect(stored.map((r) => r.updatedAt)).toEqual([100, 101, 102, 103]);
  });

  it('adding under the list while "Shipped" is picked starts the new entry as Shipped', async () => {
    const { repo, app } = await open([{ item: 'Lamp', amount: 20, status: 'shipped' }]);
    await fireEvent.press(await screen.findByTestId('choices-shipped'));
    await settle();
    await fireEvent.press(screen.getByTestId('list-add-here'));
    await waitFor(() => expect(app.router.getPathname()).toBe('/record/orders'));
    expect(JSON.parse(app.router.getSearchParams().prefill as string)).toEqual({
      status: 'shipped',
    });
    await fireEvent.changeText(await screen.findByTestId('editor-item'), 'Rug');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(async () =>
      expect(
        (await repo.listRecords('orders')).find((r) => r.values.item === 'Rug')?.values,
      ).toMatchObject({
        status: 'shipped',
      }),
    );
  });
});

import { applyOps, createDefaultWorkspace, type Locale, type Op, type Registry } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Options row on the page (D-573, founder decision ② second step, 2026-11-16): tap "Pending
// shipment", and the list, totals, and charts that follow it are filtered to only show "Pending
// shipment"; unrelated ones remain as they are; when adding below a list, a new entry is preset to
// the selected option; the tools above the list output the currently displayed records. Doing
// nothing writes nothing (invariant 15).

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
        op: 'addData',
        table: {
          id: 'big',
          name: 'Big',
          fields: [
            { id: 'title', name: 'Title', type: 'text' },
            {
              id: 'kind',
              name: 'Kind',
              type: 'choice',
              options: Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, label: `Kind ${i}` })),
            },
          ],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'many',
          title: 'Many',
          blocks: [
            { id: 'kinds', look: 'choices', show: {}, source: { table: 'big', field: 'kind' } },
          ],
        },
      },
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
    // An option in the field has a color specified: a dot in front of each item.
    expect(screen.getByTestId('choices-dot-shipped')).toBeTruthy();
  });

  it('a few options wrap; many options sit on one line that scrolls sideways', async () => {
    await open([]);
    await screen.findByTestId('choices-all');
    expect(screen.queryByTestId('choices-scroll')).toBeNull();
    await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'many' } }));
    await settle();
    expect(await screen.findByTestId('choices-scroll')).toBeTruthy();
    expect(screen.getByTestId('choices-k11')).toHaveTextContent('Kind 11');
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
    // The following list has only the two "Pending shipment" items; all four cards that do not follow it are present.
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
    // Selecting and unselecting writes nothing.
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

import * as core from '@morph/core';
import {
  applyOps,
  createDefaultWorkspace,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { tableVersion } from '../data/records';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Refresh by table (D-555): a block re-reads and recalculates only after its read tables (its own
// table, plus lookup, rollup, previous, reference tables) have been written; multiple blocks
// reading the same table on the same page share a single computation (sharing only the active
// computation, like readTable). Unidentified table writes (restore, undo deletion, bulk delete,
// import) re-trigger everything as before: better slow than stale.

jest.mock('@morph/core', () => {
  const actual = jest.requireActual('@morph/core');
  return { ...actual, loadComputedRecords: jest.fn(actual.loadComputedRecords) };
});
const computed = core.loadComputedRecords as jest.Mock;

const tables = [
  {
    id: 'tasks',
    name: '任务',
    fields: [
      { id: 'title', name: '标题', type: 'text' },
      { id: 'n', name: 'n', type: 'number' },
    ],
  },
  { id: 'other', name: '别的', fields: [{ id: 'title', name: '标题', type: 'text' }] },
  {
    id: 'customers',
    name: '客户',
    fields: [
      { id: 'name', name: '名字', type: 'text' },
      {
        id: 'total',
        name: '合计',
        type: 'rollup',
        table: 'orders',
        via: 'customer',
        aggregate: 'sum',
        field: 'amount',
      },
    ],
  },
  {
    id: 'orders',
    name: '订单',
    fields: [
      { id: 'item', name: '商品', type: 'text' },
      { id: 'amount', name: '金额', type: 'number' },
      { id: 'customer', name: '客户', type: 'link', table: 'customers' },
    ],
  },
];

// Six blocks reading tasks (half lists, half numbers), plus one list per other table.
const blocks: NewComponent[] = [
  ...Array.from({ length: 6 }, (_, i) =>
    i % 2 === 0
      ? {
          id: `l${i}`,
          look: 'list',
          source: { table: 'tasks', limit: 30 },
          show: { title: 'title' },
        }
      : {
          id: `s${i}`,
          look: 'number',
          source: { table: 'tasks', aggregate: 'count' },
          show: { label: `数${i}` },
        },
  ),
  { id: 'other-list', look: 'list', source: { table: 'other' }, show: { title: 'title' } },
  {
    id: 'customer-list',
    look: 'list',
    source: { table: 'customers' },
    show: { title: 'name', subtitles: ['total'] },
  },
  {
    id: 'order-list',
    look: 'list',
    source: { table: 'orders' },
    show: { title: 'item', subtitles: ['customer'] },
  },
] as never;

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      ...tables.map((table) => ({ op: 'addData', table }) as never),
      ...blocks.map((block) => ({ op: 'addContainer' as const, page: 'home', block })),
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config as never;
};

const rec = (id: string, collectionId: string, values: Record<string, unknown>, at = 1) => ({
  id,
  collectionId,
  values,
  createdAt: at,
  updatedAt: at,
});

async function start() {
  const repo = new MemoryWorkspaceRepo();
  for (let i = 0; i < 5; i++)
    await repo.insertRecord(rec(`task${i}aaaa`, 'tasks', { title: `t${i}`, n: i }, i));
  await repo.insertRecord(rec('other0aaaa', 'other', { title: 'o0' }));
  await repo.insertRecord(rec('cust1aaaaa', 'customers', { name: 'Alice' }));
  await repo.insertRecord(
    rec('order1aaaa', 'orders', { item: 'Book', amount: 111, customer: 'cust1aaaaa' }),
  );
  const reads = jest.spyOn(repo, 'listRecords');
  const app = await renderToolsApp(repo, undefined, { seed });
  await screen.findByText('o0');
  await screen.findByText('111');
  await waitFor(() => expect(screen.getAllByText('Alice').length).toBe(2));
  await settle();
  reads.mockClear();
  computed.mockClear();
  const count = {
    reads: (table: string) => reads.mock.calls.filter((c) => c[0] === table).length,
    computed: (table: string) =>
      computed.mock.calls.filter((c) => (c[2] as { id: string }).id === table).length,
  };
  return { ...app, repo, count };
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

afterEach(() => jest.restoreAllMocks());

it('a write to an unrelated table neither re-reads nor recomputes the blocks on tasks', async () => {
  const { repo, store, count } = await start();
  await repo.insertRecord(rec('other1aaaa', 'other', { title: 'o1' }, 2));
  await act(async () => store.getState().bumpRecords(['other']));
  await screen.findByText('o1');
  await settle();
  expect(count.reads('tasks')).toBe(0);
  expect(count.computed('tasks')).toBe(0);
});

it('six blocks on one table share one read and one computation after a write to it', async () => {
  const { repo, store, count } = await start();
  await repo.insertRecord(rec('task9aaaa', 'tasks', { title: 't9', n: 9 }, 9));
  await act(async () => store.getState().bumpRecords(['tasks']));
  await screen.findAllByText('t9');
  await settle();
  expect(count.reads('tasks')).toBe(1);
  expect(count.computed('tasks')).toBe(1);
  expect(count.reads('other')).toBe(0);
});

it('a write to a linked table refreshes the rollup and the link title on the other table', async () => {
  const { repo, store } = await start();
  await repo.insertRecord(
    rec('order2aaaa', 'orders', { item: 'Pen', amount: 222, customer: 'cust1aaaaa' }, 2),
  );
  await act(async () => store.getState().bumpRecords(['orders']));
  expect(await screen.findByText('333')).toBeTruthy();
  await repo.updateRecord('cust1aaaaa', { name: 'Alicia' }, 3);
  await act(async () => store.getState().bumpRecords(['customers']));
  // Customer list title and references on both orders have updated names.
  await waitFor(() => expect(screen.getAllByText('Alicia').length).toBe(3));
});

it('a write whose table is not known refreshes every table', async () => {
  const { repo, store, count } = await start();
  await repo.insertRecord(rec('other1aaaa', 'other', { title: 'o1' }, 2));
  await repo.insertRecord(rec('task9aaaa', 'tasks', { title: 't9', n: 9 }, 9));
  await act(async () => store.getState().bumpRecords());
  await screen.findByText('o1');
  await screen.findAllByText('t9');
  await settle();
  expect(count.reads('tasks')).toBe(1);
  expect(count.computed('tasks')).toBe(1);
  expect(count.reads('customers')).toBeGreaterThan(0);
  expect(count.reads('orders')).toBeGreaterThan(0);
});

describe('writes whose table is not known for certain refresh every table', () => {
  /** Next prompt uses the button corresponding to label. */
  const answerNext = (label: string) =>
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons?: AlertButton[]) => {
      void buttons?.find((b) => b.text === label)?.onPress?.();
    });

  it('deleting one record refreshes its table only; undoing it refreshes everything', async () => {
    const { store } = await start();
    const other = () => tableVersion(store.getState(), 'other');
    const tasks = () => tableVersion(store.getState(), 'tasks');
    const before = { other: other(), tasks: tasks() };
    await act(() =>
      router.push({
        pathname: '/record/[collectionId]',
        params: { collectionId: 'tasks', recordId: 'task1aaaa' },
      }),
    );
    await fireEvent.press(await screen.findByTestId('editor-delete'));
    await settle();
    expect(tasks()).not.toBe(before.tasks);
    expect(other()).toBe(before.other);
    await fireEvent.press(await screen.findByTestId('toast-undo'));
    await settle();
    expect(other()).not.toBe(before.other);
  });

  it('bulk delete and its undo refresh everything', async () => {
    const { store } = await start();
    const other = () => tableVersion(store.getState(), 'other');
    const before = other();
    await act(() => router.push('/data'));
    await fireEvent.press(await screen.findByTestId('table-tasks'));
    await fireEvent.press(await screen.findByTestId('select-tasks'));
    await fireEvent.press(await screen.findByTestId('select-all'));
    answerNext('删除');
    await fireEvent.press(screen.getByTestId('select-delete'));
    await settle();
    const deleted = other();
    expect(deleted).not.toBe(before);
    await fireEvent.press(await screen.findByTestId('toast-undo'));
    await settle();
    expect(other()).not.toBe(deleted);
  });
});

import {
  applyOps,
  createDefaultWorkspace,
  localDate,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Founder 2026-11-21 "do the first three": task checklist ticks also record completion dates
// (D-617), numeric blocks display the latest entry (D-618), and blank numbers in formulas evaluate
// to 0 (D-619). Ticking and unticking never trigger an undo banner: unticking clears everything
// written by the tick (invariant 11); an undo banner appears only when a tick overwrites an
// existing date (since unticking cannot restore that previous date).

const tasks: Collection = {
  id: 'tasks',
  name: '任务',
  fields: [
    { id: 'title', name: '事项', type: 'text' },
    { id: 'done', name: '完成', type: 'checkbox', default: false },
    { id: 'completed', name: '完成日期', type: 'date' },
  ],
};
const weights: Collection = {
  id: 'weights',
  name: '体重',
  fields: [
    { id: 'date', name: '日期', type: 'date' },
    { id: 'kg', name: '体重', type: 'number', decimals: 1, unit: 'kg' },
  ],
};
const guests: Collection = {
  id: 'guests',
  name: '客人',
  fields: [
    { id: 'name', name: '名字', type: 'text' },
    { id: 'coming', name: '来', type: 'checkbox' },
    { id: 'plus', name: '带几个人', type: 'number', decimals: 0 },
    {
      id: 'party',
      name: '一共',
      type: 'formula',
      expression: '{coming} * (1 + {plus})',
      decimals: 0,
      empty: 'zero',
    } as never,
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: tasks },
      { op: 'addData', table: weights },
      { op: 'addData', table: guests },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'todo',
          look: 'checklist',
          source: { table: 'tasks', limit: 10 },
          show: { title: 'title', subtitles: ['completed'] },
          tools: [
            {
              as: 'check',
              do: 'toggle',
              table: 'tasks',
              field: 'done',
              also: [{ do: 'set', field: 'completed', value: 'today' }],
            },
          ],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'now',
          look: 'number',
          show: { label: '现在' },
          source: { table: 'weights', aggregate: 'latest', field: 'kg' },
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'heads',
          look: 'number',
          show: { label: '人数' },
          source: { table: 'guests', aggregate: 'sum', field: 'party' },
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const put = (repo: MemoryWorkspaceRepo, table: string, id: string, values: object, at = 1) =>
  repo.insertRecord({
    id,
    collectionId: table,
    values: { ...values },
    createdAt: at,
    updatedAt: at,
  });

async function open(fill: (repo: MemoryWorkspaceRepo) => Promise<void> = async () => {}) {
  const repo = new MemoryWorkspaceRepo();
  await fill(repo);
  const app = await renderToolsApp(repo, undefined, { seed, locale: 'zh' });
  await act(async () => {});
  return { ...app, repo };
}

const today = () => localDate(new Date());
// Wait for writes to complete (several asynchronous steps) before checking values in the database.
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
    });
};

it('ticking records today in one write and shows no undo; unticking clears it again', async () => {
  const { repo, store } = await open((r) => put(r, 'tasks', 't1', { title: '报税', done: false }));
  await fireEvent.press(await screen.findByTestId('check-t1'));
  await settle();
  expect((await repo.getRecord('t1'))?.values).toEqual({
    title: '报税',
    done: true,
    completed: today(),
  });
  expect(screen.queryByTestId('toast-undo')).toBeNull();
  expect(store.getState().toast?.undo).toBeUndefined();
  await fireEvent.press(await screen.findByTestId('check-t1'));
  await settle();
  expect((await repo.getRecord('t1'))?.values).toEqual({ title: '报税', done: false });
  expect(screen.queryByTestId('toast-undo')).toBeNull();
});

it('ticking over a date that was already there offers undo, which puts that date back', async () => {
  const { repo } = await open((r) =>
    put(r, 'tasks', 't1', { title: '报税', done: false, completed: '2026-01-05' }),
  );
  await fireEvent.press(await screen.findByTestId('check-t1'));
  await fireEvent.press(await screen.findByTestId('toast-undo'));
  await settle();
  expect((await repo.getRecord('t1'))?.values).toEqual({
    title: '报税',
    done: false,
    completed: '2026-01-05',
  });
});

it('a number block shows the value of the newest entry', async () => {
  await open(async (r) => {
    await put(r, 'weights', 'w1', { date: '2026-11-10', kg: 72.4 }, 1);
    await put(r, 'weights', 'w2', { date: '2026-11-16', kg: 71.8 }, 2);
    await put(r, 'weights', 'w3', { date: '2026-11-12', kg: 73 }, 3);
  });
  expect(await screen.findByTestId('stat-value-weights-现在')).toHaveTextContent('71.8 kg');
});

it('a headcount counts a guest whose plus-ones is empty', async () => {
  await open(async (r) => {
    await put(r, 'guests', 'g1', { name: 'A', coming: true });
    await put(r, 'guests', 'g2', { name: 'B', coming: true, plus: 2 });
    await put(r, 'guests', 'g3', { name: 'C', coming: false, plus: 1 });
  });
  expect(await screen.findByTestId('stat-value-guests-人数')).toHaveTextContent('4');
});

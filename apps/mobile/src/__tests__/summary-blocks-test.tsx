import { StyleSheet } from 'react-native';
import {
  applyOps,
  createDefaultWorkspace,
  createRegistry,
  BUILTIN_TOOLS,
  optionColor,
  type Collection,
  type Component,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';
import type { SQLiteDatabase } from 'expo-sqlite';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { SQLiteWorkspaceRepo } from '../storage/sqlite';
import { renderToolsApp } from '../test-utils/render-app';
import { buildWidgetSnapshot } from '../widgets/snapshot';

const table: Collection = {
  id: 'metrics',
  name: 'Metrics',
  fields: [
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'end', name: 'End', type: 'date' },
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'income', name: 'Income', type: 'number' },
    {
      id: 'kind',
      name: 'Kind',
      type: 'choice',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
  ],
};
const ratio: Component = {
  id: 'ratio',
  look: 'number',
  show: { label: 'Ratio' },
  source: {
    table: 'metrics',
    aggregate: 'sum',
    field: 'amount',
    calc: {
      with: [{ id: 'income', table: 'metrics', aggregate: 'sum', field: 'income' }],
      formula: '({income} - {total}) / {income}',
      as: 'percent',
    },
  },
};
const calendar: Component = {
  id: 'week',
  look: 'calendar',
  show: { title: 'date', span: 'week', day: { aggregate: 'count' } },
  source: { table: 'metrics', limit: 30, group: { unit: 'day', by: 'date', until: 'end' } },
};
const chart: Component = {
  id: 'split',
  look: 'chart',
  show: { title: 'Split', kind: 'bar' },
  source: {
    table: 'metrics',
    aggregate: 'sum',
    field: 'amount',
    group: { unit: 'day', by: 'date', last: 3 },
    split: { by: 'kind' },
  },
};
const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table },
      { op: 'addContainer', page: 'home', block: ratio },
      { op: 'addContainer', page: 'home', block: calendar },
      { op: 'addContainer', page: 'home', block: chart },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};
const settle = async () => {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
    });
};
const row = (id: string, values: object) => ({
  id,
  collectionId: 'metrics',
  values: { ...values },
  createdAt: 1,
  updatedAt: 1,
});
async function open(fill = true, locale: Locale = 'en') {
  const repo = new MemoryWorkspaceRepo();
  if (fill) {
    await repo.insertRecord(
      row('a', { date: '2026-11-23', end: '2026-12-02', amount: 30, income: 100, kind: 'a' }),
    );
    await repo.insertRecord(row('b', { date: '2026-11-23', amount: -10, income: 100, kind: 'b' }));
  }
  await renderToolsApp(repo, undefined, { seed, locale });
  await settle();
  return repo;
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 10, 23, 12));
});
it('renders empty formula and week state without writing a record', async () => {
  const repo = await open(false);
  expect(screen.getByTestId('stat-value-metrics-Ratio')).toHaveTextContent('—');
  expect(screen.getByTestId('calendar-week-value-2026-11-23')).toHaveTextContent('0');
  expect(await repo.listRecords('metrics')).toEqual([]);
});
it.each(['en', 'zh', 'fr'] as Locale[])(
  'page and widget render the same formula in %s',
  async (locale) => {
    const repo = await open(true, locale);
    const registry = createRegistry(BUILTIN_TOOLS);
    const config = seed(locale, registry);
    const snapshot = await buildWidgetSnapshot({
      config,
      placed: [{ componentId: 'ratio', placedAt: 1 }],
      locale,
      registry,
      now: new Date(),
      records: new Map([['metrics', await repo.listRecords('metrics')]]),
    });
    const widget = snapshot.states[0]!.views.ratio;
    expect(widget.kind).toBe('stat');
    if (widget.kind !== 'stat') throw new Error('expected stat');
    expect(screen.getByTestId('stat-value-metrics-Ratio')).toHaveTextContent(widget.value);
    expect(widget.value).toBe(locale === 'fr' ? '90 %' : '90%');
  },
);
it('navigates a week across months and lists a spanning entry on its end date, without writes', async () => {
  const repo = await open();
  const before = await repo.listRecords('metrics');
  await fireEvent.press(screen.getByTestId('calendar-week-next'));
  await settle();
  expect(screen.getByTestId('calendar-week-value-2026-12-02')).toHaveTextContent('1');
  await fireEvent.press(screen.getByTestId('calendar-week-day-2026-12-02'));
  await settle();
  expect(screen.getByText('2026-11-23')).toBeTruthy();
  expect(await repo.listRecords('metrics')).toEqual(before);
});
it('shows a split legend and signed parts when selecting a time bucket', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('chart-bar-2'));
  await settle();
  expect(screen.getByText('A')).toBeTruthy();
  expect(screen.getByText('B')).toBeTruthy();
  expect(screen.getByTestId('chart-readout-metrics')).toHaveTextContent(/A: 30/);
  expect(screen.getByTestId('chart-readout-metrics')).toHaveTextContent(/B: -10/);
});
it('the range query fetches entries starting earlier and ending inside the range', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord(row('long', { date: '2026-10-01', end: '2026-12-02' }));
  await repo.insertRecord(row('before', { date: '2026-10-01', end: '2026-10-02' }));
  const range = {
    by: 'date',
    endBy: 'end',
    from: '2026-11-30',
    until: '2026-12-08',
    fromMs: 0,
    untilMs: 0,
  };
  expect((await repo.listRecordsInRange('metrics', range)).map((r) => r.id)).toEqual(['long']);
  const getAllAsync = jest.fn(async () => []);
  const sql = new SQLiteWorkspaceRepo({ getAllAsync } as unknown as SQLiteDatabase);
  await sql.listRecordsInRange('metrics', range);
  expect(getAllAsync).toHaveBeenCalledWith(
    expect.stringContaining('OR json_extract(values_json, ?) >= ?'),
    'metrics',
    '$."date"',
    range.until,
    '$."date"',
    range.from,
    '$."end"',
    range.from,
  );
});

it('draws the earlier running period even when its bars are negative', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord(row('prev', { date: '2026-11-20', amount: -5 }));
  await repo.insertRecord(row('now', { date: '2026-11-23', amount: -10 }));
  await renderToolsApp(repo, undefined, {
    locale: 'en',
    seed: (locale, registry) => {
      const result = applyOps(
        seed(locale, registry),
        [
          {
            op: 'addContainer',
            page: 'home',
            block: {
              id: 'negative',
              look: 'chart',
              show: { title: 'Running comparison', kind: 'bar' },
              source: {
                table: 'metrics',
                aggregate: 'sum',
                field: 'amount',
                group: { unit: 'day', by: 'date', last: 3 },
                running: 'shown',
                compare: 'previous',
              },
            },
          },
        ],
        { registry, locale },
      );
      if (!result.ok) throw new Error(result.error);
      return result.config;
    },
  });
  await settle();
  expect(screen.getByTestId('chart-previous-2').props.style.height).toBeGreaterThan(0);
});

it('keeps the chosen option color when the day sum is zero', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord(row('positive', { date: '2026-11-23', amount: 30, kind: 'a' }));
  await repo.insertRecord({
    ...row('negative', { date: '2026-11-23', amount: -30, kind: 'b' }),
    createdAt: 2,
  });
  await renderToolsApp(repo, undefined, {
    locale: 'en',
    seed: (locale, registry) => {
      const result = applyOps(
        seed(locale, registry),
        [
          {
            op: 'addContainer',
            page: 'home',
            block: {
              id: 'day-color',
              look: 'calendar',
              show: { title: 'date', color: 'kind', day: { aggregate: 'sum', field: 'amount' } },
              source: { table: 'metrics', limit: 30, group: { unit: 'day', by: 'date' } },
            },
          },
        ],
        { registry, locale },
      );
      if (!result.ok) throw new Error(result.error);
      return result.config;
    },
  });
  await settle();
  const cell = screen.getByTestId('calendar-day-color-day-2026-11-23');

  expect(StyleSheet.flatten(cell.props.style).backgroundColor).toBe(
    optionColor({ id: 'b' }, 1, false, [{ id: 'a' }, { id: 'b' }]),
  );
});

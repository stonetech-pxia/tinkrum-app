import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Tap a bar to change the page's time range to that month (D-585): the numbers on the same page update alongside the time range; only modifies the page selection and writes nothing (invariant 15).

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'tx',
          name: '开支',
          fields: [
            { id: 'name', name: '名称', type: 'text' },
            { id: 'date', name: '日期', type: 'date' },
            { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
          ],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'hist',
          title: '历史',
          blocks: [
            {
              id: 'range',
              look: 'tabs',
              show: { periods: ['thisMonth', 'lastMonth'], default: 'lastMonth', custom: true },
            },
            {
              id: 'total',
              look: 'number',
              show: { label: '合计' },
              source: { table: 'tx', aggregate: 'sum', field: 'amount', period: 'page' },
            },
            {
              id: 'trend',
              look: 'chart',
              show: { kind: 'bar', title: '最近 12 个月', pickPeriod: true },
              source: {
                table: 'tx',
                aggregate: 'sum',
                field: 'amount',
                group: { by: 'date', unit: 'month', last: 12 },
              },
            },
          ],
        },
      },
    ],
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

const pad = (n: number) => String(n).padStart(2, '0');
const monthsAgo = (n: number) => {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - n, 10);
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
};

afterEach(() => useGuide.setState({ stage: null, repo: null }));

it('tapping the bar of another month sets the page range to that month', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  for (const [i, [date, amount]] of (
    [
      [monthsAgo(1), 30],
      [monthsAgo(2), 700],
    ] as const
  ).entries())
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'tx',
      values: { name: `r${i}`, date, amount },
      createdAt: 100 + i,
      updatedAt: 100 + i,
    });
  await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  await settle();
  await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'hist' } }));
  await settle();

  // Default to last month: total is 30, and the reading corresponds to that month's bar.
  const total = () => screen.getByTestId('stat-value-tx-合计').props.children;
  expect(await screen.findByTestId('stat-value-tx-合计')).toBeTruthy();
  expect(total()).toBe('¥30.00');
  // Tap the bar from two months ago (third from last out of 12 bars, index 9): total becomes 700, and the reading follows that bar.
  await fireEvent.press(screen.getByTestId('chart-bar-9'));
  await settle();
  expect(total()).toBe('¥700.00');
  expect(screen.getByTestId('chart-readout-tx').props.children).toMatch(/¥700\.00$/);
  // Only the page selection was changed; records remain untouched.
  const stored = await repo.listRecords('tx');
  expect(stored.map((r) => r.updatedAt)).toEqual([100, 101]);
});

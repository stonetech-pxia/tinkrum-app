import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Time range on the page also controls the record list (D-561): whichever period is selected, the list below contains only items from that period; doing nothing writes nothing (invariant 15).

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'bills',
          name: '账单',
          fields: [
            { id: 'name', name: '名字', type: 'text' },
            { id: 'due', name: '到期', type: 'date' },
          ],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'bills-page',
          title: '账单',
          blocks: [
            { id: 'range', look: 'tabs', show: { periods: ['thisWeek', 'lastYear'] } },
            {
              id: 'following',
              look: 'list',
              source: { table: 'bills', period: 'page', limit: 30 },
              show: { title: 'name' },
            },
            {
              id: 'fixed',
              look: 'cards',
              source: { table: 'bills', limit: 30 },
              show: { title: 'name' },
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
const today = new Date();
const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const LAST_YEAR = `${today.getFullYear() - 1}-06-15`;

async function open(records: Record<string, unknown>[]) {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  for (const [i, values] of records.entries())
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'bills',
      values,
      createdAt: 100 + i,
      updatedAt: 100 + i,
    });
  const app = await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  await settle();
  await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'bills-page' } }));
  await settle();
  return { ...app, repo };
}

afterEach(() => useGuide.setState({ stage: null, repo: null }));

describe('a list following the page time range (D-561)', () => {
  it('no entries: the page still opens with the choices', async () => {
    await open([]);
    expect(await screen.findByTestId('period-thisWeek')).toBeTruthy();
  });

  it('shows only the entries of the picked range; a list that does not follow keeps all', async () => {
    const { repo } = await open([
      { name: '这周的', due: TODAY },
      { name: '去年的', due: LAST_YEAR },
      { name: '没有日期' },
    ]);
    await screen.findByTestId('period-thisWeek');
    // Following list: only items from this week; unrelated cards: all three present.
    expect(screen.getAllByText('这周的')).toHaveLength(2);
    expect(screen.getAllByText('去年的')).toHaveLength(1);
    expect(screen.getAllByText('没有日期')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('period-lastYear'));
    await settle();
    expect(screen.getAllByText('这周的')).toHaveLength(1);
    expect(screen.getAllByText('去年的')).toHaveLength(2);
    // Selecting time range writes nothing.
    const stored = await repo.listRecords('bills');
    expect(stored.map((r) => r.updatedAt)).toEqual([100, 101, 102]);
  });
});

import {
  applyOps,
  calendarOf,
  createDefaultWorkspace,
  dayOf,
  type Collection,
  type Locale,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 打卡格（D-606）：习惯 × 最近 7 天。点空格新建（这个习惯、这一天，不弹撤销），点只有一条的格子删掉（进「最近删除」，
// 弹撤销），两条的格子列出记录；没有 remove 的格子每点一下多记一条，长按列出。

const habits: Collection = {
  id: 'habits',
  name: '习惯',
  fields: [{ id: 'name', name: '名字', type: 'text' }],
};
const checkins: Collection = {
  id: 'checkins',
  name: '打卡',
  fields: [
    { id: 'habit', name: '习惯', type: 'link', table: 'habits' },
    { id: 'date', name: '日期', type: 'date' },
  ],
};
const water: Collection = {
  id: 'water',
  name: '喝水',
  fields: [
    {
      id: 'kind',
      name: '种类',
      type: 'choice',
      options: [
        { id: 'water', label: '白水' },
        { id: 'tea', label: '茶' },
      ],
    },
    { id: 'at', name: '时间', type: 'datetime' },
  ],
};

const seed = (locale: Locale, registry: Registry): WorkspaceConfig => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: habits },
      { op: 'addData', table: checkins },
      { op: 'addData', table: water },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'week',
          look: 'grid',
          source: {
            table: 'checkins',
            group: { by: 'habit', showEmpty: true },
            across: { unit: 'day', by: 'date', last: 7 },
            limit: 30,
          },
          show: { title: 'habit', subtitles: ['date'] },
          tools: [
            { as: 'tap', do: 'create', table: 'checkins', values: '$here' },
            { as: 'tap', do: 'remove', table: 'checkins' },
          ],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'cups',
          look: 'grid',
          source: {
            table: 'water',
            group: { by: 'kind', showEmpty: true },
            across: { unit: 'day', last: 7 },
            limit: 30,
          },
          show: { title: 'kind', format: { kind: 'progress', goal: 8 } },
          tools: [{ as: 'tap', do: 'create', table: 'water', values: '$here' }],
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const at = Date.now();
const put = (repo: MemoryWorkspaceRepo, id: string, collectionId: string, values: object) =>
  repo.insertRecord({ id, collectionId, values: { ...values }, createdAt: at, updatedAt: at });

/** 今天往前 n 天（和格子一样按「设置 → 日期」算，测试里是默认的）。 */
const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayOf(d, calendarOf({ data: { tables: [] } }));
};
const cell = (block: string, row: string, n: number) =>
  screen.findByTestId(`grid-${block}-cell-${row}-${day(n)}`);

it('a new user with no habits sees the empty text, and the option rows of the counting grid', async () => {
  await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { seed });
  expect(await screen.findByText('还没有记录')).toBeTruthy();
  expect(await screen.findByText('白水')).toBeTruthy();
  expect(await screen.findByText('茶')).toBeTruthy();
});

it('tapping an empty cell adds a check-in for that habit and that day, with no undo (invariant 11)', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'run', 'habits', { name: '跑步' });
  await renderToolsApp(repo, undefined, { seed });
  expect(await screen.findByText('跑步')).toBeTruthy();
  // 补三天前的。
  await fireEvent.press(await cell('week', 'run', 3));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/已在「打卡」添加一条/);
  const [added, ...more] = await repo.listRecords('checkins');
  expect(more).toEqual([]);
  expect(added!.values).toEqual({ habit: 'run', date: day(3) });
  expect(screen.queryByTestId('toast-undo')).toBeNull();
  expect(await cell('week', 'run', 3)).toHaveProp(
    'accessibilityLabel',
    expect.stringMatching(/1 条$/),
  );
});

it('tapping a cell with one check-in moves it to the trash and offers undo, which brings it back', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'run', 'habits', { name: '跑步' });
  await put(repo, 'c1', 'checkins', { habit: 'run', date: day(0) });
  await renderToolsApp(repo, undefined, { seed });
  await fireEvent.press(await cell('week', 'run', 0));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/已从「打卡」删除一条/);
  // 和用户自己删一样进「最近删除」。
  expect((await repo.listDeletedRecords()).map((r) => r.id)).toEqual(['c1']);
  await waitFor(() =>
    expect(screen.getByTestId(`grid-week-cell-run-${day(0)}`)).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/0 条$/),
    ),
  );
  await fireEvent.press(screen.getByTestId('toast-undo'));
  await waitFor(() =>
    expect(screen.getByTestId(`grid-week-cell-run-${day(0)}`)).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/1 条$/),
    ),
  );
  expect((await repo.getRecord('c1'))?.deletedAt).toBeNull();
});

it('a cell with two check-ins is never removed by a tap: it lists them', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'run', 'habits', { name: '跑步' });
  await put(repo, 'c1', 'checkins', { habit: 'run', date: day(1) });
  await put(repo, 'c2', 'checkins', { habit: 'run', date: day(1) });
  await renderToolsApp(repo, undefined, { seed });
  const two = await cell('week', 'run', 1);
  expect(two).toHaveTextContent('2');
  await fireEvent.press(two);
  // 下面列出这一格的两条，标题是「习惯 · 那一天」。
  expect(await screen.findByText(/^跑步 · /)).toBeTruthy();
  // 行名一个，列出的两条各一个（标题是引用的习惯）。
  expect(screen.getAllByText('跑步')).toHaveLength(3);
  expect(await repo.listRecords('checkins')).toHaveLength(2);
  expect(screen.queryByTestId('toast')).toBeNull();
});

it('without remove, every tap adds one more and the ring fills toward the goal; a long press lists them', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed });
  for (let i = 0; i < 3; i++) await fireEvent.press(await cell('cups', 'water', 0));
  await waitFor(() =>
    expect(screen.getByTestId(`grid-cups-cell-water-${day(0)}`)).toHaveTextContent('3'),
  );
  const records = await repo.listRecords('water');
  expect(records).toHaveLength(3);
  expect(records.every((r) => r.values.kind === 'water')).toBe(true);
  // 日期时间字段：今天那一列是现在（这一天里）。
  expect(records.every((r) => String(r.values.at).startsWith(day(0)))).toBe(true);
  expect(await cell('cups', 'water', 0)).toHaveTextContent('3');
  expect(screen.getByTestId(`grid-cups-ring-water-${day(0)}`)).toBeTruthy();
  await fireEvent(await cell('cups', 'water', 0), 'longPress');
  expect(await screen.findByText(/^白水 · /)).toBeTruthy();
  expect(await repo.listRecords('water')).toHaveLength(3);
});

it('paging back shows the week before; the newest page has no later page', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'run', 'habits', { name: '跑步' });
  await renderToolsApp(repo, undefined, { seed });
  await cell('week', 'run', 0);
  expect(screen.getByTestId('grid-week-next')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('grid-week-prev'));
  expect(await cell('week', 'run', 7)).toBeTruthy();
  expect(screen.queryByTestId(`grid-week-cell-run-${day(0)}`)).toBeNull();
  await fireEvent.press(screen.getByTestId('grid-week-today'));
  expect(await cell('week', 'run', 0)).toBeTruthy();
});

it('in French: the cell says the habit, the day and the count, and removing says so', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'run', 'habits', { name: 'Course' });
  await put(repo, 'c1', 'checkins', { habit: 'run', date: day(0) });
  await renderToolsApp(repo, undefined, { seed, locale: 'fr' });
  const one = await cell('week', 'run', 0);
  expect(one).toHaveProp('accessibilityLabel', expect.stringMatching(/^Course, .* : 1 entrée$/));
  expect(one).toHaveProp('accessibilityHint', 'Met cette entrée dans Supprimés récemment');
  await fireEvent.press(one);
  expect(await screen.findByTestId('toast')).toHaveTextContent(/Entrée supprimée de « 打卡 »/);
});

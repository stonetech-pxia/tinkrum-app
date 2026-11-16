import {
  applyOps,
  CHART_COLORS,
  createDefaultWorkspace,
  localDate,
  OPTION_COLORS,
  type Collection,
  type DataRecord,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// D-568：写了颜色的选项在按值上色的点、月历的日子、饼图里都用它的颜色；没写的照旧按顺序取色。只看，不写（底线 15）。

const money: Collection = {
  id: 'money',
  name: 'Money',
  fields: [
    { id: 'what', name: 'What', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'USD' },
    { id: 'date', name: 'Date', type: 'date', default: 'today' },
    {
      id: 'kind',
      name: 'Kind',
      type: 'choice',
      options: [
        { id: 'misc', label: 'Misc' },
        { id: 'income', label: 'Income', color: 'green' },
        { id: 'expense', label: 'Expense', color: 'red' },
      ],
    },
  ],
};

const seedWith =
  (...components: NewComponent[]) =>
  (locale: Locale, registry: Registry) => {
    const result = applyOps(
      createDefaultWorkspace(locale),
      [
        { op: 'addData' as const, table: money },
        ...components.map((block) => ({ op: 'addContainer' as const, page: 'home', block })),
      ],
      { registry, locale },
    );
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };

let seq = 0;
const put = async (repo: MemoryWorkspaceRepo, values: object) => {
  const record: DataRecord = {
    id: `r${++seq}`,
    collectionId: 'money',
    values: values as Record<string, unknown>,
    createdAt: Date.now() + seq,
    updatedAt: Date.now() + seq,
  };
  await repo.insertRecord(record);
  return record;
};

const bg = (node: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(node.props.style as never) as { backgroundColor?: string }).backgroundColor;

const today = () => localDate(new Date());
const otherDay = () => {
  const d = new Date();
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() === 1 ? 2 : 1));
};

it('the colour dot of a list uses the named colour, and the order colour without one', async () => {
  const repo = new MemoryWorkspaceRepo();
  const pay = await put(repo, { what: 'Pay', kind: 'income' });
  const rent = await put(repo, { what: 'Rent', kind: 'expense' });
  const gift = await put(repo, { what: 'Gift', kind: 'misc' });
  await renderToolsApp(repo, undefined, {
    seed: seedWith({
      id: 'v',
      look: 'list',
      source: { table: 'money', limit: 30 },
      show: { title: 'what', color: 'kind' },
    } as NewComponent),
    locale: 'en',
  });
  expect(bg(await screen.findByTestId(`color-dot-${pay.id}`))).toBe(OPTION_COLORS.green.light);
  expect(bg(screen.getByTestId(`color-dot-${rent.id}`))).toBe(OPTION_COLORS.red.light);
  expect(bg(screen.getByTestId(`color-dot-${gift.id}`))).toBe(CHART_COLORS.light[0]);
});

it('a calendar day takes the colour of its option', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, { what: 'Rent', kind: 'expense', date: otherDay() });
  await put(repo, { what: 'Gift', kind: 'misc', date: today() });
  await renderToolsApp(repo, undefined, {
    seed: seedWith({
      id: 'cal',
      look: 'calendar',
      source: { table: 'money', group: { by: 'date', unit: 'day' }, limit: 20 },
      show: { title: 'what', color: 'kind' },
    } as NewComponent),
    locale: 'en',
  });
  const day = await screen.findByTestId(`calendar-cal-day-${otherDay()}`);
  expect(bg(day)).toBe(OPTION_COLORS.red.light);
  if (otherDay() !== today())
    expect(bg(screen.getByTestId(`calendar-cal-day-${today()}`))).toBe(CHART_COLORS.light[0]);
});

it('a pie by this choice draws named colours; the rest keep their order colours', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, { what: 'Pay', kind: 'income', amount: 30 });
  await put(repo, { what: 'Rent', kind: 'expense', amount: 10 });
  await put(repo, { what: 'Gift', kind: 'misc', amount: 5 });
  await renderToolsApp(repo, undefined, {
    seed: seedWith({
      id: 'share',
      look: 'chart',
      show: { kind: 'pie', title: 'Where' },
      source: { table: 'money', aggregate: 'sum', field: 'amount', group: { by: 'kind' } },
    } as NewComponent),
    locale: 'en',
  });
  const swatch = (key: string) => bg(screen.getByTestId(`chart-slice-${key}`).children[0] as never);
  await screen.findByTestId('chart-slice-income');
  expect(swatch('income')).toBe(OPTION_COLORS.green.light);
  expect(swatch('expense')).toBe(OPTION_COLORS.red.light);
  expect(swatch('misc')).toBe(CHART_COLORS.light[0]);
});

// D-571（模拟器检查 QA_BATCH3 P1）：支出红、收入绿时，排在它们后面、没写颜色的「转账」不拿青绿（第 3 个分类色），
// 拿不和红、绿同一色系的颜色。
it('an option without a colour after named ones avoids their hue families', async () => {
  const repo = new MemoryWorkspaceRepo();
  const ledger: Collection = {
    id: 'money',
    name: 'Money',
    fields: [
      { id: 'what', name: 'What', type: 'text' },
      {
        id: 'kind',
        name: 'Kind',
        type: 'choice',
        options: [
          { id: 'expense', label: 'Expense', color: 'red' },
          { id: 'income', label: 'Income', color: 'green' },
          { id: 'transfer', label: 'Transfer' },
        ],
      },
    ],
  };
  const moved = await put(repo, { what: 'Move', kind: 'transfer' });
  await renderToolsApp(repo, undefined, {
    seed: (locale: Locale, registry: Registry) => {
      const result = applyOps(
        createDefaultWorkspace(locale),
        [
          { op: 'addData', table: ledger },
          {
            op: 'addContainer',
            page: 'home',
            block: {
              id: 'v',
              look: 'list',
              source: { table: 'money', limit: 30 },
              show: { title: 'what', color: 'kind' },
            } as NewComponent,
          },
        ],
        { registry, locale },
      );
      if (!result.ok) throw new Error(result.error);
      return result.config;
    },
    locale: 'en',
  });
  const dot = bg(await screen.findByTestId(`color-dot-${moved.id}`));
  expect(dot).not.toBe(CHART_COLORS.light[2]);
  expect(dot).toBe(CHART_COLORS.light[0]);
});

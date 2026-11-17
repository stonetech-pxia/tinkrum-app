import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 数字卡读 style.size（D-589）：不写是原来的字号，small / large 按 0.85 / 1.2 缩放数字；不写的和以前完全一样。

const seed = (locale: Locale, registry: Registry) => {
  const number = (id: string, label: string, size?: 'small' | 'medium' | 'large') => ({
    id,
    look: 'number' as const,
    show: { label },
    source: { table: 'tx', aggregate: 'sum' as const, field: 'amount' },
    ...(size ? { style: { size } } : {}),
  });
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'tx',
          name: '开支',
          fields: [{ id: 'amount', name: '金额', type: 'money', currency: 'CNY' }],
        },
      },
      {
        op: 'addContainer',
        page: {
          id: 'sizes',
          title: '大小',
          blocks: [
            number('plain', '默认'),
            number('small', '小', 'small'),
            number('medium', '中', 'medium'),
            number('large', '大', 'large'),
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

const fontSize = (label: string) =>
  StyleSheet.flatten(screen.getByTestId(`stat-value-tx-${label}`).props.style).fontSize;

afterEach(() => useGuide.setState({ stage: null, repo: null }));

it('scales the number by style.size; without it the size is what it always was', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  await repo.insertRecord({
    id: 'r1',
    collectionId: 'tx',
    values: { amount: 4582.72 },
    createdAt: 1,
    updatedAt: 1,
  });
  await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  await settle();
  await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'sizes' } }));
  await settle();
  expect(await screen.findByTestId('stat-value-tx-默认')).toBeTruthy();
  const base = fontSize('默认')!;
  expect(fontSize('中')).toBe(base);
  // 默认的数字卡字号是 26 乘主题字号比例；小是 0.85 倍，大是 1.2 倍（取整）。
  expect(fontSize('小')).toBe(Math.round(26 * 0.85 * (base / 26)));
  expect(fontSize('大')).toBe(Math.round(26 * 1.2 * (base / 26)));
});

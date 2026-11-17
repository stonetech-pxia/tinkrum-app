import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 提示卡（D-580）：文字里的 {count}、{sum:字段} 按符合条件的记录算，卡片里是「做事」和「打开」两个按钮；
// 数字只在画的时候算，不存（底线 14），也不写任何东西（底线 15）。

const pending = [{ field: 'paused', op: 'isNot' as const, value: true }];
const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'subs',
          name: '订阅',
          fields: [
            { id: 'name', name: '名称', type: 'text' },
            { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
            { id: 'paused', name: '暂停', type: 'checkbox' },
          ],
        },
      },
      {
        op: 'addData',
        table: {
          id: 'tx',
          name: '开支',
          fields: [
            { id: 'merchant', name: '商家', type: 'text' },
            { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
            { id: 'sub', name: '订阅', type: 'link', table: 'subs' },
          ],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'prompt',
          look: 'callout',
          show: {
            title: '本月订阅待确认',
            text: '有 {count} 项订阅，合计 {sum:amount}，还没记到本月。',
            actionLabel: '加入本月',
            openLabel: '修改',
          },
          source: { table: 'subs', filter: pending },
          tools: [
            {
              do: 'createAll',
              table: 'tx',
              from: 'subs',
              filter: pending,
              values: { amount: { copy: 'amount' }, merchant: { copy: 'name' }, sub: '$row' },
            },
          ],
          opens: 'settings',
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const add = (repo: MemoryWorkspaceRepo, id: string, amount: number, paused?: boolean) => {
  const at = Date.now();
  return repo.insertRecord({
    id,
    collectionId: 'subs',
    values: { name: id, amount, ...(paused === undefined ? {} : { paused }) },
    createdAt: at,
    updatedAt: at,
  });
};

it('counts and adds up only the entries that match, and shows both buttons inside the card', async () => {
  const repo = new MemoryWorkspaceRepo();
  await add(repo, 's1aaaaaa', 68);
  await add(repo, 's2aaaaaa', 15, false);
  await add(repo, 's3aaaaaa', 199, true);
  await renderToolsApp(repo, undefined, { seed });
  expect(await screen.findByTestId('component-prompt')).toBeTruthy();
  // 2 of the 3 match (the paused one does not): 68 + 15.
  expect(await screen.findByText(/有 2 项订阅，合计 .*83/)).toBeTruthy();
  expect(screen.getByText('本月订阅待确认')).toBeTruthy();
  expect(screen.getByText('加入本月')).toBeTruthy();
  expect(screen.getByText('修改')).toBeTruthy();
});

it('says 0 and a zero total when nothing matches, and writes nothing', async () => {
  const repo = new MemoryWorkspaceRepo();
  await add(repo, 's1aaaaaa', 199, true);
  await renderToolsApp(repo, undefined, { seed });
  expect(await screen.findByText(/有 0 项订阅，合计 .*0/)).toBeTruthy();
});

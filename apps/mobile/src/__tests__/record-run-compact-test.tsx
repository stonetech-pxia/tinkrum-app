import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 做完是「记一笔」的快捷操作（D-588）：运行时不摆步骤列表，只说一句在做什么；记好了或者用户取消了，
// 直接回到来的地方，不停在结果页；没有「记一笔」的快捷操作和以前一样。

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'jot',
          name: '随手记',
          fields: [
            { id: 'title', name: '标题', type: 'text' },
            { id: 'body', name: '内容', type: 'note' },
          ],
        },
      },
      {
        op: 'addTool',
        tool: {
          kind: 'quickAction',
          id: 'jot-run',
          name: '随手记一笔',
          steps: [
            { id: 'text', action: 'in.text', params: { text: '午饭 30' }, ask: [] },
            { id: 'add', action: 'out.addRecord', params: { collectionId: 'jot' } },
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
    jest.advanceTimersByTime(700);
    await Promise.resolve();
  });

async function openRun() {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  await settle();
  await act(() =>
    router.push({ pathname: '/run/[workflowId]', params: { workflowId: 'jot-run' } }),
  );
  await settle();
  return repo;
}

afterEach(() => useGuide.setState({ stage: null, repo: null }));

describe('a quick action that ends in 记一笔 (D-588)', () => {
  it('shows only one line while it works, and goes back by itself once the entry is saved', async () => {
    const repo = await openRun();
    // 表单盖在运行页上：没有步骤列表，运行页是简洁的一句话。
    expect(await screen.findByTestId('local-done')).toBeTruthy();
    expect(screen.getByTestId('run-compact')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('local-done'));
    await settle();
    expect((await repo.listRecords('jot')).length).toBe(1);
    // 不停在结果页：没有「再来一次 / 完成」，回到了主页。
    expect(screen.queryByTestId('run-done')).toBeNull();
    expect(screen.queryByTestId('run-screen')).toBeNull();
    expect(await screen.findByTestId('nav-settings')).toBeTruthy();
  });

  it('closing the form goes back too, and saves nothing', async () => {
    const repo = await openRun();
    await fireEvent.press(await screen.findByTestId('local-cancel'));
    await settle();
    expect((await repo.listRecords('jot')).length).toBe(0);
    expect(screen.queryByTestId('run-screen')).toBeNull();
    expect(await screen.findByTestId('nav-settings')).toBeTruthy();
  });
});

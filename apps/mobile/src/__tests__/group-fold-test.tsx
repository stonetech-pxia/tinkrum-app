import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { fireEvent, screen } from '@testing-library/react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// 可以收起的分组（D-578）：标题是一个能点的头，点一下收起或展开；fold 的值是一开始的样子。
// 收起只是看的方式（底线 15），不写任何数据。

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'subs',
          look: 'group',
          show: { title: '订阅', layout: 'stack', fold: 'closed' },
          children: [{ id: 'in-subs', look: 'text', show: { text: '订阅里面的字' } }],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'daily',
          look: 'group',
          show: { title: '日常', layout: 'stack', fold: 'open' },
          children: [{ id: 'in-daily', look: 'text', show: { text: '日常里面的字' } }],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'plain',
          look: 'group',
          show: { title: '普通', layout: 'stack' },
          children: [{ id: 'in-plain', look: 'text', show: { text: '普通里面的字' } }],
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

it('starts closed or open as the config says, opens and closes on a tap, and writes nothing', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed });
  expect(await screen.findByTestId('component-subs')).toBeTruthy();
  // closed: the title shows, what is inside does not.
  expect(screen.getByTestId('group-fold-subs')).toBeTruthy();
  expect(screen.queryByText('订阅里面的字')).toBeNull();
  // open: shows from the start.
  expect(screen.getByText('日常里面的字')).toBeTruthy();
  // no fold: not foldable, always shown.
  expect(screen.queryByTestId('group-fold-plain')).toBeNull();
  expect(screen.getByText('普通里面的字')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('group-fold-subs'));
  expect(await screen.findByText('订阅里面的字')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('group-fold-daily'));
  expect(screen.queryByText('日常里面的字')).toBeNull();
  await fireEvent.press(screen.getByTestId('group-fold-subs'));
  expect(screen.queryByText('订阅里面的字')).toBeNull();
});

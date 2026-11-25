import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { screen } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// On Android, React Native's JSResponderHandler makes the view that holds the JS touch responder
// intercept every move natively. A Pressable around a block therefore takes the swipe away from
// a horizontal scroller inside it (the board) as soon as JS has granted it the responder, which
// is always the case for a normal finger; only a very fast swipe got through. The layer that
// selects a block by long press must not be a touch responder there; the long press itself is
// the drag gesture's own activation (FocusItem).

const tasks: Collection = {
  id: 'tasks',
  name: '任务',
  fields: [
    { id: 'title', name: '标题', type: 'text' },
    {
      id: 'status',
      name: '状态',
      type: 'choice',
      options: [
        { id: 'todo', label: '待办' },
        { id: 'doing', label: '进行中' },
      ],
    },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: tasks },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'board',
          look: 'board',
          source: { table: 'tasks', group: { by: 'status' }, limit: 30 },
          show: { title: 'title' },
          tools: [{ as: 'drag', do: 'set', table: 'tasks', field: 'status', value: '$group' }],
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config as never;
};

const os = Platform.OS;
const setOS = (value: typeof Platform.OS) =>
  Object.defineProperty(Platform, 'OS', { get: () => value, configurable: true });
afterEach(() => setOS(os));

const layer = async () => {
  await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { seed });
  await screen.findByTestId('board-scroll');
  return screen.getByTestId('component-board');
};

it('on Android the layer around a board is not a touch responder, so the board scrolls under a slow finger', async () => {
  setOS('android');
  expect((await layer()).props.onStartShouldSetResponder).toBeUndefined();
});

it('on iOS the layer around a board keeps its long press and tap', async () => {
  setOS('ios');
  expect(typeof (await layer()).props.onStartShouldSetResponder).toBe('function');
});

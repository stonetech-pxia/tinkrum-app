import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { directEditEntry } from '../editing/entry';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';
import { actionHash } from '../widgets/ops';
import { useWidgetPlacement } from '../widgets/placed';
import type { WidgetPlatform, WidgetSnapshot } from '../widgets/types';

// Home screen widgets in app (D-323, D-325): execute widget tap operations upon app opening, undo
// together; long-pressing a component to "Pin to Home Screen" only records locally, writing visuals
// out accordingly; document supported component types and their placements.

const action = { do: 'create', table: 'water', values: { day: 'today' } } as const;
const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'water',
          name: '喝水',
          fields: [{ id: 'day', name: '日期', type: 'date' }],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'drink',
          look: 'button',
          show: { label: '+1 杯水', variant: 'filled' },
          tools: [action],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: { id: 'hello', look: 'text', show: { text: '你好' } },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config as never;
};

/** Mock widget platform. Queue behaves like the real one: reads without deleting, removed only via removeQueue (R07); each tap has a file and its own id. */
function fakeWidgets(queue: string[] = [], canPin = false) {
  const written: string[] = [];
  const entries = queue.map((text, i) => ({ id: `q${i + 1}`, text }));
  const platform: WidgetPlatform & { written: string[]; entries: typeof entries } = {
    written,
    entries,
    setSnapshot: jest.fn(async (json: string) => void written.push(json)),
    readQueue: jest.fn(async () => entries.map((e) => ({ ...e }))),
    removeQueue: jest.fn(async (ids: string[]) => {
      for (const id of ids) {
        const i = entries.findIndex((e) => e.id === id);
        if (i >= 0) entries.splice(i, 1);
      }
    }),
    canPin: () => canPin,
    pin: jest.fn(async () => true),
    onQueue: () => () => undefined,
  };
  return platform;
}

const last = (p: { written: string[] }) => JSON.parse(p.written.at(-1)!) as WidgetSnapshot;

async function openEditSheet(id: string) {
  await fireEvent.press(await screen.findByTestId('page-edit'));
  await fireEvent.press(await screen.findByTestId(`arrange-edit-${id}`));
  expect(await screen.findByTestId('edit-sheet')).toBeTruthy();
}

// Full-page editing entry point is disabled in app (D-235); enable it in tests to access the component operation panel.
beforeAll(() => {
  directEditEntry.pageButton = true;
});
afterAll(() => {
  directEditEntry.pageButton = false;
});
beforeEach(() => useWidgetPlacement.setState({ placed: null, repo: null }));
afterEach(() => jest.restoreAllMocks());

it('Add to Home Screen is the user’s own step: kept on this device, written to the widget, explained on iOS', async () => {
  const repo = new MemoryWorkspaceRepo();
  const widgets = fakeWidgets();
  await renderToolsApp(repo, undefined, { seed, widgets });
  // New user: not placed yet, no components on screen.
  await waitFor(() => expect(widgets.written.length).toBeGreaterThan(0));
  expect(last(widgets).items).toEqual([]);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await openEditSheet('drink');
  await fireEvent.press(screen.getByTestId('edit-widget'));
  expect(alert).toHaveBeenCalledWith('已加进小组件列表', expect.stringContaining('编辑小组件'));
  expect(JSON.parse((await repo.getMeta('widgets.placed'))!)).toEqual([
    { componentId: 'drink', placedAt: expect.any(Number) },
  ]);
  await waitFor(() => expect(last(widgets).items.map((i) => i.id)).toEqual(['drink']));
  expect(last(widgets).states[0]!.views.drink).toMatchObject({ kind: 'button', op: 'b:drink' });
  // Tapping again removes it.
  expect(screen.getByTestId('edit-widget')).toHaveTextContent('从桌面移除');
  await fireEvent.press(screen.getByTestId('edit-widget'));
  await waitFor(() => expect(last(widgets).items).toEqual([]));
  // AI cannot modify: configuration contains no home-screen placement records.
  expect(JSON.stringify(await repo.getHead())).not.toContain('widgets.placed');
});

it('Android asks the launcher to pin the widget instead of explaining', async () => {
  const widgets = fakeWidgets([], true);
  await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { seed, widgets });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await openEditSheet('drink');
  await act(() => fireEvent.press(screen.getByTestId('edit-widget')));
  expect(widgets.pin).toHaveBeenCalledWith('drink', expect.any(String));
  expect(alert).not.toHaveBeenCalled();
});

it('a component a widget can’t show says which ones it can, and is not placed', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed, widgets: fakeWidgets() });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await openEditSheet('hello');
  await fireEvent.press(screen.getByTestId('edit-widget'));
  expect(alert).toHaveBeenCalledWith(
    '这个组件还不能放到桌面',
    expect.stringContaining('统计、按钮和记录列表'),
  );
  expect(await repo.getMeta('widgets.placed')).toBeNull();
});

it('without the native module (Expo Go, web) there is no Add to Home Screen', async () => {
  await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { seed });
  await openEditSheet('drink');
  expect(screen.queryByTestId('edit-widget')).toBeNull();
});

it('taps queued on the widget are recorded when Tinkrum opens, with no undo (invariant 11)', async () => {
  const repo = new MemoryWorkspaceRepo();
  const at = Date.now() - 60_000;
  const tap = JSON.stringify({
    op: 'b:drink',
    component: 'drink',
    hash: actionHash(action),
    at,
  });
  const widgets = fakeWidgets([tap, tap]);
  await renderToolsApp(repo, undefined, { seed, widgets });
  expect(await screen.findByTestId('toast')).toHaveTextContent(/记下了桌面小组件上的 2 次点按/);
  expect((await repo.listRecords('water')).map((r) => r.createdAt)).toEqual([at, at]);
  expect(screen.queryByTestId('toast-undo')).toBeNull();
});

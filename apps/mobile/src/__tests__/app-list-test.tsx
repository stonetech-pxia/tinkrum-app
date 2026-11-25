import {
  applyOps,
  createStarterWorkspace,
  paperAppOps,
  type Locale,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { createGestureController } from 'react-native-gesture-handler/jest-utils';
import { AppState, BackHandler, type AppStateStatus } from 'react-native';

import { useAiReturn } from '../ai/return';
import { useGuide } from '../guide/store';
import type { HomeScreenEntry, HomeScreenPlatform } from '../home-screen/platform';
import { openStartApp } from '../shell/start-app';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp, testRegistry } from '../test-utils/render-app';

// The home page lists the apps, and an app's pages lead back to it (D-new-apphome-1, D-new-apphome-3).

/** A new user after the guide, plus an app of their own. */
function twoApps(locale: Locale, registry: Registry) {
  const start = createStarterWorkspace(locale, registry);
  const result = applyOps(
    start,
    [
      ...paperAppOps(start, locale, registry),
      { op: 'addContainer', app: { id: 'fit', name: '健身', bar: ['page:fit-home', 'ai'] } },
      {
        op: 'addContainer',
        page: { id: 'fit-home', title: '今天', app: 'fit', blocks: [] },
      },
      {
        op: 'addContainer',
        page: { id: 'fit-detail', title: '详情', app: 'fit', blocks: [] },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

/** Android's back key: the newest listener that handles it wins, as on the device. */
function backKey() {
  const handlers: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.push(handler);
    return { remove: () => void handlers.splice(handlers.indexOf(handler), 1) };
  });
  return async () => {
    await act(async () => {
      for (const handler of [...handlers].reverse()) if (handler({} as never)) break;
    });
  };
}

const start = async (locale: Locale = 'zh') => {
  const app = await renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), {
    seed: twoApps,
    locale,
  });
  await screen.findByTestId('nav-settings');
  return app;
};

describe('the app list on the home page', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
  });

  it('shows one icon per app with its name, and nothing else to open', async () => {
    await start();
    expect(screen.getByTestId('app-icon-paper')).toHaveTextContent('Paper');
    expect(screen.getByTestId('app-icon-fit')).toHaveTextContent('健身');
    expect(screen.queryByTestId('file-pick-open')).toBeNull();
    expect(screen.queryByTestId('app-home')).toBeNull();
    // Only the icons: no title above them.
    expect(screen.queryByText('Tinkrum')).toBeNull();
  });

  it('opens the app on tap; the button at the top left goes back to the list', async () => {
    const { store } = await start();
    await fireEvent.press(screen.getByTestId('app-icon-paper'));
    expect(await screen.findByTestId('file-pick-open')).toBeTruthy();
    expect(screen.getByTestId('run-scan-camera')).toBeTruthy();
    for (const page of ['paper-home', 'paper-files', 'paper-toolbox'])
      expect(screen.getByTestId(`nav-page:${page}`)).toBeTruthy();
    expect(screen.queryByTestId('nav-settings')).toBeNull();

    const button = screen.getByTestId('app-home');
    expect(button).toHaveProp('accessibilityLabel', '返回 App 清单');
    // Every page on the app's bar has it.
    await fireEvent.press(screen.getByTestId('nav-page:paper-toolbox'));
    expect(screen.getByTestId('app-home')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('app-home'));
    expect(await screen.findByTestId('app-icon-paper')).toBeTruthy();
    expect(store.getState().appId).toBeNull();
    expect(store.getState().tab).toBe('page:home');
    // Entering and leaving an app writes nothing (invariant 15).
    expect(store.getState().head!.id).toBe(1);
  });

  it('goes back to the list itself, not to the tab the app was opened from', async () => {
    const { store } = await start();
    await fireEvent.press(screen.getByTestId('nav-settings'));
    await fireEvent.press(await screen.findByTestId('settings-app-fit'));
    await fireEvent.press(await screen.findByTestId('app-home'));
    expect(await screen.findByTestId('app-icon-fit')).toBeTruthy();
    expect(store.getState().tab).toBe('page:home');
  });

  it('Android back on a page of the app’s bar goes to the list', async () => {
    const press = backKey();
    const { store } = await start();
    await fireEvent.press(screen.getByTestId('app-icon-fit'));
    await screen.findByTestId('app-home');
    await press();
    expect(store.getState().appId).toBeNull();
    expect(await screen.findByTestId('app-icon-fit')).toBeTruthy();
  });

  it('Android back on a pushed page only closes that page', async () => {
    const press = backKey();
    const { store } = await start();
    await fireEvent.press(screen.getByTestId('app-icon-fit'));
    await screen.findByTestId('app-home');
    await act(() => router.push('/page/fit-detail'));
    await press();
    expect(store.getState().appId).toBe('fit');
  });

  it('hides the button while a page is being edited, and back does not leave the app', async () => {
    const press = backKey();
    const { store } = await start();
    await fireEvent.press(screen.getByTestId('app-icon-fit'));
    await screen.findByTestId('app-home');
    await act(async () => store.getState().startEditing('fit-home'));
    expect(screen.queryByTestId('app-home')).toBeNull();
    await press();
    expect(store.getState().appId).toBe('fit');
  });

  it('an app that has only Tink in its bar can still be left', async () => {
    const { store } = await start();
    const result = applyOps(
      store.getState().config!,
      [{ op: 'addContainer', app: { id: 'blank', name: '空白' } }],
      { registry: testRegistry, locale: 'zh' },
    );
    if (!result.ok) throw new Error(result.error);
    await act(async () => {
      store.setState({ config: result.config });
      store.getState().enterApp('blank');
    });
    await fireEvent.press(await screen.findByTestId('app-home'));
    expect(store.getState().appId).toBeNull();
    expect(await screen.findByTestId('app-icon-blank')).toBeTruthy();
  });
});

// A long press on an icon opens the app's menu; the phone's home screen is one step away (D-new-apphome-5).
describe('long-pressing an app', () => {
  afterEach(() => jest.restoreAllMocks());

  const fakePhone = (canPin: boolean) => {
    const pinned: HomeScreenEntry[] = [];
    const phone: HomeScreenPlatform = {
      setItems: async () => undefined,
      canPin: () => canPin,
      pin: async (item) => {
        pinned.push(item);
        return true;
      },
      takeLaunched: () => null,
      onOpen: () => () => undefined,
    };
    return { phone, pinned };
  };
  const open = async (canPin: boolean, id: string) => {
    const { phone, pinned } = fakePhone(canPin);
    const app = await renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), {
      seed: twoApps,
      homeScreen: phone,
    });
    await fireEvent(await screen.findByTestId(`app-icon-${id}`), 'longPress');
    await screen.findByTestId('app-menu');
    return { ...app, pinned };
  };

  // Found on an Android emulator (2026-11-25): the page's long-press edit took the touch first.
  it('keeps the touch for itself: the page does not start editing the block', async () => {
    const app = await renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), {
      seed: twoApps,
    });
    const icon = await screen.findByTestId('app-icon-paper');
    const hold = async () => {
      const gesture = createGestureController('single-drag-apps');
      await act(async () => {
        gesture.begin({ absoluteX: 60, absoluteY: 120 });
        gesture.activate({ absoluteX: 60, absoluteY: 120 });
        jest.runAllTicks();
      });
      await act(async () => gesture.end());
    };
    await fireEvent(icon, 'pressIn');
    await hold();
    expect(screen.queryByTestId('single-toolbar-apps')).toBeNull();
    expect(app.store.getState().editing).toBeNull();
    // Beside the icons the block can still be edited (D-235).
    await fireEvent(icon, 'pressOut');
    await hold();
    expect(await screen.findByTestId('single-toolbar-apps')).toBeTruthy();
  });

  it('opens its menu without opening the app or writing anything', async () => {
    const { store } = await open(true, 'paper');
    expect(store.getState().appId).toBeNull();
    expect(store.getState().head!.id).toBe(1);
  });

  it('gives an app already in the Tinkrum icon’s menu its own icon, where the phone can', async () => {
    const { pinned } = await open(true, 'paper');
    await fireEvent.press(screen.getByTestId('app-menu-pin'));
    await waitFor(() => expect(pinned).toHaveLength(1));
    // Tinkrum's red, with the app's drawn sheet (D-606, D-625).
    expect(pinned[0]).toMatchObject({
      id: 'app:paper',
      title: 'Paper',
      art: { icon: 'my:tinkrum-paper', background: '#D92D20' },
    });
    expect(pinned[0]!.art!.drawn!.paths.length).toBeGreaterThan(0);
  });

  it('putting another app there goes straight on to its own icon', async () => {
    const { store, pinned } = await open(true, 'fit');
    await fireEvent.press(screen.getByText('放到桌面'));
    await waitFor(() => expect(pinned.map((x) => x.id)).toEqual(['app:fit']));
    expect(store.getState().config!.nav.phoneHomeScreen).toEqual(['app:paper', 'app:fit']);
  });

  it('only fills the menu on a phone that cannot place icons', async () => {
    const { store, pinned } = await open(false, 'fit');
    expect(screen.queryByTestId('app-menu-pin')).toBeNull();
    await fireEvent.press(screen.getByText('放到桌面'));
    await waitFor(() =>
      expect(store.getState().config!.nav.phoneHomeScreen).toEqual(['app:paper', 'app:fit']),
    );
    expect(pinned).toEqual([]);
  });
});

// With one app, Tinkrum opens in it (D-new-apphome-6).
describe('starting Tinkrum', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
    useAiReturn.setState({ pending: null });
  });

  const onlyPaper = (locale: Locale, registry: Registry) => {
    const config = createStarterWorkspace(locale, registry);
    const result = applyOps(config, paperAppOps(config, locale, registry), { registry, locale });
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };
  const launch = async (
    stage: 'goal' | 'done' = 'done',
    seed: (locale: Locale, registry: Registry) => WorkspaceConfig = onlyPaper,
  ) => {
    useGuide.setState({ stage });
    const app = await renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), { seed });
    await act(async () => openStartApp(app.store));
    return app;
  };

  it('opens in the only app, without writing anything; the list is one tap away', async () => {
    const { store } = await launch();
    expect(await screen.findByTestId('file-pick-open')).toBeTruthy();
    expect(store.getState().head!.id).toBe(1);
    await fireEvent.press(screen.getByTestId('app-home'));
    expect(await screen.findByTestId('app-icon-paper')).toBeTruthy();
  });

  it('opens on the list when there are two apps', async () => {
    const { store } = await launch('done', twoApps);
    expect(store.getState().appId).toBeNull();
  });

  it('stays on the home page while the guide runs', async () => {
    const { store } = await launch('goal');
    expect(store.getState().appId).toBeNull();
  });

  it('stays on the home page while a hand-off to another AI app is waited for', async () => {
    useAiReturn.getState().start('setup');
    const { store } = await launch();
    expect(store.getState().appId).toBeNull();
  });

  it('stays on a home page that holds more than the app list', async () => {
    const { store } = await launch('done', (locale, registry) => {
      const result = applyOps(
        onlyPaper(locale, registry),
        [
          {
            op: 'addContainer',
            page: 'home',
            block: { id: 'note', look: 'text', show: { text: '记得交房租' } },
          },
        ],
        { registry, locale },
      );
      if (!result.ok) throw new Error(result.error);
      return result.config;
    });
    expect(store.getState().appId).toBeNull();
  });

  it('coming back after a long while stays in the only app', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      listeners.push(listener as (state: AppStateStatus) => void);
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    const { store } = await launch();
    await screen.findByTestId('file-pick-open');
    jest.useFakeTimers();
    await act(async () => {
      listeners.forEach((l) => l('background'));
      jest.advanceTimersByTime(31_000);
      listeners.forEach((l) => l('active'));
      jest.advanceTimersByTime(1000);
    });
    expect(store.getState().appId).toBe('paper');
  });
});

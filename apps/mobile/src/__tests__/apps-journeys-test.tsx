import {
  THEME_PRESETS,
  appFileOfApp,
  appFileText,
  applyOps,
  readAppFile,
  type AIProvider,
  type Op,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { AppState } from 'react-native';

import { saveAppOrigin } from '../apps/origin';
import type { HomeScreenEntry, HomeScreenPlatform } from '../home-screen/platform';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp, homeWithFileEntries, testRegistry } from '../test-utils/render-app';

// Multiple apps (D-485): enter via main page entry point, bottom bar switches to the app's own, with a fixed "Back to Tinkrum" to return home.

/** A fitness app: two pages, bottom bar is two pages plus Tink; entry button on the main page. */
function withFitness(locale: 'zh' | 'en' | 'fr', registry: typeof testRegistry) {
  const base = homeWithFileEntries(locale, registry);
  const ops: Op[] = [
    { op: 'addContainer', app: { id: 'fit', name: '健身', icon: 'heart' } },
    { op: 'addContainer', page: { id: 'fit-home', title: '今天', app: 'fit', blocks: [] } },
    { op: 'addContainer', page: { id: 'fit-plan', title: '计划', app: 'fit', blocks: [] } },
    { op: 'updateContainer', app: { id: 'fit', bar: ['page:fit-home', 'page:fit-plan', 'ai'] } },
    { op: 'setTheme', app: 'fit', primaryColor: '#2255aa' },
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'open-fit',
        look: 'button',
        show: { label: '健身', variant: 'row' },
        opens: 'app:fit',
      } as never,
    },
    // Entry card: name and icon omitted, retrieved dynamically from the app.
    {
      op: 'addContainer',
      page: 'home',
      block: { id: 'fit-card', look: 'entry', opens: 'app:fit' } as never,
    },
  ];
  const result = applyOps(base, ops, { registry, locale });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

describe('apps (UI)', () => {
  const start = () =>
    renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), { seed: withFitness });

  // No "Back to Tinkrum" inside sub-apps (D-485): leaving the app and returning brings you back to the home screen.
  const handlers: ((state: string) => void)[] = [];
  const toState = (state: string) => handlers.forEach((h) => h(state));
  const appState = () =>
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (state: string) => void,
    ) => {
      handlers.push(handler);
      return { remove: () => {} };
    }) as never);
  /** Wait a moment (allowing the 700 ms debounce check to finish). */
  const wait = async (ms: number) => {
    const t0 = Date.now();
    await waitFor(
      () => {
        if (Date.now() - t0 < ms) throw new Error('waiting');
      },
      { timeout: ms + 3000, interval: 50 },
    );
  };
  /** Leave the app and return (tapping the Tinkrum icon on the phone); default absence is 31 seconds, counted as leaving only after exceeding 30 seconds (D-612). */
  let clockSkew = 0;
  let dateSpy: jest.SpyInstance | undefined;
  const leaveAndReturn = async (awayMs = 31_000) => {
    await act(async () => toState('background'));
    // Advance the clock only, wait duration proceeds normally (timers in tests are real).
    dateSpy?.mockRestore();
    const now = Date.now.bind(Date);
    clockSkew = awayMs;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now() + clockSkew);
    await act(async () => toState('active'));
    await wait(900);
    dateSpy.mockRestore();
    dateSpy = undefined;
  };

  it('opens an app from a home button, swaps the bar, and offers only the app list as a way back', async () => {
    appState();
    const { store } = await start();
    await screen.findByTestId('nav-settings');

    await fireEvent.press((await screen.findAllByText('健身'))[0]!);
    // App's bottom bar: its own two pages and Tink; home settings are absent. The way home is the button at the top left (D-646), not a bar entry.
    expect(await screen.findByTestId('nav-page:fit-home')).toBeTruthy();
    expect(screen.getByTestId('nav-page:fit-plan')).toBeTruthy();
    expect(screen.getByTestId('nav-ai')).toBeTruthy();
    expect(screen.getByTestId('app-home')).toBeTruthy();
    expect(screen.queryByTestId('nav-settings')).toBeNull();
    expect(store.getState().appId).toBe('fit');

    await fireEvent.press(screen.getByTestId('nav-page:fit-plan'));
    expect(store.getState().tab).toBe('page:fit-plan');

    // Leave and return: returns to the true home screen.
    await leaveAndReturn();
    expect(await screen.findByTestId('nav-settings')).toBeTruthy();
    expect(store.getState().appId).toBeNull();
    // Entering and exiting apps writes no data (invariant 15): version remains unchanged.
    expect(store.getState().head!.id).toBe(1);
  });

  it('an entry card that opens an app takes its name from the app, and Settings lists the app', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    // Button and entry card each have one "Fitness".
    expect(screen.getAllByText('健身').length).toBe(2);
    await fireEvent.press(screen.getByTestId('nav-settings'));
    expect(await screen.findByText('我的 App'.toUpperCase())).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-app-fit'));
    expect(await screen.findByTestId('nav-page:fit-home')).toBeTruthy();
    expect(store.getState().appId).toBe('fit');
  });

  it('shows an empty state for a new app that has only Tink in its bar', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
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
    expect(await screen.findByText('这个 App 还没有页面，点 Tink 来搭一个。')).toBeTruthy();
    expect(screen.queryByTestId('nav-settings')).toBeNull();
  });

  it('falls back to the home page when the app the user is in goes away', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    await act(async () => store.getState().enterApp('fit'));
    expect(await screen.findByTestId('nav-page:fit-home')).toBeTruthy();
    const result = applyOps(store.getState().config!, [{ op: 'removeContainer', app: 'fit' }], {
      registry: testRegistry,
      locale: 'zh',
    });
    if (!result.ok) throw new Error(result.error);
    await act(async () => store.setState({ config: result.config }));
    expect(await screen.findByTestId('nav-settings')).toBeTruthy();
    expect(store.getState().appId).toBeNull();
  });

  it('opening a page of another app switches to that app', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    // E.g. reminders, widgets opening pages inside an app: switch to its app first.
    let shown = false;
    await act(async () => {
      const nav = store.getState();
      shown = nav.showInShell(nav.config!, 'page:fit-plan');
    });
    expect(shown).toBe(true);
    expect(store.getState().appId).toBe('fit');
    expect(store.getState().tab).toBe('page:fit-plan');
  });

  // Tink inside an app can only modify this app (D-485, provisional rule).
  const planning = (ops: Op[]): AIProvider => ({ plan: async () => ({ kind: 'ops', ops }) });
  const table = { id: 'logs', name: '记录', fields: [{ id: 'title', name: '标题', type: 'text' }] };

  it('inside an app Tink may add to the app, and what it adds belongs to the app', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    await act(async () => store.getState().enterApp('fit'));
    let result;
    await act(async () => {
      result = await store
        .getState()
        .change('加一张表', planning([{ op: 'addData', table } as never]));
    });
    expect(result).toMatchObject({ kind: 'applied' });
    expect(store.getState().config!.data.tables.find((t) => t.id === 'logs')!.app).toBe('fit');
  });

  it('inside an app Tink cannot change the home; the same change from the home works', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    // Unspecified app style inside the app uses this app's style (opsForApp); main page pages cannot be modified inside the app.
    const homeChange = planning([
      { op: 'addData', table } as never,
      {
        op: 'addContainer',
        page: 'home',
        block: { id: 'hi', look: 'text', show: { text: 'hi' } } as never,
      },
    ]);
    const hasHi = () =>
      store
        .getState()
        .config!.containers.pages.find((p) => p.id === 'home')!
        .blocks.some((b) => b.id === 'hi');
    await act(async () => store.getState().enterApp('fit'));
    let result;
    await act(async () => {
      result = await store.getState().change('首页加一句话', homeChange);
    });
    expect(result).toMatchObject({ kind: 'invalid' });
    expect(store.getState().config!.data.tables.some((t) => t.id === 'logs')).toBe(false);
    expect(hasHi()).toBe(false);
    await act(async () => store.getState().leaveApp());
    await act(async () => {
      result = await store.getState().change('首页加一句话', homeChange);
    });
    expect(result).not.toMatchObject({ kind: 'invalid' });
    expect(store.getState().config!.data.tables.some((t) => t.id === 'logs')).toBe(true);
  });

  // Founder on phone, 2006-11-08: sub-app Tink page "Pick a style" and both preset sentences blocked as "out of scope".
  it('inside an app, Pick a style changes the app style, not the home style', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    const homeTheme = store.getState().config!.theme;
    await act(async () => store.getState().enterApp('fit'));
    await fireEvent.press(await screen.findByTestId('nav-ai'));
    await fireEvent.press(await screen.findByTestId('change-pick-style'));
    await fireEvent.press(await screen.findByTestId('style-material'));
    await fireEvent.press(await screen.findByTestId('draft-apply'));
    await waitFor(() =>
      expect(store.getState().config!.nav.apps!.find((a) => a.id === 'fit')!.theme).toEqual(
        THEME_PRESETS.material.theme,
      ),
    );
    expect(store.getState().config!.theme).toEqual(homeTheme);
    // Draft and application remain within this app afterwards (style modifications carry no pages and cannot fall back to home).
    expect(store.getState().appId).toBe('fit');
    // Open style selection again: highlights this app's current style.
    await fireEvent.press(await screen.findByTestId('nav-ai'));
    await fireEvent.press(await screen.findByTestId('change-pick-style'));
    expect((await screen.findByTestId('style-material')).props.accessibilityState.selected).toBe(
      true,
    );
  });

  it.each([
    ['change-want-receipts', 'receipts'],
    ['change-want-cards', 'contacts'],
  ])('inside an app, %s builds the sample inside the app', async (id, tableId) => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    const before = store.getState().config!;
    await act(async () => store.getState().enterApp('fit'));
    await fireEvent.press(await screen.findByTestId('nav-ai'));
    await fireEvent.press(await screen.findByTestId(id));
    await fireEvent.press(screen.getByTestId('change-submit'));
    await waitFor(() =>
      expect(store.getState().config!.data.tables.find((t) => t.id === tableId)?.app).toBe('fit'),
    );
    expect(screen.queryByTestId('change-feedback')).toBeNull();
    // Pages in draft: after applying draft they belong to this app, main page enters the app's bottom bar, home remains untouched.
    await fireEvent.press(await screen.findByTestId('draft-apply'));
    await waitFor(() => expect(store.getState().draft).toBeNull());
    const after = store.getState().config!;
    const added = after.containers.pages.filter(
      (p) => !before.containers.pages.some((o) => o.id === p.id),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const page of added) expect(page.app).toBe('fit');
    for (const tool of after.tools.filter((x) => !before.tools.some((o) => o.id === x.id)))
      expect(tool.app).toBe('fit');
    expect(after.nav.apps!.find((a) => a.id === 'fit')!.bar).toHaveLength(4);
    expect(after.nav.bar).toEqual(before.nav.bar);
    expect(after.containers.pages.find((p) => p.id === 'home')).toEqual(
      before.containers.pages.find((p) => p.id === 'home'),
    );
  });

  // Apps in desktop menu and deep links (D-485).
  class FakeHomeScreen implements HomeScreenPlatform {
    menus: HomeScreenEntry[][] = [];
    pinned: HomeScreenEntry[] = [];
    launched: string | null = null;
    private listener: ((id: string) => void) | null = null;
    async setItems(items: readonly HomeScreenEntry[]) {
      this.menus.push([...items]);
    }
    canPin() {
      return true;
    }
    async pin(item: HomeScreenEntry) {
      this.pinned.push(item);
      return true;
    }
    takeLaunched() {
      const id = this.launched;
      this.launched = null;
      return id;
    }
    onOpen(listener: (id: string) => void) {
      this.listener = listener;
      return () => {
        this.listener = null;
      };
    }
    tap(id: string) {
      this.listener?.(id);
    }
  }
  const withHomeScreen = (fake: HomeScreenPlatform) =>
    renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), {
      seed: withFitness,
      homeScreen: fake,
    });

  it('long-press an app in Settings puts it on the phone home screen menu, and tapping it opens the app', async () => {
    const fake = new FakeHomeScreen();
    const { store } = await withHomeScreen(fake);
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    // Long press to pop up menu, tap "Add to Home Screen".
    await fireEvent(await screen.findByTestId('settings-app-fit'), 'longPress');
    await fireEvent.press(await screen.findByText('放到桌面'));
    await screen.findByText('在桌面菜单里');
    expect(store.getState().config!.nav.phoneHomeScreen).toEqual(['app:fit']);
    // Rendered on the desktop with the app's own icon and primary color background (D-606).
    expect(fake.menus.at(-1)).toEqual([
      {
        id: 'app:fit',
        title: '健身',
        symbol: 'heart.fill',
        art: { icon: 'heart', background: '#2255aa', foreground: '#FFFFFF' },
      },
    ]);
    // Tap desktop menu: enter that app.
    await act(async () => fake.tap('app:fit'));
    expect(store.getState().appId).toBe('fit');
    expect(await screen.findByTestId('nav-page:fit-home')).toBeTruthy();
  });

  // Change icon (D-606): long press menu to select a built-in icon or enter an emoji; desktop icon updates accordingly.
  const openMenu = async (id = 'fit') => {
    await fireEvent(await screen.findByTestId(`settings-app-${id}`), 'longPress');
    await screen.findByTestId('app-menu');
  };

  it('changes the icon of an app to a built-in one, and the phone home screen follows', async () => {
    const fake = new FakeHomeScreen();
    const { store } = await withHomeScreen(fake);
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await openMenu();
    await fireEvent.press(screen.getByText('放到桌面'));
    await screen.findByText('在桌面菜单里');
    const head = store.getState().head!.id;
    // Opening the menu and icon grid is for viewing only: modifies nothing (invariant 15).
    await openMenu();
    await fireEvent.press(screen.getByText('换图标'));
    await screen.findByTestId('app-icon-star');
    expect(store.getState().head!.id).toBe(head);
    // The currently used one is highlighted.
    expect(screen.getByTestId('app-icon-heart').props.accessibilityState).toMatchObject({
      selected: true,
    });
    await fireEvent.press(screen.getByTestId('app-icon-star'));
    await waitFor(() => expect(store.getState().config!.nav.apps![0]!.icon).toBe('star'));
    await waitFor(() => expect(screen.queryByTestId('app-menu')).toBeNull());
    // A modification that can be undone in change history, with nothing else touched.
    expect(store.getState().head!.id).not.toBe(head);
    expect(store.getState().config!.nav.apps![0]).toMatchObject({ id: 'fit', name: '健身' });
    await waitFor(() =>
      expect(fake.menus.at(-1)).toEqual([
        {
          id: 'app:fit',
          title: '健身',
          symbol: 'star.fill',
          art: { icon: 'star', background: '#2255aa', foreground: '#FFFFFF' },
        },
      ]),
    );
  });

  it('takes one emoji as the icon; anything else is refused and nothing changes', async () => {
    const { store } = await start();
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await openMenu();
    await fireEvent.press(screen.getByText('换图标'));
    const head = store.getState().head!.id;
    await fireEvent.changeText(await screen.findByTestId('app-icon-emoji'), 'gym');
    await fireEvent.press(screen.getByTestId('app-icon-emoji-use'));
    await screen.findByText('只能填一个表情。');
    expect(store.getState().head!.id).toBe(head);
    // Leading and trailing spaces are ignored.
    await fireEvent.changeText(screen.getByTestId('app-icon-emoji'), ' 🏋️ ');
    await fireEvent.press(screen.getByTestId('app-icon-emoji-use'));
    await waitFor(() => expect(store.getState().config!.nav.apps![0]!.icon).toBe('🏋️'));
    await waitFor(() => expect(screen.queryByTestId('app-menu')).toBeNull());
  });

  it('closes the menu without changing anything', async () => {
    const { store } = await start();
    const head = store.getState().head!.id;
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await openMenu();
    await fireEvent.press(screen.getByText('换图标'));
    await fireEvent.press(await screen.findByTestId('app-menu-cancel'));
    await waitFor(() => expect(screen.queryByTestId('app-menu')).toBeNull());
    await openMenu();
    await fireEvent.press(screen.getByTestId('app-menu-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('app-menu')).toBeNull());
    expect(store.getState().head!.id).toBe(head);
  });

  // Android system dialogs support at most three buttons: imported app menu had five or six items after adding to desktop, causing "Add to Home Screen" to be dropped previously.
  it('an imported app on the menu still offers its own home screen icon, next to the other items', async () => {
    const fake = new FakeHomeScreen();
    const repo = new MemoryWorkspaceRepo();
    const { store } = await renderToolsApp(repo, new FakeFiles(), {
      seed: withFitness,
      homeScreen: fake,
    });
    // App imported from file retains original file locally (used for "Restore initial state").
    await saveAppOrigin(
      repo,
      'fit',
      appFileText(appFileOfApp(store.getState().config!, 'fit')!, new Date()),
    );
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await openMenu();
    // Not yet placed in the desktop menu: no "Add to Home Screen".
    expect(screen.queryByText('添加到桌面')).toBeNull();
    await fireEvent.press(screen.getByText('放到桌面'));
    await screen.findByText('在桌面菜单里');
    // Putting it there already asked for its own icon (D-648); the item stays for later.
    await waitFor(() => expect(fake.pinned).toHaveLength(1));
    fake.pinned.length = 0;
    await openMenu();
    for (const item of ['从桌面拿掉', '添加到桌面', '换图标', '分享这个 App', '恢复初始样子'])
      expect(screen.getByText(item)).toBeTruthy();
    await fireEvent.press(screen.getByText('添加到桌面'));
    await waitFor(() =>
      expect(fake.pinned).toEqual([
        {
          id: 'app:fit',
          title: '健身',
          symbol: 'heart.fill',
          art: { icon: 'heart', background: '#2255aa', foreground: '#FFFFFF' },
        },
      ]),
    );
  });

  it('opens the app when the app was started from its home screen item', async () => {
    const fake = new FakeHomeScreen();
    fake.launched = 'app:fit';
    const { store } = await withHomeScreen(fake);
    await screen.findByTestId('nav-page:fit-home');
    expect(store.getState().appId).toBe('fit');
  });

  it('stays on the home page when the menu item is for an app that is gone', async () => {
    const fake = new FakeHomeScreen();
    const { store } = await withHomeScreen(fake);
    await screen.findByTestId('nav-settings');
    await act(async () => fake.tap('app:gone'));
    expect(store.getState().appId).toBeNull();
  });

  it('morph://app/<id> opens the app, and an unknown id stays on the home page', async () => {
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    await act(async () => router.push('/app/fit'));
    expect(await screen.findByTestId('nav-page:fit-home')).toBeTruthy();
    expect(store.getState().appId).toBe('fit');
    await act(async () => store.getState().leaveApp());
    await act(async () => router.push('/app/gone'));
    await screen.findByTestId('nav-settings');
    expect(store.getState().appId).toBeNull();
  });

  it('stays in the app when the app is opened from the home screen after being away', async () => {
    appState();
    const fake = new FakeHomeScreen();
    const { store } = await withHomeScreen(fake);
    await screen.findByTestId('nav-settings');
    await act(async () => toState('background'));
    await act(async () => toState('active'));
    // Desktop menu tap registers only after returning to foreground: entering app is later than leaving, so it stays in the app.
    await act(async () => fake.tap('app:fit'));
    await wait(900);
    expect(store.getState().appId).toBe('fit');
  });

  it('stays where it is when a pushed page is open: a permission window or a picker only flashes the app away', async () => {
    appState();
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    await act(async () => store.getState().enterApp('fit'));
    await screen.findByTestId('nav-page:fit-home');
    await act(async () =>
      router.push({ pathname: '/page/[pageId]', params: { pageId: 'fit-plan' } }),
    );
    await screen.findByTestId('page-ai');
    await leaveAndReturn();
    // Pushed page remains, and app is not exited.
    expect(store.getState().appId).toBe('fit');
    expect(screen.getByTestId('page-ai')).toBeTruthy();
  });

  it('stays in the app when it was away for 30 seconds or less', async () => {
    appState();
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    await act(async () => store.getState().enterApp('fit'));
    await screen.findByTestId('nav-page:fit-home');
    await leaveAndReturn(30_000);
    expect(store.getState().appId).toBe('fit');
    expect(screen.getByTestId('nav-page:fit-home')).toBeTruthy();
    // Exceed 30 seconds to return to home screen.
    await leaveAndReturn(30_001);
    expect(store.getState().appId).toBeNull();
  });

  it('being away from the home page changes nothing', async () => {
    appState();
    const { store } = await start();
    await screen.findByTestId('nav-settings');
    await leaveAndReturn();
    expect(store.getState().appId).toBeNull();
    expect(store.getState().head!.id).toBe(1);
  });
});

// Share an app (D-545): Settings -> long press in My Apps, "Share this App"; shares an app file containing only structure.
describe('share an app', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Long press app, tap this item in the menu. */
  async function longPressAndPick(id: string, item: string) {
    await fireEvent(await screen.findByTestId(`settings-app-${id}`), 'longPress');
    await screen.findByTestId('app-menu');
    await fireEvent.press(screen.getByText(item));
  }

  it('a new user has no app of their own, so there is nothing to share', async () => {
    const files = new FakeFiles();
    await renderToolsApp(new MemoryWorkspaceRepo(), files, { seed: homeWithFileEntries });
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await screen.findByTestId('settings-ai');
    expect(screen.queryByTestId(/^settings-app-/)).toBeNull();
    expect(files.sharedTexts.size).toBe(0);
  });

  it('shares the app as an app file that reads back, and changes nothing', async () => {
    const files = new FakeFiles();
    const { store } = await renderToolsApp(new MemoryWorkspaceRepo(), files, {
      seed: withFitness,
    });
    const head = store.getState().head!.id;
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await longPressAndPick('fit', '分享这个 App');
    await waitFor(() => expect(files.sharedTexts.size).toBe(1));
    const [name, text] = [...files.sharedTexts][0]!;
    expect(name).toBe('tinkrum-app-fit.json');
    const file = readAppFile(text)!;
    expect(file.app).toMatchObject({ id: 'fit', name: '健身' });
    expect(file.pages.map((p) => p.id)).toEqual(['fit-home', 'fit-plan']);
    expect(store.getState().head!.id).toBe(head);
  });

  it('leaves out the user’s files: a file slot in the app comes out empty', async () => {
    const files = new FakeFiles();
    await renderToolsApp(new MemoryWorkspaceRepo(), files, {
      seed: (locale, registry) => {
        const r = applyOps(
          withFitness(locale, registry),
          [
            {
              op: 'addContainer',
              page: 'fit-home',
              block: {
                id: 'plan-pdf',
                look: 'entry',
                show: { title: '计划', icon: 'folder' },
                opens: { file: 'userfile0009' },
              } as never,
            },
          ],
          { registry, locale },
        );
        if (!r.ok) throw new Error(r.error);
        return r.config;
      },
    });
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await longPressAndPick('fit', '分享这个 App');
    await waitFor(() => expect(files.sharedTexts.size).toBe(1));
    const text = [...files.sharedTexts.values()][0]!;
    expect(text).not.toContain('userfile0009');
    expect(text).toContain('plan-pdf');
  });
});

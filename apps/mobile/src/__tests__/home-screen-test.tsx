import {
  createStarterWorkspace,
  type Locale,
  presetWorkflow,
  type Registry,
  type Workflow,
  WORKFLOW_PRESETS,
} from '@morph/core';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import type { HomeScreenEntry, HomeScreenPlatform } from '../home-screen/platform';
import { renderToolsApp } from '../test-utils/render-app';
import type { WorkspaceStore } from '../workspace/store';

// Home screen (D-271): long-press menu for Tinkrum icon updates dynamically based on current
// configuration (AI, undo, delete, rename); opening from home screen starts immediately; Android
// "Add to Home Screen" prompts only when user taps (system shows confirmation dialog); iOS only
// explains long-pressing the Tinkrum icon.

class FakeHomeScreen implements HomeScreenPlatform {
  /** Menus replaced entirely each time. */
  menus: HomeScreenEntry[][] = [];
  disabledMessage = '';
  pinned: HomeScreenEntry[] = [];
  launched: string | null = null;
  private listener: ((id: string) => void) | null = null;
  constructor(private readonly pinnable: boolean) {}
  async setItems(items: readonly HomeScreenEntry[], disabledMessage: string) {
    this.menus.push([...items]);
    this.disabledMessage = disabledMessage;
  }
  canPin() {
    return this.pinnable;
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
  /** User taps home screen menu (App is running). */
  tap(id: string) {
    this.listener?.(id);
  }
  get menu() {
    return this.menus.at(-1);
  }
}

async function askAi(text: string) {
  await fireEvent.press(screen.getByTestId('nav-ai'));
  await fireEvent.changeText(await screen.findByTestId('change-input'), text);
  await fireEvent.press(screen.getByTestId('change-submit'));
}

async function addVisa(store: WorkspaceStore) {
  const wf = presetWorkflow(WORKFLOW_PRESETS[0]!, 'zh', 'visa-photo');
  await act(async () => {
    await store.getState().proposeOps([{ op: 'addTool', tool: wf }], 'add');
    await store.getState().confirm();
  });
}

/** New user workspace with several ready-made quick actions: enabled ones placed on home screen, disabled ones not placed. */
const withPresets =
  (on: number[], off: number[] = []) =>
  (locale: Locale, registry: Registry) => {
    const config = createStarterWorkspace(locale, registry);
    const added: Workflow[] = [...on, ...off].map((i) =>
      presetWorkflow(WORKFLOW_PRESETS[i]!, locale, WORKFLOW_PRESETS[i]!.id),
    );
    return {
      ...config,
      nav: { ...config.nav, phoneHomeScreen: on.map((i) => WORKFLOW_PRESETS[i]!.id) },
      tools: [...config.tools, ...added],
    };
  };

describe('quick actions on the phone home screen (D-271)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('AI puts one there; Android offers “add to home screen” and only asks when tapped', async () => {
    const home = new FakeHomeScreen(true);
    const { store } = await renderToolsApp(undefined, undefined, { homeScreen: home });
    // New user: menu is empty (also disables previously left home screen icons).
    await waitFor(() => expect(home.menu).toEqual([]));
    await addVisa(store);
    expect(home.menu).toEqual([]);

    await askAi('把签证照片放到桌面');
    // Feature modification (D-191): applied directly, opening its "Done" view explaining how to use it.
    const ready = await screen.findByTestId('ready-screen');
    expect(within(ready).getByTestId('home-screen-how')).toHaveTextContent(/长按 Tinkrum 图标/);
    await waitFor(() =>
      expect(home.menu).toEqual([
        { id: 'visa-photo', title: '签证 / 证件照', symbol: expect.any(String) },
      ]),
    );
    expect(home.disabledMessage).toBe('这个快捷操作已经不在桌面上了。');
    // Must not trigger system dialogs automatically during app modifications.
    expect(home.pinned).toEqual([]);
    await fireEvent.press(screen.getByTestId('home-screen-pin'));
    expect(home.pinned).toEqual([
      expect.objectContaining({ id: 'visa-photo', title: '签证 / 证件照' }),
    ]);
    // Home page does not gain an extra card as a result ("Add to Home Screen" is not "Add to Home Page", D-109).
    const page = store.getState().config!.containers.pages.find((p) => p.id === 'home')!;
    expect(page.blocks.some((c) => c.look === 'action')).toBe(false);
  });

  it('undo takes it off the menu again', async () => {
    const home = new FakeHomeScreen(true);
    const { store } = await renderToolsApp(undefined, undefined, { homeScreen: home });
    await addVisa(store);
    await askAi('把签证照片放到桌面');
    await waitFor(() => expect(home.menu?.map((e) => e.id)).toEqual(['visa-photo']));
    const banner = await within(await screen.findByTestId('ready-screen')).findByTestId('banner');
    await fireEvent.press(within(banner).getByText('撤销'));
    await waitFor(() => expect(home.menu).toEqual([]));
    expect(store.getState().config!.nav.phoneHomeScreen ?? []).not.toContain('visa-photo');
  });

  it('renaming and deleting the quick action update the menu', async () => {
    const home = new FakeHomeScreen(true);
    const { store } = await renderToolsApp(undefined, undefined, { homeScreen: home });
    await addVisa(store);
    await act(async () => {
      await store
        .getState()
        .proposeOps([{ op: 'updateContainer', nav: { phoneHomeScreen: ['visa-photo'] } }], 'on');
      await store.getState().confirm();
    });
    await waitFor(() => expect(home.menu?.map((e) => e.title)).toEqual(['签证 / 证件照']));
    await act(async () => {
      await store
        .getState()
        .proposeOps(
          [{ op: 'updateTool', tool: 'visa-photo', changes: { name: '美签照片' } }],
          'rename',
        );
      await store.getState().confirm();
    });
    await waitFor(() => expect(home.menu?.map((e) => e.title)).toEqual(['美签照片']));
    await act(async () => {
      await store.getState().proposeOps([{ op: 'removeTool', tool: 'visa-photo' }], 'rm');
      await store.getState().confirm();
    });
    // Removed from menu; on Android, home screen pinned icons are disabled by the module (all those not in the menu are disabled).
    await waitFor(() => expect(home.menu).toEqual([]));
  });

  it('iOS has no pin button, only how to find it', async () => {
    const home = new FakeHomeScreen(false);
    const { store } = await renderToolsApp(undefined, undefined, { homeScreen: home });
    await addVisa(store);
    await askAi('把签证照片放到桌面');
    const ready = await screen.findByTestId('ready-screen');
    expect(within(ready).getByTestId('home-screen-how')).toHaveTextContent(
      '在手机桌面上长按 Tinkrum 图标就能看到「签证 / 证件照」，在那里点一下直接开始。',
    );
    expect(screen.queryByTestId('home-screen-pin')).toBeNull();
  });

  it('"Add to Home Page" still means the home page and puts nothing on the phone', async () => {
    const home = new FakeHomeScreen(true);
    const { store } = await renderToolsApp(undefined, undefined, { homeScreen: home });
    await addVisa(store);
    await askAi('把签证照片放到首页');
    // Home page is app-level appearance, enters draft first (D-190); draft home page has an extra run card, home screen remains unchanged.
    const draft = await waitFor(() => store.getState().draft!.steps.at(-1)!.config);
    expect(
      draft.containers.pages.find((p) => p.id === 'home')!.blocks.some((c) => c.look === 'action'),
    ).toBe(true);
    expect(draft.nav.phoneHomeScreen ?? []).toEqual([]);
    expect(home.menu).toEqual([]);
    expect(screen.queryByTestId('home-screen-how')).toBeNull();
  });

  it('opening from the home screen starts the quick action, cold or warm', async () => {
    const home = new FakeHomeScreen(true);
    home.launched = 'visa-photo';
    await renderToolsApp(undefined, undefined, { homeScreen: home, seed: withPresets([0]) });
    // Cold start: launches directly into the run page (starts the same as tapping a run card, D-108), opened only once.
    expect(await screen.findByTestId('run-screen')).toBeTruthy();
    expect(home.launched).toBeNull();
    await act(() => router.back());
    await waitFor(() => expect(screen.queryByTestId('run-screen')).toBeNull());
    // Tap menu while app is running.
    await act(async () => home.tap('visa-photo'));
    expect(await screen.findByTestId('run-screen')).toBeTruthy();
  });

  it('the quick action editor puts it on and takes it off; a full menu says to take one off', async () => {
    const home = new FakeHomeScreen(true);
    const { store } = await renderToolsApp(undefined, undefined, { homeScreen: home });
    await addVisa(store);
    await act(() => router.push('/workflow/visa-photo'));
    await fireEvent.press(await screen.findByTestId('workflow-home-screen'));
    await waitFor(() => expect(home.menu?.map((e) => e.id)).toEqual(['visa-photo']));
    expect(await screen.findByTestId('home-screen-pin')).toBeTruthy();
    expect(screen.getByTestId('workflow-home-screen')).toHaveTextContent('从桌面拿掉');
    await fireEvent.press(screen.getByTestId('workflow-home-screen'));
    await waitFor(() => expect(home.menu).toEqual([]));
    expect(screen.queryByTestId('home-screen-pin')).toBeNull();
  });

  it('a full menu says to take one off first and changes nothing', async () => {
    const home = new FakeHomeScreen(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { store } = await renderToolsApp(undefined, undefined, {
      homeScreen: home,
      seed: withPresets([1, 2, 3, 4], [0]),
    });
    await waitFor(() => expect(home.menu).toHaveLength(4));
    const head = store.getState().head!.id;
    await act(() => router.push(`/workflow/${WORKFLOW_PRESETS[0]!.id}`));
    await fireEvent.press(await screen.findByTestId('workflow-home-screen'));
    expect(alert).toHaveBeenCalledWith('桌面菜单最多放 4 个快捷操作，先拿掉一个。');
    expect(store.getState().head!.id).toBe(head);
  });
});

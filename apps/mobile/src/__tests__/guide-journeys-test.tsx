import {
  BUILTIN_TOOLS,
  createMockAIProvider,
  createRegistry,
  createStarterWorkspace,
  paperAppOps,
  prepareOps,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { LOOK_PROMPTS, useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp, homeWithFileEntries, openPick } from '../test-utils/render-app';

// Newbie guide (D-149, D-231, D-new-apphome-2): swipe intro -> step 1 builds the Paper app
// (takes effect immediately) -> step 2 says it is on the home page -> step 3 sample app (D-260,
// see also sample-apps-test.tsx).

const TYPED = { timeout: 4000 };

async function startGuide(stage?: 'goal' | 'samples', seed = createStarterWorkspace) {
  const repo = new MemoryWorkspaceRepo();
  if (stage) await repo.setMeta('guide', stage);
  const files = new FakeFiles();
  await act(() => useGuide.getState().load(repo));
  return renderToolsApp(repo, files, { seed });
}

describe('first-run guide', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
  });

  it('the step 1 sentences are ones the offline rules understand', async () => {
    const registry = createRegistry(BUILTIN_TOOLS);
    const ai = createMockAIProvider();
    for (const locale of ['zh', 'en'] as const) {
      for (const prompt of LOOK_PROMPTS) {
        const config = createStarterWorkspace(locale, registry);
        const plan = await ai.plan(prompt[locale], { config, registry, locale });
        expect([prompt[locale], plan.kind]).toEqual([prompt[locale], 'ops']);
      }
    }
  });

  it('shows the intro first; skipping it leads to step 1 on the home page', async () => {
    const { repo } = await startGuide();
    expect(await screen.findByTestId('welcome')).toHaveTextContent(/拍下纸质文件/);
    await fireEvent.press(screen.getByTestId('welcome-next'));
    await fireEvent.press(screen.getByTestId('welcome-skip'));
    expect(await screen.findByTestId('guide-look')).toHaveTextContent(/空荡荡/);
    expect(await repo.getMeta('guide')).toBe('look');
  });

  it('the intro has three pages; "Start" on the last one leads to step 1', async () => {
    const { repo } = await startGuide();
    await screen.findByTestId('welcome');
    for (const i of [0, 1, 2]) expect(screen.getByTestId(`welcome-page-${i}`)).toBeTruthy();
    expect(screen.queryByTestId('welcome-page-3')).toBeNull();
    expect(screen.getByTestId('welcome-art-scan')).toBeTruthy();
    expect(screen.getByTestId('welcome-page-0')).toHaveTextContent(/文件只在你的手机上处理/);
    // D-592: Page 2 explains three sources (including saying a sentence) to record into a mini app, with reminders; Page 3 explains Tink adding features and changing appearance.
    expect(screen.getByTestId('welcome-page-1')).toHaveTextContent(
      /扫描、打开文件或说一句，都能记/,
    );
    expect(screen.getByTestId('welcome-page-1')).toHaveTextContent(
      /各在自己的小 App 里，到时间会提醒你/,
    );
    const records = screen.getByTestId('welcome-art-records');
    for (const text of [/扫描/, /文件/, /说一句/, /开支/, /订阅/, /收据/]) {
      expect(records).toHaveTextContent(text);
    }
    expect(screen.getByTestId('welcome-page-2')).toHaveTextContent(
      /加功能、换样子，跟 Tink 说一句/,
    );
    expect(screen.getByTestId('welcome-art-style')).toHaveTextContent(/房租提醒 换霓虹风/);
    expect(screen.getByTestId('welcome-mini-reminder')).toHaveTextContent('交房租');
    for (let i = 0; i < 2; i++) await fireEvent.press(screen.getByTestId('welcome-next'));
    expect(screen.getByTestId('welcome-next')).toHaveTextContent('开始');
    await fireEvent.press(screen.getByTestId('welcome-next'));
    expect(await screen.findByTestId('guide-look')).toHaveTextContent(/空荡荡/);
    expect(await repo.getMeta('guide')).toBe('look');
  });

  // D-592: Introduction does not mention what to download later (originally the small text on Page 1 in D-510); the download prompt states its size and Wi-Fi status.
  it.each(['en', 'zh', 'fr'] as const)(
    'the intro says nothing about later downloads (%s, D-592)',
    async (locale) => {
      const repo = new MemoryWorkspaceRepo();
      await act(() => useGuide.getState().load(repo));
      await renderToolsApp(repo, new FakeFiles(), { locale });
      for (const i of [0, 1, 2]) {
        const page = await screen.findByTestId(`welcome-page-${i}`);
        expect(page).not.toHaveTextContent(/Wi-Fi|\d\s?(GB|Go)\b|下载|[Dd]ownload|[Tt]éléchar/);
      }
    },
  );

  const apps = (store: Awaited<ReturnType<typeof startGuide>>['store']) =>
    store.getState().config!.nav.apps?.map((a) => a.id) ?? [];

  /** A new user whose Paper app is already there, as the guide leaves it. */
  const withPaper = (locale: Locale, registry: Registry) => {
    const config = createStarterWorkspace(locale, registry);
    const result = prepareOps(config, paperAppOps(config, locale, registry), {
      registry,
      locale,
      now: new Date(2026, 9, 22),
    });
    if (!result.ok) throw new Error(result.issues.join('; '));
    return result.after;
  };

  it('step 1: the sentence fills the box and waits; sending builds the Paper app without a draft', async () => {
    const { repo, store } = await startGuide();
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    expect(await screen.findByTestId('guide-look')).toHaveTextContent(/空荡荡/);
    await fireEvent.press(await screen.findByTestId('guide-look-0'));
    // After typing, stay on the AI page for the user to send manually (D-231).
    await waitFor(
      () => expect(screen.getByTestId('change-input').props.editable).toBe(true),
      TYPED,
    );
    expect(screen.getByTestId('change-input')).toHaveProp('value', LOOK_PROMPTS[0]!.zh);
    expect(apps(store)).toEqual([]);
    await fireEvent.press(screen.getByTestId('change-submit'));
    // Takes effect immediately without entering draft mode; returns to the home page showing step 2. Guide modifications do not show "Applied · Undo" at the top (D-239).
    // The app is in the menu of the Tinkrum icon, and step 2 says so (D-new-apphome-4).
    expect(await screen.findByTestId('guide-goal')).toHaveTextContent(
      /搭好了，点图标就能打开。在手机桌面长按 Tinkrum 图标，也能直接打开 Paper/,
    );
    expect(store.getState().config!.nav.phoneHomeScreen).toEqual(['app:paper']);
    expect(store.getState().draft).toBeNull();
    expect(apps(store)).toEqual(['paper']);
    // The icon is on the home page, and opens the app once the bubble is closed.
    await fireEvent.press(screen.getByTestId('guide-later'));
    await fireEvent.press(screen.getByTestId('app-icon-paper'));
    expect(await screen.findByTestId('file-pick-open')).toBeTruthy();
    expect(screen.getByTestId('run-scan-camera')).toBeTruthy();
    expect(store.getState().banner).toBeNull();
    expect(screen.queryByTestId('banner')).toBeNull();
    expect(screen.queryByTestId('guide-undo-hint')).toBeNull();
    expect(screen.queryByTestId('guide-goal-trip-photos')).toBeNull();
    expect(await repo.getMeta('guide')).toBe('done');
  });

  // D-new-apphome-4: where the phone can place icons, step 2 says how to give Paper one of its own.
  it('step 2 tells a phone that can place icons to drag Paper onto the home screen', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'goal');
    await act(() => useGuide.getState().load(repo));
    await renderToolsApp(repo, new FakeFiles(), {
      seed: withPaper,
      homeScreen: {
        setItems: async () => undefined,
        canPin: () => true,
        pin: async () => true,
        takeLaunched: () => null,
        onOpen: () => () => undefined,
      },
    });
    expect(await screen.findByTestId('guide-goal')).toHaveTextContent(
      /长按 Tinkrum 图标，把 Paper 拖到桌面上，就能当独立 App 用/,
    );
  });

  // D-447: Step 1 is a message spoken by Tink, without "Step 1" label; the Tink icon in the top right of the home page animates, tapping it behaves the same as tapping the bubble.
  it('step 1 is Tink speaking, not a numbered card; tapping the moving Tink opens the same sentence', async () => {
    await startGuide();
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    const bubble = await screen.findByTestId('guide-look');
    expect(bubble).toHaveTextContent(/点击我，我给你搭第一个 App：Paper/);
    expect(bubble).not.toHaveTextContent(/第 1 步/);
    expect(screen.getByTestId('tink-lively')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('page-ai'));
    await waitFor(
      () => expect(screen.getByTestId('change-input')).toHaveProp('value', LOOK_PROMPTS[0]!.zh),
      TYPED,
    );
  });

  it('after the Tink bubbles the entry stops moving and opens the AI page as usual', async () => {
    await startGuide('samples');
    expect(await screen.findByTestId('page-ai')).toBeTruthy();
    expect(screen.queryByTestId('tink-lively')).toBeNull();
  });

  // D-448: The send button on the AI page is the white Tink icon, with no icon to the left of the input box; while busy, Tink animates with a short phrase next to it matching the planner stage.
  it('the send button is Tink; while busy it moves and says what the planner is doing', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { store } = await startGuide('goal');
    await fireEvent.press(await screen.findByTestId('page-ai'));
    const send = await screen.findByTestId('change-submit');
    expect(within(send).getByTestId('tink-hammer')).toBeTruthy();
    expect(screen.queryByTestId('change-progress')).toBeNull();
    await act(async () => store.setState({ busy: true, planProgress: null }));
    expect(screen.getByTestId('change-progress')).toHaveTextContent('收到！让我想想…');
    expect(within(send).getByTestId('tink-lively')).toBeTruthy();
    await act(async () => store.setState({ planProgress: 'style' }));
    expect(screen.getByTestId('change-progress')).toHaveTextContent('挑颜色挑到眼花…');
    await act(async () => store.setState({ planProgress: 'checking' }));
    expect(screen.getByTestId('change-progress')).toHaveTextContent('敲敲打打，检查一遍…');
    await act(async () => store.setState({ busy: false, planProgress: null }));
    expect(screen.queryByTestId('change-progress')).toBeNull();
  });

  it('the Tink in the guide has a glowing halo; the bubble has no step number', async () => {
    await startGuide();
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await screen.findByTestId('guide-look');
    expect(screen.getByTestId('tink-halo')).toBeTruthy();
  });

  // D-228: Built-in rules do not recognize French; the guide's own sentence they know in all three languages.
  it('in French with the built-in rules, step 1 builds the app with French names', async () => {
    const repo = new MemoryWorkspaceRepo();
    await act(() => useGuide.getState().load(repo));
    const { store } = await renderToolsApp(repo, new FakeFiles(), {
      locale: 'fr',
      seed: createStarterWorkspace,
    });
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await fireEvent.press(await screen.findByTestId('guide-look-0'));
    await waitFor(
      () => expect(screen.getByTestId('change-input').props.editable).toBe(true),
      TYPED,
    );
    await fireEvent.press(screen.getByTestId('change-submit'));
    expect(await screen.findByTestId('guide-goal')).toBeTruthy();
    expect(
      store.getState().config!.containers.pages.find((p) => p.id === 'paper-home')!.title,
    ).toBe('Accueil');
    expect(screen.getByTestId('app-icon-paper')).toHaveTextContent('Paper');
  });

  it('rerunning step 1 when the app is already there moves on to step 2', async () => {
    const { store } = await startGuide(undefined, withPaper);
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await fireEvent.press(await screen.findByTestId('guide-look-0'));
    await waitFor(
      () => expect(screen.getByTestId('change-input').props.editable).toBe(true),
      TYPED,
    );
    await fireEvent.press(screen.getByTestId('change-submit'));
    expect(await screen.findByTestId('guide-goal')).toBeTruthy();
    expect(apps(store)).toEqual(['paper']);
  });

  it('replaying the guide on an older home page adds the app and a way into it', async () => {
    const { store } = await startGuide(undefined, homeWithFileEntries);
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await fireEvent.press(await screen.findByTestId('guide-skip'));
    await waitFor(() => expect(apps(store)).toEqual(['paper']));
    const home = store.getState().config!.containers.pages.find((p) => p.id === 'home')!;
    expect(home.blocks.at(-1)).toMatchObject({ look: 'entry', opens: 'app:paper' });
  });

  it('skipping the guide builds the Paper app directly', async () => {
    const { repo, store } = await startGuide();
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await fireEvent.press(await screen.findByTestId('guide-skip'));
    await waitFor(() => expect(apps(store)).toEqual(['paper']));
    expect(store.getState().draft).toBeNull();
    expect(screen.queryByTestId('guide-look')).toBeNull();
    // Does not show "Applied · Undo" at the top (D-239).
    expect(store.getState().banner).toBeNull();
    expect(screen.queryByTestId('banner')).toBeNull();
    expect(await repo.getMeta('guide')).toBe('done');
    expect(await screen.findByTestId('app-icon-paper')).toBeTruthy();
  });

  it('step 2 ends the guide when the user opens pictures or files', async () => {
    const { repo, files } = await startGuide('goal', homeWithFileEntries);
    expect(await screen.findByTestId('guide-goal')).toHaveTextContent(/搭好了/);
    files.nextMedia = [files.offerImage('a.jpg', 400, 300)];
    await openPick('media');
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    expect(await repo.getMeta('guide')).toBe('done');
  });

  it('“got it” on step 2 closes the bubble and ends the guide (no step 3)', async () => {
    const { repo } = await startGuide('goal');
    await fireEvent.press(await screen.findByTestId('guide-later'));
    expect(screen.queryByTestId('guide-goal')).toBeNull();
    expect(screen.queryByTestId('guide-task')).toBeNull();
    expect(screen.queryByTestId('guide-samples')).toBeNull();
    expect(await repo.getMeta('guide')).toBe('done');
  });

  // D-447: Steps 1 and 2 bubbles float over the home page (not part of page layout) with a slight blur underneath; Step 2 has "Got it" at the bottom right.
  it('the bubbles float over a slightly blurred home page; step 2 has “got it”', async () => {
    await startGuide('goal');
    const overlay = await screen.findByTestId('guide-overlay');
    expect(within(overlay).getByTestId('guide-blur')).toBeTruthy();
    expect(within(overlay).getByTestId('guide-goal')).toBeTruthy();
    expect(within(overlay).getByTestId('guide-later')).toHaveTextContent('我知道了');
    expect(screen.getByTestId('guide-goal')).not.toHaveTextContent(/第 2 步/);
    expect(screen.getByTestId('tink-lively')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('guide-later'));
    expect(screen.queryByTestId('guide-overlay')).toBeNull();
  });
});

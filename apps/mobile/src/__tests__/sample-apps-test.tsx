import {
  applyOps,
  createDefaultWorkspace,
  createStarterWorkspace,
  type Locale,
  type Op,
  quickActionsOf,
  SAMPLE_APPS,
  type Registry,
  remindersOf,
  type WorkspaceConfig,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { useSampleHint } from '../guide/SampleHint';
import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp, homeWithFileEntries, openPick } from '../test-utils/render-app';

// Onboarding step 3: Sample apps (D-260). After step 2, the home screen lists five samples; tapping
// one loads the complete set into a draft (D-190), which upon "Apply" merges into a version (top
// bar reads "Changes applied · Undo"), returning to the sample's main page with a hint that AI can
// be used for further edits. Bypasses AI.

const TYPED = { timeout: 4000 };

type Seed = (locale: Locale, registry: Registry) => WorkspaceConfig;

async function start(
  stage: 'goal' | 'samples' | 'done' | undefined,
  options: { seed?: Seed; locale?: Locale; repo?: MemoryWorkspaceRepo } = {},
) {
  const repo = options.repo ?? new MemoryWorkspaceRepo();
  if (stage) await repo.setMeta('guide', stage);
  await act(() => useGuide.getState().load(repo));
  return renderToolsApp(repo, new FakeFiles(), {
    seed: options.seed ?? homeWithFileEntries,
    locale: options.locale ?? 'zh',
  });
}

/** Initial version with a few modifications applied on top of `homeWithFileEntries`. */
const seedWith =
  (ops: (config: WorkspaceConfig) => Op[], base: Seed = homeWithFileEntries): Seed =>
  (locale, registry) => {
    const config = base(locale, registry);
    const result = applyOps(config, ops(config), { registry, locale });
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };

describe('guide step 3: sample apps', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
    useSampleHint.setState({ hint: null });
  });

  // D-447: Step 3 is removed. New users finishing steps 1 and 2 (or opening a file during step 2) complete onboarding directly without sample lists.
  it('a new user who finishes steps 1 and 2 does not get step 3', async () => {
    const { repo } = await start(undefined, { seed: createStarterWorkspace });
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await fireEvent.press(await screen.findByTestId('guide-look-0'));
    await waitFor(
      () => expect(screen.getByTestId('change-input').props.editable).toBe(true),
      TYPED,
    );
    await fireEvent.press(screen.getByTestId('change-submit'));
    await fireEvent.press(await screen.findByTestId('guide-later'));
    await waitFor(() => expect(useGuide.getState().stage).toBe('done'));
    expect(await repo.getMeta('guide')).toBe('done');
    expect(screen.queryByTestId('guide-samples')).toBeNull();
  });

  it('opening a picture in step 2 ends the guide', async () => {
    const files = new FakeFiles();
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('guide', 'goal');
    await act(() => useGuide.getState().load(repo));
    await renderToolsApp(repo, files, { seed: homeWithFileEntries });
    files.nextMedia = [files.offerImage('a.jpg', 400, 300)];
    await openPick('media');
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    expect(await repo.getMeta('guide')).toBe('done');
    await act(() => router.back());
    await screen.findByTestId('nav-settings');
    expect(screen.queryByTestId('guide-samples')).toBeNull();
  });

  it('skipping the guide skips step 3 too', async () => {
    const { repo } = await start(undefined, { seed: createStarterWorkspace });
    await fireEvent.press(await screen.findByTestId('welcome-skip'));
    await fireEvent.press(await screen.findByTestId('guide-skip'));
    await waitFor(() => expect(useGuide.getState().stage).toBe('done'));
    expect(await repo.getMeta('guide')).toBe('done');
    expect(screen.queryByTestId('guide-samples')).toBeNull();
  });

  it('users who already saw the guide do not get step 3', async () => {
    await start('done');
    await screen.findByTestId('nav-settings');
    expect(screen.queryByTestId('guide-samples')).toBeNull();
    expect(screen.queryByTestId('guide-goal')).toBeNull();
  });

  it('“later” on step 3 ends the guide without changing the app', async () => {
    const { repo, store } = await start('samples');
    const before = store.getState().config;
    await fireEvent.press(await screen.findByTestId('guide-samples-later'));
    await waitFor(() => expect(screen.queryByTestId('guide-samples')).toBeNull());
    expect(await repo.getMeta('guide')).toBe('done');
    expect(store.getState().config).toBe(before);
    expect(store.getState().draft).toBeNull();
  });

  it('picking a sample drafts it, applying returns to its page with undo and an AI hint', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { repo, store } = await start('samples');
    const before = store.getState().config!;
    const revisions = (await store.getState().listRevisions(50)).length;
    await fireEvent.press(await screen.findByTestId('guide-sample-expense-helper'));

    // Enter draft mode first: view-only and inactive, official version unchanged (D-190).
    expect(await screen.findByTestId('draft-bar')).toBeTruthy();
    const draft = store.getState().draft!;
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]!.input).toBe('套用样板「报销助手」');
    expect(draft.origin.sample).toEqual({ id: 'expense-helper', pageId: 'expenses' });
    expect(store.getState().config).toBe(before);
    expect(store.getState().tab).toBe('page:expenses');
    expect(await screen.findByText('报销助手')).toBeTruthy();
    // Selecting a sample completes the onboarding guide.
    expect(await repo.getMeta('guide')).toBe('done');

    // Apply: tables, quick actions, pages, and reminders are added together as a single version; top bar shows standard "Changes applied · Undo" (not small guide edits, so D-239 does not apply).
    await fireEvent.press(screen.getByTestId('draft-apply'));
    await waitFor(() => expect(store.getState().draft).toBeNull());
    const after = store.getState().config!;
    expect(after.data.tables.map((c) => c.id)).toContain('claims');
    expect(quickActionsOf(after).map((w) => w.id)).toEqual(
      expect.arrayContaining([
        'scan-receipt-log',
        'print-expenses',
        'receipt-archive',
        'expense-report',
      ]),
    );
    expect(remindersOf(after)?.map((r) => r.id)).toEqual(['submit-expenses']);
    expect(after.nav.bar).toContain('page:expenses');
    expect(after.theme).toEqual(before.theme);
    expect((await store.getState().listRevisions(50)).length).toBe(revisions + 1);
    expect(await screen.findByTestId('banner')).toHaveTextContent(/撤销/);
    expect(store.getState().tab).toBe('page:expenses');
    const hint = await screen.findByTestId('sample-hint');
    expect(hint).toHaveTextContent(/「报销助手」装好了/);

    // "Continue modifying with AI": populate the input box with the starting text without auto-sending.
    await fireEvent.press(screen.getByTestId('sample-hint-change'));
    const input = await screen.findByTestId('change-input');
    expect(input).toHaveProp('value', '在报销助手的基础上改：');
    expect(store.getState().draft).toBeNull();
    expect(store.getState().config).toBe(after);
    // No network requests were sent throughout the entire process.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('undo after applying a sample brings the app back to how it was', async () => {
    const { store } = await start('samples');
    const before = store.getState().config!;
    await fireEvent.press(await screen.findByTestId('guide-sample-shop-orders'));
    await fireEvent.press(await screen.findByTestId('draft-apply'));
    await waitFor(() => expect(store.getState().config!.data.tables).toHaveLength(2));
    await fireEvent.press(await screen.findByText('撤销'));
    await waitFor(() => expect(store.getState().config).toEqual(before));
  });

  it('works in French without AI', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { store } = await start('samples', { locale: 'fr' });
    expect(await screen.findByTestId('guide-samples')).toHaveTextContent(/Étape 3/);
    await fireEvent.press(screen.getByTestId('guide-sample-visa-docs'));
    expect(store.getState().draft!.steps[0]!.input).toBe(
      'Utiliser l’app modèle « Visa et passeport »',
    );
    await fireEvent.press(await screen.findByTestId('draft-apply'));
    expect(await screen.findByTestId('sample-hint')).toHaveTextContent(
      /« Visa et passeport » est prête/,
    );
    expect(store.getState().config!.data.tables.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Pièces à préparer', 'Mes papiers']),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with data: an existing table of the same name keeps its records, the sample gets new ids', async () => {
    const repo = new MemoryWorkspaceRepo();
    const seed = seedWith(() => [
      {
        op: 'addData',
        table: {
          id: 'growth',
          name: '成长',
          fields: [{ id: 'name', name: '名字', type: 'text' }],
        },
      },
    ]);
    const { store } = await start('samples', { seed, repo });
    await repo.insertRecord({
      id: 'r1',
      collectionId: 'growth',
      values: { name: '老记录' },
      createdAt: 1,
      updatedAt: 1,
    });
    await fireEvent.press(await screen.findByTestId('guide-sample-baby-growth'));
    await fireEvent.press(await screen.findByTestId('draft-apply'));
    await waitFor(() => expect(store.getState().draft).toBeNull());
    const after = store.getState().config!;
    expect(after.data.tables.map((c) => c.id)).toEqual(['growth', 'growth-2']);
    expect(remindersOf(after)?.[0]).toMatchObject({ opens: 'page:baby' });
    expect((await repo.listRecords('growth')).map((r) => r.id)).toEqual(['r1']);
    expect(await screen.findByTestId('sample-hint')).toBeTruthy();
  });

  it('a full navigation bar puts the sample on the home page and opens its page after applying', async () => {
    // Default workspace navigation bar is full: Home, Tools, AI, History, Settings.
    const { store } = await start('samples', {
      seed: (locale) => createDefaultWorkspace(locale),
    });
    await fireEvent.press(await screen.findByTestId('guide-sample-study-helper'));
    await fireEvent.press(await screen.findByTestId('draft-apply'));
    await waitFor(() => expect(store.getState().draft).toBeNull());
    const after = store.getState().config!;
    expect(after.nav.bar).toHaveLength(5);
    expect(after.nav.bar).not.toContain('page:study');
    expect(
      after.containers.pages
        .find((p) => p.id === 'home')!
        .blocks.some((c) => c.look === 'entry' && c.opens === 'page:study'),
    ).toBe(true);
    // Push a new page into a main page not present in the navigation bar, displaying the hint card on that page.
    expect(await screen.findByTestId('sample-hint')).toHaveTextContent(/「学习助手」装好了/);
  });

  it('at the table limit it explains why and stays on step 3', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const seed = seedWith((config) =>
      Array.from({ length: 20 - config.data.tables.length }, (_, i) => ({
        op: 'addData' as const,
        table: {
          id: `t${i}`,
          name: `表${i}`,
          fields: [{ id: 'n', name: 'N', type: 'text' as const }],
        },
      })),
    );
    const { repo, store } = await start('samples', { seed });
    await fireEvent.press(await screen.findByTestId('guide-sample-expense-helper'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0]![1]).toMatch(/「报销助手」要新建数据表.*20 张/);
    expect(store.getState().draft).toBeNull();
    expect(await repo.getMeta('guide')).toBe('samples');
    expect(screen.getByTestId('guide-samples')).toBeTruthy();
  });
});

// Sample apps always accessible (D-544): "Settings → More → My Presets" lists all samples; tapping
// one follows the same path as onboarding step 3: enters draft, applies as a version, and supports
// undo.
describe('sample apps on My presets', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useGuide.setState({ stage: null, repo: null });
    useSampleHint.setState({ hint: null });
  });

  async function openPresets() {
    await fireEvent.press(await screen.findByTestId('nav-settings'));
    await fireEvent.press(await screen.findByTestId('settings-presets'));
    const screenEl = await screen.findByTestId('presets-screen');
    // Sample apps located in "Add App" (D-614).
    await fireEvent.press(screen.getByTestId('preset-add'));
    await fireEvent.press(screen.getByTestId('preset-samples'));
    return screenEl;
  }

  it('a new user finds every sample there, and looking changes nothing', async () => {
    const { store } = await start('done', { seed: createStarterWorkspace });
    const head = store.getState().head!.id;
    await openPresets();
    for (const id of SAMPLE_APPS) expect(screen.getByTestId(`preset-sample-${id}`)).toBeTruthy();
    expect(screen.getByTestId('preset-sample-receipts')).toHaveTextContent(/收据/);
    expect(store.getState().head!.id).toBe(head);
    expect(store.getState().draft).toBeNull();
  });

  it('with data: picking one drafts it, applying adds one version that undo takes back', async () => {
    const { store } = await start('done');
    const before = store.getState().config!;
    const revisions = (await store.getState().listRevisions(50)).length;
    await openPresets();
    await fireEvent.press(screen.getByTestId('preset-sample-shop-orders'));
    expect(await screen.findByTestId('draft-bar')).toBeTruthy();
    expect(store.getState().draft!.steps[0]!.input).toBe('套用样板「小店接单」');
    expect(store.getState().config).toBe(before);
    await fireEvent.press(screen.getByTestId('draft-apply'));
    await waitFor(() => expect(store.getState().draft).toBeNull());
    expect(store.getState().config!.data.tables.length).toBe(before.data.tables.length + 2);
    expect((await store.getState().listRevisions(50)).length).toBe(revisions + 1);
    await fireEvent.press(await screen.findByText('撤销'));
    await waitFor(() => expect(store.getState().config).toEqual(before));
  });

  it('at the table limit it explains why and stays on the screen without a draft', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const seed = seedWith((config) =>
      Array.from({ length: 20 - config.data.tables.length }, (_, i) => ({
        op: 'addData' as const,
        table: {
          id: `t${i}`,
          name: `表${i}`,
          fields: [{ id: 'n', name: 'N', type: 'text' as const }],
        },
      })),
    );
    const { store } = await start('done', { seed });
    await openPresets();
    await fireEvent.press(screen.getByTestId('preset-sample-expense-helper'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0]![1]).toMatch(/20 张/);
    expect(store.getState().draft).toBeNull();
    expect(screen.getByTestId('presets-screen')).toBeTruthy();
  });
});

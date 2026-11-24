import { packById, quickActionsOf } from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { screen, testRouter } from 'expo-router/testing-library';

import type { PackBridge } from '../packs/bridge';
import type { Packs } from '../packs/PackHost';
import { PackStore } from '../packs/store';
import { MemoryPackFs, bundlePack, sha256, text } from '../test-utils/memory-packs';
import { acceptNextAlert, renderToolsApp } from '../test-utils/render-app';

// Workflow interface journey (T7): Settings -> Quick Actions -> Run built-in preset directly; edit parameters, ask on each run, add steps -> Save (a version) -> Undo.

const NO_PAGES: string[] = [];

async function openWorkflows() {
  const app = await renderToolsApp();
  await testRouter.push('/workflows');
  expect(await screen.findByTestId('workflows-screen')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('category-image'));
  expect(await screen.findByTestId('quick-actions-image')).toBeTruthy();
  return app;
}

const visa = (store: Awaited<ReturnType<typeof renderToolsApp>>['store']) =>
  quickActionsOf(store.getState().config!).find((w) => w.preset === 'visa-photo');

describe('workflow journeys (UI)', () => {
  afterEach(() => jest.restoreAllMocks());

  // D-510: PDF preview is bundled with the App; presets using it no longer display "First-time use requires downloading some content"; display it as usual when absent.
  it.each([
    [false, true],
    [true, false],
  ])(
    'says the first run downloads only when the pack is not in the app (bundled %s)',
    async (inApp, says) => {
      const fs = new MemoryPackFs();
      const body = text('pdf.js');
      const pdfview = {
        ...packById('pdfview')!,
        files: [
          {
            path: 'pdf.js',
            url: 'https://cdn/pdf.js',
            size: body.length,
            sha256: await sha256(body),
          },
        ],
      };
      if (inApp) bundlePack(fs, pdfview, () => body);
      const store = new PackStore(fs, sha256, (id) => (id === 'pdfview' ? pdfview : packById(id)));
      // activePages must return the same array on every call (useSyncExternalStore).
      const bridge = {
        subscribe: () => () => undefined,
        activePages: () => NO_PAGES,
      } as unknown as PackBridge;
      await renderToolsApp(undefined, undefined, { packs: { store, bridge } as Packs });
      await testRouter.push('/workflows');
      await fireEvent.press(await screen.findByTestId('category-document'));
      const card = await screen.findByTestId('workflow-sign-return');
      const note = /首次使用需要下载一些内容/;
      if (says) {
        await waitFor(() => expect(card).toHaveTextContent(note));
      } else {
        // After reading installed packs (which copied a copy from the App), do not write again.
        await waitFor(() => expect(fs.files.has('pdfview/6.4.299/ready.json')).toBe(true));
        // renderRouter uses fake timers: only flush pending Promises.
        for (let i = 0; i < 3; i++) await act(async () => undefined);
        expect(card).not.toHaveTextContent(note);
      }
      expect(fs.downloads).toEqual([]);
    },
  );

  it('lists built-in quick actions without anything to add (D-236)', async () => {
    const { store } = await openWorkflows();
    expect(screen.getByTestId('workflow-visa-photo')).toBeTruthy();
    expect(screen.getByTestId('workflow-run-visa-photo')).toBeTruthy();
    expect(screen.queryByTestId('preset-add-visa-photo')).toBeNull();
    expect(screen.queryByTestId('workflows-empty')).toBeNull();
    expect(quickActionsOf(store.getState().config!).some((w) => w.preset)).toBe(false);
  });

  it('runs a built-in quick action without changing the app, and remembers the use', async () => {
    const { store, repo, files } = await openWorkflows();
    const head = store.getState().head!.id;
    files.nextPhotos = [files.offerImage('a.jpg', 4000, 3000)];
    await fireEvent.press(screen.getByTestId('workflow-run-email-photos'));
    await fireEvent.press(await screen.findByTestId('prompt-ok', {}, { timeout: 3000 }));
    expect(await screen.findByTestId('run-result', {}, { timeout: 3000 })).toBeTruthy();
    expect(files.shared).toHaveLength(1);
    expect(store.getState().head!.id).toBe(head);
    expect(quickActionsOf(store.getState().config!).some((w) => w.id === 'email-photos')).toBe(
      false,
    );
    expect((await repo.countSucceededRuns()).get('email-photos')?.count).toBe(1);
  });

  it('saves an edited built-in under its own id, and undo brings the built-in back', async () => {
    const { store } = await openWorkflows();
    const before = store.getState().head!.id;
    await fireEvent.press(screen.getByTestId('workflow-edit-visa-photo'));
    expect(await screen.findByTestId('workflow-editor')).toBeTruthy();
    // Built-in presets are already in their original state, so there is no "Restore original"; they also cannot be deleted.
    expect(screen.queryByTestId('workflow-reset')).toBeNull();
    expect(screen.queryByTestId('workflow-delete')).toBeNull();
    // Rename, change size to 200 KB, and no longer prompt for specifications every time.
    await fireEvent.changeText(screen.getByTestId('workflow-name'), '美签照片');
    await fireEvent.changeText(screen.getByTestId('step-1-maxKB'), '200');
    await fireEvent.press(screen.getByTestId('step-1-ask-spec'));
    // Add a "Share" step at the end.
    await fireEvent.press(screen.getByTestId('step-insert-3'));
    expect(await screen.findByTestId('step-picker')).toBeTruthy();
    expect(screen.queryByTestId('step-pick-in.photos')).toBeNull();
    await fireEvent.press(screen.getByTestId('step-pick-out.share'));
    await fireEvent.press(screen.getByTestId('workflow-save'));

    const wf = visa(store)!;
    // Use the same ID: continue counting usage frequency for presets.
    expect(wf.id).toBe('visa-photo');
    expect(wf.name).toBe('美签照片');
    expect(wf.steps[1]).toMatchObject({
      params: { spec: 'us-passport', maxKB: 200 },
      ask: ['maxKB'],
    });
    expect(wf.steps.map((s) => s.action).at(-1)).toBe('out.share');
    expect(store.getState().head).toMatchObject({
      id: before + 1,
      summary: '调整了快捷操作「美签照片」',
    });
    expect(await screen.findByTestId('workflow-reset')).toBeTruthy();

    // "Undo" on the banner reverts to before editing: back to the preset state.
    await fireEvent.press(await screen.findByText('撤销'));
    expect(visa(store)).toBeUndefined();
    await waitFor(() =>
      expect(screen.getByTestId('workflow-name').props.value).toBe('签证 / 证件照'),
    );
    expect(screen.queryByTestId('workflow-discard')).toBeNull();
  });

  it('keeps steps that do not fit from being saved, and can put a built-in on Home', async () => {
    const { store } = await openWorkflows();
    await fireEvent.press(screen.getByTestId('workflow-edit-email-photos'));
    // Move "Select photo" to the second step: input can only be the first step (the first step receives files via the record's attachment field, D-442), cannot save.
    await fireEvent.press(await screen.findByTestId('step-down-0'));
    expect(screen.getByTestId('step-problem-1')).toBeTruthy();
    expect(screen.getByTestId('workflow-save').props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('workflow-discard'));
    expect(screen.queryByTestId('step-problem-1')).toBeNull();

    const before = store.getState().head!.id;
    await fireEvent.press(screen.getByTestId('workflow-to-home'));
    // Home screen entry point must point to the quick action in the config: saved together, single version.
    expect(store.getState().head!.id).toBe(before + 1);
    expect(quickActionsOf(store.getState().config!).some((w) => w.id === 'email-photos')).toBe(
      true,
    );
    const home = store.getState().config!.containers.pages.find((p) => p.id === 'home')!;
    expect(
      home.blocks.some(
        (c) =>
          c.look === 'action' &&
          (c as { tools: { tool: string }[] }).tools[0]!.tool === 'email-photos',
      ),
    ).toBe(true);
  });

  it('copies a built-in under a new id', async () => {
    const { store } = await openWorkflows();
    await fireEvent.press(screen.getByTestId('workflow-edit-email-photos'));
    await fireEvent.press(await screen.findByTestId('workflow-duplicate'));
    const copy = quickActionsOf(store.getState().config!).find((w) => w.preset === 'email-photos')!;
    expect(copy.id).not.toBe('email-photos');
    // The preset one is still there.
    await fireEvent.press(await screen.findByText('撤销'));
    expect(quickActionsOf(store.getState().config!)).toHaveLength(0);
  });

  it('deleting an edited built-in returns to the original', async () => {
    const { store } = await openWorkflows();
    await fireEvent.press(screen.getByTestId('workflow-edit-email-photos'));
    await fireEvent.changeText(await screen.findByTestId('workflow-name'), '发邮件');
    await fireEvent.press(screen.getByTestId('workflow-save'));
    acceptNextAlert();
    await fireEvent.press(await screen.findByTestId('workflow-delete'));
    expect(quickActionsOf(store.getState().config!).some((w) => w.id === 'email-photos')).toBe(
      false,
    );
    expect(store.getState().head).toMatchObject({ summary: '删除了快捷操作「发邮件」' });
    expect(await screen.findByTestId('workflow-email-photos')).toBeTruthy();
  });
});

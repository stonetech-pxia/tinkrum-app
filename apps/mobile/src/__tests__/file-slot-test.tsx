import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  BUILTIN_TOOLS,
  createMockAIProvider,
  createRegistry,
  MEDIA_LIMITS,
  REDACTED_FILE,
  type AIProvider,
  type Op,
} from '@morph/core';
import { createClaudePlanner, type PlannerMessage } from '@morph/planner';
import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { AISettingsProvider } from '../ai/context';
import { createAISettingsStore, type SecretStore } from '../ai/settings';
import ChangeRoute from '../app/change';
import HomeRoute from '../app/index';
import PageRoute from '../app/page/[pageId]';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/store';

// File triggers (D-257): AI only populates empty slots; user taps empty slot to select from photo
// library or "Files", a copy of the file is saved as a user file, config holds only the file ID;
// single tap opens with system preview; long-press edit replaces or removes the file. File names do
// not enter config and are not sent to AI.

const registry = createRegistry(BUILTIN_TOOLS);

beforeEach(() => {
  jest
    .requireActual('@react-native/jest-preset/jest/MockNativeMethods')
    .default.measureLayout.mockImplementation(
      (_to: unknown, success: (x: number, y: number, w: number, h: number) => void) =>
        success(20, 100, 320, 40),
    );
});
afterEach(() => jest.restoreAllMocks());

const memorySecrets = (): SecretStore => {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
};

async function renderApp(provider: AIProvider = createMockAIProvider()) {
  const repo = new MemoryWorkspaceRepo();
  const files = new FakeFiles();
  const aiSettings = createAISettingsStore({ secrets: memorySecrets(), serverAvailable: false });
  await aiSettings.getState().load();
  await aiSettings.getState().setTinkAgent(true);
  const store = createWorkspaceStore({
    repo,
    provider,
    registry,
    locale: 'zh',
    now: () => new Date(),
  });
  await store.getState().boot();
  await renderRouter({
    _layout: () => (
      <AISettingsProvider store={aiSettings}>
        <WorkspaceProvider value={{ store, repo, files, registry, locale: 'zh' }}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <Stack />
          </GestureHandlerRootView>
        </WorkspaceProvider>
      </AISettingsProvider>
    ),
    index: HomeRoute,
    change: ChangeRoute,
    'page/[pageId]': PageRoute,
  });
  return { repo, store, files };
}

const SLOT: Op = {
  op: 'addContainer',
  page: 'home',
  block: { id: 'lease', look: 'button', show: { label: '租房合同' }, opens: { file: null } },
};

async function commit(store: WorkspaceStore, ops: Op[], summary: string) {
  expect((await store.getState().proposeOps(ops, summary)).kind).toBe('preview');
  await store.getState().confirm();
  expect(await screen.findByText(`已改好：${summary}`)).toBeTruthy();
}

const slotBlock = (store: WorkspaceStore) =>
  store.getState().config!.containers.pages[0]!.blocks.find((c) => c.id === 'lease') as {
    show: Record<string, unknown>;
    opens: { file: string | null };
  };

/** System popups: tap buttons named labels sequentially (one per popup). */
function pressInAlerts(...labels: string[]) {
  const spy = jest.spyOn(Alert, 'alert');
  for (const label of labels)
    spy.mockImplementationOnce((_title, _message, buttons) => {
      buttons?.find((b) => b.text === label)?.onPress?.();
    });
  return spy;
}

/** Text displayed on trigger card ("Recent Files" on home screen also lists this copy). */
async function slotShows(text: string) {
  await waitFor(() =>
    expect(within(screen.getByTestId('file-slot-lease')).getByText(text)).toBeTruthy(),
  );
}

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);

describe('file slot', () => {
  it('empty slot: the user picks a file from Files, Tinkrum keeps a copy and opens it', async () => {
    const { repo, store, files } = await renderApp();
    await commit(store, [SLOT], '加文件入口');
    // New user: empty slot displays hint.
    await slotShows('点按选择一个文件');

    files.nextPick = [files.offer('合同 2026.pdf', pdf, 'application/pdf')];
    pressInAlerts('从「文件」选');
    await fireEvent.press(screen.getByTestId('file-slot-lease'));
    await slotShows('合同 2026.pdf');

    const [asset] = await repo.listAssets();
    expect(asset).toMatchObject({
      name: '合同 2026.pdf',
      mimeType: 'application/pdf',
      source: 'picked',
      size: pdf.length,
    });
    // Copy resides in app's user files; selector cache copy is deleted.
    expect(files.disk.get(asset!.path)).toEqual(pdf);
    expect(files.disk.has('picker://合同 2026.pdf')).toBe(false);
    // Config contains only file ID, no file name; this modification is a manual user edit.
    expect(slotBlock(store).show).toEqual({ label: '租房合同' });
    expect(slotBlock(store).opens).toEqual({ file: asset!.id });
    expect(JSON.stringify(store.getState().config)).not.toContain('合同 2026');
    expect(store.getState().head).toMatchObject({ source: 'user', summary: '设置文件' });

    // Single tap opens copy with system preview.
    await fireEvent.press(screen.getByTestId('file-slot-lease'));
    expect(files.previewed).toEqual([
      { uri: files.fileUri(asset!.path), mimeType: 'application/pdf' },
    ]);
  });

  it('a photo can go in the slot too, as the original file', async () => {
    const { repo, store, files } = await renderApp();
    await commit(store, [SLOT], '加文件入口');
    files.nextMedia = [files.offer('IMG_0042.HEIC', pdf, 'image/heic')];
    pressInAlerts('从相册选');
    await fireEvent.press(await screen.findByTestId('file-slot-lease'));
    await slotShows('IMG_0042.HEIC');
    const [asset] = await repo.listAssets();
    // Unlike image components, not re-encoded: saved as-is.
    expect(asset).toMatchObject({ name: 'IMG_0042.HEIC', mimeType: 'image/heic' });
    expect(slotBlock(store).opens.file).toBe(asset!.id);
  });

  it('cancelling, a file over the limit or a full phone change nothing', async () => {
    const { repo, store, files } = await renderApp();
    await commit(store, [SLOT], '加文件入口');
    const headId = store.getState().head!.id;

    // Cancel in selector.
    files.nextPick = null;
    pressInAlerts('从「文件」选');
    await fireEvent.press(await screen.findByTestId('file-slot-lease'));

    // Cancel in popup.
    pressInAlerts('取消');
    await fireEvent.press(screen.getByTestId('file-slot-lease'));

    // Exceeds 4 GB (video limit, D-142).
    const huge = files.offer('big.mov', pdf, 'video/quicktime');
    files.nextPick = [{ ...huge, size: MEDIA_LIMITS.maxFileBytes + 1 }];
    const tooLarge = pressInAlerts('从「文件」选');
    await fireEvent.press(screen.getByTestId('file-slot-lease'));
    await slotShows('点按选择一个文件');
    expect(tooLarge).toHaveBeenLastCalledWith('租房合同', '这个文件超过 4 GB。');
    // Not copied, selector cache copy also deleted.
    expect(files.disk.has('picker://big.mov')).toBe(false);

    // Insufficient remaining space.
    files.freeBytes = 1024;
    files.nextPick = [files.offer('a.pdf', pdf)];
    const noSpace = pressInAlerts('从「文件」选');
    await fireEvent.press(screen.getByTestId('file-slot-lease'));
    await slotShows('点按选择一个文件');
    expect(noSpace).toHaveBeenLastCalledWith(
      '租房合同',
      '手机剩余空间不够，存不下这个文件的副本。',
    );

    expect(await repo.listAssets()).toEqual([]);
    expect(store.getState().head!.id).toBe(headId);
  });

  it('long-press edit replaces and removes the file; undo brings it back; the copy is kept', async () => {
    const { repo, store, files } = await renderApp();
    await commit(store, [SLOT], '加文件入口');
    files.nextPick = [files.offer('v1.pdf', pdf)];
    pressInAlerts('从「文件」选');
    await fireEvent.press(await screen.findByTestId('file-slot-lease'));
    await slotShows('v1.pdf');
    const first = slotBlock(store).opens.file;

    // Long press -> Edit -> Replace file.
    await fireEvent(screen.getByTestId('file-slot-lease'), 'longPress');
    await fireEvent.press(await screen.findByTestId('single-edit-lease'));
    files.nextPick = [files.offer('v2.pdf', pdf)];
    pressInAlerts('从「文件」选');
    await fireEvent.press(screen.getByTestId('edit-file-choose'));
    await slotShows('v2.pdf');
    await fireEvent.press(screen.getByTestId('single-done-lease'));
    expect(await screen.findByText('已改好：编辑「首页」（1 处修改）')).toBeTruthy();
    const second = slotBlock(store).opens.file;
    expect(second).not.toBe(first);

    // Remove file: returns to empty slot; both copies remain (like image component, user files are not deleted with versions).
    await fireEvent(screen.getByTestId('file-slot-lease'), 'longPress');
    await fireEvent.press(await screen.findByTestId('single-edit-lease'));
    await fireEvent.press(screen.getByTestId('edit-file-remove'));
    await fireEvent.press(screen.getByTestId('single-done-lease'));
    await slotShows('点按选择一个文件');
    expect(slotBlock(store).opens.file).toBeNull();
    expect((await repo.listAssets()).map((a) => a.id).sort()).toEqual([first, second].sort());

    // Undo: file returns.
    await fireEvent.press(await screen.findByText('撤销'));
    await slotShows('v2.pdf');

    // Delete component, then restore that version: copy still exists, trigger opens normally.
    const withFile = store.getState().head!.id;
    await commit(store, [{ op: 'removeContainer', page: 'home', block: 'lease' }], '删');
    expect(await repo.listAssets()).toHaveLength(2);
    expect((await store.getState().proposeRestore(withFile)).kind).toBe('preview');
    await store.getState().confirm();
    await slotShows('v2.pdf');
  });

  it('a slot whose copy is not on this device says so and lets the user pick again', async () => {
    const { store } = await renderApp();
    const missing: Op = {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'lease',
        look: 'button',
        show: { label: '租房合同' },
        opens: { file: 'abcdef123' },
      },
    };
    await commit(store, [missing], '加文件入口');
    await slotShows('这个文件不在这台设备上，点按换一个。');
  });

  it('the model sees the slot, never the file name', async () => {
    const sent: PlannerMessage[][] = [];
    const planner = createClaudePlanner({
      registry,
      now: () => new Date(),
      complete: async (messages) => {
        sent.push(JSON.parse(JSON.stringify(messages)));
        const text = JSON.stringify({ kind: 'ops', ops: [{ op: 'setTheme', radius: 8 }] });
        return {
          text,
          stopReason: 'end_turn',
          content: [{ type: 'text', text }],
          model: 'test',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    });
    const { store, files } = await renderApp(planner);
    await commit(store, [SLOT], '加文件入口');
    files.nextPick = [files.offer('私人合同-张三.pdf', pdf)];
    pressInAlerts('从「文件」选');
    await fireEvent.press(await screen.findByTestId('file-slot-lease'));
    await slotShows('私人合同-张三.pdf');

    expect((await store.getState().propose('圆角小一点')).kind).toBe('preview');
    const all = JSON.stringify(sent);
    // In v34, file trigger is a button with opens as { file }: model sees trigger, file ID is replaced with placeholder (invariant 3), file name is hidden.
    expect(all).toContain('租房合同');
    expect(all).toContain('opens');
    expect(all).toContain(REDACTED_FILE);
    expect(all).not.toContain(slotBlock(store).opens.file!);
    expect(all).not.toContain('私人合同');
  });
});

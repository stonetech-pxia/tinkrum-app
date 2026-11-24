import {
  applyOps,
  createDefaultWorkspace,
  type Locale,
  type NewComponent,
  type Op,
  type Registry,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Keyboard, StyleSheet } from 'react-native';

import { APPLIED_BANNER_MS } from '../shell/Banner';
import { TOAST_MS, TOAST_UNDO_MS } from '../shell/Toast';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { acceptNextAlert, renderToolsApp } from '../test-utils/render-app';

// UI issues discovered during actual walkthrough (REPORT3 final section).

const tasksTable: Op = {
  op: 'addData',
  table: {
    id: 'tasks',
    name: '任务',
    fields: [
      { id: 'title', name: '标题', type: 'text', required: true },
      { id: 'note', name: '备注', type: 'text' },
    ],
  },
};

const seed =
  (blocks: NewComponent[] = [], extra: Op[] = []) =>
  (locale: Locale, registry: Registry) => {
    const result = applyOps(
      createDefaultWorkspace(locale),
      [
        tasksTable,
        ...extra,
        ...blocks.map((block) => ({ op: 'addContainer' as const, page: 'home', block })),
      ],
      { registry, locale },
    );
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };

const inlineForm: NewComponent = {
  id: 'quick',
  look: 'form',
  show: { mode: 'inline' },
  tools: [{ as: 'submit', label: '保存', do: 'create', table: 'tasks', ask: ['title'] }],
} as NewComponent;

const taskList: NewComponent = {
  id: 'list',
  look: 'list',
  source: { table: 'tasks', limit: 30 },
  show: { title: 'title' },
} as NewComponent;

const app = (blocks: NewComponent[] = [], extra: Op[] = [], repo = new MemoryWorkspaceRepo()) =>
  renderToolsApp(repo, undefined, { locale: 'zh', seed: seed(blocks, extra) });

async function changeApp(store: Awaited<ReturnType<typeof app>>['store'], ops: Op[]) {
  expect((await store.getState().proposeOps(ops, '改一下')).kind).toBe('preview');
  await store.getState().confirm();
  await store.getState().markRendered(store.getState().head!.id);
}

const green: Op[] = [{ op: 'setTheme', primaryColor: '#336699' }];

describe('Version notification banner floats over content', () => {
  it('Does not occupy layout: absolute positioning; appearance and disappearance do not change content position', async () => {
    const { store } = await app([taskList]);
    await act(() => changeApp(store, green));
    const banner = await screen.findByTestId('banner');
    expect(StyleSheet.flatten(banner.props.style).position).toBe('absolute');
  });
});

describe('Notification banner undo', () => {
  it('Undo immediately after applying preset: version reverts, prompts "Reverted to"', async () => {
    const repo = new MemoryWorkspaceRepo();
    const { store } = await app([], [], repo);
    await act(async () => {
      await store.getState().savePreset('甲');
    });
    await act(() => changeApp(store, green));
    const [preset] = await repo.listPresets();
    await act(async () => router.push('/presets'));
    acceptNextAlert();
    await fireEvent.press(await screen.findByTestId(`preset-${preset!.id}`));
    await waitFor(() => expect(store.getState().config!.theme.primaryColor).not.toBe('#336699'));
    await fireEvent.press(await screen.findByTestId('banner-undo'));
    await waitFor(() => expect(store.getState().config!.theme.primaryColor).toBe('#336699'));
    expect(await screen.findByTestId('banner')).toHaveTextContent(/已回到/);
  });

  it('Holding finger on "Undo" prevents timeout disappearance; lifting finger still triggers undo', async () => {
    const { store } = await app();
    const before = store.getState().config!.theme.primaryColor;
    await act(() => changeApp(store, green));
    const undo = await screen.findByTestId('banner-undo');
    jest.useFakeTimers();
    try {
      await act(() => jest.advanceTimersByTime(APPLIED_BANNER_MS - 100));
      await fireEvent(undo, 'pressIn');
      await act(() => jest.advanceTimersByTime(1000));
      expect(screen.getByTestId('banner-undo')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('banner-undo'));
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(store.getState().config!.theme.primaryColor).toBe(before));
  });

  it('Sliding finger away without undoing: notification banner disappears on schedule', async () => {
    const { store } = await app();
    await act(() => changeApp(store, green));
    const undo = await screen.findByTestId('banner-undo');
    jest.useFakeTimers();
    try {
      await fireEvent(undo, 'pressIn');
      await fireEvent(undo, 'pressOut');
      await act(() => jest.advanceTimersByTime(APPLIED_BANNER_MS));
      expect(screen.queryByTestId('banner')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
    expect(store.getState().config!.theme.primaryColor).toBe('#336699');
  });

  it('When undo is not possible, state so rather than quietly disappearing', async () => {
    const repo = new MemoryWorkspaceRepo();
    const { store } = await app([], [], repo);
    await act(() => changeApp(store, green));
    const head = store.getState().head!.id;
    jest.spyOn(repo, 'getRevision').mockResolvedValueOnce(null);
    await act(() => store.getState().undo());
    expect(store.getState().head!.id).toBe(head);
    expect(store.getState().banner?.message).toMatch(/改动记录/);
  });

  it('Double-tapping triggers undo only once without reporting a conflict', async () => {
    const { store } = await app();
    const before = store.getState().config!.theme.primaryColor;
    await act(() => changeApp(store, green));
    await act(async () => {
      await Promise.all([store.getState().undo(), store.getState().undo()]);
    });
    expect(store.getState().config!.theme.primaryColor).toBe(before);
    expect(store.getState().banner?.kind).not.toBe('conflict');
  });
});

describe('Record notifications disappear on their own', () => {
  it('Normal notifications disappear after a few seconds, including when switching pages', async () => {
    const { store } = await app();
    jest.useFakeTimers();
    try {
      await act(async () => store.getState().showToast({ message: '吃了：已记下' }));
      expect(screen.getByTestId('toast')).toBeTruthy();
      await act(() => jest.advanceTimersByTime(TOAST_MS - 100));
      expect(screen.getByTestId('toast')).toBeTruthy();
      await act(async () => store.getState().selectTab('settings'));
      await act(() => jest.advanceTimersByTime(100));
      expect(store.getState().toast).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Notifications with undo stay longer, but also have a definite duration; tapping undo within the time limit still restores it', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord({
      id: 'r1aaaaaa',
      collectionId: 'tasks',
      values: { title: '买牛奶' },
      createdAt: 1,
      updatedAt: 1,
    });
    const { store } = await app([taskList], [], repo);
    await repo.deleteRecord('r1aaaaaa', 2);
    expect(TOAST_UNDO_MS).toBeGreaterThan(TOAST_MS);
    jest.useFakeTimers();
    try {
      await act(async () =>
        store.getState().showToast({ message: '已删除', restoreRecordId: 'r1aaaaaa' }),
      );
      await act(() => jest.advanceTimersByTime(TOAST_MS + 100));
      expect(screen.getByTestId('toast-undo')).toBeTruthy();
      await act(() => jest.advanceTimersByTime(TOAST_UNDO_MS - TOAST_MS - 200));
      await fireEvent(screen.getByTestId('toast-undo'), 'pressIn');
      await act(() => jest.advanceTimersByTime(1000));
      await fireEvent.press(screen.getByTestId('toast-undo'));
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(store.getState().recordsVersion).toBe(1));
    expect((await repo.getRecord('r1aaaaaa'))!.deletedAt).toBeNull();
    expect(store.getState().toast).toBeNull();
  });

  it('Notifications with undo also disappear upon timeout', async () => {
    const { store } = await app();
    jest.useFakeTimers();
    try {
      await act(async () =>
        store.getState().showToast({ message: '已删除', restoreRecordId: 'x' }),
      );
      await act(() => jest.advanceTimersByTime(TOAST_UNDO_MS));
      expect(store.getState().toast).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Page form keyboard', () => {
  let dismiss: jest.SpyInstance;
  beforeEach(() => {
    dismiss = jest.spyOn(Keyboard, 'dismiss');
    dismiss.mockClear();
  });
  afterEach(() => dismiss.mockRestore());

  it('When required fields are empty, the checkmark on the keyboard only dismisses the keyboard without reporting required errors; saving triggers validation', async () => {
    const repo = new MemoryWorkspaceRepo();
    await app([inlineForm], [], repo);
    await fireEvent(await screen.findByTestId('form-quick-title'), 'submitEditing');
    expect(dismiss).toHaveBeenCalled();
    expect(screen.queryByText(/必填/)).toBeNull();
    await fireEvent.press(screen.getByTestId('form-quick-submit'));
    expect(await screen.findByText(/必填/)).toBeTruthy();
    expect(await repo.listRecords('tasks')).toEqual([]);
  });

  it('When content is filled, the checkmark saves as usual and the keyboard remains open for further editing', async () => {
    const repo = new MemoryWorkspaceRepo();
    const { store } = await app([inlineForm], [], repo);
    await fireEvent.changeText(await screen.findByTestId('form-quick-title'), '买牛奶');
    await fireEvent(screen.getByTestId('form-quick-title'), 'submitEditing');
    await waitFor(() => expect(store.getState().recordsVersion).toBe(1));
    expect(await repo.listRecords('tasks')).toHaveLength(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('Tapping blank areas on the page dismisses the keyboard, as does dragging the page', async () => {
    await app([inlineForm]);
    await fireEvent.press(await screen.findByTestId('page-blank'));
    expect(dismiss).toHaveBeenCalled();
    expect(screen.getByTestId('editable-scroll').props.keyboardDismissMode).toBe('on-drag');
  });

  it('Tapping blank areas on cards also dismisses the keyboard (the long-press layer intercepts taps; this is why tapping blank areas during walkthrough was ineffective)', async () => {
    await app([inlineForm]);
    await fireEvent.press(await screen.findByTestId('component-quick'));
    expect(dismiss).toHaveBeenCalled();
  });
});

describe('Prompt when new records are not visible', () => {
  it('This table has no readable page: prompt allows continuing edits', async () => {
    const { store } = await app();
    await act(async () => router.push('/record/tasks'));
    await fireEvent.changeText(await screen.findByTestId('editor-title'), '买牛奶');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('toast')).toHaveTextContent(/还没有页面显示/);
    expect(store.getState().toast?.continueTable).toBe('tasks');
    await fireEvent.press(screen.getByTestId('toast-continue'));
    expect(await screen.findByTestId('change-input')).toBeTruthy();
    expect(store.getState().toast).toBeNull();
  });

  it('A list is currently readable: do not prompt', async () => {
    const { store } = await app([taskList]);
    await act(async () => router.push('/record/tasks'));
    await fireEvent.changeText(await screen.findByTestId('editor-title'), '买牛奶');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByText('买牛奶')).toBeTruthy();
    expect(store.getState().toast).toBeNull();
  });

  it('Editing an existing record: do not prompt', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.insertRecord({
      id: 'r1aaaaaa',
      collectionId: 'tasks',
      values: { title: '买牛奶' },
      createdAt: 1,
      updatedAt: 1,
    });
    const { store } = await app([], [], repo);
    await act(async () => router.push('/record/tasks?recordId=r1aaaaaa'));
    await fireEvent.changeText(await screen.findByTestId('editor-title'), '买燕麦奶');
    await fireEvent.press(screen.getByTestId('editor-save'));
    await waitFor(() => expect(store.getState().recordsVersion).toBe(1));
    expect((await repo.getRecord('r1aaaaaa'))!.values.title).toBe('买燕麦奶');
    expect(store.getState().toast).toBeNull();
  });

  it('French: prompt is in French', async () => {
    await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { locale: 'fr', seed: seed() });
    await act(async () => router.push('/record/tasks'));
    await fireEvent.changeText(await screen.findByTestId('editor-title'), 'Lait');
    await fireEvent.press(screen.getByTestId('editor-save'));
    expect(await screen.findByTestId('toast')).toHaveTextContent(/Paramètres/);
  });
});

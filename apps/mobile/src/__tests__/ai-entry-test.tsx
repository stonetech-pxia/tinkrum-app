import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKFLOW_PRESETS,
  appFileOps,
  applyOps,
  createStarterWorkspace,
  presetWorkflow,
  readAppFile,
  templateOps,
  type PlanAbout,
  type WorkspaceConfig,
} from '@morph/core';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { useAiReturn, AI_RETURN_TTL } from '../ai/return';
import { screen } from 'expo-router/testing-library';

import { placeOnDesk } from '../desk/store';
import { useDraftUi } from '../draft/ui';
import { workflowAbout } from '../shell/ai-entry';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { shownConfig } from '../workspace/store';
import { FakeFiles, TINY_JPEG } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';

// 页面右上角的 AI 入口（D-406）：除了设置（含子页面）、改动记录和 AI 页，每一页都有；
// 从入口进 AI 页时说明现在修改的是哪一页，发给 AI 的只有 ID（底线 1、2）。

const seed: Parameters<typeof renderToolsApp>[2] = {
  seed: (locale, registry) => {
    const base = createStarterWorkspace(locale, registry);
    const made = applyOps(base, templateOps('budget', base, locale), { registry, locale });
    if (!made.ok) throw new Error(made.error);
    return made.config;
  },
};
async function renderDesk() {
  const files = new FakeFiles();
  files.disk.set('picker://a.jpg', TINY_JPEG);
  const desk = await placeOnDesk(
    files,
    [{ uri: 'picker://a.jpg', name: 'a.jpg', size: TINY_JPEG.length, mimeType: 'image/jpeg' }],
    Date.now(),
  );
  const app = await renderToolsApp(new MemoryWorkspaceRepo(), files, seed);
  await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } }));
  return { ...app, desk };
}

const render = (locale: 'zh' | 'en' | 'fr' = 'zh') =>
  renderToolsApp(new MemoryWorkspaceRepo(), new FakeFiles(), { ...seed, locale });

/** 从入口进 AI 页，说一句话，返回 AI 收到的 about。 */
async function aboutSent(
  store: Awaited<ReturnType<typeof render>>['store'],
): Promise<PlanAbout | undefined> {
  const change = jest.fn(async () => ({
    kind: 'rejected',
    reason: 'unknown',
    message: 'x',
    examples: [],
  }));
  store.setState({ change } as never);
  await fireEvent.press(await screen.findByTestId('page-ai'));
  await fireEvent.changeText(await screen.findByTestId('change-input'), '改一下');
  await fireEvent.press(screen.getByTestId('change-submit'));
  await waitFor(() => expect(change).toHaveBeenCalled());
  const calls = change.mock.calls as unknown as [string, unknown, { about?: PlanAbout }][];
  return calls[0]![2].about;
}

describe('the AI entry at the top right of a page (D-406)', () => {
  it('the entry shows the Tink hammer, not the sparkles', async () => {
    await render();
    const entry = await screen.findByTestId('page-ai');
    expect(within(entry).getByTestId('tink-hammer')).toBeTruthy();
  });

  it('the Tink entry in the bottom bar shows the hammer too', async () => {
    await render();
    await screen.findByTestId('page-ai');
    const bar = screen.getByTestId('nav-ai');
    expect(within(bar).getByTestId('tink-hammer')).toBeTruthy();
  });

  it('a page in the bar: the AI page says which page, and AI gets only its id', async () => {
    const { store } = await render();
    const about = await aboutSent(store);
    expect(screen.getByTestId('change-about')).toHaveTextContent(/现在修改：「.+」页面/);
    expect(about).toEqual({ kind: 'page', pageId: 'home' });
  });

  it('a pushed page: same', async () => {
    const { store } = await render();
    await act(() => router.push({ pathname: '/page/[pageId]', params: { pageId: 'budget' } }));
    expect(await aboutSent(store)).toEqual({ kind: 'page', pageId: 'budget' });
    expect(screen.getByTestId('change-about')).toHaveTextContent(/现在修改：「记账」页面/);
    // 风格选择器留着：换风格不只对快捷操作、收件页面才有。
    expect(screen.getByTestId('change-pick-style')).toBeTruthy();
  });

  it.each([
    ['zh', '现在修改：工具页面'],
    ['en', 'Changing the Tools page'],
    ['fr', 'Page à modifier'],
  ] as const)('the tools page in %s', async (locale, text) => {
    const { store } = await render(locale);
    await act(() => store.getState().selectTab('tools'));
    expect(await aboutSent(store)).toEqual({ kind: 'screen', screen: 'tools' });
    expect(screen.getByTestId('change-about')).toHaveTextContent(new RegExp(text));
  });

  it('the quick actions page, and quick action categories', async () => {
    const { store } = await render();
    await act(() => router.push('/quick-actions'));
    expect(await aboutSent(store)).toEqual({ kind: 'screen', screen: 'quickActions' });
  });

  it('a record form: the table, never the record', async () => {
    const { store } = await render();
    await act(() =>
      router.push({ pathname: '/record/[collectionId]', params: { collectionId: 'expenses' } }),
    );
    expect(await aboutSent(store)).toEqual({ kind: 'table', tableId: 'expenses' });
    expect(screen.getByTestId('change-about')).toHaveTextContent(/现在修改：「账目」表/);
  });

  it('settings and the change history have no entry', async () => {
    const { store } = await render();
    await act(() => store.getState().selectTab('settings'));
    expect(await screen.findByTestId('settings-ai')).toBeTruthy();
    expect(screen.queryByTestId('page-ai')).toBeNull();
    await act(() => store.getState().selectTab('history'));
    expect(screen.queryByTestId('page-ai')).toBeNull();
  });

  it('other ways in do not carry a page', async () => {
    await render();
    await act(() => router.push('/change'));
    expect(await screen.findByTestId('change-input')).toBeTruthy();
    expect(screen.queryByTestId('change-about')).toBeNull();
  });

  it('a page that no longer exists: no hint, nothing sent', async () => {
    await render();
    await act(() => router.push({ pathname: '/change', params: { page: 'gone' } }));
    expect(await screen.findByTestId('change-input')).toBeTruthy();
    expect(screen.queryByTestId('change-about')).toBeNull();
  });

  it('in a draft the entry opens the chat, about this page', async () => {
    const { store } = await render();
    await act(async () => {
      await store.getState().change('主题换成绿色');
    });
    expect(store.getState().draft?.open).toBe(true);
    await fireEvent.press(await screen.findByTestId('page-ai'));
    expect(await screen.findByTestId('draft-chat-about')).toHaveTextContent(/现在修改/);
    expect(useDraftUi.getState().chatAbout).toEqual({ kind: 'page', pageId: 'home' });
    await act(() => useDraftUi.getState().setChatOpen(false));
    expect(useDraftUi.getState().chatAbout).toBeNull();
  });

  it('the file desk: only the kind of file; the AI page says it never touches the file', async () => {
    const { store, desk } = await renderDesk();
    expect(desk).toBeTruthy();
    expect(await aboutSent(store)).toEqual({ kind: 'desk', fileKind: 'image' });
    expect(screen.getByTestId('change-about')).toHaveTextContent(/不会碰桌上的文件/);
  });

  it('a draft from the desk shows on the desk: the toolbar moves, its buttons are locked', async () => {
    const { store } = await renderDesk();
    const before = await screen.findByTestId('desk-toolbar');
    expect(before).toBeTruthy();
    const plan = async () => ({
      kind: 'ops' as const,
      ops: [{ op: 'updateContainer' as const, desk: { toolbar: 'top' as const } }],
    });
    await act(async () => {
      expect(
        await store.getState().change('把工具栏放到上面', { plan } as never, {
          about: { kind: 'desk', fileKind: 'image' },
        }),
      ).toMatchObject({ kind: 'drafted' });
    });
    expect(store.getState().config!.containers.desk).toBeUndefined();
    // 已保存的配置没变，桌面上已经是草稿的样子。
    expect(shownConfig(store.getState())!.containers.desk?.toolbar).toBe('top');
    expect(screen.getByTestId('draft-edit')).toBeTruthy();
    await fireEvent.press(
      within(screen.getByTestId('desk-toolbar')).getAllByTestId(/^desk-tool-/)[0]!,
    );
    expect(store.getState().toast?.message).toMatch(/应用之后才能用/);
  });

  it('a quick action: itself if it is in the config; a built-in one counts as the quick actions page', async () => {
    const { store } = await render();
    await act(async () => {
      await store
        .getState()
        .proposeOps(
          [{ op: 'addTool', tool: presetWorkflow(WORKFLOW_PRESETS[0]!, 'zh', 'visa-photo') }],
          'add',
        );
      await store.getState().confirm();
    });
    await act(() =>
      router.push({ pathname: '/reminder/[workflowId]', params: { workflowId: 'visa-photo' } }),
    );
    expect(await aboutSent(store)).toEqual({ kind: 'workflow', workflowId: 'visa-photo' });
    expect(workflowAbout(store.getState().config!, 'not-added')).toEqual({
      kind: 'screen',
      screen: 'quickActions',
    });
  });

  it('the run page has no entry while running, and one when it is over', async () => {
    const files = new FakeFiles();
    const { store } = await renderToolsApp(new MemoryWorkspaceRepo(), files, seed);
    await act(async () => {
      await store
        .getState()
        .proposeOps(
          [{ op: 'addTool', tool: presetWorkflow(WORKFLOW_PRESETS[0]!, 'zh', 'visa-photo') }],
          'add',
        );
      await store.getState().confirm();
    });
    await act(() =>
      router.push({ pathname: '/run/[workflowId]', params: { workflowId: 'visa-photo' } }),
    );
    expect(await screen.findByTestId('run-screen')).toBeTruthy();
    expect(screen.queryByTestId('page-ai')).toBeNull();
    // 没有选文件：运行结束（取消）。
    await waitFor(() => expect(screen.getByTestId('page-ai')).toBeTruthy(), { timeout: 5000 });
  });

  it('a function change from a page stays on that page, it does not jump to home', async () => {
    const { store } = await render();
    await act(() => store.getState().selectTab('tools'));
    const applied = {
      origin: {},
      addedWorkflowIds: [],
      addedCollectionIds: [],
      homeScreenWorkflowIds: [],
    };
    store.setState({
      change: async () => ({ kind: 'applied', applied, focusPageId: 'home' }),
    } as never);
    await fireEvent.press(await screen.findByTestId('page-ai'));
    await fireEvent.changeText(await screen.findByTestId('change-input'), '移除视频工具');
    await fireEvent.press(screen.getByTestId('change-submit'));
    await waitFor(() => expect(screen.queryByTestId('change-input')).toBeNull());
    expect(store.getState().tab).toBe('tools');
  });

  it('a change applied on the file desk says so, with undo', async () => {
    const { store } = await renderDesk();
    await screen.findByTestId('desk-toolbar');
    const plan = async () => ({
      kind: 'ops' as const,
      ops: [{ op: 'updateContainer' as const, desk: { toolbar: 'top' as const } }],
    });
    await act(async () => {
      await store.getState().change('把工具栏放到上面', { plan } as never, {
        about: { kind: 'desk', fileKind: 'image' },
      });
    });
    await fireEvent.press(screen.getByTestId('draft-apply'));
    expect(await screen.findByTestId('banner')).toHaveTextContent(/撤销/);
  });
});

// D-611：在一个子 App 里，AI 页可以把这个 App 交给别的 AI App 改：App 文件（只有结构）和提示词一起交给分享面板，
// 从哪一页进来的写进提示词。主页提供做新 App 和改整份设置两个入口。
describe('hand the app to another AI app (D-611)', () => {
  const walletText = readFileSync(
    join(__dirname, '../../../../packages/core/src/fixtures/portal-apps/tinkrum-app-wallet.json'),
    'utf8',
  );

  async function renderWithWallet() {
    const files = new FakeFiles();
    const app = await renderToolsApp(new MemoryWorkspaceRepo(), files, {
      locale: 'zh',
      seed: (locale, registry) => {
        const base = createStarterWorkspace(locale, registry);
        const plan = appFileOps(readAppFile(walletText)!, base);
        if (!plan.ok) throw new Error(plan.error);
        const made = applyOps(base, plan.ops, { registry, locale });
        if (!made.ok) throw new Error(made.error);
        return made.config;
      },
    });
    return { ...app, files };
  }

  it('from a page of the app: shares its file and a prompt that names the page', async () => {
    const { store, files } = await renderWithWallet();
    await act(async () => store.getState().enterApp('wallet'));
    await fireEvent.press(await screen.findByTestId('page-ai'));
    await fireEvent.changeText(await screen.findByTestId('change-input'), '把标题改成我的钱包');
    await fireEvent.press(await screen.findByTestId('change-handoff'));
    await waitFor(() => expect(files.aiShares).toHaveLength(1));
    const [shared] = files.aiShares;
    expect(shared!.files.map((f) => f.name)).toEqual([
      'tinkrum-app-wallet.json',
      'tinkrum-check.js',
      'tinkrum-app-guide.md',
      'tinkrum-app-patterns.md',
    ]);
    const sent = JSON.parse(shared!.files[0]!.text) as { app: { id: string }; tables: unknown[] };
    expect(sent.app.id).toBe('wallet');
    // Claude 收到多个文件时会丢掉分享的文字：提示词在 tinkrum-request.md 里，文字只指一下它。
    expect(shared!.text).toBe('请先阅读附件 tinkrum-request.md，并照它去做。');
    expect(shared!.text).not.toContain('把标题改成我的钱包');
    expect(shared!.request).toContain('tinkrum-app-guide.md');
    expect(shared!.request).toContain('tinkrum-app-guide.md?v=');
    expect(shared!.request).toContain('「Wallet」');
    expect(shared!.request).toContain('id "wallet-home"');
    expect(shared!.request).toMatch(/先改这一页/);
    expect(shared!.request).toContain('node tinkrum-check.js');
    expect(shared!.request).toContain('把标题改成我的钱包');
    expect(shared!.request).not.toContain('先问我想改什么');
  });

  it('home offers both new app and whole setup, carrying the typed request', async () => {
    const { files, store, repo } = await renderWithWallet();
    const config = JSON.parse(JSON.stringify(store.getState().config!)) as WorkspaceConfig;
    const home = config.containers.pages.find((p) => p.id === 'home')!;
    home.blocks.push({
      id: 'private-picture',
      look: 'image',
      show: { asset: 'PRIVATE_FILE_SENTINEL', aspect: 'square', fit: 'contain' },
    });
    store.setState({ config });
    const table = config.data.tables.find((t) => t.app === 'wallet')!;
    await repo.insertRecord({
      id: 'private-record',
      collectionId: table.id,
      values: { [table.fields[0]!.id]: 'RECORD_CONTENT_SENTINEL' },
      createdAt: 1,
      updatedAt: 1,
    });
    await fireEvent.press(await screen.findByTestId('page-ai'));
    await fireEvent.changeText(await screen.findByTestId('change-input'), 'REQUEST_SENTINEL');
    await fireEvent.press(await screen.findByTestId('change-handoff-new'));
    await waitFor(() => expect(files.aiShares).toHaveLength(1));
    expect(files.aiShares[0]!.request).toContain('REQUEST_SENTINEL');
    expect(files.aiShares[0]!.files.some((f) => f.name.endsWith('.json'))).toBe(false);
    await fireEvent.press(screen.getByTestId('change-handoff-setup'));
    await waitFor(() => expect(files.aiShares).toHaveLength(2));
    const sent = files.aiShares[1]!;
    expect(sent.request).toContain('REQUEST_SENTINEL');
    expect(sent.request).toContain('morph-app-config');
    expect(JSON.parse(sent.files[0]!.text)).toMatchObject({ format: 'morph-app-config' });
    expect(sent.files[0]!.text).toContain('wallet');
    expect(JSON.stringify(sent)).not.toContain('PRIVATE_FILE_SENTINEL');
    expect(JSON.stringify(sent)).not.toContain('RECORD_CONTENT_SENTINEL');
  });

  it('only a tap on the return card reads the clipboard, then update, preview, apply and undo keep entries', async () => {
    const { store, files, repo } = await renderWithWallet();
    const read = jest.spyOn(files, 'readClipboardText');
    const alerts = jest.spyOn(Alert, 'alert');
    const before = store.getState().config!;
    const head = store.getState().head!.id;
    const table = before.data.tables.find((t) => t.app === 'wallet')!;
    const entry = {
      id: 'kept-entry',
      collectionId: table.id,
      values: { [table.fields[0]!.id]: 'Lunch' },
      createdAt: 1,
      updatedAt: 1,
    };
    await repo.insertRecord(entry);
    const changed = JSON.parse(walletText);
    changed.pages[0].title = 'UPDATED';
    await files.copyText(JSON.stringify(changed));
    await fireEvent.press(await screen.findByTestId('page-ai'));
    expect(screen.queryByTestId('ai-return-card')).toBeNull();
    await fireEvent.press(await screen.findByTestId('change-handoff-setup'));
    expect(await screen.findByTestId('ai-return-card')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('ai-return-paste'));
    await waitFor(() => expect(alerts).toHaveBeenCalled());
    let buttons = alerts.mock.calls.at(-1)![2]!;
    expect(buttons[0]!.text).toMatch(/更新/);
    expect(store.getState().head!.id).toBe(head);
    await act(() => buttons[0]!.onPress!());
    await waitFor(() => expect(alerts.mock.calls.at(-1)![1]).toContain('UPDATED'));
    expect(store.getState().head!.id).toBe(head);
    buttons = alerts.mock.calls.at(-1)![2]!;
    await act(() => buttons.find((b) => b.text === '应用')!.onPress!());
    await waitFor(() =>
      expect(store.getState().config!.containers.pages.some((p) => p.title === 'UPDATED')).toBe(
        true,
      ),
    );
    expect(useAiReturn.getState().pending).toBeNull();
    expect(screen.queryByTestId('ai-return-card')).toBeNull();
    await act(() => store.getState().undo());
    expect(store.getState().config).toEqual(before);
    expect(await repo.listRecords(table.id)).toEqual([entry]);
    expect(await repo.listPresets()).toEqual([]);
  });

  it('return card is also on home, can be dismissed, and expires after 24 hours', async () => {
    await renderWithWallet();
    await screen.findByTestId('page-ai');
    await act(() => {
      useAiReturn.getState().start('new');
    });
    expect(await screen.findByTestId('ai-return-card')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ai-return-dismiss'));
    expect(screen.queryByTestId('ai-return-card')).toBeNull();
    await act(() => {
      useAiReturn.getState().start('setup', Date.now() - AI_RETURN_TTL);
    });
    expect(screen.queryByTestId('ai-return-card')).toBeNull();
  });
});

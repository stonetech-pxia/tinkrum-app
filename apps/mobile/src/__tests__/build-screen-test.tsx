import { fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { act } from 'react';

import type { Locale } from '@morph/core';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { acceptNextAlert, renderToolsApp } from '../test-utils/render-app';

// Build plan and tool inventory on AI modification page (D-414, D-415). Uses built-in rules without sending requests.

async function openChange(locale: Locale = 'zh', repo = new MemoryWorkspaceRepo()) {
  const app = await renderToolsApp(repo, undefined, { locale });
  await act(async () => router.push('/change'));
  return { ...app, repo };
}

async function say(text: string) {
  await fireEvent.changeText(await screen.findByTestId('change-input'), text);
  await fireEvent.press(screen.getByTestId('change-submit'));
}

describe('Build plan', () => {
  it('New user: discuss large project, view plan, delete a step, start, complete, view results and preset saving prompt', async () => {
    const { store } = await openChange();
    await say('搭建一个记账 App');
    expect(await screen.findByTestId('build-panel')).toBeTruthy();
    expect(screen.getByText('一个能用的记账 App')).toBeTruthy();
    expect(screen.getByText('证件照快捷操作')).toBeTruthy();
    // No input field sending or inventory when plan is open.
    expect(screen.queryByTestId('change-session')).toBeNull();

    await fireEvent.press(screen.getByTestId('build-step-remove-scan'));
    expect(screen.queryByText('证件照快捷操作')).toBeNull();
    expect(store.getState().config!.data.tables).toHaveLength(0);

    await fireEvent.press(screen.getByTestId('build-start'));
    expect(await screen.findByTestId('build-check')).toBeTruthy();
    expect(screen.getByTestId('build-preset-hint')).toBeTruthy();
    expect(store.getState().config!.data.tables.length).toBeGreaterThan(0);
    // Appearance in draft: view only upon tapping.
    expect(store.getState().draft!.open).toBe(false);
    await fireEvent.press(screen.getByTestId('build-see-look'));
    await waitFor(() => expect(store.getState().draft!.open).toBe(true));
    expect(store.getState().build).toBeNull();
  });

  it('Step failure (built-in rules triggered): where it stalls, retry, complete', async () => {
    const { store } = await openChange();
    await say('搭建一个记账 App，有一步会失败');
    await fireEvent.press(await screen.findByTestId('build-start'));
    expect(await screen.findByTestId('build-stuck')).toBeTruthy();
    expect(screen.getByText('卡在「证件照快捷操作」')).toBeTruthy();
    expect(screen.getByTestId('build-skip')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('build-retry'));
    expect(await screen.findByTestId('build-check')).toBeTruthy();
    expect(store.getState().build!.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
  });

  it('Stop: display remaining steps count, continue to resume', async () => {
    const repo = new MemoryWorkspaceRepo();
    const { store } = await openChange('zh', repo);
    await say('搭建一个记账 App，有一步会失败');
    await fireEvent.press(await screen.findByTestId('build-start'));
    await fireEvent.press(await screen.findByTestId('build-stop'));
    expect(await screen.findByTestId('build-paused')).toBeTruthy();
    expect(screen.getByText('停下了，做好的都留着。还差 2 步。')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('build-resume'));
    expect(await screen.findByTestId('build-check')).toBeTruthy();
    expect(store.getState().build!.phase).toBe('finished');
  });

  it.each([
    ['zh', '前面已经做好了'],
    ['en', 'Already done in an earlier step'],
    ['fr', 'Déjà fait à une étape précédente'],
  ] as const)(
    'A preceding completed step has its own description (%s), while other steps do not',
    async (locale, text) => {
      const { store } = await openChange(locale);
      await act(async () =>
        store.setState({
          build: {
            summary: 'x',
            origin: { kind: 'chat' } as never,
            phase: 'finished',
            steps: [
              { id: 'a', kind: 'record', title: 'A', request: 'a', status: 'done' },
              { id: 'b', kind: 'look', title: 'B', request: 'b', status: 'done', already: true },
            ],
          },
        }),
      );
      expect(await screen.findByTestId('build-step-already-b')).toHaveTextContent(text);
      expect(screen.queryByTestId('build-step-already-a')).toBeNull();
      expect(screen.getByTestId('build-check')).toBeTruthy();
    },
  );

  it('Small modifications (color change) do not trigger plan', async () => {
    const { store } = await openChange();
    await say('主题换成绿色');
    await waitFor(() => expect(store.getState().draft).not.toBeNull());
    expect(screen.queryByTestId('build-panel')).toBeNull();
  });

  it('French interface: new interfaces are entirely in French', async () => {
    await openChange('fr');
    await say('Build a budget app');
    expect(await screen.findByText('Plan de création')).toBeTruthy();
    expect(screen.getByText('Une app de budget prête à servir')).toBeTruthy();
    expect(screen.getByText('Commencer')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('build-start'));
    expect(await screen.findByText('Toutes les étapes sont terminées')).toBeTruthy();
  });
});

describe('Tool inventory', () => {
  it('Tap remaining items to fill input field; can clear; new users have no inventory', async () => {
    const { store } = await openChange();
    expect(screen.queryByTestId('change-session')).toBeNull();
    // Start then end: uncompleted items remain in inventory.
    await say('搭建一个记账 App，有一步会失败');
    await fireEvent.press(await screen.findByTestId('build-start'));
    await fireEvent.press(await screen.findByTestId('build-stop'));
    await fireEvent.press(await screen.findByTestId('build-end'));
    expect(await screen.findByTestId('change-session')).toBeTruthy();
    const open = store
      .getState()
      .session.items.find((i) => i.status === 'todo' || i.status === 'failed')!;
    await fireEvent.press(screen.getByTestId(`change-session-item-${open.id}`));
    expect(screen.getByTestId('change-input').props.value).toBe(open.text);

    acceptNextAlert();
    await fireEvent.press(screen.getByTestId('change-session-clear'));
    await waitFor(() => expect(store.getState().session.items).toEqual([]));
    expect(screen.queryByTestId('change-session')).toBeNull();
  });
});

describe('Fix these (D-418)', () => {
  it('No issues: do not display', async () => {
    await openChange();
    expect(screen.queryByTestId('change-fix')).toBeNull();
    await say('搭建一个记账 App');
    await fireEvent.press(await screen.findByTestId('build-start'));
    expect(await screen.findByTestId('build-check')).toBeTruthy();
    expect(screen.queryByTestId('build-fix')).toBeNull();
    await fireEvent.press(screen.getByTestId('build-finish'));
    expect(screen.queryByTestId('change-fix')).toBeNull();
  });

  it('Issues with build results: see button, tapping makes issues and button disappear', async () => {
    const { store } = await openChange();
    await say('搭建一个记账 App，缺页面');
    await fireEvent.press(await screen.findByTestId('build-start'));
    expect(await screen.findByTestId('build-fix')).toBeTruthy();
    expect(screen.getAllByTestId('build-check-problem')).toHaveLength(1);
    expect(screen.getByText('把这些补上')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('build-fix'));
    await waitFor(() => expect(screen.queryByTestId('build-fix')).toBeNull());
    expect(screen.queryByTestId('build-check-problem')).toBeNull();
    // Supplemented item is a page (appearance): enters draft, view appearance button remains.
    expect(store.getState().draft).not.toBeNull();
    expect(screen.getByTestId('build-see-look')).toBeTruthy();
    expect(store.getState().build!.phase).toBe('finished');
  });

  it('AI modification page displays normally: N unusable items and button; tapping enters draft, button disappears upon return', async () => {
    const { store } = await openChange();
    await store.getState().change('新建一个记账页面');
    await store.getState().change('新建一个快捷操作：拍照，记到账目');
    expect(await screen.findByTestId('change-fix')).toBeTruthy();
    expect(screen.getByText('有 1 个地方用不了')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('change-fix-button'));
    await waitFor(() => expect(store.getState().draft).not.toBeNull());
    expect(store.getState().session.said.at(-1)!.input).toBe('把这些补上');
    await act(async () => router.push('/change'));
    expect(await screen.findByTestId('change-session')).toBeTruthy();
    expect(screen.queryByTestId('change-fix')).toBeNull();
  });

  it('Pre-existing issues at starting point are not displayed', async () => {
    const repo = new MemoryWorkspaceRepo();
    const first = await openChange('zh', repo);
    await first.store.getState().change('新建一个记账页面');
    await first.store.getState().change('新建一个快捷操作：拍照，记到账目');
    await first.store.getState().clearSession();
    await first.store.getState().change('主题换成绿色');
    await act(async () => router.push('/change'));
    expect(await screen.findByTestId('change-session')).toBeTruthy();
    expect(screen.queryByTestId('change-fix')).toBeNull();
  });

  it('French: buttons and counts are in French, singular form', async () => {
    const { store } = await openChange('fr');
    await store.getState().change('Create an expense page');
    await store.getState().change('Create a quick action: take photos, add a record to Expenses');
    expect(await screen.findByText('1 élément n’est pas utilisable')).toBeTruthy();
    expect(screen.getByText('Compléter ce qui manque')).toBeTruthy();
  });
});

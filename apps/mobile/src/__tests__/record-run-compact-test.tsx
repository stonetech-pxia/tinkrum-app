import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Completion is a "Log an entry" quick action (D-588): runtime does not display step list, displays
// only a single sentence stating what is being done; once logged or cancelled by user, returns
// directly to origin without staying on result page; quick actions without "Log an entry" behave as
// before.

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'jot',
          name: '随手记',
          fields: [
            { id: 'title', name: '标题', type: 'text' },
            { id: 'body', name: '内容', type: 'note' },
          ],
        },
      },
      {
        op: 'addTool',
        tool: {
          kind: 'quickAction',
          id: 'jot-run',
          name: '随手记一笔',
          steps: [
            { id: 'text', action: 'in.text', params: { text: '午饭 30' }, ask: [] },
            { id: 'add', action: 'out.addRecord', params: { collectionId: 'jot' } },
          ],
        },
      },
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(700);
    await Promise.resolve();
  });

async function openRun() {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  await renderToolsApp(repo, undefined, { locale: 'zh', seed });
  await settle();
  await act(() =>
    router.push({ pathname: '/run/[workflowId]', params: { workflowId: 'jot-run' } }),
  );
  await settle();
  return repo;
}

afterEach(() => useGuide.setState({ stage: null, repo: null }));

describe('a quick action that ends in Log an entry (D-588)', () => {
  it('shows only one line while it works, and goes back by itself once the entry is saved', async () => {
    const repo = await openRun();
    // Form overlays execution page: no step list, execution page is a concise single sentence.
    expect(await screen.findByTestId('local-done')).toBeTruthy();
    expect(screen.getByTestId('run-compact')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('local-done'));
    await settle();
    expect((await repo.listRecords('jot')).length).toBe(1);
    // Does not stay on result page: no "Run again / Done", returned to home.
    expect(screen.queryByTestId('run-done')).toBeNull();
    expect(screen.queryByTestId('run-screen')).toBeNull();
    expect(await screen.findByTestId('nav-settings')).toBeTruthy();
  });

  it('closing the form goes back too, and saves nothing', async () => {
    const repo = await openRun();
    await fireEvent.press(await screen.findByTestId('local-cancel'));
    await settle();
    expect((await repo.listRecords('jot')).length).toBe(0);
    expect(screen.queryByTestId('run-screen')).toBeNull();
    expect(await screen.findByTestId('nav-settings')).toBeTruthy();
  });
});

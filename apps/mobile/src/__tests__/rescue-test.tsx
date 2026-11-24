import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultWorkspace, type WorkspaceConfig } from '@morph/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { stepBack } from '../rescue/step-back';
import { RescueScreen } from '../rescue/RescueScreen';
import { MemoryWorkspaceRepo } from '../storage/memory';

// Health check 6.6 rescue page: export backup, go back to previous version, share error info, go to official website.

const NOW = new Date(2026, 10, 22, 12, 0);

// The three versions differ only in their primary color, making it easy to identify which one is active.
const COLORS: Record<string, string> = { 一: '#111111', 二: '#222222', 三: '#333333' };
function named(name: string): WorkspaceConfig {
  const config = createDefaultWorkspace('zh');
  return { ...config, theme: { ...config.theme, primaryColor: COLORS[name]! } };
}

async function history() {
  const repo = new MemoryWorkspaceRepo();
  let head = await repo.commitRevision({
    baseId: null,
    config: named('一'),
    source: 'seed',
    summary: '1',
  });
  head = await repo.commitRevision({
    baseId: head.id,
    config: named('二'),
    source: 'ai',
    summary: '2',
  });
  await repo.commitRevision({
    baseId: head.id,
    config: named('三'),
    source: 'ai',
    summary: '3',
  });
  await repo.insertRecord({
    id: 'r',
    collectionId: 't',
    values: { a: 1 },
    createdAt: 0,
    updatedAt: 0,
  });
  return repo;
}
const titleOf = async (repo: MemoryWorkspaceRepo) => {
  const color = ((await repo.getHead())!.config as WorkspaceConfig).theme.primaryColor;
  return Object.keys(COLORS).find((k) => COLORS[k] === color);
};

describe('going back a version from the rescue page', () => {
  it('each tap goes one version further back, as a new version in the history', async () => {
    const repo = await history();
    const state = {};
    await stepBack(repo, state, 'zh', NOW);
    expect(await titleOf(repo)).toBe('二');
    // Tap again: go back one more version, not returning to the broken one just visited.
    await stepBack(repo, state, 'zh', NOW);
    expect(await titleOf(repo)).toBe('一');
    // History only appends forward (§7D), and records remain completely untouched (invariant 5).
    expect(await repo.listRevisions(10)).toHaveLength(5);
    expect((await repo.getRecord('r'))!.values).toEqual({ a: 1 });
    expect((await repo.getHead())!.source).toBe('restore');
  });

  it('says so when there is no older version', async () => {
    const repo = await history();
    const state = {};
    await stepBack(repo, state, 'zh', NOW);
    await stepBack(repo, state, 'zh', NOW);
    await expect(stepBack(repo, state, 'zh', NOW)).rejects.toThrow('noOlder');
    expect(await titleOf(repo)).toBe('一');
  });
});

describe('the rescue page', () => {
  const actions = () => ({
    exportBackup: jest.fn(async () => undefined),
    stepBack: jest.fn(async () => NOW.getTime()),
    shareError: jest.fn(async (_text: string) => undefined),
    openSite: jest.fn(async () => undefined),
  });

  it('offers the four ways out and the version, in the device language', async () => {
    const a = actions();
    await render(
      <RescueScreen locale="fr" error="boom" version="1.0.0" actions={a} onContinue={jest.fn()} />,
    );
    expect(screen.getByTestId('rescue-version')).toHaveTextContent(/1\.0\.0/);
    await fireEvent.press(screen.getByTestId('rescue-export'));
    expect(a.exportBackup).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('rescue-site'));
    expect(a.openSite).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('rescue-share-error'));
    expect(a.shareError).toHaveBeenCalledWith(expect.stringMatching(/1\.0\.0[\s\S]*boom/));
  });

  it('going back says which version is now current; a failure is shown, not swallowed', async () => {
    const a = actions();
    await render(<RescueScreen locale="zh" actions={a} onContinue={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('rescue-step-back'));
    await waitFor(() => expect(screen.getByTestId('rescue-message')).toHaveTextContent(/已回到/));
    a.stepBack.mockRejectedValueOnce(new Error('noOlder'));
    await fireEvent.press(screen.getByTestId('rescue-step-back'));
    await waitFor(() =>
      expect(screen.getByTestId('rescue-message')).toHaveTextContent(/没有更早的版本/),
    );
    a.exportBackup.mockRejectedValueOnce(new Error('noSpace'));
    await fireEvent.press(screen.getByTestId('rescue-export'));
    await waitFor(() => expect(screen.getByTestId('rescue-message')).toHaveTextContent(/没能导出/));
  });

  it('without an error, there is nothing to share', async () => {
    await render(<RescueScreen locale="en" actions={actions()} onContinue={jest.fn()} />);
    expect(screen.queryByTestId('rescue-share-error')).toBeNull();
  });
});

// The rescue page and start gate must load nothing from the main flow until a button is tapped: they can only statically reference these items, while everything else (database, backups, UI) is loaded on demand when a button is pressed.
it('the rescue page and the start gate load nothing from the main flow until a button is tapped', () => {
  const allowed = [
    /^react$/,
    /^react-native$/,
    /^@morph\/core$/,
    /^expo-constants$/,
    /^expo-file-system$/,
    /^\.\/(attempts|RescueScreen|actions)$/,
    /^\.\.\/i18n$/,
  ];
  for (const file of [
    'RescueGate.tsx',
    'RescueScreen.tsx',
    'attempts.ts',
    'actions.ts',
    'expo-attempts.ts',
  ]) {
    const source = readFileSync(join(__dirname, '../rescue', file), 'utf8');
    const statics = [...source.matchAll(/^import [^;]*? from '([^']+)';/gms)].map((m) => m[1]!);
    for (const spec of statics) {
      expect([file, spec, allowed.some((r) => r.test(spec))]).toEqual([file, spec, true]);
    }
  }
});

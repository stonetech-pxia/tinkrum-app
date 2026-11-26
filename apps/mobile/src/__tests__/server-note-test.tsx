import { BUILTIN_TOOLS, createMockAIProvider, createRegistry, type Locale } from '@morph/core';
import { render, screen } from '@testing-library/react-native';

import { AISettingsProvider } from '../ai/context';
import { createAISettingsStore, type SecretStore } from '../ai/settings';
import { AISettingsScreen } from '../shell/AISettingsScreen';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore } from '../workspace/store';

// The note under "Tinkrum server" says what the production relay does with a request: it passes it
// on and does not save it (D-651).

const secrets = (): SecretStore => {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
};

const NOTES: [Locale, RegExp][] = [
  ['en', /Tinkrum server, which does not save them/],
  ['zh', /服务器不保存/],
  ['fr', /serveur Tinkrum, qui ne les enregistre pas/],
];

describe('Tinkrum server note', () => {
  it.each(NOTES)('says in %s that the server does not save requests', async (locale, note) => {
    const registry = createRegistry(BUILTIN_TOOLS);
    const aiSettings = createAISettingsStore({ secrets: secrets(), serverAvailable: true });
    await aiSettings.getState().load();
    await aiSettings.getState().setTinkAgent(true);
    const repo = new MemoryWorkspaceRepo();
    const store = createWorkspaceStore({
      repo,
      provider: createMockAIProvider(),
      registry,
      locale,
      now: () => new Date(2026, 10, 25, 9, 0),
    });
    await store.getState().boot();
    await render(
      <AISettingsProvider store={aiSettings}>
        <WorkspaceProvider value={{ store, repo, files: new FakeFiles(), registry, locale }}>
          <AISettingsScreen />
        </WorkspaceProvider>
      </AISettingsProvider>,
    );
    expect(screen.getByTestId('ai-server-note')).toHaveTextContent(note);
  });
});

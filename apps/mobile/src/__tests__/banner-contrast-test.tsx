import {
  BUILTIN_TOOLS,
  contrast,
  createDefaultWorkspace,
  createMockAIProvider,
  createRegistry,
} from '@morph/core';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { makePalette } from '../renderer/theme';
import type { FilePlatform } from '../runtime/runner';
import { Banner } from '../shell/Banner';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore } from '../workspace/store';

it('keeps warning text readable on the light danger colour of a dark theme', async () => {
  const repo = new MemoryWorkspaceRepo();
  const registry = createRegistry(BUILTIN_TOOLS);
  const store = createWorkspaceStore({
    repo,
    registry,
    provider: createMockAIProvider(),
    locale: 'fr',
    now: () => new Date(),
  });
  store.setState({ banner: { kind: 'rolledBack', message: 'Attention' } });
  const palette = makePalette({ ...createDefaultWorkspace('fr').theme, mode: 'dark' }, true);
  await render(
    <WorkspaceProvider value={{ store, registry, repo, locale: 'fr', files: {} as FilePlatform }}>
      <Banner palette={palette} />
    </WorkspaceProvider>,
  );
  const { color } = StyleSheet.flatten(screen.getByText('Attention').props.style);
  expect(contrast(color, palette.danger)).toBeGreaterThanOrEqual(4.5);
});

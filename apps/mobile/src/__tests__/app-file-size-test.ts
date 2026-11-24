import {
  appFileOps,
  type AppFile,
  BUILTIN_TOOLS,
  createMockAIProvider,
  createRegistry,
  createStarterWorkspace,
  CURRENT_SCHEMA_VERSION,
  MAX_OPS_PER_CHANGE,
} from '@morph/core';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { createWorkspaceStore } from '../workspace/store';

// Import a large app file (D-554): preview and confirm even with more than 30 steps, forms a single version, undoing once reverts to before import (invariant 7).

const registry = createRegistry(BUILTIN_TOOLS);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function bigApp(): AppFile {
  return {
    format: 'tinkrum-app',
    version: 1,
    exportedAt: '2026-11-16T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    app: {
      id: 'big',
      name: 'Big',
      bar: ['page:big-p0', 'ai'],
      theme: createStarterWorkspace('en', registry).theme,
    },
    tables: range(12).map((i) => ({
      id: `big-t${i}`,
      name: `Table ${i}`,
      fields: [{ id: 'name', name: 'Name', type: 'text' }],
    })) as AppFile['tables'],
    pages: range(15).map((i) => ({
      id: `big-p${i}`,
      title: `Page ${i}`,
      blocks: [
        { id: 'list', look: 'list', source: { table: `big-t${i % 12}` }, show: { title: 'name' } },
      ],
    })) as AppFile['pages'],
    tools: range(20).map((i) => ({
      id: `big-q${i}`,
      kind: 'quickAction',
      name: `Quick ${i}`,
      steps: [{ id: 's', action: 'in.photos', params: { source: 'files', min: 1, max: 5 } }],
    })) as AppFile['tools'],
  };
}

async function booted() {
  const repo = new MemoryWorkspaceRepo();
  const store = createWorkspaceStore({
    repo,
    provider: createMockAIProvider(),
    registry,
    locale: 'en',
    now: () => new Date(2026, 10, 16, 9, 0),
    seed: createStarterWorkspace,
  });
  await store.getState().boot();
  return { repo, store };
}

describe('importing a big app file (D-554)', () => {
  it('previews, applies as one version and undoes in one step', async () => {
    const { repo, store } = await booted();
    const before = store.getState().head!.id;
    const plan = appFileOps(bigApp(), store.getState().config!);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ops.length).toBeGreaterThan(MAX_OPS_PER_CHANGE);
    const result = await store.getState().proposeOps(plan.ops, 'import', { fromAppFile: true });
    expect(result.kind).toBe('preview');
    expect(await store.getState().confirm()).toBe(true);
    await store.getState().markRendered(store.getState().head!.id);
    expect(store.getState().head!.parentId).toBe(before);
    expect(store.getState().config!.containers.pages.filter((p) => p.app === 'big')).toHaveLength(
      15,
    );
    expect((await repo.listRevisions(10)).length).toBe(2);
    await store.getState().undo();
    expect(store.getState().config!.containers.pages.some((p) => p.app === 'big')).toBe(false);
  });

  it('other button changes keep the 30-step limit', async () => {
    const { store } = await booted();
    const plan = appFileOps(bigApp(), store.getState().config!);
    if (!plan.ok) throw new Error(plan.error);
    expect((await store.getState().proposeOps(plan.ops, 'import')).kind).toBe('invalid');
  });
});

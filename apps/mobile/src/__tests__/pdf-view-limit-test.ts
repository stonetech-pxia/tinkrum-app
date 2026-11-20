import { BUILTIN_TOOLS, createRegistry, type RunResult, type Workflow } from '@morph/core';

import type { PackPageId, PackRuntime } from '../packs/bridge';
import type { LocalUi } from '../runtime/local';
import { startRun } from '../runtime/runner';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, makePdf } from '../test-utils/fake-files';

// D-601：PDF 整份读进内存的动作按 100 MB 收，但走 PDF 预览包（WebView + pdf.js）的动作内存是文件的
// 20–30 倍，仍然只收 50 MB。这里用 copyToRun 报告的大小，不真的分配几十 MB。

const MB = 1024 * 1024;
const registry = createRegistry(BUILTIN_TOOLS);

class TextPack implements PackRuntime {
  calls: string[] = [];
  async call<T>(_page: PackPageId, method: string): Promise<T> {
    this.calls.push(method);
    if (method === 'text') return { pages: ['hello'] } as T;
    if (method === 'render') return [] as T;
    throw new Error(`unknown ${method}`);
  }
}

async function runOn(action: string, params: Record<string, unknown>, mb: number) {
  const files = new FakeFiles();
  const copy = files.copyToRun.bind(files);
  // 复制之后报告的大小：实际字节很小，只改元数据。
  files.copyToRun = async (uri, runId, name) => ({
    ...(await copy(uri, runId, name)),
    size: mb * MB,
  });
  files.nextPick = [files.offer('big.pdf', await makePdf(1))];
  const packs = new TextPack();
  const workflow: Workflow = {
    kind: 'quickAction',
    id: 'wf',
    name: 'wf',
    steps: [
      { id: 'pick', action: 'in.files', params: { accept: 'pdf', min: 1, max: 1 } },
      { id: 'run', action, params },
    ],
  };
  const ui: LocalUi = {
    confirm: async () => true,
    choose: async () => null,
    open: async () => null as never,
  };
  const { result } = await startRun({
    workflow,
    revisionId: 1,
    repo: new MemoryWorkspaceRepo(),
    files,
    registry,
    locale: 'en',
    now: () => new Date(2026, 10, 20),
    newId: () => 'id1',
    ui,
    packs: { runtime: packs, isInstalled: async () => true },
    ensurePack: async () => true,
  });
  return { result, packs };
}

const failure = (r: RunResult) =>
  r.status === 'failed' ? { code: r.error.code, detail: r.error.detail } : r.status;

describe('PDF actions that go through the preview pack stay at 50 MB (D-601)', () => {
  it('toImages and extractText refuse a 60 MB PDF with the 50 MB limit, without calling the pack', async () => {
    for (const [action, params] of [
      ['pdf.extractText', {}],
      ['pdf.toImages', { maxSide: 1200 }],
    ] as const) {
      const { result, packs } = await runOn(action, params, 60);
      expect(failure(result)).toEqual({ code: 'tooLarge', detail: { name: 'big.pdf', mb: 50 } });
      expect(packs.calls).toEqual([]);
    }
  });

  it('a 49 MB PDF still reaches the pack', async () => {
    const { packs } = await runOn('pdf.extractText', {}, 49);
    expect(packs.calls).toContain('text');
  });

  it('edit actions take a 100 MB PDF (not through the pack)', async () => {
    const { result } = await runOn('pdf.rotate', { angle: 90, rule: 'all' }, 100);
    expect(failure(result)).toBe('succeeded');
  });
});

import { describe, expect, it } from 'vitest';

import { describeChange } from './describe';
import { applyOps, type Op } from './ops';
import type { WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';
import { validateWorkspace } from './validate';

// File slot (D-257): look button, opens {file}; config contains only label, prompt, appearance, and user file ID (null = empty slot).

const add: Op = {
  op: 'addContainer',
  page: 'home',
  block: { id: 'lease', look: 'button', show: { label: 'Lease' }, opens: { file: null } },
};
function apply(config: WorkspaceConfig, ops: Op[]): WorkspaceConfig {
  const result = applyOps(config, ops, { registry, locale: 'en' });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}
const ctx = (locale: 'en' | 'zh' | 'fr') => ({ registry, locale, now: new Date(2026, 9, 27) });

describe('a file slot', () => {
  it('an empty slot is valid; the user sets and removes the file id', () => {
    const empty = apply(workspace('en'), [add]);
    expect(validateWorkspace(empty, registry).ok).toBe(true);
    const set: Op = {
      op: 'updateContainer',
      page: 'home',
      block: 'lease',
      changes: { opens: { file: 'abc123def' } },
    };
    const withFile = apply(empty, [set]);
    expect(validateWorkspace(withFile, registry).ok).toBe(true);
    expect(describeChange([set], empty, [], ctx('zh'))).toEqual([
      '修改文件入口「Lease」：更换文件',
    ]);
    const remove: Op = { ...set, changes: { opens: { file: null } } };
    expect(describeChange([remove], withFile, [], ctx('en'))[0]).toContain('file removed');
    expect(describeChange([remove], withFile, [], ctx('fr'))[0]).toContain('fichier retiré');
  });

  it('a file name or path is not a file id', () => {
    for (const assetId of ['合同.pdf', 'assets/abc/x.pdf', 'file:///x.pdf']) {
      const config = apply(workspace('en'), [add]);
      const slot = config.containers.pages[0]!.blocks.find((c) => c.id === 'lease')!;
      (slot as { opens: unknown }).opens = { file: assetId };
      expect(validateWorkspace(config, registry).ok).toBe(false);
    }
  });
});

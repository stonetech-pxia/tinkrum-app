import { describe, expect, it } from 'vitest';

import { PlanSchema } from './ai/types';
import { appFileOps, appResetOps, type AppFile } from './app-file';
import { prepareOps } from './change';
import { MAX_OPS_PER_CHANGE, type Op } from './ops-schema';
import { CURRENT_SCHEMA_VERSION, type WorkspaceConfig } from './schema';
import { createStarterWorkspace } from './starter';
import { registry } from './test-helpers';

// 一个大的 App 文件（D-554）：导入、恢复初始样子不受 AI 计划的 30 步限制，只受配置本身的上限管；
// 还是一个版本、一条改动记录，整份校验（底线 7、18）。AI 的计划照旧最多 30 步。

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 16) };
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
    tools: [
      ...range(10).map((i) => ({
        id: `big-q${i}`,
        kind: 'quickAction',
        name: `Quick ${i}`,
        steps: [{ id: 's', action: 'in.photos', params: { source: 'files', min: 1, max: 5 } }],
      })),
      ...range(10).map((i) => ({
        id: `big-r${i}`,
        kind: 'reminder',
        title: `Reminder ${i}`,
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:big-p0',
      })),
    ] as AppFile['tools'],
  };
}

function apply(config: WorkspaceConfig, ops: Op[]): WorkspaceConfig {
  const r = prepareOps(config, ops, { ...ctx, fromAppFile: true });
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.after;
}

describe('大的 App 文件（D-554）', () => {
  it('imports an app with 12 tables, 15 pages and 20 tools as one change', () => {
    const before = createStarterWorkspace('en', registry);
    const plan = appFileOps(bigApp(), before);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ops.length).toBeGreaterThan(MAX_OPS_PER_CHANGE);
    const after = apply(before, plan.ops);
    expect(after.data.tables.filter((t) => t.app === 'big')).toHaveLength(12);
    expect(after.containers.pages.filter((p) => p.app === 'big')).toHaveLength(15);
    expect(after.tools.filter((t) => t.app === 'big')).toHaveLength(20);
  });

  it('imports it into the home too', () => {
    const before = createStarterWorkspace('en', registry);
    const plan = appFileOps(bigApp(), before, { mode: 'home' });
    if (!plan.ok) throw new Error(plan.error);
    expect(apply(before, plan.ops).containers.pages.map((p) => p.id)).toContain('big-p14');
  });

  it('restores it to the file as one change', () => {
    const before = createStarterWorkspace('en', registry);
    const plan = appFileOps(bigApp(), before);
    if (!plan.ok) throw new Error(plan.error);
    const installed = apply(before, plan.ops);
    const changed = apply(installed, [{ op: 'removeContainer', page: 'big-p3' }]);
    const reset = appResetOps(bigApp(), changed, registry);
    if (!reset.ok) throw new Error(reset.error);
    expect(reset.ops.length).toBeGreaterThan(MAX_OPS_PER_CHANGE);
    const after = apply(changed, reset.ops);
    expect(after.containers.pages.filter((p) => p.app === 'big')).toHaveLength(15);
  });

  it('still validates the whole app: a page reading a missing table is refused', () => {
    const before = createStarterWorkspace('en', registry);
    const file = bigApp();
    file.pages[14] = {
      id: 'big-p14',
      title: 'Broken',
      blocks: [{ id: 'list', look: 'list', source: { table: 'nope' }, show: { title: 'name' } }],
    } as AppFile['pages'][number];
    const plan = appFileOps(file, before);
    if (!plan.ok) throw new Error(plan.error);
    expect(prepareOps(before, plan.ops, { ...ctx, fromAppFile: true })).toMatchObject({
      ok: false,
      stage: 'validate',
    });
  });

  it('keeps the 30-step limit for everything else, AI plans included', () => {
    const before = createStarterWorkspace('en', registry);
    const plan = appFileOps(bigApp(), before);
    if (!plan.ok) throw new Error(plan.error);
    const ops = plan.ops.slice(0, MAX_OPS_PER_CHANGE + 1);
    expect(prepareOps(before, ops, ctx)).toMatchObject({ ok: false, stage: 'parse' });
    // AI 不能借这一项绕过上限。
    expect(prepareOps(before, ops, { ...ctx, fromAI: true, fromAppFile: true })).toMatchObject({
      ok: false,
      stage: 'parse',
    });
    expect(PlanSchema.safeParse({ kind: 'ops', ops }).success).toBe(false);
    expect(
      PlanSchema.safeParse({ kind: 'ops', ops: ops.slice(0, MAX_OPS_PER_CHANGE) }).success,
    ).toBe(true);
  });
});

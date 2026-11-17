import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { Op } from './ops';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// 块「只在有符合条件的记录时显示」（D-579）：showIf 多一个可选的 filter（和列表的筛选同一种写法，汇总、查找算出来的字段
// 也能用）。只决定画不画，不写任何东西；筛选里的字段被删了，校验会指出来，和列表的筛选一样（底线 18）。

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 17) };
const subs: Collection = {
  id: 'subs',
  name: 'Subscriptions',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'paused', name: 'Paused', type: 'checkbox' },
  ],
};
const pending = [{ field: 'paused', op: 'isNot', value: true }];
const banner = (showIf: unknown) => ({
  id: 'banner',
  look: 'text',
  show: { text: 'Confirm your subscriptions' },
  showIf,
});
const setup = (showIf: unknown) =>
  prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: subs },
      { op: 'addContainer', page: 'home', block: banner(showIf) },
    ] as Op[],
    ctx,
  );
const problems = (showIf: unknown) => {
  const r = setup(showIf);
  return r.ok ? [] : r.issues.map(String);
};

describe('showIf with a filter (D-579)', () => {
  it('accepts a filter on the table the condition reads', () => {
    expect(problems({ table: 'subs', has: 'some', filter: pending })).toEqual([]);
    expect(problems({ table: 'subs', has: 'none', filter: pending })).toEqual([]);
  });

  it('refuses a filter on a field the table does not have', () => {
    const found = problems({
      table: 'subs',
      has: 'some',
      filter: [{ field: 'nope', op: 'isNot', value: true }],
    }).join();
    expect(found).toMatch(/nope/);
  });

  it('refuses an empty or oversized filter list shape, and a filter that is not a list', () => {
    expect(problems({ table: 'subs', has: 'some', filter: 'x' }).join()).not.toBe('');
    expect(
      problems({
        table: 'subs',
        has: 'some',
        filter: Array.from({ length: 6 }, () => pending[0]),
      }).join(),
    ).not.toBe('');
  });

  it('leaves showIf without a filter exactly as before', () => {
    expect(problems({ table: 'subs', has: 'some' })).toEqual([]);
  });

  it('refuses removing a field a showIf filter reads, instead of leaving a dangling reference', () => {
    const first = setup({ table: 'subs', has: 'some', filter: pending });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = prepareOps(
      first.after as WorkspaceConfig,
      [{ op: 'removeData', table: 'subs', field: 'paused' }] as Op[],
      ctx,
    );
    expect(after.ok).toBe(false);
  });
});

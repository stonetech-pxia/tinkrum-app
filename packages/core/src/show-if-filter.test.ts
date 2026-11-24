import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { Op } from './ops';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// Block "show only when records matching conditions exist" (D-579): showIf takes an optional filter
// (same syntax as list filtering, rollups and lookup-calculated fields can also be used).
// Determines only whether to render or not, does not write anything; deleted fields in filters are
// pointed out by validation, same as list filters (invariant 18).

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

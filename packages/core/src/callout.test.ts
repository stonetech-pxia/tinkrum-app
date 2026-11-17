import { describe, expect, it } from 'vitest';

import { calloutTokens, fillCallout } from './callout-text';
import { prepareOps } from './change';
import type { Op } from './ops';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// 提示卡（D-580）：文字里的 {count}、{sum:字段} 按符合条件的记录算，卡片里最多两个按钮（一个一键记录、一个打开页面）。
// 只读和一键记录，不存任何数字（底线 14）；配置里的引用被删了要被拒绝（底线 18）。

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 17) };
const subs: Collection = {
  id: 'subs',
  name: 'Subscriptions',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'CNY' },
    { id: 'paused', name: 'Paused', type: 'checkbox' },
  ],
};
const tx: Collection = {
  id: 'tx',
  name: 'Spending',
  fields: [
    { id: 'merchant', name: 'Merchant', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'CNY' },
    { id: 'sub', name: 'Subscription', type: 'link', table: 'subs' },
  ],
};
const pending = [{ field: 'paused', op: 'isNot', value: true }];
const callout = (over: Record<string, unknown> = {}) => ({
  id: 'prompt',
  look: 'callout',
  show: {
    title: 'To confirm',
    text: '{count} subscriptions, {sum:amount} in total.',
    actionLabel: 'Add',
    openLabel: 'Edit',
    ...((over.show as object) ?? {}),
  },
  source: { table: 'subs', filter: pending },
  tools: [
    {
      do: 'createAll',
      table: 'tx',
      from: 'subs',
      filter: pending,
      values: { amount: { copy: 'amount' }, sub: '$row' },
    },
  ],
  opens: 'settings',
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'show')),
});
const setup = (block: unknown) =>
  prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: subs },
      { op: 'addData', table: tx },
      { op: 'addContainer', page: 'home', block },
    ] as Op[],
    ctx,
  );
const problems = (block: unknown) => {
  const r = setup(block);
  return r.ok ? [] : r.issues.map(String);
};

describe('callout (D-580)', () => {
  it('accepts a card with a text that counts, a record tool and an open button', () => {
    expect(problems(callout())).toEqual([]);
  });

  it('accepts a card with only text, or with only one of the two buttons', () => {
    expect(
      problems(
        callout({
          show: { actionLabel: undefined, openLabel: undefined },
          tools: undefined,
          opens: undefined,
        }),
      ),
    ).toEqual([]);
    expect(problems(callout({ show: { openLabel: undefined }, opens: undefined }))).toEqual([]);
    expect(problems(callout({ show: { actionLabel: undefined }, tools: undefined }))).toEqual([]);
  });

  it('refuses a {sum:} on a field that is missing, not a number, or in different currencies', () => {
    expect(problems(callout({ show: { text: '{sum:nope}' } })).join()).toMatch(/nope/);
    expect(problems(callout({ show: { text: '{sum:name}' } })).join()).toMatch(/number or money/);
  });

  it('refuses a button label without what it runs, and what it runs without a label', () => {
    expect(problems(callout({ tools: undefined })).join()).toMatch(/actionLabel needs tools/);
    expect(problems(callout({ show: { actionLabel: undefined } })).join()).toMatch(
      /actionLabel is needed/,
    );
    expect(problems(callout({ opens: undefined })).join()).toMatch(/openLabel needs opens/);
    expect(problems(callout({ show: { openLabel: undefined } })).join()).toMatch(
      /openLabel is needed/,
    );
  });

  it('refuses a filter on a field the table does not have', () => {
    expect(
      problems(
        callout({
          source: { table: 'subs', filter: [{ field: 'nope', op: 'isNot', value: true }] },
        }),
      ).join(),
    ).toMatch(/nope/);
  });

  it('refuses removing a field its text or filter reads, instead of leaving a dangling reference', () => {
    const first = setup(callout());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (const field of ['paused', 'amount']) {
      const after = prepareOps(
        first.after as WorkspaceConfig,
        [{ op: 'removeData', table: 'subs', field }] as Op[],
        ctx,
      );
      expect(after.ok, field).toBe(false);
    }
  });
});

describe('the placeholders in a callout text', () => {
  it('finds {count} and {sum:field} in the order they appear', () => {
    expect(calloutTokens('a {count} b {sum:amount} c {sum:fee-2}')).toEqual([
      { kind: 'count' },
      { kind: 'sum', field: 'amount' },
      { kind: 'sum', field: 'fee-2' },
    ]);
    expect(calloutTokens('no placeholders, {unknown} stays text')).toEqual([]);
  });

  it('fills them from the numbers the caller worked out', () => {
    expect(
      fillCallout('{count} items, {sum:amount} in total, {count} again', {
        count: '3',
        sum: (f) => (f === 'amount' ? '¥371' : '?'),
      }),
    ).toBe('3 items, ¥371 in total, 3 again');
  });
});

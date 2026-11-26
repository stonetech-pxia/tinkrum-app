import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { Op } from './ops';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// Time tabs on pages and their associated charts and number cards (D-440): config validation, and cleanup when deleting blocks.

const ctx = { registry, locale: 'zh' as const, now: new Date(2026, 10, 4) };

const expenses: Collection = {
  id: 'expenses',
  name: '账目',
  fields: [
    { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
    { id: 'date', name: '日期', type: 'date' },
  ],
} as Collection;

const period = (show: object = { periods: ['thisWeek', 'thisMonth'] }, id = 'range') => ({
  id,
  look: 'tabs',
  show,
});
const chart = (source: object = {}) => ({
  id: 'c',
  look: 'chart',
  show: { kind: 'bar', title: '开销' },
  source: {
    table: 'expenses',
    aggregate: 'sum',
    field: 'amount',
    group: { unit: 'month' },
    ...source,
  },
});
const number = (source: object = {}) => ({
  id: 'n',
  look: 'number',
  show: { label: '合计' },
  source: { table: 'expenses', aggregate: 'sum', field: 'amount', ...source },
});

const build = (blocks: object[]) =>
  prepareOps(
    workspace('zh'),
    [
      { op: 'addData', table: expenses },
      { op: 'addContainer', page: { id: 'p', title: 'P', blocks } },
    ] as unknown as Op[],
    ctx,
  );
const ok = (blocks: object[]) => build(blocks).ok;
const issues = (blocks: object[]) => {
  const r = build(blocks);
  return r.ok ? [] : r.issues;
};

describe('time tabs', () => {
  it('takes the choices in order, with an optional default and a custom range', () => {
    expect(ok([period()])).toBe(true);
    expect(ok([period({ periods: ['thisMonth'], default: 'thisMonth', custom: true })])).toBe(true);
  });

  it('refuses no choices, repeated choices, other values, a default that is not a choice', () => {
    expect(ok([period({ periods: [] })])).toBe(false);
    expect(ok([period({ periods: ['thisWeek', 'thisWeek'] })])).toBe(false);
    expect(ok([period({ periods: ['last14days'] })])).toBe(false);
    expect(issues([period({ periods: ['thisWeek'], default: 'thisYear' })]).join()).toMatch(
      /show.default/,
    );
  });

  it('one per page', () => {
    expect(issues([period(undefined, 'a'), period(undefined, 'b')]).join()).toMatch(
      /more than one/,
    );
  });
});

describe('charts and numbers that follow the page', () => {
  it('need time tabs on the same page', () => {
    expect(ok([period(), chart({ period: 'page' }), number({ period: 'page' })])).toBe(true);
    expect(issues([chart({ period: 'page' })]).join()).toMatch(/needs time tabs/);
    expect(issues([number({ period: 'page' })]).join()).toMatch(/needs time tabs/);
  });

  it('a pie can follow too; compare works without an inPeriod filter, but a pie has no previous', () => {
    expect(
      ok([period(), chart({ period: 'page', group: { by: 'date' }, compare: 'previous' })]),
    ).toBe(false);
    expect(ok([period(), number({ period: 'page', compare: 'previous' })])).toBe(true);
  });

  it('a chart with compare and a page range may keep an inPeriod filter: it is ignored', () => {
    expect(
      ok([
        period(),
        chart({
          period: 'page',
          compare: 'previous',
          filter: [{ field: 'date', op: 'inPeriod', value: 'thisYear' }],
        }),
      ]),
    ).toBe(true);
  });

  it('a number that does not depend on a period cannot follow one', () => {
    expect(ok([period(), number({ aggregate: 'streak', field: undefined, period: 'page' })])).toBe(
      false,
    );
  });
});

describe('removing the time tabs', () => {
  const withBlocks = (): WorkspaceConfig => {
    const r = build([period(), chart({ period: 'page' }), number({ period: 'page' })]);
    if (!r.ok) throw new Error(r.issues.join());
    return r.after;
  };
  const sources = (c: WorkspaceConfig) =>
    c.containers.pages
      .find((p) => p.id === 'p')!
      .blocks.filter((b) => b.look === 'chart' || b.look === 'number')
      .map((b) => (b as { source: { period?: string } }).source.period);

  it('takes source.period off the charts and numbers, which keep their own range', () => {
    expect(sources(withBlocks())).toEqual(['page', 'page']);
    const r = prepareOps(withBlocks(), [{ op: 'removeContainer', page: 'p', block: 'range' }], ctx);
    if (!r.ok) throw new Error(r.issues.join());
    expect(sources(r.after)).toEqual([undefined, undefined]);
  });

  it('changing the choices keeps everything following', () => {
    const r = prepareOps(
      withBlocks(),
      [
        {
          op: 'updateContainer',
          page: 'p',
          block: 'range',
          changes: { show: { periods: ['thisMonth'] } },
        },
      ] as unknown as Op[],
      ctx,
    );
    if (!r.ok) throw new Error(r.issues.join());
    expect(sources(r.after)).toEqual(['page', 'page']);
  });
});

describe('record lists that follow the time tabs (D-561)', () => {
  const list = (source: object = {}, extra: object = {}, look = 'list') => ({
    id: 'l',
    look,
    source: { table: 'expenses', period: 'page', ...source },
    show: { title: 'amount' },
    ...extra,
  });

  it('a record block may follow the page range when the page has time tabs', () => {
    expect(issues([period(), list()])).toEqual([]);
    for (const look of ['cards', 'checklist', 'tiles', 'board', 'table', 'gallery'])
      expect(
        issues([
          period(),
          list(look === 'board' ? { group: { by: 'amount' } } : {}, {}, look),
        ]).join(),
      ).not.toMatch(/period/);
  });

  it('needs time tabs on the same page', () => {
    expect(issues([list()]).join()).toMatch(
      /source.period "page" needs time tabs \(a tabs block with show.periods\) on the same page/,
    );
  });

  it("is refused on a calendar and next to the list's own period row", () => {
    expect(issues([period(), list({ group: { unit: 'day' } }, {}, 'calendar')]).join()).toMatch(
      /a calendar moves by month itself: no source.period/,
    );
    expect(
      issues([
        period(),
        list({}, { show: { title: 'amount', browse: { period: 'date' } } }),
      ]).join(),
    ).toMatch(/follows the page's time range: no show.browse.period/);
  });

  it('removing the time tabs takes source.period off the lists too', () => {
    const r = build([period(), list()]);
    if (!r.ok) throw new Error(r.issues.join());
    const removed = prepareOps(
      r.after,
      [{ op: 'removeContainer', page: 'p', block: 'range' }],
      ctx,
    );
    if (!removed.ok) throw new Error(removed.issues.join());
    const l = removed.after.containers.pages
      .find((p) => p.id === 'p')!
      .blocks.find((b) => b.id === 'l') as unknown as { source: { period?: string } };
    expect(l.source.period).toBeUndefined();
  });
});

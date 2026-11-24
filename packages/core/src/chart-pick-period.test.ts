import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { Op } from './ops';
import { unitRange } from './page-period';
import type { Collection } from './schema';
import { registry, workspace } from './test-helpers';

// Tapping a bar updates the page's time range to match that period (D-585): permitted only when grouped by time, independent of page range, and when the current page contains a period block with custom options.

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 17) };
const tx: Collection = {
  id: 'tx',
  name: 'Spending',
  fields: [
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'CNY' },
  ],
};
const period = (custom: boolean) => ({
  id: 'range',
  look: 'period',
  show: { options: ['thisMonth', 'lastMonth'], ...(custom ? { custom: true } : {}) },
});
const chart = (show: Record<string, unknown>, source: Record<string, unknown> = {}) => ({
  id: 'trend',
  look: 'chart',
  show: { kind: 'bar', title: 'By month', ...show },
  source: {
    table: 'tx',
    aggregate: 'sum',
    field: 'amount',
    group: { by: 'date', unit: 'month', last: 12 },
    ...source,
  },
});
const problems = (blocks: unknown[]) => {
  const r = prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: tx },
      ...blocks.map((block) => ({ op: 'addContainer', page: 'home', block })),
    ] as Op[],
    ctx,
  );
  return r.ok ? [] : r.issues.map(String);
};

describe('chart show.pickPeriod (D-585)', () => {
  it('accepts a monthly bar chart next to a period block that allows a custom range', () => {
    expect(problems([period(true), chart({ pickPeriod: true })])).toEqual([]);
  });

  it('needs a period block with custom: true on the page', () => {
    expect(problems([chart({ pickPeriod: true })]).join()).toMatch(/period block/);
    expect(problems([period(false), chart({ pickPeriod: true })]).join()).toMatch(/custom/);
  });

  it('refuses a pie chart, a chart that is not grouped by time, and one that follows the page range', () => {
    const pie = chart({ kind: 'pie', pickPeriod: true }, { group: { by: 'date' } });
    expect(problems([period(true), pie]).join()).toMatch(/pickPeriod/);
    expect(
      problems([period(true), chart({ pickPeriod: true }, { period: 'page' })]).join(),
    ).toMatch(/source\.period/);
  });
});

describe('unitRange', () => {
  it('gives the whole day, the 7 days of a week, or the days up to the end of the month', () => {
    expect(unitRange('2026-10-05', 'day')).toEqual({ start: '2026-10-05', end: '2026-10-05' });
    expect(unitRange('2026-10-05', 'week')).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(unitRange('2026-10-01', 'month')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(unitRange('2026-02-01', 'month')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(unitRange('2028-02-01', 'month')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
});

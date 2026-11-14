import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import { filterRecords, formatRef, recordValue, sortRecords, type DataRecord } from './data';
import type { Collection } from './schema';
import { registry, workspace } from './test-helpers';

// 算出来的日期（D-542）：开始日期加 N 天或 N 个月（N 是固定数或这条的数字字段），不存，按日期显示、筛选、排序。

const contracts: Collection = {
  id: 'contracts',
  name: 'Contracts',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'start', name: 'Start', type: 'date' },
    { id: 'term', name: 'Term (months)', type: 'number' },
    { id: 'ends', name: 'Ends', type: 'dateOffset', from: 'start', add: 'term', unit: 'months' },
    { id: 'notice', name: 'Notice', type: 'dateOffset', from: 'start', add: 30, unit: 'days' },
  ],
};
const rec = (id: string, values: Record<string, unknown>): DataRecord => ({
  id,
  collectionId: 'contracts',
  values,
  createdAt: 0,
  updatedAt: 0,
});
const now = new Date(2026, 10, 14, 10);

describe('computed date field (D-542)', () => {
  it('adds days, or months clamped to the end of the month', () => {
    const r = rec('a', { start: '2026-01-31', term: 1 });
    expect(recordValue(r, contracts, 'ends', now)).toBe('2026-02-28');
    expect(recordValue(r, contracts, 'notice', now)).toBe('2026-03-02');
    expect(recordValue(rec('b', { start: '2025-11-30', term: 3 }), contracts, 'ends', now)).toBe(
      '2026-02-28',
    );
    expect(recordValue(rec('c', { start: '2026-03-15', term: -3 }), contracts, 'ends', now)).toBe(
      '2025-12-15',
    );
    // 开始日期或 N 没有值时没有值。
    expect(recordValue(rec('d', { term: 2 }), contracts, 'ends', now)).toBeUndefined();
    expect(recordValue(rec('e', { start: '2026-01-01' }), contracts, 'ends', now)).toBeUndefined();
  });

  it('is never stored, shows as a date, filters and sorts like one', () => {
    const records = [
      rec('soon', { start: '2025-12-01', term: 12 }),
      rec('past', { start: '2025-01-01', term: 6 }),
      rec('later', { start: '2026-11-01', term: 24 }),
    ];
    expect(records.every((r) => !('ends' in r.values))).toBe(true);
    expect(formatRef(records[0]!, contracts, 'ends', 'en', undefined, now)).toBe('2026-12-01');
    const ids = (op: 'inPeriod' | 'lt', value: string) =>
      filterRecords(records, contracts, [{ field: 'ends', op, value }], now).map((r) => r.id);
    expect(ids('inPeriod', 'next30days')).toEqual(['soon']);
    expect(ids('lt', 'today')).toEqual(['past']);
    expect(
      sortRecords(records, contracts, { field: 'ends', direction: 'asc' }, now).map((r) => r.id),
    ).toEqual(['past', 'soon', 'later']);
  });

  it('checks its start (a date field) and its amount (a number or a number field)', () => {
    const issues = (field: object) => {
      const r = prepareOps(
        workspace('en'),
        [{ op: 'addData', table: { ...contracts, fields: [...contracts.fields, field] } } as never],
        { registry, locale: 'en', now },
      );
      return r.ok ? [] : r.issues;
    };
    const base = { id: 'x', name: 'X', type: 'dateOffset', unit: 'days' };
    expect(issues({ ...base, from: 'createdAt', add: 7 })).toEqual([]);
    expect(issues({ ...base, from: 'name', add: 7 }).join()).toMatch(/from name/);
    expect(issues({ ...base, from: 'start', add: 'name' }).join()).toMatch(/add name/);
    expect(issues({ ...base, from: 'start', add: 1.5 })).not.toEqual([]);
  });
});

it('removing the start or amount field is refused while a computed date reads it, like a formula (invariant 18)', () => {
  const ctx = { registry, locale: 'en' as const, now };
  const r = prepareOps(workspace('en'), [{ op: 'addData', table: contracts }], ctx);
  if (!r.ok) throw new Error(r.issues.join());
  for (const field of ['start', 'term']) {
    const a = prepareOps(r.after, [{ op: 'removeData', table: 'contracts', field }], ctx);
    expect(a.ok ? [] : a.issues.join()).toMatch(/contracts\.ends/);
  }
});

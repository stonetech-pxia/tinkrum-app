import { describe, expect, it } from 'vitest';

import { DEFAULT_CALENDAR } from './calendar';
import { prepareOps } from './change';
import {
  filterRecords,
  formatRef,
  recordDay,
  recordValue,
  sortRecords,
  type DataRecord,
} from './data';
import { dayNumber } from './formula';
import type { Op } from './ops';
import { planNotifications } from './reminders';
import type { Collection, Reminder } from './schema';
import { dayValue, readRecords } from './source';
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

// 算出来的日期能放进月历、当「到期前提醒」的日期（D-550）：都是现算，不存。
describe('a computed date drives calendars and "before" reminders (D-550)', () => {
  const ctx = { registry, locale: 'en' as const, now };
  const calendarPage: Op = {
    op: 'addContainer',
    page: {
      id: 'renewals',
      title: 'Renewals',
      blocks: [
        {
          id: 'month',
          look: 'calendar',
          source: { table: 'contracts', group: { by: 'ends', unit: 'day' } },
          show: { title: 'name' },
        },
      ],
    },
  } as never;
  const expiring: Reminder = {
    id: 'expiring',
    kind: 'reminder',
    title: 'A contract ends soon',
    enabled: true,
    when: { before: { table: 'contracts', field: 'ends' }, days: 30, at: '09:00' },
    opens: 'page:home',
  };
  const setup = (ops: Op[]) => {
    const r = prepareOps(workspace('en'), [{ op: 'addData', table: contracts }, ...ops], ctx);
    if (!r.ok) throw new Error(r.issues.join('; '));
    return r.after;
  };

  it('a calendar can group by it and shows each entry on its computed day', () => {
    const config = setup([calendarPage]);
    const records = [
      rec('a', { name: 'Gym', start: '2026-08-14', term: 4 }),
      rec('b', { name: 'Phone', start: '2025-12-31', term: 11 }),
      rec('c', { name: 'No term', start: '2026-12-01' }),
    ];
    const read = readRecords(
      {
        look: 'calendar',
        source: { table: 'contracts', limit: 30, group: { by: 'ends', unit: 'day' } },
      },
      { config, records: new Map([['contracts', records]]), now, locale: 'en' },
      { month: '2026-11' },
    )!;
    const ids = (d: string) => read.days!.days.get(dayNumber(d)!)?.records.map((r) => r.id);
    expect(ids('2026-11-30')).toEqual(['b']);
    expect(read.days!.days.size).toBe(1);
    const december = readRecords(
      {
        look: 'calendar',
        source: { table: 'contracts', limit: 30, group: { by: 'ends', unit: 'day' } },
      },
      { config, records: new Map([['contracts', records]]), now, locale: 'en' },
      { month: '2026-12' },
    )!;
    expect([...december.days!.days.values()].map((d) => d.records.map((r) => r.id))).toEqual([
      ['a'],
    ]);
    // 点某一天添加时不预设它（算出来的，不能填）；看月历不写任何东西（底线 14、15）。
    expect(dayValue(read, dayNumber('2026-11-30')!)).toBeUndefined();
    expect(records.every((r) => !('ends' in r.values))).toBe(true);
  });

  it('a "before" reminder can watch it and fires that many days before the computed day', () => {
    const config = setup([{ op: 'addTool', tool: expiring }]);
    const records = [
      rec('a', { name: 'Gym', start: '2026-08-14', term: 4 }), // 2026-12-14 → 11-14 09:00，已过
      rec('b', { name: 'Phone', start: '2026-01-15', term: 11 }), // 2026-12-15 → 11-15 09:00
      rec('c', { name: 'No term', start: '2026-12-01' }),
    ];
    const plan = (c = config, list = records) =>
      planNotifications(c, new Map([['contracts', list]]), now, 'en').map((n) => [
        n.id,
        new Date((n.trigger as { at: number }).at).toString(),
      ]);
    expect(plan()).toEqual([['expiring-b', new Date(2026, 10, 15, 9, 0).toString()]]);
    // 改了开始日期：重新排时跟着变。
    expect(plan(config, [rec('b', { start: '2026-02-20', term: 11 })])).toEqual([
      ['expiring-b', new Date(2026, 11, 21, 9, 0).toString()],
    ]);
    // 改了字段的定义（加几个月）：也跟着变。
    const longer = prepareOps(
      config,
      [
        {
          op: 'updateData',
          table: 'contracts',
          field: 'ends',
          changes: { add: 12, unit: 'months' },
        } as never,
      ],
      ctx,
    );
    if (!longer.ok) throw new Error(longer.issues.join());
    expect(plan(longer.after, [rec('b', { start: '2026-01-15', term: 11 })])).toEqual([
      ['expiring-b', new Date(2026, 11, 16, 9, 0).toString()],
    ]);
  });

  it('falls on the same day whatever hour the day starts at (设置 → 日期, D-286)', () => {
    // 算出来的日期没有钟点：一天从 4 点开始时不该往前挪一天，不然筛选漏掉、月历放错格、提醒早一天。
    const late = { ...DEFAULT_CALENDAR, dayStartHour: 4 };
    const b = rec('b', { name: 'Phone', start: '2026-01-15', term: 11 });
    expect(recordDay(b, contracts, 'ends', now, late)).toBe('2026-12-15');
    expect(
      filterRecords([b], contracts, [{ field: 'ends', op: 'is', value: '2026-12-15' }], now, late),
    ).toHaveLength(1);
    const config = setup([{ op: 'addTool', tool: expiring }]);
    const lateConfig = { ...config, data: { ...config.data, calendar: { dayStartHour: 4 } } };
    expect(
      planNotifications(lateConfig, new Map([['contracts', [b]]]), now, 'en').map((n) =>
        new Date((n.trigger as { at: number }).at).toString(),
      ),
    ).toEqual([new Date(2026, 10, 15, 9, 0).toString()]);
  });
});

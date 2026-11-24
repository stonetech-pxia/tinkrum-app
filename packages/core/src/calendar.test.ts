import { describe, expect, it } from 'vitest';

import { splitOps } from './ai/kinds';
import { calendarOf, DEFAULT_CALENDAR, type Calendar } from './calendar';
import { prepareOps } from './change';
import { conditionProblems } from './conditions';
import { chartSeries } from './chart';
import { filterRecords, periodRange, prepareRecordValues, type DataRecord } from './data';
import { describeChange } from './describe';
import { migrateWorkspace } from './migrate';
import type { Collection } from './schema';
import { registry, v33Fixture, workspace } from './test-helpers';

// 2026-10-22 is Thursday.
const thursday = new Date(2026, 9, 22, 9, 0);
const sunday: Calendar = { ...DEFAULT_CALENDAR, weekStart: 'sunday' };
const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };

describe('future periods and "today" in comparisons (D-537)', () => {
  const c: Collection = {
    id: 'docs',
    name: 'Docs',
    fields: [
      { id: 'due', name: 'Due', type: 'date' },
      { id: 'at', name: 'At', type: 'datetime' },
    ],
  };
  const rec = (id: string, values: Record<string, unknown>): DataRecord => ({
    id,
    collectionId: 'docs',
    values,
    createdAt: 0,
    updatedAt: 0,
  });

  it('next 7 / 30 / 90 days start today', () => {
    expect(periodRange('next7days', thursday)).toEqual(['2026-10-22', '2026-10-28']);
    expect(periodRange('next30days', thursday)).toEqual(['2026-10-22', '2026-11-20']);
    expect(periodRange('next90days', thursday)).toEqual(['2026-10-22', '2027-01-19']);
    // When a day starts at 2 AM, 1:30 AM still counts as yesterday.
    expect(periodRange('next7days', new Date(2026, 9, 23, 1, 30), twoAm)).toEqual([
      '2026-10-22',
      '2026-10-28',
    ]);
  });

  it('gt / lt "today" compare with the logical today', () => {
    const records = [
      rec('past', { due: '2026-10-21', at: '2026-10-21T23:00' }),
      rec('today', { due: '2026-10-22', at: '2026-10-22T08:00' }),
      rec('future', { due: '2026-10-23', at: '2026-10-23T00:30' }),
      rec('empty', {}),
    ];
    const ids = (cond: { field: string; op: 'gt' | 'lt' }, now = thursday, cal?: Calendar) =>
      filterRecords(records, c, [{ ...cond, value: 'today' }], now, cal).map((r) => r.id);
    expect(ids({ field: 'due', op: 'lt' })).toEqual(['past']);
    expect(ids({ field: 'due', op: 'gt' })).toEqual(['future']);
    expect(ids({ field: 'at', op: 'lt' })).toEqual(['past']);
    // A day starting at 2 AM: for 2026-10-23 01:00, "today" is 10-22; 2026-10-23 00:30 counts as 10-22.
    expect(ids({ field: 'at', op: 'gt' }, new Date(2026, 9, 23, 1), twoAm)).toEqual([]);
  });

  it('validation accepts "today" on date fields only', () => {
    const cond = (field: string, op: 'gt' | 'lt', value: string | number) => [{ field, op, value }];
    expect(conditionProblems(cond('due', 'lt', 'today'), c)).toEqual([]);
    expect(conditionProblems(cond('createdAt', 'gt', 'today'), c)).toEqual([]);
  });
});

describe('new periods (D-285)', () => {
  it('last 14 / 90 / 365 days end today', () => {
    expect(periodRange('last14days', thursday)).toEqual(['2026-10-09', '2026-10-22']);
    expect(periodRange('last90days', thursday)).toEqual(['2026-07-25', '2026-10-22']);
    expect(periodRange('last365days', thursday)).toEqual(['2025-10-23', '2026-10-22']);
  });

  it('half months are the 1st–15th and the 16th–end of the month', () => {
    expect(periodRange('thisHalfMonth', thursday)).toEqual(['2026-10-16', '2026-10-31']);
    expect(periodRange('thisHalfMonth', new Date(2026, 1, 15, 23))).toEqual([
      '2026-02-01',
      '2026-02-15',
    ]);
    expect(periodRange('thisHalfMonth', new Date(2028, 1, 20))).toEqual([
      '2028-02-16',
      '2028-02-29',
    ]);
  });

  it('two-week periods count from the anchor date, before or after it', () => {
    const cal: Calendar = { ...DEFAULT_CALENDAR, twoWeekStart: '2026-10-12' };
    expect(periodRange('thisTwoWeeks', thursday, cal)).toEqual(['2026-10-12', '2026-10-25']);
    expect(periodRange('thisTwoWeeks', new Date(2026, 9, 26), cal)).toEqual([
      '2026-10-26',
      '2026-11-08',
    ]);
    expect(periodRange('thisTwoWeeks', new Date(2026, 9, 11), cal)).toEqual([
      '2026-09-28',
      '2026-10-11',
    ]);
  });

  it('without an anchor, two-week periods start on a week start', () => {
    const [start] = periodRange('thisTwoWeeks', thursday);
    expect(new Date(`${start}T12:00:00`).getDay()).toBe(1);
    const [sundayStart, end] = periodRange('thisTwoWeeks', thursday, sunday);
    expect(new Date(`${sundayStart}T12:00:00`).getDay()).toBe(0);
    expect(sundayStart <= '2026-10-22' && end >= '2026-10-22').toBe(true);
  });
});

describe('when a day and a week start (D-286)', () => {
  it('weeks start on Monday by default, or on Sunday', () => {
    expect(periodRange('thisWeek', thursday)).toEqual(['2026-10-19', '2026-10-25']);
    expect(periodRange('thisWeek', thursday, sunday)).toEqual(['2026-10-18', '2026-10-24']);
    // Sunday itself: treated as the last day of the week when the week starts on Monday, or the first day of a new week when the week starts on Sunday.
    const sun = new Date(2026, 9, 25, 10);
    expect(periodRange('thisWeek', sun)).toEqual(['2026-10-19', '2026-10-25']);
    expect(periodRange('thisWeek', sun, sunday)).toEqual(['2026-10-25', '2026-10-31']);
  });

  it('before the day start hour it is still yesterday', () => {
    const lateNight = new Date(2026, 9, 23, 1, 30);
    expect(periodRange('today', lateNight)).toEqual(['2026-10-23', '2026-10-23']);
    expect(periodRange('today', lateNight, twoAm)).toEqual(['2026-10-22', '2026-10-22']);
    // 1:00 AM on the first day of the month: still in the previous month.
    expect(periodRange('thisMonth', new Date(2026, 10, 1, 1), twoAm)).toEqual([
      '2026-10-01',
      '2026-10-31',
    ]);
  });

  it('a new entry made at 1:30 gets yesterday as its default date', () => {
    const c: Collection = {
      id: 'log',
      name: 'Log',
      fields: [{ id: 'date', name: 'Date', type: 'date', default: 'today' }],
    };
    const lateNight = new Date(2026, 9, 23, 1, 30);
    expect(prepareRecordValues(c, {}, null, lateNight)).toEqual({
      ok: true,
      values: { date: '2026-10-23' },
    });
    expect(prepareRecordValues(c, {}, null, lateNight, twoAm)).toEqual({
      ok: true,
      values: { date: '2026-10-22' },
    });
  });

  it('created-at filters use the logical day', () => {
    const c: Collection = {
      id: 'log',
      name: 'Log',
      fields: [{ id: 'n', name: 'N', type: 'number' }],
    };
    const rec = (d: Date): DataRecord => ({
      id: String(d.getTime()),
      collectionId: 'log',
      values: {},
      createdAt: d.getTime(),
      updatedAt: d.getTime(),
    });
    const records = [rec(new Date(2026, 9, 22, 1)), rec(new Date(2026, 9, 22, 8))];
    const today = [{ field: 'createdAt', op: 'inPeriod' as const, value: 'today' }];
    expect(filterRecords(records, c, today, thursday)).toHaveLength(2);
    expect(filterRecords(records, c, today, thursday, twoAm)).toHaveLength(1);
  });

  it('chart weeks follow the week start; distinct days per week', () => {
    const c: Collection = {
      id: 'log',
      name: 'Log',
      fields: [{ id: 'date', name: 'Date', type: 'date' }],
    };
    const rec = (date: string): DataRecord => ({
      id: date + Math.random(),
      collectionId: 'log',
      values: { date },
      createdAt: 0,
      updatedAt: 0,
    });
    const records = ['2026-10-18', '2026-10-19', '2026-10-19', '2026-10-21'].map(rec);
    const spec = { aggregate: 'distinctDays' as const, group: { unit: 'week' as const, last: 2 } };
    expect(chartSeries(records, c, spec, thursday, '-').map((p) => [p.key, p.value])).toEqual([
      ['2026-10-12', 1],
      ['2026-10-19', 2],
    ]);
    expect(
      chartSeries(records, c, spec, thursday, '-', sunday).map((p) => [p.key, p.value]),
    ).toEqual([
      ['2026-10-11', 0],
      ['2026-10-18', 3],
    ]);
  });
});

describe('calendar settings in the config (D-286)', () => {
  const ctx = { registry, locale: 'zh' as const, now: thursday };

  it('defaults to midnight and Monday', () => {
    expect(calendarOf(workspace())).toEqual(DEFAULT_CALENDAR);
  });

  it('updateData {calendar} changes only the given settings; null goes back to the default', () => {
    const set = prepareOps(
      workspace(),
      [{ op: 'updateData', calendar: { dayStartHour: 2, weekStart: 'sunday' } }],
      ctx,
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(calendarOf(set.after)).toEqual({ dayStartHour: 2, weekStart: 'sunday' });
    const reset = prepareOps(
      set.after,
      [{ op: 'updateData', calendar: { dayStartHour: null } }],
      ctx,
    );
    expect(reset.ok && calendarOf(reset.after)).toEqual({ dayStartHour: 0, weekStart: 'sunday' });
    expect(
      describeChange([{ op: 'updateData', calendar: { weekStart: 'sunday' } }], set.after, [], ctx),
    ).toEqual(['一周从周日开始']);
  });

  it('rejects a day start after 6 am and a bad anchor date', () => {
    expect(
      prepareOps(workspace(), [{ op: 'updateData', calendar: { dayStartHour: 7 } }], ctx).ok,
    ).toBe(false);
    expect(
      prepareOps(workspace(), [{ op: 'updateData', calendar: { twoWeekStart: '2026-02-30' } }], ctx)
        .ok,
    ).toBe(false);
  });

  it('is a function change (applied at once, can be undone)', () => {
    expect(
      splitOps([{ op: 'updateData', calendar: { weekStart: 'sunday' } }]).function,
    ).toHaveLength(1);
  });

  it('v19 → v20 only raises the version', () => {
    // Shape of an old version (default configuration saved in v33), not v34.
    const previous = { ...v33Fixture('default-en'), schemaVersion: 19 };
    expect(migrateWorkspace(previous, undefined, 20)).toEqual({
      ok: true,
      config: { ...previous, schemaVersion: 20 },
      fromVersion: 19,
    });
  });
});

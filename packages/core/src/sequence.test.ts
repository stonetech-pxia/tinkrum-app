import { describe, expect, it } from 'vitest';

import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { prepareOps } from './change';
import { matchesCondition, type DataRecord } from './data';
import { createDefaultWorkspace } from './defaults';
import type { Collection, NewComponent } from './schema';
import {
  avgInterval,
  dateFieldOf,
  daysSince,
  distinctDays,
  sequenceValue,
  streakOf,
  type StreakRule,
} from './sequence';
import { registry } from './test-helpers';

// Sequential aggregates (D-284) and day/week start times (D-286). Daylight saving time test cases are calculated in Paris time.
process.env.TZ = 'Europe/Paris';

const log: Collection = {
  id: 'log',
  name: 'Log',
  fields: [
    {
      id: 'habit',
      name: 'Habit',
      type: 'choice',
      options: [
        { id: 'run', label: 'Run' },
        { id: 'read', label: 'Read' },
      ],
    },
    {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'done', label: 'Done' },
        { id: 'skip', label: 'Skip' },
      ],
    },
    { id: 'date', name: 'Date', type: 'date', default: 'today' },
  ],
};

let seq = 0;
const on = (date: string, status = 'done'): DataRecord => ({
  id: `r${++seq}`,
  collectionId: 'log',
  values: { date, status },
  createdAt: 0,
  updatedAt: 0,
});
const at = (createdAt: Date): DataRecord => ({
  id: `r${++seq}`,
  collectionId: 'log',
  values: {},
  createdAt: createdAt.getTime(),
  updatedAt: createdAt.getTime(),
});

const daily: StreakRule = { unit: 'day', perUnit: 1 };
const ctx = (now: Date, dateField = 'date', cal: Calendar = DEFAULT_CALENDAR) => ({
  dateField,
  now,
  cal,
});
const thursday = new Date(2026, 9, 22, 9, 0); // 2026-10-22 Thursday

describe('streakOf (D-284)', () => {
  it('empty table: no streak', () => {
    expect(streakOf([], log, daily, ctx(thursday))).toEqual({ current: 0, best: 0 });
  });

  it('counts back from today; today not logged yet does not break it', () => {
    const records = ['2026-10-19', '2026-10-20', '2026-10-21'].map((d) => on(d));
    expect(streakOf(records, log, daily, ctx(thursday))).toEqual({ current: 3, best: 3 });
    expect(streakOf([...records, on('2026-10-22')], log, daily, ctx(thursday))).toEqual({
      current: 4,
      best: 4,
    });
    // Streak breaks only if nothing is logged by the next day.
    expect(streakOf(records, log, daily, ctx(new Date(2026, 9, 23, 9)))).toEqual({
      current: 0,
      best: 3,
    });
  });

  it('keeps the best streak after a break; several entries on one day count once', () => {
    const records = [
      ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((d) => on(d)),
      on('2026-10-20'),
      on('2026-10-21'),
      on('2026-10-21'),
    ];
    expect(streakOf(records, log, daily, ctx(thursday))).toEqual({ current: 2, best: 4 });
  });

  it('runs across a month and a year end', () => {
    const month = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((d) => on(d));
    expect(streakOf(month, log, daily, ctx(new Date(2026, 9, 2, 20)))).toEqual({
      current: 4,
      best: 4,
    });
    const year = ['2026-12-30', '2026-12-31', '2027-01-01'].map((d) => on(d));
    expect(streakOf(year, log, daily, ctx(new Date(2027, 0, 2, 8)))).toEqual({
      current: 3,
      best: 3,
    });
  });

  it('a skipped day neither breaks nor adds', () => {
    const records = [on('2026-10-19'), on('2026-10-20', 'skip'), on('2026-10-21')];
    const rule: StreakRule = { ...daily, skip: { field: 'status', option: 'skip' } };
    expect(streakOf(records, log, rule, ctx(thursday))).toEqual({ current: 2, best: 2 });
    // When no skip is set, the "skip" entry is also counted as a log entry.
    expect(streakOf(records, log, daily, ctx(thursday))).toEqual({ current: 3, best: 3 });
    // Today marked as skipped: neither breaks nor increments the streak.
    expect(streakOf([...records, on('2026-10-22', 'skip')], log, rule, ctx(thursday))).toEqual({
      current: 2,
      best: 2,
    });
  });

  it('weekly goal: at least 3 entries a week; this week is not over yet', () => {
    const rule: StreakRule = { unit: 'week', perUnit: 3 };
    const records = [
      // 3 times in the week of 09-28, 3 times in the week of 10-05, 2 times in the week of 10-12 (target not met, streak breaks), 1 time this week (starting 10-19).
      ...['2026-09-28', '2026-09-30', '2026-10-02'].map((d) => on(d)),
      ...['2026-10-05', '2026-10-06', '2026-10-08'].map((d) => on(d)),
      ...['2026-10-13', '2026-10-15'].map((d) => on(d)),
      on('2026-10-20'),
    ];
    // Only 1 time this week, which is not yet finished: current 0 (previous week target not met), best 2.
    expect(streakOf(records, log, rule, ctx(thursday))).toEqual({ current: 0, best: 2 });
    const more = [...records, on('2026-10-13'), on('2026-10-21'), on('2026-10-22')];
    expect(streakOf(more, log, rule, ctx(thursday))).toEqual({ current: 4, best: 4 });
  });

  it('weeks can start on Sunday', () => {
    const rule: StreakRule = { unit: 'week', perUnit: 1 };
    const sunday: Calendar = { ...DEFAULT_CALENDAR, weekStart: 'sunday' };
    const records = [on('2026-10-04'), on('2026-10-17'), on('2026-10-18')];
    // Starting Monday: 10-04 is in the 09-28 week, 10-17 and 10-18 are both in the 10-12 week, nothing logged yet this week (10-19).
    expect(streakOf(records, log, rule, ctx(thursday))).toEqual({ current: 1, best: 1 });
    // Starting Sunday: 10-04 week, 10-11 week (10-17), 10-18 week (the current week): 3 consecutive weeks.
    expect(streakOf(records, log, rule, ctx(thursday, 'date', sunday))).toEqual({
      current: 3,
      best: 3,
    });
  });

  it('monthly streaks', () => {
    const rule: StreakRule = { unit: 'month', perUnit: 2 };
    const records = ['2026-08-01', '2026-08-31', '2026-09-10', '2026-09-11', '2026-10-01'].map(
      (d) => on(d),
    );
    expect(streakOf(records, log, rule, ctx(thursday))).toEqual({ current: 2, best: 2 });
  });

  it('a day can start at 2 am: an entry made at 1:30 belongs to the day before', () => {
    const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };
    const records = [
      at(new Date(2026, 9, 20, 23, 0)),
      at(new Date(2026, 9, 22, 1, 30)), // Counted as 10-21
    ];
    // Current time is 10-22 1:45 AM: still counts as 10-21.
    const lateNight = new Date(2026, 9, 22, 1, 45);
    expect(streakOf(records, log, daily, ctx(lateNight, 'createdAt', twoAm))).toEqual({
      current: 2,
      best: 2,
    });
    // When a day starts at 0:00, the 1:30 entry counts as 10-22, breaking the 10-21 streak in between.
    expect(streakOf(records, log, daily, ctx(lateNight, 'createdAt'))).toEqual({
      current: 1,
      best: 1,
    });
  });

  it('daylight saving time changes do not add or lose a day', () => {
    // Paris transitions forward 1 hour at 2:00 AM on 2026-03-29, and back 1 hour at 3:00 AM on 2026-10-25.
    const spring = ['2026-03-28', '2026-03-29', '2026-03-30'].map((d) => new Date(`${d}T21:00:00`));
    expect(
      streakOf(spring.map(at), log, daily, ctx(new Date(2026, 2, 30, 22), 'createdAt')),
    ).toEqual({ current: 3, best: 3 });
    const autumn = [
      new Date(2026, 9, 24, 23, 30),
      new Date(2026, 9, 25, 2, 30), // Counted as 10-24 when a day starts at 3:00 AM
      new Date(2026, 9, 26, 3, 30),
    ];
    const threeAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 3 };
    expect(
      streakOf(autumn.map(at), log, daily, ctx(new Date(2026, 9, 26, 9), 'createdAt', threeAm)),
    ).toEqual({ current: 1, best: 1 });
    expect(
      streakOf(autumn.map(at), log, daily, ctx(new Date(2026, 9, 26, 9), 'createdAt')),
    ).toEqual({ current: 3, best: 3 });
  });

  it('ignores entries without a date and entries in the future', () => {
    const records = [on('2026-10-21'), on('2026-10-30'), { ...on('x'), values: {} }];
    expect(streakOf(records, log, daily, ctx(thursday))).toEqual({ current: 1, best: 1 });
  });
});

describe('daysSince, avgInterval, distinctDays (D-284)', () => {
  it('empty table', () => {
    expect(daysSince([], log, ctx(thursday))).toBeNull();
    expect(avgInterval([], log, ctx(thursday))).toBeNull();
    expect(distinctDays([], log, ctx(thursday))).toBe(0);
  });

  it('days since the latest entry up to today', () => {
    const records = [on('2026-10-01'), on('2026-10-19'), on('2026-11-30')];
    expect(daysSince(records, log, ctx(thursday))).toBe(3);
    expect(daysSince([...records, on('2026-10-22')], log, ctx(thursday))).toBe(0);
  });

  it('average gap between entry days (a period-tracker cycle)', () => {
    const records = [on('2026-07-01'), on('2026-07-29'), on('2026-08-27'), on('2026-08-27')];
    // 28 days and 29 days.
    expect(avgInterval(records, log, ctx(thursday))).toBe(28.5);
    expect(avgInterval([on('2026-07-01')], log, ctx(thursday))).toBeNull();
  });

  it('counts days with at least one entry, by the logical day', () => {
    const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };
    const records = [at(new Date(2026, 9, 20, 22)), at(new Date(2026, 9, 21, 1))];
    expect(distinctDays(records, log, ctx(thursday, 'createdAt'))).toBe(2);
    expect(distinctDays(records, log, ctx(thursday, 'createdAt', twoAm))).toBe(1);
  });
});

describe('number and chart with these aggregates (D-284)', () => {
  const changeCtx = { registry, locale: 'en' as const, now: thursday };
  const add = (block: NewComponent) =>
    prepareOps(
      createDefaultWorkspace('en'),
      [
        { op: 'addData', table: log },
        { op: 'addContainer', page: 'home', block },
      ],
      changeCtx,
    );
  const number = (source: Record<string, unknown>): NewComponent =>
    ({
      id: 's',
      look: 'number',
      show: { label: 'Streak' },
      source: { table: 'log', ...source },
    }) as NewComponent;
  const problems = (block: NewComponent) => {
    const result = add(block);
    return result.ok ? [] : result.issues;
  };

  it('a streak per habit, with a skip option', () => {
    expect(
      problems(
        number({
          aggregate: 'streak',
          days: { unit: 'week', perUnit: 3, skip: { field: 'status', option: 'skip' } },
          group: { by: 'habit' },
        }),
      ),
    ).toEqual([]);
    expect(problems(number({ aggregate: 'daysSince', days: { date: 'createdAt' } }))).toEqual([]);
  });

  it('explains what is wrong', () => {
    expect(String(problems(number({ aggregate: 'sum', days: { unit: 'week' } })))).toMatch(
      /only apply to aggregate "streak"/,
    );
    expect(
      String(
        problems(
          number({ aggregate: 'streak', days: { skip: { field: 'status', option: 'nope' } } }),
        ),
      ),
    ).toMatch(/days.skip.option must be an option id of status/);
    // Skip field and options defined together (structurally a single block).
    expect(
      problems(number({ aggregate: 'streak', days: { skip: { field: 'habit' } } })),
    ).not.toEqual([]);
    expect(String(problems(number({ aggregate: 'avgInterval', days: { date: 'habit' } })))).toMatch(
      /date/,
    );
  });

  it('a chart can count days with entries, but cannot draw a streak', () => {
    const chart = (aggregate: string): NewComponent =>
      ({
        id: 'c',
        look: 'chart',
        show: { kind: 'bar', title: 'Days' },
        source: { table: 'log', aggregate, group: { unit: 'week' } },
      }) as NewComponent;
    expect(problems(chart('distinctDays'))).toEqual([]);
    expect(problems(chart('streak'))).not.toEqual([]);
  });

  it('number values', () => {
    const records = ['2026-10-20', '2026-10-21'].map((d) => on(d));
    expect(sequenceValue(records, log, 'streak', { unit: 'day' }, thursday)).toEqual({
      value: 2,
      best: 2,
    });
    expect(sequenceValue(records, log, 'daysSince', undefined, thursday)).toEqual({ value: 1 });
  });

  it('days.date picks the date; without it the first date field, then createdAt', () => {
    expect(dateFieldOf(log, undefined)).toBe('date');
    expect(dateFieldOf(log, 'createdAt')).toBe('createdAt');
    expect(dateFieldOf({ ...log, fields: [] }, undefined)).toBe('createdAt');
    const created = [at(new Date(2026, 9, 21, 12))];
    expect(sequenceValue(created, log, 'daysSince', { date: 'createdAt' }, thursday)).toEqual({
      value: 1,
    });
    expect(sequenceValue(created, log, 'daysSince', undefined, thursday)).toEqual({
      value: null,
    });
  });
});

describe('datetime fields with a day that starts later (D-279 + D-286)', () => {
  const shifts: Collection = {
    id: 'log',
    name: 'Log',
    fields: [{ id: 'when', name: 'When', type: 'datetime' }],
  };
  const when = (v: string): DataRecord => ({
    id: `r${++seq}`,
    collectionId: 'log',
    values: { when: v },
    createdAt: 0,
    updatedAt: 0,
  });
  const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };
  const records = [when('2026-10-20T23:00'), when('2026-10-22T01:30')];

  it('a 1:30 entry counts for the day before when the day starts at 2', () => {
    expect(streakOf(records, shifts, daily, ctx(thursday, 'when', twoAm))).toEqual({
      current: 2,
      best: 2,
    });
    expect(streakOf(records, shifts, daily, ctx(thursday, 'when'))).toEqual({
      current: 1,
      best: 1,
    });
  });

  it('filters by the shifted day too', () => {
    const night = new Date(2026, 9, 22, 1, 0);
    const today = { field: 'when', op: 'inPeriod' as const, value: 'today' };
    expect(matchesCondition(when('2026-10-21T23:00'), shifts, today, night, twoAm)).toBe(true);
    expect(matchesCondition(when('2026-10-21T23:00'), shifts, today, night)).toBe(false);
  });
});

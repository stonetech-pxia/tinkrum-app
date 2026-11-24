import { describe, expect, it } from 'vitest';

import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { prepareOps } from './change';
import {
  filterRecords,
  formatRef,
  prepareRecordValues,
  recordValue,
  sortRecords,
  type DataRecord,
} from './data';
import { createDefaultWorkspace } from './defaults';
import { dayNumber } from './formula';
import {
  readSchedule,
  scheduleOccurrences,
  scheduleStatus,
  scheduleText,
  type ScheduleRule,
} from './schedule';
import type { Collection, NewComponent } from './schema';
import { registry } from './test-helpers';

// Schedules (D-292–D-296). Daylight saving time test cases are calculated in Paris time.
process.env.TZ = 'Europe/Paris';

const d = (s: string) => dayNumber(s)!;
const date = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const sunday: Calendar = { ...DEFAULT_CALENDAR, weekStart: 'sunday' };

/** The rule's "next occurrence" date on today, whether it is due today, and how many days overdue. */
function status(rule: ScheduleRule, done: string[], today: string, cal = DEFAULT_CALENDAR) {
  const s = scheduleStatus(rule, done.map(d), d(today), cal);
  return {
    next: s.next === undefined ? undefined : date(s.next),
    due: s.dueToday,
    overdue: s.overdueDays,
  };
}

describe('schedule rules without a last-done source', () => {
  // 2026-10-22 is Thursday.
  it('every day is due today', () => {
    expect(status({ repeat: 'daily' }, [], '2026-10-22')).toEqual({
      next: '2026-10-22',
      due: true,
      overdue: 0,
    });
  });

  it('fixed weekdays find the next matching day', () => {
    const mwf: ScheduleRule = { repeat: 'weekdays', days: [1, 3, 5] };
    expect(status(mwf, [], '2026-10-22')).toEqual({ next: '2026-10-23', due: false, overdue: 0 });
    expect(status(mwf, [], '2026-10-23').due).toBe(true);
    // Saturday → next Monday.
    expect(status(mwf, [], '2026-10-24').next).toBe('2026-10-26');
    // Sunday (7).
    expect(status({ repeat: 'weekdays', days: [7] }, [], '2026-10-22').next).toBe('2026-10-25');
  });

  it('day 31 falls on the last day of shorter months, February and leap years included', () => {
    const on31: ScheduleRule = { repeat: 'monthDays', days: [31] };
    expect(status(on31, [], '2026-02-10').next).toBe('2026-02-28');
    expect(status(on31, [], '2028-02-10').next).toBe('2028-02-29');
    expect(status(on31, [], '2026-04-05').next).toBe('2026-04-30');
    expect(status(on31, [], '2026-05-01').next).toBe('2026-05-31');
    // Day 30 in February lands on the last day of the month.
    expect(status({ repeat: 'monthDays', days: [30] }, [], '2026-02-01').next).toBe('2026-02-28');
  });

  it('the last day of the month (-1) and several days of the month', () => {
    const last: ScheduleRule = { repeat: 'monthDays', days: [-1] };
    expect(status(last, [], '2026-04-30')).toEqual({ next: '2026-04-30', due: true, overdue: 0 });
    expect(status(last, [], '2026-12-31').due).toBe(true);
    expect(status(last, [], '2027-01-01').next).toBe('2027-01-31');
    const twice: ScheduleRule = { repeat: 'monthDays', days: [1, 15] };
    expect(status(twice, [], '2026-10-16').next).toBe('2026-11-01');
    expect(status(twice, [], '2026-12-20').next).toBe('2027-01-01');
  });

  it('a yearly day on 29 February falls on the 28th in other years', () => {
    const leap: ScheduleRule = { repeat: 'yearly', month: 2, day: 29 };
    expect(status(leap, [], '2026-03-01').next).toBe('2027-02-28');
    expect(status(leap, [], '2027-03-01').next).toBe('2028-02-29');
    const birthday: ScheduleRule = { repeat: 'yearly', month: 12, day: 25 };
    expect(status(birthday, [], '2026-12-25').due).toBe(true);
    expect(status(birthday, [], '2026-12-26').next).toBe('2027-12-25');
  });

  it('every N days and N times a period are due today when nothing was done yet', () => {
    expect(status({ repeat: 'interval', every: 7 }, [], '2026-10-22')).toEqual({
      next: '2026-10-22',
      due: true,
      overdue: 0,
    });
    expect(status({ repeat: 'times', per: 'week', count: 3 }, [], '2026-10-22').due).toBe(true);
  });
});

describe('schedule rules with the days it was done', () => {
  it('every N days counts from the last time', () => {
    const weekly: ScheduleRule = { repeat: 'interval', every: 7 };
    expect(status(weekly, ['2026-10-15'], '2026-10-22')).toEqual({
      next: '2026-10-22',
      due: true,
      overdue: 0,
    });
    expect(status(weekly, ['2026-10-10'], '2026-10-22')).toEqual({
      next: '2026-10-17',
      due: true,
      overdue: 5,
    });
    expect(status(weekly, ['2026-10-01', '2026-10-20'], '2026-10-22')).toEqual({
      next: '2026-10-27',
      due: false,
      overdue: 0,
    });
    // Cross-month and cross-year.
    expect(status({ repeat: 'interval', every: 60 }, ['2026-12-15'], '2026-12-20').next).toBe(
      '2027-02-13',
    );
    // Dates after today are ignored (e.g., incorrectly entered dates).
    expect(status(weekly, ['2026-10-15', '2026-11-30'], '2026-10-22').next).toBe('2026-10-22');
  });

  it('fixed days are overdue from the first one missed after the last time', () => {
    const daily: ScheduleRule = { repeat: 'daily' };
    expect(status(daily, ['2026-10-22'], '2026-10-22')).toEqual({
      next: '2026-10-23',
      due: false,
      overdue: 0,
    });
    expect(status(daily, ['2026-10-19'], '2026-10-22')).toEqual({
      next: '2026-10-20',
      due: true,
      overdue: 2,
    });
    const mwf: ScheduleRule = { repeat: 'weekdays', days: [1, 3, 5] };
    expect(status(mwf, ['2026-10-19'], '2026-10-22')).toEqual({
      next: '2026-10-21',
      due: true,
      overdue: 1,
    });
    // Subscription billed on the 31st of every month, last time January 31 → February 28 (rolls over to end of month).
    expect(status({ repeat: 'monthDays', days: [31] }, ['2026-01-31'], '2026-02-01').next).toBe(
      '2026-02-28',
    );
  });

  it('3 times a week with 2 done this week is still due today', () => {
    const three: ScheduleRule = { repeat: 'times', per: 'week', count: 3 };
    // 2026-10-19 is a Monday.
    expect(status(three, ['2026-10-19', '2026-10-20'], '2026-10-22')).toEqual({
      next: '2026-10-22',
      due: true,
      overdue: 0,
    });
    // Done today → tomorrow.
    expect(status(three, ['2026-10-19', '2026-10-22'], '2026-10-22').next).toBe('2026-10-23');
    // Completed 3 times → next Monday.
    expect(status(three, ['2026-10-19', '2026-10-20', '2026-10-21'], '2026-10-22')).toEqual({
      next: '2026-10-26',
      due: false,
      overdue: 0,
    });
    // Done last week does not count for this week.
    expect(status(three, ['2026-10-14', '2026-10-15', '2026-10-16'], '2026-10-22').due).toBe(true);
    // Doing it twice on the same day counts as only one day.
    expect(status(three, ['2026-10-19', '2026-10-19', '2026-10-19'], '2026-10-22').due).toBe(true);
  });

  it('a week starting on Sunday changes which days count as this week', () => {
    const three: ScheduleRule = { repeat: 'times', per: 'week', count: 3 };
    const done = ['2026-10-19', '2026-10-20', '2026-10-21'];
    // 2026-10-25 is a Sunday: the week starting Monday already has enough completions, while the week starting Sunday has just begun.
    expect(status(three, done, '2026-10-25').next).toBe('2026-10-26');
    expect(status(three, done, '2026-10-25', sunday).due).toBe(true);
    // Enough completions in the week starting Sunday → next Sunday.
    expect(status(three, done, '2026-10-22', sunday).next).toBe('2026-10-25');
  });

  it('two weeks, a month and a year as the period', () => {
    const month: ScheduleRule = { repeat: 'times', per: 'month', count: 2 };
    expect(status(month, ['2026-10-01', '2026-10-09'], '2026-10-22').next).toBe('2026-11-01');
    expect(status(month, ['2026-09-30'], '2026-10-01').due).toBe(true);
    const year: ScheduleRule = { repeat: 'times', per: 'year', count: 1 };
    expect(status(year, ['2026-03-01'], '2026-10-22').next).toBe('2027-01-01');
    const twoWeeks: ScheduleRule = { repeat: 'times', per: 'twoWeeks', count: 1 };
    const cal: Calendar = { ...DEFAULT_CALENDAR, twoWeekStart: '2026-10-12' };
    expect(status(twoWeeks, ['2026-10-13'], '2026-10-22', cal).next).toBe('2026-10-26');
    // Do on the last day of the month: done today, tomorrow is next month.
    expect(
      status({ repeat: 'times', per: 'month', count: 5 }, ['2026-10-31'], '2026-10-31').next,
    ).toBe('2026-11-01');
  });

  it('several times a day: due until done that many times', () => {
    const twice: ScheduleRule = { repeat: 'daily', perDay: 2 };
    expect(status(twice, ['2026-10-22'], '2026-10-22')).toEqual({
      next: '2026-10-22',
      due: true,
      overdue: 0,
    });
    expect(status(twice, ['2026-10-22', '2026-10-22'], '2026-10-22').next).toBe('2026-10-23');
  });
});

describe('reading and writing a schedule', () => {
  it('reads leniently: sorts and dedupes days, drops what does not fit', () => {
    expect(readSchedule({ repeat: 'weekdays', days: [5, 1, 3, 1] })).toEqual({
      repeat: 'weekdays',
      days: [1, 3, 5],
    });
    expect(readSchedule({ repeat: 'monthDays', days: [-1, 15, 1] })).toEqual({
      repeat: 'monthDays',
      days: [1, 15, -1],
    });
    expect(readSchedule({ repeat: 'interval', every: 61 })).toBeUndefined();
    expect(readSchedule({ repeat: 'interval', every: 0 })).toBeUndefined();
    expect(readSchedule({ repeat: 'weekdays', days: [] })).toBeUndefined();
    expect(readSchedule({ repeat: 'weekdays', days: [8] })).toBeUndefined();
    expect(readSchedule({ repeat: 'yearly', month: 2, day: 30 })).toBeUndefined();
    expect(readSchedule({ repeat: 'times', per: 'week', count: 8 })).toBeUndefined();
    expect(readSchedule({ repeat: 'hourly' })).toBeUndefined();
    expect(readSchedule('FREQ=DAILY')).toBeUndefined();
    // Unrecognized properties are dropped rather than invalidating the entire entry (when restoring an old version).
    expect(readSchedule({ repeat: 'daily', color: 'red' })).toEqual({ repeat: 'daily' });
    // perDay 1 is the default and is not stored.
    expect(readSchedule({ repeat: 'daily', perDay: 1 })).toEqual({ repeat: 'daily' });
  });

  it('shows the rule as a sentence in each language', () => {
    const cases: [ScheduleRule, string, string, string][] = [
      [{ repeat: 'daily' }, '每天', 'Every day', 'Tous les jours'],
      [
        { repeat: 'weekdays', days: [1, 3, 5] },
        '每周一、周三、周五',
        'Every Mon, Wed, Fri',
        'Chaque semaine : lun., mer., ven.',
      ],
      [
        { repeat: 'times', per: 'week', count: 3 },
        '每周 3 次',
        '3 times a week',
        '3 fois par semaine',
      ],
      [
        { repeat: 'times', per: 'month', count: 1 },
        '每月 1 次',
        'Once a month',
        'Une fois par mois',
      ],
      [
        { repeat: 'monthDays', days: [1, 15, -1] },
        '每月 1 号、15 号、最后一天',
        'Monthly: day 1, day 15, last day',
        'Chaque mois : le 1, le 15, le dernier jour',
      ],
      [{ repeat: 'interval', every: 7 }, '每 7 天', 'Every 7 days', 'Tous les 7 jours'],
      [{ repeat: 'interval', every: 1 }, '每 1 天', 'Every day', 'Tous les jours'],
      [
        { repeat: 'yearly', month: 3, day: 5 },
        '每年 3月5日',
        'Every year on March 5',
        'Chaque année le 5 mars',
      ],
      [
        { repeat: 'daily', perDay: 3 },
        '每天，一天 3 次',
        'Every day, 3 times a day',
        'Tous les jours, 3 fois par jour',
      ],
    ];
    for (const [rule, zh, en, fr] of cases) {
      expect([
        scheduleText(rule, 'zh'),
        scheduleText(rule, 'en'),
        scheduleText(rule, 'fr'),
      ]).toEqual([zh, en, fr]);
    }
  });
});

// ---- Schedules on records: last completed date field from the same table ----

const plants: Collection = {
  id: 'plants',
  name: 'Plants',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    {
      id: 'plan',
      name: 'Watering',
      type: 'schedule',
      default: { repeat: 'interval', every: 7 },
      lastDone: 'watered',
    },
    { id: 'watered', name: 'Watered', type: 'date' },
    { id: 'left', name: 'Days left', type: 'formula', expression: 'days(today, {plan})' },
  ],
};

let seq = 0;
const plant = (name: string, values: Record<string, unknown>): DataRecord => ({
  id: `p${++seq}`,
  collectionId: 'plants',
  values: { name, plan: { repeat: 'interval', every: 7 }, ...values },
  createdAt: seq,
  updatedAt: seq,
});

const now = new Date(2026, 9, 22, 9, 0); // Thursday
const fern = plant('Fern', { watered: '2026-10-15' }); // Due to be watered today
const cactus = plant('Cactus', { plan: { repeat: 'interval', every: 30 }, watered: '2026-10-20' });
const ivy = plant('Ivy', { watered: '2026-10-10' }); // 5 days overdue
const palm = plant('Palm', { plan: { repeat: 'interval', every: 3 }, watered: '2026-10-21' }); // Saturday
const fresh = plant('Fresh', {}); // Never watered → today
const none = plant('None', { plan: undefined });
const all = [fern, cactus, ivy, palm, fresh, none];
const names = (rs: DataRecord[]) => rs.map((r) => r.values.name);

describe('schedules on records', () => {
  it('filters what is due today, overdue and due this week', () => {
    const due = (value: string, at = now, cal = DEFAULT_CALENDAR) =>
      names(filterRecords(all, plants, [{ field: 'plan', op: 'due', value }], at, cal));
    expect(due('today')).toEqual(['Fern', 'Ivy', 'Fresh']);
    expect(due('overdue')).toEqual(['Ivy']);
    expect(due('thisWeek')).toEqual(['Fern', 'Ivy', 'Palm', 'Fresh']);
    // Week starts on Sunday: Thursday → this week up to Saturday.
    expect(due('thisWeek', now, sunday)).toEqual(['Fern', 'Ivy', 'Palm', 'Fresh']);
    expect(due('thisWeek', new Date(2026, 9, 24, 9), sunday)).toEqual([
      'Fern',
      'Ivy',
      'Palm',
      'Fresh',
    ]);
    // In a week starting Sunday, "this week" on Sunday reaches through to next Saturday; Cactus on Nov 19 is not due yet.
    expect(due('thisWeek', new Date(2026, 9, 25, 9), sunday)).not.toContain('Cactus');
  });

  it('a day starting at 2 am: 1:30 is still the day before', () => {
    const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };
    const late = new Date(2026, 9, 23, 1, 30);
    const daily = { ...plants, fields: plants.fields.map((f) => f) };
    const fernTomorrow = plant('Late', { watered: '2026-10-16' }); // Due Oct 23
    expect(
      names(
        filterRecords(
          [fernTomorrow],
          daily,
          [{ field: 'plan', op: 'due', value: 'today' }],
          late,
          twoAm,
        ),
      ),
    ).toEqual([]);
    expect(
      names(
        filterRecords([fernTomorrow], daily, [{ field: 'plan', op: 'due', value: 'today' }], late),
      ),
    ).toEqual(['Late']);
  });

  it('a datetime last-done field done at 1:30 counts for the day before when a day starts at 2 am', () => {
    const twoAm: Calendar = { ...DEFAULT_CALENDAR, dayStartHour: 2 };
    const chores: Collection = {
      id: 'chores',
      name: 'Chores',
      fields: [
        { id: 'plan', name: 'Plan', type: 'schedule', lastDone: 'at' },
        { id: 'at', name: 'Done at', type: 'datetime' },
      ],
    };
    const r: DataRecord = {
      id: 'c1',
      collectionId: 'chores',
      values: { plan: { repeat: 'daily' }, at: '2026-10-23T01:30' },
      createdAt: 0,
      updatedAt: 0,
    };
    const at = new Date(2026, 9, 23, 10);
    const due = (cal: Calendar) =>
      filterRecords([r], chores, [{ field: 'plan', op: 'due', value: 'today' }], at, cal).length;
    // Starts at midnight: done today. Starts at 2 AM: 1:30 counts as the 22nd, and the 23rd is not done yet.
    expect(due(DEFAULT_CALENDAR)).toBe(0);
    expect(due(twoAm)).toBe(1);
  });

  it('the day the clocks change does not shift the next date', () => {
    // Paris switches to daylight saving time on 2026-03-29 and 2026-10-25.
    const spring = plant('Spring', {
      plan: { repeat: 'interval', every: 1 },
      watered: '2026-03-28',
    });
    const autumn = plant('Autumn', {
      plan: { repeat: 'interval', every: 1 },
      watered: '2026-10-24',
    });
    const today = (r: DataRecord, at: Date) =>
      filterRecords([r], plants, [{ field: 'plan', op: 'due', value: 'today' }], at).length;
    expect(today(spring, new Date(2026, 2, 29, 23, 30))).toBe(1);
    expect(today(spring, new Date(2026, 2, 29, 0, 30))).toBe(1);
    expect(today(autumn, new Date(2026, 9, 25, 23, 30))).toBe(1);
    expect(recordValue(autumn, plants, 'left', new Date(2026, 9, 25, 23, 30))).toBe(0);
  });

  it('sorts by the next date, entries without a schedule last', () => {
    const sorted = sortRecords(all, plants, { field: 'plan', direction: 'asc' }, now);
    // Same-day items are ordered by creation time from newest to oldest (Fresh is newer than Fern).
    expect(names(sorted)).toEqual(['Ivy', 'Fresh', 'Fern', 'Palm', 'Cactus', 'None']);
  });

  it('formulas read the next date, inPeriod and gt / lt use it too', () => {
    expect(recordValue(ivy, plants, 'left', now)).toBe(-5);
    expect(recordValue(palm, plants, 'left', now)).toBe(2);
    expect(recordValue(none, plants, 'left', now)).toBeUndefined();
    expect(
      names(
        filterRecords(all, plants, [{ field: 'plan', op: 'inPeriod', value: 'thisMonth' }], now),
      ),
    ).toEqual(['Fern', 'Ivy', 'Palm', 'Fresh']);
    expect(
      names(filterRecords(all, plants, [{ field: 'plan', op: 'gt', value: '2026-10-22' }], now)),
    ).toEqual(['Cactus', 'Palm']);
  });

  it('shows the rule and when it is next due', () => {
    expect(formatRef(fern, plants, 'plan', 'zh', undefined, now)).toBe('每 7 天 · 今天');
    expect(formatRef(ivy, plants, 'plan', 'en', undefined, now)).toBe(
      'Every 7 days · 5 days overdue',
    );
    expect(formatRef(palm, plants, 'plan', 'fr', undefined, now)).toBe(
      'Tous les 3 jours · Prochaine : 24 oct.',
    );
    expect(
      formatRef(plant('One', { watered: '2026-10-14' }), plants, 'plan', 'fr', undefined, now),
    ).toBe('Tous les 7 jours · En retard de 1 jour');
    expect(
      formatRef(plant('Tmw', { watered: '2026-10-16' }), plants, 'plan', 'en', undefined, now),
    ).toBe('Every 7 days · Tomorrow');
    expect(formatRef(none, plants, 'plan', 'en', undefined, now)).toBe('');
  });

  it('a new entry starts with the default rule; the form writes a rule', () => {
    const fresh = prepareRecordValues(plants, { name: 'New' }, null, now);
    expect(fresh).toEqual({
      ok: true,
      values: { name: 'New', plan: { repeat: 'interval', every: 7 } },
    });
    const bad = prepareRecordValues(plants, { plan: { repeat: 'interval', every: 99 } }, null, now);
    expect(bad).toEqual({ ok: false, issues: [{ fieldId: 'plan', code: 'invalid' }] });
    const cleared = prepareRecordValues(plants, { plan: '' }, { plan: { repeat: 'daily' } }, now);
    expect(cleared).toEqual({ ok: true, values: {} });
  });
});

describe('checking schedule fields and filters', () => {
  const problems = (ops: unknown[]) => {
    const r = prepareOps(createDefaultWorkspace('en'), [{ op: 'addData', table: plants }, ...ops], {
      registry,
      locale: 'en',
      now,
    });
    return r.ok ? [] : r.issues.map(String);
  };

  it('last done must be a date, datetime or rollup field of the same table', () => {
    const field = (lastDone: string) => ({
      op: 'addData',
      table: 'plants',
      field: { id: 'plan2', name: 'Plan 2', type: 'schedule', lastDone },
    });
    expect(problems([field('watered')])).toEqual([]);
    expect(problems([field('name')]).join()).toMatch(
      /lastDone name must be a date, datetime or rollup field/,
    );
    expect(problems([field('nope')]).join()).toMatch(/lastDone nope/);
  });

  it('the default rule follows the rule limits', () => {
    expect(
      problems([
        {
          op: 'addData',
          table: 'plants',
          field: {
            id: 'p3',
            name: 'P3',
            type: 'schedule',
            default: { repeat: 'interval', every: 90 },
          },
        },
      ]).length,
    ).toBeGreaterThan(0);
  });

  it('due needs a schedule field and one of today, overdue, thisWeek', () => {
    const list = (filter: unknown): NewComponent =>
      ({
        id: 'l',
        look: 'list',
        source: { table: 'plants', limit: 30, filter },
        show: { title: 'name' },
      }) as never;
    const add = (filter: unknown) => [{ op: 'addContainer', page: 'home', block: list(filter) }];
    expect(problems(add([{ field: 'plan', op: 'due', value: 'today' }]))).toEqual([]);
    expect(problems(add([{ field: 'plan', op: 'due', value: 'soon' }])).join()).toMatch(
      /today, overdue, thisWeek, pending/,
    );
    expect(problems(add([{ field: 'watered', op: 'due', value: 'today' }])).join()).toMatch(
      /due needs a schedule field/,
    );
  });
});

// D-340: "once"—do only once, can be without a date; ends after being done once.
describe('a once rule', () => {
  const once = (date?: string): ScheduleRule =>
    date ? { repeat: 'once', date } : { repeat: 'once' };

  it('is due on its date, overdue after it, and has no next date once done', () => {
    expect(status(once('2026-10-25'), [], '2026-10-22')).toEqual({
      next: '2026-10-25',
      due: false,
      overdue: 0,
    });
    expect(status(once('2026-10-20'), [], '2026-10-22')).toEqual({
      next: '2026-10-20',
      due: true,
      overdue: 2,
    });
    // Doing it early still counts as completed.
    const done = scheduleStatus(once('2026-10-25'), [d('2026-10-21')], d('2026-10-22'));
    expect(done).toEqual({ next: undefined, dueToday: false, overdueDays: 0, finished: true });
  });

  it('without a date it is never due, but still pending until done', () => {
    expect(status(once(), [], '2026-10-22')).toEqual({ next: undefined, due: false, overdue: 0 });
    expect(scheduleOccurrences(once(), [], d('2026-10-22'), 7)).toEqual([]);
    // Schedules once when a date is present; overdue items are scheduled for today.
    expect(scheduleOccurrences(once('2026-10-25'), [], d('2026-10-22'), 7)).toEqual([
      d('2026-10-25'),
    ]);
    expect(scheduleOccurrences(once('2026-10-20'), [], d('2026-10-22'), 7)).toEqual([
      d('2026-10-22'),
    ]);
    expect(scheduleOccurrences(once('2026-10-25'), [d('2026-10-22')], d('2026-10-22'), 7)).toEqual(
      [],
    );
  });

  it('reads leniently and rejects dates that do not exist or a per-day count', () => {
    expect(readSchedule({ repeat: 'once' })).toEqual({ repeat: 'once' });
    expect(readSchedule({ repeat: 'once', date: '2026-11-05', perDay: 3 })).toEqual({
      repeat: 'once',
      date: '2026-11-05',
    });
    expect(readSchedule({ repeat: 'once', date: '2026-02-30' })).toBeUndefined();
    expect(readSchedule({ repeat: 'once', date: 'tomorrow' })).toBeUndefined();
  });

  it('says once and the date in each language', () => {
    expect(scheduleText(once('2026-11-05'), 'zh')).toBe('一次：11月5日');
    expect(scheduleText(once('2026-11-05'), 'en')).toBe('Once: Nov 5');
    expect(scheduleText(once(), 'fr')).toBe('Une fois, sans date');
  });
});

// D-341: countEarly—doing it early counts toward the current occurrence (Todoist-style repeating tasks).
describe('counting an early completion', () => {
  const monday: ScheduleRule = { repeat: 'weekdays', days: [1] };
  // Created on Monday 2026-10-19; 2026-10-26 and Nov 2 are also Mondays.
  const early = (done: string[], today: string, since = '2026-10-19') => {
    const s = scheduleStatus(monday, done.map(d), d(today), DEFAULT_CALENDAR, {
      countEarly: true,
      since: d(since),
    });
    return { next: date(s.next!), overdue: s.overdueDays };
  };

  it('done on the Sunday before counts for that Monday', () => {
    // Done on Monday the 19th, did the 26th occurrence early on the 25th (Sunday) → next occurrence Nov 2.
    expect(early(['2026-10-19', '2026-10-25'], '2026-10-25')).toEqual({
      next: '2026-11-02',
      overdue: 0,
    });
    // Without countEarly enabled (D-293), it is still the 26th.
    expect(status(monday, ['2026-10-19', '2026-10-25'], '2026-10-25').next).toBe('2026-10-26');
  });

  it('done late on Tuesday still moves to the next Monday, not the one after', () => {
    expect(early(['2026-10-20'], '2026-10-20')).toEqual({ next: '2026-10-26', overdue: 0 });
  });

  it('done long after it was due moves to the first Monday after that day', () => {
    // Due on the 19th, completed only on the 30th → Nov 2, does not schedule a Monday that has already passed.
    expect(early(['2026-10-30'], '2026-10-30')).toEqual({ next: '2026-11-02', overdue: 0 });
  });

  it('never done keeps the old behaviour: the next matching day from today', () => {
    const s = scheduleStatus(monday, [], d('2026-10-22'), DEFAULT_CALENDAR, {
      countEarly: true,
      since: d('2026-10-01'),
    });
    expect(date(s.next!)).toBe('2026-10-26');
  });

  it('every day: done today moves to tomorrow either way', () => {
    const s = scheduleStatus({ repeat: 'daily' }, [d('2026-10-22')], d('2026-10-22'), undefined, {
      countEarly: true,
      since: d('2026-10-01'),
    });
    expect(date(s.next!)).toBe('2026-10-23');
  });
});

describe('once and pending on records', () => {
  const tasks: Collection = {
    id: 'tasks',
    name: 'Tasks',
    fields: [
      { id: 'title', name: 'Title', type: 'text' },
      { id: 'plan', name: 'Plan', type: 'schedule', lastDone: 'done', countEarly: true },
      { id: 'done', name: 'Done', type: 'date' },
    ],
  };
  const task = (title: string, plan: unknown, done?: string): DataRecord => ({
    id: title,
    collectionId: 'tasks',
    values: { title, plan, ...(done ? { done } : {}) },
    createdAt: new Date(2026, 9, 1).getTime(),
    updatedAt: 0,
  });
  const list = [
    task('Report', { repeat: 'once', date: '2026-10-22' }),
    task('Someday', { repeat: 'once' }),
    task('Finished', { repeat: 'once', date: '2026-10-20' }, '2026-10-21'),
    task('Weekly', { repeat: 'weekdays', days: [4] }, '2026-10-15'),
    task('Plain', undefined),
  ];
  const filtered = (value: string) =>
    list
      .filter(
        (r) => filterRecords([r], tasks, [{ field: 'plan', op: 'due', value }], now).length > 0,
      )
      .map((r) => r.values.title);

  it('pending is everything with a rule that is not a finished once', () => {
    expect(filtered('pending')).toEqual(['Report', 'Someday', 'Weekly']);
    expect(filtered('today')).toEqual(['Report', 'Weekly']);
    expect(filtered('thisWeek')).toEqual(['Report', 'Weekly']);
  });

  it('a once shows the date or its state, not the word once', () => {
    const shown = list.map((r) => formatRef(r, tasks, 'plan', 'zh', undefined, now));
    expect(shown).toEqual(['今天', '不定日期', '已完成', '每周四 · 今天', '']);
    expect(
      formatRef(
        task('Later', { repeat: 'once', date: '2026-11-05' }),
        tasks,
        'plan',
        'en',
        undefined,
        now,
      ),
    ).toBe('Nov 5');
  });

  it('sorts dated tasks first, undated and finished ones last', () => {
    const sorted = sortRecords(list, tasks, { field: 'plan', direction: 'asc' }, now);
    expect(
      sorted
        .slice(0, 2)
        .map((r) => r.values.title)
        .sort(),
    ).toEqual(['Report', 'Weekly']);
  });
});

// D-346: Every schedule rule can include a specific time.
describe('a time on a schedule', () => {
  it('reads and validates the time on any rule', () => {
    expect(readSchedule({ repeat: 'once', date: '2026-11-05', time: '15:00' })).toEqual({
      repeat: 'once',
      date: '2026-11-05',
      time: '15:00',
    });
    expect(readSchedule({ repeat: 'weekdays', days: [1], time: '09:30' })).toEqual({
      repeat: 'weekdays',
      days: [1],
      time: '09:30',
    });
    expect(readSchedule({ repeat: 'daily', time: '24:00' })).toBeUndefined();
    expect(readSchedule({ repeat: 'daily', time: '' })).toEqual({ repeat: 'daily' });
  });

  it('says the time in each language', () => {
    const rule: ScheduleRule = { repeat: 'weekdays', days: [1], time: '09:00' };
    expect(scheduleText(rule, 'zh')).toBe('每周一 09:00');
    expect(scheduleText(rule, 'en')).toBe('Every Mon at 09:00');
    expect(scheduleText(rule, 'fr')).toMatch(/à 09:00$/);
  });

  it('a once shows its day and time; the same day sorts by time, no time last', () => {
    const tasks: Collection = {
      id: 'tasks',
      name: 'Tasks',
      fields: [
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'plan', name: 'Plan', type: 'schedule' },
      ],
    };
    const task = (title: string, plan: unknown): DataRecord => ({
      id: title,
      collectionId: 'tasks',
      values: { title, plan },
      createdAt: 0,
      updatedAt: 0,
    });
    const at = new Date(2026, 9, 22, 9);
    const late = task('Late', { repeat: 'once', date: '2026-10-23', time: '18:00' });
    const early = task('Early', { repeat: 'once', date: '2026-10-23', time: '08:00' });
    const anytime = task('Anytime', { repeat: 'once', date: '2026-10-23' });
    expect(formatRef(late, tasks, 'plan', 'zh', undefined, at)).toBe('明天 18:00');
    expect(formatRef(late, tasks, 'plan', 'en', undefined, at)).toBe('Tomorrow at 18:00');
    const sorted = sortRecords(
      [anytime, late, early],
      tasks,
      { field: 'plan', direction: 'asc' },
      at,
    );
    expect(sorted.map((r) => r.values.title)).toEqual(['Early', 'Late', 'Anytime']);
  });
});

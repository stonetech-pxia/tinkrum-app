import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { reminderWhen } from './describe';
import { usesOf } from './file-uses';
import type { Op } from './ops';
import { planNotifications, RECORD_OCCURRENCES } from './reminders';
import type { Collection, Reminder, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// 每月几号的提醒（D-577）：「每月 1 号提醒我确认订阅」。系统没有按月重复的通知，所以一次排好接下来的几次，
// 记录一变、打开 App 就重排（useReminders.ts）；什么都不在后台运行（底线 16）。可以带 unless（D-563）。

const logs: Collection = {
  id: 'logs',
  name: 'Logs',
  fields: [
    { id: 'kind', name: 'Kind', type: 'text' },
    { id: 'on', name: 'On', type: 'date' },
  ],
};
// 2026-11-16 是星期一，12:00。
const now = new Date(2026, 10, 16, 12, 0);
const ctx = { registry, locale: 'en' as const, now };

const reminder = (when: unknown, unless?: Reminder['unless']): Reminder =>
  ({
    id: 'month',
    kind: 'reminder',
    title: 'Confirm your subscriptions',
    enabled: true,
    when,
    opens: 'page:home',
    ...(unless ? { unless } : {}),
  }) as Reminder;
const monthly = (day = 1, unless?: Reminder['unless']) =>
  reminder({ every: 'month', day, at: '09:00' }, unless);

const setup = (r: Reminder) =>
  prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: logs },
      { op: 'addTool', tool: r },
    ] as Op[],
    ctx,
  );
function config(r: Reminder): WorkspaceConfig {
  const result = setup(r);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.after;
}
const problems = (r: Reminder) => {
  const result = setup(r);
  return result.ok ? [] : result.issues.map(String);
};
const log = (id: string, on: string): DataRecord => ({
  id,
  collectionId: 'logs',
  values: { on },
  createdAt: new Date(2026, 10, 1).getTime(),
  updatedAt: new Date(2026, 10, 1).getTime(),
});
const plan = (c: WorkspaceConfig, records: DataRecord[], at: Date = now) =>
  planNotifications(c, new Map([['logs', records]]), at, 'en');
const times = (c: WorkspaceConfig, records: DataRecord[], at: Date = now) =>
  plan(c, records, at).map((n) => (n.trigger as { at?: number }).at ?? n.trigger.kind);
const first = (y: number, m: number, d = 1, h = 9) => new Date(y, m, d, h, 0).getTime();

describe('a reminder on a day of the month (D-577)', () => {
  it('is accepted for days 1 to 28 and refused outside them', () => {
    expect(problems(monthly(1))).toEqual([]);
    expect(problems(monthly(28))).toEqual([]);
    expect(problems(monthly(0)).join()).not.toBe('');
    expect(problems(monthly(29)).join()).not.toBe('');
    expect(problems(reminder({ every: 'month', at: '09:00' })).join()).not.toBe('');
  });

  it('is planned as the next occurrences, one dated notification each, at that time', () => {
    const got = times(config(monthly(1)), []);
    expect(got).toHaveLength(RECORD_OCCURRENCES);
    expect(got.slice(0, 3)).toEqual([first(2026, 11), first(2027, 0), first(2027, 1)]);
  });

  it('uses the chosen day, and today counts only while its time is still ahead', () => {
    expect(times(config(monthly(20)), [])[0]).toBe(first(2026, 10, 20));
    const sameDay = new Date(2026, 11, 1, 8, 0);
    expect(times(config(monthly(1)), [], sameDay)[0]).toBe(first(2026, 11));
    const after = new Date(2026, 11, 1, 10, 0);
    expect(times(config(monthly(1)), [], after)[0]).toBe(first(2027, 0));
  });

  it('with unless, leaves out a month that already has a matching entry and still plans a full set', () => {
    const c = config(monthly(1, { table: 'logs', within: 'month', date: 'on' }));
    const got = times(c, [log('a', '2026-12-05')]);
    expect(got).not.toContain(first(2026, 11));
    expect(got[0]).toBe(first(2027, 0));
    expect(got).toHaveLength(RECORD_OCCURRENCES);
  });

  it('carries only the title and where to open, nothing from the entries (P-043)', () => {
    const n = plan(config(monthly(1)), [])[0]!;
    expect(n.title).toBe('Confirm your subscriptions');
    expect(n.opens).toBe('page:home');
    expect(n.body).toBe('');
  });

  it('is described in words, and counted as a feature of a file that uses it', () => {
    const c = config(monthly(1));
    const r = c.tools.find((x) => x.id === 'month') as Reminder;
    expect(reminderWhen(r, c, 'en')).toBe('on day 1 of every month at 09:00');
    expect(usesOf({ tools: [r] }).features).toContain('reminderMonthly');
  });
});

import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { usesOf } from './file-uses';
import type { Op } from './ops';
import { planNotifications, reminderCollections, RECORD_OCCURRENCES } from './reminders';
import type { Collection, Reminder, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// 每天、每周的提醒也可以带 unless（D-563）：「今天还没记就 21:00 提醒我」。通知提前排好，记录一变就重排
// （useReminders.ts）；什么都不在后台运行（底线 16）。

const logs: Collection = {
  id: 'logs',
  name: 'Logs',
  fields: [
    { id: 'kind', name: 'Kind', type: 'text' },
    { id: 'on', name: 'On', type: 'date' },
    { id: 'habit', name: 'Habit', type: 'link', table: 'logs' },
  ],
};
// 2026-11-16 是星期一，12:00。
const now = new Date(2026, 10, 16, 12, 0);
const ctx = { registry, locale: 'en' as const, now };

const reminder = (when: Reminder['when'], unless: Reminder['unless']): Reminder => ({
  id: 'log',
  kind: 'reminder',
  title: 'Log your day',
  enabled: true,
  when,
  opens: 'page:home',
  ...(unless ? { unless } : {}),
});
const daily = (unless: Reminder['unless']) => reminder({ every: 'day', at: '21:00' }, unless);

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
const log = (id: string, createdAt: Date, values: Record<string, unknown> = {}): DataRecord => ({
  id,
  collectionId: 'logs',
  values,
  createdAt: createdAt.getTime(),
  updatedAt: createdAt.getTime(),
});
const at = (d: number, h = 21, m = 0) => new Date(2026, 10, d, h, m).getTime();
const times = (c: WorkspaceConfig, records: DataRecord[]) =>
  planNotifications(c, new Map([['logs', records]]), now, 'en').map(
    (n) => (n.trigger as { at?: number }).at ?? n.trigger.kind,
  );

describe('unless on a daily or weekly reminder (D-563)', () => {
  it('is accepted on every day and every week, with filter and date', () => {
    expect(problems(daily({ table: 'logs', within: 'day' }))).toEqual([]);
    expect(
      problems(
        reminder(
          { every: 'week', days: [1, 4], at: '09:00' },
          {
            table: 'logs',
            within: 'week',
            filter: [{ field: 'kind', op: 'is', value: 'run' }],
            date: 'on',
          },
        ),
      ),
    ).toEqual([]);
  });

  it('refuses link, a missing table, a bad filter or date; before and after still refuse unless', () => {
    expect(problems(daily({ table: 'logs', within: 'day', link: 'habit' })).join()).toMatch(
      /unless.link only works with when.each/,
    );
    expect(problems(daily({ table: 'nope', within: 'day' })).join()).toMatch(
      /data table nope does not exist/,
    );
    expect(
      problems(daily({ table: 'logs', within: 'day', filter: [{ field: 'x', op: 'isEmpty' }] })),
    ).not.toEqual([]);
    expect(problems(daily({ table: 'logs', within: 'day', date: 'kind' })).join()).toMatch(
      /date must be a date or datetime field of logs/,
    );
    expect(
      problems(
        reminder({ after: { table: 'logs' }, minutes: 5 }, { table: 'logs', within: 'day' }),
      ).join(),
    ).toMatch(/unless only works with when.each, when.every/);
  });

  it('without unless a daily reminder stays one repeating notification', () => {
    expect(times(config(daily(undefined)), [])).toEqual(['daily']);
  });

  it('with unless it plans the coming days one by one and skips a day that already has an entry', () => {
    const c = config(daily({ table: 'logs', within: 'day' }));
    const days = Array.from({ length: RECORD_OCCURRENCES }, (_, i) => at(16 + i));
    expect(times(c, [])).toEqual(days);
    // 今天已经记了：今天不提醒，后面的照旧。
    expect(times(c, [log('a', new Date(2026, 10, 16, 8))])).toEqual([...days.slice(1), at(23)]);
    // 昨天记的不算。
    expect(times(c, [log('b', new Date(2026, 10, 15, 22))])).toEqual(days);
  });

  it('the filter and the date field decide which entries count', () => {
    const c = config(
      daily({
        table: 'logs',
        within: 'day',
        filter: [{ field: 'kind', op: 'is', value: 'run' }],
        date: 'on',
      }),
    );
    const today = at(16);
    // 只有 kind 是 run 的算；日期看 on（明天的那条让明天不提醒）。
    const planned = times(c, [
      log('walk', new Date(2026, 10, 16, 8), { kind: 'walk', on: '2026-11-16' }),
      log('run', new Date(2026, 10, 16, 8), { kind: 'run', on: '2026-11-17' }),
    ]);
    expect(planned).toContain(today);
    expect(planned).not.toContain(at(17));
  });

  it('a weekly one skips the rest of a week that already has an entry', () => {
    const c = config(
      reminder({ every: 'week', days: [1, 4], at: '09:00' }, { table: 'logs', within: 'week' }),
    );
    // 周一 9 点已经过了；本周四有记录就不提醒，下周一、周四照旧。
    const planned = times(c, [log('a', new Date(2026, 10, 16, 8))]);
    expect(planned.slice(0, 2)).toEqual([at(23, 9), at(26, 9)]);
    expect(times(c, []).slice(0, 2)).toEqual([at(19, 9), at(23, 9)]);
  });

  it('reads the unless table, and a file lists it', () => {
    const c = config(daily({ table: 'logs', within: 'day' }));
    expect(reminderCollections(c)).toEqual(['logs']);
    expect(usesOf(c).features).toContain('reminderUnlessRepeating');
    expect(usesOf(config(daily(undefined))).features ?? []).not.toContain(
      'reminderUnlessRepeating',
    );
  });
});

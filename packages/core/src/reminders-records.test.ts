import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { dayNumber } from './formula';
import type { Op } from './ops';
import {
  MAX_PENDING_NOTIFICATIONS,
  MAX_RECORD_NOTIFICATIONS,
  RECORD_OCCURRENCES,
  planNotifications,
  reminderCollections,
  reminderDoneInput,
  reminderSkipped,
} from './reminders';
import { scheduleOccurrences } from './schedule';
import {
  MAX_RECORD_REMINDERS,
  MAX_REMINDERS,
  remindersOf,
  type Collection,
  type Reminder,
  type WorkspaceConfig,
} from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';

// Reminders sorted by record (D-316–D-319).

const habits: Collection = {
  id: 'habits',
  name: '习惯',
  fields: [
    { id: 'name', name: '名字', type: 'text' },
    { id: 'plan', name: '日程', type: 'schedule', lastDone: 'last' },
    { id: 'last', name: '上次', type: 'date' },
    { id: 'count', name: '次数', type: 'number' },
  ],
};
const checkins: Collection = {
  id: 'checkins',
  name: '打卡',
  fields: [
    { id: 'habit', name: '习惯', type: 'link', table: 'habits' },
    { id: 'day', name: '日期', type: 'date' },
  ],
};
const perHabit: Reminder = {
  id: 'habit',
  kind: 'reminder',
  title: '该做了',
  enabled: true,
  when: { each: { table: 'habits', field: 'plan' }, at: '20:00' },
  opens: 'page:home',
};
const each = (table: string, field: string, at = '20:00') => ({
  when: { each: { table, field }, at },
});
// 2026-10-22 is Thursday, noon.
const now = new Date(2026, 9, 22, 12);
const today = dayNumber('2026-10-22')!;
const ctx = { registry, locale: 'zh' as const, now };

function prepare(ops: Op[]) {
  return prepareOps(
    fromV33(v33Fixture('default-zh')),
    [{ op: 'addData', table: habits }, { op: 'addData', table: checkins }, ...ops],
    ctx,
  );
}
function config(ops: Op[]): WorkspaceConfig {
  const r = prepare(ops);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.after;
}
const habit = (id: string, name: string, values: Record<string, unknown>): DataRecord => ({
  id,
  collectionId: 'habits',
  values: { name, ...values },
  createdAt: 0,
  updatedAt: 0,
});
const checkin = (id: string, habitId: string, createdAt: Date): DataRecord => ({
  id,
  collectionId: 'checkins',
  values: { habit: habitId },
  createdAt: createdAt.getTime(),
  updatedAt: createdAt.getTime(),
});
const atLocal = (date: string, time: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, min] = time.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, h, min).getTime();
};

describe('scheduleOccurrences', () => {
  it('starts at the next time (overdue = today) and assumes each one is done', () => {
    expect(scheduleOccurrences({ repeat: 'daily' }, [], today, 3)).toEqual([
      today,
      today + 1,
      today + 2,
    ]);
    // Every 3 days, last 5 days ago: already overdue, remind today, then every 3 days.
    expect(scheduleOccurrences({ repeat: 'interval', every: 3 }, [today - 5], today, 3)).toEqual([
      today,
      today + 3,
      today + 6,
    ]);
    // Every Monday, Wednesday, and Friday (today is Thursday): Friday, next Monday, next Wednesday.
    expect(scheduleOccurrences({ repeat: 'weekdays', days: [1, 3, 5] }, [], today, 3)).toEqual([
      today + 1,
      today + 4,
      today + 6,
    ]);
    // Twice a week, already done for 2 days this week: starting next Monday.
    const monday = today - 3;
    expect(
      scheduleOccurrences(
        { repeat: 'times', per: 'week', count: 2 },
        [monday, monday + 1],
        today,
        2,
      ),
    ).toEqual([monday + 7, monday + 8]);
  });
});

describe('reminder settings per entry (D-316)', () => {
  it('can be added with unless, done and snooze; described with the table and field', () => {
    const r: Reminder = {
      ...perHabit,
      unless: { table: 'checkins', within: 'day', link: 'habit' },
      done: { do: 'create', table: 'checkins', values: { habit: '$row', day: 'today' } },
      snoozeMinutes: 10,
    };
    const added = prepare([{ op: 'addTool', tool: r }]);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.after.tools).toEqual([r]);
    expect(added.lines).toContain(
      '新建提醒「该做了」（「习惯」每条记录按自己的「日程」，在 20:00，当天「打卡」已有符合条件的记录就不提醒）',
    );
  });

  it('refuses settings that can’t work', () => {
    const bad = (r: Partial<Reminder> | Record<string, unknown>) =>
      prepare([{ op: 'addTool', tool: { ...perHabit, ...r } as Reminder }]).ok;
    expect(bad({})).toBe(true);
    expect(bad(each('habits', 'last'))).toBe(false); // Not a schedule field
    expect(bad(each('missing', 'plan'))).toBe(false);
    expect(bad({ unless: { table: 'missing', within: 'day' } })).toBe(false);
    expect(bad({ unless: { table: 'checkins', within: 'day', link: 'day' } })).toBe(false);
    expect(bad({ unless: { table: 'checkins', within: 'day', date: 'habit' } })).toBe(false);
    expect(
      bad({
        unless: {
          table: 'checkins',
          within: 'week',
          filter: [{ field: 'nope', op: 'isNotEmpty' }],
        },
      }),
    ).toBe(false);
    // "Done" cannot write text; increment requires a numeric field.
    expect(bad({ done: { do: 'set', table: 'habits', field: 'name', value: 'x' } })).toBe(false);
    expect(bad({ done: { do: 'increment', table: 'habits', field: 'last', by: 1 } })).toBe(false);
    expect(bad({ done: { do: 'set', table: 'habits', field: 'last', value: 'today' } })).toBe(true);
    // "Done" cannot run quick actions or open forms (relation rule 13).
    expect(bad({ done: { tool: 'pdf-merge' } })).toBe(false);
    expect(bad({ done: { do: 'create', table: 'checkins', ask: 'all' } })).toBe(false);
    // Relation rule 12: creating in another table must link back to this entry.
    expect(bad({ done: { do: 'create', table: 'checkins', values: { day: 'today' } } })).toBe(
      false,
    );
    expect(bad({ snoozeMinutes: 2 })).toBe(false);
    // unless, done, and snoozeMinutes are only used on when.each.
    expect(bad({ when: { every: 'day', at: '09:00' }, snoozeMinutes: 10 })).toBe(false);
  });

  it('has its own limit and does not take the 20 places of other reminders', () => {
    const daily = (i: number): Reminder => ({
      id: `d${i}`,
      kind: 'reminder',
      title: '记账',
      enabled: true,
      when: { every: 'day', at: '09:00' },
      opens: 'page:home',
    });
    const full = Array.from({ length: MAX_REMINDERS }, (_, i) => ({
      op: 'addTool' as const,
      tool: daily(i),
    }));
    expect(prepare([...full, { op: 'addTool', tool: perHabit }]).ok).toBe(true);
    expect(prepare([...full, { op: 'addTool', tool: daily(99) }]).ok).toBe(false);
    const perEntry = Array.from({ length: MAX_RECORD_REMINDERS + 1 }, (_, i) => ({
      op: 'addTool' as const,
      tool: { ...perHabit, id: `h${i}` },
    }));
    expect(prepare(perEntry.slice(0, MAX_RECORD_REMINDERS)).ok).toBe(true);
    expect(prepare(perEntry).ok).toBe(false);
  });

  it('removing the schedule field removes the reminder, and says so', () => {
    const before = config([{ op: 'addTool', tool: perHabit }]);
    const result = prepareOps(before, [{ op: 'removeData', table: 'habits', field: 'plan' }], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.tools).toEqual([]);
    expect(result.lines.join('\n')).toContain('该做了');
  });

  it('reads the reminder table and the unless table', () => {
    const c = config([
      {
        op: 'addTool',
        tool: { ...perHabit, unless: { table: 'checkins', within: 'day' } },
      },
    ]);
    expect(reminderCollections(c)).toEqual(['habits', 'checkins']);
  });
});

describe('planNotifications per entry (D-316, D-319)', () => {
  const c = config([
    {
      op: 'addTool',
      tool: {
        ...perHabit,
        done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
        snoozeMinutes: 15,
      },
    },
  ]);

  it('each entry on its own schedule, titled with the entry, with the buttons', () => {
    const records = new Map([
      [
        'habits',
        [
          habit('run', '跑步', { plan: { repeat: 'daily' } }),
          habit('water', '浇水', { plan: { repeat: 'interval', every: 7 }, last: '2026-10-20' }),
          habit('none', '没有日程', {}),
        ],
      ],
    ]);
    const planned = planNotifications(c, records, now, 'zh');
    const run = planned.filter((n) => n.recordId === 'run');
    expect(run).toHaveLength(RECORD_OCCURRENCES);
    expect(run[0]).toMatchObject({
      id: `habit-run-${today}`,
      reminderId: 'habit',
      title: '跑步',
      body: '该做了',
      trigger: { kind: 'date', at: atLocal('2026-10-22', '20:00') },
      buttons: 'doneSnooze',
    });
    expect(run[1]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-10-23', '20:00') });
    const water = planned.filter((n) => n.recordId === 'water');
    expect(water[0]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-10-27', '20:00') });
    expect(water[1]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-11-03', '20:00') });
    expect(planned.some((n) => n.recordId === 'none')).toBe(false);
    // Most recent first.
    const times = planned.map((n) => (n.trigger as { at: number }).at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('an entry with its own time is reminded then, not at the reminder time (D-346)', () => {
    const records = new Map([
      [
        'habits',
        [
          habit('pill', '吃药', { plan: { repeat: 'daily', time: '13:30' } }),
          habit('call', '打电话', { plan: { repeat: 'once', date: '2026-10-24', time: '08:15' } }),
        ],
      ],
    ]);
    const planned = planNotifications(c, records, now, 'zh');
    const pill = planned.filter((n) => n.recordId === 'pill');
    expect(pill[0]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-10-22', '13:30') });
    // One-off: schedule only that single time.
    expect(planned.filter((n) => n.recordId === 'call').map((n) => n.trigger)).toEqual([
      { kind: 'date', at: atLocal('2026-10-24', '08:15') },
    ]);
  });

  it('skips today when the time has passed, and does not count it', () => {
    const late = new Date(2026, 9, 22, 21);
    const records = new Map([['habits', [habit('run', '跑步', { plan: { repeat: 'daily' } })]]]);
    const planned = planNotifications(c, records, late, 'zh');
    expect(planned).toHaveLength(RECORD_OCCURRENCES);
    expect(planned[0]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-10-23', '20:00') });
  });

  it('done today (lastDone) moves the next one to tomorrow', () => {
    const records = new Map([
      ['habits', [habit('run', '跑步', { plan: { repeat: 'daily' }, last: '2026-10-22' })]],
    ]);
    const planned = planNotifications(c, records, now, 'zh');
    expect(planned[0]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-10-23', '20:00') });
  });

  it('a time before the day starts falls on the next calendar date', () => {
    const night = config([
      { op: 'updateData', calendar: { dayStartHour: 4 } },
      { op: 'addTool', tool: { ...perHabit, ...each('habits', 'plan', '01:30') } },
    ]);
    const records = new Map([['habits', [habit('run', '跑步', { plan: { repeat: 'daily' } })]]]);
    const planned = planNotifications(night, records, now, 'zh');
    expect(planned[0]!.trigger).toEqual({ kind: 'date', at: atLocal('2026-10-23', '01:30') });
  });

  it('turned off or broken reminders plan nothing', () => {
    const off = config([{ op: 'addTool', tool: { ...perHabit, enabled: false } }]);
    const records = new Map([['habits', [habit('run', '跑步', { plan: { repeat: 'daily' } })]]]);
    expect(planNotifications(off, records, now, 'zh')).toEqual([]);
  });

  it('keeps only the nearest per-entry notifications, and all of them within the system limit', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      habit(`h${i}`, `习惯${i}`, { plan: { repeat: 'daily' } }),
    );
    const planned = planNotifications(c, new Map([['habits', many]]), now, 'zh');
    expect(planned).toHaveLength(MAX_RECORD_NOTIFICATIONS);
    // Keep only the most recent ones within 20 items × 7 days: 40 items for today and tomorrow.
    const last = Math.max(...planned.map((n) => (n.trigger as { at: number }).at));
    expect(last).toBe(atLocal('2026-10-23', '20:00'));
  });

  it('counts daily and weekly reminders, date reminders and snoozes against the 64', () => {
    const withOthers = config([
      { op: 'addTool', tool: perHabit },
      ...Array.from({ length: 10 }, (_, i) => ({
        op: 'addTool' as const,
        tool: {
          id: `w${i}`,
          kind: 'reminder' as const,
          title: '周报',
          enabled: true,
          when: { every: 'week' as const, days: [1, 2], at: '09:00' },
          opens: 'page:home' as const,
        },
      })),
    ]);
    const many = Array.from({ length: 20 }, (_, i) =>
      habit(`h${i}`, `习惯${i}`, { plan: { repeat: 'daily' } }),
    );
    const planned = planNotifications(withOthers, new Map([['habits', many]]), now, 'zh', {
      reserved: 4,
    });
    // 20 weekly reminders + 4 snooze reminders take 24 slots, leaving 40 based on records.
    expect(planned.filter((n) => n.trigger.kind === 'weekly')).toHaveLength(20);
    expect(planned).toHaveLength(MAX_PENDING_NOTIFICATIONS - 4);
    const fewer = planNotifications(withOthers, new Map([['habits', many]]), now, 'zh', {
      reserved: 10,
    });
    expect(fewer.filter((n) => n.recordId)).toHaveLength(MAX_PENDING_NOTIFICATIONS - 30);
  });
});

describe('unless (D-317)', () => {
  const linked = config([
    {
      op: 'addTool',
      tool: {
        ...perHabit,
        unless: { table: 'checkins', within: 'day', link: 'habit' },
      },
    },
  ]);
  const run = habit('run', '跑步', { plan: { repeat: 'daily' } });
  const read = habit('read', '读书', { plan: { repeat: 'daily' } });

  it('skips the days that already have a matching entry for this one', () => {
    const records = new Map([
      ['habits', [run, read]],
      ['checkins', [checkin('c1', 'run', new Date(2026, 9, 22, 8))]],
    ]);
    const planned = planNotifications(linked, records, now, 'zh');
    const days = (id: string) =>
      planned.filter((n) => n.recordId === id).map((n) => n.id.split('-').pop());
    // Already checked in for running today: no reminder today, tomorrow as usual; reading as usual today.
    expect(days('run')[0]).toBe(String(today + 1));
    expect(days('read')[0]).toBe(String(today));
  });

  it('within a week skips the rest of that week', () => {
    const weekly = config([
      {
        op: 'addTool',
        tool: {
          ...perHabit,
          unless: { table: 'checkins', within: 'week', link: 'habit' },
        },
      },
    ]);
    const r = remindersOf(weekly)[0]!;
    const records = new Map([['checkins', [checkin('c1', 'run', new Date(2026, 9, 20, 8))]]]);
    // Checked in on Tuesday: no reminders for this week (until Sunday 10-25), next Monday as usual.
    expect(reminderSkipped(r, run, today, weekly, records, now)).toBe(true);
    expect(reminderSkipped(r, run, today + 3, weekly, records, now)).toBe(true);
    expect(reminderSkipped(r, run, today + 4, weekly, records, now)).toBe(false);
  });

  it('uses the filter and the date field; without link any entry of the table counts', () => {
    const anyCheckin = config([
      {
        op: 'addTool',
        tool: {
          ...perHabit,
          unless: {
            table: 'checkins',
            within: 'day',
            date: 'day',
            filter: [{ field: 'day', op: 'isNotEmpty' }],
          },
        },
      },
    ]);
    const r = remindersOf(anyCheckin)[0]!;
    const dated = (day?: string): DataRecord => ({
      ...checkin('c', 'other', new Date(2026, 0, 1)),
      values: { habit: 'other', ...(day ? { day } : {}) },
    });
    const map = (x: DataRecord) => new Map([['checkins', [x]]]);
    expect(reminderSkipped(r, run, today, anyCheckin, map(dated('2026-10-22')), now)).toBe(true);
    expect(reminderSkipped(r, run, today + 1, anyCheckin, map(dated('2026-10-22')), now)).toBe(
      false,
    );
    // No date does not match the filter.
    expect(reminderSkipped(r, run, today, anyCheckin, map(dated()), now)).toBe(false);
  });

  it('on the same table only looks at this entry itself', () => {
    const self = config([
      {
        op: 'addTool',
        tool: {
          ...perHabit,
          unless: { table: 'habits', within: 'day', date: 'last' },
        },
      },
    ]);
    const r = remindersOf(self)[0]!;
    const doneRun = habit('run', '跑步', { plan: { repeat: 'daily' }, last: '2026-10-22' });
    const records = new Map([['habits', [doneRun, read]]]);
    expect(reminderSkipped(r, doneRun, today, self, records, now)).toBe(true);
    expect(reminderSkipped(r, read, today, self, records, now)).toBe(false);
  });
});

describe('reminderDoneInput (D-318)', () => {
  const c = config([]);
  const run = habit('run', '跑步', { plan: { repeat: 'daily' }, count: 2 });
  const at = new Date(2026, 9, 22, 20, 1);

  it('create makes a new entry linked to this one', () => {
    expect(
      reminderDoneInput(
        { do: 'create', table: 'checkins', values: { habit: '$row', day: 'today' } },
        c,
        habits,
        run,
        at,
      ),
    ).toEqual({
      kind: 'create',
      collection: c.data.tables.find((x) => x.id === 'checkins'),
      input: { habit: 'run', day: '2026-10-22' },
    });
  });

  it('set and increment change this entry', () => {
    expect(
      reminderDoneInput(
        { do: 'set', table: 'habits', field: 'last', value: 'today' },
        c,
        habits,
        run,
        at,
      ),
    ).toEqual({ kind: 'update', input: { last: '2026-10-22' } });
    expect(
      reminderDoneInput(
        { do: 'increment', table: 'habits', field: 'count', by: 1 },
        c,
        habits,
        run,
        at,
      ),
    ).toEqual({ kind: 'update', input: { count: 3 } });
  });

  it('a field or table that is gone writes nothing', () => {
    expect(
      reminderDoneInput(
        { do: 'set', table: 'habits', field: 'gone', value: 1 },
        c,
        habits,
        run,
        at,
      ),
    ).toBe(null);
    expect(reminderDoneInput({ do: 'create', table: 'gone' }, c, habits, run, at)).toBe(null);
  });
});

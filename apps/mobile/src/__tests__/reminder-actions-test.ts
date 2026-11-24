import {
  applyOps,
  BUILTIN_TOOLS,
  createDefaultWorkspace,
  createRegistry,
  migrateReminderV33,
  v33Tables,
  type DataRecord,
  type Op,
  type Reminder,
  remindersOf,
  snoozeId,
  type WorkspaceConfig,
} from '@morph/core';

import type { ReminderAction } from '../reminders/platform';
import { handleReminderAction, runReminderAction } from '../reminders/reminder-actions';
import { syncReminders } from '../reminders/useReminders';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { SQLiteWorkspaceRepo, migrateDatabase } from '../storage/sqlite';
import type { WorkspaceRepo } from '../storage/types';
import { FakeNotifications } from '../test-utils/fake-notifications';
import { nodeSqlite } from '../test-utils/node-sqlite';

// Buttons on reminder notifications (D-318): "Done" writes only this record and re-sorts upon completion; "Snooze" schedules another; single click performs action once.

const registry = createRegistry(BUILTIN_TOOLS);
const habitsTable: Op = {
  op: 'addData',
  table: {
    id: 'habits',
    name: '习惯',
    fields: [
      { id: 'name', name: '名字', type: 'text' },
      { id: 'plan', name: '日程', type: 'schedule', lastDone: 'last' },
      { id: 'last', name: '上次', type: 'date' },
      { id: 'count', name: '次数', type: 'number' },
    ],
  },
};
const checkinsTable: Op = {
  op: 'addData',
  table: {
    id: 'checkins',
    name: '打卡',
    fields: [
      { id: 'habit', name: '习惯', type: 'link', table: 'habits' },
      { id: 'day', name: '日期', type: 'date', required: true },
    ],
  },
};
const base: Reminder = {
  id: 'habit',
  kind: 'reminder',
  title: '该做了',
  enabled: true,
  when: { each: { table: 'habits', field: 'plan' }, at: '20:00' },
  opens: 'page:home',
  snoozeMinutes: 15,
};
const now = new Date(2026, 9, 22, 20, 1);

async function setup(reminder: Partial<Reminder>, repo: WorkspaceRepo = new MemoryWorkspaceRepo()) {
  const r = applyOps(
    createDefaultWorkspace('zh'),
    [habitsTable, checkinsTable, { op: 'addTool', tool: { ...base, ...reminder } }],
    { registry, locale: 'zh' },
  );
  if (!r.ok) throw new Error(r.error);
  await repo.commitRevision({ baseId: null, config: r.config, source: 'user', summary: 'seed' });
  const run: DataRecord = {
    id: 'run',
    collectionId: 'habits',
    values: { name: '跑步', plan: { repeat: 'daily' }, count: 2 },
    createdAt: 0,
    updatedAt: 0,
  };
  await repo.insertRecord(run);
  const platform = new FakeNotifications();
  platform.status = 'granted';
  const deps = { repo, platform, locale: 'zh' as const, now: () => now };
  return { repo, platform, deps, config: r.config as WorkspaceConfig };
}
const press = (button: 'done' | 'snooze', key = 'n1:1:x'): ReminderAction => ({
  button,
  reminderId: 'habit',
  recordId: 'run',
  notificationId: 'habit-run-20748',
  key,
});

describe('the Done button (D-318)', () => {
  it('set writes this entry, then reminders are planned again from tomorrow', async () => {
    const { repo, platform, deps, config } = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    await syncReminders(
      platform,
      config,
      (id) => repo.listRecords(id),
      'zh',
      new Date(2026, 9, 22, 12),
    );
    expect(platform.scheduled![0]!.id).toBe('habit-run-20748');

    expect(await handleReminderAction(press('done'), deps)).toEqual({
      kind: 'done',
      title: '跑步',
    });
    expect((await repo.getRecord('run'))!.values.last).toBe('2026-10-22');
    expect(platform.dismissed).toEqual(['habit-run-20748']);
    expect(platform.cancelled).toContain(snoozeId('habit', 'run'));
    // Rescheduled: today's has passed, next is tomorrow at 20:00.
    expect(platform.scheduled![0]!.id).toBe('habit-run-20749');
  });

  it('a reminder saved by the v33 app (scheduleField, done set) marks the entry done after migration', async () => {
    // v33 syntax: schedule + collectionId + fieldId, done has no table (applies to the reminder's table).
    const v33 = {
      id: 'habit',
      title: '该做了',
      enabled: true,
      schedule: 'scheduleField',
      collectionId: 'habits',
      fieldId: 'plan',
      time: '20:00',
      opens: 'page:home',
      done: { do: 'set', fieldId: 'last', value: 'today' },
    };
    const migrated = migrateReminderV33(v33, v33Tables([{ id: 'habits', fields: [] }]));
    const { repo, deps } = await setup(migrated as Partial<Reminder>);
    expect(await handleReminderAction(press('done'), deps)).toEqual({
      kind: 'done',
      title: '跑步',
    });
    // Writes this entry in the reminder's table (v34 done with table: habits).
    expect((await repo.getRecord('run'))!.values.last).toBe('2026-10-22');
  });

  it('increment adds to this entry; the same tap arriving twice counts once', async () => {
    const { repo, deps } = await setup({
      done: { do: 'increment', table: 'habits', field: 'count', by: 1 },
    });
    await handleReminderAction(press('done'), deps);
    expect(await handleReminderAction(press('done'), deps)).toEqual({ kind: 'skipped' });
    expect((await repo.getRecord('run'))!.values.count).toBe(3);
    // Another click computes normally.
    await handleReminderAction(press('done', 'n2:2:x'), deps);
    expect((await repo.getRecord('run'))!.values.count).toBe(4);
  });

  it('create adds a check-in linked to this entry', async () => {
    const { repo, deps } = await setup({
      done: { do: 'create', table: 'checkins', values: { habit: '$row', day: 'today' } },
    });
    await handleReminderAction(press('done'), deps);
    const checkins = await repo.listRecords('checkins');
    expect(checkins.map((c) => c.values)).toEqual([{ habit: 'run', day: '2026-10-22' }]);
  });

  it('writes nothing when the entry was deleted, or a required field would stay empty', async () => {
    const gone = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    await gone.repo.deleteRecord('run', 1);
    expect(await handleReminderAction(press('done'), gone.deps)).toEqual({ kind: 'skipped' });

    const missing = await setup({
      done: { do: 'create', table: 'checkins', values: { habit: '$row' } },
    });
    // Record exists but fails to save: user thinks it was logged, must inform them (see runReminderAction below).
    expect(await handleReminderAction(press('done'), missing.deps)).toEqual({
      kind: 'notSaved',
    });
    expect(await missing.repo.listRecords('checkins')).toEqual([]);
  });

  it('never touches anything but entries: no quick action, no AI, no new version', async () => {
    const { repo, deps } = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    const before = await repo.listRevisions(10);
    await handleReminderAction(press('done'), deps);
    expect(await repo.listRevisions(10)).toEqual(before);
    expect(await repo.listToolRuns(10)).toEqual([]);
  });
});

describe('Remind me later (D-318)', () => {
  it('plans one more notification after snoozeMinutes, kept apart and counted against the limit', async () => {
    const { repo, platform, deps, config } = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    expect(await handleReminderAction(press('snooze'), deps)).toEqual({ kind: 'snoozed' });
    expect(platform.snoozes).toEqual([
      {
        id: snoozeId('habit', 'run'),
        reminderId: 'habit',
        title: '跑步',
        body: '该做了',
        trigger: { kind: 'date', at: now.getTime() + 15 * 60_000 },
        opens: 'page:home',
        recordId: 'run',
        buttons: 'doneSnooze',
      },
    ]);
    // Record unchanged: snooze does not write records.
    expect((await repo.getRecord('run'))!.values.last).toBeUndefined();
    // Tap "Done" again: snooze is cancelled.
    await handleReminderAction(press('done', 'n3:3:x'), deps);
    expect(platform.snoozes).toEqual([]);
    expect(remindersOf(config)).toHaveLength(1);
  });
});

// R06: The deduplication marker and the record write are in the same transaction. If the write
// fails, the same tap (resent on the next app start) can run again without being treated as already
// handled; if the write succeeds but the marker fails, that state is impossible (either both write
// or neither does), so it is never counted twice.
describe('a tap whose write fails is not lost (R06)', () => {
  it('the write fails once: the same tap done again counts, and only once', async () => {
    const { repo, deps } = await setup({
      done: { do: 'increment', table: 'habits', field: 'count', by: 1 },
    });
    jest.spyOn(repo, 'applyRecordWrites').mockRejectedValueOnce(new Error('disk write failed'));
    await expect(handleReminderAction(press('done'), deps)).rejects.toThrow('disk write failed');
    expect((await repo.getRecord('run'))!.values.count).toBe(2);
    expect(await handleReminderAction(press('done'), deps)).toEqual({
      kind: 'done',
      title: '跑步',
    });
    expect((await repo.getRecord('run'))!.values.count).toBe(3);
    expect(await handleReminderAction(press('done'), deps)).toEqual({ kind: 'skipped' });
    expect((await repo.getRecord('run'))!.values.count).toBe(3);
  });

  it('SQLite: the record write and the handled mark go together — failing at the mark undoes the write', async () => {
    const db = nodeSqlite();
    await migrateDatabase(db);
    const original = db.runAsync.bind(db);
    let failMark = true;
    (db as unknown as { runAsync: typeof db.runAsync }).runAsync = (async (
      sql: string,
      ...params: never[]
    ) => {
      if (failMark && sql.includes('app_meta')) {
        failMark = false;
        throw new Error('crash before the mark');
      }
      return original(sql, ...params);
    }) as typeof db.runAsync;
    const { repo, deps } = await setup(
      { done: { do: 'increment', table: 'habits', field: 'count', by: 1 } },
      new SQLiteWorkspaceRepo(db),
    );
    await expect(handleReminderAction(press('done'), deps)).rejects.toThrow('crash before');
    // Record left no half-state: still 2, and the marker was not written.
    expect((await repo.getRecord('run'))!.values.count).toBe(2);
    expect(await handleReminderAction(press('done'), deps)).toEqual({
      kind: 'done',
      title: '跑步',
    });
    expect((await repo.getRecord('run'))!.values.count).toBe(3);
    expect(await handleReminderAction(press('done'), deps)).toEqual({ kind: 'skipped' });
    expect((await repo.getRecord('run'))!.values.count).toBe(3);
  });

  it('the notification is only dismissed once the write is in', async () => {
    const { repo, platform, deps } = await setup({
      done: { do: 'increment', table: 'habits', field: 'count', by: 1 },
    });
    jest.spyOn(repo, 'applyRecordWrites').mockRejectedValueOnce(new Error('disk write failed'));
    await expect(handleReminderAction(press('done'), deps)).rejects.toThrow();
    expect(platform.dismissed).toEqual([]);
    await handleReminderAction(press('done'), deps);
    expect(platform.dismissed).toEqual(['habit-run-20748']);
  });

  it('Remind me later: scheduling fails once, the same tap can be done again', async () => {
    const { platform, deps } = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    jest.spyOn(platform, 'snooze').mockRejectedValueOnce(new Error('cannot schedule'));
    await expect(handleReminderAction(press('snooze'), deps)).rejects.toThrow('cannot schedule');
    expect(await handleReminderAction(press('snooze'), deps)).toEqual({ kind: 'snoozed' });
    expect(await handleReminderAction(press('snooze'), deps)).toEqual({ kind: 'skipped' });
  });

  it('nothing to do (the entry is gone): the tap is marked handled', async () => {
    const { repo, deps } = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    await repo.deleteRecord('run', 1);
    expect(await handleReminderAction(press('done'), deps)).toEqual({ kind: 'skipped' });
    await repo.restoreRecord('run');
    // An already-handled tap (where nothing was done at the time) is not run again just because records return.
    expect(await handleReminderAction(press('done'), deps)).toEqual({ kind: 'skipped' });
    expect((await repo.getRecord('run'))!.values.last).toBeUndefined();
  });
});

// Health check 2.5: When a button on a notification fails to execute, it must not be silent—immediately pop a notification prompting the user to open the app and try again.
describe('telling the user when a button on the reminder did not go through', () => {
  it('the write fails: a notification says it was not logged', async () => {
    const { repo, platform, deps } = await setup({
      done: { do: 'increment', table: 'habits', field: 'count', by: 1 },
    });
    jest.spyOn(repo, 'applyRecordWrites').mockRejectedValueOnce(new Error('disk write failed'));
    await runReminderAction(press('done'), deps);
    expect(platform.alerts).toEqual([
      { title: '没有记下', body: '刚才在提醒上点的按钮没有生效，请打开 Tinkrum 再试一次。' },
    ]);
    expect((await repo.getRecord('run'))!.values.count).toBe(2);
  });

  it('a required field would stay empty: the same notification, nothing written', async () => {
    const { repo, platform, deps } = await setup({
      done: { do: 'create', table: 'checkins', values: { habit: '$row' } },
    });
    await runReminderAction(press('done'), deps);
    expect(platform.alerts.map((a) => a.title)).toEqual(['没有记下']);
    expect(await repo.listRecords('checkins')).toEqual([]);
  });

  it('Remind me later cannot be scheduled: says so', async () => {
    const { platform, deps } = await setup({
      done: { do: 'set', table: 'habits', field: 'last', value: 'today' },
    });
    jest.spyOn(platform, 'snooze').mockRejectedValueOnce(new Error('cannot schedule'));
    await runReminderAction(press('snooze'), deps);
    expect(platform.alerts.map((a) => a.title)).toEqual(['没能稍后提醒']);
  });

  it('stays quiet when it worked, or when there was nothing to do', async () => {
    const done = await setup({
      done: { do: 'increment', table: 'habits', field: 'count', by: 1 },
    });
    expect(await runReminderAction(press('done'), done.deps)).toEqual({
      kind: 'done',
      title: '跑步',
    });
    await done.repo.deleteRecord('run', 1);
    await runReminderAction(press('done', 'n1:2:x'), done.deps);
    expect(done.platform.alerts).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { usesOf } from './file-uses';
import type { Op } from './ops';
import { MAX_DATE_NOTIFICATIONS, planNotifications } from './reminders';
import type { Collection, Locale, Reminder, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// Reminders minutes before date-time (D-562): 30 minutes before an appointment. Local notification only, writes nothing, exports nothing out of the app (invariants 10, 16).

const visits: Collection = {
  id: 'visits',
  name: 'Appointments',
  fields: [
    { id: 'what', name: 'What', type: 'text' },
    { id: 'at', name: 'At', type: 'datetime' },
    { id: 'day', name: 'Day', type: 'date' },
  ],
};
const soon = (minutes: number, field = 'at'): Reminder => ({
  id: 'soon',
  kind: 'reminder',
  title: 'Appointment soon',
  enabled: true,
  when: { before: { table: 'visits', field }, minutes },
  opens: 'page:home',
});
const now = new Date(2026, 10, 16, 12, 0);
const ctx = { registry, locale: 'en' as const, now };

const setup = (reminder: Reminder) =>
  prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: visits },
      { op: 'addTool', tool: reminder },
    ] as Op[],
    ctx,
  );
function config(reminder: Reminder): WorkspaceConfig {
  const r = setup(reminder);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.after;
}
const problems = (reminder: Reminder) => {
  const r = setup(reminder);
  return r.ok ? [] : r.issues.map(String);
};
const visit = (id: string, at?: string): DataRecord => ({
  id,
  collectionId: 'visits',
  values: { what: `secret ${id}`, ...(at ? { at } : {}) },
  createdAt: 0,
  updatedAt: 0,
});
const plan = (c: WorkspaceConfig, records: DataRecord[], locale: Locale = 'en') =>
  planNotifications(c, new Map([['visits', records]]), now, locale);

describe('a reminder some minutes before a date and time (D-562)', () => {
  it('is accepted on a datetime field, from 1 minute up to 7 days', () => {
    expect(problems(soon(30))).toEqual([]);
    expect(problems(soon(1))).toEqual([]);
    expect(problems(soon(7 * 24 * 60))).toEqual([]);
    expect(problems(soon(0))).not.toEqual([]);
    expect(problems(soon(7 * 24 * 60 + 1))).not.toEqual([]);
  });

  it('is refused on a date field (no time of day), and on a missing field', () => {
    expect(problems(soon(30, 'day')).join()).toMatch(
      /when.before.field must be a datetime field of visits when minutes is set/,
    );
    expect(problems(soon(30, 'nope')).join()).toMatch(/datetime field of visits/);
  });

  it('fires N minutes before each entry, only in the future, with no entry content', () => {
    const c = config(soon(30));
    const planned = plan(c, [
      visit('a', '2026-11-16T15:00'),
      visit('b', '2026-11-16T12:20'), // 11:50, already passed
      visit('c'),
      visit('d', '2026-11-17T00:10'), // Previous day 23:40
    ]);
    expect(planned.map((n) => [n.id, n.trigger])).toEqual([
      ['soon-a', { kind: 'date', at: new Date(2026, 10, 16, 14, 30).getTime() }],
      ['soon-d', { kind: 'date', at: new Date(2026, 10, 16, 23, 40).getTime() }],
    ]);
    for (const n of planned) {
      expect(n.title).toBe('Appointment soon');
      expect(n.body).not.toMatch(/secret/);
      expect(n.body).toContain('Appointments');
    }
    expect(planned[0]!.body).toBe('An entry in “Appointments” is at 15:00, in 30 minutes');
  });

  it('says it in every language, with the singular for one minute', () => {
    const c = config(soon(1));
    const one = [visit('a', '2026-11-16T15:00')];
    expect(plan(c, one, 'en')[0]!.body).toBe('An entry in “Appointments” is at 15:00, in 1 minute');
    expect(plan(c, one, 'fr')[0]!.body).toContain('1 minute');
    expect(plan(c, one, 'fr')[0]!.body).not.toContain('minutes');
    expect(plan(c, one, 'zh')[0]!.body).toContain('1 分钟');
  });

  it('respects the cap on dated notifications (nearest first)', () => {
    const c = config(soon(10));
    const many = Array.from({ length: MAX_DATE_NOTIFICATIONS + 10 }, (_, i) =>
      visit(
        `v${i}`,
        `2026-11-${String(17 + Math.floor(i / 20)).padStart(2, '0')}T${String(i % 20).padStart(2, '0')}:30`,
      ),
    );
    const planned = plan(c, many);
    expect(planned).toHaveLength(MAX_DATE_NOTIFICATIONS);
    const times = planned.map((n) => (n.trigger as { at: number }).at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('is described, and a file lists it', () => {
    const r = setup(soon(30));
    if (!r.ok) throw new Error(String(r.issues));
    expect(r.lines.join()).toContain('30 minutes before “At” in “Appointments”');
    expect(usesOf(r.after).features).toContain('reminderMinutesBefore');
    expect(usesOf(workspace('en')).features ?? []).not.toContain('reminderMinutesBefore');
  });
});

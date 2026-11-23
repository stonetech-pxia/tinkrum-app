import { expect, it } from 'vitest';
import { DEFAULT_CALENDAR } from './calendar';
import { dayNumber } from './formula';
import { monthDays } from './month-view';
import type { Collection } from './schema';
const table: Collection = {
  id: 'events',
  name: 'Events',
  fields: [
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'end', name: 'End', type: 'date' },
    { id: 'n', name: 'N', type: 'number' },
  ],
};
const rows = [
  {
    id: 'a',
    collectionId: 'events',
    values: { date: '2026-10-20', end: '2026-12-10', n: 12 },
    createdAt: 1,
    updatedAt: 1,
  },
];
const now = new Date(2026, 10, 23);
it('includes an entry begun before this month on every covered day', () => {
  const read = monthDays(
    rows,
    table,
    { date: 'date', until: 'end' } as never,
    '2026-11',
    now,
    DEFAULT_CALENDAR,
  );
  expect(read.days.size).toBe(30);
  expect(read.days.get(dayNumber('2026-11-30')!)?.count).toBe(1);
});
it('falls back to the start day when the end is empty or before the start', () => {
  for (const end of [undefined, '2026-10-01']) {
    const read = monthDays(
      [{ ...rows[0]!, values: { date: '2026-11-23', end, n: 12 } }],
      table,
      { date: 'date', until: 'end' } as never,
      '2026-11',
      now,
      DEFAULT_CALENDAR,
    );
    expect(read.days.size).toBe(1);
  }
});
it('computes sums for day cells without changing their records', () => {
  const own = [
    { ...rows[0]!, values: { date: '2026-11-23', n: 12 } },
    { ...rows[0]!, id: 'b', values: { date: '2026-11-23', n: -2 } },
  ];
  const before = JSON.stringify(own);
  const read = monthDays(
    own,
    table,
    { date: 'date', day: { aggregate: 'sum', field: 'n' } } as never,
    '2026-11',
    now,
    DEFAULT_CALENDAR,
  );
  expect(read.days.get(dayNumber('2026-11-23')!)?.value).toBe(10);
  expect(JSON.stringify(own)).toBe(before);
});
it('reads a seven-day range across months, including a spanning entry', () => {
  const read = monthDays(
    rows,
    table,
    { date: 'date', until: 'end' } as never,
    { start: '2026-10-26', end: '2026-11-01' } as never,
    now,
    DEFAULT_CALENDAR,
  );
  expect(read.days.size).toBe(7);
});

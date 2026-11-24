import { describe, expect, it } from 'vitest';

import type { DataRecord } from './data';
import { computeRecords } from './related';
import type { Collection, WorkspaceConfig } from './schema';
import { readNumber, type SourceContext } from './source';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// "Latest" in number blocks (D-618, founder Nov 21, 2026 "do the first three"): the "latest" value
// of a number field in the latest entry, matching the summary field's latest logic: sorted by
// days.date (defaulting to the first date field, then the first datetime field, then creation
// time), with ties broken by later creation time. Entries without dates or without a value in this
// field are excluded.

const people: Collection = {
  id: 'people',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    {
      id: 'latest',
      name: 'Latest weight',
      type: 'rollup',
      table: 'weights',
      via: 'who',
      aggregate: 'latest',
      field: 'kg',
    },
  ],
};
const weights: Collection = {
  id: 'weights',
  name: 'Weights',
  fields: [
    { id: 'who', name: 'Who', type: 'link', table: 'people' },
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'kg', name: 'Weight', type: 'number', decimals: 1 },
    { id: 'logged', name: 'Logged', type: 'date' },
    { id: 'note', name: 'Note', type: 'text' },
    { id: 'price', name: 'Price', type: 'money', currency: 'EUR', currencyField: 'cur' },
    {
      id: 'cur',
      name: 'Currency',
      type: 'choice',
      options: [
        { id: 'eur', label: 'EUR' },
        { id: 'usd', label: 'USD' },
      ],
    },
  ],
};

const record = (
  table: string,
  id: string,
  values: Record<string, unknown>,
  createdAt: number,
): DataRecord => ({ id, collectionId: table, values, createdAt, updatedAt: createdAt });

const base = (): WorkspaceConfig => {
  const config = fromV33(v33Fixture('default-en'));
  config.data.tables.push(...structuredClone([people, weights]));
  return config;
};
const number = (source: object) => ({
  id: 'n1',
  look: 'number',
  show: { label: 'Now' },
  source: { table: 'weights', aggregate: 'latest', ...source },
});
function problems(blocks: unknown[]): string {
  const copy = base();
  copy.containers.pages.find((p) => p.id === 'home')!.blocks.push(...(blocks as never[]));
  const r = validateWorkspace(copy, registry);
  return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
}

const now = new Date(2026, 10, 18, 9);
const rows = [
  record('weights', 'w1', { who: 'ann', date: '2026-11-10', kg: 72.4, logged: '2026-11-17' }, 1),
  record('weights', 'w2', { who: 'ann', date: '2026-11-16', kg: 71.8, logged: '2026-11-11' }, 2),
  // Two entries on the same day: the later created one is considered latest.
  record('weights', 'w3', { who: 'bob', date: '2026-11-15', kg: 80, logged: '2026-11-01' }, 3),
  record('weights', 'w4', { who: 'bob', date: '2026-11-15', kg: 79.5, logged: '2026-11-02' }, 4),
  // Updated on the same day, but no weight: excluded.
  record('weights', 'w5', { who: 'ann', date: '2026-11-17', note: 'forgot' }, 5),
  // No date: excluded.
  record('weights', 'w6', { who: 'bob', kg: 60 }, 6),
];
const ctx = (list: DataRecord[] = rows): SourceContext => ({
  config: base(),
  records: new Map([
    ['weights', list],
    [
      'people',
      [record('people', 'ann', { name: 'Ann' }, 1), record('people', 'bob', { name: 'Bob' }, 2)],
    ],
  ]),
  now,
  locale: 'en',
});

describe('a number block can show the latest value (D-618)', () => {
  it('is accepted on a number field, refused without one or on something that is not a number', () => {
    expect(problems([number({ field: 'kg' })])).toBe('');
    expect(problems([number({ field: 'kg', days: { date: 'logged' } })])).toBe('');
    expect(problems([number({ field: 'kg', group: { by: 'who' } })])).toBe('');
    expect(problems([number({})])).toMatch(
      /latest needs field set to a number, money, rating, duration or formula field/,
    );
    expect(problems([number({ field: 'note' })])).toMatch(/latest needs field set to a number/);
    expect(problems([number({ field: 'kg', days: { unit: 'week' } })])).toMatch(
      /days.unit, perUnit and skip only apply to aggregate "streak"/,
    );
    // Per-entry currency amounts: the latest entry has a different currency from others, making a single number ambiguous.
    expect(problems([number({ field: 'price' })])).toMatch(/price has its own currency/);
  });

  it('reads the newest entry that has a value: by date, later created wins a tie, no date or no value is skipped', () => {
    expect(readNumber({ table: 'weights', aggregate: 'latest', field: 'kg' }, ctx())?.value).toBe(
      71.8,
    );
    const bob = [{ field: 'who', op: 'is' as const, value: 'bob' }];
    expect(
      readNumber({ table: 'weights', aggregate: 'latest', field: 'kg', filter: bob }, ctx())?.value,
    ).toBe(79.5);
    // Another date field.
    expect(
      readNumber(
        { table: 'weights', aggregate: 'latest', field: 'kg', days: { date: 'logged' } },
        ctx(),
      )?.value,
    ).toBe(72.4);
    // By creation time.
    expect(
      readNumber(
        { table: 'weights', aggregate: 'latest', field: 'kg', days: { date: 'createdAt' } },
        ctx(),
      )?.value,
    ).toBe(60);
    // None at all: no value.
    expect(
      readNumber({ table: 'weights', aggregate: 'latest', field: 'kg' }, ctx([]))?.value,
    ).toBeNull();
  });

  it('per group it is the latest of each, the same value the rollup latest shows', () => {
    const read = readNumber(
      { table: 'weights', aggregate: 'latest', field: 'kg', group: { by: 'who' } },
      ctx(),
    );
    const byGroup = Object.fromEntries((read?.groups ?? []).map((g) => [g.optionId, g.value]));
    const c = ctx();
    const rolled = computeRecords(c.config.data.tables, 'people', c.records, now);
    for (const p of rolled) expect(byGroup[p.id]).toBe(p.values.latest);
    expect(byGroup).toMatchObject({ ann: 71.8, bob: 79.5 });
  });

  it('writes nothing: reading twice gives the same and the entries are untouched', () => {
    const list = structuredClone(rows);
    const c = ctx(list);
    const first = readNumber({ table: 'weights', aggregate: 'latest', field: 'kg' }, c);
    expect(readNumber({ table: 'weights', aggregate: 'latest', field: 'kg' }, ctx(list))).toEqual(
      first,
    );
    expect(list).toEqual(rows);
  });
});

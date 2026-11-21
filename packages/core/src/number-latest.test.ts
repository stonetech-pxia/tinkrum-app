import { describe, expect, it } from 'vitest';

import type { DataRecord } from './data';
import { computeRecords } from './related';
import type { Collection, WorkspaceConfig } from './schema';
import { readNumber, type SourceContext } from './source';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// 数字块的「最新」（D-618，创始人 2026-11-21「做前三个」）：最新一条记录的某个数字字段，和汇总字段的 latest 同一个「最新」：
// 按 days.date（默认第一个日期字段，再第一个日期时间字段，再创建时间），同一天后建的算新，没有日期或这个字段没有值的不算。

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
  // 同一天两条：后建的算新。
  record('weights', 'w3', { who: 'bob', date: '2026-11-15', kg: 80, logged: '2026-11-01' }, 3),
  record('weights', 'w4', { who: 'bob', date: '2026-11-15', kg: 79.5, logged: '2026-11-02' }, 4),
  // 更新的一天，但没有体重：不算。
  record('weights', 'w5', { who: 'ann', date: '2026-11-17', note: 'forgot' }, 5),
  // 没有日期：不算。
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
    // 每笔自己选货币的金额：最新一笔的货币和别的不一样，一个数说不清。
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
    // 另一个日期字段。
    expect(
      readNumber(
        { table: 'weights', aggregate: 'latest', field: 'kg', days: { date: 'logged' } },
        ctx(),
      )?.value,
    ).toBe(72.4);
    // 按创建时间。
    expect(
      readNumber(
        { table: 'weights', aggregate: 'latest', field: 'kg', days: { date: 'createdAt' } },
        ctx(),
      )?.value,
    ).toBe(60);
    // 一条都没有：没有值。
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

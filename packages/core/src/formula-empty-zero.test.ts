import { describe, expect, it } from 'vitest';

import { aggregateRecords, recordValue, type DataRecord } from './data';
import { createDefaultWorkspace } from './defaults';
import { applyOps } from './ops';
import { computeRecords, expandCollection } from './related';
import { CollectionSchema, type Collection, type Field } from './schema';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';

// Empty numbers in formulas count as 0 (D-619, founder 2026-11-21 "do the first three"): only
// applies when formula field has empty: "zero", otherwise unchanged (having an empty value yields
// no value). Applies only to numbers (numbers, amounts, ratings, durations, checkboxes, choice
// values, other formulas, lookup and summary numbers); dates and times left empty still have no
// value. Division by zero still yields no value.

const NOW = new Date(2026, 10, 18, 12);

const party = (extra: Partial<Extract<Field, { type: 'formula' }>> = {}): Field => ({
  id: 'party',
  name: 'Coming with plus-ones',
  type: 'formula',
  expression: '{reply} * (1 + {plus})',
  decimals: 0,
  ...extra,
});

const guests = (formula: Field = party({ empty: 'zero' } as never)): Collection => ({
  id: 'guests',
  name: 'Guests',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    {
      id: 'reply',
      name: 'Reply',
      type: 'choice',
      options: [
        { id: 'waiting', label: 'No reply yet', value: 0 },
        { id: 'yes', label: 'Coming', value: 1 },
        { id: 'no', label: 'Not coming', value: 0 },
      ],
    },
    { id: 'plus', name: 'Plus-ones', type: 'number', decimals: 0 },
    { id: 'price', name: 'Price', type: 'money', currency: 'EUR' },
    { id: 'stars', name: 'Stars', type: 'rating' },
    { id: 'time', name: 'Time', type: 'duration' },
    { id: 'vip', name: 'VIP', type: 'checkbox' },
    { id: 'arrive', name: 'Arrives', type: 'date' },
    formula,
    {
      id: 'sum',
      name: 'Everything',
      type: 'formula',
      expression: '{price} + {stars} + {time} + {vip} + {reply}',
      empty: 'zero',
    } as never,
    {
      id: 'share',
      name: 'Share',
      type: 'formula',
      expression: '{price} / {plus}',
      empty: 'zero',
    } as never,
    {
      id: 'wait',
      name: 'Days to arrival',
      type: 'formula',
      expression: 'days(today, {arrive}) + {plus}',
      empty: 'zero',
    } as never,
    {
      id: 'outer',
      name: 'Outer',
      type: 'formula',
      expression: '{share} + 1',
      empty: 'zero',
    } as never,
    {
      id: 'big',
      name: 'Big party',
      type: 'formula',
      expression: 'if({plus} > 1, 1, 0)',
      empty: 'zero',
    } as never,
  ],
});

let seq = 0;
const entry = (values: Record<string, unknown>): DataRecord => ({
  id: `g${++seq}`,
  collectionId: 'guests',
  values,
  createdAt: seq,
  updatedAt: seq,
});

const problems = (...tables: Collection[]) => {
  const result = applyOps(
    createDefaultWorkspace('en'),
    tables.map((table) => ({ op: 'addData' as const, table })),
    { registry, locale: 'en' },
  );
  if (!result.ok) return result.error;
  const checked = validateWorkspace(result.config, registry);
  return checked.ok ? '' : checked.issues.map((i) => i.message).join('\n');
};

describe('empty counts as 0 in a formula, only when asked (D-619)', () => {
  it('is an optional key with one value', () => {
    expect(problems(guests())).toBe('');
    expect(CollectionSchema.safeParse(guests()).success).toBe(true);
    expect(CollectionSchema.safeParse(guests(party({ empty: 'skip' } as never))).success).toBe(
      false,
    );
    expect(CollectionSchema.safeParse(guests(party({ empty: true } as never))).success).toBe(false);
  });

  it('without it nothing changes: an empty plus-ones leaves the headcount empty', () => {
    const table = guests(party());
    const g = entry({ reply: 'yes' });
    expect(recordValue(g, table, 'party', NOW)).toBeUndefined();
    expect(recordValue(entry({ reply: 'yes', plus: 2 }), table, 'party', NOW)).toBe(3);
  });

  it('with it a guest whose plus-ones is empty counts as one', () => {
    const table = guests();
    expect(recordValue(entry({ reply: 'yes' }), table, 'party', NOW)).toBe(1);
    expect(recordValue(entry({ reply: 'yes', plus: 2 }), table, 'party', NOW)).toBe(3);
    // Unanswered (empty radio) also counts as 0.
    expect(recordValue(entry({ plus: 2 }), table, 'party', NOW)).toBe(0);
    const list = [
      entry({ reply: 'yes' }),
      entry({ reply: 'yes', plus: 1 }),
      entry({ reply: 'no' }),
    ];
    expect(
      aggregateRecords(
        computeRecords([table], 'guests', new Map([['guests', list]]), NOW),
        table,
        'sum',
        'party',
      ),
    ).toBe(3);
  });

  it('money, rating, duration, checkbox and choice values count as 0 when empty', () => {
    const table = guests();
    expect(recordValue(entry({}), table, 'sum', NOW)).toBe(0);
    expect(recordValue(entry({ price: 10, vip: true }), table, 'sum', NOW)).toBe(11);
  });

  it('dates stay empty, and dividing by an empty number gives no value, as dividing by 0 always does', () => {
    const table = guests();
    expect(recordValue(entry({ plus: 2 }), table, 'wait', NOW)).toBeUndefined();
    expect(recordValue(entry({ arrive: '2026-11-20' }), table, 'wait', NOW)).toBe(2);
    expect(recordValue(entry({ price: 10 }), table, 'share', NOW)).toBeUndefined();
    expect(recordValue(entry({ price: 10, plus: 4 }), table, 'share', NOW)).toBe(2.5);
    // Also counts as 0 when another formula has no value (here division by zero).
    expect(recordValue(entry({ price: 10 }), table, 'outer', NOW)).toBe(1);
    // If comparisons also treat empty numbers as 0.
    expect(recordValue(entry({}), table, 'big', NOW)).toBe(0);
  });

  it('numbers that come from a lookup or a rollup count as 0 when empty', () => {
    const tables: Collection[] = [
      {
        id: 'parties',
        name: 'Parties',
        fields: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'extra', name: 'Extra', type: 'number' },
          {
            id: 'heads',
            name: 'Heads',
            type: 'rollup',
            table: 'people',
            via: 'party',
            aggregate: 'max',
            field: 'n',
          },
          {
            id: 'total',
            name: 'Total',
            type: 'formula',
            expression: '{heads} + {extra}',
            empty: 'zero',
          } as never,
        ],
      },
      {
        id: 'people',
        name: 'People',
        fields: [
          { id: 'party', name: 'Party', type: 'link', table: 'parties' },
          { id: 'n', name: 'N', type: 'number' },
          { id: 'extra', name: 'Extra', type: 'lookup', via: 'party', field: 'extra' },
          {
            id: 'plus',
            name: 'Plus',
            type: 'formula',
            expression: '{n} + {extra}',
            empty: 'zero',
          } as never,
        ],
      },
    ];
    expect(problems(...tables)).toBe('');
    const records = new Map<string, DataRecord[]>([
      ['parties', [{ id: 'p1', collectionId: 'parties', values: {}, createdAt: 0, updatedAt: 0 }]],
      [
        'people',
        [
          {
            id: 'x1',
            collectionId: 'people',
            values: { party: 'p1', n: 2 },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ],
    ]);
    const parties = computeRecords(tables, 'parties', records, NOW);
    expect(recordValue(parties[0]!, expandCollection(tables, tables[0]!), 'total', NOW)).toBe(2);
    const noOne = computeRecords(tables, 'parties', new Map([...records, ['people', []]]), NOW);
    expect(recordValue(noOne[0]!, expandCollection(tables, tables[0]!), 'total', NOW)).toBe(0);
    const people = computeRecords(tables, 'people', records, NOW);
    expect(recordValue(people[0]!, expandCollection(tables, tables[1]!), 'plus', NOW)).toBe(2);
  });

  it('is refused on a formula that reads no number (it would change nothing)', () => {
    const table = guests();
    table.fields.push({
      id: 'late',
      name: 'Late',
      type: 'formula',
      expression: 'days({arrive}, today)',
      empty: 'zero',
    } as never);
    expect(problems(table)).toMatch(/guests.late: empty "zero" only changes number fields/);
  });

  it('writes nothing: the value is computed when read, never stored', () => {
    const table = guests();
    const g = entry({ reply: 'yes' });
    const before = structuredClone(g);
    expect(recordValue(g, table, 'party', NOW)).toBe(1);
    expect(g).toEqual(before);
  });
});

import { describe, expect, it } from 'vitest';
import { prepareOps } from './change';
import type { NumberSource } from './components/number';
import type { Collection, NewComponent } from './schema';
import { readNumber, sourceTableIds, type SourceContext } from './source';
import { fromV33, registry, v33Fixture } from './test-helpers';

const tables: Collection[] = ['cost', 'income'].map((id) => ({
  id,
  name: id,
  fields: [
    { id: 'amount', name: 'Amount', type: 'money', currency: 'EUR' },
    { id: 'date', name: 'Date', type: 'date' },
  ],
}));
const config = fromV33(v33Fixture('default-en'));
config.data.tables.push(...tables);
const records = new Map(
  tables.map((t) => [
    t.id,
    [
      {
        id: 'old',
        collectionId: t.id,
        values: { amount: t.id === 'income' ? 2000 : 1000, date: '2026-10-01' },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'new',
        collectionId: t.id,
        values: { amount: t.id === 'cost' ? 30 : 100, date: '2026-11-02' },
        createdAt: 2,
        updatedAt: 2,
      },
    ],
  ]),
);
const ctx: SourceContext = { config, records, now: new Date(2026, 10, 23), locale: 'en' };
const base = { table: 'cost', aggregate: 'sum', field: 'amount' } as const;
const calc = {
  with: [{ id: 'income', table: 'income', aggregate: 'sum', field: 'amount' }],
  formula: '({income} - {total}) / {income}',
  as: 'percent',
} as const;
function source(extra: object): NumberSource {
  return { ...base, ...extra } as NumberSource;
}
function issues(extra: object) {
  const block = {
    look: 'number',
    id: 'savings',
    show: { label: 'Savings' },
    source: source(extra),
  } as NewComponent;
  const result = prepareOps(config, [{ op: 'addContainer', page: 'home', block }], {
    registry,
    locale: 'en',
    now: ctx.now,
  });
  return result.ok ? '' : result.issues.join('\n');
}
describe('named totals', () => {
  it('computes a ratio on the selected page range for every operand', () => {
    const read = readNumber(source({ calc, period: 'page' }), {
      ...ctx,
      range: { start: '2026-11-01', end: '2026-11-30' },
    } as SourceContext);
    expect(read?.value).toBe(0.7);
  });
  it('subtracts only the selected period from an existing minus block', () => {
    expect(
      readNumber(
        source({ period: 'page', minus: { table: 'income', aggregate: 'sum', field: 'amount' } }),
        { ...ctx, range: { start: '2026-11-01', end: '2026-11-30' } } as SourceContext,
      )?.value,
    ).toBe(-70);
  });
  it('tracks all operand tables', () =>
    expect(sourceTableIds(source({ calc }), config)).toContain('income'));
  it('accepts the general calculation and rejects unknown, unused and reserved names', () => {
    expect(issues({ calc })).toBe('');
    expect(issues({ calc: { ...calc, formula: '{unknown} + {total}' } })).not.toBe('');
    expect(issues({ calc: { ...calc, formula: '{total}' } })).not.toBe('');
    expect(issues({ calc: { ...calc, with: [{ ...calc.with[0], id: 'total' }] } })).not.toBe('');
  });
  it('refuses grouping, comparison, minus, date functions and mixed currencies', () => {
    for (const extra of [
      { group: { by: 'date' } },
      { compare: 'previous' },
      { minus: { table: 'income', aggregate: 'count' } },
    ])
      expect(issues({ calc, ...extra })).not.toBe('');
    expect(issues({ calc: { ...calc, formula: 'days(today, today) + {income}' } })).not.toBe('');
    const foreign = structuredClone(config);
    foreign.data.tables.find((t) => t.id === 'income')!.fields[0] = {
      id: 'amount',
      name: 'Amount',
      type: 'money',
      currency: 'USD',
    };
    const result = prepareOps(
      foreign,
      [
        {
          op: 'addContainer',
          page: 'home',
          block: {
            id: 'ratio',
            look: 'number',
            show: { label: 'Ratio' },
            source: source({ calc }),
          },
        },
      ],
      { registry, locale: 'en', now: ctx.now },
    );
    expect(result.ok).toBe(false);
  });
  it('division by zero and missing average yield an empty result', () => {
    const empty = { ...ctx, records: new Map() };
    expect(readNumber(source({ calc }), empty)?.value).toBeNull();
    expect(
      readNumber(
        source({ calc: { ...calc, with: [{ ...calc.with[0], aggregate: 'avg' }] } }),
        empty,
      )?.value,
    ).toBeNull();
  });
});

it('page ranges override inPeriod on the subtracted total, not only its records', () => {
  const minus = {
    table: 'income',
    aggregate: 'sum',
    field: 'amount',
    filter: [{ field: 'date', op: 'inPeriod', value: 'lastMonth' }],
  };
  expect(
    readNumber(source({ period: 'page', minus }), {
      ...ctx,
      range: { start: '2026-11-01', end: '2026-11-30' },
    })?.value,
  ).toBe(-70);
});

it('named numeric totals may have a name also used by a date keyword', () => {
  const own = { ...calc, with: [{ ...calc.with[0], id: 'today' }], formula: '{today} - {total}' };
  expect(issues({ calc: own })).toBe('');
});

it('describes formulas with table and field names instead of internal total ids', async () => {
  const { componentLabel, describeChange } = await import('./describe');
  const named = structuredClone(config);
  named.data.tables.find((t) => t.id === 'cost')!.name = 'Spending';
  named.data.tables.find((t) => t.id === 'income')!.name = 'Earnings';
  const block = {
    id: 'savings',
    look: 'number',
    show: { label: 'Savings' },
    source: source({ calc }),
  } as const;
  named.containers.pages.find((p) => p.id === 'home')!.blocks.push(block);
  for (const locale of ['en', 'zh', 'fr'] as const) {
    const label = componentLabel(block, named, { registry, locale, now: ctx.now });
    expect(label).toContain('Earnings');
    expect(label).toContain('Spending');
    expect(label).not.toContain('{total}');
    expect(label).not.toContain('{income}');
    const lines = describeChange(
      [
        {
          op: 'updateContainer',
          page: 'home',
          block: 'savings',
          changes: { source: { calc: { formula: '{total} / {income}' } } },
        },
      ],
      named,
      [],
      { registry, locale, now: ctx.now },
    ).join('\n');
    expect(lines).toContain('Earnings');
  }
});

it('formats tiny finite formula results in every language without losing the computed value', async () => {
  const { calculatedText } = await import('./stat-calc');
  for (const locale of ['en', 'zh', 'fr'] as const) {
    expect(calculatedText(1e-9, { ...calc, with: [...calc.with], as: 'number' }, locale)).toBe('0');
    expect(calculatedText(1e-10, { ...calc, with: [...calc.with], as: 'percent' }, locale)).toBe(
      locale === 'fr' ? '0 %' : '0%',
    );
  }
  const own = {
    ...calc,
    formula: '{total} / {income} / 1000000000',
    with: [...calc.with],
    as: 'number',
  };
  expect(readNumber(source({ calc: own }), ctx)?.value).toBeGreaterThan(0);
});

it('shows float noise as a clean number: 0.29 is 29%, not 29.0000%', async () => {
  const { calculatedText } = await import('./stat-calc');
  for (const locale of ['en', 'zh'] as const) {
    expect(calculatedText(0.29, { ...calc, with: [...calc.with], as: 'percent' }, locale)).toBe(
      '29%',
    );
    expect(calculatedText(0.07, { ...calc, with: [...calc.with], as: 'percent' }, locale)).toBe(
      '7%',
    );
    expect(calculatedText(10.1 - 10, { ...calc, with: [...calc.with], as: 'number' }, locale)).toBe(
      '0.1',
    );
  }
});

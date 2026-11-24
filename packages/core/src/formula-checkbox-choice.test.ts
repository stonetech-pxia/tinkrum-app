import { describe, expect, it } from 'vitest';

import { recordValue, type DataRecord } from './data';
import { createDefaultWorkspace } from './defaults';
import { usesOf } from './file-uses';
import { applyOps } from './ops';
import { computeRecords, expandCollection } from './related';
import { fieldDefinition, type Collection, type Field } from './schema';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';

// D-569: Formulas can read checkboxes (checked is 1, unchecked is 0) and radio choices (selected
// option's value, D-568). When unselected or selected option has no value, behaves like an empty
// number: formula has no value. No new syntax: comparisons remain only in the first term of if.

const NOW = new Date(2026, 10, 16, 12);

const subs: Collection = {
  id: 'subs',
  name: 'Subscriptions',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'price', name: 'Price', type: 'money', currency: 'USD' },
    { id: 'paid', name: 'Paid', type: 'checkbox' },
    {
      id: 'cycle',
      name: 'Billing cycle',
      type: 'choice',
      options: [
        { id: 'monthly', label: 'Monthly', value: 12 },
        { id: 'yearly', label: 'Yearly', value: 1 },
        { id: 'trial', label: 'Trial' },
      ],
    },
    { id: 'yearly-cost', name: 'Per year', type: 'formula', expression: '{price} * {cycle}' },
    { id: 'due', name: 'Due', type: 'formula', expression: '{price} * (1 - {paid})' },
    { id: 'due-if', name: 'Due (if)', type: 'formula', expression: 'if({paid} = 1, 0, {price})' },
  ],
};

let seq = 0;
const entry = (values: Record<string, unknown>, collectionId = 'subs'): DataRecord => ({
  id: `r${++seq}`,
  collectionId,
  values,
  createdAt: 0,
  updatedAt: 0,
});
const value = (r: DataRecord, field: string, table = subs) => recordValue(r, table, field, NOW);

const withTables = (...tables: Collection[]) =>
  applyOps(
    createDefaultWorkspace('en'),
    tables.map((table) => ({ op: 'addData' as const, table })),
    { registry, locale: 'en' },
  );
const problems = (...tables: Collection[]) => {
  const result = withTables(...tables);
  if (!result.ok) return result.error;
  const checked = validateWorkspace(result.config, registry);
  return checked.ok ? '' : checked.issues.map((i) => i.message).join('\n');
};

describe('a checkbox in a formula is 1 when ticked and 0 when not (D-569)', () => {
  it('works as a factor and as the comparison of if', () => {
    const paid = entry({ price: 10, paid: true });
    const open = entry({ price: 10, paid: false });
    expect(value(paid, 'due')).toBe(0);
    expect(value(open, 'due')).toBe(10);
    expect(value(paid, 'due-if')).toBe(0);
    expect(value(open, 'due-if')).toBe(10);
  });

  it('an entry saved before the checkbox existed counts as not ticked, as it is shown', () => {
    expect(value(entry({ price: 7 }), 'due')).toBe(7);
  });
});

describe('a choice in a formula is the value of the chosen option (D-569)', () => {
  it('multiplies by the value of the option', () => {
    expect(value(entry({ price: 5, cycle: 'monthly' }), 'yearly-cost')).toBe(60);
    expect(value(entry({ price: 50, cycle: 'yearly' }), 'yearly-cost')).toBe(50);
  });

  it('no option chosen, an option without a value or a removed option give no value', () => {
    expect(value(entry({ price: 5 }), 'yearly-cost')).toBeUndefined();
    expect(value(entry({ price: 5, cycle: 'trial' }), 'yearly-cost')).toBeUndefined();
    expect(value(entry({ price: 5, cycle: 'gone' }), 'yearly-cost')).toBeUndefined();
  });

  it('the table passes validation', () => {
    expect(problems(subs)).toBe('');
  });

  it('a choice none of whose options has a value is refused with a sentence the AI can act on', () => {
    const plain: Collection = {
      ...subs,
      fields: subs.fields.map((f) =>
        f.type === 'choice'
          ? { ...f, options: f.options.map(({ id, label }) => ({ id, label })) }
          : f,
      ),
    };
    const message = problems(plain);
    expect(message).toMatch(/cycle/);
    expect(message).toMatch(/none of its options has a value/);
    expect(message).toMatch(/value: 12/);
  });
});

describe('lookups and rollups over them (D-569)', () => {
  const clients: Collection = {
    id: 'clients',
    name: 'Clients',
    fields: [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'vip', name: 'VIP', type: 'checkbox' },
      {
        id: 'tier',
        name: 'Tier',
        type: 'choice',
        options: [
          { id: 'gold', label: 'Gold', value: 0.8 },
          { id: 'basic', label: 'Basic', value: 1 },
        ],
      },
      {
        id: 'paid-count',
        name: 'Paid',
        type: 'rollup',
        table: 'bills',
        via: 'client',
        aggregate: 'sum',
        field: 'is-paid',
      },
    ],
  };
  const bills: Collection = {
    id: 'bills',
    name: 'Bills',
    fields: [
      { id: 'amount', name: 'Amount', type: 'money', currency: 'USD' },
      { id: 'paid', name: 'Paid', type: 'checkbox' },
      { id: 'client', name: 'Client', type: 'link', table: 'clients' },
      { id: 'client-tier', name: 'Tier', type: 'lookup', via: 'client', field: 'tier' },
      { id: 'client-vip', name: 'VIP', type: 'lookup', via: 'client', field: 'vip' },
      { id: 'is-paid', name: 'Is paid', type: 'formula', expression: '{paid}' },
      {
        id: 'net',
        name: 'Net',
        type: 'formula',
        expression: '{amount} * {client-tier} - {client-vip}',
      },
    ],
  };
  const tables = [clients, bills];

  it('a lookup of a choice or a checkbox reads like the field it shows', () => {
    expect(problems(clients, bills)).toBe('');
    const gold = entry({ name: 'Ada', vip: true, tier: 'gold' }, 'clients');
    const bill = entry({ amount: 100, paid: true, client: gold.id }, 'bills');
    const records = new Map([
      ['clients', [gold]],
      ['bills', [bill]],
    ]);
    const [computed] = computeRecords(tables, 'bills', records, NOW);
    expect(recordValue(computed!, expandCollection(tables, bills), 'net', NOW)).toBe(79);
  });

  it('a rollup sums a formula that reads a checkbox (the number of paid bills)', () => {
    const ada = entry({ name: 'Ada' }, 'clients');
    const records = new Map([
      ['clients', [ada]],
      [
        'bills',
        [
          entry({ amount: 1, paid: true, client: ada.id }, 'bills'),
          entry({ amount: 2, paid: false, client: ada.id }, 'bills'),
          entry({ amount: 3, paid: true, client: ada.id }, 'bills'),
        ],
      ],
    ]);
    const [computed] = computeRecords(tables, 'clients', records, NOW);
    expect(recordValue(computed!, expandCollection(tables, clients), 'paid-count', NOW)).toBe(2);
  });

  it('a rollup cannot sum a checkbox or a choice directly (they are not numbers for stats)', () => {
    const direct = (field: string): Field => ({
      id: 'x',
      name: 'X',
      type: 'rollup',
      table: 'bills',
      via: 'client',
      aggregate: 'sum',
      field,
    });
    expect(problems({ ...clients, fields: [...clients.fields, direct('paid')] }, bills)).not.toBe(
      '',
    );
  });
});

it('an exported file names it as a feature', () => {
  const result = withTables(subs);
  if (!result.ok) throw new Error(result.error);
  expect(usesOf(result.config).features).toContain('formulaReadsCheckboxOrChoice');
  const plain = withTables({ ...subs, fields: subs.fields.filter((f) => f.type !== 'formula') });
  if (!plain.ok) throw new Error(plain.error);
  expect(usesOf(plain.config).features ?? []).not.toContain('formulaReadsCheckboxOrChoice');
});

it('the AI is told how to use them', () => {
  const doc = fieldDefinition('formula').ai.doc;
  expect(doc).toMatch(/checkbox \(1 or 0\)/);
  expect(doc).toMatch(/choice \(the value of the chosen option; rule 32\)/);
});

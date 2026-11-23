import { expect, it } from 'vitest';
import { fillRecordTemplate } from './record-template';
import type { Collection } from './schema';
const table: Collection = {
  id: 't',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'link', name: 'Owner', type: 'link', table: 'p' },
  ],
};
it('fills displayed values once, keeps unknown placeholders and reports them', () => {
  const r = fillRecordTemplate(
    '{Name} / {Owner} / {Missing}',
    table,
    {
      id: 'r',
      collectionId: 't',
      values: { name: '{Owner}', link: 'p1' },
      createdAt: 1,
      updatedAt: 1,
    },
    'fr',
    () => 'Marie',
  );
  expect(r).toEqual({ text: '{Owner} / Marie / {Missing}', missing: ['Missing'] });
});
it('does not guess when two fields have the same name', () => {
  const c = {
    ...table,
    fields: [...table.fields, { id: 'other', name: 'Name', type: 'text' as const }],
  };
  expect(
    fillRecordTemplate(
      '{Name}',
      c,
      { id: 'r', collectionId: 't', values: { name: 'A', other: 'B' }, createdAt: 1, updatedAt: 1 },
      'en',
    ),
  ).toEqual({ text: '{Name}', missing: ['Name'] });
});
it('uses the currency selected on the entry', () => {
  const c: Collection = {
    id: 't',
    name: 'Claims',
    fields: [
      { id: 'amount', name: 'Amount', type: 'money', currency: 'USD', currencyField: 'currency' },
      { id: 'currency', name: 'Currency', type: 'choice', options: [{ id: 'eur', label: 'EUR' }] },
    ],
  };
  const r = {
    id: 'r',
    collectionId: 't',
    values: { amount: 12.5, currency: 'eur' },
    createdAt: 1,
    updatedAt: 1,
  };
  expect(fillRecordTemplate('{Amount}', c, r, 'fr').text).toContain('€');
});

import { describe, expect, it } from 'vitest';

import { checkAppFileText } from './app-file-check';
import { pastTextValues } from './browse-filter';
import type { DataRecord } from './data';
import { createDefaultWorkspace } from './defaults';
import { describeChange } from './describe';
import { missingUses, usesOf, USES_FEATURES } from './file-uses';
import type { Op } from './ops';
import { CURRENT_SCHEMA_VERSION, FieldSchema } from './schema';
import { apply, registry } from './test-helpers';

// D-642: a text field with suggest: true offers, under its input, the
// values already saved in that field, so a name typed again and again is filled with a tap. The list
// is computed from the entries when the form is shown and is never stored.

const now = new Date(2026, 10, 25, 9);

const addShops = (field: object): Op =>
  ({
    op: 'addData',
    table: {
      id: 'spending',
      name: 'Spending',
      fields: [{ id: 'merchant', name: 'Merchant', type: 'text', ...field }],
    },
  }) as Op;

const withShops = (field: object = { suggest: true }) =>
  apply(createDefaultWorkspace('en'), [addShops(field)], 'en');

const merchantOf = (config: ReturnType<typeof withShops>) =>
  config.data.tables.find((t) => t.id === 'spending')!.fields[0]!;

describe('suggest on a text field', () => {
  it('is accepted as true on a text field only', () => {
    expect(merchantOf(withShops())).toMatchObject({ type: 'text', suggest: true });
    const field = { id: 'merchant', name: 'Merchant', type: 'text' };
    expect(FieldSchema.safeParse({ ...field, suggest: true }).success).toBe(true);
    expect(FieldSchema.safeParse({ ...field, suggest: false }).success).toBe(false);
    for (const type of ['note', 'number'])
      expect(FieldSchema.safeParse({ ...field, type, suggest: true }).success).toBe(false);
  });

  it('is turned on and off with updateData, and the change says so', () => {
    const plain = withShops({});
    const on: Op = {
      op: 'updateData',
      table: 'spending',
      field: 'merchant',
      changes: { suggest: true },
    };
    const turnedOn = apply(plain, [on], 'en');
    expect(merchantOf(turnedOn)).toMatchObject({ suggest: true });
    const off: Op = { ...on, changes: { suggest: null } } as Op;
    expect(merchantOf(apply(turnedOn, [off], 'en'))).not.toHaveProperty('suggest');
    const say = (op: Op, before: typeof plain) =>
      describeChange([op], before, [], { registry, locale: 'en', now }).join('\n');
    expect(say(on, plain)).toContain('earlier values are offered while filling in');
    expect(say(off, turnedOn)).toContain('earlier values are no longer offered');
  });

  it('is listed as a requirement of files that use it', () => {
    expect(usesOf(withShops()).features).toContain('textSuggest');
    expect(usesOf(withShops({})).features ?? []).not.toContain('textSuggest');
    expect(USES_FEATURES).toContain('textSuggest');
    expect(missingUses(JSON.stringify({ uses: { features: ['textSuggest'] } }), registry)).toEqual(
      [],
    );
  });

  it('passes the app file check', () => {
    const result = checkAppFileText(
      JSON.stringify({
        format: 'tinkrum-app',
        version: 1,
        exportedAt: now.toISOString(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        app: {
          id: 'money',
          name: 'Money',
          bar: ['page:money-home', 'ai'],
          theme: createDefaultWorkspace('en').theme,
        },
        tables: [
          {
            id: 'money-spending',
            name: 'Spending',
            fields: [{ id: 'merchant', name: 'Merchant', type: 'text', suggest: true }],
          },
        ],
        tools: [],
        pages: [{ id: 'money-home', title: 'Money', blocks: [] }],
      }),
      { registry, locale: 'en', now },
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('pastTextValues', () => {
  const view = () => withShops().data.tables.find((t) => t.id === 'spending')!;
  const entry = (merchant: unknown, updatedAt: number): DataRecord => ({
    id: `r${updatedAt}`,
    collectionId: 'spending',
    values: { merchant },
    createdAt: updatedAt,
    updatedAt,
  });
  const saved = [
    entry('Aldi', 1),
    entry('carrefour', 2),
    entry('Boulangerie Paul', 3),
    entry('Carrefour', 4),
    entry('  ', 5),
    entry(42, 6),
    entry('Carrefour City', 7),
    entry('Aldi ', 8),
  ];
  const offered = (typed: unknown, limit = 8) =>
    pastTextValues(saved, view(), 'merchant', typed, limit);

  it('lists each saved value once, the latest saved first, in its latest spelling', () => {
    expect(offered('')).toEqual(['Aldi', 'Carrefour City', 'Carrefour', 'Boulangerie Paul']);
    expect(offered(undefined)).toEqual(offered(''));
  });

  it('keeps those containing what is typed, ignoring case and character width', () => {
    expect(offered('CARRE')).toEqual(['Carrefour City', 'Carrefour']);
    expect(offered('ｐａｕｌ')).toEqual(['Boulangerie Paul']);
    expect(offered('Lidl')).toEqual([]);
  });

  it('leaves out what the field already says, but offers another spelling of it', () => {
    expect(offered('Carrefour')).toEqual(['Carrefour City']);
    expect(offered('boulangerie paul')).toEqual(['Boulangerie Paul']);
    expect(offered('Aldi')).toEqual([]);
  });

  it('stops at the limit', () => {
    expect(offered('', 2)).toEqual(['Aldi', 'Carrefour City']);
  });
});

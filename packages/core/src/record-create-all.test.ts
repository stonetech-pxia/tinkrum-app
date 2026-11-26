import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { usesOf } from './file-uses';
import {
  MAX_CREATE_ALL,
  RECORD_TOOL_KINDS,
  RecordToolSchema,
  createAllInputs,
  type RecordTool,
} from './record-ops';
import { computeRecords, expandCollection } from './related';
import type { Collection, WorkspaceConfig } from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// Batch creation (D-567, founder 2026-11-16 decision ④): For every entry filtered in table A,
// create a new entry in table B. Ask first, at most 200 entries, executed one by one by the engine
// (no loops in config), and any errors can be undone in batch with a single undo. "$row" refers to
// the source entry, and its values can be copied (D-565).
process.env.TZ = 'Europe/Paris';
const now = new Date(2026, 10, 1, 9, 0);

const customers: Collection = {
  id: 'customers',
  name: 'Customers',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'regular', name: 'Regular', type: 'checkbox' },
    { id: 'usual', name: 'Usual amount', type: 'money', currency: 'EUR' },
  ],
};
const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'customer', name: 'Customer', type: 'link', table: 'customers' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'EUR' },
    { id: 'on', name: 'On', type: 'date', required: true },
    { id: 'note', name: 'Note', type: 'text' },
  ],
};

const base = (): WorkspaceConfig => {
  const config = fromV33(v33Fixture('default-en'));
  config.data.tables.push(...structuredClone([customers, orders]));
  return config;
};
const monthly = {
  do: 'createAll',
  table: 'orders',
  from: 'customers',
  filter: [{ field: 'regular', op: 'is', value: true }],
  values: { customer: '$row', amount: { copy: 'usual' }, on: 'today' },
};
const button = (tool: unknown) => ({
  id: 'b1',
  look: 'button',
  show: { label: "Create this month's orders", shape: 'filled' },
  tools: [tool],
});
function problems(blocks: unknown[], config = base()): string {
  const copy = structuredClone(config);
  copy.containers.pages.find((p) => p.id === 'home')!.blocks.push(...(blocks as never[]));
  const r = validateWorkspace(copy, registry);
  return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
}

describe('bulk create (D-567)', () => {
  it('is the sixth record tool kind, with a fixed cap of 200', () => {
    // The seventh kind, remove, was added by D-610 (only for attendance/check-in grid cells).
    expect(RECORD_TOOL_KINDS).toEqual([
      'create',
      'set',
      'toggle',
      'increment',
      'setAll',
      'createAll',
      'remove',
    ]);
    expect(MAX_CREATE_ALL).toBe(200);
    expect(RecordToolSchema.safeParse(monthly).success).toBe(true);
    for (const skip of [{ confirm: false }, { ask: 'all' }, { max: 1000 }, { also: [] }])
      expect(RecordToolSchema.safeParse({ ...monthly, ...skip }).success).toBe(false);
  });

  it('a button creates one order for each regular customer', () => {
    expect(problems([button(monthly)])).toBe('');
  });

  it('checks the source, its filter, the values and required fields', () => {
    expect(problems([button({ ...monthly, from: 'nope' })])).toMatch(
      /data table nope does not exist/,
    );
    expect(problems([button({ ...monthly, filter: [{ field: 'nope', op: 'isEmpty' }] })])).toMatch(
      /nope/,
    );
    // "$row" is the source entry: reference fields must point to the source table.
    expect(
      problems([button({ ...monthly, from: 'orders', table: 'orders', filter: undefined })]),
    ).toMatch(
      /link field orders\.customer can only be "\$row" \(this entry\) and must point at orders/,
    );
    // Copies fields from the source entry.
    expect(
      problems([button({ ...monthly, values: { ...monthly.values, amount: { copy: 'nope' } } })]),
    ).toMatch(/copy nope is not a field of customers/);
    // Required date has no value: every entry fails to save.
    expect(problems([button({ ...monthly, values: { customer: '$row' } })])).toMatch(
      /required field on would be empty/,
    );
    // Text constants are still not allowed (D-301).
    expect(problems([button({ ...monthly, values: { ...monthly.values, note: 'x' } })])).toMatch(
      /orders\.note is a text field/,
    );
  });

  it('only sits where setAll sits: not on a row, a tile or a reminder’s done', () => {
    expect(
      problems([
        {
          id: 'l1',
          look: 'list',
          source: { table: 'customers', limit: 30 },
          show: { title: 'name' },
          tools: [{ as: 'button', label: 'All', ...monthly }],
        },
      ]),
      // Since D-616 allows selection and creation below lists, rejection messages are updated to point to button blocks and selection syntax; buttons on individual rows are still not allowed.
    ).toMatch(/createAll on every entry a filter selects belongs on a button block/);
  });

  it('works out one new entry per matching source entry, linking and copying from it', () => {
    const tables = [customers, orders];
    const source: DataRecord[] = [
      {
        id: 'c1',
        collectionId: 'customers',
        values: { name: 'Ana', regular: true, usual: 40 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'c2',
        collectionId: 'customers',
        values: { name: 'Bo', regular: false, usual: 10 },
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'c3',
        collectionId: 'customers',
        values: { name: 'Cy', regular: true },
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const computed = computeRecords(tables, 'customers', new Map([['customers', source]]), now);
    const inputs = createAllInputs(
      monthly as Extract<RecordTool, { do: 'createAll' }>,
      orders,
      expandCollection(tables, customers),
      computed,
      { now },
    );
    expect(inputs).toEqual([
      { sourceId: 'c1', input: { customer: 'c1', amount: 40, on: '2026-11-01' } },
      { sourceId: 'c3', input: { customer: 'c3', amount: '', on: '2026-11-01' } },
    ]);
  });

  it('deleting the source table or a field it reads removes the button (invariant 18)', () => {
    const config = base();
    config.containers.pages.find((p) => p.id === 'home')!.blocks.push(button(monthly) as never);
    const ctx = { registry, locale: 'en' as const, now };
    for (const op of [
      { op: 'removeData', table: 'customers', field: 'usual' },
      { op: 'removeData', table: 'customers', field: 'regular' },
      { op: 'removeData', table: 'orders', field: 'amount' },
    ]) {
      const r = prepareOps(config, [op as never], ctx);
      expect(r.ok, JSON.stringify(op)).toBe(true);
      if (r.ok)
        expect(
          r.after.containers.pages.find((p) => p.id === 'home')!.blocks.some((b) => b.id === 'b1'),
        ).toBe(false);
    }
  });

  it('an exported file lists it (D-556)', () => {
    const config = base();
    config.containers.pages.find((p) => p.id === 'home')!.blocks.push(button(monthly) as never);
    expect(usesOf(config).features).toContain('createAll');
  });
});

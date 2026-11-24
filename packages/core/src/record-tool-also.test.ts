import { describe, expect, it } from 'vitest';

import { usesOf } from './file-uses';
import { MAX_TAP_WRITES, ToolUseSchema, tapWrites, type RecordToolUse } from './record-ops';
import { ReminderSchema, type Collection, type WorkspaceConfig } from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// Modify two or three places on this record with a single tap (D-566, founder decision 2026-11-16
// ③): at most 3 places, all restricted to this record (or creating a new record linked back to this
// record), forming a fixed flat list (no conditions, loops, nesting, or triggering other tools;
// invariant 9); all succeed or none do; followed by an undo banner (invariant 11).

const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'item', name: 'Item', type: 'text' },
    {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'new', label: 'New' },
        { id: 'shipped', label: 'Shipped' },
      ],
    },
    { id: 'shipped', name: 'Shipped on', type: 'date' },
    { id: 'parcels', name: 'Parcels', type: 'number' },
    { id: 'paid', name: 'Paid', type: 'checkbox' },
  ],
};
const events: Collection = {
  id: 'events',
  name: 'Events',
  fields: [
    { id: 'order', name: 'Order', type: 'link', table: 'orders' },
    { id: 'on', name: 'On', type: 'date' },
  ],
};

const base = (): WorkspaceConfig => {
  const config = fromV33(v33Fixture('default-en'));
  config.data.tables.push(...structuredClone([orders, events]));
  return config;
};
const list = (tools: unknown[], look = 'list') => ({
  id: 'l1',
  look,
  source: { table: 'orders', limit: 30 },
  show: { title: 'item' },
  tools,
});
function problems(blocks: unknown[], config = base()): string {
  const copy = structuredClone(config);
  copy.containers.pages.find((p) => p.id === 'home')!.blocks.push(...(blocks as never[]));
  const r = validateWorkspace(copy, registry);
  return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
}

const ship = {
  as: 'button',
  label: 'Ship',
  do: 'set',
  table: 'orders',
  field: 'status',
  value: 'shipped',
  also: [{ do: 'set', field: 'shipped', value: 'today' }],
};

describe('one tap, up to three changes to this entry (D-566)', () => {
  it('a Ship button sets the status and the ship date', () => {
    expect(ToolUseSchema.safeParse(ship).success).toBe(true);
    expect(problems([list([ship])])).toBe('');
    // Three places: set value, check, increment/decrement, plus one new record linked back to this record (at most one new record).
    expect(
      problems([
        list([
          {
            ...ship,
            also: [
              { do: 'toggle', field: 'paid' },
              { do: 'create', table: 'events', values: { order: '$row', on: 'today' } },
            ],
          },
        ]),
      ]),
    ).toBe('');
    expect(problems([list([{ ...ship, as: 'tap' }], 'tiles')])).toBe('');
  });

  it('is a flat, fixed list of at most 3 writes: no setAll, no ask, no nesting, no tool', () => {
    expect(MAX_TAP_WRITES).toBe(3);
    const bad = [
      { ...ship, also: [] },
      {
        ...ship,
        also: [
          { do: 'toggle', field: 'paid' },
          { do: 'increment', field: 'parcels', by: 1 },
          { do: 'set', field: 'item', value: null },
        ],
      },
      { ...ship, also: [{ do: 'setAll', field: 'paid', value: true }] },
      { ...ship, also: [{ do: 'create', table: 'events', values: {}, ask: 'all' }] },
      { ...ship, also: [{ ...ship.also[0], also: [{ do: 'toggle', field: 'paid' }] }] },
      { ...ship, also: [{ tool: 'pdf-merge' }] },
      { ...ship, also: [{ do: 'set', field: 'paid', value: true, when: [] }] },
      // setAll and batch creation themselves cannot include this.
      { do: 'setAll', table: 'orders', field: 'paid', value: true, also: [ship.also[0]] },
    ];
    for (const use of bad)
      expect(ToolUseSchema.safeParse(use).success, JSON.stringify(use)).toBe(false);
  });

  it('every write stays on this entry, or creates one entry linked back to it', () => {
    expect(
      problems([
        list([{ ...ship, also: [{ do: 'create', table: 'events', values: { on: 'today' } }] }]),
      ]),
    ).toMatch(/also: a create must link back to this entry/);
    expect(
      problems([
        list([
          {
            as: 'button',
            label: 'Log',
            do: 'create',
            table: 'events',
            values: { order: '$row' },
            also: [{ do: 'create', table: 'events', values: { order: '$row' } }],
          },
        ]),
      ]),
    ).toMatch(/at most one create/);
    expect(
      problems([list([{ ...ship, also: [{ do: 'set', field: 'status', value: 'new' }] }])]),
    ).toMatch(/changes status twice/);
    expect(problems([list([{ ...ship, also: [{ do: 'toggle', field: 'status' }] }])])).toMatch(
      /toggle needs a checkbox field/,
    );
  });

  it('only a button or a tap on each entry: not on a page button, a check, a drag or a form', () => {
    expect(
      problems([
        {
          id: 'b1',
          look: 'button',
          show: { label: 'Go', variant: 'filled' },
          tools: [
            {
              do: 'create',
              table: 'events',
              values: {},
              also: [{ do: 'set', field: 'on', value: 'today' }],
            },
          ],
        },
      ]),
    ).toMatch(/also only works on a button or tap on each entry/);
    expect(
      problems([
        list([
          {
            as: 'button',
            label: 'Add',
            do: 'create',
            table: 'events',
            values: { order: '$row' },
            ask: 'all',
            also: [{ do: 'set', field: 'status', value: 'shipped' }],
          },
        ]),
      ]),
    ).toMatch(/also can't open a form/);
  });

  it('a reminder’s done stays one change: there is no banner on a notification', () => {
    expect(
      ReminderSchema.safeParse({
        id: 'r',
        kind: 'reminder',
        title: 'Ship',
        enabled: true,
        when: { each: { table: 'orders', field: 'shipped' }, at: '09:00' },
        opens: 'page:home',
        done: {
          do: 'set',
          table: 'orders',
          field: 'status',
          value: 'shipped',
          also: [{ do: 'set', field: 'shipped', value: 'today' }],
        },
      }).success,
    ).toBe(false);
  });

  it('lists the writes of one tap in order, the tool itself first', () => {
    expect(tapWrites(ship as RecordToolUse)).toEqual([
      { do: 'set', table: 'orders', field: 'status', value: 'shipped' },
      { do: 'set', table: 'orders', field: 'shipped', value: 'today' },
    ]);
  });

  it('an exported file lists it (D-556)', () => {
    const config = base();
    config.containers.pages.find((p) => p.id === 'home')!.blocks.push(list([ship]) as never);
    expect(usesOf(config).features).toContain('tapAlso');
  });
});

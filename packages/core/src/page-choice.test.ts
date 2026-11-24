import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import { usesOf } from './file-uses';
import { filterPresets } from './list-groups';
import type { Op } from './ops';
import { choiceRowOptions, followedFilter, resolvePageChoice } from './page-choice';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// A row of options on the page (D-573, founder decision 2 on 2026-11-16): the choices block lists
// options for a single-select field; record blocks, numbers, and charts in the same page with
// source.choice set to "page" display only records for the selected item. Config validation,
// cleanup upon deleting blocks/fields/options, and pure logic.

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 16) };

const orders: Collection = {
  id: 'orders',
  name: 'Orders',
  fields: [
    { id: 'item', name: 'Item', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'money', currency: 'USD' },
    { id: 'date', name: 'Date', type: 'date' },
    {
      id: 'status',
      name: 'Status',
      type: 'choice',
      options: [
        { id: 'to-ship', label: 'To ship' },
        { id: 'shipped', label: 'Shipped' },
        { id: 'done', label: 'Done' },
      ],
    },
    {
      id: 'channel',
      name: 'Channel',
      type: 'choice',
      options: [
        { id: 'web', label: 'Web' },
        { id: 'shop', label: 'Shop' },
      ],
    },
  ],
} as Collection;

const notes: Collection = {
  id: 'notes',
  name: 'Notes',
  fields: [{ id: 'title', name: 'Title', type: 'text' }],
} as Collection;

const row = (show: object = {}, source: object = {}, id = 'tabs') => ({
  id,
  look: 'choices',
  show,
  source: { table: 'orders', field: 'status', ...source },
});
const list = (source: object = {}, extra: object = {}, look = 'list', id = 'l') => ({
  id,
  look,
  source: { table: 'orders', choice: 'page', ...source },
  show: { title: 'item' },
  ...extra,
});
const number = (source: object = {}) => ({
  id: 'n',
  look: 'number',
  show: { label: 'Total' },
  source: { table: 'orders', aggregate: 'sum', field: 'amount', choice: 'page', ...source },
});
const chart = (source: object = {}, kind = 'bar') => ({
  id: 'c',
  look: 'chart',
  show: { kind, title: 'By month' },
  source: {
    table: 'orders',
    aggregate: 'sum',
    field: 'amount',
    group: { unit: 'month' },
    choice: 'page',
    ...source,
  },
});

const build = (blocks: object[], base: WorkspaceConfig = workspace('en')) =>
  prepareOps(
    base,
    [
      { op: 'addData', table: orders },
      { op: 'addData', table: notes },
      { op: 'addContainer', page: { id: 'p', title: 'Sales', blocks } },
    ] as unknown as Op[],
    ctx,
  );
const issues = (blocks: object[]) => {
  const r = build(blocks);
  return r.ok ? [] : r.issues;
};
const after = (blocks: object[]) => {
  const r = build(blocks);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.after;
};
const apply = (config: WorkspaceConfig, ops: object[]) => {
  const r = prepareOps(config, ops as unknown as Op[], ctx);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.after;
};
const blockOf = (config: WorkspaceConfig, id: string) =>
  config.containers.pages.find((p) => p.id === 'p')!.blocks.find((b) => b.id === id) as unknown as
    { show: Record<string, unknown>; source: Record<string, unknown> } | undefined;

describe('the choices block (D-573)', () => {
  it('names a table and one of its choice fields; options, all and default are optional', () => {
    expect(issues([row()])).toEqual([]);
    expect(
      issues([row({ options: ['shipped', 'to-ship'], all: false, default: 'shipped' })]),
    ).toEqual([]);
  });

  it('refuses a field that is not a choice, an option the field does not have, a default not shown', () => {
    expect(issues([row({}, { field: 'item' })]).join()).toMatch(/choice/);
    expect(issues([row({ options: ['lost'] })]).join()).toMatch(
      /show.options lost is not an option of status: to-ship, shipped, done/,
    );
    expect(issues([row({ options: ['to-ship'], default: 'done' })]).join()).toMatch(
      /show.default done must be one of: to-ship/,
    );
    expect(issues([row({ options: ['to-ship', 'to-ship'] })]).length).toBeGreaterThan(0);
  });

  it('one per page, on the page itself', () => {
    expect(issues([row(), row({}, { field: 'channel' }, 'tabs-2')]).join()).toMatch(
      /more than one choices block/,
    );
    expect(
      issues([{ id: 'g', look: 'group', show: { layout: 'stack' }, children: [row()] }]).join(),
    ).toMatch(/not inside a group/);
  });
});

describe('blocks that follow it', () => {
  it('record blocks, numbers and charts of the same table may follow; a calendar too', () => {
    expect(issues([row(), list(), number(), chart()])).toEqual([]);
    for (const look of ['cards', 'tiles', 'table', 'gallery'])
      expect(issues([row(), list({}, {}, look)])).toEqual([]);
    expect(issues([row(), list({ group: { unit: 'day' } }, {}, 'calendar')])).toEqual([]);
  });

  it('needs the choices block on the same page', () => {
    expect(issues([list()]).join()).toMatch(
      /source.choice "page" needs a choices block on the same page/,
    );
    expect(issues([number()]).join()).toMatch(/needs a choices block/);
    expect(issues([chart()]).join()).toMatch(/needs a choices block/);
  });

  it('a block reading another table cannot follow, and says so', () => {
    expect(issues([row(), list({ table: 'notes' }, { show: { title: 'title' } })]).join()).toMatch(
      /the choices block on this page picks from orders, and this block reads notes: only blocks that read orders can follow it, so remove source.choice here/,
    );
  });

  it('a block grouped by the same field does not follow; another field is fine', () => {
    const board = (by: string) => list({ group: { by } }, {}, 'board', 'b') as { source: object };
    expect(issues([row(), board('status')]).join()).toMatch(
      /grouped by status, which already shows every option of it: no source.choice/,
    );
    expect(issues([row(), board('channel')])).toEqual([]);
    expect(issues([row(), number({ group: { by: 'status' } })]).join()).toMatch(
      /grouped by status/,
    );
    expect(
      issues([
        row(),
        chart({ aggregate: 'count', field: undefined, group: { by: 'status' } }, 'pie'),
      ]).join(),
    ).toMatch(/grouped by status/);
  });

  it('a list with its own filter row on the same field keeps one of the two', () => {
    expect(
      issues([row(), list({}, { show: { title: 'item', browse: { filter: ['status'] } } })]).join(),
    ).toMatch(/own show.browse.filter on status: keep one of the two/);
    expect(
      issues([row(), list({}, { show: { title: 'item', browse: { filter: ['channel'] } } })]),
    ).toEqual([]);
  });

  it('a page may have a period block and a choices block, and a block may follow both', () => {
    const period = { id: 'range', look: 'period', show: { options: ['thisMonth', 'thisYear'] } };
    expect(
      issues([
        period,
        row(),
        list({ period: 'page' }),
        number({ period: 'page' }),
        chart({ period: 'page' }),
      ]),
    ).toEqual([]);
  });

  it('a file that uses it lists the feature (D-556)', () => {
    expect(usesOf({ blocks: [row(), list()] }).features).toEqual(['blocksFollowPageChoice']);
    expect(usesOf({ blocks: [row()] }).features).toBeUndefined();
  });
});

describe('keeping the config consistent (invariant 18)', () => {
  it('removing the choices block takes source.choice off every block that followed it', () => {
    const config = after([row(), list(), number(), chart()]);
    const next = apply(config, [{ op: 'removeContainer', page: 'p', block: 'tabs' }]);
    for (const id of ['l', 'n', 'c']) expect(blockOf(next, id)!.source.choice).toBeUndefined();
  });

  it('removing the choice field removes the row, and the blocks stop following', () => {
    const config = after([row(), list(), number()]);
    const next = apply(config, [{ op: 'removeData', table: 'orders', field: 'status' }]);
    expect(blockOf(next, 'tabs')).toBeUndefined();
    expect(blockOf(next, 'l')!.source.choice).toBeUndefined();
    expect(blockOf(next, 'n')!.source.choice).toBeUndefined();
  });

  it('removing the table removes the row with the blocks that read it', () => {
    const config = after([row(), list()]);
    const next = apply(config, [{ op: 'removeData', table: 'orders' }]);
    expect(blockOf(next, 'tabs')).toBeUndefined();
  });

  it('removing an option the row lists drops it from the row and from default', () => {
    const config = after([row({ options: ['shipped', 'to-ship'], default: 'shipped' }), list()]);
    const next = apply(config, [
      {
        op: 'updateData',
        table: 'orders',
        field: 'status',
        changes: {
          options: [
            { id: 'to-ship', label: 'To ship' },
            { id: 'done', label: 'Done' },
          ],
        },
      },
    ]);
    expect(blockOf(next, 'tabs')!.show).toEqual({ options: ['to-ship'] });
    const gone = apply(next, [
      {
        op: 'updateData',
        table: 'orders',
        field: 'status',
        changes: { options: [{ id: 'done', label: 'Done' }] },
      },
    ]);
    expect(blockOf(gone, 'tabs')!.show).toEqual({});
    expect(blockOf(gone, 'l')!.source.choice).toBe('page');
  });
});

describe('what is picked and what a following block reads', () => {
  const r = (show: object = {}) => row(show) as unknown as Parameters<typeof resolvePageChoice>[0];

  it('the options shown: the field order, or the subset and order of show.options', () => {
    expect(choiceRowOptions(r(), orders).map((o) => o.id)).toEqual(['to-ship', 'shipped', 'done']);
    expect(
      choiceRowOptions(r({ options: ['done', 'lost', 'to-ship'] }), orders).map((o) => o.id),
    ).toEqual(['done', 'to-ship']);
  });

  it('All by default; default; first option without All; a pick no longer shown falls back', () => {
    expect(resolvePageChoice(r(), orders, undefined)).toBeNull();
    expect(resolvePageChoice(r({ default: 'done' }), orders, undefined)).toBe('done');
    expect(resolvePageChoice(r({ default: 'done' }), orders, null)).toBeNull();
    expect(resolvePageChoice(r({ all: false }), orders, undefined)).toBe('to-ship');
    expect(resolvePageChoice(r({ all: false }), orders, null)).toBe('to-ship');
    expect(resolvePageChoice(r(), orders, 'shipped')).toBe('shipped');
    expect(resolvePageChoice(r({ options: ['done'] }), orders, 'shipped')).toBeNull();
  });

  it('a following block gets one more condition; All, another table or not following adds none', () => {
    const picked = { table: 'orders', field: 'status', option: 'shipped' };
    const own = [{ field: 'amount', op: 'gt' as const, value: 0 }];
    expect(followedFilter({ table: 'orders', filter: own, choice: 'page' }, picked)).toEqual([
      ...own,
      { field: 'status', op: 'is', value: 'shipped' },
    ]);
    expect(followedFilter({ table: 'orders', filter: own }, picked)).toBe(own);
    expect(
      followedFilter({ table: 'orders', filter: own, choice: 'page' }, { ...picked, option: null }),
    ).toBe(own);
    expect(followedFilter({ table: 'notes', choice: 'page' }, picked)).toBeUndefined();
  });

  it('adding right there ("$here") starts with the picked option, even over an own equal-to', () => {
    const filter = followedFilter(
      {
        table: 'orders',
        filter: [{ field: 'status', op: 'is', value: 'to-ship' }],
        choice: 'page',
      },
      { table: 'orders', field: 'status', option: 'done' },
    );
    expect(filterPresets(orders, filter)).toEqual({ status: 'done' });
  });
});

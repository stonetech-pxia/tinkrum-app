import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { Op } from './ops';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// 表格外观（D-539）：表头是字段名，每条一行，第一列（title）固定，其余列是 show.columns（不写时用副标题和右侧字段）。

const ctx = { registry, locale: 'en' as const, now: new Date(0) };

const TABLE: Collection = {
  id: 'people',
  name: 'People',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'company', name: 'Company', type: 'text' },
    { id: 'age', name: 'Age', type: 'number' },
    { id: 'day', name: 'Day', type: 'date' },
  ],
};

const table = (show: object = {}, extra: object = {}) => ({
  id: 't',
  look: 'table',
  source: { table: 'people' },
  show: { title: 'name', ...show },
  ...extra,
});

function prepare(...blocks: object[]) {
  return prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: TABLE },
      { op: 'addContainer', page: { id: 'p', title: 'P', blocks } } as unknown as Op,
    ],
    ctx,
  );
}
const issues = (...blocks: object[]) => {
  const r = prepare(...blocks);
  return r.ok ? [] : r.issues;
};
const blockOf = (config: WorkspaceConfig) =>
  config.containers.pages
    .find((p) => p.id === 'p')!
    .blocks.find((b) => b.id === 't') as unknown as {
    show: Record<string, unknown>;
  };

describe('table look (D-539)', () => {
  it('takes up to 7 more columns after the title, fields or createdAt', () => {
    expect(issues(table({ columns: ['company', 'age', 'day', 'createdAt'] }))).toEqual([]);
    expect(issues(table())).toEqual([]);
    expect(issues(table({ columns: ['nope'] })).join()).toMatch(/nope/);
    expect(
      issues(table({ columns: ['company', 'age', 'day', 'company', 'age', 'day', 'name', 'age'] })),
    ).not.toEqual([]);
  });

  it('columns only apply to the table look', () => {
    expect(issues({ ...table({ columns: ['age'] }), look: 'list' }).join()).toMatch(
      /show.columns only applies/,
    );
  });

  it('has no row buttons (cells are read-only); add-here and list buttons are fine', () => {
    const button = { as: 'button', label: 'Older', do: 'increment', table: 'people', field: 'age' };
    expect(issues(table({}, { tools: [button] }))).not.toEqual([]);
    const addHere = { as: 'addHere', do: 'create', table: 'people', values: '$here' };
    expect(issues(table({}, { tools: [addHere] }))).toEqual([]);
  });

  it('removing a field takes it out of the columns, and the last one removes columns', () => {
    const r = prepare(table({ columns: ['company', 'age'] }));
    if (!r.ok) throw new Error(r.issues.join());
    const a = prepareOps(r.after, [{ op: 'removeData', table: 'people', field: 'company' }], ctx);
    if (!a.ok) throw new Error(a.issues.join());
    expect(blockOf(a.after).show).toEqual({ title: 'name', columns: ['age'] });
    const b = prepareOps(a.after, [{ op: 'removeData', table: 'people', field: 'age' }], ctx);
    if (!b.ok) throw new Error(b.issues.join());
    expect(blockOf(b.after).show).toEqual({ title: 'name' });
  });
});

describe('gallery look (D-540)', () => {
  const gallery = (extra: object = {}) => ({ ...table(), id: 'g', look: 'gallery', ...extra });

  it('uses the title slot; no columns, no row buttons', () => {
    expect(issues(gallery())).toEqual([]);
    expect(issues(gallery({ show: { title: 'name', columns: ['age'] } })).join()).toMatch(
      /show.columns only applies/,
    );
    const button = { as: 'button', label: 'Older', do: 'increment', table: 'people', field: 'age' };
    expect(issues(gallery({ tools: [button] }))).not.toEqual([]);
  });
});

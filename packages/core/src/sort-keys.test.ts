import { describe, expect, it } from 'vitest';

import {
  fieldOf,
  isSystemField,
  readValue,
  recordValue,
  scheduleStatusOf,
  sortRecords,
  type DataRecord,
} from './data';
import { prepareOps } from './change';
import { createDefaultWorkspace } from './defaults';
import { describeChange } from './describe';
import { usesOf } from './file-uses';
import { minuteOfDay } from './formula';
import { browseSortKeys } from './list-groups';
import type { Op } from './ops';
import type { FieldValue } from './field-values';
import { expandCollection } from './related';
import { FIELDS, fieldDefinition, type Collection, type Field } from './schema';
import { registry } from './test-helpers';
import { V33_NOW, sampleRecords } from './test-records';

// Sorting keys for each record are computed only once (precomputed before sorting), and the order is identical to calculating on the fly during every comparison.

/** A table populated with an example for each field type (reference field points to itself, formula uses weight). */
const raw: Collection = {
  id: 'expenses',
  name: 'Expenses',
  fields: FIELDS.map((d) => d.example as Field),
};
const table = expandCollection([raw], raw);

/** Previous sortRecords (calculating keys on the fly during comparison), copied verbatim for comparison purposes. */
function sortBefore(
  records: readonly DataRecord[],
  collection: Collection,
  sort: { field: string; direction: 'asc' | 'desc' } | undefined,
  now: Date,
): DataRecord[] {
  const { field, direction } = sort ?? { field: 'createdAt', direction: 'desc' as const };
  const sign = direction === 'asc' ? 1 : -1;
  const def = fieldOf(collection, field);
  const sortKey = def && fieldDefinition(def.type).sort;
  const compare = (a: FieldValue, b: FieldValue): number => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (Array.isArray(a) || Array.isArray(b))
      return (Array.isArray(a) ? a.length : 0) - (Array.isArray(b) ? b.length : 0);
    if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
    return String(a).localeCompare(String(b));
  };
  const key = (r: DataRecord): FieldValue | undefined => {
    if (isSystemField(field)) return r[field];
    if (def?.type === 'schedule') {
      const next = scheduleStatusOf(r, collection, def, now)?.next;
      const time = (readValue(def, r.values[def.id]) as { time?: string } | undefined)?.time;
      return next === undefined ? undefined : next + (time ? minuteOfDay(time)! / 1440 : 0.9999);
    }
    const v = recordValue(r, collection, field, now);
    return def && sortKey && v !== undefined ? sortKey(def, v) : v;
  };
  return [...records].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === undefined && kb === undefined) return b.createdAt - a.createdAt;
    if (ka === undefined) return 1;
    if (kb === undefined) return -1;
    return sign * compare(ka, kb) || b.createdAt - a.createdAt;
  });
}

/** 30 sample records, plus a few created at the same time as other records with identical values (ties). */
function records(): DataRecord[] {
  const list = sampleRecords([raw]).get('expenses')!;
  const ties = list
    .slice(0, 6)
    .map((r, i) => ({ ...r, id: `tie-${i}`, createdAt: list[0]!.createdAt }));
  return [...list, ...ties, { ...list[3]!, id: 'tie-same', values: {} }];
}

const sortable = table.fields.filter((f) => fieldDefinition(f.type).sort !== false);

describe('sorting computes each key once', () => {
  it('sorts by every sortable field type', () => {
    // Single select, event, date, formula, empty values, and ties are all included.
    expect(sortable.map((f) => f.type)).toEqual(
      expect.arrayContaining(['choice', 'schedule', 'formula', 'date', 'datetime', 'number']),
    );
  });

  it.each([...sortable.map((f) => f.id), 'createdAt', 'updatedAt'])(
    'keeps the order of %s identical to computing keys in every comparison',
    (field) => {
      const list = records();
      for (const direction of ['asc', 'desc'] as const) {
        const sort = { field, direction };
        expect(sortRecords(list, table, sort, V33_NOW).map((r) => r.id)).toEqual(
          sortBefore(list, table, sort, V33_NOW).map((r) => r.id),
        );
      }
    },
  );

  it('keeps the default order (newest first) identical', () => {
    const list = records();
    expect(sortRecords(list, table, undefined, V33_NOW).map((r) => r.id)).toEqual(
      sortBefore(list, table, undefined, V33_NOW).map((r) => r.id),
    );
  });

  it('reads each record once, not once per comparison', () => {
    const counts = new Map<string, number>();
    const list = Array.from({ length: 200 }, (_, i) => {
      const values = { weight: (i * 37) % 101 };
      const r = { id: `r${i}`, collectionId: 'expenses', createdAt: i, updatedAt: i } as DataRecord;
      Object.defineProperty(r, 'values', {
        get: () => {
          counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
          return values;
        },
      });
      return r;
    });
    const formula = table.fields.find((f) => f.type === 'formula')!;
    sortRecords(list, table, { field: formula.id, direction: 'asc' }, V33_NOW);
    // A record's formula value is fixed when read multiple times; previously every comparison re-read it, taking a dozen comparisons for 200 records.
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });
});

describe('sorting by up to three fields (D-560)', () => {
  const tasks: Collection = {
    id: 'tasks',
    name: 'Tasks',
    fields: [
      { id: 'title', name: 'Title', type: 'text', required: true },
      {
        id: 'priority',
        name: 'Priority',
        type: 'choice',
        options: [
          { id: 'high', label: 'High' },
          { id: 'low', label: 'Low' },
        ],
      },
      { id: 'due', name: 'Due', type: 'date' },
      { id: 'labels', name: 'Labels', type: 'tags' },
    ],
  };
  const rows: DataRecord[] = [
    ['a', 'low', '2026-11-01', 1],
    ['b', 'high', '2026-11-09', 2],
    ['c', 'high', '2026-11-03', 3],
    ['d', undefined, '2026-11-02', 4],
    ['e', 'high', undefined, 5],
    ['f', 'low', '2026-11-01', 6],
  ].map(([id, priority, due, at]) => ({
    id: id as string,
    collectionId: 'tasks',
    values: { title: id, priority, due },
    createdAt: at as number,
    updatedAt: at as number,
  }));
  const ids = (sort: Parameters<typeof sortRecords>[2]) =>
    sortRecords(rows, tasks, sort, V33_NOW).map((r) => r.id);

  it('sorts by the first field, then the second for ties; empty values last at each step', () => {
    expect(
      ids([
        { field: 'priority', direction: 'asc' },
        { field: 'due', direction: 'asc' },
      ]),
    ).toEqual(['c', 'b', 'e', 'f', 'a', 'd']);
    // When all three are identical, sorts by creation time from newest to oldest (same as a single field).
    expect(
      ids([
        { field: 'priority', direction: 'desc' },
        { field: 'due', direction: 'desc' },
        { field: 'title', direction: 'asc' },
      ]),
    ).toEqual(['a', 'f', 'b', 'c', 'e', 'd']);
  });

  it('a single object means what it meant before, and equals a list of one', () => {
    const one = { field: 'priority', direction: 'asc' } as const;
    expect(ids(one)).toEqual(ids([one]));
    expect(ids(one)).toEqual(['e', 'c', 'b', 'f', 'a', 'd']);
  });

  it('the user picking a field to sort by puts it first and keeps the configured ones after', () => {
    const configured: { field: string; direction: 'asc' | 'desc' }[] = [
      { field: 'priority', direction: 'asc' },
      { field: 'due', direction: 'asc' },
    ];
    expect(browseSortKeys({ field: 'due', direction: 'desc' }, configured)).toEqual([
      { field: 'due', direction: 'desc' },
      { field: 'priority', direction: 'asc' },
    ]);
    expect(browseSortKeys({ field: 'title', direction: 'asc' }, configured[0])).toEqual([
      { field: 'title', direction: 'asc' },
      { field: 'priority', direction: 'asc' },
    ]);
    expect(browseSortKeys(undefined, configured)).toBe(configured);
    expect(browseSortKeys({ field: 'title', direction: 'asc' }, undefined)).toEqual({
      field: 'title',
      direction: 'asc',
    });
  });

  describe('in the config', () => {
    const NOW = new Date(2026, 10, 16);
    const list = (sort: unknown) => ({
      op: 'addContainer',
      page: 'home',
      block: { id: 'l', look: 'list', source: { table: 'tasks', sort }, show: { title: 'title' } },
    });
    const problems = (sort: unknown) => {
      const r = prepareOps(
        createDefaultWorkspace('en'),
        [{ op: 'addData', table: tasks }, list(sort)] as never,
        { registry, locale: 'en', now: NOW },
      );
      return r.ok ? [] : r.issues.map(String);
    };
    const key = (field: string, direction = 'asc') => ({ field, direction });

    it('accepts one to three fields', () => {
      expect(problems(key('due'))).toEqual([]);
      expect(problems([key('priority'), key('due', 'desc')])).toEqual([]);
      expect(problems([key('priority'), key('due'), key('createdAt', 'desc')])).toEqual([]);
    });

    it('refuses more than three, an empty list, a field twice, a missing or unsortable field', () => {
      expect(problems([key('priority'), key('due'), key('title'), key('createdAt')])).not.toEqual(
        [],
      );
      expect(problems([])).not.toEqual([]);
      expect(problems([key('due'), key('due', 'desc')]).join()).toMatch(/due more than once/);
      expect(problems([key('due'), key('nope')]).join()).toMatch(
        /sort field nope is not a field of tasks/,
      );
      expect(problems([key('due'), key('labels')]).join()).toMatch(
        /can't sort by the tags field labels/,
      );
    });

    it('describes the change and a file lists it', () => {
      const r = prepareOps(
        createDefaultWorkspace('en'),
        [{ op: 'addData', table: tasks }, list([key('priority'), key('due')])] as never,
        { registry, locale: 'en', now: NOW },
      );
      if (!r.ok) throw new Error(String(r.issues));
      expect(usesOf(r.after).features).toContain('sortMany');
      expect(usesOf(createDefaultWorkspace('en')).features ?? []).not.toContain('sortMany');
      const text = describeChange(
        [
          {
            op: 'updateContainer',
            page: 'home',
            block: 'l',
            changes: { source: { sort: [key('priority'), key('due')] } },
          } as Op,
        ],
        r.after,
        [],
        { locale: 'en', registry, now: NOW },
      ).join('\n');
      expect(text).toContain('Priority');
      expect(text).toContain('Due');
    });
  });
});

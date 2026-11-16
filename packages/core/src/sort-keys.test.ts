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
import { minuteOfDay } from './formula';
import type { FieldValue } from './field-values';
import { expandCollection } from './related';
import { FIELDS, fieldDefinition, type Collection, type Field } from './schema';
import { V33_NOW, sampleRecords } from './test-records';

// 排序每条记录的键只算一次（排序前算好），顺序和以前每次比较都现算的一模一样。

/** 一张表放上每种字段的 example（引用字段指向它自己，公式用 weight）。 */
const raw: Collection = {
  id: 'expenses',
  name: 'Expenses',
  fields: FIELDS.map((d) => d.example as Field),
};
const table = expandCollection([raw], raw);

/** 以前的 sortRecords（比较时现算键），照抄，用来对照。 */
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

/** 30 条样本记录，再加几条和别的记录同时创建、值也一样的（平局）。 */
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
    // 单选、日程、日期、公式、空值、平局都在里面。
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
    // 一条记录的公式读几次它的值是固定的；以前每次比较都再读，200 条要比十几次。
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });
});

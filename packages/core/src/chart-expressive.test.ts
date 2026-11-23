import { describe, expect, it } from 'vitest';
import { chartSeries, type ChartSpec } from './chart';
import { DEFAULT_CALENDAR } from './calendar';
import type { Collection } from './schema';
const table: Collection = {
  id: 't',
  name: 'T',
  fields: [
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'n', name: 'N', type: 'number' },
    {
      id: 'kind',
      name: 'Kind',
      type: 'choice',
      options: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `C${i}` })),
    },
  ],
};
const record = (date: string, n: number, kind = 'c0', i = 0) => ({
  id: `${date}${kind}${i}`,
  collectionId: 't',
  values: { date, n, kind },
  createdAt: i,
  updatedAt: i,
});
const rows = [
  record('2026-11-20', 100),
  record('2026-11-21', 5),
  record('2026-11-21', 3, 'c1', 1),
  record('2026-11-23', -2),
];
const now = new Date(2026, 10, 23);
const base = { aggregate: 'sum', field: 'n', group: { unit: 'day', by: 'date', last: 3 } } as const;
function series(extra: object = {}, records = rows) {
  return chartSeries(
    records,
    table,
    { ...base, ...extra } as ChartSpec,
    now,
    'None',
    DEFAULT_CALENDAR,
  );
}
describe('expressive chart series', () => {
  it('latest uses the newest dated entry and retains a gap', () =>
    expect(series({ aggregate: 'latest' }).map((p) => [p.value, p.empty])).toEqual([
      [3, false],
      [0, true],
      [-2, false],
    ]));
  it('min and max preserve missing periods', () => {
    expect(series({ aggregate: 'min' }).map((p) => p.value)).toEqual([3, 0, -2]);
    expect(series({ aggregate: 'max' }).map((p) => p.value)).toEqual([5, 0, -2]);
  });
  it('running shown starts at the visible edge; all includes earlier entries', () => {
    expect(series({ running: 'shown' }).map((p) => p.value)).toEqual([8, 8, 6]);
    expect(series({ running: 'all' }).map((p) => p.value)).toEqual([108, 108, 106]);
  });
  it('running all honors a page range start inside a week or month', () => {
    const points = chartSeries(
      rows,
      table,
      { ...base, running: 'all' } as ChartSpec,
      now,
      'None',
      DEFAULT_CALENDAR,
      undefined,
      false,
      { start: '2026-11-21', end: '2026-11-23' },
    );
    expect(points.map((p) => p.value)).toEqual([108, 108, 106]);
  });
  it('splits single choices with signed values and no data duplication', () => {
    const points = series({ split: { by: 'kind' } });
    expect(points[0]?.parts?.map((p) => p.value)).toEqual([5, 3]);
    expect(points[2]?.parts?.[0]?.value).toBe(-2);
  });
  it('keeps at most 8 series and merges the rest without losing amounts', () => {
    const points = series(
      { split: { by: 'kind' } },
      Array.from({ length: 10 }, (_, i) => record('2026-11-21', i + 1, `c${i}`)),
    );
    expect(points[0]?.parts).toHaveLength(8);
    expect(points[0]?.parts?.reduce((s, p) => s + p.value, 0)).toBe(55);
  });
});

it('merges averages by recomputing entries, not adding averages', () => {
  const own = Array.from({ length: 10 }, (_, i) => record('2026-11-21', i + 1, `c${i}`));
  own.push(record('2026-11-21', 0, 'c0', 1));
  const points = series({ aggregate: 'avg', split: { by: 'kind' } }, own);
  const rest = points[0]!.parts!.find((p) => p.key === '$other')!;
  expect(rest.value).toBe((1 + 0 + 2 + 3) / 4);
});
it('keeps the prior running period independent for shown', () => {
  const prior = chartSeries(
    rows,
    table,
    { ...base, running: 'shown' },
    now,
    'None',
    DEFAULT_CALENDAR,
    undefined,
    true,
  );
  expect(prior.map((p) => p.value)).toEqual([0, 0, 100]);
});

it('choice colors keep the field option index when earlier choices have no slice', async () => {
  const { chartOptionColor, optionColor } = await import('./chart');
  const options = [{ id: 'a' }, { id: 'b' }];
  expect(chartOptionColor('b', options, false, 0)).toBe(optionColor(options[1], 1, false, options));
  expect(chartOptionColor('$other', options, false, 7)).toBe(
    optionColor(undefined, -1, false, options),
  );
});

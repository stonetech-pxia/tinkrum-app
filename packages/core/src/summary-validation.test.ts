import { expect, it } from 'vitest';
import { prepareOps } from './change';
import { createDefaultWorkspace } from './defaults';
import { usesOf } from './file-uses';
import type { Collection, NewComponent } from './schema';
import { registry } from './test-helpers';
const table: Collection = {
  id: 'tx',
  name: 'Tx',
  fields: [
    { id: 'n', name: 'N', type: 'number' },
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'end', name: 'End', type: 'datetime' },
    { id: 'cat', name: 'Category', type: 'choice', options: [{ id: 'a', label: 'A' }] },
    {
      id: 'tags',
      name: 'Multi',
      type: 'choice',
      multiple: true,
      options: [{ id: 'a', label: 'A' }],
    },
  ],
};
const chart = {
  id: 'c',
  look: 'chart',
  show: { title: 'Chart', kind: 'line' },
  source: { table: 'tx', aggregate: 'sum', field: 'n', group: { unit: 'day', by: 'date' } },
};
const calendar = {
  id: 'cal',
  look: 'calendar',
  show: { title: 'date' },
  source: { table: 'tx', limit: 30, group: { unit: 'day', by: 'date' } },
};
function accepts(block: unknown) {
  return prepareOps(
    createDefaultWorkspace('en'),
    [
      { op: 'addData', table },
      { op: 'addContainer', page: 'home', block: block as NewComponent },
    ],
    { registry, locale: 'en', now: new Date() },
  ).ok;
}
it('allows all new numeric chart aggregates, but refuses them for pies', () => {
  for (const aggregate of ['latest', 'min', 'max']) {
    expect(accepts({ ...chart, source: { ...chart.source, aggregate } })).toBe(true);
    expect(
      accepts({
        ...chart,
        show: { ...chart.show, kind: 'pie' },
        source: { ...chart.source, aggregate, group: { by: 'cat' } },
      }),
    ).toBe(false);
  }
});
it('rejects ambiguous split and running combinations', () => {
  for (const source of [
    { ...chart.source, split: { by: 'tags' } },
    { ...chart.source, split: { by: 'n' } },
    { ...chart.source, split: { by: 'cat' }, running: 'shown' },
    { ...chart.source, split: { by: 'cat' }, compare: 'previous' },
    { ...chart.source, running: 'all', compare: 'previous' },
    { ...chart.source, running: 'shown', aggregate: 'avg' },
    { ...chart.source, running: 'shown', group: { by: 'cat' } },
  ])
    expect(accepts({ ...chart, source })).toBe(false);
  expect(
    accepts({ ...chart, source: { ...chart.source, running: 'shown', compare: 'previous' } }),
  ).toBe(true);
});
it('week and span are read-only calendar options; sum and span cannot combine', () => {
  expect(
    accepts({
      ...calendar,
      show: { ...calendar.show, span: 'week', day: { aggregate: 'count' } },
      source: { ...calendar.source, group: { ...calendar.source.group, until: 'end' } },
    }),
  ).toBe(true);
  expect(
    accepts({
      ...calendar,
      show: { ...calendar.show, day: { aggregate: 'sum', field: 'n' } },
      source: { ...calendar.source, group: { ...calendar.source.group, until: 'end' } },
    }),
  ).toBe(false);
  for (const look of ['list', 'cards', 'board', 'grid', 'number', 'chart']) {
    const base =
      look === 'number'
        ? { id: 'n', look, show: { label: 'N' }, source: { table: 'tx', aggregate: 'count' } }
        : look === 'chart'
          ? chart
          : { ...calendar, look };
    expect(
      accepts({
        ...base,
        source: { ...base.source, group: { unit: 'day', by: 'date', until: 'end' } },
      }),
    ).toBe(false);
  }
});
it('export declares each new feature precisely', () => {
  expect(
    usesOf({
      ...chart,
      source: { ...chart.source, aggregate: 'latest', running: 'shown', split: { by: 'cat' } },
    }).features,
  ).toEqual(['chartExtrema', 'chartRunning', 'chartSplit']);
  expect(
    usesOf({
      ...calendar,
      show: { title: 'date', span: 'week', day: { aggregate: 'count' } },
      source: { ...calendar.source, group: { ...calendar.source.group, until: 'end' } },
    }).features,
  ).toEqual(['calendarDayValue', 'calendarUntil', 'calendarWeek']);
  expect(usesOf({ id: 'n', look: 'number', source: { calc: {} } }).features).toEqual([
    'numberCalc',
  ]);
});

import { describe, expect, it } from 'vitest';

import { DEFAULT_CALENDAR } from './calendar';
import { boardColumns } from './board-view';
import { browseFilter, browseFilterRows } from './browse-filter';
import { prepareOps } from './change';
import { conditionProblems } from './conditions';
import {
  filterRecords,
  formatValue,
  groupedAggregate,
  prepareRecordValues,
  readValue,
  recordsToCsv,
  sortRecords,
  type DataRecord,
} from './data';
import { createDefaultWorkspace } from './defaults';
import { describeChange } from './describe';
import { filterPresets, listGroups } from './list-groups';
import { CURRENT_SCHEMA_VERSION, migrateWorkspace } from './index';
import { applyOps, type Op } from './ops';
import { ruleEngine } from './prefill/engine';
import { planImport, readCellFor } from './records-import';
import { setAllChanges } from './record-ops';
import { streakOf } from './sequence';
import { FieldSchema, type Collection, type Field, type NewComponent } from './schema';
import { registry } from './test-helpers';
import { validateWorkspace } from './validate';

// D-607: single-choice fields can allow multiple selections (multiple: true). Stored values are a
// list of option IDs (in option order); filter is "contains any of" for is, and "contains none of"
// for isNot; splitting, grouping, Kanban, and option rows on pages count a record toward every
// option it selects.

const now = new Date(2026, 10, 20, 9);
const cal = DEFAULT_CALENDAR;

const days = {
  id: 'days',
  name: 'Days',
  type: 'choice',
  multiple: true,
  options: [
    { id: 'mon', label: 'Monday' },
    { id: 'tue', label: 'Tuesday' },
    { id: 'thu', label: 'Thursday' },
    { id: 'sat', label: 'Saturday' },
  ],
} as const satisfies Field;

const meals: Collection = {
  id: 'meals',
  name: 'Meals',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    days,
    {
      id: 'course',
      name: 'Course',
      type: 'choice',
      options: [
        { id: 'main', label: 'Main', value: 1 },
        { id: 'side', label: 'Side', value: 2 },
      ],
    },
    { id: 'servings', name: 'Servings', type: 'number' },
    { id: 'date', name: 'Date', type: 'date' },
  ],
};

let seq = 0;
const meal = (name: string, values: Record<string, unknown>): DataRecord => ({
  id: name,
  collectionId: 'meals',
  values: { name, ...values },
  createdAt: ++seq,
  updatedAt: seq,
});
const names = (rs: readonly DataRecord[]) => rs.map((r) => r.values.name);

const list = [
  meal('Soup', { days: ['mon', 'thu'] }),
  meal('Curry', { days: ['thu'] }),
  meal('Salad', { days: ['mon', 'tue', 'thu', 'sat'] }),
  meal('Toast', {}),
  // Single option ID stored prior to switching to multi-choice.
  meal('Pasta', { days: 'sat' }),
];

const withMeals = (ops: Op[] = []) =>
  prepareOps(createDefaultWorkspace('en'), [{ op: 'addData', table: meals }, ...ops], {
    registry,
    locale: 'en',
    now,
  });
const problemsOf = (ops: Op[]) => {
  const r = withMeals(ops);
  return r.ok ? [] : r.issues;
};
const block = (b: Record<string, unknown>): Op => ({
  op: 'addContainer',
  page: 'home',
  block: b as NewComponent,
});

describe('the field (D-607)', () => {
  it('multiple: true and a default list are part of the schema', () => {
    expect(FieldSchema.safeParse(days).success).toBe(true);
    expect(FieldSchema.safeParse({ ...days, default: ['mon', 'thu'] }).success).toBe(true);
    expect(FieldSchema.safeParse({ ...days, default: 'mon' }).success).toBe(true);
    expect(FieldSchema.safeParse({ ...days, multiple: false }).success).toBe(false);
  });

  it('a default list must be options of a multiple field', () => {
    expect(withMeals().ok).toBe(true);
    const field = (f: object) =>
      prepareOps(
        createDefaultWorkspace('en'),
        [{ op: 'addData', table: { ...meals, fields: [meals.fields[0]!, f as Field] } }],
        { registry, locale: 'en', now },
      );
    expect(field({ ...days, default: ['mon', 'sat'] }).ok).toBe(true);
    expect(field({ ...days, default: ['mon', 'sun'] }).ok).toBe(false);
    expect(field({ ...days, default: ['mon', 'mon'] }).ok).toBe(false);
    const { multiple: _m, ...single } = days;
    expect(field({ ...single, default: ['mon'] }).ok).toBe(false);
  });

  it('writes a list of option ids in option order; one id is a list of one', () => {
    const write = (v: unknown) => prepareRecordValues(meals, { days: v }, null, now, cal);
    expect(write(['thu', 'mon'])).toEqual({ ok: true, values: { days: ['mon', 'thu'] } });
    expect(write('tue')).toEqual({ ok: true, values: { days: ['tue'] } });
    expect(write(['mon', 'mon'])).toEqual({ ok: true, values: { days: ['mon'] } });
    expect(write([])).toEqual({ ok: true, values: {} });
    expect(write(['mon', 'sun']).ok).toBe(false);
    expect(write([1]).ok).toBe(false);
  });

  it('a default list fills a new entry', () => {
    const table = {
      ...meals,
      fields: meals.fields.map((f) => (f.id === 'days' ? { ...days, default: ['sat'] } : f)),
    };
    expect(prepareRecordValues(table, {}, null, now, cal)).toEqual({
      ok: true,
      values: { days: ['sat'] },
    });
  });

  it('reads a stored single id as one item and leaves out options removed since', () => {
    expect(readValue(days, 'sat')).toEqual(['sat']);
    expect(readValue(days, ['thu', 'gone', 'mon'])).toEqual(['mon', 'thu']);
    expect(readValue(days, ['gone'])).toBeUndefined();
    expect(readValue(days, [])).toBeUndefined();
  });

  it('shows the labels in option order', () => {
    expect(formatValue(days, ['thu', 'mon'], 'en')).toBe('Monday, Thursday');
    expect(formatValue(days, 'sat', 'en')).toBe('Saturday');
    expect(formatValue(days, ['gone'], 'en')).toBe('');
  });

  it('sorts by the first option picked; none last', () => {
    const sorted = sortRecords(list, meals, { field: 'days', direction: 'asc' }, now, cal);
    expect(names(sorted)).toEqual(['Salad', 'Soup', 'Curry', 'Pasta', 'Toast']);
  });

  it('exports the labels to CSV and imports them back', () => {
    const csv = recordsToCsv(meals, [list[0]!], 'en');
    expect(csv).toContain('"Monday, Thursday"');
    expect(readCellFor(days, { text: 'Monday, Thursday' }, 'dmy')).toEqual({
      value: ['mon', 'thu'],
    });
    expect(readCellFor(days, { text: 'saturday；tue' }, 'dmy')).toEqual({
      value: ['sat', 'tue'],
    });
    expect(readCellFor(days, { text: 'Monday, Sunday' }, 'dmy')).toEqual({ invalid: true });
    const plan = planImport(
      meals,
      [
        [{ text: 'Name' }, { text: 'Days' }],
        [{ text: 'Stew' }, { text: 'Thursday, Monday' }],
      ],
      { header: true, mapping: ['name', 'days'], orders: ['dmy', 'dmy'] },
      now,
      cal,
    );
    expect(plan.entries).toEqual([{ row: 2, values: { name: 'Stew', days: ['mon', 'thu'] } }]);
  });
});

describe('filters (D-607)', () => {
  const where = (c: { op: string; value?: unknown }) =>
    names(filterRecords(list, meals, [{ field: 'days', ...c } as never], now, cal));

  it('is: the entry has that option, or any of a list', () => {
    expect(where({ op: 'is', value: 'mon' })).toEqual(['Soup', 'Salad']);
    expect(where({ op: 'is', value: ['tue', 'sat'] })).toEqual(['Salad', 'Pasta']);
  });

  it('isNot: the entry has none of it', () => {
    expect(where({ op: 'isNot', value: 'thu' })).toEqual(['Toast', 'Pasta']);
  });

  it('isEmpty / isNotEmpty', () => {
    expect(where({ op: 'isEmpty' })).toEqual(['Toast']);
    expect(where({ op: 'isNotEmpty' })).toEqual(['Soup', 'Curry', 'Salad', 'Pasta']);
  });

  it('checks the values like a single choice', () => {
    expect(conditionProblems([{ field: 'days', op: 'is', value: ['mon', 'sat'] }], meals)).toEqual(
      [],
    );
    expect(conditionProblems([{ field: 'days', op: 'is', value: 'sun' }], meals)).toHaveLength(1);
    expect(
      conditionProblems([{ field: 'days', op: 'contains', value: 'mon' }], meals),
    ).toHaveLength(1);
  });

  it('a temporary filter on the list: options in use, an entry with it', () => {
    expect(browseFilterRows(list, meals, ['days'], 'en')).toEqual([
      {
        field: 'days',
        values: [
          { value: 'mon', label: 'Monday' },
          { value: 'tue', label: 'Tuesday' },
          { value: 'thu', label: 'Thursday' },
          { value: 'sat', label: 'Saturday' },
        ],
      },
    ]);
    expect(names(browseFilter(list, meals, { field: 'days', value: 'sat' }))).toEqual([
      'Salad',
      'Pasta',
    ]);
  });

  it('adding in a list filtered to an option starts with that option picked', () => {
    expect(filterPresets(meals, [{ field: 'days', op: 'is', value: 'thu' }])).toEqual({
      days: ['thu'],
    });
  });

  it('a streak skips the days of an entry that has the skip option', () => {
    const log = [
      meal('a', { date: '2026-11-18', days: ['mon'] }),
      meal('b', { date: '2026-11-19', days: ['tue', 'sat'] }),
      meal('c', { date: '2026-11-20', days: ['mon'] }),
    ];
    const streak = streakOf(
      log,
      meals,
      { unit: 'day', perUnit: 1, skip: { field: 'days', option: 'sat' } },
      { dateField: 'date', now, cal },
    );
    // The 19th has "skipped": streak is unbroken, but not counted as a day.
    expect(streak.current).toBe(2);
  });
});

describe('grouping: an entry counts in every option it has (D-607)', () => {
  it('list sections', () => {
    const groups = listGroups(list, meals, { by: 'days' }, { locale: 'en', now, cal });
    expect(groups.map((g) => [g.label, names(g.records), g.preset])).toEqual([
      ['Monday', ['Soup', 'Salad'], ['mon']],
      ['Tuesday', ['Salad'], ['tue']],
      ['Thursday', ['Soup', 'Curry', 'Salad'], ['thu']],
      ['Saturday', ['Salad', 'Pasta'], ['sat']],
      ['Not set', ['Toast'], undefined],
    ]);
  });

  it('numbers and bars per option add up to more than the entries', () => {
    const groups = groupedAggregate(list, meals, 'count', undefined, 'days', 'Not set');
    expect(groups.map((g) => [g.optionId, g.value])).toEqual([
      ['mon', 2],
      ['tue', 1],
      ['thu', 3],
      ['sat', 2],
      [null, 1],
    ]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(9);
  });

  it('a board shows a card in each of its columns', () => {
    const columns = boardColumns(days, list, 30);
    expect(columns.map((c) => [c.option, names(c.records)])).toEqual([
      ['mon', ['Soup', 'Salad']],
      ['tue', ['Salad']],
      ['thu', ['Soup', 'Curry', 'Salad']],
      ['sat', ['Salad', 'Pasta']],
      [null, ['Toast']],
    ]);
  });

  it('an entry with every option, and one whose only option was removed', () => {
    const fewer = { ...days, options: days.options.filter((o) => o.id !== 'sat') };
    const table = { ...meals, fields: meals.fields.map((f) => (f.id === 'days' ? fewer : f)) };
    const groups = listGroups(list, table, { by: 'days' }, { locale: 'en', now, cal });
    expect(groups.map((g) => [g.label, names(g.records)])).toEqual([
      ['Monday', ['Soup', 'Salad']],
      ['Tuesday', ['Salad']],
      ['Thursday', ['Soup', 'Curry', 'Salad']],
      ['Not set', ['Toast', 'Pasta']],
    ]);
  });
});

describe('what a multiple field can and cannot be used for (D-607)', () => {
  it('list sections, number groups, bar charts and the choices row are fine', () => {
    expect(
      problemsOf([
        block({
          id: 'l',
          look: 'list',
          source: { table: 'meals', group: { by: 'days' } },
          show: { title: 'name', subtitles: ['days'] },
        }),
        block({
          id: 'n',
          look: 'number',
          show: { label: 'Per day' },
          source: { table: 'meals', aggregate: 'count', group: { by: 'days' } },
        }),
        block({
          id: 'c',
          look: 'chart',
          show: { kind: 'bar', title: 'Per day' },
          source: { table: 'meals', aggregate: 'count', group: { by: 'days' } },
        }),
        block({
          id: 'tabs',
          look: 'choices',
          source: { table: 'meals', field: 'days' },
          show: {},
        }),
      ]),
    ).toEqual([]);
  });

  it('a pie chart cannot be grouped by it', () => {
    const issues = problemsOf([
      block({
        id: 'c',
        look: 'chart',
        show: { kind: 'pie', title: 'Per day' },
        source: { table: 'meals', aggregate: 'count', group: { by: 'days' } },
      }),
    ]);
    expect(issues.join('\n')).toMatch(/pie.*several options/);
  });

  it('a board grouped by it is read-only: no drag', () => {
    const board = (tools?: object[]) =>
      block({
        id: 'b',
        look: 'board',
        source: { table: 'meals', group: { by: 'days' } },
        show: { title: 'name' },
        ...(tools ? { tools } : {}),
      });
    expect(problemsOf([board()])).toEqual([]);
    const issues = problemsOf([
      board([{ as: 'drag', do: 'set', table: 'meals', field: 'days', value: '$group' }]),
    ]);
    expect(issues.join('\n')).toMatch(/several options/);
  });

  it('no colour by it', () => {
    const issues = problemsOf([
      block({
        id: 'l',
        look: 'list',
        source: { table: 'meals' },
        show: { title: 'name', color: 'days' },
      }),
    ]);
    expect(issues.join('\n')).toMatch(/colorField days picks several options/);
  });

  it('no formula over it', () => {
    const issues = problemsOf([
      {
        op: 'addData',
        table: 'meals',
        field: { id: 'f', name: 'F', type: 'formula', expression: '{days} * 2' },
      },
    ]);
    expect(issues.join('\n')).toMatch(/several options/);
  });

  it('not the currency of an amount, nor the group of a previous value', () => {
    const currency = problemsOf([
      {
        op: 'addData',
        table: 'meals',
        field: { id: 'cost', name: 'Cost', type: 'money', currency: 'EUR', currencyField: 'days' },
      },
    ]);
    expect(currency.join('\n')).toMatch(/several options/);
    const previous = problemsOf([
      {
        op: 'addData',
        table: 'meals',
        field: { id: 'prev', name: 'Prev', type: 'previous', field: 'servings', within: 'days' },
      },
    ]);
    expect(previous.join('\n')).toMatch(/several options/);
  });

  it('a lookup of it shows and filters like the field', () => {
    const plans: Collection = {
      id: 'plans',
      name: 'Plans',
      fields: [
        { id: 'meal', name: 'Meal', type: 'link', table: 'meals' },
        { id: 'meal-days', name: 'Days', type: 'lookup', via: 'meal', field: 'days' },
      ],
    };
    const r = withMeals([
      { op: 'addData', table: plans },
      block({
        id: 'p',
        look: 'list',
        source: {
          table: 'plans',
          filter: [{ field: 'meal-days', op: 'is', value: 'mon' }],
          group: { by: 'meal-days' },
        },
        show: { title: 'meal', subtitles: ['meal-days'] },
      }),
    ]);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });
});

describe('record tools on a multiple field (D-607)', () => {
  const button = (values: Record<string, unknown>, d: 'create' | 'set' = 'create') =>
    block({
      id: 'l',
      look: 'list',
      source: { table: 'meals' },
      show: { title: 'name' },
      tools: [
        d === 'create'
          ? { as: 'button', label: 'Add', do: 'create', table: 'meals', values }
          : { as: 'button', label: 'Weekend', do: 'set', table: 'meals', ...values },
      ],
    });

  it('create takes a list of option ids', () => {
    expect(problemsOf([button({ days: ['mon', 'thu'] })])).toEqual([]);
    expect(problemsOf([button({ days: ['mon', 'sun'] })]).join('\n')).toMatch(/option ids/);
  });

  it('set takes a list (it replaces what was picked) or null; one id alone is refused', () => {
    expect(problemsOf([button({ field: 'days', value: ['sat'] }, 'set')])).toEqual([]);
    expect(problemsOf([button({ field: 'days', value: null }, 'set')])).toEqual([]);
    expect(problemsOf([button({ field: 'days', value: 'sat' }, 'set')]).join('\n')).toMatch(/list/);
  });

  it('a single choice still takes one id, not a list', () => {
    expect(problemsOf([button({ course: ['main'] })]).join('\n')).toMatch(/course/);
  });

  it('setAll writes the list to every entry', () => {
    const changes = setAllChanges(
      { do: 'setAll', table: 'meals', field: 'days', value: ['tue'] } as never,
      meals,
      meals,
      list,
      { now, cal },
    );
    // Salad already has days other than Tuesday: replace entirely with [tue]; no existing entry is already exactly [tue].
    expect(changes.map((c) => [c.id, c.after.days])).toEqual([
      ['Soup', ['tue']],
      ['Curry', ['tue']],
      ['Salad', ['tue']],
      ['Toast', ['tue']],
      ['Pasta', ['tue']],
    ]);
  });
});

describe('turning multiple on and off (D-607)', () => {
  const single: Collection = {
    ...meals,
    fields: meals.fields.map((f) => {
      if (f.id !== 'days') return f;
      const { multiple: _m, ...rest } = days;
      return rest;
    }),
  };
  const base = () =>
    applyOps(createDefaultWorkspace('en'), [{ op: 'addData', table: single }], {
      registry,
      locale: 'en',
    });

  it('on: only the field changes; stored ids read as one-item lists', () => {
    const before = base();
    if (!before.ok) throw new Error(before.error);
    const r = applyOps(
      before.config,
      [{ op: 'updateData', table: 'meals', field: 'days', changes: { multiple: true } }],
      { registry, locale: 'en' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateWorkspace(r.config, registry).ok).toBe(true);
    const field = r.config.data.tables.find((t) => t.id === 'meals')!.fields[1]!;
    expect(readValue(field, 'thu')).toEqual(['thu']);
  });

  it('off is refused: the entries may hold several options', () => {
    const on = withMeals();
    if (!on.ok) throw new Error('setup');
    const r = applyOps(
      on.after,
      [{ op: 'updateData', table: 'meals', field: 'days', changes: { multiple: null } }],
      { registry, locale: 'en' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/several options/);
  });

  it('after an undo back to one option, a stored list still shows and is kept on save', () => {
    const one = single.fields[1]!;
    // Display only, not treated as selecting a specific item (filters, groupings, and forms treat it as unselected).
    expect(readValue(one, ['mon', 'thu'])).toBeUndefined();
    expect(formatValue(one, ['mon', 'thu'], 'en')).toBe('Monday, Thursday');
    // Modifying other fields: stored list remains unchanged.
    expect(
      prepareRecordValues(single, { name: 'Soup 2' }, { name: 'Soup', days: ['mon', 'thu'] }, now),
    ).toEqual({ ok: true, values: { name: 'Soup 2', days: ['mon', 'thu'] } });
    // User explicitly selected an item: replace with this item.
    expect(
      prepareRecordValues(single, { days: 'tue' }, { name: 'Soup', days: ['mon', 'thu'] }, now),
    ).toEqual({ ok: true, values: { name: 'Soup', days: 'tue' } });
  });

  it('an option removed later stays in the entry and does not block saving it', () => {
    expect(
      prepareRecordValues(meals, { servings: 2 }, { name: 'Soup', days: ['mon', 'gone'] }, now),
    ).toEqual({ ok: true, values: { name: 'Soup', days: ['mon', 'gone'], servings: 2 } });
  });

  it('the change is described in words', () => {
    const before = base();
    if (!before.ok) throw new Error(before.error);
    const lines = describeChange(
      [{ op: 'updateData', table: 'meals', field: 'days', changes: { multiple: true } }],
      before.config,
      [],
      { registry, locale: 'en', now },
    );
    expect(lines.join('\n')).toMatch(/several/);
  });
});

describe('schema version 40 (D-607)', () => {
  it('a v39 config moves to v40 with nothing else changed', () => {
    const v39 = { ...createDefaultWorkspace('en'), schemaVersion: 39 };
    const r = migrateWorkspace(structuredClone(v39));
    expect(CURRENT_SCHEMA_VERSION).toBe(40);
    expect(r.ok && r.config).toEqual({ ...v39, schemaVersion: 40 });
  });
});

describe('on-device suggestions skip a multiple field (D-607)', () => {
  it('a spoken sentence naming options fills nothing in it and does not fail', async () => {
    const suggestions = await ruleEngine({
      fields: meals.fields,
      pages: [
        {
          width: 1000,
          height: 40,
          lines: [
            { text: 'Soup on Monday and Thursday, main', x: 0, y: 0, width: 1000, height: 24 },
          ],
        },
      ],
      spoken: true,
      locale: 'en',
      now,
    });
    expect(suggestions.days).toBeUndefined();
    expect(suggestions.course?.[0]?.value).toBe('main');
  });
});

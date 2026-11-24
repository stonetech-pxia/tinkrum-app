import { describe, expect, it } from 'vitest';

import { recordValue, type DataRecord } from './data';
import { createDefaultWorkspace } from './defaults';
import { computeRecords, expandCollection } from './related';
import { readRecords } from './source';
import type { Collection } from './schema';

// The grocery list chain (D-616 second part, validation only without changes): recipe summary count
// planned times this week -> ingredient lookup this count -> formula quantity x count -> ingredient
// summary adds up this ingredient formula = total amount of each ingredient needed this week.
// Tables are identical to meals.tinkrum-app.json in side-session-notes/pick-create-2026-11-21.
process.env.TZ = 'Europe/Paris';
// 2026-11-18 is Wednesday; by default a week starts on Monday, so this week is 11-16 to 11-22.
const now = new Date(2026, 10, 18, 9, 0);

const tables: Collection[] = [
  {
    id: 'meals-recipes',
    name: 'Recipes',
    fields: [
      { id: 'name', name: 'Name', type: 'text', required: true },
      {
        id: 'times',
        name: 'Planned this week',
        type: 'rollup',
        table: 'meals-plan',
        via: 'recipe',
        aggregate: 'count',
        filter: [{ field: 'day', op: 'inPeriod', value: 'thisWeek' }],
      },
    ],
  },
  {
    id: 'meals-ingredients',
    name: 'Ingredients',
    fields: [
      { id: 'name', name: 'Name', type: 'text', required: true },
      {
        id: 'week',
        name: 'Needed this week',
        type: 'rollup',
        table: 'meals-items',
        via: 'ingredient',
        aggregate: 'sum',
        field: 'need',
      },
    ],
  },
  {
    id: 'meals-items',
    name: 'Recipe items',
    fields: [
      { id: 'recipe', name: 'Recipe', type: 'link', table: 'meals-recipes', required: true },
      {
        id: 'ingredient',
        name: 'Ingredient',
        type: 'link',
        table: 'meals-ingredients',
        required: true,
      },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'times', name: 'Times this week', type: 'lookup', via: 'recipe', field: 'times' },
      { id: 'need', name: 'Needed this week', type: 'formula', expression: '{amount} * {times}' },
    ],
  },
  {
    id: 'meals-plan',
    name: 'Meal plan',
    fields: [
      { id: 'recipe', name: 'Recipe', type: 'link', table: 'meals-recipes', required: true },
      { id: 'day', name: 'Day', type: 'date', default: 'today', required: true },
    ],
  },
];

const rec = (id: string, collectionId: string, values: object): DataRecord => ({
  id,
  collectionId,
  values: { ...values },
  createdAt: 1,
  updatedAt: 1,
});

describe('shopping list: this week’s total per ingredient (D-616 part 2)', () => {
  const stored = new Map<string, DataRecord[]>([
    [
      'meals-recipes',
      [
        rec('pancakes', 'meals-recipes', { name: 'Pancakes' }),
        rec('omelette', 'meals-recipes', { name: 'Omelette' }),
        rec('soup', 'meals-recipes', { name: 'Soup' }),
      ],
    ],
    [
      'meals-ingredients',
      [
        rec('flour', 'meals-ingredients', { name: 'Flour' }),
        rec('egg', 'meals-ingredients', { name: 'Egg' }),
        rec('milk', 'meals-ingredients', { name: 'Milk' }),
        rec('leek', 'meals-ingredients', { name: 'Leek' }),
      ],
    ],
    [
      'meals-items',
      [
        rec('i1', 'meals-items', { recipe: 'pancakes', ingredient: 'flour', amount: 200 }),
        rec('i2', 'meals-items', { recipe: 'pancakes', ingredient: 'egg', amount: 2 }),
        rec('i3', 'meals-items', { recipe: 'pancakes', ingredient: 'milk', amount: 300 }),
        rec('i4', 'meals-items', { recipe: 'omelette', ingredient: 'egg', amount: 3 }),
        rec('i5', 'meals-items', { recipe: 'soup', ingredient: 'leek', amount: 2 }),
        // One without quantity filled yet: not included.
        rec('i6', 'meals-items', { recipe: 'omelette', ingredient: 'milk' }),
      ],
    ],
    [
      'meals-plan',
      [
        // This week: pancakes twice, omelette once; soup was only last week.
        rec('p1', 'meals-plan', { recipe: 'pancakes', day: '2026-11-16' }),
        rec('p2', 'meals-plan', { recipe: 'pancakes', day: '2026-11-21' }),
        rec('p3', 'meals-plan', { recipe: 'omelette', day: '2026-11-18' }),
        rec('p4', 'meals-plan', { recipe: 'soup', day: '2026-11-12' }),
      ],
    ],
  ]);
  // Displayed value (formulas are evaluated on read, recordValue).
  const value = (table: string, id: string, field: string) => {
    const view = expandCollection(
      tables,
      tables.find((t) => t.id === table)!,
    );
    const record = computeRecords(tables, table, stored, now).find((r) => r.id === id)!;
    return recordValue(record, view, field, now);
  };

  it('step 1: a recipe counts this week’s plans', () => {
    expect(value('meals-recipes', 'pancakes', 'times')).toBe(2);
    expect(value('meals-recipes', 'omelette', 'times')).toBe(1);
    expect(value('meals-recipes', 'soup', 'times')).toBe(0);
  });

  it('step 2 and 3: a recipe item looks the count up and multiplies its amount', () => {
    expect(value('meals-items', 'i1', 'times')).toBe(2);
    expect(value('meals-items', 'i1', 'need')).toBe(400);
    expect(value('meals-items', 'i4', 'need')).toBe(3);
    expect(value('meals-items', 'i5', 'need')).toBe(0);
  });

  it('step 4: an ingredient sums what this week needs', () => {
    expect(value('meals-ingredients', 'flour', 'week')).toBe(400);
    // Pancakes 2 x 2 + omelette 3 x 1.
    expect(value('meals-ingredients', 'egg', 'week')).toBe(7);
    expect(value('meals-ingredients', 'milk', 'week')).toBe(600);
    expect(value('meals-ingredients', 'leek', 'week')).toBe(0);
  });

  it('step 5: the shopping list shows the ingredients needed this week with their totals', () => {
    const config = createDefaultWorkspace('en');
    config.data.tables.push(...tables);
    const read = readRecords(
      {
        look: 'list',
        source: {
          table: 'meals-ingredients',
          filter: [{ field: 'week', op: 'gt', value: 0 }],
          sort: { field: 'name', direction: 'asc' },
          limit: 30,
        },
      },
      { config, records: stored, now, locale: 'en' },
    )!;
    expect(read.shown.map((r) => [r.id, recordValue(r, read.view, 'week', now)])).toEqual([
      ['egg', 7],
      ['flour', 400],
      ['milk', 600],
    ]);
  });
});

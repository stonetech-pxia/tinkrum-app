import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { hereValues, readRecords } from './source';
import {
  MAX_CREATE_ALL,
  RecordToolSchema,
  pickChoices,
  pickCreateInputs,
  pickedAlready,
  type RecordTool,
} from './record-ops';
import { computeRecords, expandCollection } from './related';
import { bindRecord } from './record-pages';
import type { Collection, Component, WorkspaceConfig } from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// Check-and-create (D-616, founder 2026-11-21 "start work"): many-to-many relationships where the
// link itself carries data (recipe → ingredients and quantities). Tap "Add" on a recipe page, check
// several ingredients, creating an entry in "Recipe ingredients" for each, linked to this recipe
// (equality condition in list filtering, "$here") and the checked ingredient ("$row"). Already
// linked ones are displayed as "Added" and not created again. Still asks first, caps at 200 items,
// and the banner can undo this batch (invariant 11, D-567).
process.env.TZ = 'Europe/Paris';
const now = new Date(2026, 10, 21, 9, 0);

const recipes: Collection = {
  id: 'recipes',
  name: 'Recipes',
  fields: [{ id: 'name', name: 'Name', type: 'text' }],
};
const ingredients: Collection = {
  id: 'ingredients',
  name: 'Ingredients',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'pantry', name: 'In the pantry', type: 'checkbox' },
    { id: 'unit', name: 'Unit', type: 'choice', options: [{ id: 'g', label: 'g' }] },
  ],
};
const items: Collection = {
  id: 'recipe-items',
  name: 'Recipe items',
  fields: [
    { id: 'recipe', name: 'Recipe', type: 'link', table: 'recipes', required: true },
    { id: 'ingredient', name: 'Ingredient', type: 'link', table: 'ingredients' },
    { id: 'spare', name: 'Spare', type: 'link', table: 'ingredients' },
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'unit', name: 'Unit', type: 'choice', options: [{ id: 'g', label: 'g' }] },
  ],
};

const pick = {
  as: 'addHere',
  label: 'Add ingredients',
  do: 'createAll',
  table: 'recipe-items',
  from: 'ingredients',
  pick: true,
  values: { ingredient: '$row' },
};
const itemsList = (tools: unknown[], extra: object = {}) => ({
  id: 'items',
  look: 'list',
  source: {
    table: 'recipe-items',
    filter: [{ field: 'recipe', op: 'is', value: '$record' }],
    limit: 30,
  },
  show: { title: 'ingredient', trailing: 'amount' },
  tools,
  ...extra,
});

const base = (): WorkspaceConfig => {
  const config = fromV33(v33Fixture('default-en'));
  config.data.tables.push(...structuredClone([recipes, ingredients, items]));
  config.containers.pages.push({ id: 'recipe', title: 'Recipe', of: 'recipes', blocks: [] });
  return config;
};
function problems(blocks: unknown[], page = 'recipe', config = base()): string {
  const copy = structuredClone(config);
  copy.containers.pages.find((p) => p.id === page)!.blocks.push(...(blocks as never[]));
  const r = validateWorkspace(copy, registry);
  return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
}

describe('pick several, create one each (D-616)', () => {
  it('is an optional key of createAll, still asking first and capped at 200', () => {
    const { as: _as, label: _label, ...tool } = pick;
    expect(RecordToolSchema.safeParse(tool).success).toBe(true);
    expect(RecordToolSchema.safeParse({ ...tool, pick: false }).success).toBe(false);
    expect(
      RecordToolSchema.safeParse({ do: 'create', table: 'recipe-items', pick: true }).success,
    ).toBe(false);
    for (const skip of [{ confirm: false }, { ask: false }, { silent: true }, { max: 1000 }])
      expect(RecordToolSchema.safeParse({ ...tool, ...skip }).success).toBe(false);
    expect(MAX_CREATE_ALL).toBe(200);
  });

  it('sits as the Add under a list of join entries on a recipe page', () => {
    expect(problems([itemsList([pick])])).toBe('');
    // Can also restrict to checkable ones (source table filter) with preset other values.
    expect(
      problems([
        itemsList([
          {
            ...pick,
            filter: [{ field: 'pantry', op: 'is', value: false }],
            values: { ingredient: '$row', unit: 'g' },
          },
        ]),
      ]),
    ).toBe('');
    // Also works under cards, table, and list views.
    for (const look of ['cards', 'table'])
      expect(problems([{ ...itemsList([pick]), look }])).toBe('');
  });

  it('a calendar of meal plans picks recipes for the selected day', () => {
    const config = base();
    config.data.tables.push({
      id: 'plans',
      name: 'Meal plan',
      fields: [
        { id: 'recipe', name: 'Recipe', type: 'link', table: 'recipes' },
        { id: 'on', name: 'On', type: 'date', required: true },
      ],
    });
    const calendar = {
      id: 'week',
      look: 'calendar',
      source: { table: 'plans', limit: 30, group: { unit: 'day', by: 'on' } },
      show: { title: 'recipe' },
      tools: [
        {
          as: 'addHere',
          do: 'createAll',
          table: 'plans',
          from: 'recipes',
          pick: true,
          values: { recipe: '$row', on: 'today' },
        },
      ],
    };
    // That date is populated by the calendar ("$here"), and values cannot overwrite it.
    expect(problems([calendar], 'home', config)).toMatch(
      /on is already filled by this list \(its filter or section\)/,
    );
    const { on: _on, ...values } = calendar.tools[0]!.values;
    const fixed = { ...calendar, tools: [{ ...calendar.tools[0], values }] };
    // Segment values might not exist ("Unassigned"), so required dates without default values are also rejected; default values are allowed.
    expect(problems([fixed], 'home', config)).toMatch(/required field on would be empty/);
    const dated = structuredClone(config);
    const on = dated.data.tables.find((t) => t.id === 'plans')!.fields[1]!;
    (on as { required?: boolean }).required = false;
    expect(problems([fixed], 'home', dated)).toBe('');
  });

  it('is refused anywhere else, with the shape to use', () => {
    // Button block: no "here" segment, and no "Added".
    const { as: _as, label: _label, ...tool } = pick;
    expect(
      problems([
        { id: 'b', look: 'button', show: { label: 'Add', shape: 'filled' }, tools: [tool] },
      ]),
    ).toMatch(/pick: true only works as the "Add" under a list of entries/);
    // Button on each item.
    expect(problems([itemsList([{ ...pick, as: 'button' }])])).toMatch(
      /pick: true only works as the "Add" under a list/,
    );
    // Batch creation without checking below lists (for each filtered item) is still restricted to button blocks.
    const { pick: _pick, ...all } = pick;
    expect(problems([itemsList([all])])).toMatch(
      /createAll on every entry a filter selects belongs on a button block; under a list, let the user pick/,
    );
    expect(problems([itemsList([{ ...all, as: 'button' }])])).toMatch(
      /createAll on every entry a filter selects belongs on a button block/,
    );
    // Check-in grids and large circles do not have "Add".
    expect(
      problems([
        {
          id: 'g',
          look: 'grid',
          source: {
            table: 'recipe-items',
            limit: 30,
            group: { by: 'ingredient' },
            across: { unit: 'day' },
          },
          show: { title: 'ingredient' },
          tools: [{ ...pick, as: 'tap' }],
        },
      ]),
    ).toMatch(/can't have a createAll tool/);
  });

  it('writes only the table of the list it sits under (invariant 17)', () => {
    expect(problems([itemsList([{ ...pick, table: 'recipes', values: {} }])])).toMatch(
      /pick: true adds entries to the list it sits under, so table must be recipe-items, not recipes/,
    );
  });

  it('needs exactly one link to the picked table set to "$row", and leaves the list’s own values alone', () => {
    expect(problems([itemsList([{ ...pick, values: {} }])])).toMatch(
      /pick: true needs exactly one link field of recipe-items to ingredients set to "\$row"/,
    );
    expect(
      problems([itemsList([{ ...pick, values: { ingredient: '$row', spare: '$row' } }])]),
    ).toMatch(/exactly one link field.*not ingredient, spare/);
    // Recipe is populated by list filtering (this recipe); if values specify it again, it is outside this segment.
    expect(
      problems([itemsList([{ ...pick, values: { ingredient: '$row', recipe: '$record' } }])]),
    ).toMatch(/recipe is already filled by this list/);
    // List not filtered by recipe: required recipe is left unfilled by anyone, so it cannot be saved.
    expect(
      problems([{ ...itemsList([pick]), source: { table: 'recipe-items', limit: 30 } }]),
    ).toMatch(/required field recipe would be empty/);
    // Text constants are still not allowed (D-301).
    expect(
      problems([itemsList([{ ...pick, values: { ingredient: '$row', amount: 'x' } }])]),
    ).toMatch(/recipe-items\.amount is a number field/);
  });

  it('works out the choices, what is already added and one new entry per picked ingredient', () => {
    const tables = [recipes, ingredients, items];
    const rec = (id: string, collectionId: string, values: object, at = 1): DataRecord => ({
      id,
      collectionId,
      values: { ...values },
      createdAt: at,
      updatedAt: at,
    });
    const stored = new Map<string, DataRecord[]>([
      [
        'recipes',
        [rec('r1', 'recipes', { name: 'Pancakes' }), rec('r2', 'recipes', { name: 'Soup' })],
      ],
      [
        'ingredients',
        [
          rec('flour', 'ingredients', { name: 'Flour', pantry: false }),
          rec('egg', 'ingredients', { name: 'Egg', pantry: false }),
          rec('milk', 'ingredients', { name: 'Milk', pantry: true }),
          rec('salt', 'ingredients', { name: 'Salt', pantry: false }),
        ],
      ],
      [
        'recipe-items',
        [
          rec('x1', 'recipe-items', { recipe: 'r1', ingredient: 'flour', amount: 200 }),
          // Other recipes use eggs: not yet in this recipe.
          rec('x2', 'recipe-items', { recipe: 'r2', ingredient: 'egg', amount: 2 }),
        ],
      ],
    ]);
    const config = base();
    // List on recipe page: opening r1 replaces "$record" with r1, and "$here" is {recipe: r1}.
    const block = bindRecord(itemsList([pick]) as unknown as Component, 'r1');
    const read = readRecords(
      block as never,
      {
        config,
        records: stored,
        now,
        locale: 'en',
      } as never,
    )!;
    const here = hereValues(read);
    expect(here).toEqual({ recipe: 'r1' });
    const tool = pick as unknown as Extract<RecordTool, { do: 'createAll' }>;
    const target = items;
    const already = pickedAlready(tool, target, stored.get('recipe-items')!, here);
    expect([...already]).toEqual(['flour']);
    const sourceView = expandCollection(tables, ingredients);
    const sources = computeRecords(tables, 'ingredients', stored, now);
    // Only give items not in pantry: milk cannot be checked.
    const filtered = { ...tool, filter: [{ field: 'pantry', op: 'is' as const, value: false }] };
    expect(pickChoices(filtered, sourceView, sources, { now }).map((r) => r.id)).toEqual([
      'flour',
      'egg',
      'salt',
    ]);
    // Checked flour (already added), salt, egg: in check order, only create salt and egg, both linked to this recipe.
    const picked = ['flour', 'salt', 'egg'].map((id) => sources.find((r) => r.id === id)!);
    expect(pickCreateInputs(tool, target, sourceView, picked, here, already, { now })).toEqual([
      { sourceId: 'salt', input: { recipe: 'r1', ingredient: 'salt' } },
      { sourceId: 'egg', input: { recipe: 'r1', ingredient: 'egg' } },
    ]);
  });

  it('"already added" only counts entries in this section, and multiple choices by inclusion', () => {
    const tool = pick as unknown as Extract<RecordTool, { do: 'createAll' }>;
    const rows: DataRecord[] = [
      {
        id: 'a',
        collectionId: 'recipe-items',
        values: { recipe: 'r1', ingredient: 'egg', unit: 'g' },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'b',
        collectionId: 'recipe-items',
        values: { recipe: 'r1', ingredient: 'milk' },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    expect([...pickedAlready(tool, items, rows, { recipe: 'r1', unit: 'g' })]).toEqual(['egg']);
    expect([...pickedAlready(tool, items, rows, { recipe: 'r2' })]).toEqual([]);
    expect([...pickedAlready(tool, items, rows, {})].sort()).toEqual(['egg', 'milk']);
  });

  it('deleting the picked table or the link field removes the Add, keeping the list (invariant 18)', () => {
    const config = base();
    // Title uses amount: deleting a field when it is used as a list title has separate rules (not tested here).
    const list = { ...itemsList([pick]), show: { title: 'amount' } };
    config.containers.pages.find((p) => p.id === 'recipe')!.blocks.push(list as never);
    const ctx = { registry, locale: 'en' as const, now };
    // Referenced tables must have fields referencing them deleted first (ops.ts), or deleted together.
    for (const ops of [
      [{ op: 'removeData', table: 'recipe-items', field: 'ingredient' }],
      [
        { op: 'removeData', table: 'recipe-items', field: 'ingredient' },
        { op: 'removeData', table: 'recipe-items', field: 'spare' },
        { op: 'removeData', table: 'ingredients' },
      ],
    ]) {
      const op = ops.at(-1);
      const r = prepareOps(config, ops as never, ctx);
      expect(r.ok, JSON.stringify(op)).toBe(true);
      if (!r.ok) continue;
      const page = r.after.containers.pages.find((p) => p.id === 'recipe')!;
      const list = page.blocks.find((b) => b.id === 'items') as { tools?: unknown[] } | undefined;
      expect(list, JSON.stringify(op)).toBeDefined();
      expect(list!.tools ?? [], JSON.stringify(op)).toEqual([]);
      expect(validateWorkspace(r.after, registry).ok).toBe(true);
    }
  });
});

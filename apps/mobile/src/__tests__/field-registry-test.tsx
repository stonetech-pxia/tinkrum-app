import {
  FIELDS,
  applyOps,
  createDefaultWorkspace,
  type Field,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { screen } from 'expo-router/testing-library';

import { FIELD_EDITORS } from '../renderer/data';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Every registered field type can be filled and displayed in the app (automatically covered here
// when adding new field types, see docs/FIELDS.md): a table places an example of each field, the
// form contains every fillable field, and the list displays one record per field.

const fields = FIELDS.map((d) => d.example as Field);
const fillable = FIELDS.filter((d) => d.inForm !== false).map((d) => d.example.id);

const seed = (locale: Locale, registry: Registry) => {
  const components: NewComponent[] = [
    // At most 10 fields per form, split across multiple forms.
    ...[0, 10].map((start): NewComponent => ({
      id: start === 0 ? 'form' : `form${start}`,
      look: 'form',
      show: { mode: 'inline' },
      tools: [
        {
          as: 'submit',
          label: 'Add',
          do: 'create',
          table: 'expenses',
          ask: fillable.slice(start, start + 10),
        },
      ],
    })),
    ...FIELDS.map((d): NewComponent => ({
      id: `list-${d.example.id}`,
      look: 'list',
      source: { table: 'expenses', limit: 5 },
      show: { title: d.example.id },
    })),
  ];
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: { id: 'expenses', name: 'Expenses', fields } },
      ...components.map((block) => ({
        op: 'addContainer' as const,
        page: 'home',
        block,
      })),
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

async function withExampleValues() {
  const repo = new MemoryWorkspaceRepo();
  const values = Object.fromEntries(
    FIELDS.flatMap((d) => (d.exampleValue === undefined ? [] : [[d.example.id, d.exampleValue]])),
  );
  await repo.insertRecord({
    id: 'r1',
    collectionId: 'expenses',
    values,
    createdAt: 1,
    updatedAt: 1,
  });
  return repo;
}

it('has an editor for every registered field type', () => {
  expect(Object.keys(FIELD_EDITORS).sort()).toEqual(FIELDS.map((d) => d.type).sort());
});

it.each(['zh', 'en', 'fr'] as const)(
  'every field example can be filled in and shown in %s',
  async (locale) => {
    const { store } = await renderToolsApp(await withExampleValues(), undefined, { seed, locale });
    for (const id of fillable) {
      const form = fillable.indexOf(id) < 10 ? 'form' : 'form10';
      const input = screen.queryByTestId(`form-${form}-${id}`);
      // Options and stars are a group of buttons; test IDs include option suffixes.
      const parts = screen.queryAllByTestId(new RegExp(`^form-${form}-${id}-`));
      expect({ id, shown: input !== null || parts.length > 0 }).toEqual({ id, shown: true });
    }
    for (const d of FIELDS) {
      expect(await screen.findByTestId(`component-list-${d.example.id}`)).toBeTruthy();
    }
    expect(store.getState().head!.source).not.toBe('rollback');
  },
);

import {
  COMPONENTS,
  applyOps,
  createDefaultWorkspace,
  localDate,
  templateOps,
  type Locale,
  type NewComponent,
  type Registry,
} from '@morph/core';
import { screen } from 'expo-router/testing-library';

import { RENDERERS } from '../renderer/registry';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Every registered component can be rendered (automatically covered here when new components are
// added, see docs/COMPONENTS.md): uses the example from the definition, placed on the sample
// configuration's home screen (expenses table, added PDF tool). If rendering fails, the app rolls
// back its version; this check ensures no rollback occurs.

type Definition = (typeof COMPONENTS)[number];

const seed = (def: Definition) => (locale: Locale, registry: Registry) => {
  const config = createDefaultWorkspace(locale);
  const block = { id: 'example', look: def.look, ...def.example } as NewComponent;
  const result = applyOps(
    config,
    [
      { op: 'setPackage', package: 'pdf', do: 'add' },
      templateOps('budget', config, locale)[0]!,
      // Checklist example requires a checkbox field.
      { op: 'addData', table: 'expenses', field: { id: 'paid', name: 'Paid', type: 'checkbox' } },
      { op: 'addContainer', page: 'home', block },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

async function renders(def: Definition, locale: Locale, repo = new MemoryWorkspaceRepo()) {
  const { store } = await renderToolsApp(repo, undefined, { seed: seed(def), locale });
  expect(await screen.findByTestId('component-example')).toBeTruthy();
  expect(store.getState().head!.source).not.toBe('rollback');
  expect(store.getState().status).toBe('ready');
}

async function withRecords(values: Record<string, unknown>[]) {
  const repo = new MemoryWorkspaceRepo();
  for (const [i, v] of values.entries()) {
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'expenses',
      values: v,
      createdAt: i,
      updatedAt: i,
    });
  }
  return repo;
}

const today = localDate(new Date());

it('has a renderer for every registered component', () => {
  expect(Object.keys(RENDERERS).sort()).toEqual(COMPONENTS.map((d) => d.look).sort());
});

describe.each(COMPONENTS.map((d) => [d.look, d] as const))('component %s', (_type, def) => {
  it.each(['zh', 'en', 'fr'] as const)('renders its example in %s', async (locale) => {
    await renders(def, locale);
  });
});

/** Components referencing data tables: handles new users with no records, users with records, and users with many or malformed records (missing values, incorrect values, oversized). */
const DATA = COMPONENTS.filter((d) =>
  Object.values(d.refs ?? {}).some((ref) => ref?.to === 'table'),
);

describe.each(DATA.map((d) => [d.look, d] as const))('data component %s', (_type, def) => {
  it('renders for a new user with no entries', async () => {
    await renders(def, 'zh');
  });

  it('renders with entries', async () => {
    await renders(
      def,
      'en',
      await withRecords([
        { amount: 30, category: 'food', date: today, note: 'Lunch' },
        { amount: 12.5, category: 'transport', date: today },
      ]),
    );
  });

  it('renders many entries with missing, wrong and huge values', async () => {
    const values: Record<string, unknown>[] = Array.from({ length: 150 }, (_, i) => ({
      amount: i * 3.75,
      category: ['food', 'fun', 'gone-option'][i % 3],
      date: today,
    }));
    values.push(
      {},
      { amount: 'not a number', category: 42, date: 'yesterday' },
      { amount: 1e15, note: 'x'.repeat(5000) },
      { amount: -20, date: '1999-01-01' },
    );
    await renders(def, 'fr', await withRecords(values));
  });
});

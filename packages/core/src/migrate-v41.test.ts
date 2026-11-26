import { describe, expect, it } from 'vitest';

import { prepareSnapshot } from './change';
import { migrateWorkspace } from './migrate';
import { registry, workspace } from './test-helpers';

// v40 → v41 (D-655): twelve looks merged into spacer, catalog,
// notice, tabs and button. A v40 config (a page with every old look, the blocks above and below the
// file preview) must upgrade and validate, with nothing lost (invariant 12).

type Json = Record<string, any>;

const expenses = {
  id: 'expenses',
  name: 'Expenses',
  fields: [
    { id: 'note', name: 'Note', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'number' },
    {
      id: 'category',
      name: 'Category',
      type: 'choice',
      options: [
        { id: 'food', label: 'Food' },
        { id: 'rent', label: 'Rent' },
      ],
    },
    { id: 'date', name: 'Date', type: 'date' },
  ],
};

const OLD_BLOCKS = [
  { id: 'title', look: 'header', show: { title: 'Old' } },
  { id: 'line', look: 'divider' },
  { id: 'gap', look: 'spacer', show: { size: 'medium' } },
  {
    id: 'range',
    look: 'period',
    show: { options: ['thisWeek', 'thisMonth'], default: 'thisMonth', custom: true },
  },
  {
    id: 'by-category',
    look: 'choices',
    source: { table: 'expenses', field: 'category' },
    show: {},
  },
  {
    id: 'list',
    look: 'list',
    source: { table: 'expenses', period: 'page', choice: 'page' },
    show: { title: 'note' },
  },
  {
    id: 'due',
    look: 'callout',
    show: { title: 'This month', text: '{count} entries, {sum:amount}', openLabel: 'Open' },
    source: { table: 'expenses' },
    opens: 'settings',
  },
  {
    id: 'go',
    look: 'entry',
    show: { title: 'Tools', icon: 'apps', shape: 'tile' },
    opens: 'tools',
  },
  {
    id: 'slot',
    look: 'entry',
    show: { title: 'Lease', hint: 'Pick the PDF' },
    opens: { file: null },
  },
  { id: 'tool', look: 'entry', show: { shape: 'tile' }, opens: 'package:pdf' },
  { id: 'run', look: 'action', show: { shape: 'row' }, tools: [{ tool: 'pdf-merge' }] },
  { id: 'open', look: 'picker', show: { shape: 'icon' }, tools: [{ tool: '$pick.open' }] },
  { id: 'photos', look: 'picker', tools: [{ tool: '$pick.media' }] },
  { id: 'library', look: 'library', source: { catalog: 'quickActions', kind: 'image' } },
  {
    id: 'grid',
    look: 'packages',
    show: { title: 'Docs' },
    source: { catalog: 'packages', ids: ['pdf'] },
  },
  { id: 'my-apps', look: 'apps', source: { catalog: 'apps' } },
  {
    id: 'add',
    look: 'button',
    show: { label: 'Add', variant: 'filled' },
    tools: [{ do: 'create', table: 'expenses', ask: 'all' }],
  },
  {
    id: 'to-toolbox',
    look: 'button',
    show: { label: 'Toolbox', variant: 'row', icon: 'apps' },
    opens: 'tools',
  },
  {
    id: 'pair',
    look: 'group',
    show: { layout: 'row' },
    children: [
      { id: 'pair-line', look: 'divider', hidden: true },
      { id: 'pair-run', look: 'action', tools: [{ tool: 'pdf-merge' }] },
    ],
  },
];

/** A v40 config: the default workspace with PDF, a table and a page holding every look v41 merged. */
function v40Config(): Json {
  const config = JSON.parse(JSON.stringify(workspace('en', { withPdf: true }))) as Json;
  config.schemaVersion = 40;
  config.data.tables.push(expenses);
  config.containers.pages.push({ id: 'old', title: 'Old', blocks: OLD_BLOCKS });
  config.containers.desk = {
    above: [{ id: 'desk-line', look: 'divider' }],
    below: [
      { id: 'desk-help', look: 'entry', show: { title: 'Help', icon: 'info' }, opens: 'settings' },
    ],
  };
  return config;
}

const migrated = () => {
  const result = migrateWorkspace(v40Config());
  if (!result.ok) throw new Error(result.error);
  return result.config as Json;
};
const page = (config: Json) => config.containers.pages.find((p: Json) => p.id === 'old');
const block = (config: Json, id: string) => {
  const all = page(config).blocks.flatMap((b: Json) => [b, ...(b.children ?? [])]);
  return all.find((b: Json) => b.id === id);
};

describe('v40 → v41: merged looks', () => {
  it('upgrades a v40 config with every merged look and it validates', () => {
    const result = prepareSnapshot(v40Config(), registry);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('turns each old look into the new one with the same content', () => {
    const c = migrated();
    expect(c.schemaVersion).toBe(41);
    expect(block(c, 'line')).toEqual({
      id: 'line',
      look: 'spacer',
      show: { size: 'small', line: true },
    });
    expect(block(c, 'gap')).toEqual({ id: 'gap', look: 'spacer', show: { size: 'medium' } });
    expect(block(c, 'range')).toEqual({
      id: 'range',
      look: 'tabs',
      show: { periods: ['thisWeek', 'thisMonth'], default: 'thisMonth', custom: true },
    });
    expect(block(c, 'by-category')).toEqual({
      id: 'by-category',
      look: 'tabs',
      source: { table: 'expenses', field: 'category' },
      show: {},
    });
    expect(block(c, 'due')).toEqual({ ...OLD_BLOCKS[6], look: 'notice' });
    expect(block(c, 'go')).toEqual({
      id: 'go',
      look: 'button',
      show: { label: 'Tools', icon: 'apps', shape: 'tile' },
      opens: 'tools',
    });
    expect(block(c, 'slot')).toEqual({
      id: 'slot',
      look: 'button',
      show: { label: 'Lease', hint: 'Pick the PDF' },
      opens: { file: null },
    });
    expect(block(c, 'tool')).toEqual({
      id: 'tool',
      look: 'button',
      show: { shape: 'tile' },
      opens: 'package:pdf',
    });
    expect(block(c, 'run')).toEqual({
      id: 'run',
      look: 'button',
      show: { shape: 'row' },
      tools: [{ tool: 'pdf-merge' }],
    });
    expect(block(c, 'open')).toEqual({
      id: 'open',
      look: 'button',
      show: { shape: 'icon' },
      tools: [{ tool: '$pick.open' }],
    });
    expect(block(c, 'photos')).toEqual({
      id: 'photos',
      look: 'button',
      tools: [{ tool: '$pick.media' }],
    });
    expect(block(c, 'library')).toEqual({ ...OLD_BLOCKS[13], look: 'catalog' });
    expect(block(c, 'grid')).toEqual({ ...OLD_BLOCKS[14], look: 'catalog' });
    expect(block(c, 'my-apps')).toEqual({ ...OLD_BLOCKS[15], look: 'catalog' });
    expect(block(c, 'add').show).toEqual({ label: 'Add', shape: 'filled' });
    expect(block(c, 'to-toolbox').show).toEqual({ label: 'Toolbox', shape: 'row', icon: 'apps' });
    // Blocks inside a group, keeping hidden.
    expect(block(c, 'pair-line')).toEqual({
      id: 'pair-line',
      look: 'spacer',
      show: { size: 'small', line: true },
      hidden: true,
    });
    expect(block(c, 'pair-run')).toEqual({
      id: 'pair-run',
      look: 'button',
      tools: [{ tool: 'pdf-merge' }],
    });
    // Blocks that were not merged are untouched.
    expect(block(c, 'title')).toEqual(OLD_BLOCKS[0]);
    expect(block(c, 'list')).toEqual(OLD_BLOCKS[5]);
  });

  it('keeps the keys of a block in their order', () => {
    expect(Object.keys(block(migrated(), 'go'))).toEqual(['id', 'look', 'show', 'opens']);
    expect(Object.keys(block(migrated(), 'go').show)).toEqual(['label', 'icon', 'shape']);
  });

  it('migrates the blocks above and below the file preview', () => {
    expect(migrated().containers.desk).toEqual({
      above: [{ id: 'desk-line', look: 'spacer', show: { size: 'small', line: true } }],
      below: [
        {
          id: 'desk-help',
          look: 'button',
          show: { label: 'Help', icon: 'info' },
          opens: 'settings',
        },
      ],
    });
  });

  it('keeps every other part of the config as it was', () => {
    const before = v40Config();
    const after = migrated();
    for (const key of ['theme', 'nav', 'data', 'tools', 'packages'])
      expect(after[key]).toEqual(before[key]);
    expect(after.containers.pages.map((p: Json) => p.id)).toEqual(
      before.containers.pages.map((p: Json) => p.id),
    );
  });
});

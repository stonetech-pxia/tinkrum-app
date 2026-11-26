import { describe, expect, it } from 'vitest';

import { blockEdit, buttonKind, buttonShape } from './components';
import { registry, workspace } from './test-helpers';
import { validateWorkspace } from './validate';
import type { ComponentOf, WorkspaceConfig } from './schema';

// The looks merged by D-new-kernel-available-resources-3ffb5b-1: what a button does follows from
// its opens or tools, and each kind only takes the shapes and texts it can draw; tabs take one of
// two forms; a notice only counts entries when it has a source; the file preview's slots keep
// refusing what they refused before the merge.

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
  ],
};

/** A valid config with PDF, the expenses table and a page holding these blocks. */
function withBlocks(blocks: Json[], desk?: Json): Json {
  const config = JSON.parse(JSON.stringify(workspace('en', { withPdf: true }))) as Json;
  config.data.tables.push(expenses);
  config.containers.pages.push({ id: 'test', title: 'Test', blocks });
  if (desk) config.containers.desk = desk;
  return config;
}
const messages = (config: Json) => {
  const result = validateWorkspace(config, registry);
  return result.ok ? [] : result.issues.map((i) => i.message);
};
const ok = (config: Json) => expect(messages(config)).toEqual([]);
const refused = (config: Json, pattern: RegExp) =>
  expect(messages(config).join('\n')).toMatch(pattern);

const button = (rest: Json) => ({ id: 'b', look: 'button', ...rest }) as ComponentOf<'button'>;

describe('button: what it does', () => {
  it('is read from tools or opens', () => {
    expect(buttonKind(button({ tools: [{ tool: 'pdf-merge' }] }))).toBe('run');
    expect(buttonKind(button({ tools: [{ tool: '$pick.files' }] }))).toBe('pick');
    expect(buttonKind(button({ tools: [{ do: 'create', table: 'expenses' }] }))).toBe('record');
    expect(buttonKind(button({ opens: { file: null } }))).toBe('file');
    expect(buttonKind(button({ opens: 'package:pdf' }))).toBe('package');
    expect(buttonKind(button({ opens: 'app:work' }))).toBe('app');
    expect(buttonKind(button({ opens: 'tools', show: { accent: true } }))).toBe('link');
    expect(buttonKind(button({ opens: 'page:home' }))).toBe('open');
  });

  it('takes the shape of what it does when none is given', () => {
    expect(buttonShape(button({ opens: 'page:home' }))).toBe('row');
    expect(buttonShape(button({ opens: 'package:pdf' }))).toBe('tile');
    expect(buttonShape(button({ tools: [{ do: 'create', table: 'expenses' }] }))).toBe('filled');
    expect(buttonShape(button({ tools: [{ tool: '$pick.media' }] }))).toBe('text');
    // A quick action to run is placed by its neighbours (D-230).
    expect(buttonShape(button({ tools: [{ tool: 'pdf-merge' }] }))).toBeUndefined();
  });

  it('accepts every kind with the shapes it can draw', () => {
    ok(
      withBlocks([
        { id: 'run', look: 'button', show: { shape: 'card' }, tools: [{ tool: 'pdf-merge' }] },
        { id: 'pick', look: 'button', show: { shape: 'icon' }, tools: [{ tool: '$pick.open' }] },
        {
          id: 'add',
          look: 'button',
          show: { label: 'Add', shape: 'outline' },
          tools: [{ do: 'create', table: 'expenses', ask: 'all' }],
        },
        {
          id: 'slot',
          look: 'button',
          show: { label: 'Lease', hint: 'Pick it' },
          opens: { file: null },
        },
        { id: 'tool', look: 'button', opens: 'package:pdf' },
        {
          id: 'go',
          look: 'button',
          show: { label: 'Home', icon: 'home', shape: 'tile' },
          opens: 'page:home',
        },
        {
          id: 'plain',
          look: 'button',
          show: { label: 'Settings', shape: 'text' },
          opens: 'settings',
        },
      ]),
    );
  });

  it('refuses a shape that does not fit what it does', () => {
    refused(
      withBlocks([
        { id: 'run', look: 'button', show: { shape: 'filled' }, tools: [{ tool: 'pdf-merge' }] },
      ]),
      /shape "filled" doesn't fit what it does/,
    );
    refused(
      withBlocks([
        {
          id: 'add',
          look: 'button',
          show: { label: 'Add', shape: 'card' },
          tools: [{ do: 'create', table: 'expenses' }],
        },
      ]),
      /shape "card" doesn't fit/,
    );
  });

  it('refuses a label where Tinkrum supplies it, and wants one where it does not', () => {
    refused(
      withBlocks([
        { id: 'run', look: 'button', show: { label: 'Merge' }, tools: [{ tool: 'pdf-merge' }] },
      ]),
      /come from the quick action/,
    );
    refused(
      withBlocks([
        { id: 'pick', look: 'button', show: { label: 'Open' }, tools: [{ tool: '$pick.media' }] },
      ]),
      /come from Tinkrum/,
    );
    refused(
      withBlocks([{ id: 'go', look: 'button', show: { shape: 'text' }, opens: 'settings' }]),
      /needs show.label/,
    );
  });

  it('refuses opens and a tool together, and a hint outside a file slot', () => {
    refused(
      withBlocks([
        {
          id: 'both',
          look: 'button',
          show: { label: 'Both' },
          opens: 'settings',
          tools: [{ tool: '$pick.media' }],
        },
      ]),
      /either opens something or has a tool/,
    );
    refused(
      withBlocks([
        { id: 'go', look: 'button', show: { label: 'Go', hint: 'x' }, opens: 'settings' },
      ]),
      /show.hint only applies to a file slot/,
    );
  });

  it('offers in long-press edit only what that kind of button can change', () => {
    expect(blockEdit(button({ opens: 'package:pdf' })).text).toEqual([]);
    expect(blockEdit(button({ tools: [{ tool: 'pdf-merge' }] })).text).toEqual([]);
    expect(blockEdit(button({ opens: { file: null }, show: { label: 'x' } })).asset).toBe('file');
    expect(blockEdit(button({ opens: 'settings', show: { label: 'x', shape: 'filled' } }))).toEqual(
      {
        text: [{ prop: 'label', max: 40 }],
        style: ['align'],
      },
    );
  });
});

describe('tabs', () => {
  it('allows one time tabs and one by a choice field on a page', () => {
    ok(
      withBlocks([
        { id: 'range', look: 'tabs', show: { periods: ['thisWeek', 'thisMonth'] } },
        { id: 'by', look: 'tabs', source: { table: 'expenses', field: 'category' }, show: {} },
        {
          id: 'list',
          look: 'list',
          source: { table: 'expenses', period: 'page', choice: 'page' },
          show: { title: 'note' },
        },
      ]),
    );
  });

  it('refuses two of the same kind, periods with a source, and tabs without either', () => {
    refused(
      withBlocks([
        { id: 'a', look: 'tabs', show: { periods: ['thisWeek'] } },
        { id: 'b', look: 'tabs', show: { periods: ['thisMonth'] } },
      ]),
      /more than one time tabs block/,
    );
    refused(
      withBlocks([
        {
          id: 'a',
          look: 'tabs',
          source: { table: 'expenses', field: 'category' },
          show: { periods: ['thisWeek'] },
        },
      ]),
      /not periods/,
    );
    refused(withBlocks([{ id: 'a', look: 'tabs', show: {} }]), /need show.periods/);
  });

  it('makes a block that follows the page range need time tabs', () => {
    refused(
      withBlocks([
        {
          id: 'list',
          look: 'list',
          source: { table: 'expenses', period: 'page' },
          show: { title: 'note' },
        },
      ]),
      /needs time tabs/,
    );
  });
});

describe('notice', () => {
  it('counts entries only with a source', () => {
    ok(
      withBlocks([
        {
          id: 'due',
          look: 'notice',
          show: { text: '{count} entries, {sum:amount}', openLabel: 'Open' },
          source: { table: 'expenses' },
          opens: 'settings',
        },
      ]),
    );
    refused(
      withBlocks([{ id: 'tip', look: 'notice', show: { text: '{count} entries' } }]),
      /need source/,
    );
    refused(
      withBlocks([
        {
          id: 'tip',
          look: 'notice',
          show: { text: 'Add one', actionLabel: 'Add' },
          tools: [{ do: 'create', table: 'expenses' }],
        },
      ]),
      /tools need source/,
    );
  });
});

describe('file preview slots', () => {
  it('still refuse a button that runs a quick action or picks files, and a notice about entries', () => {
    const page = (desk: Json) => withBlocks([], desk) as unknown as WorkspaceConfig;
    expect(
      messages(
        page({ above: [{ id: 'go', look: 'button', show: { label: 'Help' }, opens: 'settings' }] }),
      ),
    ).toEqual([]);
    refused(
      page({ above: [{ id: 'run', look: 'button', tools: [{ tool: 'pdf-merge' }] }] }),
      /above or below the preview/,
    );
    refused(
      page({ below: [{ id: 'pick', look: 'button', tools: [{ tool: '$pick.media' }] }] }),
      /above or below the preview/,
    );
    refused(
      page({
        below: [{ id: 'n', look: 'notice', show: { text: 'x' }, source: { table: 'expenses' } }],
      }),
      /above or below the preview/,
    );
  });
});

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from './defaults';
import { prepareOps } from './change';
import { SAMPLE_APPS, sampleOps } from './samples';
import { createStarterWorkspace } from './starter';
import { checkRequestParams, checkTools, tableIsShown, type ToolCheckResult } from './tool-check';
import type { Collection, Component, QuickAction, Reminder, WorkspaceConfig } from './schema';
import { registry } from './test-helpers';
import { WORKFLOW_PRESETS, presetWorkflow } from './workflows/presets';

// Tool checks: assertions written as 'expected behavior'. Examples reflect real incidents from two
// rounds of testing (AGENT_PLAN §2, REPORT2). Configs are constructed directly, bypassing the
// validator: some examples (target table lacking an attachment field) are normally rejected by the
// validator, but here we test whether the checker recognizes them.

const text = (id: string, required = false) =>
  ({
    id,
    name: id,
    type: 'text',
    ...(required ? { required } : {}),
  }) as Collection['fields'][number];
const number = (id: string) => ({ id, name: id, type: 'number' }) as Collection['fields'][number];
const table = (id: string, fields: Collection['fields'], name = id): Collection => ({
  id,
  name,
  fields,
});

const list = (id: string, tableId: string, extra: object = {}) =>
  ({
    id,
    look: 'list',
    source: { table: tableId, limit: 30 },
    show: { title: 'title' },
    ...extra,
  }) as unknown as Component;
const addButton = (id: string, tableId: string) =>
  ({
    id,
    look: 'button',
    show: { label: 'Add', shape: 'filled' },
    tools: [{ do: 'create', table: tableId, ask: 'all' }],
  }) as unknown as Component;
const form = (id: string, tableId: string, ask: string[], values?: object) =>
  ({
    id,
    look: 'form',
    show: { mode: 'inline' },
    tools: [
      {
        as: 'submit',
        label: 'Save',
        do: 'create',
        table: tableId,
        ask,
        ...(values ? { values } : {}),
      },
    ],
  }) as unknown as Component;
const stat = (id: string, tableId: string) =>
  ({
    id,
    look: 'number',
    show: { label: 'Total' },
    source: { table: tableId, aggregate: 'count' },
  }) as unknown as Component;
const entry = (id: string, opens: string) =>
  ({ id, look: 'button', show: { label: id, icon: 'document' }, opens }) as unknown as Component;
const action = (id: string, tool: string) =>
  ({ id, look: 'button', tools: [{ tool }] }) as unknown as Component;

const quick = (id: string, steps: [string, object, (string[] | undefined)?][]): QuickAction => ({
  id,
  kind: 'quickAction',
  name: id,
  steps: steps.map(([a, params, ask], i) => ({
    id: `s${i}`,
    action: a,
    params: params as Record<string, unknown>,
    ...(ask ? { ask } : {}),
  })),
});

function workspace(parts: {
  tables?: Collection[];
  home?: Component[];
  pages?: { id: string; blocks: Component[]; of?: string }[];
  tools?: (QuickAction | Reminder)[];
}): WorkspaceConfig {
  const config = createDefaultWorkspace('en');
  config.data.tables = parts.tables ?? [];
  config.containers.pages[0]!.blocks.push(...(parts.home ?? []));
  for (const p of parts.pages ?? []) config.containers.pages.push({ title: p.id, ...p });
  config.tools = parts.tools ?? [];
  return config;
}

const check = (config: WorkspaceConfig) => checkTools(config, registry);
const codes = (r: ToolCheckResult, severity?: 'blocker' | 'warning') =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const tool = (r: ToolCheckResult, id: string) => r.tools.find((t) => t.id === id)!;
/** A usable table: has an add button and a list on the home screen. */
const usable = (id: string) => [addButton(`add-${id}`, id), list(`list-${id}`, id)];

describe('tableIsShown', () => {
  const tables = [table('t', [text('title')])];

  it('no block read: not visible', () => {
    expect(tableIsShown(workspace({ tables, pages: [] }), 't', registry)).toBe(false);
  });

  it('block read exists on reachable page: visible', () => {
    const config = workspace({ tables, pages: [{ id: 'ledger', blocks: usable('t') }] });
    const shown = {
      ...config,
      nav: { ...config.nav, bar: [...config.nav.bar, 'page:ledger' as const] },
    };
    expect(tableIsShown(shown, 't', registry)).toBe(true);
  });

  it('block on unreachable page: still not visible', () => {
    const config = workspace({ tables, pages: [{ id: 'ledger', blocks: usable('t') }] });
    expect(tableIsShown(config, 't', registry)).toBe(false);
  });
});

describe('file tools', () => {
  const chain = quick('send', [
    ['in.photos', { source: 'library', min: 1, max: 5 }],
    ['image.compress', { maxKB: 500, format: 'jpeg' }],
    ['out.share', {}],
  ]);

  it('linked, fully parameterized, placed on page: usable, no issues', () => {
    const r = check(workspace({ tools: [chain], home: [action('run', 'send')] }));
    expect(r.issues).toEqual([]);
    expect(tool(r, 'send')).toMatchObject({ kind: 'file', ok: true });
    expect(tool(r, 'send').checks).toMatchObject({ chain: true, params: true, entry: 'placed' });
  });

  it('input action not in first step: unusable', () => {
    // File collection quick action step passes files via record attachment field (D-442); input actions can only be placed in the first step.
    const wf = quick('bad', [
      ['image.compress', { maxKB: 500, format: 'jpeg' }],
      ['in.photos', { source: 'library', min: 1, max: 5 }],
    ]);
    const r = check(workspace({ tools: [wf], home: [action('run', 'bad')] }));
    expect(codes(r, 'blocker')).toContain('step-source');
    expect(tool(r, 'bad').ok).toBe(false);
  });

  it('adjacent step types incompatible: unusable', () => {
    const wf = quick('bad', [
      ['in.videos', { source: 'library', min: 1, max: 1 }],
      ['image.compress', { maxKB: 500, format: 'jpeg' }],
    ]);
    expect(codes(check(workspace({ tools: [wf] })), 'blocker')).toContain('step-binding');
  });

  it('missing required parameters: unusable', () => {
    const wf = quick('bad', [
      ['in.photos', { source: 'library', min: 1, max: 5 }],
      ['image.compress', {}],
    ]);
    expect(codes(check(workspace({ tools: [wf] })), 'blocker')).toContain('step-params');
  });

  it('only in Settings -> Quick Actions: reachable, so warns only', () => {
    const r = check(workspace({ tools: [chain] }));
    expect(codes(r)).toEqual(['no-entry']);
    expect(r.issues[0]!.severity).toBe('warning');
    expect(tool(r, 'send')).toMatchObject({ ok: true });
    expect(tool(r, 'send').checks).toMatchObject({ entry: 'settings' });
  });

  it.each([
    ['入口块', { home: [entry('go', 'tool:send')] }, {}],
    [
      '快捷操作库块',
      {
        home: [
          { id: 'l', look: 'catalog', source: { catalog: 'quickActions' } } as unknown as Component,
        ],
      },
      {},
    ],
    ['手机桌面', {}, { phoneHomeScreen: ['send'] }],
  ])('%s also counts as an entry point', (_name, parts, nav) => {
    const config = workspace({ tools: [chain], ...parts });
    Object.assign(config.nav, nav);
    expect(codes(check(config))).toEqual([]);
  });

  it('quick actions added from presets reside in the preset library and are not considered missing entry points', () => {
    const r = check(workspace({ tools: [{ ...chain, preset: 'email-photos' }] }));
    expect(codes(r)).toEqual([]);
  });

  it('entry points on unreachable pages do not count', () => {
    const config = workspace({
      tools: [chain],
      pages: [{ id: 'lost', blocks: [action('run', 'send')] }],
    });
    expect(codes(check(config))).toEqual(expect.arrayContaining(['no-entry', 'page-unreachable']));
  });
});

describe('record tools: 4 issues', () => {
  it('has add and list: usable', () => {
    const r = check(
      workspace({ tables: [table('tasks', [text('title', true)])], home: usable('tasks') }),
    );
    expect(r.issues).toEqual([]);
    expect(tool(r, 'tasks')).toMatchObject({ kind: 'record', ok: true });
    expect(tool(r, 'tasks').checks).toMatchObject({
      where: true,
      add: true,
      view: true,
      remind: null,
    });
  });

  it('button targets table A, stats read table B: both sides unusable, warns about mismatched purposes', () => {
    const fields = [text('title'), number('amount')];
    const r = check(
      workspace({
        tables: [table('expenses', fields, 'Expenses'), table('spending', fields, 'Spending')],
        home: [addButton('add', 'expenses'), stat('total', 'spending')],
      }),
    );
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'view-missing', target: 'table:expenses' }),
        expect.objectContaining({ code: 'add-missing', target: 'table:spending' }),
        expect.objectContaining({ code: 'duplicate-table', severity: 'warning' }),
      ]),
    );
  });

  it('two unrelated tables writing and reading independently do not trigger duplicate warnings', () => {
    const r = check(
      workspace({
        tables: [
          table('tasks', [text('title'), text('owner')], 'Tasks'),
          table('books', [text('author'), number('pages')], 'Books'),
        ],
        home: [addButton('add', 'tasks'), stat('total', 'books')],
      }),
    );
    expect(codes(r)).not.toContain('duplicate-table');
  });

  it('two similar tables both reading and writing (each usable) do not trigger duplicate warnings', () => {
    const fields = [text('title'), number('amount')];
    const r = check(
      workspace({
        tables: [table('a', fields, 'Spending 2025'), table('b', fields, 'Spending 2026')],
        home: [...usable('a'), ...usable('b')],
      }),
    );
    expect(codes(r)).not.toContain('duplicate-table');
  });

  it('form missing required fields: can never be saved', () => {
    const r = check(
      workspace({
        tables: [table('t', [text('title', true), text('amount', true)])],
        home: [form('f', 't', ['title']), list('l', 't')],
      }),
    );
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'add-missing-required', severity: 'blocker' }),
      ]),
    );
    expect(tool(r, 't').ok).toBe(false);
    expect(tool(r, 't').checks).toMatchObject({ add: false });
  });

  it('required fields with default values, preset values, or opening the full form: not considered missing', () => {
    const withDefault = { ...text('b', true), default: 'x' } as Collection['fields'][number];
    const choice = {
      id: 'kind',
      name: 'kind',
      type: 'choice',
      required: true,
      options: [{ id: 'a', label: 'A' }],
    } as Collection['fields'][number];
    const r = check(
      workspace({
        tables: [table('t', [text('title', true), withDefault, choice])],
        home: [form('f', 't', ['title'], { kind: 'a' }), addButton('add', 't'), list('l', 't')],
      }),
    );
    expect(codes(r, 'blocker')).toEqual([]);
  });

  it('nothing can be added: unusable', () => {
    const r = check(workspace({ tables: [table('t', [text('title')])], home: [list('l', 't')] }));
    expect(codes(r, 'blocker')).toEqual(['add-missing']);
  });

  it('Settings -> Data is not an add entry point (it only supports export and restore), record tables cannot rely on it for visibility', () => {
    const r = check(
      workspace({ tables: [table('t', [text('title')])], home: [addButton('a', 't')] }),
    );
    expect(codes(r, 'blocker')).toEqual(['view-missing']);
  });

  it("only 'new' button on individual rows: first entry cannot be added", () => {
    const rowAdd = list('l', 't', {
      tools: [{ as: 'button', label: 'Add', do: 'create', table: 't', ask: 'all' }],
    });
    const r = check(workspace({ tables: [table('t', [text('title')])], home: [rowAdd] }));
    expect(codes(r, 'blocker')).toEqual(['add-needs-existing-row']);
  });

  it("'new' button on rows of another table ($row) counts as an add entry point; inline add also counts", () => {
    const habits = table('habits', [text('title')]);
    const checkins = table('checkins', [
      { id: 'habit', name: 'habit', type: 'link', table: 'habits' } as Collection['fields'][number],
      { id: 'n', name: 'n', type: 'number' } as Collection['fields'][number],
    ]);
    const tiles = {
      id: 't',
      look: 'tiles',
      source: { table: 'habits', limit: 24 },
      show: { title: 'title' },
      tools: [
        { as: 'tap', label: 'Done', do: 'create', table: 'checkins', values: { habit: '$row' } },
      ],
    } as unknown as Component;
    const here = list('l', 'checkins', {
      show: { title: 'n' },
      tools: [{ as: 'addHere', do: 'create', table: 'checkins', ask: 'all' }],
    });
    const r = check(
      workspace({ tables: [habits, checkins], home: [addButton('a', 'habits'), tiles, here] }),
    );
    expect(codes(r, 'blocker')).toEqual([]);
  });

  it("tables with attachment fields lacking add entry points can add entries via inbox 'Save as record', warns only", () => {
    const r = check(
      workspace({
        tables: [
          table('t', [
            text('title'),
            { id: 'file', name: 'file', type: 'file' } as Collection['fields'][number],
          ]),
        ],
        home: [list('l', 't')],
      }),
    );
    expect(codes(r, 'blocker')).toEqual([]);
    expect(codes(r)).toContain('add-only-from-inbox');
  });

  it('hidden blocks do not count', () => {
    const hidden = { ...(list('l', 't') as object), hidden: true } as unknown as Component;
    const r = check(
      workspace({ tables: [table('t', [text('title')])], home: [addButton('a', 't'), hidden] }),
    );
    expect(codes(r, 'blocker')).toEqual(['view-missing']);
  });

  it('page has no entry point: page and its tools are unusable', () => {
    const r = check(
      workspace({
        tables: [table('t', [text('title')])],
        pages: [{ id: 'ledger', blocks: usable('t') }],
      }),
    );
    expect(codes(r, 'blocker').sort()).toEqual([
      'add-unreachable',
      'page-unreachable',
      'view-unreachable',
    ]);
  });

  it('entry point must be reachable from a reachable page: opening solely via another unreachable page does not count', () => {
    const r = check(
      workspace({
        pages: [
          { id: 'a', blocks: [entry('to-b', 'page:b')] },
          { id: 'b', blocks: [entry('to-a', 'page:a')] },
        ],
      }),
    );
    expect(r.issues.filter((i) => i.code === 'page-unreachable')).toHaveLength(2);
  });

  it('page has entry point (home entry block, navigation, record block opens): no warning', () => {
    const config = workspace({
      tables: [table('t', [text('title')])],
      home: [entry('go', 'page:tasks'), addButton('a', 't')],
      pages: [
        { id: 'tasks', blocks: [list('l', 't', { opens: 'one' })] },
        { id: 'one', of: 't', blocks: [stat('n', 't')] },
        { id: 'bar', blocks: [stat('m', 't')] },
      ],
    });
    config.nav.bar = [...config.nav.bar.slice(0, 4), 'page:bar'];
    expect(codes(check(config), 'blocker')).toEqual([]);
  });

  it('tool pack pages are reachable in Settings -> Tools, no warning', () => {
    const config = workspace({ pages: [{ id: 'pdf', blocks: [action('r', 'x')] }] });
    config.containers.pages[1]!.package = 'pdf';
    expect(codes(check(config))).not.toContain('page-unreachable');
  });

  it('tables with nothing in use warn only: user may no longer want them while preserving data (invariant 5)', () => {
    const r = check(workspace({ tables: [table('old', [text('title')])] }));
    expect(codes(r)).toEqual(['table-unused']);
    expect(r.issues[0]!.severity).toBe('warning');
    expect(tool(r, 'old').ok).toBe(false);
  });

  it('tables visible only via reference fields (lookup tables) count as visible, but remain unusable if no one adds entries to them', () => {
    const r = check(
      workspace({
        tables: [
          table('rooms', [text('title')]),
          table('tasks', [
            text('title'),
            {
              id: 'room',
              name: 'room',
              type: 'link',
              table: 'rooms',
            } as Collection['fields'][number],
          ]),
        ],
        home: [form('f', 'tasks', ['title', 'room']), list('l', 'tasks')],
      }),
    );
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'add-missing', target: 'table:rooms', severity: 'blocker' }),
    ]);
  });
});

describe('record tools: warnings', () => {
  const plants = table('plants', [
    text('title'),
    {
      id: 'water',
      name: 'water',
      type: 'schedule',
      default: { repeat: 'interval', every: 7 },
    } as unknown as Collection['fields'][number],
  ]);
  const reminder = (extra: Partial<Reminder>): Reminder => ({
    id: 'r',
    kind: 'reminder',
    title: 'Water',
    enabled: true,
    when: { each: { table: 'plants', field: 'water' }, at: '09:00' },
    opens: 'page:plants-page',
    ...extra,
  });
  const page = { id: 'plants-page', blocks: usable('plants') };

  it('opened page reads this table: usable', () => {
    const config = workspace({ tables: [plants], pages: [page], tools: [reminder({})] });
    config.nav.bar = [...config.nav.bar.slice(0, 4), 'page:plants-page'];
    const r = check(config);
    expect(codes(r, 'blocker')).toEqual([]);
    expect(tool(r, 'plants').checks).toMatchObject({ remind: true });
  });

  it('opened page lacks relevant content: unusable', () => {
    const r = check(
      workspace({
        tables: [plants],
        home: usable('plants').slice(0, 0),
        pages: [
          {
            id: 'other',
            blocks: [{ id: 'h', look: 'header', show: { title: 'x' } } as unknown as Component],
          },
          { id: 'plants-page', blocks: usable('plants') },
        ],
        tools: [reminder({ opens: 'page:other' })],
      }),
    );
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'reminder-opens-unrelated', severity: 'blocker' }),
      ]),
    );
    expect(tool(r, 'plants').checks).toMatchObject({ remind: false });
  });

  it('opening home screen does not trigger unusable status (rule 35 allows new table warnings to defer to home screen): warns only', () => {
    const r = check(
      workspace({
        tables: [plants],
        home: [{ id: 'h', look: 'header', show: { title: 'x' } } as unknown as Component],
        pages: [{ id: 'plants-page', blocks: usable('plants') }],
        tools: [reminder({ opens: 'page:home' })],
      }),
    );
    expect(r.issues.filter((i) => i.code === 'reminder-opens-unrelated')).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
    expect(tool(r, 'plants').checks).not.toMatchObject({ remind: false });
  });

  it('opened page reads related table (forward reference): considered correct', () => {
    const logs = table('logs', [
      text('title'),
      { id: 'plant', name: 'plant', type: 'link', table: 'plants' } as Collection['fields'][number],
    ]);
    const r = check(
      workspace({
        tables: [plants, logs],
        home: usable('plants'),
        pages: [{ id: 'log-page', blocks: usable('logs') }],
        tools: [reminder({ opens: 'page:log-page' })],
      }),
    );
    expect(codes(r)).not.toContain('reminder-opens-unrelated');
  });

  it('opened page is merely an entry point leading to that page: warns only', () => {
    const r = check(
      workspace({
        tables: [plants],
        home: [entry('go', 'page:plants-page')],
        pages: [page],
        tools: [reminder({ opens: 'page:home' })],
      }),
    );
    expect(codes(r)).toContain('reminder-opens-indirect');
    expect(codes(r, 'blocker')).toEqual([]);
  });

  it("'done' writes to table A, 'dismiss' reads table B: clicking done still triggers warning", () => {
    const r = check(
      workspace({
        tables: [plants, table('logs', [text('title')])],
        home: [...usable('plants'), ...usable('logs')],
        tools: [
          reminder({
            opens: 'page:home',
            done: { do: 'create', table: 'logs' },
            unless: { table: 'plants', within: 'day' },
          }),
        ],
      }),
    );
    expect(codes(r, 'blocker')).toContain('reminder-done-wrong-table');
  });

  it("'done' and 'dismiss' target the same table: no warning", () => {
    const r = check(
      workspace({
        tables: [plants, table('logs', [text('title')])],
        home: [...usable('plants'), ...usable('logs')],
        tools: [
          reminder({
            opens: 'page:home',
            done: { do: 'create', table: 'logs' },
            unless: { table: 'logs', within: 'day' },
          }),
        ],
      }),
    );
    expect(codes(r)).not.toContain('reminder-done-wrong-table');
  });

  it('daily reminder opens page with no content: warns only', () => {
    const r = check(
      workspace({
        tools: [reminder({ when: { every: 'day', at: '09:00' }, opens: 'page:home' })],
      }),
    );
    expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('file to record', () => {
  const scan = (target: string) =>
    quick('scan', [
      ['in.photos', { source: 'scanner', min: 1, max: 5 }],
      ['out.addRecord', { collectionId: target }],
    ]);
  const receipts = table('receipts', [
    text('title'),
    { id: 'file', name: 'file', type: 'file' } as Collection['fields'][number],
  ]);

  it('target has attachment field, entry point, and visible table: usable, counts as both a tool and a table add entry point', () => {
    const r = check(
      workspace({
        tables: [receipts],
        home: [action('run', 'scan'), list('l', 'receipts')],
        tools: [scan('receipts')],
      }),
    );
    expect(r.issues).toEqual([]);
    expect(tool(r, 'scan')).toMatchObject({ kind: 'fileToRecord', ok: true });
    expect(tool(r, 'scan').checks).toMatchObject({ target: true, place: true, recordSide: true });
    expect(tool(r, 'receipts').checks).toMatchObject({ add: true });
  });

  it('target lacks attachment field: files cannot be stored', () => {
    const r = check(
      workspace({
        tables: [table('receipts', [text('title')])],
        home: [action('run', 'scan'), list('l', 'receipts')],
        tools: [scan('receipts')],
      }),
    );
    expect(codes(r, 'blocker')).toContain('record-no-place');
    expect(tool(r, 'scan').ok).toBe(false);
  });

  it('text input requires text fields, not attachment fields', () => {
    const wf = quick('note', [
      ['in.text', { text: 'x' }],
      ['out.addRecord', { collectionId: 'notes' }],
    ]);
    const ok = check(
      workspace({
        tables: [table('notes', [text('title')])],
        home: [list('l', 'notes')],
        tools: [wf],
      }),
    );
    expect(codes(ok, 'blocker')).toEqual([]);
    const bad = check(
      workspace({
        tables: [table('notes', [number('title')])],
        home: [list('l', 'notes', { show: { title: 'title' } })],
        tools: [wf],
      }),
    );
    expect(codes(bad, 'blocker')).toContain('record-no-place');
  });

  it('target table does not exist: unusable', () => {
    const r = check(workspace({ home: [action('run', 'scan')], tools: [scan('gone')] }));
    expect(codes(r, 'blocker')).toContain('step-table-missing');
    expect(tool(r, 'scan').checks).toMatchObject({ target: false });
  });

  it('table lacks any block reads: files stored are invisible, tool is incomplete', () => {
    const r = check(
      workspace({ tables: [receipts], home: [action('run', 'scan')], tools: [scan('receipts')] }),
    );
    expect(codes(r, 'blocker')).toContain('view-missing');
    expect(tool(r, 'scan').ok).toBe(false);
    expect(tool(r, 'scan').checks).toMatchObject({ recordSide: false });
  });
});

describe('fields', () => {
  it('neither displayed, nor prompted in forms, nor referenced: warns', () => {
    const r = check(
      workspace({
        tables: [table('t', [text('title'), text('phone')])],
        home: [form('f', 't', ['title']), list('l', 't')],
      }),
    );
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: 'field-unused',
        target: 'field:t.phone',
        severity: 'warning',
      }),
    ]);
  });

  it.each([
    [
      '显示在副标题',
      [
        form('f', 't', ['title']),
        list('l', 't', { show: { title: 'title', subtitles: ['phone'] } }),
      ],
    ],
    ['表单问了', [form('f', 't', ['title', 'phone']), list('l', 't')]],
    ['完整表单问了', [addButton('a', 't'), list('l', 't')]],
    [
      '筛选用了',
      [
        form('f', 't', ['title']),
        list('l', 't', {
          source: { table: 't', limit: 9, filter: [{ field: 'phone', op: 'isNotEmpty' }] },
        }),
      ],
    ],
  ])('%s: not counted as useless', (_name, blocks) => {
    const r = check(
      workspace({
        tables: [table('t', [text('title'), text('phone')])],
        home: blocks as Component[],
      }),
    );
    expect(codes(r)).not.toContain('field-unused');
  });

  it('fields referenced by formulas, rollups, or lookups are not considered unused', () => {
    const r = check(
      workspace({
        tables: [
          table('parents', [
            text('title'),
            { id: 'budget', name: 'budget', type: 'number' } as Collection['fields'][number],
            {
              id: 'total',
              name: 'total',
              type: 'rollup',
              table: 'kids',
              via: 'parent',
              aggregate: 'sum',
              field: 'amount',
            } as Collection['fields'][number],
          ]),
          table('kids', [
            text('title'),
            {
              id: 'parent',
              name: 'parent',
              type: 'link',
              table: 'parents',
            } as Collection['fields'][number],
            number('amount'),
            number('qty'),
            {
              id: 'double',
              name: 'double',
              type: 'formula',
              expression: '{qty} * 2',
            } as Collection['fields'][number],
            {
              id: 'pb',
              name: 'pb',
              type: 'lookup',
              via: 'parent',
              field: 'budget',
            } as Collection['fields'][number],
          ]),
        ],
        home: [
          ...usable('parents').slice(1),
          form('fp', 'parents', ['title']),
          list('p2', 'parents', { show: { title: 'title', trailing: 'total' } }),
          form('fk', 'kids', ['title', 'parent', 'amount', 'qty']),
          list('k', 'kids', { show: { title: 'title', subtitles: ['double', 'pb'] } }),
        ],
      }),
    );
    expect(r.issues.filter((i) => i.code === 'field-unused').map((i) => i.target)).toEqual([]);
  });

  it("fields used as 'last completed' by schedule fields are not considered unused", () => {
    const r = check(
      workspace({
        tables: [
          table('t', [
            text('title'),
            {
              id: 'next',
              name: 'next',
              type: 'schedule',
              default: { repeat: 'interval', every: 7 },
              lastDone: 'last',
            } as unknown as Collection['fields'][number],
            { id: 'last', name: 'last', type: 'date' } as Collection['fields'][number],
          ]),
        ],
        home: [form('f', 't', ['title', 'next']), list('l', 't')],
      }),
    );
    expect(codes(r)).not.toContain('field-unused');
  });

  it('fields required by computed values lack entry points: warns', () => {
    const tiles = {
      id: 't',
      look: 'tiles',
      source: { table: 't', limit: 9 },
      show: { title: 'title', trailing: 'double' },
      tools: [{ as: 'tap', label: 'x', do: 'create', table: 't' }],
    } as unknown as Component;
    const r = check(
      workspace({
        tables: [
          table('t', [
            text('title'),
            number('qty'),
            {
              id: 'double',
              name: 'double',
              type: 'formula',
              expression: '{qty} * 2',
            } as Collection['fields'][number],
          ]),
        ],
        home: [form('f', 't', ['title']), tiles],
      }),
    );
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'computed-input-missing', severity: 'warning' }),
      ]),
    );
  });

  it('dependent fields fillable in detail view edit page: no warning', () => {
    const r = check(
      workspace({
        tables: [
          table('t', [
            text('title'),
            number('qty'),
            {
              id: 'double',
              name: 'double',
              type: 'formula',
              expression: '{qty} * 2',
            } as Collection['fields'][number],
          ]),
        ],
        home: [
          form('f', 't', ['title']),
          list('l', 't', { show: { title: 'title', trailing: 'double' } }),
        ],
      }),
    );
    expect(codes(r)).not.toContain('computed-input-missing');
  });
});

describe('no false positives on real content (target: sample app and preset blockers = 0)', () => {
  it.each(['en', 'zh', 'fr'] as const)('All presets (%s)', (locale) => {
    for (const sample of SAMPLE_APPS) {
      const base = createStarterWorkspace(locale, registry);
      const ops = sampleOps(sample, base, locale);
      if (!ops.ok) throw new Error(ops.message);
      const prepared = prepareOps(base, ops.ops, { registry, locale, now: new Date(0) });
      if (!prepared.ok) throw new Error(prepared.issues.join('; '));
      expect(codes(check(prepared.after), 'blocker')).toEqual([]);
    }
  });

  it('all presets', () => {
    for (const preset of WORKFLOW_PRESETS) {
      const config = createDefaultWorkspace('en');
      config.tools = [presetWorkflow(preset, 'en', preset.id)];
      expect(check(config).issues).toEqual([]);
    }
  });

  it('read-only, config unmodified (invariant 15)', () => {
    const config = workspace({ tables: [table('t', [text('title')])], home: usable('t') });
    const before = JSON.stringify(config);
    check(config);
    checkRequestParams('2MB', 'en', config, config);
    expect(JSON.stringify(config)).toBe(before);
  });
});

describe('user-specified numbers and terms map to parameters', () => {
  const compress = (params: object, ask?: string[]) =>
    quick('c', [
      ['in.photos', { source: 'library', min: 1, max: 5 }],
      ['image.compress', { format: 'jpeg', ...params }, ask],
    ]);
  const pdf = (maxMB: number) =>
    quick('p', [
      ['in.photos', { source: 'library', min: 1, max: 5 }],
      [
        'pdf.fromImages',
        { pageSize: 'a4', orientation: 'auto', marginMm: 10, fit: 'contain', maxMB },
      ],
    ]);
  const with_ = (...tools: QuickAction[]) => workspace({ tools });
  const empty = workspace({});
  const run = (input: string, locale: 'en' | 'zh' | 'fr', after: WorkspaceConfig, before = empty) =>
    checkRequestParams(input, locale, before, after).map((i) => i.code);

  describe('Size', () => {
    it('"Fixed 2MB" only cleared ask, value is still old: should report', () => {
      const before = with_(pdf(4));
      const after = with_(pdf(4));
      after.tools[0] = { ...(after.tools[0] as QuickAction) };
      (after.tools[0] as QuickAction).steps[1]!.ask = [];
      expect(run('固定 2MB，不用每次问', 'zh', after, before)).toEqual(['param-size']);
    });

    it('"Fixed 2MB" written into maxMB: do not report', () => {
      expect(run('固定 2MB，不用每次问', 'zh', with_(pdf(2)), with_(pdf(4)))).toEqual([]);
    });

    it.each([
      ['压到 2048KB 换算：2MB', '压到 2MB', compress({ maxKB: 2048 })],
      ['1000 进制也认', 'compress to 2MB', compress({ maxKB: 2000 })],
      ['兆', '压到两兆', compress({ maxKB: 2048 })],
      ['2M', '压到2M', pdf(2)],
      ['Ko', 'compresser à 500 Ko', compress({ maxKB: 500 })],
      ['1 Mo = 1024 Ko', 'compresser à 1 Mo', compress({ maxKB: 1024 })],
      [
        '不超过 1 MB 写小一点也对',
        'il faut moins de 1 Mo par pièce jointe',
        compress({ maxKB: 900 }),
      ],
      ['两个数只要对上一个', '500MB 的文件压到 2MB', pdf(2)],
      ['否定的不算', '不要 2MB，改成 5MB', pdf(5)],
    ] as const)('%s: do not report', (_name, input, wf) => {
      const locale = /[一-龥]/.test(input)
        ? 'zh'
        : input.includes('Ko') || input.includes('Mo')
          ? 'fr'
          : 'en';
      expect(run(input, locale, with_(wf))).toEqual([]);
    });

    it('Says 500 KB, written as 300 KB: should report (three languages)', () => {
      for (const [input, locale] of [
        ['压到 500KB', 'zh'],
        ['compress to 500 KB', 'en'],
        ['compresser à 500 Ko', 'fr'],
      ] as const)
        expect(run(input, locale, with_(compress({ maxKB: 300 })))).toEqual(['param-size']);
    });

    it("New quick action's target size, but missing compression step: should report", () => {
      const wf = quick('n', [
        ['in.photos', { source: 'library', min: 1, max: 5 }],
        ['out.share', {}],
      ]);
      expect(run('压到 2MB 再分享', 'zh', with_(wf))).toEqual(['param-size']);
    });

    it('Uncertain ones not reported: untouched quick action, 4K, 2 mo (two months), existing chain with only one step added', () => {
      expect(run('固定 2MB', 'zh', empty, empty)).toEqual([]);
      expect(run('compress to 4K', 'en', with_(compress({ maxKB: 300 })))).toEqual([]);
      expect(run('keep it for 2 mo', 'en', with_(compress({ maxKB: 300 })))).toEqual([]);
      const before = with_(quick('n', [['in.photos', { source: 'library', min: 1, max: 5 }]]));
      const after = with_(
        quick('n', [
          ['in.photos', { source: 'library', min: 1, max: 5 }],
          ['out.share', {}],
        ]),
      );
      expect(run('那个 2MB 的快捷操作加一步分享', 'zh', after, before)).toEqual([]);
    });

    it('When modifying other quick actions, untouched quick actions do not count', () => {
      const other = pdf(4);
      const before = with_(other);
      const after = with_(other, compress({ maxKB: 2048 }));
      expect(run('压到 2MB', 'zh', after, before)).toEqual([]);
    });
  });

  describe('Target language', () => {
    const translate = (to: string) =>
      quick('t', [
        ['in.text', { text: 'x' }],
        ['translate.text', { from: 'auto', to }],
      ]);

    it.each([
      ['traduire mon relevé de notes en anglais', 'fr', 'fr'],
      ['翻译成英文', 'zh', 'zh-Hans'],
      ['国外寄来的信，拍一下变成英文 PDF', 'zh', 'zh-Hans'],
      ['translate it into English', 'en', 'fr'],
      ['翻译成中文', 'zh', 'en'],
      ['traduire en français', 'fr', 'en'],
      ['翻译成日语', 'zh', 'ko'],
    ] as const)('"%s" written in the wrong language: should report', (input, locale, to) => {
      expect(run(input, locale, with_(translate(to)))).toEqual(['param-language']);
    });

    it.each([
      ['traduire mon relevé de notes en anglais', 'fr', 'en'],
      ['翻译成英文', 'zh', 'en'],
      ['translate it into English', 'en', 'en'],
      ['翻译成中文', 'zh', 'zh-Hans'],
      ['翻译成中文', 'zh', 'zh-Hant'],
      ['翻译成繁体中文', 'zh', 'zh-Hant'],
      ['把英文翻译成法语', 'zh', 'fr'],
      ['translate from French to English', 'en', 'en'],
    ] as const)('"%s" \u2192 %s %s: do not report', (input, locale, to) => {
      expect(run(input, locale, with_(translate(to)))).toEqual([]);
    });

    it('Those without a target language are not reported', () => {
      expect(run('翻译这段英文', 'zh', with_(translate('zh-Hans')))).toEqual([]);
      expect(run('translate my English notes', 'en', with_(translate('fr')))).toEqual([]);
    });

    it('New quick action missing translation step: should report', () => {
      const wf = quick('n', [
        ['in.text', { text: 'x' }],
        ['text.toPdf', { pageSize: 'a4', fontSize: 12 }],
      ]);
      expect(run('翻译成英文再转 PDF', 'zh', with_(wf))).toEqual(['param-language']);
    });
  });

  describe('ID photo background color', () => {
    const idPhoto = (background: string) =>
      quick('id', [
        ['in.photos', { source: 'library', min: 1, max: 1 }],
        ['image.idPhoto', { spec: 'us-passport', maxKB: 240, background }],
      ]);

    it.each([
      ['换成蓝底', 'zh', 'white'],
      ['blue background', 'en', 'keep'],
      ['fond blanc', 'fr', 'blue'],
    ] as const)('"%s" written incorrectly: should report', (input, locale, background) => {
      expect(run(input, locale, with_(idPhoto(background)))).toEqual(['param-background']);
    });

    it.each([
      ['换成蓝底', 'zh', 'blue'],
      ['blue background', 'en', 'blue'],
      ['fond blanc', 'fr', 'white'],
      ['换成蓝底', 'zh', 'custom'],
    ] as const)('"%s" \u2192 %s %s: do not report', (input, locale, background) => {
      expect(run(input, locale, with_(idPhoto(background)))).toEqual([]);
    });

    it('Page\'s "blue background" is unrelated to ID photos: do not report', () => {
      expect(run('蓝色背景', 'zh', with_(compress({ maxKB: 300 })))).toEqual([]);
    });
  });

  describe('Pixels, playback speed, page count, resolution', () => {
    const resize = (params: object) =>
      quick('r', [
        ['in.photos', { source: 'library', min: 1, max: 5 }],
        ['image.resize', params],
      ]);
    const speed = (factor: number) =>
      quick('s', [
        ['in.videos', { source: 'library', min: 1, max: 1 }],
        ['video.speed', { factor }],
      ]);
    const split = (params: object) =>
      quick('sp', [
        ['in.files', { accept: 'pdf', min: 1, max: 1 }],
        ['pdf.split', params],
      ]);
    const select = (params: object) =>
      quick('se', [
        ['in.files', { accept: 'pdf', min: 1, max: 1 }],
        ['pdf.selectPages', params],
      ]);
    const video = (params: object) =>
      quick('v', [
        ['in.videos', { source: 'library', min: 1, max: 1 }],
        ['video.compress', params],
      ]);

    it('Pixels', () => {
      const wrong = resize({ mode: 'longEdge', px: 1600 });
      expect(run('长边 1080 像素', 'zh', with_(wrong))).toEqual(['param-pixels']);
      expect(run('long edge 1080 px', 'en', with_(wrong))).toEqual(['param-pixels']);
      expect(run('1080 pixels', 'fr', with_(wrong))).toEqual(['param-pixels']);
      expect(run('长边 1600 像素', 'zh', with_(wrong))).toEqual([]);
      expect(
        run('resize to 1920x1080', 'en', with_(resize({ mode: 'longEdge', px: 1920 }))),
      ).toEqual([]);
      // Percent scaling: specified pixels were not applied.
      expect(run('1080 px', 'en', with_(resize({ mode: 'percent', percent: 50 })))).toEqual([
        'param-pixels',
      ]);
      // ID photo dimensions are determined by specifications.
      const photo = quick('id', [
        ['in.photos', { source: 'library', min: 1, max: 1 }],
        ['image.idPhoto', { spec: 'us-passport', maxKB: 240 }],
      ]);
      expect(run('600×600 的证件照', 'zh', with_(photo))).toEqual([]);
      // Print dimensions are not pixels.
      expect(run('10x15 cm', 'en', with_(wrong))).toEqual([]);
    });

    it('Playback speed', () => {
      expect(run('两倍速', 'zh', with_(speed(1.5)))).toEqual(['param-speed']);
      expect(run('2x speed', 'en', with_(speed(1.5)))).toEqual(['param-speed']);
      expect(run('vitesse x2', 'fr', with_(speed(1.5)))).toEqual(['param-speed']);
      expect(run('1.5 倍速', 'zh', with_(speed(1.5)))).toEqual([]);
      expect(run('2x speed', 'en', with_(speed(2)))).toEqual([]);
      expect(run('两倍速', 'zh', with_(compress({ maxKB: 300 })))).toEqual([]);
    });

    it('Page count', () => {
      const every3 = split({ mode: 'every', n: 3 });
      expect(run('每 5 页拆一份', 'zh', with_(every3))).toEqual(['param-pages']);
      expect(run('split every 5 pages', 'en', with_(every3))).toEqual(['param-pages']);
      expect(run('toutes les 5 pages', 'fr', with_(every3))).toEqual(['param-pages']);
      expect(run('每 3 页拆一份', 'zh', with_(every3))).toEqual([]);
      expect(run('第 2 到 5 页', 'zh', with_(select({ rule: 'range', range: '2-5' })))).toEqual([]);
      expect(run('第 2 到 5 页', 'zh', with_(select({ rule: 'range', range: '1-3' })))).toEqual([
        'param-pages',
      ]);
      expect(run('pages 2-5', 'en', with_(select({ rule: 'odd' })))).toEqual(['param-pages']);
      expect(run('第 1 页', 'zh', with_(select({ rule: 'first' })))).toEqual([]);
    });

    it('Resolution', () => {
      expect(run('压到 720p', 'zh', with_(video({ by: 'quality', quality: '1080p' })))).toEqual([
        'param-resolution',
      ]);
      expect(run('compress to 720p', 'en', with_(video({ by: 'size', maxMB: 20 })))).toEqual([
        'param-resolution',
      ]);
      expect(
        run('compresser en 720p', 'fr', with_(video({ by: 'quality', quality: '720p' }))),
      ).toEqual([]);
    });
  });
});

describe('Runs on Hermes', () => {
  it('Avoid lookbehind assertions and Unicode property escapes (same as route.ts)', () => {
    const source = readFileSync(new URL('./tool-check.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\(\?<[!=]/);
    expect(source).not.toMatch(/\\p\{/);
  });

  it('Not considered a number if it immediately follows another number', () => {
    const before = workspace({});
    const pdf = quick('p', [
      ['in.photos', { source: 'library', min: 1, max: 5 }],
      [
        'pdf.fromImages',
        { pageSize: 'a4', orientation: 'auto', marginMm: 10, fit: 'contain', maxMB: 3 },
      ],
    ]);
    const after = workspace({ tools: [pdf] });
    const codes = (input: string) =>
      checkRequestParams(input, 'zh', before, after).map((i) => i.code);
    expect(codes('压到 2MB')).toEqual(['param-size']);
    expect(codes('压到 1.2.3MB')).toEqual([]);
  });

  it('Punctuation in names does not count: full-width, Chinese, and ASCII are all the same, it is the same table', () => {
    const config = workspace({
      tables: [table('a', [text('title')], '读书，笔记'), table('b', [text('x')], '读书 笔记！')],
      home: [addButton('add', 'a'), stat('total', 'b')],
    });
    expect(codes(check(config))).toContain('duplicate-table');
  });
});

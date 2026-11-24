import { describe, expect, it } from 'vitest';

import { LEAF_COMPONENTS } from '../components';
import { chartComponent } from '../components/chart';
import { formComponent } from '../components/form';
import { NumberSourceSchema } from '../components/number';
import { TrailingFormatSchema } from '../components/records';
import { createDefaultWorkspace } from '../defaults';
import { FIELDS } from '../fields';
import { scheduleField } from '../fields/schedule';
import { RECORD_TOOL_KINDS, TOOL_USE_AS } from '../record-ops-schema';
import {
  AGGREGATES,
  ConditionSchema,
  GROUP_UNITS,
  PERIODS,
  RECORD_LOOKS,
  ReminderSchema,
  ReminderWhenSchema,
  STREAK_UNITS,
} from '../schema';
import { BUILTIN_TOOLS } from '../tools';
import { CORE_ACTIONS } from '../registry';
import { registry } from '../test-helpers';
import { CAPABILITIES, viewOf } from './capabilities';
import {
  addField,
  addPage,
  addTable,
  addTool,
  blockIn,
  buildConfig,
  button,
  changed,
  chart,
  choice,
  date,
  form,
  link,
  money,
  navTo,
  number,
  quickAction,
  records,
  reminder,
  runAction,
  scanInto,
  text,
} from './fixtures';

const IDS = new Set(CAPABILITIES.map((c) => c.id));

/** These items exist in config but are not personal record capabilities: presentation elements or belonging to the file side; listed separately so new looks don't accidentally omit them. */
const NOT_RECORD_LOOKS = new Set([
  'header',
  'text',
  'notice',
  'image',
  'divider',
  'spacer',
  'entry',
  'picker',
  'files',
  'library',
  'packages',
  'action',
]);
/** Write blocks are located under `write.look.*`, others under `read.look.*`. */
const WRITE_LOOKS = new Set(['form', 'button']);
/** Keys on reminders: basic info, `when`, and `opens` are separate capabilities. */
const REMINDER_PLAIN_KEYS = new Set([
  'id',
  'kind',
  'app',
  'package',
  'preset',
  'title',
  'enabled',
  'when',
  'opens',
]);
const NUMBER_SOURCE_PLAIN_KEYS = new Set([
  'table',
  'aggregate',
  'field',
  'filter',
  'days',
  'group',
]);
const SCHEDULE_PLAIN_KEYS = new Set(['id', 'name', 'required', 'hint', 'type', 'default']);

describe('Integrity guard: Fails if schema or registry adds an item while capabilities list drops one', () => {
  const missing = (expected: string[]) => expected.filter((id) => !IDS.has(id));

  it('Every field type', () => {
    expect(missing(FIELDS.map((f) => `field.${f.type}`))).toEqual([]);
  });

  it('Every option of choice fields', () => {
    const keys = Object.keys(scheduleField.schema.shape).filter((k) => !SCHEDULE_PLAIN_KEYS.has(k));
    expect(missing(keys.map((k) => `field.schedule.${k}`))).toEqual([]);
  });

  it('Every one-tap record tool and appearance mode', () => {
    expect(missing(RECORD_TOOL_KINDS.map((k) => `write.do.${k}`))).toEqual([]);
    expect(missing(TOOL_USE_AS.map((k) => `write.as.${k}`))).toEqual([]);
  });

  it('Every look is categorized; both read and write blocks have capabilities', () => {
    const looks = LEAF_COMPONENTS.map((c) => c.look as string);
    const record = looks.filter((l) => !NOT_RECORD_LOOKS.has(l));
    expect(
      missing(record.map((l) => (WRITE_LOOKS.has(l) ? `write.look.${l}` : `read.look.${l}`))),
    ).toEqual([]);
    expect(record).toEqual(expect.arrayContaining([...RECORD_LOOKS, 'number', 'chart']));
    // Table reading and record writing looks cannot be classified as "not record capabilities" (actions simply run quick actions, while `out.addRecord` has its own capabilities).
    for (const c of LEAF_COMPONENTS)
      if (c.reads === 'table' || c.writes) expect(NOT_RECORD_LOOKS.has(c.look)).toBe(false);
  });

  it('Every aggregation, filter condition, time range, grouping unit, and consecutive unit', () => {
    expect(missing(AGGREGATES.map((a) => `read.aggregate.${a}`))).toEqual([]);
    expect(missing(ConditionSchema.shape.op.options.map((o) => `read.op.${o}`))).toEqual([]);
    expect(missing(PERIODS.map((p) => `read.period.${p}`))).toEqual([]);
    expect(missing(GROUP_UNITS.map((u) => `read.group.unit.${u}`))).toEqual([]);
    expect(missing(STREAK_UNITS.map((u) => `read.streak.unit.${u}`))).toEqual([]);
  });

  it('Every chart, form mode, and right-side format', () => {
    const kinds = chartComponent.schema.shape.show.shape.kind.options;
    expect(missing(kinds.map((k: string) => `read.chart.${k}`))).toEqual([]);
    const modes = formComponent.schema.shape.show.shape.mode.options;
    expect(missing(modes.map((k: string) => `write.form.${k}`))).toEqual([]);
    const formats = TrailingFormatSchema.options.map((o) => o.shape.kind.value as string);
    expect(missing(formats.map((k) => `read.format.${k}`))).toEqual([]);
  });

  it('Every option of number blocks', () => {
    const keys = Object.keys(NumberSourceSchema.shape).filter(
      (k) => !NUMBER_SOURCE_PLAIN_KEYS.has(k),
    );
    expect(missing(keys.map((k) => `read.number.${k}`))).toEqual([]);
  });

  it('Every reminder time and reminder option', () => {
    const whens = ReminderWhenSchema.options.map((o) => {
      const shape = o.shape as Record<string, { value?: string }>;
      if (shape.every)
        return shape.every.value === 'day'
          ? 'everyDay'
          : shape.every.value === 'month'
            ? 'everyMonth'
            : 'everyWeek';
      if (shape.before && shape.minutes) return 'beforeMinutes';
      return Object.keys(shape)[0]!;
    });
    expect(whens.sort()).toEqual([
      'after',
      'before',
      'beforeMinutes',
      'each',
      'everyDay',
      'everyMonth',
      'everyWeek',
    ]);
    expect(missing(whens.map((w) => `remind.when.${w}`))).toEqual([]);
    const keys = Object.keys(ReminderSchema.shape).filter((k) => !REMINDER_PLAIN_KEYS.has(k));
    expect(missing(keys.map((k) => `remind.${k}`))).toEqual([]);
  });

  it('Every action that reads or writes data tables', () => {
    const actions = [...BUILTIN_TOOLS.flatMap((t) => t.actions), ...CORE_ACTIONS].filter((a) =>
      a.fields.some((f) => f.kind === 'collection'),
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      const writes = a.fields.some((f) => f.kind === 'collection' && f.receives);
      expect(IDS).toContain(`${writes ? 'write' : 'read'}.action.${a.id}`);
    }
  });

  it('Capability IDs are unique', () => {
    expect(IDS.size).toBe(CAPABILITIES.length);
  });
});

/** A configuration using everything: proves that every predicate can hold and none are hardcoded to false. */
function everything() {
  const periods = [
    'today',
    'thisWeek',
    'thisMonth',
    'thisYear',
    'last7days',
    'last30days',
    'last14days',
    'last90days',
    'last365days',
    'thisTwoWeeks',
    'thisHalfMonth',
    'next7days',
    'next30days',
    'next90days',
    'yesterday',
    'lastWeek',
    'lastMonth',
    'lastYear',
    'tomorrow',
    'nextWeek',
    'nextMonth',
  ];
  return buildConfig([
    addTable('groups', [text('name', { required: true })]),
    addTable('items', [
      text('title'),
      { id: 'body', name: 'body', type: 'note' },
      // D-570: Input prompt and range.
      { id: 'qty', name: 'qty', type: 'number', min: 0, hint: 'How many' },
      money(),
      { id: 'done', name: 'done', type: 'checkbox' },
      date(),
      { id: 'at', name: 'at', type: 'datetime' },
      { id: 'clock', name: 'clock', type: 'time' },
      { id: 'mins', name: 'mins', type: 'duration' },
      {
        ...choice('status', ['a', 'b', 'skip'], { default: 'a' }),
        // D-568: Numbers and colors represented by options.
        options: [
          { id: 'a', label: 'a', value: 1, color: 'green' },
          { id: 'b', label: 'b' },
          { id: 'skip', label: 'skip' },
        ],
      },
      { id: 'stars', name: 'stars', type: 'rating' },
      { id: 'photo', name: 'photo', type: 'file' },
      link('group', 'groups'),
      { id: 'twice', name: 'twice', type: 'formula', expression: '{qty} * 2' },
      // D-569: Formula reading checkboxes and radio buttons.
      { id: 'flags', name: 'flags', type: 'formula', expression: '{done} + {status}' },
      { id: 'group-name', name: 'group-name', type: 'lookup', via: 'group', field: 'name' },
      { id: 'before', name: 'before', type: 'previous', field: 'qty' },
      {
        id: 'plan',
        name: 'plan',
        type: 'schedule',
        default: { repeat: 'daily' },
        lastDone: 'date',
        countEarly: true,
      },
      { id: 'labels', name: 'labels', type: 'tags' },
      { id: 'ends', name: 'ends', type: 'dateOffset', from: 'date', add: 'qty', unit: 'months' },
    ]),
    {
      op: 'updateData',
      table: 'items',
      changes: {
        readAttachments: true,
        prefillRules: 'receipt',
        recordRow: [{ tool: 'record-vcard' }],
        // D-570: Record form split into two sections, the second section shown only when `done` is checked.
        form: {
          sections: [
            { title: 'Main', fields: ['title', 'done'] },
            { title: 'More', fields: ['body'], when: [{ field: 'done', op: 'is', value: true }] },
          ],
        },
      },
    },
    addField('items', { id: 'contact', name: 'contact', type: 'text', format: 'phone' }),
    addField('groups', {
      id: 'all',
      name: 'all',
      type: 'rollup',
      table: 'items',
      via: 'group',
      aggregate: 'latest',
    }),
    addTool(scanInto('scan-item', 'items')),
    addTool(
      quickAction('fill-item', [
        [
          'records.fill',
          { collectionId: 'items', templatesTable: 'items', kind: 'text', body: ['body'] },
        ],
      ]),
    ),
    addTool(
      quickAction('vcard-items', [
        ['in.records', { collectionId: 'items', period: 'all' }],
        ['records.toVCard', {}],
        ['out.share', {}],
      ]),
    ),
    addTool(
      quickAction('export-shown-items', [
        ['records.toVCard', {}],
        ['out.share', {}],
      ]),
    ),
    addTool(
      quickAction('excel-items', [
        ['in.records', { collectionId: 'items', period: 'all' }],
        ['records.toExcel', {}],
        ['out.share', {}],
      ]),
    ),
    addTool(
      quickAction('print-items-attached', [
        ['in.records', { collectionId: 'items', period: 'all' }],
        [
          'print.records',
          {
            template: 'table',
            title: 'Items',
            fields: ['title'],
            pageSize: 'a4',
            attachments: true,
          },
        ],
      ]),
    ),
    addTool(
      quickAction('print-items', [
        ['in.records', { collectionId: 'items', period: 'thisMonth' }],
        ['print.records', { template: 'table', title: 'Items', fields: ['title'], pageSize: 'a4' }],
        ['out.share', {}],
      ]),
    ),
    addPage(
      'item',
      [
        form('add-in-item', 'groups', ['name']),
        form('link-in-item', 'items', ['title'], { values: { group: '$record' } }),
        {
          id: 'this-group',
          look: 'single',
          source: { table: 'groups', record: '$record' },
          show: { fields: ['name'] },
        },
      ],
      { of: 'groups' },
    ),
    addPage('writes', [
      form('add', 'items', ['title', 'photo'], {
        smartDate: { from: 'title', to: 'date' },
      }),
      { ...form('sheet', 'items', ['title']), show: { mode: 'sheet' } },
      button('all', { do: 'create', table: 'items', ask: 'all' }),
      button('quick', {
        do: 'create',
        table: 'items',
        values: { at: 'now', status: 'b' },
      }),
      button('bulk', { do: 'setAll', table: 'items', field: 'status', value: 'a' }),
      button('bulk-create', {
        do: 'createAll',
        table: 'items',
        from: 'groups',
        filter: [{ field: 'name', op: 'isNotEmpty' }],
        values: { group: '$row' },
      }),
      {
        id: 'callout',
        look: 'callout',
        show: {
          title: 'Waiting',
          text: '{count} waiting, {sum:qty} in total',
          actionLabel: 'Add',
          openLabel: 'Settings',
        },
        source: { table: 'items', filter: [{ field: 'qty', op: 'lt', value: 5 }] },
        tools: [
          {
            do: 'createAll',
            table: 'items',
            from: 'groups',
            filter: [{ field: 'name', op: 'isNotEmpty' }],
            values: { group: '$row' },
          },
        ],
        opens: 'settings',
      },
      runAction('run-scan', 'scan-item'),
      records('list', 'rows', 'items', 'title', {
        source: { sort: { field: 'date', direction: 'desc' } },
        show: {
          trailing: 'at',
          format: { kind: 'elapsed' },
        },
        tools: [
          { as: 'button', label: 'Set', do: 'set', table: 'items', field: 'date', value: 'today' },
          {
            as: 'button',
            label: 'Add',
            do: 'increment',
            table: 'items',
            field: 'qty',
            by: 1,
            when: [{ field: 'qty', op: 'lt', value: 5 }],
          },
          { as: 'addHere', do: 'create', table: 'items', ask: 'all', values: '$here' },
          { as: 'button', label: 'Open', opens: 'record' },
        ],
      }),
      {
        id: 'one',
        look: 'single',
        source: { table: 'items' },
        show: { fields: ['title'], qr: true },
        showIf: { table: 'items', has: 'some' },
        tools: [{ tool: 'record-qr' }],
      },
      {
        id: 'dial',
        look: 'dial',
        pin: 'bottom',
        tools: [{ do: 'create', table: 'items', ask: 'all', label: 'Add' }],
      },
      {
        id: 'none-yet',
        look: 'divider',
        showIf: { table: 'items', has: 'none' },
      },
      // D-616: The "Add" action below picks multiple groups, creating an entry for each.
      records('cards', 'picked', 'items', 'title', {
        tools: [
          {
            as: 'addHere',
            do: 'createAll',
            table: 'items',
            from: 'groups',
            pick: true,
            values: { group: '$row' },
          },
        ],
      }),
      records('list', 'relative', 'items', 'title', {
        tools: [
          {
            as: 'button',
            label: 'Snooze',
            do: 'set',
            table: 'items',
            field: 'date',
            value: { from: 'today', add: 7, unit: 'days' },
          },
          {
            as: 'button',
            label: 'Again',
            do: 'increment',
            table: 'items',
            field: 'qty',
            by: 'qty',
            also: [{ do: 'set', field: 'date', value: 'today' }],
          },
          {
            as: 'button',
            label: 'Copy',
            do: 'create',
            table: 'items',
            values: { title: { copy: 'title' } },
          },
        ],
      }),
      records('list', 'browsed', 'items', 'title', {
        show: { browse: { search: true, sort: ['title', 'createdAt'], group: ['status'] } },
        tools: [{ as: 'list', tool: 'export-shown-items' }],
      }),
      records('list', 'by-group-list', 'groups', 'name', {
        opens: 'item',
        tools: [
          {
            as: 'button',
            label: 'Add',
            do: 'create',
            table: 'items',
            ask: 'all',
            values: { group: '$row' },
          },
        ],
      }),
    ]),
    addPage('views', [
      records('cards', 'cards', 'items', 'title', {
        source: { filter: [{ field: 'title', op: 'contains', value: 'x' }] },
        show: { trailing: 'qty', format: { kind: 'progress', goal: 10 } },
      }),
      records('checklist', 'check', 'items', 'title', {
        source: { group: { by: 'status', showEmpty: true } },
        tools: [{ as: 'check', do: 'toggle', table: 'items', field: 'done' }],
      }),
      records('tiles', 'tiles', 'items', 'title', {
        tools: [{ as: 'tap', label: 'Tap', do: 'increment', table: 'items', field: 'qty', by: 1 }],
      }),
      records('board', 'board', 'items', 'title', {
        source: {
          group: { by: 'group', filter: [{ field: 'name', op: 'isNotEmpty' }] },
        },
        tools: [{ as: 'drag', do: 'set', table: 'items', field: 'group', value: '$group' }],
      }),
      records('calendar', 'cal', 'items', 'title', {
        source: { group: { unit: 'day' } },
        show: { color: 'status' },
      }),
      records('table', 'grid', 'items', 'title', { show: { columns: ['qty', 'status'] } }),
      records('gallery', 'pics', 'items', 'title'),
      // Habit tracking grid (D-610): One row per group, one column per day; tap empty space to create, tap single-item cells to delete.
      records('grid', 'week', 'items', 'title', {
        source: {
          group: { by: 'group', showEmpty: true },
          across: { unit: 'day', by: 'date' },
        },
        tools: [
          { as: 'tap', do: 'create', table: 'items', values: '$here' },
          { as: 'tap', do: 'remove', table: 'items' },
        ],
      }),
      records('list', 'by-week', 'items', 'title', {
        source: {
          group: { unit: 'week' },
          filter: [{ field: 'plan', op: 'due', value: 'today' }],
        },
      }),
      records('list', 'by-schedule', 'items', 'title', { source: { group: { by: 'plan' } } }),
      records('list', 'by-two', 'items', 'title', {
        source: {
          sort: [
            { field: 'status', direction: 'asc' },
            { field: 'date', direction: 'desc' },
          ],
        },
      }),
      number('n-goal', 'items', {
        aggregate: 'count',
        goal: 5,
        filter: [{ field: 'status', op: 'is', value: 'a' }],
      }),
      number('n-compare', 'items', {
        aggregate: 'sum',
        field: 'amount',
        compare: 'previous',
        filter: [{ field: 'date', op: 'inPeriod', value: 'thisMonth' }],
      }),
      number('n-minus', 'items', {
        aggregate: 'sum',
        field: 'amount',
        minus: { table: 'items', aggregate: 'sum', field: 'qty' },
      }),
      number('n-avg', 'items', { aggregate: 'avg', field: 'qty', group: { by: 'status' } }),
      number('n-min', 'items', { aggregate: 'min', field: 'qty', group: { by: 'group' } }),
      number('n-max', 'items', { aggregate: 'max', field: 'qty' }),
      number('n-streak', 'items', {
        aggregate: 'streak',
        days: { unit: 'week', perUnit: 2, skip: { field: 'status', option: 'skip' } },
      }),
      number('n-streak-day', 'items', { aggregate: 'streak', days: { unit: 'day' } }),
      number('n-streak-month', 'items', { aggregate: 'streak', days: { unit: 'month' } }),
      number('n-since', 'items', { aggregate: 'daysSince' }),
      number('n-interval', 'items', { aggregate: 'avgInterval' }),
      number('n-days', 'items', { aggregate: 'distinctDays' }),
      chart('c-bar', 'items', 'bar', {
        aggregate: 'sum',
        field: 'amount',
        group: { unit: 'month', last: 6 },
      }),
      chart('c-line', 'items', 'line', { aggregate: 'count', group: { unit: 'day' } }),
      chart('c-pie', 'items', 'pie', { aggregate: 'count', group: { by: 'status' } }),
      { id: 'range', look: 'period', show: { options: ['thisWeek', 'thisMonth'], custom: true } },
      number('n-period', 'items', { aggregate: 'count', period: 'page' }),
      records('list', 'l-period', 'items', 'title', { source: { period: 'page' } }),
      chart('c-compare', 'items', 'bar', {
        aggregate: 'count',
        group: { unit: 'month' },
        compare: 'previous',
        period: 'page',
      }),
    ]),
    addPage('tabs', [
      { id: 'tabs', look: 'choices', show: {}, source: { table: 'items', field: 'status' } },
      { id: 'range-2', look: 'period', show: { options: ['thisMonth'] } },
      number('n-choice', 'items', { aggregate: 'count', choice: 'page', period: 'page' }),
      records('list', 'l-choice', 'items', 'title', { source: { choice: 'page' } }),
      chart('c-choice', 'items', 'line', {
        aggregate: 'count',
        group: { unit: 'day' },
        choice: 'page',
      }),
    ]),
    addPage(
      'periods',
      periods.map((value) =>
        number(`p-${value.toLowerCase()}`, 'items', {
          aggregate: 'count',
          filter: [{ field: 'date', op: 'inPeriod', value }],
        }),
      ),
    ),
    addPage('ops', [
      number('o-not', 'items', {
        aggregate: 'count',
        filter: [
          { field: 'status', op: 'isNot', value: 'b' },
          { field: 'qty', op: 'gt', value: 0 },
          { field: 'body', op: 'isEmpty' },
        ],
      }),
    ]),
    addPage('summaries', [
      {
        id: 'formula-total',
        look: 'number',
        show: { label: 'Formula' },
        source: {
          table: 'items',
          aggregate: 'sum',
          field: 'qty',
          calc: {
            with: [{ id: 'other', table: 'items', aggregate: 'count' }],
            formula: '{total} / {other}',
            as: 'number',
          },
        },
      },
      {
        id: 'running-chart',
        look: 'chart',
        show: { title: 'Running', kind: 'line' },
        source: {
          table: 'items',
          aggregate: 'sum',
          field: 'qty',
          group: { unit: 'day', by: 'date' },
          running: 'shown',
        },
      },
      {
        id: 'split-chart',
        look: 'chart',
        show: { title: 'Split', kind: 'bar' },
        source: {
          table: 'items',
          aggregate: 'count',
          group: { unit: 'day', by: 'date' },
          split: { by: 'status' },
        },
      },
      {
        id: 'week-calendar',
        look: 'calendar',
        show: { title: 'title', span: 'week', day: { aggregate: 'count' } },
        source: { table: 'items', limit: 30, group: { unit: 'day', by: 'date', until: 'at' } },
      },
    ]),
    addTool(reminder('r-day', { every: 'day', at: '09:00' }, 'page:views')),
    addTool(
      reminder('r-day-unless', { every: 'day', at: '21:00' }, 'page:views', {
        unless: { table: 'items', within: 'day' },
      }),
    ),
    addTool(reminder('r-week', { every: 'week', days: [1], at: '09:00' }, 'page:views')),
    addTool(reminder('r-month', { every: 'month', day: 1, at: '09:00' }, 'page:views')),
    addTool(
      reminder(
        'r-before',
        { before: { table: 'items', field: 'date' }, days: 1, at: '09:00' },
        'page:views',
      ),
    ),
    addTool(
      reminder('r-each', { each: { table: 'items', field: 'plan' }, at: '09:00' }, 'page:views', {
        done: { do: 'set', table: 'items', field: 'date', value: 'today' },
        snoozeMinutes: 10,
        unless: { table: 'items', within: 'day' },
      }),
    ),
    addTool(reminder('r-after', { after: { table: 'items' }, minutes: 5 }, 'page:views')),
    addTool(
      reminder('r-minutes', { before: { table: 'items', field: 'at' }, minutes: 30 }, 'page:views'),
    ),
    navTo('writes', 'views', 'periods'),
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'to-ops',
        look: 'entry',
        show: { title: 'ops', icon: 'star' },
        opens: 'page:ops',
      },
    },
  ]);
}

describe('Every predicate', () => {
  it('Holds true on the all-inclusive config', () => {
    const v = viewOf(everything(), registry);
    expect(CAPABILITIES.filter((c) => !c.test(v)).map((c) => c.id)).toEqual([]);
  });

  it('Does not hold true on a new config', () => {
    const v = viewOf(createDefaultWorkspace('en'), registry);
    expect(CAPABILITIES.filter((c) => c.test(v)).map((c) => c.id)).toEqual([]);
  });

  it('Hidden blocks, inaccessible pages, and disabled reminders are excluded', () => {
    const has = (config: object, id: string) =>
      CAPABILITIES.find((c) => c.id === id)!.test(viewOf(config as never, registry));
    const base = everything();
    expect(has(base, 'read.look.tiles')).toBe(true);
    expect(
      has(
        changed(base, (c) => (blockIn(c, 'tiles').hidden = true)),
        'read.look.tiles',
      ),
    ).toBe(false);
    expect(
      has(
        changed(base, (c) => {
          c.nav.bar = ['page:home', 'settings'];
          c.tools = c.tools.filter((t: { kind: string }) => t.kind !== 'reminder');
        }),
        'read.look.tiles',
      ),
    ).toBe(false);
    expect(has(base, 'remind.when.after')).toBe(true);
    expect(
      has(
        changed(base, (c) => {
          for (const t of c.tools) if (t.id === 'r-after') t.enabled = false;
        }),
        'remind.when.after',
      ),
    ).toBe(false);
  });

  it('Read-only, config is unmodified', () => {
    const config = everything();
    const before = JSON.stringify(config);
    const v = viewOf(config, registry);
    for (const c of CAPABILITIES) c.test(v);
    expect(JSON.stringify(config)).toBe(before);
  });
});

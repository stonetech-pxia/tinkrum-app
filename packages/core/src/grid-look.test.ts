import { describe, expect, it } from 'vitest';

import { prepareOps } from './change';
import type { DataRecord } from './data';
import { gridCellValue, gridColumns, gridHereValues, gridRange, gridTap } from './grid-view';
import type { Op } from './ops';
import { RecordToolSchema, ToolUseSchema } from './record-ops-schema';
import type { Collection, WorkspaceConfig } from './schema';
import { readRecords, sourceTableIds, type SourceContext } from './source';
import { registry, workspace } from './test-helpers';
import { validateWorkspace } from './validate';

// 打卡格（D-606）：行 × 时间列，每格是这一行这一天的记录；点空格新建（$here），点只有一条的格子删掉（带撤销）。
// 2026-11-20 是周五。
const now = new Date(2026, 10, 20, 9, 30);
const ctx = { registry, locale: 'en' as const, now };

const HABITS: Collection = {
  id: 'habits',
  name: 'Habits',
  fields: [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'active', name: 'Active', type: 'checkbox' },
    { id: 'goal', name: 'Daily goal', type: 'number' },
    { id: 'note', name: 'Note', type: 'text' },
  ],
};
const CHECKINS: Collection = {
  id: 'check-ins',
  name: 'Check-ins',
  fields: [
    { id: 'habit', name: 'Habit', type: 'link', table: 'habits' },
    { id: 'date', name: 'Date', type: 'date' },
    { id: 'glasses', name: 'Glasses', type: 'number' },
    {
      id: 'mood',
      name: 'Mood',
      type: 'choice',
      options: [
        { id: 'good', label: 'Good' },
        { id: 'bad', label: 'Bad' },
      ],
    },
    { id: 'note', name: 'Note', type: 'text' },
  ],
};
const WORKOUTS: Collection = {
  id: 'workouts',
  name: 'Workouts',
  fields: [
    {
      id: 'kind',
      name: 'Kind',
      type: 'choice',
      options: [
        { id: 'run', label: 'Run' },
        { id: 'swim', label: 'Swim' },
      ],
    },
    { id: 'at', name: 'At', type: 'datetime' },
  ],
};

const create = { as: 'tap', do: 'create', table: 'check-ins', values: '$here' };
const remove = { as: 'tap', do: 'remove', table: 'check-ins' };

const grid = (extra: Record<string, unknown> = {}, source: Record<string, unknown> = {}) => ({
  id: 'week',
  look: 'grid',
  source: {
    table: 'check-ins',
    group: { by: 'habit', showEmpty: true },
    across: { unit: 'day', by: 'date', last: 7 },
    ...source,
  },
  show: { title: 'habit' },
  tools: [create, remove],
  ...extra,
});

function prepare(blocks: object[], more: Op[] = []) {
  return prepareOps(
    workspace('en'),
    [
      { op: 'addData', table: HABITS },
      { op: 'addData', table: CHECKINS },
      { op: 'addData', table: WORKOUTS },
      ...more,
      { op: 'addContainer', page: { id: 'p', title: 'P', blocks } } as unknown as Op,
    ],
    ctx,
  );
}
const issues = (...blocks: object[]) => {
  const r = prepare(blocks);
  return r.ok ? [] : r.issues;
};
const configWith = (...blocks: object[]): WorkspaceConfig => {
  const r = prepare(blocks);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.after;
};

const rec = (
  table: string,
  id: string,
  values: Record<string, unknown>,
  createdAt = 0,
): DataRecord => ({ id, collectionId: table, values, createdAt, updatedAt: createdAt });

const habitRecords = [
  rec('habits', 'run', { name: 'Running', active: true, goal: 2 }, 1),
  rec('habits', 'read', { name: 'Reading', active: true }, 2),
  rec('habits', 'old', { name: 'Old habit', active: false }, 3),
];

describe('grid look: validation (D-606)', () => {
  it('a week of check-ins by habit with add and remove taps is valid; taps need no label', () => {
    expect(issues(grid())).toEqual([]);
    // 按单选分行也行。
    expect(
      issues({
        ...grid({}, { group: { by: 'mood' } }),
      }),
    ).toEqual([]);
  });

  it('needs rows by a choice or link field and columns of time', () => {
    expect(issues(grid({}, { group: undefined })).join()).toMatch(/needs source.group.by/);
    expect(issues(grid({}, { group: { by: 'note' } })).join()).toMatch(/choice or link/);
    expect(issues(grid({}, { across: undefined })).join()).toMatch(/needs source.across/);
    expect(issues(grid({}, { group: { by: 'habit', unit: 'day' } })).join()).toMatch(
      /no source.group.unit/,
    );
  });

  it('columns use a date or datetime field; the default is the first one', () => {
    expect(issues(grid({}, { across: { unit: 'week' } }))).toEqual([]);
    expect(issues(grid({}, { across: { unit: 'day', by: 'note' } })).join()).toMatch(
      /source.across.by note must be a date or datetime field/,
    );
    expect(issues(grid({}, { across: { unit: 'day', by: 'createdAt' } }))).not.toEqual([]);
    expect(issues(grid({}, { across: { unit: 'month', last: 40 } }))).not.toEqual([]);
  });

  it('across only applies to a grid', () => {
    const list = {
      id: 'l',
      look: 'list',
      source: { table: 'check-ins', across: { unit: 'day' } },
      show: { title: 'habit' },
    };
    expect(issues(list).join()).toMatch(/source.across only applies to look "grid"/);
  });

  it('group.filter narrows the linked rows, like a board', () => {
    const filter = [{ field: 'active', op: 'is', value: true }];
    expect(issues(grid({}, { group: { by: 'habit', showEmpty: true, filter } }))).toEqual([]);
    expect(
      issues(grid({}, { group: { by: 'habit', filter: [{ field: 'nope', op: 'isEmpty' }] } })),
    ).not.toEqual([]);
  });

  it('a progress ring has its goal as a number or a number field of the row table', () => {
    const ring = (goal: unknown) =>
      grid({ show: { title: 'habit', format: { kind: 'progress', goal } } });
    expect(issues(ring(8))).toEqual([]);
    expect(issues(ring('goal'))).toEqual([]);
    expect(issues(ring('note')).join()).toMatch(
      /goal note must be a number or a number field of habits/,
    );
    // show.trailing 是数字字段时每格是它的合计；文字不行。
    expect(issues(grid({ show: { title: 'habit', trailing: 'glasses' } }))).toEqual([]);
    expect(issues(grid({ show: { title: 'habit', trailing: 'note' } })).join()).toMatch(/summed/);
  });

  it('tools are taps only: one create with "$here", one remove, no when or also', () => {
    expect(issues(grid({ tools: [create] }))).toEqual([]);
    expect(issues(grid({ tools: [remove] }))).toEqual([]);
    expect(issues(grid({ tools: [create, create] })).join()).toMatch(/at most one create/);
    expect(issues(grid({ tools: [{ ...create, values: { note: null } }] })).join()).toMatch(
      /values: "\$here"/,
    );
    expect(
      issues(grid({ tools: [{ ...remove, when: [{ field: 'note', op: 'isEmpty' }] }] })).join(),
    ).toMatch(/no when/);
    const button = { as: 'button', label: 'X', do: 'create', table: 'check-ins', values: '$here' };
    expect(issues(grid({ tools: [button] })).join()).toMatch(/doesn't fit a grid/);
    expect(issues(grid({ tools: [{ ...remove, as: 'button', label: 'X' }] }))).not.toEqual([]);
  });

  it('"$here" fills the row and the day, so they may be required fields', () => {
    const required: Op[] = [
      { op: 'updateData', table: 'check-ins', field: 'habit', changes: { required: true } },
      { op: 'updateData', table: 'check-ins', field: 'date', changes: { required: true } },
    ] as never;
    const r = prepare([grid()], required);
    expect(r.ok ? [] : r.issues).toEqual([]);
    // 别的必填字段还是要有值。
    const note = prepare([grid()], [
      { op: 'updateData', table: 'check-ins', field: 'note', changes: { required: true } },
    ] as never);
    expect(note.ok ? '' : note.issues.join()).toMatch(/required field note would be empty/);
  });

  it('remove writes only the table the grid reads (relation rule 12)', () => {
    expect(issues(grid({ tools: [{ ...remove, table: 'habits' }] })).join()).toMatch(
      /table must be check-ins, not habits/,
    );
  });
});

describe('grid look: remove only works as a tap on a grid (D-606)', () => {
  const removeHere = (block: object) => issues(block).join('\n');
  it('is refused on a list button, tiles and a button block', () => {
    expect(
      removeHere({
        id: 'l',
        look: 'list',
        source: { table: 'check-ins' },
        show: { title: 'habit' },
        tools: [{ ...remove, as: 'button', label: 'Delete' }],
      }),
    ).toMatch(/remove/);
    expect(
      removeHere({
        id: 't',
        look: 'tiles',
        source: { table: 'check-ins' },
        show: { title: 'habit' },
        tools: [{ ...remove, label: 'Delete' }],
      }),
    ).toMatch(/remove/);
    expect(
      removeHere({
        id: 'b',
        look: 'button',
        show: { label: 'Delete', variant: 'filled' },
        tools: [{ do: 'remove', table: 'check-ins' }],
      }),
    ).toMatch(/remove/);
  });

  it("is refused as a reminder's done", () => {
    const r = prepare([], []);
    if (!r.ok) throw new Error(r.issues.join());
    const config = structuredClone(r.after);
    config.data.tables.push({
      id: 'plants',
      name: 'Plants',
      fields: [
        { id: 'name', name: 'Name', type: 'text' },
        { id: 'next', name: 'Next', type: 'date' },
      ],
    });
    config.tools.push({
      kind: 'reminder',
      id: 'water',
      title: 'Water',
      enabled: true,
      opens: 'page:home',
      when: { each: { table: 'plants', field: 'next' }, at: '09:00' },
      done: { do: 'remove', table: 'plants' },
    } as never);
    const v = validateWorkspace(config, registry);
    expect(v.ok ? '' : v.issues.map((i) => i.message).join()).toMatch(/remove only works/);
  });

  it('is one fixed kind with only a table: no filter, no count, no way to skip the undo', () => {
    expect(RecordToolSchema.safeParse({ do: 'remove', table: 't' }).success).toBe(true);
    for (const extra of [
      { filter: [] },
      { max: 10 },
      { undo: false },
      { quiet: true },
      { field: 'a' },
      { values: {} },
    ])
      expect(
        ToolUseSchema.safeParse({ as: 'tap', do: 'remove', table: 't', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
  });
});

describe('grid look: columns (D-606)', () => {
  const cal = { dayStartHour: 0, weekStart: 'monday' as const };
  it('the last 7 days end today, oldest first, labelled by weekday and day', () => {
    const cols = gridColumns({ unit: 'day', last: 7 }, now, cal, 'en');
    expect(cols.map((c) => c.key)).toEqual([
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
    ]);
    expect(cols.at(-1)).toMatchObject({ label: 'Fri', detail: '20', current: true, future: false });
    expect(cols.filter((c) => c.current)).toHaveLength(1);
    expect(cols.some((c) => c.future)).toBe(false);
    expect(cols[0]!.title).toMatch(/Saturday, November 14/);
  });

  it('the header says the range of the page', () => {
    expect(gridRange(gridColumns({ unit: 'day' }, now, cal, 'en'), now, cal, 'en')).toBe(
      'Nov 14 – Nov 20',
    );
    expect(gridRange(gridColumns({ unit: 'month', last: 2 }, now, cal, 'en'), now, cal, 'en')).toBe(
      'Oct 1 – Nov 30',
    );
  });

  it('defaults like a chart: 7 days, 8 weeks, 6 months', () => {
    expect(gridColumns({ unit: 'day' }, now, cal, 'en')).toHaveLength(7);
    expect(gridColumns({ unit: 'week' }, now, cal, 'en')).toHaveLength(8);
    expect(gridColumns({ unit: 'month' }, now, cal, 'en')).toHaveLength(6);
  });

  it('weeks start on the day set in Settings', () => {
    const monday = gridColumns({ unit: 'week', last: 2 }, now, cal, 'en');
    expect(monday.map((c) => c.key)).toEqual(['2026-11-09', '2026-11-16']);
    const sunday = gridColumns(
      { unit: 'week', last: 2 },
      now,
      { ...cal, weekStart: 'sunday' },
      'en',
    );
    expect(sunday.map((c) => c.key)).toEqual(['2026-11-08', '2026-11-15']);
    expect(sunday.at(-1)).toMatchObject({ current: true, title: 'Week of Nov 15' });
  });

  it('months run to their last day', () => {
    const cols = gridColumns({ unit: 'month', last: 2 }, now, cal, 'en');
    expect(cols.map((c) => [c.key, c.end - c.start + 1])).toEqual([
      ['2026-10-01', 31],
      ['2026-11-01', 30],
    ]);
  });

  it('paging back moves a whole page and never reaches the future', () => {
    const back = gridColumns({ unit: 'day', last: 7 }, now, cal, 'en', 1);
    expect(back[0]!.key).toBe('2026-11-07');
    expect(back.at(-1)!.key).toBe('2026-11-13');
    expect(back.some((c) => c.current || c.future)).toBe(false);
    expect(gridColumns({ unit: 'day', last: 7 }, now, cal, 'en', -3).at(-1)!.key).toBe(
      '2026-11-20',
    );
  });

  it('a day that starts at 4 am: at 2 am today is still yesterday', () => {
    const early = new Date(2026, 10, 21, 2);
    const cols = gridColumns({ unit: 'day', last: 3 }, early, { ...cal, dayStartHour: 4 }, 'en');
    expect(cols.at(-1)).toMatchObject({ key: '2026-11-20', current: true });
  });
});

describe('grid look: reading (D-606)', () => {
  const checkins = [
    rec('check-ins', 'c1', { habit: 'run', date: '2026-11-20', glasses: 1 }),
    rec('check-ins', 'c2', { habit: 'run', date: '2026-11-18', glasses: 2 }),
    rec('check-ins', 'c3', { habit: 'run', date: '2026-11-18', glasses: 3 }),
    rec('check-ins', 'c4', { habit: 'read', date: '2026-11-19' }),
    // 七天以外的、没有习惯的、旧习惯的：不在这一页的格子里。
    rec('check-ins', 'c5', { habit: 'read', date: '2026-11-01' }),
    rec('check-ins', 'c6', { date: '2026-11-20' }),
    rec('check-ins', 'c7', { habit: 'old', date: '2026-11-20', mood: 'good' }),
  ];
  const read = (block: ReturnType<typeof grid>, page?: number, records = checkins) => {
    const config = configWith(block);
    const sctx: SourceContext = {
      config,
      records: new Map([
        ['habits', habitRecords],
        ['check-ins', records],
      ]),
      now,
      locale: 'en',
    };
    return readRecords(
      config.containers.pages.find((p) => p.id === 'p')!.blocks[0] as never,
      sctx,
      page === undefined ? {} : { page },
    )!;
  };
  const counts = (r: ReturnType<typeof read>) =>
    Object.fromEntries(r.grid!.rows.map((row) => [row.label, row.cells.map((c) => c.length)]));

  it('reads the linked habits too', () => {
    const config = configWith(grid());
    const block = config.containers.pages.find((p) => p.id === 'p')!.blocks[0] as never as {
      source: { table: string; group: { by: string } };
    };
    expect(sourceTableIds(block.source, config).sort()).toEqual(['check-ins', 'habits']);
  });

  it('one row per habit (showEmpty), one column per day, the entries of that habit on that day', () => {
    const r = read(grid());
    expect(r.grid!.columns).toHaveLength(7);
    expect(counts(r)).toEqual({
      Running: [0, 0, 0, 0, 2, 0, 1],
      Reading: [0, 0, 0, 0, 0, 1, 0],
      'Old habit': [0, 0, 0, 0, 0, 0, 1],
    });
    expect(r.grid!.rows.map((row) => row.value)).toEqual(['run', 'read', 'old']);
  });

  it('without showEmpty only habits with entries are rows; group.filter keeps only active habits', () => {
    const none = rec('habits', 'none', { name: 'Unused', active: true }, 4);
    const config = configWith(grid({}, { group: { by: 'habit' } }));
    const sctx: SourceContext = {
      config,
      records: new Map([
        ['habits', [...habitRecords, none]],
        ['check-ins', checkins],
      ]),
      now,
      locale: 'en',
    };
    const block = config.containers.pages.find((p) => p.id === 'p')!.blocks[0] as never;
    expect(readRecords(block, sctx)!.grid!.rows.map((row) => row.label)).toEqual([
      'Running',
      'Reading',
      'Old habit',
    ]);
    const active = read(
      grid(
        {},
        {
          group: {
            by: 'habit',
            showEmpty: true,
            filter: [{ field: 'active', op: 'is', value: true }],
          },
        },
      ),
    );
    expect(active.grid!.rows.map((row) => row.label)).toEqual(['Running', 'Reading']);
  });

  it('the source filter applies before the cells are counted', () => {
    const r = read(grid({}, { filter: [{ field: 'glasses', op: 'gt', value: 1 }] }));
    expect(counts(r).Running).toEqual([0, 0, 0, 0, 2, 0, 0]);
  });

  it('a page back shows the week before, still without writing anything', () => {
    const r = read(grid(), 2);
    expect(r.grid!.columns[0]!.key).toBe('2026-10-31');
    expect(counts(r).Reading).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it('rows by a choice field: one row per option', () => {
    const r = read(grid({}, { group: { by: 'mood', showEmpty: true } }));
    expect(counts(r)).toEqual({ Good: [0, 0, 0, 0, 0, 0, 1], Bad: [0, 0, 0, 0, 0, 0, 0] });
  });

  it('a cell counts its entries, or sums show.trailing', () => {
    const r = read(grid());
    const cell = r.grid!.rows[0]!.cells[4]!;
    expect(gridCellValue(cell, r.view, undefined)).toBe(2);
    expect(gridCellValue(cell, r.view, 'glasses')).toBe(5);
    expect(gridCellValue([], r.view, 'glasses')).toBe(0);
  });

  it("a ring's goal is a number, or each habit's own number field", () => {
    const fixed = read(grid({ show: { title: 'habit', format: { kind: 'progress', goal: 8 } } }));
    expect(fixed.grid!.rows.map((row) => row.goal)).toEqual([8, 8, 8]);
    const own = read(
      grid({ show: { title: 'habit', format: { kind: 'progress', goal: 'goal' } } }),
    );
    expect(own.grid!.rows.map((row) => row.goal)).toEqual([2, undefined, undefined]);
  });

  it('a datetime field puts an entry on its day, counting the hours before the day starts as the day before', () => {
    const workouts = (dayStartHour: number) => {
      const r = prepare([
        {
          id: 'w',
          look: 'grid',
          source: {
            table: 'workouts',
            group: { by: 'kind', showEmpty: true },
            across: { unit: 'day', last: 3 },
          },
          show: { title: 'kind' },
          tools: [{ as: 'tap', do: 'create', table: 'workouts', values: '$here' }],
        },
      ]);
      if (!r.ok) throw new Error(r.issues.join());
      const config = { ...r.after, data: { ...r.after.data, calendar: { dayStartHour } } };
      const sctx: SourceContext = {
        config,
        records: new Map([
          [
            'workouts',
            [
              rec('workouts', 'w1', { kind: 'run', at: '2026-11-20T07:00' }),
              rec('workouts', 'w2', { kind: 'run', at: '2026-11-20T01:30' }),
            ],
          ],
        ]),
        now,
        locale: 'en',
      };
      const read = readRecords(
        config.containers.pages.find((p) => p.id === 'p')!.blocks[0] as never,
        sctx,
      )!;
      return read.grid!.rows[0]!.cells.map((c) => c.length);
    };
    expect(workouts(0)).toEqual([0, 0, 2]);
    expect(workouts(2)).toEqual([0, 1, 1]);
  });
});

describe('grid look: what a tap does (D-606)', () => {
  const past = { future: false };
  it('with remove: an empty cell adds, one entry is removed, two or more are listed', () => {
    const tools = [create, remove] as never;
    expect(gridTap(tools, 0, past)).toBe('create');
    expect(gridTap(tools, 1, past)).toBe('remove');
    expect(gridTap(tools, 2, past)).toBe('open');
  });

  it('without remove a tap always adds one more (counting)', () => {
    const tools = [create] as never;
    expect(gridTap(tools, 0, past)).toBe('create');
    expect(gridTap(tools, 3, past)).toBe('create');
  });

  it('without tools a tap only lists what is there; a future cell does nothing', () => {
    expect(gridTap(undefined, 0, past)).toBe('none');
    expect(gridTap(undefined, 2, past)).toBe('open');
    expect(gridTap([create, remove] as never, 0, { future: true })).toBe('none');
  });

  it('adding in a cell fills the row, the day and the equals of the filter', () => {
    const view = CHECKINS;
    const read = { by: 'habit', date: 'date' };
    const cal = { dayStartHour: 0, weekStart: 'monday' as const };
    const cols = gridColumns({ unit: 'day', last: 7 }, now, cal, 'en');
    expect(gridHereValues(view, [], read, { value: 'run' }, cols[2]!, now, cal)).toEqual({
      habit: 'run',
      date: '2026-11-16',
    });
    expect(
      gridHereValues(
        view,
        [{ field: 'mood', op: 'is', value: 'good' }],
        read,
        { value: 'run' },
        cols.at(-1)!,
        now,
        cal,
      ),
    ).toEqual({ habit: 'run', date: '2026-11-20', mood: 'good' });
    // 一周的一列：这一周是今天，以前的周是它的第一天。
    const weeks = gridColumns({ unit: 'week', last: 2 }, now, cal, 'en');
    expect(gridHereValues(view, [], read, { value: 'run' }, weeks[0]!, now, cal).date).toBe(
      '2026-11-09',
    );
    expect(gridHereValues(view, [], read, { value: 'run' }, weeks[1]!, now, cal).date).toBe(
      '2026-11-20',
    );
  });

  it('a datetime field gets now in the current column and noon on other days', () => {
    const cal = { dayStartHour: 4, weekStart: 'monday' as const };
    const read = { by: 'kind', date: 'at' };
    const cols = gridColumns({ unit: 'day', last: 2 }, now, cal, 'en');
    expect(gridHereValues(WORKOUTS, [], read, { value: 'run' }, cols[0]!, now, cal)).toEqual({
      kind: 'run',
      at: '2026-11-19T12:00',
    });
    expect(gridHereValues(WORKOUTS, [], read, { value: 'run' }, cols[1]!, now, cal).at).toBe(
      '2026-11-20T09:30',
    );
  });
});

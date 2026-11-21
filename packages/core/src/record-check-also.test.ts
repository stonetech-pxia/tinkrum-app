import { describe, expect, it } from 'vitest';

import { prepareRecordValues } from './data';
import {
  ToolUseSchema,
  checkInput,
  checkOverwrites,
  tapWrites,
  type RecordToolUse,
} from './record-ops';
import type { Collection, WorkspaceConfig } from './schema';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';

// 清单的勾也能顺带记下点什么（D-617，创始人 2026-11-21「做前三个」）：勾上时 also 设这一条的一两个字段（例如完成日期 = 今天），
// 取消时把它们清空。点一下最多 3 处、都在这一条（底线 11）；只有 set，没有新建、别的表、加减。

const tasks: Collection = {
  id: 'tasks',
  name: 'Tasks',
  fields: [
    { id: 'title', name: 'Task', type: 'text', required: true },
    { id: 'done', name: 'Done', type: 'checkbox', default: false },
    { id: 'completed', name: 'Completed on', type: 'date' },
    { id: 'at', name: 'Done at', type: 'datetime' },
    { id: 'due', name: 'Due', type: 'date', required: true },
    { id: 'points', name: 'Points', type: 'number' },
    { id: 'flag', name: 'Flag', type: 'checkbox' },
  ],
};
const logs: Collection = {
  id: 'logs',
  name: 'Logs',
  fields: [
    { id: 'task', name: 'Task', type: 'link', table: 'tasks' },
    { id: 'on', name: 'On', type: 'date' },
  ],
};

const base = (): WorkspaceConfig => {
  const config = fromV33(v33Fixture('default-en'));
  config.data.tables.push(...structuredClone([tasks, logs]));
  return config;
};
const checklist = (check: object) => ({
  id: 'c1',
  look: 'checklist',
  source: { table: 'tasks', limit: 30 },
  show: { title: 'title' },
  tools: [check],
});
function problems(blocks: unknown[]): string {
  const copy = base();
  copy.containers.pages.find((p) => p.id === 'home')!.blocks.push(...(blocks as never[]));
  const r = validateWorkspace(copy, registry);
  return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
}

const tick = {
  as: 'check',
  do: 'toggle',
  table: 'tasks',
  field: 'done',
  also: [{ do: 'set', field: 'completed', value: 'today' }],
} as const;
const use = tick as unknown as RecordToolUse;
const NOW = new Date(2026, 10, 18, 9, 30);

describe('a check box can also record a date (D-617)', () => {
  it('ticking done also sets completed: the checklist accepts it', () => {
    expect(ToolUseSchema.safeParse(tick).success).toBe(true);
    expect(problems([checklist(tick)])).toBe('');
    // 两处也行（一共 3 处）。
    expect(
      problems([
        checklist({
          ...tick,
          also: [...tick.also, { do: 'set', field: 'at', value: 'now' }],
        }),
      ]),
    ).toBe('');
    expect(tapWrites(use)).toEqual([
      { do: 'toggle', table: 'tasks', field: 'done' },
      { do: 'set', table: 'tasks', field: 'completed', value: 'today' },
    ]);
  });

  it('only sets fields of this entry: no create, toggle, increment, other table, or a third write', () => {
    for (const also of [
      [{ do: 'create', table: 'logs', values: { task: '$row', on: 'today' } }],
      [{ do: 'toggle', field: 'flag' }],
      [{ do: 'increment', field: 'points', by: 1 }],
    ])
      expect(problems([checklist({ ...tick, also })]), JSON.stringify(also)).toMatch(
        /a check's also can only set fields of this entry/,
      );
    // 别的表、第三处：写法本身就不行。
    expect(
      ToolUseSchema.safeParse({
        ...tick,
        also: [{ do: 'set', table: 'logs', field: 'on', value: 'today' }],
      }).success,
    ).toBe(false);
    expect(
      ToolUseSchema.safeParse({
        ...tick,
        also: [
          ...tick.also,
          { do: 'set', field: 'at', value: 'now' },
          { do: 'set', field: 'points', value: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it('refuses what unticking could not take back: an emptying value, a required field, the box itself', () => {
    expect(
      problems([checklist({ ...tick, also: [{ do: 'set', field: 'completed', value: null }] })]),
    ).toMatch(/completed would be emptied by the tick/);
    expect(
      problems([checklist({ ...tick, also: [{ do: 'set', field: 'flag', value: false }] })]),
    ).toMatch(/flag would be emptied by the tick/);
    expect(
      problems([checklist({ ...tick, also: [{ do: 'set', field: 'due', value: 'today' }] })]),
    ).toMatch(/due is required, and unticking clears it/);
    expect(
      problems([checklist({ ...tick, also: [{ do: 'set', field: 'done', value: true }] })]),
    ).toMatch(/changes done twice/);
    // 字段的值照常检查。
    expect(
      problems([checklist({ ...tick, also: [{ do: 'set', field: 'completed', value: 'now' }] })]),
    ).toMatch(/completed/);
  });

  it('still refuses also on a page button, a drag or a form', () => {
    expect(
      problems([
        {
          id: 'b1',
          look: 'button',
          show: { label: 'Go', variant: 'filled' },
          tools: [
            {
              do: 'create',
              table: 'logs',
              values: {},
              also: [{ do: 'set', field: 'on', value: 'today' }],
            },
          ],
        },
      ]),
    ).toMatch(/also only works on a button or tap on each entry, or the check of a checklist/);
  });

  it('ticking writes the box and the date; unticking clears them again', () => {
    const ctx = { now: NOW, rowId: 't1' };
    const ticked = checkInput(use, tasks, { title: 'A', done: false, due: '2026-11-20' }, ctx);
    expect(ticked).toEqual({ done: true, completed: '2026-11-18' });
    const stored = prepareRecordValues(
      tasks,
      ticked!,
      { title: 'A', done: false, due: '2026-11-20' },
      NOW,
    );
    expect(stored.ok && stored.values).toEqual({
      title: 'A',
      done: true,
      completed: '2026-11-18',
      due: '2026-11-20',
    });
    const after = stored.ok ? stored.values : {};
    const unticked = checkInput(use, tasks, after, ctx);
    expect(unticked).toEqual({ done: false, completed: '' });
    const back = prepareRecordValues(tasks, unticked!, after, NOW);
    // 回到勾之前的样子（没勾的勾选框存 false，日期不再存）。
    expect(back.ok && back.values).toEqual({ title: 'A', done: false, due: '2026-11-20' });
    // 一个勾选框的 also 取消时存 false。
    const flagged = {
      ...tick,
      also: [{ do: 'set', field: 'flag', value: true }],
    } as unknown as RecordToolUse;
    expect(checkInput(flagged, tasks, { done: true, flag: true }, ctx)).toEqual({
      done: false,
      flag: false,
    });
  });

  it('ticking only overwrites what was empty, otherwise the app offers undo (unticking can only clear)', () => {
    const before = { title: 'A', done: false, completed: '2026-10-01' };
    const after = { ...before, done: true, completed: '2026-11-18' };
    expect(checkOverwrites(use, before, after)).toBe(true);
    expect(checkOverwrites(use, { ...before, completed: null }, after)).toBe(false);
    // 原来就是今天：没有丢掉什么。
    expect(checkOverwrites(use, { ...before, completed: '2026-11-18' }, after)).toBe(false);
    // 取消只是清空勾上时写的值：再勾一下就回来。
    expect(checkOverwrites(use, after, { ...after, done: false, completed: null })).toBe(false);
  });

  it('a value read from this entry that is empty is left out, the box still ticks', () => {
    const copy = {
      ...tick,
      also: [{ do: 'set', field: 'points', value: { copy: 'points' } }],
    } as unknown as RecordToolUse;
    expect(checkInput(copy, tasks, { done: false }, { now: NOW })).toEqual({ done: true });
  });
});

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

// Checklists can also log something when checked (D-617, founder 2021-11-21 "do the first three"):
// when checked, also set one or two fields of this entry (e.g., completion date = today), and clear
// them when unchecked. At most 3 changes per tap, all on this entry (invariant 11); only set, no
// creation, no other tables, no additions/subtractions.

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
    // Two changes are also fine (3 changes in total).
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
    // Other tables, third change: the syntax itself is invalid.
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
    // Field values are checked as usual.
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
          show: { label: 'Go', shape: 'filled' },
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
    // Restore to the state before checking (unchecked checkboxes store false, date is no longer stored).
    expect(back.ok && back.values).toEqual({ title: 'A', done: false, due: '2026-11-20' });
    // The also action of a checkbox stores false when unchecked.
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
    // Already today: nothing is lost.
    expect(checkOverwrites(use, { ...before, completed: '2026-11-18' }, after)).toBe(false);
    // Unchecking only clears the value written when checked: checking again brings it back.
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

import { applyOps, createDefaultWorkspace, type WorkspaceConfig } from '@morph/core';

import { MemoryWorkspaceRepo } from '../storage/memory';
import type { WorkspaceRepo } from '../storage/types';
import { sqliteRepo } from '../test-utils/node-sqlite';
import { testRegistry } from '../test-utils/render-app';
import { actionHash } from '../widgets/ops';
import { runQueuedWidgetOps } from '../widgets/useWidgets';

// R07: Widget tap operations are read first (without deletion), executed one by one, saved to the
// database along with the "already executed" flag, and confirmed for deletion only at the end. If
// interrupted or the app is killed midway, unexecuted items remain in the queue for the next run;
// completed or failed-deletion items will not be re-executed upon subsequent reads.

const action = { do: 'create', table: 'water', values: { day: 'today' } } as const;

function config(): WorkspaceConfig {
  const result = applyOps(
    createDefaultWorkspace('zh'),
    [
      {
        op: 'addData',
        table: { id: 'water', name: '喝水', fields: [{ id: 'day', name: '日期', type: 'date' }] },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'drink',
          look: 'button',
          show: { label: '+1 杯水', shape: 'filled' },
          tools: [action],
        },
      },
    ],
    { registry: testRegistry, locale: 'zh' },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config as WorkspaceConfig;
}

const tap = (id: string, at: number) => ({
  id,
  text: JSON.stringify({ op: 'b:drink', component: 'drink', hash: actionHash(action), at }),
});
const now = new Date(2026, 10, 7, 12);
const count = async (repo: WorkspaceRepo) => (await repo.listRecords('water')).length;

describe.each([
  ['memory', async () => new MemoryWorkspaceRepo()],
  ['SQLite', sqliteRepo],
] as const)('queued widget taps (%s)', (_name, make: () => Promise<WorkspaceRepo>) => {
  it('Completed taps are confirmed for deletion (using id), returning null when un-tapped', async () => {
    const repo = await make();
    const removed: string[] = [];
    const remove = async (ids: readonly string[]) => void removed.push(...ids);
    expect(await runQueuedWidgetOps([], repo, config(), now, remove)).toBeNull();
    const result = await runQueuedWidgetOps(
      [tap('a1', 1000), tap('a2', 2000)],
      repo,
      config(),
      now,
      remove,
    );
    expect(result).toEqual({ done: 2, skipped: 0 });
    expect(await count(repo)).toBe(2);
    expect(removed.sort()).toEqual(['a1', 'a2']);
  });

  it('Second item fails to write: first item completes and confirms deletion, second and third items remain in the queue; executed one each in the next run', async () => {
    const repo = await make();
    const queue = [tap('a1', 1000), tap('a2', 2000), tap('a3', 3000)];
    const remove = async (ids: readonly string[]) => {
      for (const id of ids)
        queue.splice(
          queue.findIndex((q) => q.id === id),
          1,
        );
    };
    const original = repo.applyRecordWrites.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'applyRecordWrites').mockImplementation(async (writes, meta) => {
      if (++calls === 2) throw new Error('disk write failed');
      return original(writes, meta);
    });
    const first = await runQueuedWidgetOps([...queue], repo, config(), now, remove);
    expect(first).toMatchObject({ done: 1 });
    expect(queue.map((q) => q.id)).toEqual(['a2', 'a3']);
    expect(await count(repo)).toBe(1);
    // Next time: execute each of the remaining two items once.
    const second = await runQueuedWidgetOps([...queue], repo, config(), now, remove);
    expect(second).toEqual({ done: 2, skipped: 0 });
    expect(queue).toEqual([]);
    expect(await count(repo)).toBe(3);
  });

  it('Confirm deletion fails: encountering the same tap again next time will not re-execute it, only re-attempt deletion confirmation', async () => {
    const repo = await make();
    const queue = [tap('a1', 1000), tap('a2', 2000)];
    const failing = async () => {
      throw new Error('cannot delete');
    };
    const first = await runQueuedWidgetOps([...queue], repo, config(), now, failing);
    expect(first).toEqual({ done: 2, skipped: 0 });
    expect(await count(repo)).toBe(2);
    const removed: string[] = [];
    const again = await runQueuedWidgetOps([...queue], repo, config(), now, async (ids) => {
      removed.push(...ids);
    });
    expect(await count(repo)).toBe(2);
    expect(removed.sort()).toEqual(['a1', 'a2']);
    expect(again).toBeNull();
  });

  it('Non-executable taps (due to component changes) are considered "unexecuted" and also confirmed for deletion without remaining in the queue', async () => {
    const repo = await make();
    const stale = {
      id: 'z1',
      text: JSON.stringify({ op: 'b:drink', component: 'drink', hash: 'oldhash', at: 1000 }),
    };
    const removed: string[] = [];
    const result = await runQueuedWidgetOps(
      [stale, tap('a1', 2000)],
      repo,
      config(),
      now,
      async (ids) => {
        removed.push(...ids);
      },
    );
    expect(result).toEqual({ done: 1, skipped: 1 });
    expect(removed.sort()).toEqual(['a1', 'z1']);
  });

  it('Corrupted entry is skipped and deleted', async () => {
    const repo = await make();
    const removed: string[] = [];
    const result = await runQueuedWidgetOps(
      [{ id: 'bad1', text: '{not json' }, tap('a1', 2000)],
      repo,
      config(),
      now,
      async (ids) => {
        removed.push(...ids);
      },
    );
    expect(result).toEqual({ done: 1, skipped: 1 });
    expect(removed.sort()).toEqual(['a1', 'bad1']);
  });
});

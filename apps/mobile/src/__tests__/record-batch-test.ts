import { MemoryWorkspaceRepo } from '../storage/memory';
import type { RecordWrite, WorkspaceRepo } from '../storage/types';
import { sqliteRepo } from '../test-utils/node-sqlite';

// R06 / R09: writing multiple records plus a marker must be done in the same transaction—either all
// or none. SQLite uses real transactions (BEGIN / ROLLBACK, test-utils/node-sqlite.ts).

const record = (id: string, count: number) => ({
  id,
  collectionId: 'tasks',
  values: { count },
  createdAt: 1,
  updatedAt: 1,
});

async function seeded(make: () => Promise<WorkspaceRepo>) {
  const repo = await make();
  for (const [id, count] of [
    ['aaaaaaa1', 1],
    ['aaaaaaa2', 2],
    ['aaaaaaa3', 3],
  ] as const)
    await repo.insertRecord(record(id, count));
  return repo;
}

const counts = async (repo: WorkspaceRepo) =>
  (await repo.listRecords('tasks')).map((r) => r.values.count).sort();

describe.each([
  ['memory', async () => new MemoryWorkspaceRepo()],
  ['SQLite', sqliteRepo],
] as const)('applyRecordWrites (%s)', (_name, make: () => Promise<WorkspaceRepo>) => {
  it('All writes and the marker take effect together', async () => {
    const repo = await seeded(make);
    const writes: RecordWrite[] = [
      { kind: 'update', id: 'aaaaaaa1', values: { count: 10 }, updatedAt: 5 },
      { kind: 'insert', record: record('aaaaaaa4', 4) },
    ];
    expect(await repo.applyRecordWrites(writes, { key: 'marker', value: 'done' })).toBe('applied');
    expect(await counts(repo)).toEqual([10, 2, 3, 4]);
    expect(await repo.getMeta('marker')).toBe('done');
    expect((await repo.getRecord('aaaaaaa1'))!.updatedAt).toBe(5);
  });

  it('One write fails in the middle: preceding writes do not take effect, and the marker is not written either', async () => {
    const repo = await seeded(make);
    const writes: RecordWrite[] = [
      { kind: 'update', id: 'aaaaaaa1', values: { count: 10 }, updatedAt: 5 },
      { kind: 'update', id: 'aaaaaaa2', values: { count: 20 }, updatedAt: 5 },
      // This ID already exists: insertion will fail.
      { kind: 'insert', record: record('aaaaaaa3', 99) },
    ];
    await expect(
      repo.applyRecordWrites(writes, { key: 'marker', value: 'done' }),
    ).rejects.toThrow();
    expect(await counts(repo)).toEqual([1, 2, 3]);
    expect(await repo.getMeta('marker')).toBeNull();
  });

  it('The entry required to "still be this version" has been modified: entire batch is aborted, returns conflict', async () => {
    const repo = await seeded(make);
    await repo.updateRecord('aaaaaaa2', { count: 22 }, 3);
    const writes: RecordWrite[] = [
      {
        kind: 'update',
        id: 'aaaaaaa1',
        values: { count: 10 },
        updatedAt: 5,
        expected: { count: 1 },
      },
      {
        kind: 'update',
        id: 'aaaaaaa2',
        values: { count: 20 },
        updatedAt: 5,
        expected: { count: 2 },
      },
    ];
    expect(await repo.applyRecordWrites(writes, { key: 'marker', value: 'done' })).toBe('conflict');
    expect(await counts(repo)).toEqual([1, 22, 3]);
    expect(await repo.getMeta('marker')).toBeNull();
  });

  it('The entry required to "still be this version" has been deleted: conflict', async () => {
    const repo = await seeded(make);
    await repo.deleteRecord('aaaaaaa1', 9);
    const writes: RecordWrite[] = [
      {
        kind: 'update',
        id: 'aaaaaaa1',
        values: { count: 10 },
        updatedAt: 5,
        expected: { count: 1 },
      },
    ];
    expect(await repo.applyRecordWrites(writes)).toBe('conflict');
  });

  it('Writing only the marker is also allowed (no records to write)', async () => {
    const repo = await seeded(make);
    expect(await repo.applyRecordWrites([], { key: 'marker', value: 'x' })).toBe('applied');
    expect(await repo.getMeta('marker')).toBe('x');
  });
});

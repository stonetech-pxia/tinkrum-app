import { MemoryWorkspaceRepo } from '../storage/memory';
import { DB_MIGRATIONS, SQLiteWorkspaceRepo, migrateDatabase } from '../storage/sqlite';
import type { WorkspaceRepo } from '../storage/types';
import { nodeSqlite, sqliteRepo } from '../test-utils/node-sqlite';

// Batch imported from spreadsheet file (D-574): records and batch identifier written in the same
// transaction; undo or delete this import soft-deletes remaining records of this batch (into
// "Recently Deleted"). SQLite uses node:sqlite to run real SQL and transactions, with the same
// semantics as the in-memory implementation.

const record = (id: string, title: string) => ({
  id,
  collectionId: 'orders',
  values: { title },
  createdAt: 10,
  updatedAt: 10,
});
const batch = (id: string, createdAt = 100) => ({
  id,
  collectionId: 'orders',
  fileName: 'Orders 2026.xlsx',
  createdAt,
});
const titles = async (repo: WorkspaceRepo) =>
  (await repo.listRecords('orders')).map((r) => r.values.title).sort();

describe.each([
  ['memory', async () => new MemoryWorkspaceRepo()],
  ['SQLite', sqliteRepo],
] as const)('record imports (%s)', (_name, make: () => Promise<WorkspaceRepo>) => {
  it('writes the entries and the batch together, newest batch first', async () => {
    const repo = await make();
    await repo.insertRecord(record('old00001', 'old'));
    await repo.importRecords(batch('imp1', 100), [
      record('aaaa0001', 'a'),
      record('aaaa0002', 'b'),
    ]);
    await repo.importRecords(batch('imp2', 200), [record('bbbb0001', 'c')]);
    expect(await titles(repo)).toEqual(['a', 'b', 'c', 'old']);
    expect(await repo.listImports('orders')).toEqual([
      { ...batch('imp2', 200), count: 1, present: 1 },
      { ...batch('imp1', 100), count: 2, present: 2 },
    ]);
    expect(await repo.listImports('other')).toEqual([]);
  });

  it('one entry that cannot be written writes nothing, not even the batch', async () => {
    const repo = await make();
    await repo.insertRecord(record('aaaa0002', 'already there'));
    await expect(
      repo.importRecords(batch('imp1'), [record('aaaa0001', 'a'), record('aaaa0002', 'b')]),
    ).rejects.toThrow();
    expect(await titles(repo)).toEqual(['already there']);
    expect(await repo.listImports('orders')).toEqual([]);
  });

  it('deleting a batch soft-deletes exactly its entries still present, edited ones too; restoring one counts it again', async () => {
    const repo = await make();
    await repo.insertRecord(record('old00001', 'old'));
    await repo.importRecords(batch('imp1'), [
      record('aaaa0001', 'a'),
      record('aaaa0002', 'b'),
      record('aaaa0003', 'c'),
    ]);
    await repo.importRecords(batch('imp2', 200), [record('bbbb0001', 'other batch')]);
    await repo.updateRecord('aaaa0001', { title: 'a edited' }, 50);
    // Items already deleted one by one by the user are no longer counted.
    await repo.deleteRecord('aaaa0002', 60);
    expect((await repo.listImports('orders'))[1]!.present).toBe(2);
    expect(await repo.deleteImport('imp1', 70)).toBe(2);
    expect(await titles(repo)).toEqual(['old', 'other batch']);
    const deleted = await repo.listDeletedRecords();
    expect(deleted.map((r) => [r.id, r.deletedAt]).sort()).toEqual([
      ['aaaa0001', 70],
      ['aaaa0002', 60],
      ['aaaa0003', 70],
    ]);
    await repo.restoreRecord('aaaa0001');
    expect((await repo.listImports('orders'))[1]).toMatchObject({ count: 3, present: 1 });
    // After clearing the recycle bin, remaining unmatched markers are neither counted nor cause errors.
    await repo.purgeDeletedRecords(1000);
    expect((await repo.listImports('orders'))[1]).toMatchObject({ present: 1 });
    expect(await repo.deleteImport('missing', 80)).toBe(0);
  });
});

it('the SQLite upgrade adds the two tables and changes no existing row', async () => {
  const db = nodeSqlite();
  // Database before upgrade: first 5 upgrades, already containing records and settings.
  for (const sql of DB_MIGRATIONS.slice(0, 5)) await db.execAsync(sql);
  await db.execAsync('PRAGMA user_version = 5');
  await db.runAsync(
    'INSERT INTO records (id, collection_id, values_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
    'r1',
    'orders',
    '{"title":"keep me"}',
    1,
    2,
    null,
  );
  await db.runAsync('INSERT INTO app_meta (key, value) VALUES (?, ?)', 'guide', 'done');
  const before = await db.getAllAsync('SELECT * FROM records');
  await migrateDatabase(db);
  expect(await db.getFirstAsync('PRAGMA user_version')).toEqual({
    user_version: DB_MIGRATIONS.length,
  });
  expect(DB_MIGRATIONS).toHaveLength(6);
  expect(await db.getAllAsync('SELECT * FROM records')).toEqual(before);
  expect(await db.getAllAsync('SELECT * FROM app_meta')).toEqual([{ key: 'guide', value: 'done' }]);
  const repo = new SQLiteWorkspaceRepo(db);
  expect(await repo.listImports('orders')).toEqual([]);
  // Running migration again does nothing.
  await migrateDatabase(db);
  expect(await db.getAllAsync('SELECT * FROM records')).toEqual(before);
});

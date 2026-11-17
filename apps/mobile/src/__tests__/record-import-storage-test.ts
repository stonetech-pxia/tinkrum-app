import { MemoryWorkspaceRepo } from '../storage/memory';
import { DB_MIGRATIONS, SQLiteWorkspaceRepo, migrateDatabase } from '../storage/sqlite';
import type { WorkspaceRepo } from '../storage/types';
import { nodeSqlite, sqliteRepo } from '../test-utils/node-sqlite';

// 从表格文件导入的一批（D-574）：记录和这一批的记号在同一个事务里写；撤销、删除这次导入把这一批还在的记录
// 软删除（进「最近删除」）。SQLite 用 node:sqlite 跑真实的 SQL 和事务，和内存实现的语义一样。

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
    // 用户已经一条条删了的不再算。
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
    // 清空回收站后，留下的那批对不上的记号不算数，也不出错。
    await repo.purgeDeletedRecords(1000);
    expect((await repo.listImports('orders'))[1]).toMatchObject({ present: 1 });
    expect(await repo.deleteImport('missing', 80)).toBe(0);
  });
});

it('the SQLite upgrade adds the two tables and changes no existing row', async () => {
  const db = nodeSqlite();
  // 升级前的数据库：前 5 次升级，里面已经有记录和设置。
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
  // 再跑一次升级什么都不做。
  await migrateDatabase(db);
  expect(await db.getAllAsync('SELECT * FROM records')).toEqual(before);
});

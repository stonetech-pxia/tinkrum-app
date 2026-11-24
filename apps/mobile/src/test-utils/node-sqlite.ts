import type { SQLiteDatabase } from 'expo-sqlite';

import { SQLiteWorkspaceRepo, migrateDatabase } from '../storage/sqlite';

// Node's built-in node:sqlite running real SQL (foreign keys enabled), wrapped in the same
// interface as expo-sqlite in the app. Transactions are real: BEGIN / COMMIT / ROLLBACK, callback
// throwing an error rolls back the entire transaction; queued one after another just like
// expo-sqlite's exclusive transactions. Must be used for testing writes that "remain completely
// unchanged on failure" (R06, R09, etc.), rather than fake transactions that directly invoke
// callbacks.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      run(...p: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
    };
  };
};

/** When path is omitted, creates an in-memory database; when provided, creates a real file (with -wal, -shm, required for full export testing). */
export function nodeSqlite(path = ':memory:'): SQLiteDatabase {
  const db = new DatabaseSync(path);
  let queue: Promise<unknown> = Promise.resolve();
  const transaction = (fn: (txn: unknown) => Promise<void>) => {
    const run = async () => {
      db.exec('BEGIN');
      try {
        await fn(api);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  };
  const api = {
    execAsync: async (sql: string) => db.exec(sql),
    runAsync: async (sql: string, ...params: unknown[]) => {
      const r = db.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    getFirstAsync: async (sql: string, ...params: unknown[]) =>
      db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params),
    closeAsync: async () => db.close(),
    withTransactionAsync: transaction,
    withExclusiveTransactionAsync: transaction,
  };
  return api as unknown as SQLiteDatabase;
}

export async function sqliteRepo(path?: string) {
  const db = nodeSqlite(path);
  await migrateDatabase(db);
  return new SQLiteWorkspaceRepo(db);
}

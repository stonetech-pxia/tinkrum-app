import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sqliteRepo } from '../test-utils/node-sqlite';
import { DB_MIGRATIONS } from '../storage/sqlite';

// Database in full export (D-600): real SQLite file, WAL mode. VACUUM INTO produces a consistent
// copy: includes records in WAL not yet written back to the main file, preserves user_version,
// ready to use immediately upon opening without needing -wal / -shm.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    prepare(sql: string): { get(...p: unknown[]): Record<string, number> };
    close(): void;
  };
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinkrum-backup-db-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('database snapshot for the backup', () => {
  it('includes writes that are still only in the WAL, keeps user_version, and stands alone', async () => {
    const live = path.join(dir, 'morph.db');
    const repo = await sqliteRepo(live);
    for (let i = 0; i < 25; i++) {
      await repo.insertRecord({
        id: `r${i}`,
        collectionId: 'notes',
        values: { title: `note ${i}` },
        createdAt: i,
        updatedAt: i,
      });
    }
    // Actually in WAL mode with unwritten content in the main file: copying only the main file here would cause data loss.
    expect(fs.existsSync(`${live}-wal`)).toBe(true);
    expect(fs.statSync(`${live}-wal`).size).toBeGreaterThan(0);

    const copy = path.join(dir, 'snapshot.db');
    await repo.snapshotTo(copy);
    expect(fs.existsSync(`${copy}-wal`)).toBe(false);

    const opened = new DatabaseSync(copy);
    expect(opened.prepare('SELECT COUNT(*) AS n FROM records').get().n).toBe(25);
    expect(opened.prepare('PRAGMA user_version').get().user_version).toBe(DB_MIGRATIONS.length);
    opened.close();

    expect(await repo.backupInfo()).toEqual({
      userVersion: DB_MIGRATIONS.length,
      schemaVersion: null,
      records: 25,
    });
    await repo.close();
  });

  it('does not count deleted entries in the manifest numbers', async () => {
    const repo = await sqliteRepo(path.join(dir, 'morph.db'));
    await repo.insertRecord({ id: 'a', collectionId: 't', values: {}, createdAt: 1, updatedAt: 1 });
    await repo.insertRecord({ id: 'b', collectionId: 't', values: {}, createdAt: 2, updatedAt: 2 });
    await repo.deleteRecord('b', 5);
    expect((await repo.backupInfo()).records).toBe(1);
    await repo.close();
  });
});

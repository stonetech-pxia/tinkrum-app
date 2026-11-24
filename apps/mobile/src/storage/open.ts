import { Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';

import MorphShare from '../../modules/morph-share';
import { SQLiteWorkspaceRepo, migrateDatabase } from './sqlite';

// Open the local database (opened only once): shared between app startup and the notification button background handler (D-318).

let opened: Promise<SQLiteWorkspaceRepo> | null = null;

// Exclude Tinkrum data from system backups (D-599). iOS: Mark Documents (where the database resides
// under SQLite/, along with file copies, downloaded tools, and extension packs) and App Group
// shared directories (widget layouts, touches, and incoming shared copies) as do-not-back-up on the
// directory itself, so all contents inherit it. Android does not use this: allowBackup is disabled
// in app.json.
async function excludeStorageFromBackup(): Promise<void> {
  const dirs = [Paths.document, ...Object.values(Paths.appleSharedContainers ?? {})];
  await MorphShare?.excludeFromBackup?.(dirs.map((dir) => dir.uri));
}

export function openRepo(): Promise<SQLiteWorkspaceRepo> {
  opened ??= (async () => {
    // Failure to set the backup exclusion attribute must not block startup.
    await excludeStorageFromBackup().catch(() => undefined);
    const db = await openDatabaseAsync('morph.db');
    await migrateDatabase(db);
    return new SQLiteWorkspaceRepo(db);
  })().catch((e: unknown) => {
    opened = null;
    throw e;
  });
  return opened;
}

/** Close the database and forget the open instance (before full restore / data directory switch, D-600); the next openRepo will reopen it. */
export async function closeRepo(): Promise<void> {
  const current = opened;
  opened = null;
  if (!current) return;
  const repo = await current.catch(() => null);
  await repo?.close();
}

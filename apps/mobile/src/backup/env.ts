import { CURRENT_SCHEMA_VERSION } from '@morph/core';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import { Platform } from 'react-native';

import MorphArchive from '../../modules/morph-archive';
import { openRepo } from '../storage/open';
import { DB_MIGRATIONS, migrateDatabase } from '../storage/sqlite';
import { backupRuntime } from './runtime';
import type { ArchiveNative, BackupEnv, StagedDb } from './service';

// Environment for overall export and restore on real devices (D-600): native zip (MorphArchive), expo-file-system, expo-sqlite.

/** file:// URI -> local path (SQLite requires path, not file://, and no percent encoding). */
const toPath = (uri: string) =>
  decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');

/** Native modules not present in Expo Go and tests: hide "Backup" section. */
export const backupAvailable = () => MorphArchive !== null && MorphArchive !== undefined;

function nativeArchive(): ArchiveNative {
  const m = MorphArchive;
  if (!m) throw new Error('MorphArchive is not available');
  return {
    scanTree: (uris) => m.scanTree(uris),
    createArchive: (dest, sources) => m.createArchive(dest, sources),
    inspectArchive: (src) => m.inspectArchive(src),
    extractArchive: (src, dest) => m.extractArchive(src, dest),
    moveTree: (from, to) => m.moveTree(from, to),
    removeTree: (uri) => m.removeTree(uri),
    cancel: () => m.cancel(),
    onProgress(listener) {
      const subscription = m.addListener('onProgress', listener);
      return () => subscription.remove();
    },
  };
}

async function openStaged(dirUri: string): Promise<StagedDb> {
  const db = await openDatabaseAsync('morph.db', undefined, toPath(dirUri));
  return {
    async integrityOk() {
      try {
        const row = await db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
        return row?.integrity_check === 'ok';
      } catch {
        // Not a database file.
        return false;
      }
    },
    async userVersion() {
      const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      return row?.user_version ?? 0;
    },
    migrate: () => migrateDatabase(db),
    async head() {
      try {
        const row = await db.getFirstAsync<{ id: number; schema_version: number }>(
          'SELECT r.id, r.schema_version FROM workspace_head h JOIN revisions r ON r.id = h.revision_id WHERE h.singleton = 1',
        );
        return row ? { id: row.id, schemaVersion: row.schema_version } : null;
      } catch {
        // No such tables: not a Tinkrum database.
        return null;
      }
    },
    close: () => db.closeAsync(),
  };
}

export function createBackupEnv(): BackupEnv {
  return {
    native: nativeArchive(),
    fs: {
      // Paths ending with / are directories, others are files.
      exists: (uri) => (uri.endsWith('/') ? new Directory(uri).exists : new File(uri).exists),
      makeDir: (uri) => new Directory(uri).create({ idempotent: true, intermediates: true }),
      size: (uri) => new File(uri).size,
      freeSpace: () => Paths.availableDiskSpace,
      removeFile: (uri) => new File(uri).delete(),
    },
    roots: {
      documents: Paths.document.uri.replace(/\/?$/, '/'),
      cache: Paths.cache.uri.replace(/\/?$/, '/'),
    },
    db: {
      live: {
        snapshotTo: async (dest) => (await openRepo()).snapshotTo(toPath(dest)),
        info: async () => (await openRepo()).backupInfo(),
      },
      openStaged,
      maxUserVersion: DB_MIGRATIONS.length,
      maxSchemaVersion: CURRENT_SCHEMA_VERSION,
    },
    runtime: backupRuntime,
    app: { version: Constants.expoConfig?.version ?? null, platform: Platform.OS },
    now: () => new Date(),
  };
}

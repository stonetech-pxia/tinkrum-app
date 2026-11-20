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

// 整体导出和恢复在真机上的环境（D-600）：原生 zip（MorphArchive）、expo-file-system、expo-sqlite。

/** file:// 地址 → 本机路径（SQLite 要路径，不要 file://，也不要百分号编码）。 */
const toPath = (uri: string) =>
  decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');

/** 原生模块在 Expo Go 和测试里没有：这时「备份」这一块不显示。 */
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
        // 不是数据库文件。
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
        // 没有这些表：不是 Tinkrum 的数据库。
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
      // 结尾带 / 的是目录，其余是文件。
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

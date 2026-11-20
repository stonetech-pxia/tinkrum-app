import { Paths } from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';

import MorphShare from '../../modules/morph-share';
import { SQLiteWorkspaceRepo, migrateDatabase } from './sqlite';

// 打开本机数据库（只打开一次）：界面启动和提醒按钮的后台处理（D-318）共用一个。

let opened: Promise<SQLiteWorkspaceRepo> | null = null;

// 系统备份里不放 Tinkrum 的数据（D-599）。iOS：每次启动把 Documents（数据库在它的 SQLite/ 里，文件副本、
// 下载的工具和扩展包也在里面）和 App Group 共享目录（小组件的画面和点按、分享进来的副本）标成不备份，
// 标在目录上，里面的东西都跟着不备份。Android 不走这里：app.json 里关掉了 allowBackup。
async function excludeStorageFromBackup(): Promise<void> {
  const dirs = [Paths.document, ...Object.values(Paths.appleSharedContainers ?? {})];
  await MorphShare?.excludeFromBackup?.(dirs.map((dir) => dir.uri));
}

export function openRepo(): Promise<SQLiteWorkspaceRepo> {
  opened ??= (async () => {
    // 标不上不挡启动。
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

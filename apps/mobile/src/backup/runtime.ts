import type { BackupEnv } from './service';

// 恢复和撤销要「关掉数据库、换目录、重开并重建界面状态」。这些在根布局（app/_layout.tsx）里：
// 工作空间的 store 和数据库是它建的。根布局挂上之后把自己的实现登记在这里，备份流程通过它调用。

let hooks: BackupEnv['runtime'] | null = null;

export function registerBackupRuntime(next: BackupEnv['runtime'] | null) {
  hooks = next;
}

function current(): BackupEnv['runtime'] {
  if (!hooks) throw new Error('The app is not ready');
  return hooks;
}

export const backupRuntime: BackupEnv['runtime'] = {
  release: () => current().release(),
  reload: (expectHeadId) => current().reload(expectHeadId),
  notify: (kind) => current().notify(kind),
};

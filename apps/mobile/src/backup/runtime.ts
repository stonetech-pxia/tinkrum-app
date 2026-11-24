import type { BackupEnv } from './service';

// Restore and undo need to "close database, switch directory, reopen, and rebuild UI state". These
// are handled in root layout (app/_layout.tsx): workspace store and database are created by it.
// After root layout mounts, register its implementation here, backup pipeline calls it through
// this.

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

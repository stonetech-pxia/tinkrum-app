import { createBackupEnv } from './env';
import { createBackupService, type BackupService } from './service';

export { backupAvailable } from './env';

// Single service for overall export and restore (D-600): UI and undo banners use it, state is in useBackupStatus in service.ts.
let service: BackupService | null = null;

export function getBackup(): BackupService {
  service ??= createBackupService(createBackupEnv());
  return service;
}

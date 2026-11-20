import { createBackupEnv } from './env';
import { createBackupService, type BackupService } from './service';

export { backupAvailable } from './env';

// 整体导出和恢复只有一个服务（D-600）：界面、撤销提示条都用它，状态在 service.ts 的 useBackupStatus 里。
let service: BackupService | null = null;

export function getBackup(): BackupService {
  service ??= createBackupService(createBackupEnv());
  return service;
}

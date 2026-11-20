import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import MorphShare from '../../modules/morph-share';
import { openRepo } from '../storage/open';

// 系统备份里不放 Tinkrum 的数据（D-599）：Android 在 app.json 里关掉 allowBackup；iOS 每次启动把放数据的
// 目录标成不备份。原生模块是假的；标记真的写上了只有模拟器和真机上能验证。

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn(async () => ({})) }));
jest.mock('../storage/sqlite', () => ({
  migrateDatabase: jest.fn(async () => undefined),
  SQLiteWorkspaceRepo: class {},
}));
jest.mock('expo-file-system', () => ({
  Paths: {
    document: { uri: 'file:///app/Documents/' },
    appleSharedContainers: { 'group.dev.stonetech.tinkrum': { uri: 'file:///group/' } },
  },
}));
jest.mock('../../modules/morph-share', () => ({
  __esModule: true,
  default: { excludeFromBackup: jest.fn(async () => undefined) },
}));

describe('系统备份里不放 Tinkrum 的数据（D-599）', () => {
  it('Android: app.json turns the system backup off', () => {
    const app = JSON.parse(readFileSync(join(__dirname, '../../app.json'), 'utf8'));
    expect(app.expo.android.allowBackup).toBe(false);
  });

  it('iOS: opening the storage marks Documents and the App Group container as not backed up', async () => {
    await openRepo();
    expect(MorphShare!.excludeFromBackup).toHaveBeenCalledWith([
      'file:///app/Documents/',
      'file:///group/',
    ]);
  });

  it('the app still opens its storage when the mark cannot be set', async () => {
    jest.resetModules();
    jest.doMock('../../modules/morph-share', () => ({
      __esModule: true,
      default: {
        excludeFromBackup: jest.fn(async () => {
          throw new Error('no');
        }),
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require('../storage/open') as typeof import('../storage/open');
    await expect(fresh.openRepo()).resolves.toBeDefined();
  });
});

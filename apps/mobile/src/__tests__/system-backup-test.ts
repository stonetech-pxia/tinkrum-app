import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import MorphShare from '../../modules/morph-share';
import { openRepo } from '../storage/open';

// Exclude Tinkrum data from system backups (D-599): Android disables allowBackup in app.json; iOS
// marks the data directory as do-not-backup on every startup. Native modules are mocked; actual
// markings can only be verified on emulators and real devices.

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

describe('Exclude Tinkrum data from system backups (D-599)', () => {
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

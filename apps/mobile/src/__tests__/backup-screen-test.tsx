import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { TOAST_RESTORE_MS, TOAST_UNDO_MS } from '../shell/Toast';
import { createBackupService, useBackupStatus, type BackupService } from '../backup/service';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeBackup, PICKED } from '../test-utils/fake-backup';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';

// 「设置 → 数据 → 备份和恢复」（D-600）：新用户（没有数据）、有数据、各种出错和取消。
// 原生 zip 在这里是替身（FakeBackup），界面、确认、状态都是真的。

let disk: FakeBackup;
let mockService: BackupService;
jest.mock('../backup', () => ({
  backupAvailable: () => true,
  getBackup: () => mockService,
}));

const idle = {
  phase: 'idle',
  step: null,
  done: 0,
  total: 0,
  exported: null,
  error: null,
} as const;

async function start(locale: 'zh' | 'en' | 'fr' = 'zh') {
  disk = new FakeBackup();
  mockService = createBackupService(disk.env());
  useBackupStatus.setState({ ...idle });
  const files = new FakeFiles();
  const app = await renderToolsApp(new MemoryWorkspaceRepo(), files, { locale });
  await screen.findByTestId('nav-settings');
  await act(() => router.push('/data'));
  await screen.findByTestId('backup');
  return { ...app, files };
}

/** 下一个弹窗：按指定的按钮，并把标题和内容交回来。 */
function answerNext(label: string) {
  const asked: { title?: string | null; message?: string | null } = {};
  jest.spyOn(Alert, 'alert').mockImplementationOnce((title, message, buttons?: AlertButton[]) => {
    asked.title = title;
    asked.message = message;
    void buttons?.find((b) => b.text === label)?.onPress?.();
  });
  return asked;
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => {});
}

afterEach(() => jest.restoreAllMocks());

describe('备份和恢复：新用户（还没有什么数据）', () => {
  it('shows both actions, and export says the file is not encrypted before it does anything', async () => {
    await start();
    expect(screen.getByTestId('backup-export')).toBeOnTheScreen();
    expect(screen.getByTestId('backup-restore')).toBeOnTheScreen();
    // 打开页面什么都不做（底线 15）：不扫、不写、不删。
    expect(disk.calls).toEqual([]);
    expect(disk.removed).toEqual([]);
    // 先问；不确认就什么都不做。
    const asked = answerNext('取消');
    await fireEvent.press(screen.getByTestId('backup-export'));
    await flush();
    expect(asked.message).toMatch(/没有加密/);
    expect(asked.message).toMatch(/所有的记录、文件和 App 设计/);
    expect(disk.calls).not.toContain('createArchive');
  });

  it('exports, offers where to put it, and Done removes the cache copy', async () => {
    const { files } = await start();
    answerNext('导出');
    await fireEvent.press(screen.getByTestId('backup-export'));
    await flush();
    expect(screen.getByTestId('backup-ready')).toHaveTextContent(/tinkrum-backup-2026-11-20\.zip/);
    // 复制进文件夹的是这个缓存里的压缩包（替身磁盘里的文件在 FakeFiles 里也放一份）。
    files.disk.set(useBackupStatus.getState().exported!.uri, new Uint8Array(3));
    await fireEvent.press(screen.getByTestId('backup-save-folder'));
    await flush();
    expect(screen.getByTestId('backup-saved')).toHaveTextContent(/MorphOut/);
    // 每次都让用户选文件夹，不用记住的那个。
    expect(files.folderPicks).toBe(1);
    await fireEvent.press(screen.getByTestId('backup-share'));
    await flush();
    expect(files.shared[0]).toMatch(/backup-export\/tinkrum-backup-2026-11-20\.zip$/);
    await fireEvent.press(screen.getByTestId('backup-done'));
    await flush();
    expect(screen.getByTestId('backup-export')).toBeOnTheScreen();
    expect([...disk.files.keys()].filter((k) => k.startsWith('file:///cache/'))).toEqual([]);
  });

  it('can be cancelled while it writes, and says nothing was changed', async () => {
    await start();
    let release!: () => void;
    disk.gate = new Promise<void>((resolve) => (release = resolve));
    answerNext('导出');
    await fireEvent.press(screen.getByTestId('backup-export'));
    await flush();
    expect(screen.getByTestId('backup-working')).toBeOnTheScreen();
    expect(screen.getByTestId('backup-progress')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('backup-cancel'));
    release();
    await flush();
    expect(screen.getByTestId('backup-error')).toHaveTextContent('已取消，什么都没有改动。');
  });
});

describe('备份和恢复：有数据时恢复', () => {
  it('reads the archive in place (no copy into the cache), asks with the date and size, then replaces everything', async () => {
    const { files } = await start();
    disk.addArchive();
    files.nextPick = [{ uri: PICKED, name: 'backup.zip', size: 9, mimeType: 'application/zip' }];
    const asked = answerNext('全部替换');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(files.lastPickInPlace).toBe(true);
    expect(files.lastPickTypes).toContain('application/zip');
    expect(asked.title).toBe('替换 Tinkrum 里的全部内容？');
    expect(asked.message).toMatch(/2026/);
    expect(asked.message).toMatch(/9 条记录/);
    expect(asked.message).toMatch(/恢复之后可以马上撤销/);
    expect(disk.notified).toEqual(['restored']);
    expect(disk.runtimeHead).toBe(21);
    expect(disk.removed).not.toContain(PICKED);
  });

  it('does nothing when the user declines the question', async () => {
    const { files } = await start();
    disk.addArchive();
    files.nextPick = [{ uri: PICKED, name: 'backup.zip', size: 9, mimeType: 'application/zip' }];
    answerNext('取消');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(disk.calls).not.toContain('release');
    expect(disk.notified).toEqual([]);
    expect(screen.getByTestId('backup-restore')).toBeOnTheScreen();
  });

  it('does nothing when the user closes the file picker', async () => {
    const { files } = await start();
    files.nextPick = null;
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(disk.calls).toEqual([]);
  });

  const refusals: [string, (d: FakeBackup) => void, RegExp][] = [
    ['not a zip', () => undefined, /这不是 Tinkrum 的备份文件，什么都没有改动/],
    [
      'a zip without the manifest',
      (d) => d.addArchive(PICKED, { manifest: null }),
      /这不是 Tinkrum 的备份文件/,
    ],
    [
      'a newer archive',
      (d) => d.addArchive(PICKED, { db: { userVersion: 9 } }),
      /更新版本的 Tinkrum 做的。请先更新 Tinkrum 再试/,
    ],
    [
      'a truncated archive',
      (d) => d.addArchive(PICKED, { error: 'ERR_ARCHIVE_DAMAGED' }),
      /已损坏或不完整，什么都没有改动/,
    ],
  ];
  it.each(refusals)('%s: says so and changes nothing', async (_n, make, text) => {
    const { files } = await start();
    make(disk);
    files.nextPick = [{ uri: PICKED, name: 'x.zip', size: 9, mimeType: 'application/zip' }];
    const before = disk.snapshotLive();
    const alert = jest.spyOn(Alert, 'alert');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(screen.getByTestId('backup-error')).toHaveTextContent(text);
    expect(alert).not.toHaveBeenCalled();
    expect(disk.snapshotLive()).toEqual(before);
  });

  it('says how much space is needed when there is not enough', async () => {
    const { files } = await start();
    disk.addArchive();
    disk.archiveBytes = 3 * 1024 ** 3;
    disk.free = 1024 ** 3;
    files.nextPick = [{ uri: PICKED, name: 'x.zip', size: 9, mimeType: 'application/zip' }];
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(screen.getByTestId('backup-error')).toHaveTextContent(/腾出大约 3\d\d\d\.\d MB 再试/);
  });

  it('can be cancelled while unpacking', async () => {
    const { files } = await start();
    disk.addArchive();
    files.nextPick = [{ uri: PICKED, name: 'x.zip', size: 9, mimeType: 'application/zip' }];
    let release!: () => void;
    disk.gate = new Promise<void>((resolve) => (release = resolve));
    answerNext('全部替换');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    await fireEvent.press(screen.getByTestId('backup-cancel'));
    release();
    await flush();
    expect(screen.getByTestId('backup-error')).toHaveTextContent('已取消，什么都没有改动。');
    expect(disk.calls).not.toContain('release');
  });

  it('puts the old data back and says so when the new data cannot be opened', async () => {
    const { files } = await start();
    disk.addArchive(PICKED, { db: { unbootable: true } });
    files.nextPick = [{ uri: PICKED, name: 'x.zip', size: 9, mimeType: 'application/zip' }];
    const before = disk.snapshotLive();
    answerNext('全部替换');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(screen.getByTestId('backup-error')).toHaveTextContent(
      '备份没能打开，Tinkrum 已换回你之前的数据。',
    );
    expect(disk.snapshotLive()).toEqual(before);
  });
});

describe('恢复之后的撤销提示', () => {
  it('Undo on the banner goes back to the earlier data, and the earlier data is still there when the banner closes', async () => {
    const { files, store } = await start();
    disk.addArchive();
    files.nextPick = [{ uri: PICKED, name: 'x.zip', size: 9, mimeType: 'application/zip' }];
    answerNext('全部替换');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(disk.runtimeHead).toBe(21);
    const kept = 'file:///doc/.restore/previous/assets/a1/photo.jpg';
    expect(disk.files.has(kept)).toBe(true);

    await act(() => router.replace('/'));
    await screen.findByTestId('nav-settings');
    await act(async () =>
      store.getState().showToast({ message: '已从备份恢复。', undoRestore: true }),
    );
    await fireEvent.press(await screen.findByTestId('toast-undo'));
    await flush();
    expect(disk.runtimeHead).toBe(7);
    expect(disk.files.get('file:///doc/assets/a1/photo.jpg')).toBe('PHOTO');
    expect(disk.notified).toEqual(['restored', 'undone']);
    expect(mockService.hasUndo()).toBe(false);
  });
});

describe('恢复之后的撤销提示：时长', () => {
  it('stays longer than an ordinary undo banner, then goes', async () => {
    const { store } = await start();
    await act(() => router.replace('/'));
    await screen.findByTestId('nav-settings');
    expect(TOAST_RESTORE_MS).toBeGreaterThan(TOAST_UNDO_MS);
    jest.useFakeTimers();
    try {
      await act(async () => store.getState().showToast({ message: 'x', undoRestore: true }));
      await act(() => jest.advanceTimersByTime(TOAST_UNDO_MS + 1000));
      expect(screen.getByTestId('toast-undo')).toBeTruthy();
      await act(() => jest.advanceTimersByTime(TOAST_RESTORE_MS - TOAST_UNDO_MS));
      expect(store.getState().toast).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('备份和恢复：法语', () => {
  it('shows the French copy for the card, the question and the refusals', async () => {
    const { files } = await start('fr');
    expect(screen.getByText(/sauvegarde et restauration/i)).toBeOnTheScreen();
    expect(screen.getByTestId('backup-export')).toHaveTextContent('Tout exporter');
    const asked = answerNext('Annuler');
    await fireEvent.press(screen.getByTestId('backup-export'));
    await flush();
    expect(asked.title).toBe('Tout exporter ?');
    expect(asked.message).toMatch(/n’est pas chiffré/);

    files.nextPick = [{ uri: PICKED, name: 'x.zip', size: 9, mimeType: 'application/zip' }];
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(screen.getByTestId('backup-error')).toHaveTextContent(
      'Ce n’est pas un fichier de sauvegarde Tinkrum : rien n’a été modifié.',
    );

    disk.addArchive(PICKED, { db: { records: 1 } });
    const confirm = answerNext('Annuler');
    await fireEvent.press(screen.getByTestId('backup-restore'));
    await flush();
    expect(confirm.title).toBe('Remplacer tout le contenu de Tinkrum ?');
    // 1 entrée (singulier), la date et la taille.
    expect(confirm.message).toMatch(/contient 1 entrée \(environ/);
  });
});

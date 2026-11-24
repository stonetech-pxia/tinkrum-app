import { DB_ENTRY, MANIFEST_NAME, parseManifest } from '../backup/manifest';
import {
  createBackupService,
  needSpace,
  useBackupStatus,
  type BackupService,
} from '../backup/service';
import { CACHE, DOC, FakeBackup, PICKED } from '../test-utils/fake-backup';

// Full export and restore workflow (D-600, backup/service.ts): run through using mock disk, mock
// zip, and mock database. Every step must fail if the corresponding code is removed: nothing
// changes when checks fail, everything rolls back when directory switching fails, no residue is
// left on cancellation, and compressed archives provided by the selector (user originals) are never
// deleted even once (invariant 4).

let disk: FakeBackup;
let service: BackupService;
const yes = async () => true;

function setup(over?: Parameters<FakeBackup['env']>[0]) {
  disk = new FakeBackup();
  useBackupStatus.setState({
    phase: 'idle',
    step: null,
    done: 0,
    total: 0,
    exported: null,
    error: null,
  });
  service = createBackupService(disk.env(over));
}

const status = () => useBackupStatus.getState();
const notUntouched = (before: Record<string, string>) =>
  expect(disk.snapshotLive()).toEqual(before);

describe('Export', () => {
  beforeEach(() => setup());

  it('writes one archive with the manifest, the database copy and every user file directory, and not the packs', async () => {
    await service.exportAll();
    const done = status().exported!;
    expect(done.name).toBe('tinkrum-backup-2026-11-20.zip');
    expect(done.uri.startsWith(CACHE)).toBe(true);
    const archive = disk.archives.get(done.uri)!;
    expect(Object.keys(archive.entries).sort()).toEqual(
      [
        MANIFEST_NAME,
        DB_ENTRY,
        'files/assets/a1/.thumb.jpg',
        'files/assets/a1/photo.jpg',
        'files/desk/d1/doc.pdf',
        'files/tools/pack/manifest.json',
      ].sort(),
    );
    // Database content is that consistent copy; model packs (packs/) are not included.
    expect(JSON.parse(archive.entries[DB_ENTRY]!)).toMatchObject({ headId: 7, records: 3 });
    expect(Object.keys(archive.entries).some((n) => n.includes('model'))).toBe(false);
    const manifest = parseManifest(archive.manifest);
    expect(manifest).toMatchObject({
      ok: true,
      manifest: {
        createdAt: new Date(2026, 10, 20, 12, 0).getTime(),
        database: { userVersion: 5, schemaVersion: 39 },
        contains: { records: 3, files: 4 },
      },
    });
    // Database copy does not remain in cache (already in the archive); original data is untouched.
    expect(disk.files.has(`${CACHE}backup-export/morph.db`)).toBe(false);
    expect(disk.calls).toContain('snapshot');
    expect(disk.files.get(`${DOC}assets/a1/photo.jpg`)).toBe('PHOTO');
  });

  it('is only for the user to place: done removes the cache copy', async () => {
    await service.exportAll();
    const uri = status().exported!.uri;
    expect(disk.files.has(uri)).toBe(true);
    await service.discardExport();
    expect(disk.files.has(uri)).toBe(false);
    expect(status().phase).toBe('idle');
  });

  it('refuses before writing when there is not enough free space, and says how much', async () => {
    disk.free = 100;
    await service.exportAll();
    expect(status().error).toMatchObject({ kind: 'noSpace' });
    expect(status().error!.needed).toBeGreaterThan(100);
    expect(disk.calls).not.toContain('createArchive');
    // Nothing is left in cache.
    expect([...disk.files.keys()].filter((k) => k.startsWith(CACHE))).toEqual([]);
  });

  it('cancelling part-way ends the promise, leaves nothing in the cache and the data untouched', async () => {
    let release!: () => void;
    disk.gate = new Promise<void>((resolve) => (release = resolve));
    const before = disk.snapshotLive();
    const running = service.exportAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(status().step).toBe('write');
    service.cancel();
    release();
    await running;
    expect(status().error).toMatchObject({ kind: 'cancelled' });
    expect(status().phase).toBe('idle');
    expect([...disk.files.keys()].filter((k) => k.startsWith(CACHE))).toEqual([]);
    notUntouched(before);
  });
});

describe('Restore: nothing changes when checks fail', () => {
  beforeEach(() => setup());

  const cases: [string, (d: FakeBackup) => void, string][] = [
    ['not a zip', () => undefined, 'notBackup'],
    ['a zip without the manifest', (d) => d.addArchive(PICKED, { manifest: null }), 'notBackup'],
    [
      'a zip with the manifest but no database',
      (d) => d.addArchive(PICKED, { skipDb: true }),
      'notBackup',
    ],
    [
      'a zip with something that has no place in Tinkrum',
      (d) => d.addArchive(PICKED, { extra: { 'photos/x.jpg': 'X' } }),
      'notBackup',
    ],
    [
      'a manifest of another format',
      (d) => d.addArchive(PICKED, { manifest: { format: 'something-else' } }),
      'notBackup',
    ],
    [
      'an archive from a newer format',
      (d) => d.addArchive(PICKED, { manifest: { formatVersion: 2 } }),
      'newer',
    ],
    [
      'an archive from a newer Tinkrum (database)',
      (d) => d.addArchive(PICKED, { db: { userVersion: 6 } }),
      'newer',
    ],
    [
      'an archive from a newer Tinkrum (design)',
      (d) => d.addArchive(PICKED, { db: { schemaVersion: 40 } }),
      'newer',
    ],
    ['a damaged archive', (d) => d.addArchive(PICKED, { error: 'ERR_ARCHIVE_DAMAGED' }), 'damaged'],
    [
      'a hostile archive',
      (d) => d.addArchive(PICKED, { error: 'ERR_ARCHIVE_UNSAFE' }),
      'notBackup',
    ],
    [
      'an encrypted archive',
      (d) => d.addArchive(PICKED, { error: 'ERR_ARCHIVE_UNSUPPORTED' }),
      'notBackup',
    ],
    [
      'a truncated archive (no end of file)',
      (d) => d.archives.set(PICKED, { entries: {}, manifest: null, error: 'ERR_ARCHIVE_NOT_ZIP' }),
      'notBackup',
    ],
  ];

  it.each(cases)('refuses %s', async (_name, make, kind) => {
    make(disk);
    const before = disk.snapshotLive();
    const confirm = jest.fn(yes);
    expect(await service.restore(PICKED, confirm)).toBe('failed');
    expect(status().error).toMatchObject({ kind });
    expect(confirm).not.toHaveBeenCalled();
    expect(disk.calls).not.toContain('release');
    expect(disk.calls).not.toContain('extractArchive');
    notUntouched(before);
    // Original is still there.
    expect(disk.removed).not.toContain(PICKED);
  });

  it('refuses when the unpacked data would not fit', async () => {
    disk.addArchive();
    disk.archiveBytes = 5 * 1024 ** 3;
    disk.free = 4 * 1024 ** 3;
    const before = disk.snapshotLive();
    expect(await service.restore(PICKED, yes)).toBe('failed');
    expect(status().error).toMatchObject({ kind: 'noSpace', needed: needSpace(5 * 1024 ** 3) });
    notUntouched(before);
    expect(disk.calls).not.toContain('extractArchive');
  });

  it('refuses a database that fails its integrity check, after unpacking, without touching the data', async () => {
    disk.addArchive(PICKED, { db: { corrupt: true } });
    const before = disk.snapshotLive();
    expect(await service.restore(PICKED, yes)).toBe('failed');
    expect(status().error).toMatchObject({ kind: 'damaged' });
    expect(disk.calls).not.toContain('release');
    notUntouched(before);
    // Extracted items are deleted.
    expect([...disk.files.keys()].some((k) => k.includes('.restore/staging'))).toBe(false);
  });

  it('asks first, and says nothing is changed when the user declines', async () => {
    disk.addArchive();
    const before = disk.snapshotLive();
    const confirm = jest.fn(async () => false);
    expect(await service.restore(PICKED, confirm)).toBe('declined');
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ contains: expect.anything() }),
      }),
    );
    expect(disk.calls).not.toContain('extractArchive');
    notUntouched(before);
  });
});

describe('Restore', () => {
  beforeEach(() => setup());

  it('replaces everything, keeps the previous data aside, reads the new data back, then undo returns the old state', async () => {
    disk.addArchive();
    const old = disk.snapshotLive();
    expect(await service.restore(PICKED, yes)).toBe('restored');
    // New data in original locations: database, user files; packs untouched; old user files no longer in original location.
    expect(JSON.parse(disk.files.get(`${DOC}SQLite/morph.db`)!)).toMatchObject({ headId: 21 });
    expect(disk.files.get(`${DOC}assets/b1/receipt.pdf`)).toBe('RECEIPT');
    expect(disk.files.has(`${DOC}assets/a1/photo.jpg`)).toBe(false);
    expect(disk.files.get(`${DOC}packs/model.bin`)).toBe('BIG MODEL');
    // Old data is entirely left in .restore/previous (renamed, not copied).
    expect(disk.files.get(`${DOC}.restore/previous/assets/a1/photo.jpg`)).toBe('PHOTO');
    expect(disk.files.get(`${DOC}.restore/previous/SQLite/morph.db`)).toBeDefined();
    // Close database -> replace -> reopen and read back (the read current version must match the one in the archive).
    expect(disk.calls.indexOf('release')).toBeLessThan(disk.calls.indexOf('reload'));
    expect(disk.reloads).toEqual([21]);
    expect(disk.runtimeHead).toBe(21);
    expect(disk.notified).toEqual(['restored']);
    expect(service.hasUndo()).toBe(true);
    expect(status().phase).toBe('idle');

    expect(await service.undoRestore()).toBe(true);
    expect(disk.snapshotLive()).toEqual(old);
    expect(disk.runtimeHead).toBe(7);
    expect(disk.notified).toEqual(['restored', 'undone']);
    expect(service.hasUndo()).toBe(false);
    // Both the incoming restored copy and the retained old data are cleared.
    expect([...disk.files.keys()].filter((k) => k.startsWith(`${DOC}.restore/`))).toEqual([]);
    expect(disk.removed).not.toContain(PICKED);
  });

  it('upgrades an archive from an older Tinkrum before switching', async () => {
    disk.addArchive(PICKED, { db: { userVersion: 3, schemaVersion: 30 } });
    expect(await service.restore(PICKED, yes)).toBe('restored');
    expect(disk.migrated).toBe(1);
  });

  it('goes back to the old data when the restored data cannot be read back', async () => {
    disk.addArchive(PICKED, { db: { unbootable: true } });
    const old = disk.snapshotLive();
    expect(await service.restore(PICKED, yes)).toBe('failed');
    expect(status().error).toMatchObject({ kind: 'switchFailed' });
    expect(disk.snapshotLive()).toEqual(old);
    // Closed and reopened the old one: first release, then try the new one, and upon failure read back the old one.
    expect(disk.reloads).toEqual([21, undefined]);
    expect(disk.runtimeHead).toBe(7);
    expect(disk.notified).toEqual([]);
    expect(service.hasUndo()).toBe(false);
    expect([...disk.files.keys()].some((k) => k.includes('.restore/staging'))).toBe(false);
  });

  it('goes back to the old data when the app falls back to an older version instead of reading the new head', async () => {
    // Current version in database cannot be parsed (e.g., missing tool): reverted to old version during rebuild, not counted as success.
    disk.addArchive(PICKED, { db: { headId: 21 } });
    const env = disk.env();
    const reload = env.runtime.reload;
    env.runtime.reload = async (id) => {
      if (id !== undefined) throw new Error('fell back to an older version');
      await reload(id);
    };
    service = createBackupService(env);
    const old = disk.snapshotLive();
    expect(await service.restore(PICKED, yes)).toBe('failed');
    expect(status().error).toMatchObject({ kind: 'switchFailed' });
    expect(disk.snapshotLive()).toEqual(old);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'puts every directory back when moving fails at step %i of the switch',
    async (step) => {
      disk.addArchive();
      const old = disk.snapshotLive();
      disk.failMoveAt = step;
      expect(await service.restore(PICKED, yes)).toBe('failed');
      expect(status().error).toMatchObject({ kind: 'switchFailed' });
      expect(disk.snapshotLive()).toEqual(old);
      expect(disk.runtimeHead).toBe(7);
      expect(service.hasUndo()).toBe(false);
    },
  );

  it('cancelling the unpack ends the promise, removes what was unpacked, and never closes the database', async () => {
    disk.addArchive();
    const before = disk.snapshotLive();
    let release!: () => void;
    disk.gate = new Promise<void>((resolve) => (release = resolve));
    const running = service.restore(PICKED, yes);
    await new Promise((r) => setTimeout(r, 0));
    expect(status().step).toBe('unpack');
    service.cancel();
    release();
    expect(await running).toBe('failed');
    expect(status().error).toMatchObject({ kind: 'cancelled' });
    expect(disk.calls).not.toContain('release');
    notUntouched(before);
    expect([...disk.files.keys()].some((k) => k.startsWith(`${DOC}.restore/`))).toBe(false);
  });

  it('cannot be cancelled once it is switching', async () => {
    disk.addArchive();
    const seen: string[] = [];
    const env = disk.env();
    const release = env.runtime.release;
    env.runtime.release = async () => {
      service.cancel();
      seen.push(...disk.calls.filter((c) => c === 'cancel'));
      await release();
    };
    service = createBackupService(env);
    expect(await service.restore(PICKED, yes)).toBe('restored');
    expect(seen).toEqual([]);
  });

  it('removes the previous data only when the undo is no longer offered, never while undoing', async () => {
    disk.addArchive();
    await service.restore(PICKED, yes);
    const kept = `${DOC}.restore/previous/assets/a1/photo.jpg`;
    expect(disk.files.has(kept)).toBe(true);
    const undoing = service.undoRestore();
    // Prompt dismissed after undo started: the retained data is required for the undo, so it cannot be deleted.
    await service.discardPrevious();
    expect(await undoing).toBe(true);
    expect(disk.files.get(`${DOC}assets/a1/photo.jpg`)).toBe('PHOTO');

    await service.restore(PICKED, yes);
    expect(disk.files.has(kept)).toBe(true);
    await service.discardPrevious();
    expect(disk.files.has(kept)).toBe(false);
    expect(service.hasUndo()).toBe(false);
    expect(await service.undoRestore()).toBe(false);
  });

  it('clears what a killed app left behind at the next export or restore, but not the undo that is still on offer', async () => {
    disk.files.set(`${DOC}.restore/previous/assets/old/x.jpg`, 'LEFT');
    disk.files.set(`${DOC}.restore/staging/database/morph.db`, '{}');
    await service.exportAll();
    expect([...disk.files.keys()].filter((k) => k.startsWith(`${DOC}.restore/`))).toEqual([]);

    disk.addArchive();
    await service.restore(PICKED, yes);
    await service.exportAll();
    expect(disk.files.has(`${DOC}.restore/previous/assets/a1/photo.jpg`)).toBe(true);
  });

  it('never deletes or moves the archive the user picked, in any outcome', async () => {
    disk.addArchive();
    await service.restore(PICKED, yes);
    await service.undoRestore();
    disk.addArchive(PICKED, { db: { unbootable: true } });
    await service.restore(PICKED, yes);
    expect(disk.archives.has(PICKED)).toBe(true);
    expect(disk.removed.filter((u) => u === PICKED || PICKED.startsWith(u))).toEqual([]);
    expect(disk.calls.filter((c) => c.includes('content://'))).toEqual([]);
  });

  it('only one thing at a time', async () => {
    let release!: () => void;
    disk.gate = new Promise<void>((resolve) => (release = resolve));
    const first = service.exportAll();
    await new Promise((r) => setTimeout(r, 0));
    await service.exportAll();
    disk.addArchive();
    expect(await service.checkArchive(PICKED)).toBeNull();
    release();
    await first;
    expect(disk.calls.filter((c) => c === 'createArchive')).toHaveLength(1);
  });
});

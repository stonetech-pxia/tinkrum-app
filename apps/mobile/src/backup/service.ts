import { localDate } from '@morph/core';
import { create } from 'zustand';

import {
  buildManifest,
  checkLayout,
  DB_ENTRY,
  FILE_DIRS,
  MANIFEST_NAME,
  parseManifest,
  type BackupManifest,
} from './manifest';

// Overall export and restore pipeline (D-600). Native zip read/write, file system, database, and UI
// state reconstruction all come through BackupEnv (actual implementation in env.ts, replaced with
// mock in tests), so only rules reside here:
// - Export: take a consistent database copy using VACUUM INTO (including unwritten WAL entries),
// stream-write it along with user files into a zip stored in cache, let user choose destination
// (save to folder / share); delete cached file after user takes it (or dismisses).
// - Restore: check first (is zip, has manifest, correct directories, version not newer than this
// app, sufficient space), after user confirmation extract to Documents/.restore/staging/, check
// internal database (integrity, migration, has current version), proceed only if all checks pass:
// move old data entirely into .restore/previous/ (rename, do not copy), move new data in, reopen
// database, rebuild UI state and read back to confirm. If any step fails, move old data back. On
// success, keep old data until undo banner disappears, then delete; undo uses the same swap.
// Cancellation: allowed only during decompression and export file-writing phases (native stops at
// next data chunk, deletes unfinished files); directory switching steps are fast and cannot be
// cancelled.

export type BackupErrorKind =
  'notBackup' | 'damaged' | 'newer' | 'noSpace' | 'cancelled' | 'switchFailed' | 'failed';

export class BackupError extends Error {
  constructor(
    readonly kind: BackupErrorKind,
    readonly needed?: number,
  ) {
    super(kind);
  }
}

export interface ArchiveProgress {
  phase: 'write' | 'extract';
  done: number;
  total: number;
}

/** Parts used from MorphArchive native module (modules/morph-archive/index.ts). */
export interface ArchiveNative {
  scanTree(uris: readonly string[]): Promise<{ files: number; bytes: number }>;
  createArchive(
    dest: string,
    sources: readonly (
      | { dir: string; prefix: string }
      | { file: string; name: string }
      | { text: string; name: string }
    )[],
  ): Promise<{ entries: number; bytes: number }>;
  inspectArchive(
    src: string,
  ): Promise<{ entries: { name: string; size: number }[]; bytes: number; manifest: string | null }>;
  extractArchive(src: string, dest: string): Promise<{ files: number; bytes: number }>;
  moveTree(from: string, to: string): Promise<void>;
  removeTree(uri: string): Promise<void>;
  cancel(): void;
  onProgress(listener: (e: ArchiveProgress) => void): () => void;
}

export interface LiveDb {
  /** Save a consistent database copy to dest (file:// URI, file must not exist yet). */
  snapshotTo(dest: string): Promise<void>;
  info(): Promise<{ userVersion: number; schemaVersion: number | null; records: number }>;
}

export interface StagedDb {
  integrityOk(): Promise<boolean>;
  userVersion(): Promise<number>;
  /** Upgrade database schema to match this app version (invariant 12). */
  migrate(): Promise<void>;
  head(): Promise<{ id: number; schemaVersion: number } | null>;
  close(): Promise<void>;
}

export interface BackupEnv {
  native: ArchiveNative;
  fs: {
    exists(uri: string): boolean;
    makeDir(uri: string): void;
    size(uri: string): number;
    freeSpace(): number;
    removeFile(uri: string): void;
  };
  /** Both are file:// URIs ending with /. */
  roots: { documents: string; cache: string };
  db: {
    live: LiveDb;
    openStaged(dirUri: string): Promise<StagedDb>;
    /** Database version (user_version) and config version supported by this app. */
    maxUserVersion: number;
    maxSchemaVersion: number;
  };
  runtime: {
    /** Close active database (before directory switch). */
    release(): Promise<void>;
    /** Reopens database, rebuilds interface state, and reads back; throws if unable to read. expectHeadId: the version read back must be this one (ensuring no fallback to an older version due to unreadable data). */
    reload(expectHeadId?: number): Promise<void>;
    /** After restoration or undo completes: returns to home page, displaying a banner with "Undo" (for restoration) or a message (for undo / undo failure). */
    notify(kind: 'restored' | 'undone' | 'undoFailed'): void;
  };
  app: { version: string | null; platform: string };
  now(): Date;
}

export type BackupPhase = 'idle' | 'exporting' | 'exported' | 'checking' | 'restoring' | 'undoing';
export type BackupStep = 'prepare' | 'write' | 'unpack' | 'verify' | 'switch';

export interface BackupStatus {
  phase: BackupPhase;
  step: BackupStep | null;
  done: number;
  total: number;
  /** Export is ready, waiting for user to select a location. */
  exported: { uri: string; name: string; bytes: number } | null;
  /** Previous error encountered (cleared when starting the next operation). */
  error: { kind: BackupErrorKind; needed?: number } | null;
}

const IDLE: BackupStatus = {
  phase: 'idle',
  step: null,
  done: 0,
  total: 0,
  exported: null,
  error: null,
};

export const useBackupStatus = create<BackupStatus>()(() => IDLE);

export interface RestorePreview {
  manifest: BackupManifest;
  /** Total size in bytes after extraction. */
  bytes: number;
}

/** Reserved margin: extra space needed beyond extracted files for database upgrades and temporary files. */
const MARGIN = 64 * 1024 * 1024;
export const needSpace = (bytes: number) => bytes + Math.max(MARGIN, Math.floor(bytes * 0.02));

/** Directory swap manifest: database directory and four file directories. `staged` is the location inside the archive, `live` is the name in Documents. */
const ITEMS = [
  { live: 'SQLite', staged: 'database' },
  ...FILE_DIRS.map((d) => ({ live: d, staged: `files/${d}` })),
];

/** Maps native errors (with codes) to our error types. Unsafe names and unknown compression formats are treated as "not a backup". */
export function nativeToBackupError(e: unknown): BackupError {
  if (e instanceof BackupError) return e;
  const code =
    typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : '';
  switch (code) {
    case 'ERR_ARCHIVE_NOT_ZIP':
    case 'ERR_ARCHIVE_UNSAFE':
    case 'ERR_ARCHIVE_UNSUPPORTED':
      return new BackupError('notBackup');
    case 'ERR_ARCHIVE_DAMAGED':
      return new BackupError('damaged');
    case 'ERR_ARCHIVE_NO_SPACE':
      return new BackupError('noSpace');
    case 'ERR_ARCHIVE_CANCELLED':
      return new BackupError('cancelled');
    default:
      return new BackupError('failed');
  }
}

export function createBackupService(env: BackupEnv) {
  const set = (patch: Partial<BackupStatus>) => useBackupStatus.setState(patch);
  const scratch = `${env.roots.documents}.restore/`;
  const staging = `${scratch}staging/`;
  const previous = `${scratch}previous/`;
  const aside = `${scratch}discarded/`;
  const exportDir = `${env.roots.cache}backup-export/`;
  /** Data before restoration is still kept and undo prompt is still active (in memory only: retained state after app shutdown cannot be undone, cleared upon next export or restore). */
  let previousKept = false;
  let undoing = false;

  const busy = () => {
    const { phase } = useBackupStatus.getState();
    return phase !== 'idle' && phase !== 'exported';
  };

  function begin(phase: BackupPhase, step: BackupStep) {
    set({ ...IDLE, phase, step });
  }

  function fail(e: unknown): BackupError {
    const error = nativeToBackupError(e);
    set({
      ...IDLE,
      error: { kind: error.kind, ...(error.needed !== undefined ? { needed: error.needed } : {}) },
    });
    return error;
  }

  function track<T>(run: () => Promise<T>): Promise<T> {
    const off = env.native.onProgress((e) => set({ done: e.done, total: e.total }));
    return run().finally(off);
  }

  /** Cleans up temporary files left by restore and export (half-extracted, swapped-out items); discards pre-restoration data no longer needed for undo. */
  async function cleanupLeftovers() {
    await env.native.removeTree(staging);
    await env.native.removeTree(aside);
    if (!previousKept) await env.native.removeTree(previous);
    await env.native.removeTree(exportDir);
  }

  /** Pre-restoration data: deleted when the undo prompt disappears. Not modified while an undo is in progress. */
  async function discardPrevious() {
    if (!previousKept || undoing) return;
    previousKept = false;
    await env.native.removeTree(previous);
  }

  async function exportAll(): Promise<void> {
    if (busy()) return;
    begin('exporting', 'prepare');
    let snapshot: string | null = null;
    try {
      await cleanupLeftovers();
      env.fs.makeDir(exportDir);
      const info = await env.db.live.info();
      const dirs = FILE_DIRS.map((d) => ({ name: d, uri: `${env.roots.documents}${d}/` }));
      const scan = await env.native.scanTree(dirs.map((d) => d.uri));
      snapshot = `${exportDir}morph.db`;
      await env.db.live.snapshotTo(snapshot);
      // Worst-case scenario: user files entirely uncompressed, plus the database.
      const needed = needSpace(scan.bytes + env.fs.size(snapshot));
      if (env.fs.freeSpace() < needed) throw new BackupError('noSpace', needed);
      const now = env.now();
      const manifest = buildManifest({
        createdAt: now.getTime(),
        app: env.app,
        database: { userVersion: info.userVersion, schemaVersion: info.schemaVersion },
        contains: { records: info.records, files: scan.files, bytes: scan.bytes },
      });
      const name = `tinkrum-backup-${localDate(now)}.zip`;
      const dest = `${exportDir}${name}`;
      set({ step: 'write', done: 0, total: scan.bytes });
      const written = await track(() =>
        env.native.createArchive(dest, [
          { text: manifest, name: MANIFEST_NAME },
          { file: snapshot!, name: DB_ENTRY },
          ...dirs.map((d) => ({ dir: d.uri, prefix: `files/${d.name}` })),
        ]),
      );
      set({ ...IDLE, phase: 'exported', exported: { uri: dest, name, bytes: written.bytes } });
    } catch (e) {
      fail(e);
      await env.native.removeTree(exportDir);
    } finally {
      // Database copy is already in the archive and is not retained.
      if (snapshot && env.fs.exists(snapshot)) {
        try {
          env.fs.removeFile(snapshot);
        } catch {
          // Next export will clear the entire directory at the start.
        }
      }
    }
  }

  /** User took away or discarded the export: deletes the cached archive. */
  async function discardExport(): Promise<void> {
    if (useBackupStatus.getState().phase === 'exported') set({ ...IDLE });
    await env.native.removeTree(exportDir);
  }

  /** Checks if an archive can be restored (without modifying anything). Leaves reason in state on error and returns null. */
  async function checkArchive(uri: string): Promise<RestorePreview | null> {
    if (busy()) return null;
    begin('checking', 'prepare');
    try {
      const inspected = await env.native.inspectArchive(uri).catch((e: unknown) => {
        throw nativeToBackupError(e);
      });
      const parsed = parseManifest(inspected.manifest);
      if (!parsed.ok) throw new BackupError(parsed.problem);
      if (!checkLayout(inspected.entries)) throw new BackupError('notBackup');
      const m = parsed.manifest;
      if (
        m.database.userVersion > env.db.maxUserVersion ||
        (m.database.schemaVersion ?? 0) > env.db.maxSchemaVersion
      ) {
        throw new BackupError('newer');
      }
      const needed = needSpace(inspected.bytes);
      if (env.fs.freeSpace() < needed) throw new BackupError('noSpace', needed);
      set({ ...IDLE });
      return { manifest: m, bytes: inspected.bytes };
    } catch (e) {
      fail(e);
      return null;
    }
  }

  /**
   * Swaps data directories: moves items present in `live` to `setAside`, and items present in
   * `source` into `live`. Records each step to roll back in reverse order on error. All renames
   * within the same volume happen instantly.
   */
  async function exchange(source: (item: (typeof ITEMS)[number]) => string, setAside: string) {
    const done: { from: string; to: string }[] = [];
    const move = async (from: string, to: string) => {
      await env.native.moveTree(from, to);
      done.push({ from, to });
    };
    try {
      env.fs.makeDir(setAside);
      for (const item of ITEMS) {
        const live = `${env.roots.documents}${item.live}/`;
        if (env.fs.exists(live)) await move(live, `${setAside}${item.live}/`);
        const from = source(item);
        if (env.fs.exists(from)) await move(from, live);
      }
    } catch (e) {
      for (const step of done.reverse()) await env.native.moveTree(step.to, step.from);
      throw e;
    }
    return async () => {
      for (const step of [...done].reverse()) await env.native.moveTree(step.to, step.from);
    };
  }

  /** Reopens and reads back after swapping; rolls back the swap and reverts to the old data if reading back fails. */
  async function switchTo(
    source: (item: (typeof ITEMS)[number]) => string,
    setAside: string,
    expectHeadId?: number,
  ) {
    await env.runtime.release();
    let undo: (() => Promise<void>) | null = null;
    try {
      undo = await exchange(source, setAside);
      await env.runtime.reload(expectHeadId);
    } catch {
      try {
        if (undo) await undo();
      } finally {
        await env.runtime.reload().catch(() => undefined);
      }
      throw new BackupError('switchFailed');
    }
  }

  /**
   * Restore. confirm: prompts user after passing checks (shows date and count in description);
   * returns false to do nothing. Returns 'restored', 'declined' (user cancelled), or 'failed'
   * (reason in state).
   */
  async function restore(
    uri: string,
    confirm: (preview: RestorePreview) => Promise<boolean>,
  ): Promise<'restored' | 'declined' | 'failed'> {
    const preview = await checkArchive(uri);
    if (!preview) return 'failed';
    if (!(await confirm(preview))) return 'declined';
    begin('restoring', 'unpack');
    try {
      await cleanupLeftovers();
      // New restoration begins, making old data retained from the previous restoration no longer undoable.
      await discardPrevious();
      env.fs.makeDir(scratch);
      set({ total: preview.bytes });
      await track(() => env.native.extractArchive(uri, staging)).catch(async (e: unknown) => {
        await env.native.removeTree(staging);
        throw nativeToBackupError(e);
      });

      set({ step: 'verify', done: 0 });
      const staged = await env.db.openStaged(`${staging}database/`);
      let headId: number;
      try {
        if (!(await staged.integrityOk())) throw new BackupError('damaged');
        if ((await staged.userVersion()) > env.db.maxUserVersion) throw new BackupError('newer');
        await staged.migrate();
        const head = await staged.head();
        if (!head) throw new BackupError('notBackup');
        if (head.schemaVersion > env.db.maxSchemaVersion) throw new BackupError('newer');
        headId = head.id;
      } catch (e) {
        await staged.close().catch(() => undefined);
        await env.native.removeTree(staging);
        throw e;
      }
      await staged.close();

      set({ step: 'switch' });
      await switchTo((item) => `${staging}${item.staged}/`, previous, headId);
      previousKept = true;
      await env.native.removeTree(staging);
      set({ ...IDLE });
      env.runtime.notify('restored');
      return 'restored';
    } catch (e) {
      fail(e);
      // Extracted items are no longer needed (same for the backup copy moved back on swap failure).
      await env.native.removeTree(staging).catch(() => undefined);
      return 'failed';
    }
  }

  /** Undo restore: performs the same directory swap as restore to revert to pre-restoration data. Deletes the restored copy upon success. */
  async function undoRestore(): Promise<boolean> {
    if (!previousKept || busy()) return false;
    undoing = true;
    begin('undoing', 'switch');
    try {
      await env.native.removeTree(aside);
      await switchTo((item) => `${previous}${item.live}/`, aside);
      previousKept = false;
      await env.native.removeTree(aside);
      await env.native.removeTree(previous);
      set({ ...IDLE });
      env.runtime.notify('undone');
      return true;
    } catch (e) {
      fail(e);
      // The user performing undo is on the home page and cannot see error messages on the data page: shows a different hint message instead.
      env.runtime.notify('undoFailed');
      return false;
    } finally {
      undoing = false;
    }
  }

  /** Cancels the ongoing operation (only valid during cancellable stages). */
  function cancel() {
    const { phase, step } = useBackupStatus.getState();
    if (
      (phase === 'exporting' && step !== 'prepare') ||
      (phase === 'restoring' && step === 'unpack')
    ) {
      env.native.cancel();
    }
  }

  return {
    exportAll,
    discardExport,
    checkArchive,
    restore,
    undoRestore,
    discardPrevious,
    cancel,
    hasUndo: () => previousKept,
    dismissError: () => {
      if (useBackupStatus.getState().error) set({ error: null });
    },
  };
}

export type BackupService = ReturnType<typeof createBackupService>;

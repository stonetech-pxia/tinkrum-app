// Format of overall backup archive (D-600): standard zip containing a manifest
// (tinkrum-backup.json), database, and user files. Restore accepts only archives with this manifest
// and correct directory structure; if manifest version is newer than this app, reject and ask user
// to update app first.

export const BACKUP_FORMAT = 'tinkrum-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_NAME = 'tinkrum-backup.json';
/** Location of database (consistent copy created via VACUUM INTO) inside archive; restored to Documents/SQLite/morph.db. */
export const DB_ENTRY = 'database/morph.db';
/** Directories under files/ in archive, matching directory names under Documents. */
export const FILE_DIRS = ['assets', 'desk', 'signatures', 'tools'] as const;
export type FileDir = (typeof FILE_DIRS)[number];

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** Timestamp when backup was created (milliseconds). */
  createdAt: number;
  app: { version: string | null; platform: string };
  database: { userVersion: number; schemaVersion: number | null };
  /** Quantity for user display only; not used as checksum during restore (user files may still change during export). */
  contains: { records: number; files: number; bytes: number };
}

export function buildManifest(input: Omit<BackupManifest, 'format' | 'formatVersion'>): string {
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    ...input,
  };
  return JSON.stringify(manifest, null, 2);
}

export type ManifestResult =
  | { ok: true; manifest: BackupManifest }
  /** notBackup: not a Tinkrum backup; newer: is a backup, but created by a newer version. */
  | { ok: false; problem: 'notBackup' | 'newer' };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function parseManifest(text: string | null): ManifestResult {
  // Return null when native manifest is missing (or no such item).
  if (typeof text !== 'string') return { ok: false, problem: 'notBackup' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'notBackup' };
  }
  const o = raw as Partial<BackupManifest> | null;
  if (!o || typeof o !== 'object' || o.format !== BACKUP_FORMAT) {
    return { ok: false, problem: 'notBackup' };
  }
  if (!isCount(o.formatVersion) || o.formatVersion < 1) return { ok: false, problem: 'notBackup' };
  // Newer format: contents not recognized, reject first (remaining fields may no longer have this structure).
  if (o.formatVersion > BACKUP_FORMAT_VERSION) return { ok: false, problem: 'newer' };
  const db = o.database;
  const has = o.contains;
  if (
    !isCount(o.createdAt) ||
    !db ||
    !isCount(db.userVersion) ||
    !(db.schemaVersion === null || isCount(db.schemaVersion)) ||
    !has ||
    !isCount(has.records) ||
    !isCount(has.files) ||
    !isCount(has.bytes)
  ) {
    return { ok: false, problem: 'notBackup' };
  }
  const app = o.app;
  return {
    ok: true,
    manifest: {
      format: BACKUP_FORMAT,
      formatVersion: o.formatVersion,
      createdAt: o.createdAt,
      app: {
        version: typeof app?.version === 'string' ? app.version : null,
        platform: typeof app?.platform === 'string' ? app.platform : 'unknown',
      },
      database: { userVersion: db.userVersion, schemaVersion: db.schemaVersion },
      contains: { records: has.records, files: has.files, bytes: has.bytes },
    },
  };
}

/**
 * Archive may only contain: manifest, database, and files under files/<known_directory>/.
 * Anything else is not our backup (restore replaces everything completely, unrecognized items are
 * rejected). Database is mandatory.
 */
export function checkLayout(entries: readonly { name: string }[]): boolean {
  let database = 0;
  for (const { name } of entries) {
    if (name === MANIFEST_NAME) continue;
    if (name === DB_ENTRY) {
      database += 1;
      continue;
    }
    const m = /^files\/([^/]+)\/./.exec(name);
    if (!m || !(FILE_DIRS as readonly string[]).includes(m[1]!)) return false;
  }
  return database === 1;
}

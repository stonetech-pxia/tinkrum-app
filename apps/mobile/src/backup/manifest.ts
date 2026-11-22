// 整体备份压缩包的格式（D-600）：标准 zip，里面有一份说明（tinkrum-backup.json）、数据库、用户文件。
// 恢复只认带这份说明、目录结构也对得上的压缩包；说明里的版本比这个 App 新的，拒绝并请用户先更新 App。

export const BACKUP_FORMAT = 'tinkrum-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_NAME = 'tinkrum-backup.json';
/** 数据库（VACUUM INTO 出来的一致拷贝）在压缩包里的位置，恢复后是 Documents/SQLite/morph.db。 */
export const DB_ENTRY = 'database/morph.db';
/** 压缩包里 files/ 下的目录，名字和 Documents 下的目录一样。 */
export const FILE_DIRS = ['assets', 'desk', 'signatures', 'tools'] as const;
export type FileDir = (typeof FILE_DIRS)[number];

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** 做这份备份的时间（毫秒）。 */
  createdAt: number;
  app: { version: string | null; platform: string };
  database: { userVersion: number; schemaVersion: number | null };
  /** 只是给用户看的数量；恢复时不拿它当校验（导出过程中用户文件可能还在变）。 */
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
  /** notBackup：不是 Tinkrum 的备份；newer：是，但是更新的版本做的。 */
  | { ok: false; problem: 'notBackup' | 'newer' };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function parseManifest(text: string | null): ManifestResult {
  // 原生没有说明时给 null（或没有这一项）。
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
  // 更新的格式：不认识里面的东西，先拒绝（其余字段可能已经不是这个样子）。
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
 * 压缩包里只能有：说明、数据库、files/<已知目录>/ 下的文件。有别的就不是我们的备份（恢复会整个换掉，
 * 认不出去向的东西不收）。数据库必须有。
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

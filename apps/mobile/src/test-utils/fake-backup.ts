import { DB_ENTRY, FILE_DIRS, MANIFEST_NAME, buildManifest } from '../backup/manifest';
import type { ArchiveNative, ArchiveProgress, BackupEnv, StagedDb } from '../backup/service';

// 整体导出和恢复的替身环境（D-600）：一块内存里的「磁盘」、一个按原生模块的规则工作的 zip、两份数据库（正在用的、解开的）。
// 替身要像真的一样会出问题：目录改名会连里面的东西一起搬；删除只删前缀；压缩包有坏的、不是 zip 的、名字不安全的；
// 取消要在写到一半时生效；选择器给的压缩包在磁盘外面（原件），谁删它测试就报错。

export const DOC = 'file:///doc/';
export const CACHE = 'file:///cache/';
export const PICKED = 'content://com.android.providers.downloads.documents/document/42';

export interface DbState {
  userVersion: number;
  schemaVersion: number | null;
  records: number;
  /** 数据库里当前版本的编号。 */
  headId: number;
  /** 为 true：整个文件读不出来（完整性检查不过）。 */
  corrupt?: boolean;
  /** 为 true：打开时进入错误状态（重建界面时读不回来）。 */
  unbootable?: boolean;
}

export interface FakeArchive {
  /** 条目名 → 内容；content 为 null 的是不存在。 */
  entries: Record<string, string>;
  manifest: string | null;
  /** 让检查或解压抛出这个原生错误代码。 */
  error?: string;
}

export class FakeBackup {
  /** 磁盘上的文件：file:// 地址 → 内容。目录是前缀。 */
  files = new Map<string, string>();
  dirs = new Set<string>();
  archives = new Map<string, FakeArchive>();
  live: DbState = { userVersion: 5, schemaVersion: 39, records: 3, headId: 7 };
  free = 10 * 1024 ** 3;
  /** 压缩包解开后的总字节（给空间检查用）。 */
  archiveBytes = 1000;
  calls: string[] = [];
  /** 登记过的 removeTree，用来断言没删过选择器的压缩包。 */
  removed: string[] = [];
  /** 取消用：写和解压到这里停下，等测试放行。 */
  gate: Promise<void> | null = null;
  cancelled = false;
  failMoveAt: number | null = null;
  private moves = 0;
  listeners = new Set<(e: ArchiveProgress) => void>();
  notified: string[] = [];
  reloads: (number | undefined)[] = [];
  /** 当前「界面在用」的数据库状态（reload 时从磁盘读）。 */
  runtimeHead: number | null = null;
  migrated = 0;

  constructor() {
    // 正在用的数据：数据库目录和一个用户文件。
    this.files.set(`${DOC}SQLite/morph.db`, JSON.stringify(this.live));
    this.files.set(`${DOC}assets/a1/photo.jpg`, 'PHOTO');
    this.files.set(`${DOC}assets/a1/.thumb.jpg`, 'THUMB');
    this.files.set(`${DOC}desk/d1/doc.pdf`, 'PDF');
    this.files.set(`${DOC}tools/pack/manifest.json`, '{}');
    this.files.set(`${DOC}packs/model.bin`, 'BIG MODEL');
    this.runtimeHead = this.live.headId;
  }

  /** 做一份能恢复的压缩包（放在磁盘外面，像选择器给的原件）。 */
  addArchive(
    uri = PICKED,
    patch: {
      db?: Partial<DbState>;
      manifest?: Partial<Record<string, unknown>> | null;
      extra?: Record<string, string>;
      skipDb?: boolean;
      error?: string;
    } = {},
  ): FakeArchive {
    const db: DbState = { userVersion: 5, schemaVersion: 39, records: 9, headId: 21, ...patch.db };
    const text = buildManifest({
      createdAt: Date.UTC(2026, 10, 1, 9, 30),
      app: { version: '1.0.0', platform: 'ios' },
      database: { userVersion: db.userVersion, schemaVersion: db.schemaVersion },
      contains: { records: db.records, files: 2, bytes: 100 },
    });
    const manifest =
      patch.manifest === null
        ? null
        : patch.manifest
          ? JSON.stringify({ ...JSON.parse(text), ...patch.manifest })
          : text;
    const entries: Record<string, string> = {
      ...(manifest === null ? {} : { [MANIFEST_NAME]: manifest }),
      ...(patch.skipDb ? {} : { [DB_ENTRY]: JSON.stringify(db) }),
      'files/assets/b1/receipt.pdf': 'RECEIPT',
      'files/desk/e1/sheet.xlsx': 'SHEET',
      ...patch.extra,
    };
    const archive: FakeArchive = {
      entries,
      manifest,
      ...(patch.error ? { error: patch.error } : {}),
    };
    this.archives.set(uri, archive);
    return archive;
  }

  private under(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }

  exists = (uri: string) => this.dirs.has(uri) || this.files.has(uri) || this.under(uri).length > 0;

  private coded(code: string) {
    return Object.assign(new Error(code), { code });
  }

  native: ArchiveNative = {
    scanTree: async (uris) => {
      let files = 0;
      let bytes = 0;
      for (const uri of uris)
        for (const k of this.under(uri)) {
          files += 1;
          bytes += this.files.get(k)!.length;
        }
      return { files, bytes };
    },
    createArchive: async (dest, sources) => {
      this.calls.push('createArchive');
      const entries: Record<string, string> = {};
      for (const s of sources) {
        if ('text' in s) entries[s.name] = s.text;
        else if ('file' in s) entries[s.name] = this.files.get(s.file) ?? '';
        else
          for (const k of this.under(s.dir))
            entries[`${s.prefix}/${k.slice(s.dir.length)}`] = this.files.get(k)!;
      }
      for (const l of this.listeners) l({ phase: 'write', done: 1, total: 2 });
      if (this.gate) await this.gate;
      if (this.cancelled) throw this.coded('ERR_ARCHIVE_CANCELLED');
      this.files.set(dest, 'ZIP');
      this.archives.set(dest, { entries, manifest: entries[MANIFEST_NAME] ?? null });
      return { entries: Object.keys(entries).length, bytes: 123456 };
    },
    inspectArchive: async (src) => {
      const a = this.archives.get(src);
      if (!a) throw this.coded('ERR_ARCHIVE_NOT_ZIP');
      if (a.error) throw this.coded(a.error);
      return {
        entries: Object.entries(a.entries).map(([name, c]) => ({ name, size: c.length })),
        bytes: this.archiveBytes,
        manifest: a.manifest,
      };
    },
    extractArchive: async (src, dest) => {
      this.calls.push('extractArchive');
      const a = this.archives.get(src);
      if (!a) throw this.coded('ERR_ARCHIVE_NOT_ZIP');
      for (const l of this.listeners) l({ phase: 'extract', done: 1, total: 2 });
      if (this.gate) await this.gate;
      if (this.cancelled) {
        throw this.coded('ERR_ARCHIVE_CANCELLED');
      }
      if (a.error) throw this.coded(a.error);
      for (const [name, c] of Object.entries(a.entries)) this.files.set(`${dest}${name}`, c);
      return { files: Object.keys(a.entries).length, bytes: this.archiveBytes };
    },
    moveTree: async (from, to) => {
      this.moves += 1;
      this.calls.push(`move ${from.replace(DOC, '')} -> ${to.replace(DOC, '')}`);
      if (this.failMoveAt !== null && this.moves === this.failMoveAt) {
        throw this.coded('ERR_ARCHIVE_IO');
      }
      if (this.exists(to)) throw this.coded('ERR_ARCHIVE_IO');
      for (const k of this.under(from)) {
        this.files.set(to + k.slice(from.length), this.files.get(k)!);
        this.files.delete(k);
      }
    },
    removeTree: async (uri) => {
      // 选择器给的压缩包是用户的原件（在磁盘外面）：谁也不能删。
      if (this.archives.has(uri) && !uri.startsWith(DOC) && !uri.startsWith(CACHE)) {
        throw new Error(`removed the user's archive: ${uri}`);
      }
      this.removed.push(uri);
      for (const k of this.under(uri)) this.files.delete(k);
      for (const d of [...this.dirs]) if (d.startsWith(uri)) this.dirs.delete(d);
    },
    cancel: () => {
      this.calls.push('cancel');
      this.cancelled = true;
    },
    onProgress: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  private staged(dirUri: string): StagedDb {
    const read = (): DbState | null => {
      const text = this.files.get(`${dirUri}morph.db`);
      if (!text) return null;
      try {
        return JSON.parse(text) as DbState;
      } catch {
        return null;
      }
    };
    return {
      integrityOk: async () => {
        const s = read();
        return !!s && !s.corrupt;
      },
      userVersion: async () => read()?.userVersion ?? 0,
      migrate: async () => {
        this.migrated += 1;
      },
      head: async () => {
        const s = read();
        return s && s.schemaVersion !== null
          ? { id: s.headId, schemaVersion: s.schemaVersion }
          : null;
      },
      close: async () => undefined,
    };
  }

  env(over: Partial<{ maxUserVersion: number; maxSchemaVersion: number }> = {}): BackupEnv {
    return {
      native: this.native,
      fs: {
        exists: this.exists,
        makeDir: (uri) => this.dirs.add(uri),
        size: (uri) => this.files.get(uri)?.length ?? 0,
        freeSpace: () => this.free,
        removeFile: (uri) => void this.files.delete(uri),
      },
      roots: { documents: DOC, cache: CACHE },
      db: {
        live: {
          snapshotTo: async (dest) => {
            this.calls.push('snapshot');
            // 一致的拷贝：此刻数据库里的东西。
            this.files.set(dest, this.files.get(`${DOC}SQLite/morph.db`) ?? '{}');
          },
          info: async () => {
            const s = JSON.parse(this.files.get(`${DOC}SQLite/morph.db`) ?? '{}') as DbState;
            return {
              userVersion: s.userVersion,
              schemaVersion: s.schemaVersion,
              records: s.records,
            };
          },
        },
        openStaged: async (dir) => this.staged(dir),
        maxUserVersion: over.maxUserVersion ?? 5,
        maxSchemaVersion: over.maxSchemaVersion ?? 39,
      },
      runtime: {
        release: async () => {
          this.calls.push('release');
          this.runtimeHead = null;
        },
        reload: async (expectHeadId) => {
          this.calls.push('reload');
          this.reloads.push(expectHeadId);
          const text = this.files.get(`${DOC}SQLite/morph.db`);
          const s = text ? (JSON.parse(text) as DbState) : null;
          if (!s || s.unbootable) throw new Error('cannot boot');
          if (expectHeadId !== undefined && s.headId !== expectHeadId) throw new Error('fell back');
          this.runtimeHead = s.headId;
        },
        notify: (kind) => void this.notified.push(kind),
      },
      app: { version: '1.0.0', platform: 'ios' },
      now: () => new Date(2026, 10, 20, 12, 0),
    };
  }

  /** 磁盘上 Documents 里除了 .restore 之外的全部东西（用来断言「什么都没变」）。 */
  snapshotLive(): Record<string, string> {
    return Object.fromEntries(
      [...this.files].filter(([k]) => k.startsWith(DOC) && !k.startsWith(`${DOC}.restore/`)),
    );
  }
}

export const FILE_DIR_NAMES = FILE_DIRS;

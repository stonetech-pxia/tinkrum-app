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

// 整体导出和恢复的流程（D-600）。原生的 zip 读写、文件系统、数据库、重建界面状态都从 BackupEnv 进来
// （真的实现在 env.ts，测试里换成替身），所以这里只有规则：
// - 导出：数据库用 VACUUM INTO 取一份一致的拷贝（WAL 里没写回的也在内），和用户文件一起流式写成一个 zip，放在缓存里，
//   交给用户选地方（保存到文件夹 / 分享）；用户拿走（或关掉）后删掉缓存里的这份。
// - 恢复：先检查（是 zip、有说明、目录对、版本不比这个 App 新、空间够），用户确认后解到 Documents/.restore/staging/，
//   再检查里面的数据库（完整性、升级、有当前版本），全部通过才动手：旧数据整个挪进 .restore/previous/（改名，不复制），
//   新数据挪进去，重开数据库、重建界面状态并读回来确认。任何一步出错都把旧数据挪回来。成功后旧数据留着，
//   直到撤销提示不再出现，再删掉；撤销是同样的对换。
// 取消：只在解压和导出的写文件阶段可以取消（原生在下一块数据处停下，删掉没写完的文件）；换目录的几步很快，不能取消。

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

/** 原生模块 MorphArchive 里用到的部分（modules/morph-archive/index.ts）。 */
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
  /** 把数据库存成一份一致的拷贝到 dest（file:// 地址，文件必须还不存在）。 */
  snapshotTo(dest: string): Promise<void>;
  info(): Promise<{ userVersion: number; schemaVersion: number | null; records: number }>;
}

export interface StagedDb {
  integrityOk(): Promise<boolean>;
  userVersion(): Promise<number>;
  /** 把数据库结构升级到这个 App 的版本（底线 12）。 */
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
  /** 都是 file:// 地址，结尾带 /。 */
  roots: { documents: string; cache: string };
  db: {
    live: LiveDb;
    openStaged(dirUri: string): Promise<StagedDb>;
    /** 这个 App 能打开的数据库版本（user_version）和配置版本。 */
    maxUserVersion: number;
    maxSchemaVersion: number;
  };
  runtime: {
    /** 关掉正在用的数据库（换目录之前）。 */
    release(): Promise<void>;
    /** 重开数据库、重建界面状态并读回来；读不回来就抛错。expectHeadId：读出来的当前版本必须是这个（没有因为读不懂退回旧版本）。 */
    reload(expectHeadId?: number): Promise<void>;
    /** 恢复或撤销做完之后：回到主页，显示带「撤销」的提示（恢复）或一句话（撤销，撤销失败）。 */
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
  /** 导出做好了、等用户选地方。 */
  exported: { uri: string; name: string; bytes: number } | null;
  /** 上一次出的问题（开始下一次时清掉）。 */
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
  /** 解开后一共多少字节。 */
  bytes: number;
}

/** 留出的余量：解开的东西之外，数据库升级、临时文件还要一点。 */
const MARGIN = 64 * 1024 * 1024;
export const needSpace = (bytes: number) => bytes + Math.max(MARGIN, Math.floor(bytes * 0.02));

/** 换目录的清单：数据库目录和四个文件目录。staged 是在压缩包里的位置，live 是在 Documents 里的名字。 */
const ITEMS = [
  { live: 'SQLite', staged: 'database' },
  ...FILE_DIRS.map((d) => ({ live: d, staged: `files/${d}` })),
];

/** 原生错误（带 code）换成我们的种类。名字不安全、不认识的压缩方式都算「不是备份」。 */
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
  /** 恢复之前的数据还留着、撤销提示还在（只在内存里：App 被关掉后留下的没有撤销可用，下次导出或恢复时清掉）。 */
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

  /** 恢复和导出留下的临时东西（解开一半的、对换下来的）；撤销已经用不上的恢复前数据。 */
  async function cleanupLeftovers() {
    await env.native.removeTree(staging);
    await env.native.removeTree(aside);
    if (!previousKept) await env.native.removeTree(previous);
    await env.native.removeTree(exportDir);
  }

  /** 恢复之前的数据：撤销提示不再出现时删掉。撤销进行中不动。 */
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
      // 最坏的情况：用户文件一点没压缩，再加数据库。
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
      // 数据库的拷贝已经在压缩包里了，不留着。
      if (snapshot && env.fs.exists(snapshot)) {
        try {
          env.fs.removeFile(snapshot);
        } catch {
          // 下次导出开头会清掉整个目录。
        }
      }
    }
  }

  /** 用户拿走了（或不要了）：删掉缓存里的压缩包。 */
  async function discardExport(): Promise<void> {
    if (useBackupStatus.getState().phase === 'exported') set({ ...IDLE });
    await env.native.removeTree(exportDir);
  }

  /** 检查压缩包能不能恢复（不改任何东西）。出问题时状态里留下原因，返回 null。 */
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
   * 对换数据目录：live 里有的挪到 setAside，source 里有的挪进 live。每一步都记下，出错时倒着挪回去。
   * 都是同一个卷里的改名，瞬间完成。
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

  /** 换完之后重开读回来；读不回来就把换的退回去，再读回旧的。 */
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
   * 恢复。confirm：检查通过后问用户（说明里的日期和数量）；返回 false 就什么都不做。
   * 返回 'restored'、'declined'（用户没确认）或 'failed'（原因在状态里）。
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
      // 新的恢复开始，上一次恢复留着的旧数据不再能撤销。
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
      // 解开的东西不再有用（换失败时挪回来的那份也一样）。
      await env.native.removeTree(staging).catch(() => undefined);
      return 'failed';
    }
  }

  /** 撤销恢复：和恢复同样的对换，换回恢复之前的数据。成功后恢复进来的那份删掉。 */
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
      // 撤销的人在主页，看不到数据页上的出错说明：换一句提示告诉他。
      env.runtime.notify('undoFailed');
      return false;
    } finally {
      undoing = false;
    }
  }

  /** 取消正在做的事（只在能取消的阶段有用）。 */
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

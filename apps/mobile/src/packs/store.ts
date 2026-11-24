import { packById, packFileUrl, type PackManifest } from '@morph/core';

// Extension pack download, validation, storage, and deletion (D-064, TOOLS_DESIGN §6). Stored in
// documentDirectory/packs/<id>/<version>/, excluded from backups so rollbacks are unaffected;
// ready.json is written last to mark installation complete, preventing interrupted downloads from
// being treated as installed. File system and hashes are injected by the App, using an in-memory
// implementation in tests. Packs bundled with the App (D-510) are considered installed: copied from
// the App upon first use (offline), validating size and SHA-256 just like downloads.

export interface PackFs {
  /** Downloads to a relative path under the packs directory, returning the downloaded bytes. */
  download(url: string, path: string): Promise<Uint8Array>;
  /**
   * Large files (speech models of tens to hundreds of MB): downloads to disk, computing SHA-256
   * on the fly in native code without reading into JS memory; onBytes reports downloaded bytes.
   * Falls back to download when unavailable (Expo Go, tests).
   */
  downloadLarge?(
    url: string,
    path: string,
    onBytes: (bytes: number) => void,
  ): Promise<{ size: number; sha256: string }>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  /** Deletes a file or an entire directory (does nothing if it does not exist). */
  remove(path: string): Promise<void>;
  /** Subdirectory names under a directory. */
  listDirs(path: string): Promise<string[]>;
  /** Absolute URL of a file (for WebView reading). */
  uri(path: string): string;
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * Packs bundled with the App (D-510): the packs/ directory inside the App, structured
   * identically (<id>/<version>/<file>), read-only. Returns subdirectory names under this
   * directory in the App; empty if not bundled (dev builds, Expo Go, tests).
   */
  bundledDirs?(path: string): Promise<string[]>;
  /** Copies the file at the same relative path from the App to here, returning the copied size and SHA-256 (computed on the fly by native code). */
  copyBundled?(path: string): Promise<{ size: number; sha256: string }>;
}

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

export class PackError extends Error {
  constructor(
    readonly code: 'unknown' | 'download' | 'hash' | 'size',
    readonly file?: string,
  ) {
    super(file ? `${code}: ${file}` : code);
  }
}

export interface InstalledPack {
  id: string;
  version: string;
  bytes: number;
  installedAt: number;
  /** Copied from the App (D-510), not downloaded. */
  bundled?: true;
}

export interface PackProgress {
  packId: string;
  doneBytes: number;
  totalBytes: number;
}

const dirOf = (pack: PackManifest) => `${pack.id}/${pack.version}`;

/** Number of files downloaded concurrently. */
const PARALLEL = 6;

/** Files exceeding this size use downloadLarge. */
export const LARGE_FILE = 32 * 1024 * 1024;

export class PackStore {
  constructor(
    private readonly fs: PackFs,
    private readonly sha256: Sha256,
    /** Manifest lookup (replaced with test manifest in tests). */
    private readonly lookup: (id: string) => PackManifest | undefined = packById,
    private readonly now: () => number = Date.now,
    /** Packs whose hosting URL is not yet determined are downloaded from here (EXPO_PUBLIC_MORPH_PACKS_URL, D-274). */
    private readonly packsUrl?: string,
  ) {}

  private readonly listeners = new Set<() => void>();

  /** Notifies when an extension pack is installed or deleted (updates the "download required" prompt in the UI, D-456). Returns unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Contents of ready.json; if missing or unreadable (process killed mid-write), treated as not
   * properly installed, reinstalling normally when next used so a bad manifest in one pack does
   * not break the entire installed list.
   */
  private async readyInfo(
    pack: PackManifest,
  ): Promise<{ bytes: number; installedAt: number; bundled?: boolean } | null> {
    const path = `${dirOf(pack)}/ready.json`;
    if (!(await this.fs.exists(path))) return null;
    try {
      const ready: unknown = JSON.parse(await this.fs.readText(path));
      if (
        !ready ||
        typeof ready !== 'object' ||
        typeof (ready as { bytes?: unknown }).bytes !== 'number' ||
        typeof (ready as { installedAt?: unknown }).installedAt !== 'number'
      )
        return null;
      return ready as { bytes: number; installedAt: number; bundled?: boolean };
    } catch {
      return null;
    }
  }

  private async ready(pack: PackManifest): Promise<boolean> {
    return (await this.readyInfo(pack)) !== null;
  }

  /** App includes this version from the manifest (D-510); if the manifest has a newer version while the App has an older one, downloads normally. */
  private async bundled(pack: PackManifest): Promise<boolean> {
    if (!this.fs.copyBundled) return false;
    return ((await this.fs.bundledDirs?.(pack.id)) ?? []).includes(pack.version);
  }

  /** Installed, or bundled with the App (in which case copied from the App first, D-510; treated as uninstalled if copy fails). */
  async isInstalled(id: string): Promise<boolean> {
    const pack = this.lookup(id);
    if (!pack) return false;
    if (await this.ready(pack)) return true;
    if (!(await this.bundled(pack))) return false;
    try {
      await this.install(id, undefined, true);
      return true;
    } catch {
      return false;
    }
  }

  /** Installed extension packs (only counting versions in the current manifest; old version directories are deleted when installing a new version), including those bundled with the App (D-510). */
  async installed(): Promise<InstalledPack[]> {
    const out: InstalledPack[] = [];
    const ids = new Set([
      ...(await this.fs.listDirs('')),
      ...((await this.fs.bundledDirs?.('')) ?? []),
    ]);
    for (const id of ids) {
      const pack = this.lookup(id);
      if (!pack || !(await this.isInstalled(id))) continue;
      const ready = await this.readyInfo(pack);
      if (!ready) continue;
      out.push({
        id,
        version: pack.version,
        bytes: ready.bytes,
        installedAt: ready.installedAt,
        ...(ready.bundled ? { bundled: true as const } : {}),
      });
    }
    return out;
  }

  /**
   * Downloads and validates an extension pack (along with its dependent packs). Can only be
   * called after user confirmation in the UI (D-064). Bundled packs are copied from the App first
   * (D-510); downloaded only if the copied files are invalid. appOnly: copies from App only, does
   * not download (used by isInstalled, without user confirmation). If any file's size or SHA-256
   * is incorrect, deletes this version directory and throws an error.
   */
  install(id: string, onProgress?: (p: PackProgress) => void, appOnly = false): Promise<void> {
    // Prevents starting a second download while the same pack is downloading (e.g. clicking
    // "Download in background" while requesting the same pack elsewhere): the second call deletes
    // the half-downloaded directory of the first. Subsequent calls track progress, treating it as a
    // single download session.
    const running = this.installing.get(id);
    if (running) {
      if (onProgress) running.watchers.add(onProgress);
      return running.done;
    }
    const watchers = new Set<(p: PackProgress) => void>();
    if (onProgress) watchers.add(onProgress);
    const done = this.installNow(id, (p) => watchers.forEach((w) => w(p)), appOnly).finally(() =>
      this.installing.delete(id),
    );
    this.installing.set(id, { done, watchers });
    return done;
  }

  private readonly installing = new Map<
    string,
    { done: Promise<void>; watchers: Set<(p: PackProgress) => void> }
  >();

  private readonly backgroundListeners = new Set<(e: { ids: string[]; ok: boolean }) => void>();

  /** Notifies when a download started via "Download in background" finishes (success or failure). Returns unsubscribe function. */
  onBackgroundEnd(listener: (e: { ids: string[]; ok: boolean }) => void): () => void {
    this.backgroundListeners.add(listener);
    return () => void this.backgroundListeners.delete(listener);
  }

  finishedInBackground(ids: string[], ok: boolean) {
    for (const listener of [...this.backgroundListeners]) listener({ ids, ok });
  }

  private async installNow(
    id: string,
    onProgress: ((p: PackProgress) => void) | undefined,
    appOnly: boolean,
  ): Promise<void> {
    const pack = this.lookup(id);
    if (!pack) throw new PackError('unknown', id);
    for (const dep of pack.requires ?? []) {
      if (!(await this.isInstalled(dep))) await this.install(dep, onProgress, appOnly);
    }
    if (await this.ready(pack)) return;
    // Bundled with the App (D-510): copied from the App, offline; validation is identical to downloads.
    if (await this.bundled(pack)) {
      try {
        return await this.put(pack, true, onProgress);
      } catch (e) {
        // Copied files are invalid: user-confirmed downloads proceed to download anyway, unconfirmed ones do not.
        if (appOnly) throw e;
      }
    } else if (appOnly) {
      throw new PackError('download', id);
    }
    await this.put(pack, false, onProgress);
  }

  /** Places all files of an extension pack (copied from App or downloaded), validates them individually, and finally writes ready.json. */
  private async put(
    pack: PackManifest,
    fromApp: boolean,
    onProgress?: (p: PackProgress) => void,
  ): Promise<void> {
    const id = pack.id;
    const dir = dirOf(pack);
    // Deletes other versions of the same extension pack (older versions or interrupted downloads) first.
    await this.fs.remove(pack.id);
    const total = pack.files.reduce((sum, f) => sum + f.size, 0);
    let done = 0;
    onProgress?.({ packId: id, doneBytes: 0, totalBytes: total });
    try {
      // Downloads several files concurrently (pdf.js has over a hundred small cmap files; downloading them one by one is too slow).
      const queue = [...pack.files];
      const worker = async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          const path = `${dir}/${file.path}`;
          const url = fromApp ? null : packFileUrl(file, this.packsUrl);
          if (!fromApp && !url) throw new PackError('download', file.path);
          let got: { size: number; sha256: string | null; bytes?: Uint8Array };
          try {
            if (fromApp) {
              got = await this.fs.copyBundled!(path);
            } else if (file.size > LARGE_FILE && this.fs.downloadLarge) {
              got = await this.fs.downloadLarge(url!, path, (bytes) =>
                onProgress?.({
                  packId: id,
                  doneBytes: done + Math.min(bytes, file.size),
                  totalBytes: total,
                }),
              );
            } else {
              const bytes = await this.fs.download(url!, path);
              got = { size: bytes.length, sha256: null, bytes };
            }
          } catch {
            throw new PackError('download', file.path);
          }
          if (got.size !== file.size) throw new PackError('size', file.path);
          const hash = got.sha256 ?? (await this.sha256(got.bytes!));
          if (hash !== file.sha256) throw new PackError('hash', file.path);
          done += file.size;
          onProgress?.({ packId: id, doneBytes: done, totalBytes: total });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, pack.files.length) }, worker));
    } catch (e) {
      await this.fs.remove(pack.id);
      throw e;
    }
    await this.fs.writeText(
      `${dir}/ready.json`,
      JSON.stringify({
        id,
        version: pack.version,
        bytes: total,
        installedAt: this.now(),
        ...(fromApp ? { bundled: true } : {}),
      }),
    );
    this.changed();
  }

  /** Deletes an extension pack; when deleting the OCR pack, also deletes its language packs (which cannot function without the OCR pack). */
  async remove(id: string): Promise<void> {
    await this.fs.remove(id);
    const dependents = (await this.fs.listDirs('')).filter((d) =>
      (this.lookup(d)?.requires ?? []).includes(id),
    );
    for (const d of dependents) await this.fs.remove(d);
    this.changed();
  }

  /** Path to a file within an installed extension pack. */
  path(id: string, file: string): string {
    const pack = this.lookup(id);
    if (!pack) throw new PackError('unknown', id);
    return `${dirOf(pack)}/${file}`;
  }

  readText(id: string, file: string): Promise<string> {
    return this.fs.readText(this.path(id, file));
  }

  readBytes(id: string, file: string): Promise<Uint8Array> {
    return this.fs.readBytes(this.path(id, file));
  }
}

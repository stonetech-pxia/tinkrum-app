import { packById } from '@morph/core';

// Communication channel between App and pack pages (WebView) (D-074). Pages can only access two
// types of files: files listed in the installed pack manifest and files explicitly passed in the
// current call. Message format is fixed; the App sends only action names, our own parameters, and
// file contents, never injecting code.

export type PackPageId = 'pdfview' | 'scan' | 'ocr';

/** File reading capability (implemented via expo-file-system in the App). */
export interface BridgeFiles {
  /** Read files inside installed packs as text or base64. */
  packFile(pack: string, path: string, as: 'text' | 'base64'): Promise<string>;
  isInstalled(pack: string): Promise<boolean>;
  /** Read temporary files of the current run as base64. */
  runFile(uri: string): Promise<string>;
}

export interface PackRuntime {
  /** Invoke a handler function inside a pack page; files are those permitted for the page to read in this call (name → URI). */
  call<T>(
    page: PackPageId,
    method: string,
    args: Record<string, unknown>,
    files?: Record<string, string>,
  ): Promise<T>;
}

interface Poster {
  postMessage(message: string): void;
}

const CHUNK = 512 * 1024;
const READY_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; page?: PackPageId };

export class PackBridge implements PackRuntime {
  private webviews = new Map<PackPageId, Poster>();
  private readyWaiters = new Map<PackPageId, Pending[]>();
  private readyPages = new Set<PackPageId>();
  private pending = new Map<number, Pending>();
  private allowed = new Map<string, string>();
  private nextId = 0;
  private active: PackPageId[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly files: BridgeFiles) {}

  // ---- For host components ----
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  activePages = () => this.active;
  attach(page: PackPageId, webview: Poster | null) {
    if (webview) this.webviews.set(page, webview);
    else {
      this.webviews.delete(page);
      // During re-rendering, React first uses null, then invokes with the same WebView: if the page
      // is still in use, it's not considered disconnected, otherwise subsequent calls wait for a
      // ready state that never arrives. Considered truly unmounted only after the page is removed
      // from use (close).
      if (!this.active.includes(page)) this.readyPages.delete(page);
    }
  }

  /** Messages sent from the page. */
  async onMessage(page: PackPageId, data: string): Promise<void> {
    let m: {
      t?: string;
      id?: number;
      ok?: boolean;
      value?: unknown;
      error?: string;
      ref?: Ref;
      as?: string;
    };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === 'log') {
      // Errors within pages are written only to dev logs (content consists of errors thrown by our own page code, excluding file contents).
      if (__DEV__) console.warn(`[pack:${page}]`, (m as { message?: string }).message);
      return;
    }
    if (m.t === 'ready') {
      if (__DEV__) console.log(`[pack:${page}] ready`);
      this.readyPages.add(page);
      for (const w of this.readyWaiters.get(page) ?? []) w.resolve(undefined);
      this.readyWaiters.delete(page);
    } else if (m.t === 'result' && typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.ok) p?.resolve(m.value);
      else {
        if (__DEV__) console.warn(`[pack:${page}] call failed`, m.error);
        p?.reject(new Error(m.error ?? 'failed'));
      }
    } else if (m.t === 'need' && typeof m.id === 'number' && m.ref) {
      await this.serve(page, m.id, m.ref, m.as === 'bytes' ? 'bytes' : 'text');
    }
  }

  async call<T>(
    page: PackPageId,
    method: string,
    args: Record<string, unknown>,
    files: Record<string, string> = {},
  ): Promise<T> {
    await this.open(page);
    for (const [name, uri] of Object.entries(files)) this.allowed.set(name, uri);
    const id = ++this.nextId;
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('timeout'));
        }, CALL_TIMEOUT_MS);
        this.pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v as T)),
          reject: (e) => (clearTimeout(timer), reject(e)),
          page,
        });
        this.post(page, { t: 'call', id, method, args });
      });
    } finally {
      for (const name of Object.keys(files)) this.allowed.delete(name);
    }
  }

  /**
   * Page web process terminated by the system (occurs during iOS low memory pressure): pending
   * calls fail immediately without waiting for timeout; page is unmounted and remounted on next
   * call.
   */
  processGone(page: PackPageId) {
    this.readyPages.delete(page);
    for (const [id, p] of this.pending) {
      if (p.page !== page) continue;
      this.pending.delete(id);
      p.reject(new Error('page stopped'));
    }
    this.close(page);
  }

  /** Close page to release memory (e.g., after leaving the run page). */
  close(page: PackPageId) {
    this.active = this.active.filter((p) => p !== page);
    this.emit();
  }

  private async open(page: PackPageId) {
    if (this.readyPages.has(page)) return;
    if (!this.active.includes(page)) {
      this.active = [...this.active, page];
      this.emit();
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('page did not start')), READY_TIMEOUT_MS);
      const list = this.readyWaiters.get(page) ?? [];
      list.push({ resolve: () => (clearTimeout(timer), resolve()), reject });
      this.readyWaiters.set(page, list);
    });
  }

  private async serve(page: PackPageId, id: number, ref: Ref, as: 'text' | 'bytes') {
    if (__DEV__) console.log(`[pack:${page}] need`, 'pack' in ref ? ref.path : 'input file');
    try {
      let data: string;
      if ('pack' in ref) {
        // Only manifest-listed files are permitted, and the pack must be installed (hash verified).
        const pack = packById(ref.pack);
        if (!pack || !pack.files.some((f) => f.path === ref.path)) throw new Error('not allowed');
        if (!(await this.files.isInstalled(ref.pack))) throw new Error('pack not installed');
        data = await this.files.packFile(ref.pack, ref.path, as === 'bytes' ? 'base64' : 'text');
      } else {
        const uri = this.allowed.get(ref.file);
        if (!uri) throw new Error('not allowed');
        data = await this.files.runFile(uri);
      }
      const n = Math.max(1, Math.ceil(data.length / CHUNK));
      for (let i = 0; i < n; i++) {
        this.post(page, { t: 'chunk', id, i, n, data: data.slice(i * CHUNK, (i + 1) * CHUNK) });
      }
    } catch (e) {
      if (__DEV__) console.warn(`[pack:${page}] serve failed`, String(e));
      this.post(page, { t: 'chunk', id, error: String(e instanceof Error ? e.message : e) });
    }
  }

  private post(page: PackPageId, message: unknown) {
    this.webviews.get(page)?.postMessage(JSON.stringify(message));
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

type Ref = { pack: string; path: string } | { file: string };

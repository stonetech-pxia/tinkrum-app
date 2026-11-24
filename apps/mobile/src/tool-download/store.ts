import {
  ToolDownloadError,
  compareVersions,
  decodeUtf8,
  parseToolManifest,
  toolManifestUrl,
  verifyCatalog,
  HOST_API,
  type Catalog,
  type CatalogEntry,
  type Registry,
  type ToolManifest,
} from '@morph/core';

// Downloaded tools (D-177, D-178, docs/TOOL_DOWNLOAD_DESIGN.md §4, §5): directories and manifests
// are stored in documentDirectory/tools/. catalog.json + catalog.sig (last verified catalog,
// signature re-verified on every read), <id>/<version>/manifest.json (verified manifest; download
// is complete only when ready.json is written). File system, hashing, and networking are injected
// by the app, with in-memory implementations used in tests.

export interface ToolFs {
  /** Reads a file from the network (without writing to disk). */
  fetch(url: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  listDirs(path: string): Promise<string[]>;
}

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

export interface DownloadedTool {
  manifest: ToolManifest;
  bytes: number;
  downloadedAt: number;
}

// Hermes has TextEncoder but not necessarily TextDecoder: decoding uses core's decodeUtf8.
const encoder = new TextEncoder();

export class ToolDownloadStore {
  constructor(
    private readonly fs: ToolFs,
    private readonly sha256: Sha256,
    private readonly options: {
      /** Base URL containing the catalog (excluding catalog.json). */
      baseUrl: string;
      trustedKeys: readonly string[];
      now?: () => number;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Last verified catalog; returns null if missing or if the signature is invalid (tampered with). */
  async cachedCatalog(): Promise<{ catalog: Catalog; checkedAt: number } | null> {
    if (!(await this.fs.exists('catalog.json')) || !(await this.fs.exists('catalog.sig'))) {
      return null;
    }
    try {
      const sig = JSON.parse(await this.fs.readText('catalog.sig')) as {
        signature: string;
        checkedAt: number;
      };
      const catalog = verifyCatalog(
        encoder.encode(await this.fs.readText('catalog.json')),
        sig.signature,
        this.options.trustedKeys,
      );
      return { catalog, checkedAt: sig.checkedAt };
    } catch {
      return null;
    }
  }

  /** Fetches the catalog from the server and verifies its signature; rejects if older than the previously seen version (prevents rolling back revocations with an old catalog). */
  async refreshCatalog(): Promise<Catalog> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    let data: Uint8Array;
    let signature: string;
    try {
      [data, signature] = await Promise.all([
        this.fs.fetch(`${base}/catalog.json`),
        this.fs.fetch(`${base}/catalog.sig`).then((b) => decodeUtf8(b)),
      ]);
    } catch {
      throw new ToolDownloadError('download', 'catalog');
    }
    const previous = await this.cachedCatalog();
    const catalog = verifyCatalog(
      data,
      signature,
      this.options.trustedKeys,
      previous?.catalog.seq ?? 0,
    );
    await this.fs.writeText('catalog.json', decodeUtf8(data));
    await this.fs.writeText(
      'catalog.sig',
      JSON.stringify({ signature: signature.trim(), checkedAt: this.now() }),
    );
    return catalog;
  }

  /** Locally downloaded tools (one version each). Skips any that cannot be read. */
  async downloaded(): Promise<DownloadedTool[]> {
    const out: DownloadedTool[] = [];
    for (const id of await this.fs.listDirs('')) {
      for (const version of await this.fs.listDirs(id)) {
        const dir = `${id}/${version}`;
        if (!(await this.fs.exists(`${dir}/ready.json`))) continue;
        try {
          const ready = JSON.parse(await this.fs.readText(`${dir}/ready.json`)) as {
            bytes: number;
            downloadedAt: number;
          };
          const manifest = JSON.parse(
            await this.fs.readText(`${dir}/manifest.json`),
          ) as ToolManifest;
          out.push({ manifest, bytes: ready.bytes, downloadedAt: ready.downloadedAt });
        } catch {
          // Treats a corrupted catalog as not downloaded.
        }
      }
    }
    return out;
  }

  /**
   * Downloads a tool from the catalog: size and SHA-256 must match the catalog, manifest must
   * pass core checks (parseToolManifest), and it cannot be older than the locally existing
   * version. Can only be invoked by user action in the UI (D-064).
   */
  async download(entry: CatalogEntry, registry: Registry): Promise<DownloadedTool> {
    if (entry.hostApi > HOST_API)
      throw new ToolDownloadError('host', `${entry.id} needs a newer app`);
    const current = (await this.downloaded()).find((d) => d.manifest.id === entry.id);
    if (current && compareVersions(entry.version, current.manifest.version) < 0) {
      throw new ToolDownloadError('downgrade', `${entry.id} ${entry.version}`);
    }
    if (current?.manifest.version === entry.version) return current;
    let data: Uint8Array;
    try {
      data = await this.fs.fetch(toolManifestUrl(this.options.baseUrl, entry));
    } catch {
      throw new ToolDownloadError('download', entry.id);
    }
    if (data.length !== entry.size) throw new ToolDownloadError('size', entry.id);
    if ((await this.sha256(data)) !== entry.sha256) throw new ToolDownloadError('hash', entry.id);
    const manifest = parseToolManifest(data, registry, entry);
    // Writes the new version first, then deletes the old version: if interrupted midway, the old version remains intact.
    const dir = `${entry.id}/${entry.version}`;
    await this.fs.remove(dir);
    await this.fs.writeText(`${dir}/manifest.json`, decodeUtf8(data));
    const downloadedAt = this.now();
    await this.fs.writeText(
      `${dir}/ready.json`,
      JSON.stringify({ bytes: data.length, downloadedAt }),
    );
    for (const version of await this.fs.listDirs(entry.id)) {
      if (version !== entry.version) await this.fs.remove(`${entry.id}/${version}`);
    }
    return { manifest, bytes: data.length, downloadedAt };
  }

  /** Deletes a locally downloaded tool (must be added in the config and removed from the UI first). */
  async remove(id: string): Promise<void> {
    await this.fs.remove(id);
  }
}

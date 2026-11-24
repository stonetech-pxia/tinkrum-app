import {
  ToolManifestSchema,
  checkToolManifest,
  isRevoked,
  registerTool,
  toolFromManifest,
  type Catalog,
  type CatalogEntry,
  type Registry,
} from '@morph/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { ToolDownloadStore } from './store';

// Downloaded tools state in the app (D-177): directory, locally downloaded items, and active
// download. Loads at startup (registers locally downloaded tools into the registry) before opening
// the workspace, otherwise configurations using them fail validation.

export interface ToolDownloadsState {
  /** Configured directory URL (EXPO_PUBLIC_MORPH_TOOLS_URL). When unconfigured, uses only locally downloaded tools. */
  configured: boolean;
  catalog: Catalog | null;
  checkedAt: number | null;
  /** Locally downloaded tools: id -> version and size. */
  downloaded: Record<string, { version: string; bytes: number }>;
  /** ID of the tool currently being downloaded. */
  busy: string | null;
  load(): Promise<void>;
  /** Fetches the catalog once; skips if fetched within maxAgeMs. Retains the previous catalog when offline. */
  refresh(maxAgeMs?: number): Promise<void>;
  /** Downloads (or updates to) the latest version in the catalog and registers it in the registry. Throws ToolDownloadError on failure. */
  download(entry: CatalogEntry): Promise<void>;
  /** Deletes a locally downloaded tool (must be removed from the config first). Registry entries remain until the next startup. */
  remove(id: string): Promise<void>;
}

export type ToolDownloads = StoreApi<ToolDownloadsState>;

export function createToolDownloads(deps: {
  store: ToolDownloadStore;
  registry: Registry;
  configured: boolean;
  now?: () => number;
}): ToolDownloads {
  const now = deps.now ?? Date.now;
  return createStore<ToolDownloadsState>()((set, get) => ({
    configured: deps.configured,
    catalog: null,
    checkedAt: null,
    downloaded: {},
    busy: null,

    async load() {
      const downloaded: ToolDownloadsState['downloaded'] = {};
      for (const tool of await deps.store.downloaded()) {
        // Re-checks at every startup: after app updates, legacy manifests may no longer apply (actions changed, capability levels altered).
        const parsed = ToolManifestSchema.safeParse(tool.manifest);
        if (!parsed.success || checkToolManifest(parsed.data, deps.registry).length > 0) continue;
        registerTool(deps.registry, toolFromManifest(parsed.data));
        downloaded[parsed.data.id] = { version: parsed.data.version, bytes: tool.bytes };
      }
      const cached = await deps.store.cachedCatalog();
      set({
        downloaded,
        catalog: cached?.catalog ?? null,
        checkedAt: cached?.checkedAt ?? null,
      });
    },

    async refresh(maxAgeMs = 0) {
      if (!deps.configured) return;
      const { checkedAt } = get();
      if (checkedAt !== null && now() - checkedAt < maxAgeMs) return;
      try {
        const catalog = await deps.store.refreshCatalog();
        set({ catalog, checkedAt: now() });
      } catch {
        // Offline, server error, or invalid signature: retains the last verified catalog.
      }
    },

    async download(entry) {
      set({ busy: entry.id });
      try {
        const tool = await deps.store.download(entry, deps.registry);
        registerTool(deps.registry, toolFromManifest(tool.manifest));
        set({
          downloaded: {
            ...get().downloaded,
            [entry.id]: { version: tool.manifest.version, bytes: tool.bytes },
          },
        });
      } finally {
        set({ busy: null });
      }
    },

    async remove(id) {
      await deps.store.remove(id);
      const { [id]: _, ...rest } = get().downloaded;
      set({ downloaded: rest });
    },
  }));
}

/** Whether this tool's local version has been revoked (D-178: uses the last catalog when offline, or not revoked if no catalog exists). */
export function toolRevoked(state: ToolDownloadsState, toolId: string): boolean {
  const version = state.downloaded[toolId]?.version;
  return version !== undefined && isRevoked(state.catalog, toolId, version);
}

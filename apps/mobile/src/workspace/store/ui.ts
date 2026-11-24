import { appOfTarget, appViewOf, firstTarget } from '@morph/core';

import type { Kernel } from './kernel';
import type { WorkspaceState } from './types';

// UI state: Version banner, record toast, current navigation item, and file/record refresh signals.

export function createUI({
  set,
  get,
}: Kernel): Pick<
  WorkspaceState,
  | 'dismissBanner'
  | 'selectTab'
  | 'enterApp'
  | 'showInShell'
  | 'leaveApp'
  | 'bumpRecords'
  | 'showToast'
  | 'dismissToast'
  | 'holdBanner'
  | 'holdToast'
  | 'bumpAssets'
> {
  return {
    dismissBanner: () => set({ banner: null }),

    selectTab: (target) => set({ tab: target, editing: null }),

    enterApp(appId) {
      const config = get().config;
      if (!config) return;
      const view = appViewOf(config, appId);
      if (view.appId === null) return;
      set({ appId, tab: firstTarget(view), editing: null, appEnters: get().appEnters + 1 });
    },

    showInShell(config, target) {
      const owner = appOfTarget(config, target);
      if (owner === undefined) return false;
      const view = appViewOf(config, owner);
      if (!view.bar.includes(target)) return false;
      set({
        appId: view.appId,
        tab: target,
        editing: null,
        ...(view.appId !== null ? { appEnters: get().appEnters + 1 } : {}),
      });
      return true;
    },

    leaveApp() {
      const config = get().config;
      set({
        appId: null,
        tab: config ? firstTarget(appViewOf(config, null)) : null,
        editing: null,
      });
    },

    bumpRecords: (tables) =>
      set((s) => {
        if (!tables || tables.length === 0)
          return { recordsVersion: s.recordsVersion + 1, recordsAll: s.recordsAll + 1 };
        const tableVersions = { ...s.tableVersions };
        for (const id of tables) tableVersions[id] = (tableVersions[id] ?? 0) + 1;
        return { recordsVersion: s.recordsVersion + 1, tableVersions };
      }),

    showToast: (toast) => set({ toast }),

    dismissToast: () => set({ toast: null }),

    // Swaps to a new object on hold/release, restarting and stopping the banner timer accordingly.
    holdBanner(held) {
      const banner = get().banner;
      if (banner && !!banner.held !== held) set({ banner: { ...banner, held } });
    },

    holdToast(held) {
      const toast = get().toast;
      if (toast && !!toast.held !== held) set({ toast: { ...toast, held } });
    },

    bumpAssets: () => set({ assetsVersion: get().assetsVersion + 1 }),
  };
}

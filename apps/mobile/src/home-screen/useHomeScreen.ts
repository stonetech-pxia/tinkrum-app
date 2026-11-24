import { drawnIconId, homeScreenItems, type WorkspaceConfig } from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { t } from '../i18n';
import { iosSymbolName } from '../renderer/Icon';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { HomeScreenEntry, HomeScreenPlatform } from './platform';

// Mobile Home Screen (D-271): The long-press menu for the Morph icon is computed entirely from the
// official version's config (drafts are excluded). It is replaced wholesale after AI modifications,
// undos, redos, deletions, and quick action renames; unpinned icons that are no longer in the menu
// are disabled on Android. Tapping a menu item or home screen icon opens the quick action's run
// page, starting immediately just like tapping a run card (D-108); App items (app:<id>) navigate to
// that App (D-485).

/** Menu items: quick action ID, name, and iOS system icon; Apps also carry their own icon and color (D-606). */
export function homeScreenEntries(config: WorkspaceConfig): HomeScreenEntry[] {
  return homeScreenItems(config).map((item) => {
    const symbol = iosSymbolName(item.icon);
    // The drawn icon (D-625) includes the path, and Android home screen icons are drawn accordingly.
    const id = drawnIconId(item.icon);
    const drawn = id !== null ? config.icons?.[id] : undefined;
    return {
      id: item.id,
      title: item.title,
      ...(symbol ? { symbol } : {}),
      ...(item.colors
        ? { art: { icon: item.icon, ...item.colors, ...(drawn ? { drawn } : {}) } }
        : {}),
    };
  });
}

/** When menu contents change, replace them wholesale (considering only quick actions placed on the home screen and App IDs, names, icons, and colors). */
export function useHomeScreenSync(platform: HomeScreenPlatform | null) {
  const { locale } = useWorkspaceContext();
  const key = useWorkspace((s) => (s.config ? JSON.stringify(homeScreenEntries(s.config)) : null));
  useEffect(() => {
    if (!platform || key === null) return;
    platform
      .setItems(JSON.parse(key) as HomeScreenEntry[], t(locale, 'homeScreenGone'))
      .catch(() => undefined);
  }, [platform, key, locale]);
}

/**
 * Opening from the home screen (cold start or app running): go to the quick action's run page. If
 * a draft is open, exit the draft first (the draft is preserved, D-190), and the run page uses
 * the quick actions from the official version.
 */
export function useHomeScreenOpen(platform: HomeScreenPlatform | null) {
  const router = useRouter();
  const { store } = useWorkspaceContext();
  useEffect(() => {
    if (!platform) return;
    const open = (id: string) => {
      if (store.getState().draft?.open) store.getState().closeDraft();
      // Apps in the menu (D-485): tapping enters that App; if it no longer exists, remain on the home screen.
      if (id.startsWith('app:')) {
        if (router.canDismiss()) router.dismissAll();
        store.getState().enterApp(id.slice('app:'.length));
        return;
      }
      router.push({ pathname: '/run/[workflowId]', params: { workflowId: id } });
    };
    // Cold start: once the navigator and home screen are mounted, open on the next tick with the run page stacked on top of the home screen (closing returns to the home screen).
    const launched = platform.takeLaunched();
    const timer = launched ? setTimeout(() => open(launched), 0) : undefined;
    const unsubscribe = platform.onOpen(open);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);
}

/** Placed in the root layout: sync menu, handle home screen opens. */
export function HomeScreenBridge({ platform }: { platform: HomeScreenPlatform | null }) {
  useHomeScreenSync(platform);
  useHomeScreenOpen(platform);
  return null;
}

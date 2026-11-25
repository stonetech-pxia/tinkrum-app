import type { Op } from './ops';
import { workflowKinds, QUICK_ACTION_CATEGORIES } from './quick-actions';
import {
  MAX_HOME_SCREEN,
  appTarget,
  quickActionsOf,
  type IconValue,
  type WorkspaceConfig,
} from './schema';
import { isDark, resolveColors } from './theme';

// Mobile desktop (D-271): quick actions under nav.phoneHomeScreen appear in the long-press menu of
// the Morph icon (iOS Home Screen Quick Actions, Android App Shortcuts). The menu is computed from
// the configuration and completely replaced whenever the configuration changes (AI modification,
// undo, restore, deletion, renaming). Tapping opens Morph and immediately starts that quick action,
// identical to tapping a run card (D-108).

// Supports placing Apps as well (D-485): items formatted as app:<id> open that App when tapped.

export interface HomeScreenItem {
  /** Menu item ID: either a quick action ID or app:<id>. */
  id: string;
  kind: 'quickAction' | 'app';
  title: string;
  /** Quick action's own icon, falling back to its category icon if absent; apps use their own icon, falling back to apps if absent. */
  icon: IconValue;
  /**
   * Colors used for the app's desktop icon (D-606): background color is the primary color of the
   * app's own theme, and foreground uses the text color on that primary color. Desktop icons do
   * not adapt to system dark/light mode, following the system theme treated as light mode. Quick
   * actions lack this and use the Tinkrum icon (D-271).
   */
  colors?: { background: string; foreground: string };
}

/** IDs of items in the desktop menu (quick actions, apps), in the order of nav.phoneHomeScreen; items not in the config are excluded. */
function homeScreenIds(config: WorkspaceConfig): string[] {
  const ids = new Set(quickActionsOf(config).map((w) => w.id));
  const apps = new Set((config.nav.apps ?? []).map((a) => `app:${a.id}`));
  return (config.nav.phoneHomeScreen ?? []).filter((id) => ids.has(id) || apps.has(id));
}

/** Items in the desktop menu, in the order of nav.phoneHomeScreen; the validator ensures it does not exceed MAX_HOME_SCREEN, and we truncate it here again. */
export function homeScreenItems(config: WorkspaceConfig): HomeScreenItem[] {
  const workflows = quickActionsOf(config);
  return homeScreenIds(config)
    .slice(0, MAX_HOME_SCREEN)
    .map((id): HomeScreenItem => {
      if (id.startsWith('app:')) {
        const app = config.nav.apps!.find((a) => `app:${a.id}` === id)!;
        const c = resolveColors(app.theme, isDark(app.theme, false));
        return {
          id,
          kind: 'app',
          title: app.name,
          icon: app.icon ?? 'apps',
          colors: { background: c.primary, foreground: c.onPrimary },
        };
      }
      const w = workflows.find((x) => x.id === id)!;
      return {
        id,
        kind: 'quickAction',
        title: w.name,
        icon: w.icon ?? QUICK_ACTION_CATEGORIES[workflowKinds(w)[0] ?? 'other'].icon,
      };
    });
}

/** Quick actions newly placed on the desktop in this modification (after application, guides the user on how to use them; on Android, pinned to the desktop only after tapping the button). */
export function addedToHomeScreen(before: WorkspaceConfig, after: WorkspaceConfig): string[] {
  const was = new Set(homeScreenIds(before));
  return homeScreenIds(after).filter((id) => !was.has(id));
}

/** Desktop menu is full: another item must be removed before placing a new one. */
export const homeScreenFull = (config: WorkspaceConfig): boolean =>
  homeScreenIds(config).length >= MAX_HOME_SCREEN;

/**
 * A new app starts out in the menu while there is room (D-647): puts each app that is in
 * `after` and not in `before` into `after`'s menu, and returns the names of those put in. An app
 * that was already installed keeps the user's choice, also when it is reinstalled.
 */
export function addNewAppsToHomeScreen(before: WorkspaceConfig, after: WorkspaceConfig): string[] {
  const installed = new Set((before.nav.apps ?? []).map((a) => a.id));
  const put: string[] = [];
  for (const app of after.nav.apps ?? []) {
    const id = appTarget(app.id);
    if (installed.has(app.id) || after.nav.phoneHomeScreen?.includes(id)) continue;
    if (homeScreenFull(after)) break;
    after.nav.phoneHomeScreen = [...(after.nav.phoneHomeScreen ?? []), id];
    put.push(app.name);
  }
  return put;
}

/**
 * Modification to place/remove a quick action on the desktop (long-press menu toggle): v34
 * operations write the entire list (nav.phoneHomeScreen), whereas here we add or remove this
 * single item based on the current list. Newly placed items are appended at the end.
 */
export function homeScreenOp(config: WorkspaceConfig, itemId: string, on: boolean): Op {
  const ids = (config.nav.phoneHomeScreen ?? []).filter((id) => id !== itemId);
  return { op: 'updateContainer', nav: { phoneHomeScreen: on ? [...ids, itemId] : ids } };
}

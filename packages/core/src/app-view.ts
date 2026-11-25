import { HOME_PAGE_ID, isKnownComponent, type WorkspaceConfig } from './schema';
import { pageIdOf, type AppBarTarget, type NavTarget, type Theme } from './schema-base';

// Current app view (D-485): the home screen is the top-level nav.bar + theme, and other apps are
// under nav.apps. The shell, navigation, and theme all read this without checking "is this the home
// screen" elsewhere. If the appId does not exist (e.g., restoring to an old version without this
// app), it falls back to the home screen.

export interface ShellView {
  /** null = home screen. */
  appId: string | null;
  /** The home screen is nav.bar; an app uses its own bottom bar. */
  bar: readonly NavTarget[];
  /** Only the home screen has floating entry points. */
  floating: readonly NavTarget[];
  theme: Theme;
  /** The app's name; the home screen does not have one. */
  name?: string;
}

export function appViewOf(config: WorkspaceConfig, appId: string | null): ShellView {
  const app = appId === null ? undefined : config.nav.apps?.find((a) => a.id === appId);
  if (!app)
    return { appId: null, bar: config.nav.bar, floating: config.nav.floating, theme: config.theme };
  return {
    appId: app.id,
    bar: app.bar as readonly AppBarTarget[],
    floating: [],
    theme: app.theme,
    name: app.name,
  };
}

/** Which app a page belongs to; pages on the home screen have null, and non-existent pages return undefined. */
export function appOfPage(config: WorkspaceConfig, pageId: string): string | null | undefined {
  const page = config.containers.pages.find((p) => p.id === pageId);
  return page ? (page.app ?? null) : undefined;
}

/** Which app a navigation target belongs to: pages look at their app; system entry points do not belong to any app and return undefined. */
export function appOfTarget(config: WorkspaceConfig, target: NavTarget): string | null | undefined {
  const pageId = pageIdOf(target);
  return pageId === null ? undefined : appOfPage(config, pageId);
}

/** Which item to display first after entering an app: the first item in the bottom bar that is not Tink; same as firstTab for the home screen. */
export function firstTarget(view: ShellView): NavTarget {
  const first = view.bar.find((n) => n !== 'ai');
  if (first !== undefined) return first;
  // A new app has no pages yet, so its bottom bar only has Tink: there are no pages to display (the shell displays an empty state).
  if (view.appId !== null) return 'ai';
  return view.floating.find((n) => n !== 'ai') ?? 'settings';
}

/**
 * The app Tinkrum opens in (D-new-apphome-6): the only app, as long as the home page holds nothing
 * but the app list, so that nothing of the home page goes unseen. Null: Tinkrum opens on the home
 * page.
 */
export function startAppOf(config: WorkspaceConfig): string | null {
  const [app, ...others] = config.nav.apps ?? [];
  if (!app || others.length > 0 || !app.bar.some((target) => target !== 'ai')) return null;
  const home = config.containers.pages.find((p) => p.id === HOME_PAGE_ID);
  const shown = home?.blocks.filter((block) => !block.hidden) ?? [];
  const onlyTheList =
    shown.length > 0 &&
    shown.every((block) => isKnownComponent(block) && block.look === 'apps') &&
    config.nav.bar.every((target) => [null, HOME_PAGE_ID].includes(pageIdOf(target)));
  return onlyTheList ? app.id : null;
}

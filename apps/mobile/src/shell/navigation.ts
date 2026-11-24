import {
  SYSTEM_TARGET_ICONS,
  appOfTarget,
  appTargetId,
  appViewOf,
  builtinText,
  navTargetLabel,
  pageIdOf,
  toolTargetId,
  type IconValue,
  type Locale,
  type NavTarget,
  type OpenTarget,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { useRouter } from 'expo-router';

import { useWorkspace } from '../workspace/context';

/**
 * Opens a navigation target:
 * - AI modifications are separate pages;
 * - Navigation bar pages and system entries (tools, history, settings) switch display within the
 * shell;
 * - Pages not in the navigation bar, tools, and change history are pushed into a new page with a
 * back button;
 * - Quick action tool:<id> only opens displayed items (D-256);
 * - app:<id> enters that app; pages of other apps first switch to their app (reminders, widgets,
 * and entries all route through here, D-485); opening settings within an app returns to the home
 * screen (system pages adopt the home screen appearance).
 */
export function useNavigate(): (target: OpenTarget) => void {
  const router = useRouter();
  const config = useWorkspace((s) => s.config!);
  const appId = useWorkspace((s) => s.appId);
  const nav = appViewOf(config, appId).bar;
  const selectTab = useWorkspace((s) => s.selectTab);
  const enterApp = useWorkspace((s) => s.enterApp);
  const leaveApp = useWorkspace((s) => s.leaveApp);
  return (target) => {
    const toApp = appTargetId(target);
    if (toApp !== null) {
      enterApp(toApp);
      if (router.canDismiss()) router.dismissAll();
      return;
    }
    // Quick actions opened via buttons or quick shortcuts (D-256): displayed only, runs only when the user taps "Start" (same as reminders, P-043).
    const workflowId = toolTargetId(target);
    if (workflowId !== null) {
      router.push({ pathname: '/reminder/[workflowId]', params: { workflowId, from: 'entry' } });
      return;
    }
    const navTarget = target as NavTarget;
    if (navTarget === 'quickActions' && !nav.includes(navTarget)) {
      router.push('/quick-actions');
      return;
    }
    if ((navTarget === 'history' || navTarget === 'tools') && !nav.includes(navTarget)) {
      router.push(`/${navTarget}`);
      return;
    }
    if (navTarget === 'ai') {
      router.push('/change');
      return;
    }
    const pageId = pageIdOf(navTarget);
    // Pages of another app (or home screen): switches over first; displayed if in its bottom bar, pushed if not.
    const owner = appOfTarget(config, navTarget);
    if (pageId !== null && owner !== undefined && owner !== appId) {
      if (appViewOf(config, owner).bar.includes(navTarget)) {
        if (owner === null) leaveApp();
        else enterApp(owner);
        selectTab(navTarget);
        if (router.canDismiss()) router.dismissAll();
      } else router.push({ pathname: '/page/[pageId]', params: { pageId } });
      return;
    }
    if (pageId !== null && !nav.includes(navTarget)) {
      router.push({ pathname: '/page/[pageId]', params: { pageId } });
      return;
    }
    // Settings are absent from the app's bottom bar: returns to home screen to display (Settings is a system page, using the home screen layout).
    if (appId !== null && navTarget === 'settings') leaveApp();
    selectTab(navTarget);
    // When opening a shell entry from a pushed page, return to the shell first.
    if (router.canDismiss()) router.dismissAll();
  };
}

export function targetIcon(target: NavTarget, config: WorkspaceConfig): IconValue | 'tink' {
  const pageId = pageIdOf(target);
  if (pageId === null) return SYSTEM_TARGET_ICONS[target as keyof typeof SYSTEM_TARGET_ICONS];
  return config.containers.pages.find((p) => p.id === pageId)?.icon ?? 'bookmark';
}

/** Text for the navigation bar; built-in page names follow the UI language (user-modified names are preserved). */
export function targetLabel(
  target: NavTarget,
  config: WorkspaceConfig,
  locale: Locale,
  registry: Registry,
): string {
  return builtinText(navTargetLabel(target, config, locale), locale, registry);
}

/** Animation duration for closing modal pages (approximately 350 ms on iOS). */
const MODAL_CLOSE_MS = 400;

/**
 * Transition from a modal page ("quick action created", quick action entry page) to the run page:
 * closes this page first, then opens the run page upon closure. Directly switching to the run
 * page causes two modals to animate simultaneously, causing iOS to quietly drop the photo/file
 * picker popped up by the first step of the run page, leaving execution stuck at step 1
 * (2026-11-06 simulator stuck at "Select photo" on "Use once now").
 */
export function openRunAfterClosing(
  router: ReturnType<typeof useRouter>,
  workflowId: string,
): void {
  const run = { pathname: '/run/[workflowId]' as const, params: { workflowId } };
  // When opened directly from a notification with no underlying pages, there is nothing to dismiss, so perform a direct replacement.
  if (!router.canGoBack()) {
    router.replace(run);
    return;
  }
  router.back();
  setTimeout(() => router.push(run), MODAL_CLOSE_MS);
}

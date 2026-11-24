import { AiReturnBubble } from '../ai/AiReturnBubble';
import {
  HOME_PAGE_ID,
  appViewOf,
  firstTarget,
  pageIdOf,
  type NavTarget,
  type ShellView,
  type WorkspaceConfig,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { BlurTargetView } from 'expo-blur';
import { useEffect, useRef, type ComponentRef } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DraftBar } from '../draft/DraftBar';
import { useDraftUi } from '../draft/ui';
import { directEditEntry } from '../editing/entry';
import { GuideBubble } from '../guide/GuideBubble';
import { GuideCard } from '../guide/GuideCard';
import { SampleHint } from '../guide/SampleHint';
import { openLookGuide, useGuide } from '../guide/store';
import { t } from '../i18n';
import { usePacks } from '../packs/PackHost';
import { EditablePage } from '../editing/EditablePage';
import type { RenderEnv } from '../renderer/components';
import { GlassFill } from '../renderer/GlassFill';
import { Icon } from '../renderer/Icon';
import { usePalette } from '../renderer/theme';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { shownConfig } from '../workspace/store';
import { AIEntry, shellAbout } from './ai-entry';
import { BannerAnchor, DraftNotice } from './Banner';
import { HistoryView } from './HistoryView';
import { targetIcon, targetLabel, useNavigate } from './navigation';
import { SettingsView } from './SettingsView';
import { Toast } from './Toast';
import { ToolsView } from './ToolsView';
import { WorkflowsScreen } from './WorkflowsScreen';

// Prompt bar placed separately in Banner.tsx (also used by WorkflowsScreen, placing it here would cause a circular dependency); exported here as before so old references do not need to change.
export { APPLIED_BANNER_MS, Banner, DraftNotice } from './Banner';

const BAR_HEIGHT = { iconLabel: 64, label: 52, icon: 56 } as const;

/**
 * Targets the shell can display: pages of the current app (or home page), and system entry points
 * in the home page (excluding AI modify, which is a separate page). Only its own pages are
 * displayed within an app; pages from other apps or the home page will not be mixed in (D-485).
 */
function canShow(
  target: NavTarget | null,
  config: WorkspaceConfig,
  view: ShellView,
): target is NavTarget {
  if (target === null || target === 'ai') return false;
  const pageId = pageIdOf(target);
  if (pageId === null) return view.appId === null;
  const page = config.containers.pages.find((p) => p.id === pageId);
  return page !== undefined && (page.app ?? null) === view.appId;
}

/** Environment provided by the shell to pages (D-190): opening pages in draft mode works as usual, "AI modify" opens the chat box, and operations that actually perform actions only show prompts. */
export function useShellEnv(): Pick<RenderEnv, 'navigate' | 'locked'> & { inDraft: boolean } {
  const { locale } = useWorkspaceContext();
  const inDraft = useWorkspace((s) => !!s.draft?.open);
  const showToast = useWorkspace((s) => s.showToast);
  const setChatOpen = useDraftUi((s) => s.setChatOpen);
  const markSeen = useDraftUi((s) => s.markSeen);
  const lastStep = useWorkspace((s) => s.draft?.steps.at(-1)?.changeRequestId);
  const navigate = useNavigate();
  if (!inDraft) return { navigate, inDraft };
  return {
    inDraft,
    navigate: (target) => (target === 'ai' ? setChatOpen(true) : navigate(target)),
    // Prompt "Available after application"; the reply from the latest step will block the prompt, so collapse it first.
    locked: () => {
      if (lastStep !== undefined) markSeen(lastStep);
      showToast({ message: t(locale, 'draftLocked') });
    },
  };
}

/** App shell: content area, bottom navigation rendered according to configuration, and floating buttons. */
/** If in the background for longer than this duration, returning goes back to the home page (D-485, D-612). */
const LEAVE_APP_AFTER_MS = 30_000;

export function Shell() {
  const { registry, locale, store } = useWorkspaceContext();
  // Show the draft in draft mode (D-190).
  const config = useWorkspace(shownConfig)!;
  const headId = useWorkspace((s) => s.head!.id);
  const tab = useWorkspace((s) => s.tab);
  const appId = useWorkspace((s) => s.appId);
  const leaveApp = useWorkspace((s) => s.leaveApp);
  const view = appViewOf(config, appId);
  const markRendered = useWorkspace((s) => s.markRendered);
  // Prompt once when downloads requested via "Background download" finish (the user has already gone to do other things).
  const packs = usePacks();
  const showToast = useWorkspace((s) => s.showToast);
  useEffect(
    () =>
      packs?.store.onBackgroundEnd(({ ok }) =>
        showToast({ message: t(locale, ok ? 'packBackgroundDone' : 'packBackgroundFailed') }),
      ),
    [packs, showToast, locale],
  );
  const editing = useWorkspace((s) => s.editing !== null);
  const startEditing = useWorkspace((s) => s.startEditing);
  const palette = usePalette(view.theme);
  const { navigate, locked, inDraft } = useShellEnv();
  const insets = useSafeAreaInsets();

  // The current app no longer exists (e.g., restored to an old version, app deleted): return to the home page.
  const missingApp = appId !== null && view.appId === null;
  useEffect(() => {
    if (missingApp) leaveApp();
  }, [missingApp, leaveApp]);

  // There is no "Return to Tinkrum" button within sub-apps (D-485): returning to the home page can
  // only be done by opening Tinkrum from the phone. Leaving the app for more than 30 seconds and
  // returning (via icon tap, app switcher) returns to the home page (D-612); when directly opening
  // an app from the home screen menu or a deep link, entering the app occurs after returning, and
  // the user stays within that app.

  // Rendering completion (not intercepted by ErrorBoundary) confirms this commit succeeded (§4).
  useEffect(() => {
    void markRendered(headId);
  }, [headId, markRendered]);

  // First open (or re-watch selected in settings): view the swipe introduction first (D-149).
  const guideStage = useGuide((s) => s.stage);
  const router = useRouter();

  useEffect(() => {
    let left: { enters: number; at: number } | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') left = { enters: store.getState().appEnters, at: Date.now() };
      else if (state === 'active' && left !== null) {
        const { enters: since, at } = left;
        left = null;
        // Briefly switching away (glancing at another app, notification panel) does not count as leaving: returning only after more than 30 seconds goes to the home page (D-612).
        if (Date.now() - at <= LEAVE_APP_AFTER_MS) return;
        // App opening events (home screen menu, deep link) arrive slightly later than "returning to foreground", wait for them.
        setTimeout(() => {
          const s = store.getState();
          if (s.appId === null || s.appEnters > since) return;
          // Having pushed pages (running, record form, etc.) indicates the user is working: system
          // permission dialogs, file and photo pickers will also cause the app to enter the
          // background briefly, so what the user is doing must not be closed; stay in place
          // (D-585).
          if (router.canDismiss()) return;
          s.leaveApp();
        }, 700);
      }
    });
    return () => sub.remove();
  }, [store, router]);
  const blurTarget = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    // When the shell is remounted due to a version change (e.g., inbox created a table), the introduction may already be open, so do not push it again.
    if (guideStage !== 'intro' || useGuide.getState().introOpen) return;
    useGuide.setState({ introOpen: true });
    router.push('/welcome');
  }, [guideStage, router]);

  const active = canShow(tab, config, view) ? tab : firstTarget(view);
  const env: RenderEnv = {
    config,
    palette,
    locale,
    registry,
    interactive: true,
    navigate,
    ...(locked ? { locked } : {}),
  };
  const navStyle = view.theme.navStyle;
  // Hide navigation bar and floating buttons in edit mode: "Done" or "Cancel" first; drafts are not lost when switching pages (D-054).
  const barSpace = editing ? insets.bottom : BAR_HEIGHT[navStyle] + insets.bottom;

  let content;
  const pageId = pageIdOf(active);
  const entryAbout = shellAbout(active);
  // Guide steps 1 and 2 (D-447): Tink's speech bubble floats on the home screen, Tink animates and has a halo.
  const bubbleGuide =
    pageId === HOME_PAGE_ID &&
    (guideStage === 'look' || guideStage === 'goal') &&
    !editing &&
    !inDraft;
  const lookGuide = bubbleGuide && guideStage === 'look';
  if (pageId !== null) {
    const page = config.containers.pages.find((p) => p.id === pageId)!;
    // Navigation bar is below the page (not overlaying it), so pages do not need to reserve height
    // for it; edit mode has no navigation bar, so it must clear the system bottom area. Clear space
    // for floating buttons when present (the 64 in bottomInset is reserved for scrollable content).
    const floatingShown = view.floating.length > 0 && !editing && !inDraft;
    const below = editing ? insets.bottom : 0;
    content = (
      <EditablePage
        page={page}
        env={env}
        bottomInset={below + (editing ? 0 : 64)}
        zoneInset={below + (floatingShown ? 64 : 0)}
      />
    );
  } else if (active === 'ai') {
    // New apps do not have pages yet, so the bottom bar only contains Tink (D-485).
    content = (
      <View style={styles.empty}>
        <Text style={[palette.font('body', 15), { color: palette.caption, textAlign: 'center' }]}>
          {t(locale, 'appEmpty')}
        </Text>
      </View>
    );
  } else if (active === 'tools') {
    content = <ToolsView env={env} />;
  } else if (active === 'quickActions') {
    content = <WorkflowsScreen palette={palette} locale={locale} registry={registry} embedded />;
  } else if (active === 'history') {
    content = <HistoryView env={env} />;
  } else {
    content = <SettingsView env={env} />;
  }

  return (
    <View style={[styles.root, palette.backdrop, { paddingTop: insets.top }]}>
      {/* AI entry point in the upper right (D-406): no navigation bar here, takes up a single row, does not overlay page content. Settings and change history do not have it. */}
      {entryAbout && !editing ? (
        <View
          style={[
            styles.entryRow,
            { paddingHorizontal: palette.pad },
            bubbleGuide && styles.entryOnTop,
          ]}>
          {/* Guide step 1 (D-447): Tink on the home screen animates; tapping it is the same as tapping the bubble, opening that prompt. */}
          {bubbleGuide ? (
            <AIEntry
              about={entryAbout}
              palette={palette}
              lively
              {...(lookGuide ? { onPress: () => openLookGuide(router) } : {})}
            />
          ) : (
            <AIEntry about={entryAbout} palette={palette} />
          )}
        </View>
      ) : null}
      {/* Wrap content below the Tink row in BlurTargetView: slightly blur the entire area when the guide bubble appears (Android requires this for true blurring). */}
      <BlurTargetView ref={blurTarget} style={styles.content}>
        {inDraft ? null : <BannerAnchor palette={palette} />}
        <DraftNotice palette={palette} />
        {pageId === HOME_PAGE_ID && !editing && !inDraft ? <GuideCard palette={palette} /> : null}
        {pageId !== null && !editing && !inDraft ? (
          <SampleHint pageId={pageId} palette={palette} />
        ) : null}
        <View style={styles.content}>{content}</View>

        {/*
         * Edit mode switch (D-053): pages in the navigation bar have no title bar, placed in the
         * bottom left; hidden in edit mode. Full-page entry points remain closed, long-press
         * entry points are opened individually (D-235, editing/entry.ts).
         */}
        {pageId !== null && directEditEntry.pageButton && !inDraft ? (
          <Pressable
            testID={editing ? undefined : 'page-edit'}
            accessibilityRole="button"
            accessibilityElementsHidden={editing}
            pointerEvents={editing ? 'none' : 'auto'}
            onPress={() => startEditing(pageId)}
            style={({ pressed }) => [
              styles.fab,
              styles.editButton,
              { left: palette.pad },
              palette.cardStyle(palette.surface),
              { bottom: barSpace + 16, borderRadius: 999 },
              pressed && { transform: [{ scale: 0.96 }] },
              editing && styles.invisible,
            ]}>
            <GlassFill palette={palette} radius={999} />
            <Text style={[palette.font('title', 14), { color: palette.primaryText }]}>
              {t(locale, 'edit')}
            </Text>
          </Pressable>
        ) : null}

        {view.floating.length > 0 && !editing && !inDraft ? (
          <View style={[styles.floating, { right: palette.pad, bottom: barSpace + 16 }]}>
            {view.floating.map((target) => {
              const accent = target === 'ai';
              const fg = accent ? palette.onPrimary : palette.text;
              return (
                <Pressable
                  key={target}
                  testID={`floating-${target}`}
                  onPress={() => navigate(target)}
                  style={({ pressed }) => [
                    styles.fab,
                    palette.cardStyle(accent ? palette.primary : palette.surface),
                    { borderRadius: 999 },
                    pressed && { transform: [{ scale: 0.96 }] },
                  ]}>
                  <GlassFill palette={palette} radius={999} />
                  <Icon name={targetIcon(target, config)} size={18} color={fg} />
                  <Text style={[palette.font('title', 14), { color: fg }]}>
                    {targetLabel(target, config, locale, registry)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <DraftBar palette={palette} bottom={barSpace + 12} top={12} tinkRight={palette.pad + 12} />
        <Toast palette={palette} bottom={barSpace + (inDraft ? 84 : 12)} />

        <View
          style={[
            styles.bar,
            editing && styles.hidden,
            {
              height: barSpace,
              paddingBottom: insets.bottom,
              backgroundColor: palette.barBackground,
              borderColor: palette.border,
            },
          ]}>
          <GlassFill palette={palette} radius={0} />
          {view.bar.map((target) => {
            const isActive = target === active;
            const color = isActive || target === 'ai' ? palette.primaryText : palette.caption;
            const label = targetLabel(target, config, locale, registry);
            return (
              <Pressable
                key={target}
                testID={`nav-${target}`}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: isActive }}
                style={styles.tab}
                onPress={() => navigate(target)}>
                {navStyle !== 'label' ? (
                  <View
                    style={[
                      styles.tabIcon,
                      { backgroundColor: isActive ? palette.primaryTint : 'transparent' },
                    ]}>
                    <Icon name={targetIcon(target, config)} size={22} color={color} />
                  </View>
                ) : null}
                {navStyle !== 'icon' ? (
                  <Text
                    numberOfLines={1}
                    style={[palette.font(isActive ? 'bodyBold' : 'bodyMedium', 12), { color }]}>
                    {label}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </BlurTargetView>
      {bubbleGuide ? (
        <GuideBubble palette={palette} top={insets.top + ENTRY_ROW} blurTarget={blurTarget} />
      ) : entryAbout && appId === null && pageId === HOME_PAGE_ID && !editing && !inDraft ? (
        // Coming back from another AI app (D-627): Tink says so in a bubble, like the guide.
        <View
          pointerEvents="box-none"
          style={[
            styles.returnWrap,
            {
              top: insets.top + ENTRY_ROW,
              paddingLeft: palette.pad,
              paddingRight: palette.pad - 3,
            },
          ]}>
          <AiReturnBubble palette={palette} />
        </View>
      ) : null}
    </View>
  );
}

/** Height of the upper right Tink row (8 top/bottom + 24 icon): guide bubble floats downward from here. */
const ENTRY_ROW = 40;

const styles = StyleSheet.create({
  // When the guide bubble appears, the Tink row floats above the blur layer, and the halo is not blocked.
  entryOnTop: { zIndex: 2, elevation: 2 },
  returnWrap: { ...StyleSheet.absoluteFill, alignItems: 'flex-end', paddingTop: 12 },
  entryRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingVertical: 8,
  },
  root: { flex: 1 },
  content: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  // Items floating on the page (upper right Tink, edit, floating buttons) align with the page margin palette.pad horizontally (D-454), written where used.
  floating: { position: 'absolute', gap: 10, alignItems: 'flex-end' },
  fab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    minHeight: 48,
  },
  invisible: { opacity: 0 },
  editButton: { position: 'absolute', minHeight: 40, paddingHorizontal: 16 },
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  hidden: { display: 'none' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: {
    width: 52,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

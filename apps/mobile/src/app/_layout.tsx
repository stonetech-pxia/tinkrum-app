import {
  BUILTIN_TOOLS,
  createMockAIProvider,
  createRegistry,
  createStarterWorkspace,
  localize,
  quickActionsOf,
  type Locale,
  trustedToolKeys,
} from '@morph/core';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Karla_400Regular } from '@expo-google-fonts/karla/400Regular';
import { Karla_400Regular_Italic } from '@expo-google-fonts/karla/400Regular_Italic';
import { Karla_500Medium } from '@expo-google-fonts/karla/500Medium';
import { Karla_700Bold } from '@expo-google-fonts/karla/700Bold';
import { Sora_600SemiBold } from '@expo-google-fonts/sora/600SemiBold';
import { Sora_700Bold } from '@expo-google-fonts/sora/700Bold';
import Constants from 'expo-constants';
import { useFonts } from 'expo-font';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AISettingsProvider } from '@/ai/context';
import { createAIRouter } from '@/ai/router';
import { getDeviceId, secureSecretStore } from '@/ai/secure-store';
import { createAISettingsStore } from '@/ai/settings';
import { DraftChatSheet } from '@/draft/DraftBar';
import { useGuide } from '@/guide/store';
import { openStartApp } from '@/shell/start-app';
import { HomeScreenProvider } from '@/home-screen/context';
import { nativeHomeScreen } from '@/home-screen/native';
import { HomeScreenBridge } from '@/home-screen/useHomeScreen';
import { t } from '@/i18n';
import { LANGUAGE_META_KEY, parseLanguage, resolveLocale, useLanguage } from '@/language';
import { PackBridge } from '@/packs/bridge';
import { expoBridgeFiles, expoPackStore, expoSha256 } from '@/packs/expo-pack-fs';
import { PackHostProvider } from '@/packs/PackHost';
import { rescueActions } from '@/rescue/actions';
import { HEALTHY_AFTER_MS, markHealthy } from '@/rescue/attempts';
import { attachReturnStore } from '@/ai/return';
import { expoReturnStore } from '@/ai/expo-return';
import { expoAttemptStore } from '@/rescue/expo-attempts';
import { RescueScreen } from '@/rescue/RescueScreen';
import { onReminderAction, reminders } from '@/reminders/background';
import {
  useReminderActionFeedback,
  useReminderOpen,
  useReminderSync,
} from '@/reminders/useReminders';
import { expoFilePlatform } from '@/runtime/expo-platform';
import { closeButtonOption, stackScreenOptions } from '@/shell/header';
import { AlertHost } from '@/renderer/AlertHost';
import { DrawnIconsProvider } from '@/renderer/DrawnIcon';
import { CLAY_FONTS, usePalette } from '@/renderer/theme';
import { useIncomingShare } from '@/share/useIncomingShare';
import { ToolDownloadsProvider } from '@/tool-download/context';
import { expoToolFs } from '@/tool-download/expo-tool-fs';
import { createToolDownloads } from '@/tool-download/state';
import { ToolDownloadStore } from '@/tool-download/store';
import { getBackup } from '@/backup';
import { registerBackupRuntime } from '@/backup/runtime';
import { closeRepo, openRepo } from '@/storage/open';
import type { SQLiteWorkspaceRepo } from '@/storage/sqlite';
import { useStopBuildInBackground } from '@/shell/BuildPanel';
import {
  WorkspaceProvider,
  useWorkspace,
  useWorkspaceContext,
  useAppTheme,
} from '@/workspace/context';
import { createNeedSender, createRemoteAIProvider } from '@/workspace/remote-ai';
import { createWorkspaceStore, shownConfig, type WorkspaceStore } from '@/workspace/store';
import { WidgetProvider } from '@/widgets/context';
import { nativeWidgets } from '@/widgets/native';
import { WidgetBridge } from '@/widgets/useWidgets';

// Extension packs (D-064, D-510): the single PackStore in the app, see expo-pack-fs.ts.
const packs = { store: expoPackStore, bridge: new PackBridge(expoBridgeFiles(expoPackStore)) };
const registry = createRegistry(BUILTIN_TOOLS);
// Tools downloaded from the server (D-177, D-178): directory URL is not a secret; development builds additionally trust the development public key in the repository.
const toolsUrl = process.env.EXPO_PUBLIC_MORPH_TOOLS_URL;
const toolDownloads = createToolDownloads({
  store: new ToolDownloadStore(expoToolFs, expoSha256, {
    baseUrl: toolsUrl ?? '',
    trustedKeys: trustedToolKeys(__DEV__),
  }),
  registry,
  configured: Boolean(toolsUrl),
});
/** Fetch the catalog on startup if it hasn't been fetched for over a day (powers the blocklist, D-178). */
const CATALOG_DAY_MS = 24 * 60 * 60 * 1000;
// AI source determined by 'Settings -> AI': built-in rules, Morph server (requires address config, see README), or user's own key.
const apiUrl = process.env.EXPO_PUBLIC_MORPH_API_URL;
// Platform and version sent to the server per requirements (D-189) and request persistence during testing (D-240).
const appInfo = {
  ...(Platform.OS === 'ios' || Platform.OS === 'android' ? { platform: Platform.OS } : {}),
  ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
};
const aiSettings = createAISettingsStore({
  secrets: secureSecretStore,
  serverAvailable: Boolean(apiUrl),
  // Requirement recovery (D-189): when a server address is configured, phrases the AI cannot handle can be sent by the user with a tap.
  needs: apiUrl
    ? createNeedSender({
        baseUrl: apiUrl,
        clientToken: process.env.EXPO_PUBLIC_MORPH_CLIENT_TOKEN,
        deviceId: getDeviceId,
        ...appInfo,
      })
    : null,
});
const provider = createAIRouter({
  settings: aiSettings,
  mock: createMockAIProvider(),
  remote: apiUrl
    ? createRemoteAIProvider({
        baseUrl: apiUrl,
        clientToken: process.env.EXPO_PUBLIC_MORPH_CLIENT_TOKEN,
        deviceId: getDeviceId,
        ...appInfo,
        registry,
        now: () => new Date(),
      })
    : null,
  registry,
  now: () => new Date(),
});

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

function RootStack() {
  const { locale, store } = useWorkspaceContext();
  const status = useWorkspace((s) => s.status);
  const error = useWorkspace((s) => s.error);
  const config = useWorkspace((s) => s.config);
  const actions = useMemo(() => rescueActions(locale), [locale]);
  useStopBuildInBackground();
  // Error reading workspace: fallback page (health check 6.6), 'Open as usual' to read again.
  if (status === 'error')
    return (
      <RescueScreen
        locale={locale}
        error={error ?? ''}
        actions={actions}
        onContinue={() => void store.getState().boot()}
      />
    );
  if (!config)
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  return <ThemedStack />;
}

function ThemedStack() {
  const { locale } = useWorkspaceContext();
  const theme = useAppTheme();
  // Files shared from other apps -> inbox page (D-114).
  useIncomingShare(expoFilePlatform);
  // Reminders: re-schedule on config or record changes; tapping a reminder opens a page or quick action (D-251).
  useReminderSync(reminders);
  useReminderOpen(reminders);
  useReminderActionFeedback(onReminderAction);
  const palette = usePalette(theme);
  const closable = { presentation: 'modal', ...closeButtonOption(palette) } as const;
  // Drawn icons (D-625): includes both official version and draft icons; pushed pages also render official version icons when a draft is open.
  const savedIcons = useWorkspace((s) => s.config?.icons);
  const shownIcons = useWorkspace((s) => shownConfig(s)?.icons);
  const icons = useMemo(() => ({ ...savedIcons, ...shownIcons }), [savedIcons, shownIcons]);
  return (
    <DrawnIconsProvider icons={icons}>
      <StatusBar style={palette.dark ? 'light' : 'dark'} />
      {/* Home Screen (D-271): long-press menu on the Morph icon updates with config changes; opening from the menu or home screen icon directly triggers that quick action. */}
      <HomeScreenBridge platform={nativeHomeScreen} />
      {/* Home screen widgets (D-321-D-323): retrieves triggered operations from widgets and re-renders when config or records change. */}
      <WidgetBridge platform={nativeWidgets} />
      <Stack screenOptions={stackScreenOptions(palette)}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* AI modification page shows no title (D-231), top-left only has 'Close'. */}
        <Stack.Screen name="change" options={{ ...closable, title: '' }} />
        <Stack.Screen name="page/[pageId]" />
        <Stack.Screen name="ai-settings" options={{ title: t(locale, 'aiSettingsTitle') }} />
        <Stack.Screen name="data" options={{ title: t(locale, 'dataTitle') }} />
        {/* Data subpage (D-614); a table's title is the table name, set within the page. */}
        <Stack.Screen name="data-table/[tableId]" options={{ title: '' }} />
        <Stack.Screen name="data-backup" options={{ title: t(locale, 'backupTitle') }} />
        <Stack.Screen name="data-deleted" options={{ title: t(locale, 'recentlyDeleted') }} />
        <Stack.Screen name="data-unused" options={{ title: t(locale, 'unusedTables') }} />
        <Stack.Screen name="data-more" options={{ title: t(locale, 'dataMoreTitle') }} />
        <Stack.Screen name="select-records" options={{ title: t(locale, 'bulkSelectTitle') }} />
        <Stack.Screen name="pick-records" options={{ ...closable, title: '' }} />
        <Stack.Screen name="import-records" options={{ title: t(locale, 'importTitle') }} />
        <Stack.Screen name="storage" options={{ title: t(locale, 'storageTitle') }} />
        <Stack.Screen name="files" options={{ title: t(locale, 'filesAllTitle') }} />
        <Stack.Screen name="packs" options={{ title: t(locale, 'packsTitle') }} />
        <Stack.Screen name="presets" options={{ title: t(locale, 'presetsTitle') }} />
        <Stack.Screen name="open" options={{ ...closable, title: t(locale, 'appLinkTitle') }} />
        {/* Title is in the page (even when in the navigation bar), not duplicated here. */}
        <Stack.Screen name="history" options={{ title: '' }} />
        <Stack.Screen name="tools" options={{ title: '' }} />
        <Stack.Screen name="reminders" options={{ title: t(locale, 'remindersTitle') }} />
        <Stack.Screen name="calendar" options={{ title: t(locale, 'calendarTitle') }} />
        <Stack.Screen name="language" options={{ title: t(locale, 'language') }} />
        <Stack.Screen name="reminder/[workflowId]" options={{ ...closable, title: '' }} />
        <Stack.Screen
          name="quick-actions/index"
          options={{ title: t(locale, '_layout_What_Morph_can_do_8f4f4') }}
        />
        <Stack.Screen name="quick-actions/[kind]" />
        <Stack.Screen name="workflows" options={{ title: t(locale, 'workflowsTitle') }} />
        <Stack.Screen name="workflow/[id]" />
        <Stack.Screen name="record/[collectionId]" options={closable} />
        <Stack.Screen name="new-table" options={closable} />
        <Stack.Screen name="run/[workflowId]" options={closable} />
        <Stack.Screen name="share" options={closable} />
        {/*
         * Viewing one of multiple files (D-457): a modal popup like the inbox page. Regular pages
         * cover the hidden WebView on the root view, causing the PDF preview extension pack page
         * to hang and keep spinning (observed on real devices).
         */}
        <Stack.Screen name="file-preview" options={closable} />
        {/*
         * File desk (D-360): full screen, draws its own top bar. Do not use fullScreenModal: iOS
         * moves the underlying view out of the window, causing the root view's extension pack
         * page (hidden WebView) to hang and keep the PDF preview loading.
         */}
        <Stack.Screen
          name="desk/[deskId]"
          options={{ presentation: 'transparentModal', headerShown: false }}
        />
        <Stack.Screen name="ready/[workflowId]" options={{ ...closable, title: '' }} />
        <Stack.Screen name="table-ready/[collectionId]" options={{ ...closable, title: '' }} />
        <Stack.Screen
          name="widget/[componentId]"
          options={{ headerShown: false, animation: 'none' }}
        />
        <Stack.Screen name="app/[appId]" options={{ headerShown: false, animation: 'none' }} />
        <Stack.Screen
          name="welcome"
          options={{ presentation: 'transparentModal', headerShown: false, gestureEnabled: false }}
        />
      </Stack>
      {/* Only keep one chat box in draft mode (D-190): the shell remounts on every step change, and pushed pages must also use it. */}
      <DraftChatSheet />
      {/* Android: Alert.alert is drawn as an app Dialog that follows the theme. */}
      <AlertHost palette={palette} locale={locale} />
    </DrawnIconsProvider>
  );
}

/** An active workspace: store, database, and the locale it was created with. */
interface Runtime {
  store: WorkspaceStore;
  repo: SQLiteWorkspaceRepo;
  /** The locale this workspace was created with; rebuilding it when the language changes in settings. */
  locale: Locale;
}

/**
 * Open the database, create the workspace, and read it (used on startup, full restore, and undo).
 * strict: throws an error if it cannot be read (enters error state) or if it fails to read the
 * expected expectHeadId version (unreadable or rolled back to old version), preventing incorrect
 * data from being treated as success (full restore, D-600).
 */
async function bootRuntime(strict?: { strict: true; expectHeadId?: number }): Promise<Runtime> {
  const repo = await openRepo();
  try {
    // Language selected in settings (follows system if none selected): read first so the workspace is created accordingly.
    const saved = parseLanguage(await repo.getMeta(LANGUAGE_META_KEY).catch(() => null));
    useLanguage.getState().set(saved);
    const bootLocale = resolveLocale(saved);
    // Register locally downloaded tools first so their configuration passes validation.
    await toolDownloads.getState().load();
    const created = createWorkspaceStore({
      repo,
      provider,
      registry,
      locale: bootLocale,
      now: () => new Date(),
      seed: createStarterWorkspace,
      toolName: (id) =>
        localize(
          toolDownloads.getState().catalog?.tools.find((e) => e.id === id)?.name,
          bootLocale,
        ),
    });
    await created.getState().boot();
    if (strict) {
      const { status, head, error } = created.getState();
      if (status !== 'ready') throw new Error(error ?? 'The workspace could not be read');
      if (strict.expectHeadId !== undefined && head?.id !== strict.expectHeadId) {
        throw new Error('The workspace fell back to an older version');
      }
    }
    await useGuide.getState().load(repo);
    void toolDownloads.getState().refresh(CATALOG_DAY_MS);
    // Deleted quick actions no longer remember their folder (D-196).
    const booted = created.getState().config;
    if (booted) expoFilePlatform.forgetFolders(quickActionsOf(booted).map((w) => w.id));
    return { store: created, repo, locale: bootLocale };
  } catch (e) {
    // Failed to read: close the newly opened one to avoid keeping a database pointing to the wrong place.
    await closeRepo().catch(() => undefined);
    throw e;
  }
}

export default function RootLayout() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const locale = resolveLocale(useLanguage((s) => s.preference));
  const [error, setError] = useState<string | null>(null);
  // Clicked 'Open as usual' on the fallback page after startup error: start again.
  const [bootTry, setBootTry] = useState(0);
  const actions = useMemo(() => rescueActions(locale), [locale]);
  // Default Clay style fonts (Sora for headings, Karla for body). Falls back to system fonts on load failure without blocking startup.
  const [fontsLoaded, fontError] = useFonts({
    [CLAY_FONTS.heading]: Sora_700Bold,
    [CLAY_FONTS.title]: Sora_600SemiBold,
    [CLAY_FONTS.body]: Karla_400Regular,
    Karla_400Regular_Italic,
    [CLAY_FONTS.bodyMedium]: Karla_500Medium,
    [CLAY_FONTS.bodyBold]: Karla_700Bold,
    // Inter (D-591): used by themes with font: "inter".
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    (async () => {
      await aiSettings.getState().load();
      const booted = await bootRuntime();
      // Temporary files left over from the previous run that weren't deleted in time (D-063).
      await expoFilePlatform.removeAllRuns().catch(() => undefined);
      // Copies left in cache by the file picker when exiting without finishing processing during the previous session.
      await expoFilePlatform.removeStalePickerCopies().catch(() => undefined);
      openStartApp(booted.store);
      setRuntime(booted);
    })().catch((e) => setError(String(e)));
  }, [bootTry]);

  // The "waiting for result" flag left behind after handing over to another AI app last time (read-only file, no write): preserved even if Android kills the process when the user leaves.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    attachReturnStore(expoReturnStore);
  }, []);

  // Main page displayed normally for a moment: startup considered successful, reset startup fallback counter (health check 6.6).
  const ready = Boolean(runtime) && (fontsLoaded || Boolean(fontError));
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => markHealthy(expoAttemptStore), HEALTHY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // Full restore and undo (D-600): close the database and unmount the UI before changing data
  // directories (preventing any UI from touching the closed database), reopen and recreate the
  // workspace after the switch, and read back successfully to confirm; throws an error on read
  // failure so the backup process can revert to old data and retry.
  const rebuilt = useRef<Runtime | null>(null);
  const [homeSignal, setHomeSignal] = useState(0);
  useEffect(() => {
    registerBackupRuntime({
      async release() {
        rebuilt.current = null;
        setRuntime(null);
        await closeRepo();
      },
      async reload(expectHeadId) {
        try {
          const next = await bootRuntime({ strict: true, expectHeadId });
          rebuilt.current = next;
          setError(null);
          setRuntime(next);
        } catch (e) {
          // UI is unmounted at this point: when even reverting to old data fails to read, at least show what error occurred rather than infinite spinning.
          setError(String(e));
          throw e;
        }
      },
      notify(kind) {
        const next = rebuilt.current;
        if (!next) return;
        // Return to home (after UI mounts with new data): previously opened pages may no longer exist in the new data.
        setHomeSignal((n) => n + 1);
        const message = {
          restored: 'backupRestored',
          undone: 'backupUndone',
          undoFailed: 'backupUndoFailed',
        } as const;
        next.store.getState().showToast({
          message: t(next.locale, message[kind]),
          ...(kind === 'restored' ? { undoRestore: true } : {}),
        });
        // Restore prompt no longer appears (timed out, closed, or replaced by another prompt): pre-restore data can no longer be undone, delete it.
        if (kind === 'restored') {
          const off = next.store.subscribe((state) => {
            if (state.toast?.undoRestore) return;
            off();
            void getBackup().discardPrevious();
          });
        }
      },
    });
    return () => registerBackupRuntime(null);
  }, []);
  useEffect(() => {
    if (homeSignal === 0) return;
    const timer = setTimeout(() => {
      try {
        if (router.canDismiss()) router.dismissAll();
        router.replace('/');
      } catch {
        // Navigator not yet mounted: stay on the current page.
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [homeSignal]);

  // Language changed in settings: rebuild the workspace on the same database using the new language (store copy and validation messages carry the new language).
  const builtLocale = runtime?.locale;
  useEffect(() => {
    if (!runtime || builtLocale === locale) return;
    let alive = true;
    void (async () => {
      const created = createWorkspaceStore({
        repo: runtime.repo,
        provider,
        registry,
        locale,
        now: () => new Date(),
        seed: createStarterWorkspace,
        toolName: (id) =>
          localize(toolDownloads.getState().catalog?.tools.find((e) => e.id === id)?.name, locale),
      });
      await created.getState().boot();
      if (alive) setRuntime({ store: created, repo: runtime.repo, locale });
    })().catch((e) => setError(String(e)));
    return () => {
      alive = false;
    };
  }, [runtime, builtLocale, locale]);

  if (!runtime && error)
    return (
      <RescueScreen
        locale={locale}
        error={error}
        actions={actions}
        onContinue={() => {
          setError(null);
          setBootTry((n) => n + 1);
        }}
      />
    );
  if (!runtime || !ready) {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AISettingsProvider store={aiSettings}>
        <WorkspaceProvider
          value={{
            store: runtime.store,
            repo: runtime.repo,
            files: expoFilePlatform,
            registry,
            locale: runtime.locale,
          }}>
          <PackHostProvider value={packs}>
            <ToolDownloadsProvider value={toolDownloads}>
              <HomeScreenProvider value={nativeHomeScreen}>
                <WidgetProvider value={nativeWidgets}>
                  <RootStack />
                </WidgetProvider>
              </HomeScreenProvider>
            </ToolDownloadsProvider>
          </PackHostProvider>
        </WorkspaceProvider>
      </AISettingsProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});

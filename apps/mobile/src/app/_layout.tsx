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
import { createWorkspaceStore, type WorkspaceStore } from '@/workspace/store';
import { WidgetProvider } from '@/widgets/context';
import { nativeWidgets } from '@/widgets/native';
import { WidgetBridge } from '@/widgets/useWidgets';

// 扩展包（D-064、D-510）：App 里唯一的 PackStore，见 expo-pack-fs.ts。
const packs = { store: expoPackStore, bridge: new PackBridge(expoBridgeFiles(expoPackStore)) };
const registry = createRegistry(BUILTIN_TOOLS);
// 从服务器下载的工具（D-177、D-178）：目录地址不是秘密；开发版另外信任仓库里的开发公钥。
const toolsUrl = process.env.EXPO_PUBLIC_MORPH_TOOLS_URL;
const toolDownloads = createToolDownloads({
  store: new ToolDownloadStore(expoToolFs, expoSha256, {
    baseUrl: toolsUrl ?? '',
    trustedKeys: trustedToolKeys(__DEV__),
  }),
  registry,
  configured: Boolean(toolsUrl),
});
/** 启动时目录超过一天没拉就拉一次（停用名单靠它生效，D-178）。 */
const CATALOG_DAY_MS = 24 * 60 * 60 * 1000;
// AI 来源由「设置 → AI」决定：内置规则、Morph 服务器（需配置地址，见 README）或用户自带 key。
const apiUrl = process.env.EXPO_PUBLIC_MORPH_API_URL;
// 平台和版本随需求（D-189）和测试期保存的请求（D-240）发给服务器。
const appInfo = {
  ...(Platform.OS === 'ios' || Platform.OS === 'android' ? { platform: Platform.OS } : {}),
  ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
};
const aiSettings = createAISettingsStore({
  secrets: secureSecretStore,
  serverAvailable: Boolean(apiUrl),
  // 需求回收（D-189）：配置了服务器地址时，AI 做不到的那句话可以由用户点一下发过去。
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
  // 读工作空间出错：兜底页（体检 6.6），「照常打开」再读一次。
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
  // 别的 App 分享进来的文件 → 收件页面（D-114）。
  useIncomingShare(expoFilePlatform);
  // 提醒：配置或记录变了就重排；点提醒只打开页面或快捷操作（D-251）。
  useReminderSync(reminders);
  useReminderOpen(reminders);
  useReminderActionFeedback(onReminderAction);
  const palette = usePalette(theme);
  const closable = { presentation: 'modal', ...closeButtonOption(palette) } as const;
  return (
    <>
      <StatusBar style={palette.dark ? 'light' : 'dark'} />
      {/* 手机桌面（D-271）：长按 Morph 图标的菜单跟着配置变；从菜单或桌面图标打开时直接开始那个快捷操作。 */}
      <HomeScreenBridge platform={nativeHomeScreen} />
      {/* 桌面小组件（D-321–D-323）：取走小组件上点了的操作，配置或记录变了就重算画面。 */}
      <WidgetBridge platform={nativeWidgets} />
      <Stack screenOptions={stackScreenOptions(palette)}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* AI 修改页不显示标题（D-231），左上角只有「关闭」。 */}
        <Stack.Screen name="change" options={{ ...closable, title: '' }} />
        <Stack.Screen name="page/[pageId]" />
        <Stack.Screen name="ai-settings" options={{ title: t(locale, 'aiSettingsTitle') }} />
        <Stack.Screen name="data" options={{ title: t(locale, 'dataTitle') }} />
        {/* 数据的子页面（D-614）；一张表的标题是表名，在页面里设。 */}
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
        {/* 标题在页面里（放在导航栏时也要），这里不再写一遍。 */}
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
        {/* 多个文件里点开一个看（D-457）：和收件页面一样是弹出页。普通页面会盖住根视图上隐藏的 WebView，PDF 预览
            用的扩展包页面跟着被挂起，一直转圈（真机上发现）。 */}
        <Stack.Screen name="file-preview" options={closable} />
        {/* 文件房间（D-360）：全屏，自己画顶栏。不用 fullScreenModal：iOS 会把底下的视图拿出窗口，
            根视图上的扩展包页面（隐藏的 WebView）跟着被挂起，PDF 预览一直装载。 */}
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
      {/* 草稿模式的聊天框只放一个（D-190）：外壳每改一步会重新挂载，推入的页面也要用它。 */}
      <DraftChatSheet />
    </>
  );
}

/** 一个正在用的工作空间：store、数据库、建它时的语言。 */
interface Runtime {
  store: WorkspaceStore;
  repo: SQLiteWorkspaceRepo;
  /** 这个工作空间是按哪种语言建的；设置里改了语言就按新的重建。 */
  locale: Locale;
}

/**
 * 打开数据库、建工作空间并读出来（启动、整体恢复和撤销之后都走这里）。
 * strict：读不出来（进入错误状态）、或者没有读到 expectHeadId 那个版本（读不懂、退回了旧版本）就抛错，
 * 不把读不对的数据当成功（整体恢复，D-600）。
 */
async function bootRuntime(strict?: { strict: true; expectHeadId?: number }): Promise<Runtime> {
  const repo = await openRepo();
  try {
    // 设置里选的语言（没选就跟随系统）：先读出来，工作空间按它建。
    const saved = parseLanguage(await repo.getMeta(LANGUAGE_META_KEY).catch(() => null));
    useLanguage.getState().set(saved);
    const bootLocale = resolveLocale(saved);
    // 先把本机下载过的工具注册进来，用到它们的配置才校验得过。
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
    // 已经删掉的快捷操作不再记着文件夹（D-196）。
    const booted = created.getState().config;
    if (booted) expoFilePlatform.forgetFolders(quickActionsOf(booted).map((w) => w.id));
    return { store: created, repo, locale: bootLocale };
  } catch (e) {
    // 没读好：关掉刚打开的，免得留着一个指向错地方的数据库。
    await closeRepo().catch(() => undefined);
    throw e;
  }
}

export default function RootLayout() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const locale = resolveLocale(useLanguage((s) => s.preference));
  const [error, setError] = useState<string | null>(null);
  // 启动出错后在兜底页点了「照常打开」：再启动一次。
  const [bootTry, setBootTry] = useState(0);
  const actions = useMemo(() => rescueActions(locale), [locale]);
  // 默认风格 Clay 的字体（Sora 标题、Karla 正文）。加载失败时退回系统字体，不阻塞启动。
  const [fontsLoaded, fontError] = useFonts({
    [CLAY_FONTS.heading]: Sora_700Bold,
    [CLAY_FONTS.title]: Sora_600SemiBold,
    [CLAY_FONTS.body]: Karla_400Regular,
    Karla_400Regular_Italic,
    [CLAY_FONTS.bodyMedium]: Karla_500Medium,
    [CLAY_FONTS.bodyBold]: Karla_700Bold,
    // Inter（D-591）：选了 font: "inter" 的主题用。
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    (async () => {
      await aiSettings.getState().load();
      const booted = await bootRuntime();
      // 上次运行没来得及删除的临时文件（D-063）。
      await expoFilePlatform.removeAllRuns().catch(() => undefined);
      // 上次在 App 里选了文件、没有处理完就退出时，选择器留在缓存里的副本。
      await expoFilePlatform.removeStalePickerCopies().catch(() => undefined);
      setRuntime(booted);
    })().catch((e) => setError(String(e)));
  }, [bootTry]);

  // 主页正常显示了一会儿：这次启动算成功，启动兜底从零数起（体检 6.6）。
  const ready = Boolean(runtime) && (fontsLoaded || Boolean(fontError));
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => markHealthy(expoAttemptStore), HEALTHY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // 整体恢复和撤销（D-600）：换数据目录前关掉数据库并卸下界面（不让任何界面碰关掉的数据库），换完后重开、
  // 重建工作空间，读回来才算成功；读不回来就抛错，由备份流程换回旧数据再来一遍。
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
          // 界面这时是卸下的：连换回旧数据也读不回来时，至少显示出了什么错，而不是一直转圈。
          setError(String(e));
          throw e;
        }
      },
      notify(kind) {
        const next = rebuilt.current;
        if (!next) return;
        // 回到主页（界面换了新数据重新挂上之后）：恢复之前打开的页面在新数据里不一定还在。
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
        // 恢复提示不再出现（到时间、关掉、被别的提示换掉）：恢复之前的数据不再能撤销，删掉。
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
        // 导航器还没挂好：留在原来的页面。
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [homeSignal]);

  // 设置里改了语言：同一个数据库，按新语言重建工作空间（store 里的文案、校验提示都带着语言）。
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

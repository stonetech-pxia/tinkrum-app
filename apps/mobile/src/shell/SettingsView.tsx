import {
  CURRENT_SCHEMA_VERSION,
  appFileOfApp,
  appFileText,
  appResetOps,
  appTarget,
  homeScreenFull,
  homeScreenOp,
  remindersOf,
  type AppFile,
  type IconValue,
} from '@morph/core';
import { MODELS } from '@morph/planner';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Text } from 'react-native';

import { useAISettings } from '../ai/context';
import { useHomeScreenPlatform } from '../home-screen/context';
import { homeScreenEntries } from '../home-screen/useHomeScreen';
import { useWorkflowChange } from '../run/workflow-change';
import { useLanguage } from '../language';
import { t, type StringKey } from '../i18n';
import type { RenderEnv } from '../renderer/components';
import { ListRow, PageTitle, SectionLabel } from '../renderer/ui';
import { loadAppOrigin } from '../apps/origin';
import { AppIconPicker, AppMenuRow, AppMenuSheet } from './AppMenu';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';

/**
 * 设置页由内核固定提供「AI 修改」「历史版本」「工具」入口（§5.1）：
 * 导航栏和浮动按钮里可以没有它们，但设置本身必须始终可达，所以随时都能修改和撤销。
 */
export function SettingsView({ env }: { env: RenderEnv }) {
  const { palette, locale } = env;
  const headId = useWorkspace((s) => s.head!.id);
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const preference = useLanguage((s) => s.preference);
  const aiMode = useAISettings((s) => s.mode);
  const aiModel = useAISettings((s) => s.model);
  const aiProvider = useAISettings((s) => s.provider);
  const aiCustomModel = useAISettings((s) => s.customModel);
  const aiValue =
    aiMode === 'byok'
      ? t(locale, 'aiEngineByok', {
          model:
            aiProvider === 'openai'
              ? aiCustomModel
              : (MODELS.find((m) => m.id === aiModel)?.name ?? aiModel),
        })
      : t(locale, aiMode === 'server' ? 'aiEngineRemote' : 'aiEngineMock');
  // 长按一个 App：放到手机桌面的菜单里，或拿掉；Android 上放进去以后还能单独放一个图标（D-271、D-485）；
  // 换图标（D-606）。picking：菜单里正在选图标。
  const [menu, setMenu] = useState<{
    appId: string;
    origin: AppFile | null;
    picking: boolean;
  } | null>(null);
  const change = useWorkflowChange();
  const homeScreen = useHomeScreenPlatform();
  const { repo, registry, files } = useWorkspaceContext();
  const proposeOps = useWorkspace((s) => s.proposeOps);
  const confirm = useWorkspace((s) => s.confirm);
  const cancel = useWorkspace((s) => s.cancel);

  /** 恢复这个 App 的初始样子（D-485）：先预览，确认后生效，能在改动记录里撤销；记录一条不动。 */
  async function restoreApp(appId: string, name: string, origin: AppFile) {
    const plan = appResetOps(origin, env.config, registry);
    if (!plan.ok) {
      Alert.alert(t(locale, 'appResetItem'), t(locale, 'importAppClash', { reason: plan.error }));
      return;
    }
    const result = await proposeOps(plan.ops, t(locale, 'appResetSummary', { name }), {
      fromAppFile: true,
    });
    if (result.kind !== 'preview') {
      Alert.alert(
        t(locale, 'invalidPlan'),
        result.kind === 'invalid' ? result.issues.join('\n') : result.message,
      );
      return;
    }
    Alert.alert(
      name,
      [t(locale, 'appResetConfirm', { name }), ...result.proposal.lines].join('\n'),
      [
        { text: t(locale, 'cancel'), style: 'cancel', onPress: () => void cancel() },
        { text: t(locale, 'presetApply'), onPress: () => void confirm() },
      ],
    );
  }

  async function openAppMenu(appId: string) {
    // 从文件导入的 App 才有初始样子；Tink 或自己搭的没有，不显示这一项。
    setMenu({ appId, origin: await loadAppOrigin(repo, appId), picking: false });
  }

  /** 菜单里的项：点了先收起菜单再做。 */
  function appMenuItems(appId: string, name: string, origin: AppFile | null) {
    const id = appTarget(appId);
    const onHome = (env.config.nav.phoneHomeScreen ?? []).includes(id);
    const toggle = () => {
      if (!onHome && homeScreenFull(env.config)) {
        Alert.alert(t(locale, 'homeScreenFull'));
        return;
      }
      void change(
        [homeScreenOp(env.config, id, !onHome)],
        t(locale, onHome ? 'homeScreenRemoved' : 'homeScreenAdded', { name }),
      );
    };
    // Android：在桌面上单独放一个图标，画的是这个 App 自己的图标（D-606）。系统弹确认框，用户决定。
    const pin = () => {
      const entry = homeScreenEntries(env.config).find((e) => e.id === id);
      if (entry)
        void homeScreen?.pin(entry).then((sent) => {
          if (!sent) Alert.alert(t(locale, 'homeScreenPinFailed'));
        });
    };
    // 分享这个 App（D-545）：只有结构，用户文件的引用清空；用户自己点了才发出去（底线 3、10、14）。
    const share = () => {
      const file = appFileOfApp(env.config, appId);
      if (file)
        void files.shareText(
          `tinkrum-app-${appId}.json`,
          appFileText(file, new Date()),
          'application/json',
        );
    };
    return [
      { id: 'home', label: t(locale, onHome ? 'homeScreenRemove' : 'homeScreenAdd'), run: toggle },
      ...(onHome && homeScreen?.canPin()
        ? [{ id: 'pin', label: t(locale, 'homeScreenPin'), run: pin }]
        : []),
      // 这一项不收起菜单：菜单里换成选图标的格子。
      {
        id: 'icon',
        label: t(locale, 'appIconItem'),
        run: () => setMenu({ appId, origin, picking: true }),
      },
      { id: 'share', label: t(locale, 'shareAppItem'), run: share },
      ...(origin
        ? [
            {
              id: 'reset',
              label: t(locale, 'appResetItem'),
              run: () => void restoreApp(appId, name, origin),
            },
          ]
        : []),
    ];
  }

  /** 换图标（D-606）：用户点的就是确认，直接生效，能在改动记录里撤销。 */
  function pickIcon(appId: string, name: string, icon: IconValue) {
    setMenu(null);
    void change(
      [{ op: 'updateContainer', app: { id: appId, icon } }],
      t(locale, 'appIconChanged', { name }),
    );
  }

  const menuApp = menu ? (env.config.nav.apps ?? []).find((a) => a.id === menu.appId) : undefined;
  return (
    <ScrollView
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 160 }}>
      {menu && menuApp ? (
        <AppMenuSheet
          palette={palette}
          locale={locale}
          title={menuApp.name}
          onClose={() => setMenu(null)}>
          {menu.picking ? (
            <AppIconPicker
              palette={palette}
              locale={locale}
              current={menuApp.icon ?? 'apps'}
              onPick={(icon) => pickIcon(menuApp.id, menuApp.name, icon)}
            />
          ) : (
            appMenuItems(menuApp.id, menuApp.name, menu.origin).map((item) => (
              <AppMenuRow
                key={item.id}
                id={`app-menu-${item.id}`}
                label={item.label}
                palette={palette}
                onPress={() => {
                  setMenu(null);
                  item.run();
                }}
              />
            ))
          )}
        </AppMenuSheet>
      ) : null}
      <PageTitle palette={palette}>{t(locale, 'settingsTitle')}</PageTitle>
      {/* 我的 App（D-485）：入口可以没有，这里一定进得去。系统层，AI 改不了。 */}
      {(env.config.nav.apps ?? []).length > 0 ? (
        <>
          <SectionLabel palette={palette}>{t(locale, 'settingsMyApps')}</SectionLabel>
          {(env.config.nav.apps ?? []).map((app) => {
            const onHome = (env.config.nav.phoneHomeScreen ?? []).includes(appTarget(app.id));
            return (
              <ListRow
                key={app.id}
                palette={palette}
                testID={`settings-app-${app.id}`}
                icon={app.icon ?? 'apps'}
                label={app.name}
                {...(onHome ? { value: t(locale, 'settingsAppOnHome') } : {})}
                onPress={env.locked ?? (() => env.navigate(appTarget(app.id)))}
                onLongPress={env.locked ?? (() => void openAppMenu(app.id))}
              />
            );
          })}
          <Text style={[palette.font('body', 13), { color: palette.muted }]}>
            {t(locale, 'settingsMyAppsHint')}
          </Text>
        </>
      ) : null}
      <SectionLabel palette={palette}>{t(locale, 'thisApp')}</SectionLabel>
      <ListRow
        palette={palette}
        testID="settings-ai"
        icon="tink"
        label={t(locale, 'changeTitle')}
        value={t(locale, 'changeRowHint')}
        onPress={env.locked ?? (() => router.push('/change'))}
      />
      <ListRow
        palette={palette}
        testID="settings-history"
        icon="history"
        label={t(locale, 'openHistory')}
        value={t(locale, 'historyRowHint')}
        onPress={() => router.push('/history')}
      />
      {remindersOf(env.config).length > 0 ? (
        <ListRow
          palette={palette}
          testID="settings-reminders"
          icon="calendar"
          label={t(locale, 'remindersTitle')}
          value={t(locale, 'remindersRowHint', { n: remindersOf(env.config).length })}
          onPress={env.locked ?? (() => router.push('/reminders'))}
        />
      ) : null}
      <ListRow
        palette={palette}
        testID="settings-more"
        icon="folder"
        label={t(locale, 'settingsMoreTitle')}
        onPress={() => setMoreOpen((open) => !open)}
      />
      {/* 点开才看到：我的预设、数据、存储空间、已下载内容。 */}
      {moreOpen ? (
        <>
          <ListRow
            palette={palette}
            testID="settings-presets"
            icon="bookmark"
            label={t(locale, 'presetsTitle')}
            value={t(locale, 'presetsRowHint')}
            onPress={env.locked ?? (() => router.push('/presets'))}
          />
          <ListRow
            palette={palette}
            testID="settings-data"
            icon="inbox"
            label={t(locale, 'dataTitle')}
            value={t(locale, 'dataRowHint')}
            onPress={env.locked ?? (() => router.push('/data'))}
          />
          <ListRow
            palette={palette}
            testID="settings-storage"
            icon="folder"
            label={t(locale, 'storageTitle')}
            value={t(locale, 'storageRowHint')}
            onPress={env.locked ?? (() => router.push('/storage'))}
          />
          <ListRow
            palette={palette}
            testID="settings-packs"
            icon="archive"
            label={t(locale, 'packsTitle')}
            onPress={env.locked ?? (() => router.push('/packs'))}
          />
        </>
      ) : null}
      <SectionLabel palette={palette}>{t(locale, 'general')}</SectionLabel>
      <ListRow
        palette={palette}
        testID="settings-language"
        label={t(locale, 'language')}
        value={t(locale, `languageValue_${preference}` as StringKey)}
        onPress={() => router.push('/language')}
      />
      <ListRow
        palette={palette}
        label={t(locale, 'aiEngine')}
        value={aiValue}
        onPress={env.locked ?? (() => router.push('/ai-settings'))}
      />
      <ListRow
        palette={palette}
        label={t(locale, 'about')}
        value={t(locale, 'aboutValue', { schema: CURRENT_SCHEMA_VERSION, revision: headId })}
      />
      <Text
        testID="settings-trust"
        style={[palette.font('body', 13), { color: palette.muted, lineHeight: 20 }]}>
        {t(locale, 'trustNote')}
      </Text>
    </ScrollView>
  );
}

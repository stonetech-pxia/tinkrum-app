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
 * The settings page fixedly provides "AI modify", "Version history", and "Tools" entry points via
 * the core (§5.1): they may be absent from the navigation bar or floating button, but settings
 * itself must always remain reachable, so modifications and undos are possible at any time.
 */
export function SettingsView({ env }: { env: RenderEnv }) {
  const { palette, locale } = env;
  const headId = useWorkspace((s) => s.head!.id);
  const router = useRouter();
  const preference = useLanguage((s) => s.preference);
  const aiMode = useAISettings((s) => s.mode);
  const aiModel = useAISettings((s) => s.model);
  const aiProvider = useAISettings((s) => s.provider);
  const aiCustomModel = useAISettings((s) => s.customModel);
  const tinkAgent = useAISettings((s) => s.tinkAgent);
  const tinkValue =
    aiMode === 'byok'
      ? t(locale, 'aiEngineByok', {
          model:
            aiProvider === 'openai'
              ? aiCustomModel
              : (MODELS.find((m) => m.id === aiModel)?.name ?? aiModel),
        })
      : t(locale, aiMode === 'server' ? 'aiEngineRemote' : 'aiEngineMock');
  const aiValue = tinkAgent ? tinkValue : t(locale, 'aiAgentOther');
  // Long-press an App: menu options to place it on the mobile home screen, or remove it; on
  // Android, once placed, an individual icon can also be placed separately (D-271, D-485); change
  // icon (D-606). picking: currently selecting an icon in the menu.
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

  /** Restore this App to its initial state (D-485): preview first, take effect upon confirmation, can be undone in change history; records remain completely untouched. */
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
    // Only Apps imported from files have an initial state; those created by Tink or oneself do not, so this item is not displayed.
    setMenu({ appId, origin: await loadAppOrigin(repo, appId), picking: false });
  }

  /** Items in the menu: tap to collapse the menu first before performing the action. */
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
    // Android: place an individual icon on the home screen displaying this App's own icon (D-606). The system prompts a confirmation dialog, and the user decides.
    const pin = () => {
      const entry = homeScreenEntries(env.config).find((e) => e.id === id);
      if (entry)
        void homeScreen?.pin(entry).then((sent) => {
          if (!sent) Alert.alert(t(locale, 'homeScreenPinFailed'));
        });
    };
    // Share this App (D-545): structure only, user file references are cleared; sent only after the user explicitly taps it (Invariants 3, 10, 14).
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
      // This item does not collapse the menu: the menu switches to an icon selection grid.
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

  /** Change icon (D-606): what the user taps is confirmation, taking effect immediately, and can be undone in change history. */
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
      {/* My Apps (D-485): the entry point may be absent, but this is always accessible. System layer, cannot be modified by AI. */}
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
      {/* Apps, presets, data, and storage space each occupy a single row without further collapsing (D-614); downloaded content is under "Data -> More". */}
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

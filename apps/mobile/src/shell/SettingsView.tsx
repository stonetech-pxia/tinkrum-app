import { CURRENT_SCHEMA_VERSION, appTarget, remindersOf } from '@morph/core';
import { MODELS } from '@morph/planner';
import { useRouter } from 'expo-router';
import { ScrollView, Text } from 'react-native';

import { useAISettings } from '../ai/context';
import { useLanguage } from '../language';
import { t, type StringKey } from '../i18n';
import type { RenderEnv } from '../renderer/components';
import { ListRow, PageTitle, SectionLabel } from '../renderer/ui';
import { useWorkspace } from '../workspace/context';
import { useAppMenu } from './useAppMenu';

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
  const { openAppMenu, appMenu } = useAppMenu(env);

  return (
    <ScrollView
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 160 }}>
      {appMenu}
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
                onLongPress={env.locked ?? (() => openAppMenu(app.id))}
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

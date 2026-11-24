import { ScrollView, Text, View } from 'react-native';

import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { LocalModelCard } from '@/packs/LocalModelCard';
import { Card, ListRow, Pill, SectionLabel } from '@/renderer/ui';

/**
 * 'Data -> More' (D-614): lesser-used items placed here. Export app design (entire config);
 * export form memory, restore from file, clear (D-244); on-device model (D-396); downloaded
 * content. System layer, cannot be modified by AI (invariant 8).
 */
export default function DataMoreRoute() {
  const data = useDataOverview();
  const { locale, palette, router, layouts, picks } = data;
  const caption = [palette.font('body', 13), { color: palette.muted }];

  return (
    <ScrollView
      testID="data-more-screen"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      <SectionLabel palette={palette}>{t(locale, 'appConfigTitle')}</SectionLabel>
      <Card palette={palette} testID="app-config">
        <Text style={caption}>{t(locale, 'appConfigHint')}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pill
            palette={palette}
            testID="export-app-config"
            label={t(locale, 'exportAppConfig')}
            onPress={() => void data.exportConfig()}
          />
        </View>
      </Card>

      <SectionLabel palette={palette}>{t(locale, 'prefillMemoryTitle')}</SectionLabel>
      <Card palette={palette} testID="prefill-memory">
        <Text style={[palette.font('title', 15), { color: palette.text }]}>
          {layouts > 0 || picks === 0
            ? layouts > 0
              ? t(locale, 'prefillMemoryCount', { count: layouts })
              : t(locale, 'prefillMemoryNone')
            : null}
          {layouts > 0 && picks > 0 ? '\n' : ''}
          {picks > 0 ? t(locale, 'prefillMemoryPicks', { count: picks }) : null}
        </Text>
        <Text style={caption}>{t(locale, 'prefillMemoryHint')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {layouts + picks > 0 ? (
            <Pill
              palette={palette}
              testID="export-prefill-memory"
              label={t(locale, 'prefillMemoryExport')}
              onPress={() => void data.exportMemory()}
            />
          ) : null}
          <Pill
            palette={palette}
            testID="restore-prefill-memory"
            label={t(locale, 'prefillMemoryRestore')}
            onPress={() => void data.restoreMemory()}
          />
          {layouts + picks > 0 ? (
            <Pill
              palette={palette}
              danger
              testID="clear-prefill-memory"
              label={t(locale, 'prefillMemoryClear')}
              onPress={data.clearMemory}
            />
          ) : null}
        </View>
      </Card>

      <LocalModelCard palette={palette} locale={locale} />

      <ListRow
        palette={palette}
        testID="settings-packs"
        icon="archive"
        label={t(locale, 'packsTitle')}
        onPress={() => router.push('/packs')}
      />
    </ScrollView>
  );
}

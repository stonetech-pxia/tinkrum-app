import { ScrollView, Text, View } from 'react-native';

import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { Card, Pill } from '@/renderer/ui';

/**
 * 'Data -> Unused Data' (D-038, D-041, separate page since D-614): tables removed from the UI
 * that still contain records. Exportable, permanently deletable (with confirmation). System
 * layer, cannot be modified by AI (invariant 8).
 */
export default function DataUnusedRoute() {
  const data = useDataOverview();
  const { locale, palette, orphans, name } = data;
  const caption = [palette.font('body', 13), { color: palette.muted }];

  return (
    <ScrollView
      testID="data-unused-screen"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      <Text style={caption}>{t(locale, 'unusedTablesHint')}</Text>
      {orphans.map((o) => (
        <Card key={o.id} palette={palette} testID={`orphan-${o.id}`}>
          <Text style={[palette.font('title', 16), { color: palette.text }]}>
            {name(o.collection, o.id)}
          </Text>
          <Text style={caption}>{t(locale, 'recordCount', { count: o.count })}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {o.collection ? (
              <Pill
                palette={palette}
                testID={`export-${o.id}`}
                label={t(locale, 'exportCsv')}
                onPress={() => void data.exportCsv(o.collection!)}
              />
            ) : null}
            <Pill
              palette={palette}
              danger
              testID={`purge-${o.id}`}
              label={t(locale, 'deleteForever')}
              onPress={() => data.deleteForever(o.id, name(o.collection, o.id), o.count)}
            />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

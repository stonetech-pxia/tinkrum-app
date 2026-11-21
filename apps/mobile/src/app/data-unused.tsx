import { ScrollView, Text, View } from 'react-native';

import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { Card, Pill } from '@/renderer/ui';

/**
 * 「数据 → 不在界面里的数据」（D-038、D-041，D-614 起单独一页）：从界面上拿掉的表还有记录。
 * 能导出，能永久删除（先问）。系统层，AI 不能修改（底线 8）。
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

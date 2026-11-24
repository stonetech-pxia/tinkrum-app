import { formatRef, formatTimestamp } from '@morph/core';
import { ScrollView, Text, View } from 'react-native';

import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { Card, Pill } from '@/renderer/ui';

/** 'Data -> Recently Deleted' (D-037, separate page since D-614): kept for 30 days, restorable. System layer, cannot be modified by AI (invariant 8). */
export default function DataDeletedRoute() {
  const { locale, palette, deleted, known, name, actions } = useDataOverview();
  const caption = [palette.font('body', 13), { color: palette.muted }];

  return (
    <ScrollView
      testID="data-deleted-screen"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      <Text style={caption}>{t(locale, 'recentlyDeletedHint')}</Text>
      {deleted.length === 0 ? (
        <Card palette={palette}>
          <Text style={caption}>{t(locale, 'nothingDeleted')}</Text>
        </Card>
      ) : (
        deleted.map((r) => {
          const c = known.get(r.collectionId);
          const first = c?.fields.find((f) => f.type === 'text') ?? c?.fields[0];
          const title = c && first ? formatRef(r, c, first.id, locale) : '';
          return (
            <Card key={r.id} palette={palette} testID={`deleted-${r.id}`}>
              <Text style={[palette.font('title', 15), { color: palette.text }]}>
                {title || '—'}
              </Text>
              <Text style={caption}>
                {name(c ?? null, r.collectionId)} · {formatTimestamp(r.deletedAt!, locale)}
              </Text>
              <View style={{ flexDirection: 'row' }}>
                <Pill
                  palette={palette}
                  testID={`restore-record-${r.id}`}
                  label={t(locale, 'restore')}
                  onPress={() => void actions.restore(r.id)}
                />
              </View>
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

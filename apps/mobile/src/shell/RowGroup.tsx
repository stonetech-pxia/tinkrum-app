import { Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/renderer/ui';
import { onSurface, type Palette } from '@/renderer/theme';

export interface GroupRow {
  testID: string;
  label: string;
  value?: string;
  /** Small text at the end of a row (such as entry count). */
  trailing?: string;
  onPress?: () => void;
  /** Button at the end of a row (preset "..."): when present, tapping this row still triggers onPress. */
  extra?: ReactNode;
}

/**
 * Several rows in a card, separated by thin lines (D-614): system-layer lists (tables in data,
 * presets) take up too much vertical space if each row is a separate card, and scrolling becomes
 * tedious when there are many tables. Used only in system pages like settings, not part of
 * configuration.
 */
export function RowGroup({ palette: pagePalette, rows }: { palette: Palette; rows: GroupRow[] }) {
  const palette = onSurface(pagePalette);
  if (rows.length === 0) return null;
  return (
    <Card palette={palette} style={styles.card}>
      {rows.map((row, i) => (
        <Fragment key={row.testID}>
          {i > 0 ? <View style={[styles.line, { backgroundColor: palette.border }]} /> : null}
          <Pressable
            testID={row.testID}
            accessibilityRole={row.onPress ? 'button' : undefined}
            disabled={!row.onPress}
            onPress={row.onPress}
            style={({ pressed }) => [
              styles.row,
              { paddingHorizontal: palette.inset, opacity: pressed ? 0.6 : 1 },
            ]}>
            <View style={styles.text}>
              <Text style={[palette.font('title', 16), { color: palette.text }]}>{row.label}</Text>
              {row.value ? (
                <Text style={[palette.font('body', 13), { color: palette.muted }]}>
                  {row.value}
                </Text>
              ) : null}
            </View>
            {row.trailing ? (
              <Text style={[palette.font('body', 14), { color: palette.muted }]}>
                {row.trailing}
              </Text>
            ) : null}
            {row.extra ??
              (row.onPress ? (
                <Text style={[palette.font('title', 20), { color: palette.caption }]}>›</Text>
              ) : null)}
          </Pressable>
        </Fragment>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 0, paddingVertical: 4, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  text: { flex: 1, gap: 2 },
  line: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
});

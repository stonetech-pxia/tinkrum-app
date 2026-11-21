import { Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/renderer/ui';
import { onSurface, type Palette } from '@/renderer/theme';

export interface GroupRow {
  testID: string;
  label: string;
  value?: string;
  /** 行尾的小字（条数之类）。 */
  trailing?: string;
  onPress?: () => void;
  /** 行尾的按钮（预设的「⋯」）：有它时点这一行仍走 onPress。 */
  extra?: ReactNode;
}

/**
 * 一张卡片里的几行，中间用细线隔开（D-614）：系统层的列表（数据里的表、预设）一行一个卡片太高，表一多就要往下拉。
 * 只在设置这类系统页面里用，不进配置。
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

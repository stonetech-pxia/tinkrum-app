import { t, type Collection, type DataRecord } from '@morph/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { RenderEnv } from './components';
import { ColorDot, type RecordMarks } from './record-marks';
import { Card } from './ui';

// 表格外观（D-539）：表头是字段名，每条一行；第一列（title）固定在左边，其余的列左右滑动。
// 格子只读，点一行和列表一样打开这一条（编辑在记录页）。看什么都不写（底线 15）。

const ROW_HEIGHT = 44;
const TITLE_WIDTH = 140;
const COLUMN_WIDTH = 120;

export function RecordTable({
  blockId,
  view,
  title,
  columns,
  records,
  env,
  background,
  titleOf,
  cellOf,
  marks,
  warnColumn,
  open,
}: {
  blockId: string;
  view: Collection;
  title: string;
  columns: readonly string[];
  records: readonly DataRecord[];
  env: RenderEnv;
  background: string;
  titleOf: (r: DataRecord) => string;
  cellOf: (r: DataRecord, field: string) => string;
  marks: RecordMarks;
  /** 警示色画在哪一列（右侧字段在列里时）；null 时画在标题上（D-541）。 */
  warnColumn: string | null;
  open: ((r: DataRecord) => void) | undefined;
}) {
  const { palette, locale } = env;
  const name = (id: string) =>
    id === 'createdAt'
      ? t(locale, 'tableCreatedAt')
      : id === 'updatedAt'
        ? t(locale, 'tableUpdatedAt')
        : (view.fields.find((f) => f.id === id)?.name ?? id);
  const line = { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border };
  const head = (id: string, width: number) => (
    <View key={id} testID={`table-${blockId}-head-${id}`} style={[styles.cell, { width }]}>
      <Text numberOfLines={1} style={[palette.font('bodyBold', 13), { color: palette.muted }]}>
        {name(id)}
      </Text>
    </View>
  );
  const press = (r: DataRecord) => (open ? () => open(r) : undefined);
  return (
    <Card palette={palette} background={background} style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.fixed, { borderColor: palette.border }]}>
          {head(title, TITLE_WIDTH)}
          {records.map((r) => (
            <Pressable
              key={r.id}
              testID={`record-${r.id}`}
              onPress={press(r)}
              onLongPress={env.onLongPress}
              disabled={!open}
              style={[styles.cell, styles.row, { width: TITLE_WIDTH }, line]}>
              <ColorDot color={marks.colorOf(r)} recordId={r.id} />
              <Text
                numberOfLines={1}
                style={[
                  styles.flex,
                  palette.font('title', 14),
                  {
                    color: warnColumn === null && marks.warns(r) ? palette.danger : palette.text,
                  },
                ]}>
                {titleOf(r)}
              </Text>
            </Pressable>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={styles.row}>{columns.map((id) => head(id, COLUMN_WIDTH))}</View>
            {records.map((r) => (
              <Pressable
                key={r.id}
                testID={`record-${r.id}-cells`}
                onPress={press(r)}
                onLongPress={env.onLongPress}
                disabled={!open}
                style={[styles.row, styles.tall, line]}>
                {columns.map((id) => (
                  <View
                    key={id}
                    testID={`table-${blockId}-${r.id}-${id}`}
                    style={[styles.body, { width: COLUMN_WIDTH }]}>
                    <Text
                      numberOfLines={1}
                      style={[
                        palette.font('body', 14),
                        {
                          color:
                            id === warnColumn && marks.warns(r) ? palette.danger : palette.text,
                        },
                      ]}>
                      {cellOf(r, id)}
                    </Text>
                  </View>
                ))}
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: 0, gap: 0, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
  fixed: { borderRightWidth: StyleSheet.hairlineWidth },
  cell: { height: ROW_HEIGHT, justifyContent: 'center', paddingHorizontal: 12 },
  // 右边每一行和左边那一格一样高（都含上边线）：不写的话每行多出一条线，行多了左右对不齐。
  tall: { height: ROW_HEIGHT },
  body: { justifyContent: 'center', paddingHorizontal: 12 },
});

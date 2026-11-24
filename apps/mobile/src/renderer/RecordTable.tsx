import { t, type Collection, type DataRecord } from '@morph/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { RenderEnv } from './components';
import { ColorDot, type RecordMarks } from './record-marks';
import { Card } from './ui';

// Table appearance (D-539): table header shows field names, one row per entry; the first column
// (title) is fixed on the left, while remaining columns scroll horizontally. Cells are read-only;
// tapping a row opens the entry just like the list view (editing is done on the entry page).
// Displays nothing when viewing (invariant 15).

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
  /** Determines which column displays the warning color (when right-side fields are displayed within columns); defaults to the title column when null (D-541). */
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
  // Makes every row on the right match the height of the left grid cell (including the top border): without this, each extra row adds an extra line, causing alignment issues between left and right columns when there are many rows.
  tall: { height: ROW_HEIGHT },
  body: { justifyContent: 'center', paddingHorizontal: 12 },
});

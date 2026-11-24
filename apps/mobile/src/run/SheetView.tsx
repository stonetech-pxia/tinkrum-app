import {
  DEFAULT_FONT_SIZE,
  LINE_POINTS,
  cellNumber,
  columnName,
  lineCountAt,
  type SheetCell,
  type SheetLayout,
} from '@morph/tool-office';
import { Image } from 'expo-image';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { Palette } from '../renderer/theme';

// Sheet view (D-272, file-room DESIGN §11.4): renders a TableDoc page resembling xlsx (column
// letters, row numbers, merged cells). Split out from the Excel conversion edit page: shared
// between the edit page and file-room main preview. Handles rendering and selection only, content
// modification is handled by its consumer; view-only when no callback is passed (R1 read-only in
// the room).

/** Approximate point width of an Excel character; column widths and row heights are constrained to ranges that are easy to tap without being too wide. */
const CHAR_PX = 8;
/** Same as xlsx: defaults to "General" when alignment cannot be determined, numbers align right, text aligns left. */
const textAlignOf = (cell: SheetCell) =>
  cell.align ?? (cell.cell !== undefined && cellNumber(cell.text) ? 'right' : 'left');
/** Font size in cells (points): 11pt font renders as 13, others proportionally, not less than 9, not greater than 28. */
const screenFont = (cell: SheetCell) =>
  Math.round(
    Math.min(28, Math.max(9, (13 * (cell.size ?? DEFAULT_FONT_SIZE)) / DEFAULT_FONT_SIZE)),
  );
const MIN_COL = 56;
const MAX_COL = 280;
const LINE_PX = 20;
/** Left, right, top, and bottom cell padding. */
const CELL_PAD = 4;
const MIN_ROW = 32;
const ROW_HEAD = 40;
const COL_HEAD = 28;

export function SheetView({
  layout,
  palette,
  selected = null,
  onPressCell,
  onLongPressRow,
  onLongPressColumn,
  testID = 'table-sheet',
}: {
  layout: SheetLayout;
  palette: Palette;
  /** Selected cell (draws a thick border). */
  selected?: SheetCell | null;
  onPressCell?: (cell: SheetCell) => void;
  onLongPressRow?: (row: number) => void;
  onLongPressColumn?: (col: number) => void;
  testID?: string;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const colPx = useMemo(
    () =>
      layout.colWidths.map((w) => Math.round(Math.min(MAX_COL, Math.max(MIN_COL, w * CHAR_PX)))),
    [layout],
  );
  const colAt = useMemo(() => {
    const out = [0];
    for (const w of colPx) out.push(out.at(-1)! + w);
    return out;
  }, [colPx]);
  // Full-row merging for text outside the table, but not wider than the screen (when a table has
  // many columns, full-row text can be much wider than the screen, causing centered text to
  // overflow outside both sides of the screen); row height for this row is calculated based on the
  // line count wrapped to this width (row counts estimated by Excel column widths do not match
  // this).
  const textWidth = Math.max(MIN_COL, Math.min(colAt.at(-1) ?? 0, screenWidth - ROW_HEAD));
  const rowPx = useMemo(() => {
    // Row height based on the tallest cell in the row (points, based on font size): an 11pt row is LINE_PX points.
    const out = layout.rows.map((r) => Math.max(MIN_ROW, (r.points / LINE_POINTS) * LINE_PX + 10));
    for (const cell of layout.cells) {
      // Full-row merged text is re-calculated and wrapped based on screen width (row counts
      // estimated by Excel column widths do not match this); row heights are not changed for text
      // with column ranges, text in side-by-side strips (spanning multiple rows), or images.
      if (cell.cell !== undefined || cell.image || cell.colSpan < colPx.length || cell.rowSpan > 1)
        continue;
      const size = cell.size ?? DEFAULT_FONT_SIZE;
      const lines = lineCountAt(cell.text, (textWidth - 2 * CELL_PAD) / CHAR_PX, size);
      out[cell.row] = Math.max(MIN_ROW, ((lines * size) / DEFAULT_FONT_SIZE) * LINE_PX + 10);
    }
    return out;
  }, [layout, textWidth, colPx.length]);
  const rowAt = useMemo(() => {
    const out = [0];
    for (const h of rowPx) out.push(out.at(-1)! + h);
    return out;
  }, [rowPx]);

  const sheetWidth = ROW_HEAD + (colAt.at(-1) ?? 0);
  const sheetHeight = COL_HEAD + (rowAt.at(-1) ?? 0);

  return (
    <ScrollView horizontal style={styles.flex} testID={testID}>
      <ScrollView stickyHeaderIndices={[0]} contentContainerStyle={{ width: sheetWidth }}>
        {/* Column letters (stay pinned to the top during vertical scrolling). Positioned explicitly: the docked row on iOS is not arranged using flexDirection. */}
        <View style={[styles.colHeads, { width: sheetWidth, backgroundColor: palette.background }]}>
          {colPx.map((w, c) => (
            <Pressable
              key={c}
              testID={`table-col-${c}`}
              {...(onLongPressColumn ? { onLongPress: () => onLongPressColumn(c) } : {})}
              style={[
                styles.head,
                styles.abs,
                {
                  left: ROW_HEAD + colAt[c]!,
                  top: 0,
                  width: w,
                  borderColor: palette.border,
                  // D-488: headers of the row and column containing the selected cell change to light primary color.
                  ...(selected?.col === c ? { backgroundColor: palette.primaryTint } : {}),
                },
              ]}>
              <Text
                style={[
                  palette.font('bodyBold', 12),
                  { color: selected?.col === c ? palette.primaryText : palette.muted },
                ]}>
                {columnName(c)}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={{ width: sheetWidth, height: sheetHeight - COL_HEAD }}>
          {rowPx.map((h, r) => (
            <Pressable
              key={`r${r}`}
              testID={`table-row-${r}`}
              {...(onLongPressRow ? { onLongPress: () => onLongPressRow(r) } : {})}
              style={[
                styles.head,
                styles.abs,
                {
                  left: 0,
                  top: rowAt[r]!,
                  width: ROW_HEAD,
                  height: h,
                  borderColor: palette.border,
                  backgroundColor: selected?.row === r ? palette.primaryTint : palette.background,
                },
              ]}>
              <Text
                style={[
                  palette.font('bodyBold', 12),
                  { color: selected?.row === r ? palette.primaryText : palette.muted },
                ]}>
                {r + 1}
              </Text>
            </Pressable>
          ))}
          {layout.cells.map((cell) => {
            const left = ROW_HEAD + colAt[cell.col]!;
            const top = rowAt[cell.row]!;
            const table = cell.cell !== undefined;
            // Text spanning the full page is not wider than the screen; text with column ranges and images span their respective columns.
            const width =
              table || cell.image || cell.colSpan < colPx.length
                ? colAt[Math.min(cell.col + cell.colSpan, colPx.length)]! - colAt[cell.col]!
                : textWidth;
            const height = rowAt[Math.min(cell.row + cell.rowSpan, rowPx.length)]! - top;
            const on = selected === cell;
            return (
              <Pressable
                key={`${cell.block}-${cell.cell ?? 't'}`}
                testID={`table-cell-${cell.row}-${cell.col}`}
                disabled={!onPressCell}
                {...(onPressCell ? { onPress: () => onPressCell(cell) } : {})}
                style={[
                  styles.abs,
                  styles.cell,
                  {
                    left,
                    top,
                    width,
                    height,
                    borderColor: on ? palette.primary : table ? palette.border : 'transparent',
                    borderWidth: on ? 2 : StyleSheet.hairlineWidth,
                    backgroundColor: on ? palette.primaryTint : palette.surface,
                  },
                ]}>
                {cell.image ? (
                  // Images cropped from original images (D-520); leave only a bounding box while not yet cropped.
                  cell.image.src ? (
                    <Image
                      testID={`table-image-${cell.row}-${cell.col}`}
                      source={{ uri: cell.image.src }}
                      style={{ width: width - 2 * CELL_PAD, height: height - 2 * CELL_PAD }}
                      contentFit="contain"
                    />
                  ) : null
                ) : (
                  <Text
                    {...(table
                      ? { numberOfLines: Math.max(1, Math.floor((height - 8) / LINE_PX)) }
                      : {})}
                    style={[
                      palette.font(
                        cell.bold ? 'bodyBold' : on ? 'bodyMedium' : 'body',
                        screenFont(cell),
                      ),
                      { color: palette.text, textAlign: textAlignOf(cell) },
                    ]}>
                    {cell.text}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  colHeads: { height: COL_HEAD },
  head: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    height: COL_HEAD,
  },
  abs: { position: 'absolute' },
  cell: { paddingHorizontal: CELL_PAD, paddingVertical: CELL_PAD },
});

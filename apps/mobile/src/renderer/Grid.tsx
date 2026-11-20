import {
  calendarOf,
  filterRecords,
  followedFilter,
  gridCellValue,
  gridHereValues,
  gridRange,
  gridRead,
  gridTap,
  isRecordToolUse,
  sortRecords,
  type DataRecord,
  type GridColumn,
  type GridRow,
  type GridTap,
  type RecordToolUse,
} from '@morph/core';
import { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance,
} from 'react-native';

import { useRecordActionRunner } from '../data/record-actions';
import { LONG_PRESS_MS } from '../editing/entry';
import { setInnerGesture } from '../editing/useSingleDrag';
import { t } from '../i18n';
import type { RenderEnv } from './components';
import {
  amountText,
  useLinkedGroups,
  useListRecords,
  useRecordRows,
  type RecordBlock,
  type Tone,
} from './data';
import { UiIcon } from './Icon';
import { ProgressRing } from './Progress';
import { onPage } from './theme';
import { Card } from './ui';

// 打卡格（D-606）：行是 source.group（每个习惯、每个选项），列是 source.across（最近几天、几周、几个月，最后一列是今天
// 所在的那一段）。格子里有记录画实心圆（一条打勾，两条起写数；有 show.trailing 时写合计），有目标时画进度环。
// 点空格在这一格加一条（$here：这一行、这一天）；有 remove 时点只有一条的格子把它移到「最近删除」（带撤销），两条起
// 在下面列出这一格的记录（和月历点某天一样）；没有 remove 时点一下总是多记一条，长按列出。今天以后的格子不能点。
// 行名固定在左边，列多了横着滚，打开时滚到今天那一列。翻页、滚动、打开格子都不写（底线 15）；数是每次画的时候算的（底线 14）。

/** 行名那一栏的宽度。 */
const TITLE_WIDTH = 92;
const ROW_HEIGHT = 44;
const HEAD_HEIGHT = 40;
/** 一屏大约 7 列：按卡片的宽度分，最窄 34、最宽 52。 */
const MIN_CELL = 34;
const MAX_CELL = 52;
const VISIBLE = 7;
/** 长按列出记录要比页面的长按编辑（LONG_PRESS_MS）先到。 */
const HOLD_MS = LONG_PRESS_MS - 150;

const tapTool = (block: RecordBlock, kind: 'create' | 'remove'): RecordToolUse | undefined =>
  block.tools?.find(
    (u): u is RecordToolUse => u.as === 'tap' && isRecordToolUse(u) && u.do === kind,
  );

export function Grid({ block, env, tone }: { block: RecordBlock; env: RenderEnv; tone?: Tone }) {
  const { palette, locale } = env;
  const runner = useRecordActionRunner();
  const { collection, view, loaded, sorted } = useListRecords(block, env);
  const group = block.source.group;
  const linkedAll = useLinkedGroups(env, view, group?.by);
  const rows = useRecordRows(block, env, tone, collection, view);
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<{ row: string; column: string } | null>(null);
  const [width, setWidth] = useState(0);
  const scroller = useRef<ScrollViewInstance>(null);
  if (!collection || !view || !rows || linkedAll === null) return null;
  const cal = calendarOf(env.config);
  const now = new Date();
  // 按引用分行时先按 group.filter 筛被引用的表（和看板一样，D-351）。
  const linked = linkedAll && {
    ...linkedAll,
    records: filterRecords(linkedAll.records, linkedAll.collection, group?.filter, now, cal),
  };
  const read = gridRead(sorted, view, block.source, block.show, {
    now,
    cal,
    locale,
    linked,
    page,
  });
  if (!read) return null;
  const background = rows.background;
  if (loaded && read.rows.length === 0)
    return (
      <Card palette={palette} background={background}>
        <Text style={[palette.font('body', 14), { color: palette.caption }]}>
          {block.show.emptyText ?? t(locale, 'noRecords')}
        </Text>
      </Card>
    );
  const { columns } = read;
  const create = tapTool(block, 'create');
  const remove = tapTool(block, 'remove');
  // 跟着页面上的一排选项（D-573）：在这一格加的也带上它。
  const filter = followedFilter(block.source, env.pageChoice);
  const field = block.show.trailing
    ? view.fields.find((f) => f.id === block.show.trailing)
    : undefined;
  const cell = Math.max(
    MIN_CELL,
    Math.min(MAX_CELL, (width - TITLE_WIDTH) / Math.min(VISIBLE, columns.length)),
  );
  const go = (next: number) => {
    setPage(Math.max(0, next));
    setPicked(null);
  };

  const navButton = (
    id: string,
    icon: 'chevronLeft' | 'chevronRight',
    label: string,
    to: number,
  ) => (
    <Pressable
      testID={`grid-${block.id}-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={to < 0}
      onPress={() => go(to)}
      onLongPress={env.onLongPress}
      hitSlop={6}
      style={[styles.nav, { borderColor: palette.border, opacity: to < 0 ? 0.35 : 1 }]}>
      <UiIcon name={icon} size={20} color={palette.text} />
    </Pressable>
  );

  const hintOf: Record<GridTap, string | undefined> = {
    create: t(locale, 'gridHintAdd'),
    remove: t(locale, 'gridHintRemove'),
    open: t(locale, 'gridHintOpen'),
    none: undefined,
  };

  const renderCell = (row: GridRow, column: GridColumn, i: number) => {
    const records = row.cells[i]!;
    const count = records.length;
    const value = gridCellValue(records, view, block.show.trailing);
    const tap = gridTap(block.tools, count, column);
    const run = () => {
      if (tap === 'create' && create)
        void runner.runCell(create, {
          here: gridHereValues(view, filter, read, row, column, now, cal),
        });
      else if (tap === 'remove' && remove) void runner.runCell(remove, { record: records[0]! });
      else if (tap === 'open') setPicked({ row: row.key, column: column.key });
    };
    const press = env.interactive && tap !== 'none' ? (env.locked ?? run) : undefined;
    // 有记录时长按列出这一格的记录（和点一下做的事分开）；空格长按照样是页面的长按编辑。
    const holdOpen = () => {
      setPicked({ row: row.key, column: column.key });
      setTimeout(() => setInnerGesture(false), LONG_PRESS_MS);
    };
    const canHold = env.interactive && count > 0;
    const size = Math.min(cell, ROW_HEIGHT) - 8;
    const goal = row.goal;
    const ratio = goal === undefined ? undefined : Math.min(1, value / goal);
    const full = goal === undefined ? count > 0 : value >= goal;
    const isPicked = picked?.row === row.key && picked.column === column.key;
    const text = field ? amountText(value, field, locale) : String(value);
    return (
      <Pressable
        key={column.key}
        testID={`grid-${block.id}-cell-${row.key}-${column.key}`}
        accessibilityRole="button"
        accessibilityLabel={t(locale, 'gridCellLabel', {
          row: row.label,
          column: column.title,
          n: count,
        })}
        accessibilityHint={hintOf[tap]}
        accessibilityState={{ disabled: !press, selected: isPicked }}
        disabled={!press && !canHold}
        onPress={press}
        onPressIn={canHold ? () => setInnerGesture(true) : undefined}
        onPressOut={canHold ? () => setInnerGesture(false) : undefined}
        onLongPress={canHold ? (env.locked ?? holdOpen) : env.onLongPress}
        delayLongPress={canHold ? HOLD_MS : undefined}
        style={({ pressed }) => [
          styles.cell,
          { width: cell, opacity: column.future ? 0.35 : 1 },
          pressed && { transform: [{ scale: 0.9 }] },
        ]}>
        <View
          style={[
            styles.mark,
            {
              width: size,
              height: size,
              borderRadius: size,
              borderColor: isPicked ? palette.text : palette.border,
              borderWidth: isPicked ? 2 : count === 0 || !full ? 1.5 : 0,
              backgroundColor: full
                ? palette.primary
                : count > 0
                  ? palette.primaryTint
                  : 'transparent',
            },
          ]}>
          {ratio !== undefined && !full && count > 0 ? (
            <View style={StyleSheet.absoluteFill}>
              <ProgressRing
                ratio={ratio}
                size={size}
                stroke={3}
                palette={palette}
                testID={`grid-${block.id}-ring-${row.key}-${column.key}`}
              />
            </View>
          ) : null}
          {count === 0 ? null : count === 1 && !field && goal === undefined ? (
            <UiIcon name="done" size={size * 0.55} color={palette.onPrimary} />
          ) : (
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[
                palette.font('bodyBold', 12),
                styles.tabular,
                { color: full ? palette.onPrimary : palette.primaryText },
              ]}>
              {text}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  // 打开的那一格：还在这一页里时列出它的记录（有 source.sort 时按它排，最多 limit 条）。
  const pickedRow = picked && read.rows.find((r) => r.key === picked.row);
  const pickedIndex = picked ? columns.findIndex((c) => c.key === picked.column) : -1;
  const pickedRecords: DataRecord[] =
    pickedRow && pickedIndex >= 0 ? pickedRow.cells[pickedIndex]! : [];
  const shown = (
    block.source.sort
      ? sortRecords(pickedRecords, view, block.source.sort, now, cal)
      : pickedRecords
  ).slice(0, block.source.limit);

  return (
    <View style={{ gap: palette.gap - 4 }}>
      <Card palette={palette} background={background}>
        <View style={styles.header}>
          {navButton('prev', 'chevronLeft', t(locale, 'gridEarlier'), page + 1)}
          <Text
            accessibilityRole="header"
            style={[styles.range, palette.font('title', 15), { color: palette.text }]}>
            {gridRange(columns, now, cal, locale)}
          </Text>
          {page > 0 ? (
            <Pressable
              testID={`grid-${block.id}-today`}
              accessibilityRole="button"
              onPress={() => go(0)}
              hitSlop={6}
              style={[styles.todayButton, { borderColor: palette.border }]}>
              <Text style={[palette.font('bodyBold', 13), { color: palette.primaryText }]}>
                {t(locale, 'calendarToday')}
              </Text>
            </Pressable>
          ) : null}
          {navButton('next', 'chevronRight', t(locale, 'gridLater'), page > 0 ? page - 1 : -1)}
        </View>
        <View style={styles.body} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          <View style={{ width: TITLE_WIDTH }}>
            <View style={{ height: HEAD_HEIGHT }} />
            {read.rows.map((row) => (
              <View key={row.key} style={styles.rowTitle}>
                <Text
                  numberOfLines={2}
                  style={[palette.font('bodyMedium', 14), { color: palette.text }]}>
                  {row.label}
                </Text>
              </View>
            ))}
          </View>
          <ScrollView
            ref={scroller}
            horizontal
            showsHorizontalScrollIndicator={false}
            // 今天那一列在最右边：打开、翻页时都滚到最右。
            onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}>
            <View>
              <View style={[styles.line, { height: HEAD_HEIGHT }]}>
                {columns.map((c) => (
                  <View key={c.key} style={[styles.head, { width: cell }]}>
                    <Text
                      numberOfLines={1}
                      style={[
                        palette.font(c.current ? 'bodyBold' : 'body', 11),
                        { color: c.current ? palette.text : palette.muted },
                      ]}>
                      {c.label}
                    </Text>
                    {c.detail ? (
                      <Text
                        style={[
                          palette.font(c.current ? 'bodyBold' : 'body', 13),
                          styles.tabular,
                          { color: palette.text },
                        ]}>
                        {c.detail}
                      </Text>
                    ) : null}
                    {c.current ? (
                      <View style={[styles.todayMark, { backgroundColor: palette.primary }]} />
                    ) : null}
                  </View>
                ))}
              </View>
              {read.rows.map((row) => (
                <View key={row.key} style={[styles.line, { height: ROW_HEIGHT }]}>
                  {columns.map((c, i) => renderCell(row, c, i))}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      </Card>
      {pickedRow && pickedIndex >= 0 ? (
        <>
          <Text style={[palette.font('bodyBold', 14), { color: onPage(palette).muted }]}>
            {t(locale, 'gridCellTitle', {
              row: pickedRow.label,
              column: columns[pickedIndex]!.title,
            })}
          </Text>
          {shown.length > 0 ? (
            rows.list(shown)
          ) : (
            <Card palette={palette} background={background}>
              <Text style={[palette.font('body', 14), { color: palette.caption }]}>
                {t(locale, 'gridCellEmpty')}
              </Text>
            </Card>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  range: { flex: 1, textAlign: 'center' },
  nav: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 34,
    justifyContent: 'center',
  },
  body: { flexDirection: 'row' },
  rowTitle: { height: ROW_HEIGHT, justifyContent: 'center', paddingRight: 6 },
  line: { flexDirection: 'row', alignItems: 'center' },
  head: { alignItems: 'center', justifyContent: 'center' },
  todayMark: { width: 14, height: 3, borderRadius: 2, marginTop: 1 },
  cell: { height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  mark: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tabular: { fontVariant: ['tabular-nums'] },
});

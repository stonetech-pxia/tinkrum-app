import {
  MAX_TILES,
  calendarOf,
  formatRef,
  recordProgress,
  untitledRecordTitle,
  type DataRecord,
  fieldForRecord,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRecordActionRunner } from '../data/record-actions';
import { HOLD_MS, LONG_PRESS_MS } from '../editing/entry';
import { setInnerGesture } from '../editing/useSingleDrag';
import { useLinkResolver } from '../data/records';
import { t } from '../i18n';
import type { RenderEnv } from './components';
import {
  Trailing,
  amountText,
  rowToolOf,
  useListRecords,
  type RecordBlock,
  type Tone,
} from './data';
import { openRow } from './open-row';
import { ProgressRing } from './Progress';
import { cardColors } from './theme';
import { ColorDot, recordMarks } from './record-marks';
import { Card } from './ui';

// Large circular block appearance for record lists (D-311, similar to Streaks): one large circle
// per entry with the title below; displays a progress ring around the circle when progress is
// present, filling completely when the target is reached. Tapping executes the row action for this
// block (the first satisfied when clause, D-300, executed via one-tap action code), or opens the
// entry if there is no row action; long-pressing opens the entry when a row action exists. Maximum
// of 24 items (D-312).

const SIZE = 84;
const STROKE = 6;

export function Tiles({ block, env, tone }: { block: RecordBlock; env: RenderEnv; tone?: Tone }) {
  const { palette, locale } = env;
  const router = useRouter();
  const runner = useRecordActionRunner();
  const { collection, view, loaded, sorted } = useListRecords(block, env);
  const links = useLinkResolver(view);
  if (!collection || !view) return null;
  const background = cardColors(palette, tone).background;
  const shown = sorted.slice(0, Math.min(block.source.limit, MAX_TILES));
  if (loaded && shown.length === 0) {
    return (
      <Card palette={palette} background={background}>
        <Text style={[palette.font('body', 14), { color: palette.caption }]}>
          {block.show.emptyText ?? t(locale, 'noRecords')}
        </Text>
      </Card>
    );
  }
  const cal = calendarOf(env.config);
  const now = new Date();
  const { show } = block;
  const format = show.format;
  const marks = recordMarks(show, view, env, now);

  const tile = (r: DataRecord) => {
    // Warning color (D-541): values on the right, or the title if no right-side field exists.
    const warn = marks.warns(r);
    const title =
      formatRef(r, view, show.title, locale, links, now, cal) ||
      untitledRecordTitle(r, collection, locale, now, cal);
    const action = rowToolOf(block, r, view, now, cal);
    const progress =
      format?.kind === 'progress'
        ? recordProgress(r, view, show.trailing!, format.goal, now, cal)
        : undefined;
    const found = view.fields.find((f) => f.id === show.trailing);
    const field = found && fieldForRecord(found, r.values, view);
    const full = progress !== undefined && progress.ratio >= 1;
    const inside = progress
      ? t(locale, 'progressOfGoal', {
          value: amountText(progress.value, field, locale),
          goal: amountText(progress.goal, field, locale),
        })
      : undefined;
    const text = show.trailing ? formatRef(r, view, show.trailing, locale, links, now, cal) : '';
    const open = () => openRow(router, block.opens, collection.id, r.id);
    const run = action ? () => void runner.runRow(action, r) : open;
    // After opening an entry, this block might not receive an onPressOut event if released after the page's long-press edit duration elapses.
    const holdOpen = () => {
      open();
      setTimeout(() => setInnerGesture(false), LONG_PRESS_MS);
    };
    const press = env.interactive ? (env.locked ?? run) : undefined;
    return (
      <View key={r.id} style={styles.cell}>
        <Pressable
          testID={`tile-${r.id}`}
          accessibilityRole="button"
          accessibilityLabel={[title, inside ?? text].filter(Boolean).join(', ')}
          accessibilityHint={action?.label}
          // Executes row actions on tap when present; screen reader users can alternatively select "Open" to view the entry.
          accessibilityActions={
            action
              ? [
                  { name: 'activate', label: action.label },
                  { name: 'open', label: t(locale, 'open') },
                ]
              : undefined
          }
          onAccessibilityAction={(e) => {
            if (!env.interactive) return;
            if (env.locked) return env.locked();
            if (e.nativeEvent.actionName === 'open') open();
            else run();
          }}
          disabled={!press}
          onPress={press}
          // Long-press to open this entry when a row action exists (D-311): prioritizes functionality over single-component editing (D-235), allowing long presses outside the circular block to still trigger editing.
          onPressIn={action && env.interactive ? () => setInnerGesture(true) : undefined}
          onPressOut={action ? () => setInnerGesture(false) : undefined}
          onLongPress={
            action ? (env.interactive ? (env.locked ?? holdOpen) : undefined) : env.onLongPress
          }
          delayLongPress={action ? HOLD_MS : undefined}
          style={({ pressed }) => [styles.tile, pressed && { transform: [{ scale: 0.94 }] }]}>
          <View style={styles.circleBox}>
            {progress ? (
              <View style={StyleSheet.absoluteFill}>
                <ProgressRing
                  ratio={progress.ratio}
                  size={SIZE}
                  stroke={STROKE}
                  palette={palette}
                  testID={`tile-ring-${r.id}`}
                />
              </View>
            ) : null}
            <View
              style={[
                styles.circle,
                {
                  backgroundColor: full ? palette.primary : palette.primaryTint,
                  margin: progress ? STROKE + 3 : 0,
                },
              ]}>
              {inside ? (
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={[
                    palette.font('title', 15),
                    styles.tabular,
                    { color: full ? palette.onPrimary : palette.primaryText },
                  ]}>
                  {inside}
                </Text>
              ) : show.trailing ? (
                <Trailing record={r} view={view} show={show} env={env} text={text} warn={warn} />
              ) : action ? (
                <Text
                  numberOfLines={2}
                  style={[
                    palette.font('bodyBold', 13),
                    styles.center,
                    { color: palette.primaryText },
                  ]}>
                  {action.label}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.titleRow}>
            <ColorDot color={marks.colorOf(r)} recordId={r.id} />
            <Text
              numberOfLines={2}
              style={[
                palette.font('bodyMedium', 14),
                styles.center,
                { color: warn && !show.trailing ? palette.danger : palette.text },
              ]}>
              {title}
            </Text>
          </View>
        </Pressable>
      </View>
    );
  };

  return (
    <Card palette={palette} background={background}>
      <View style={styles.grid}>{shown.map(tile)}</View>
    </Card>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16 },
  cell: { width: '33.333%', alignItems: 'center' },
  tile: { alignItems: 'center', gap: 8, paddingHorizontal: 4, minWidth: 88 },
  circleBox: { width: SIZE, height: SIZE },
  circle: {
    flex: 1,
    borderRadius: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  center: { textAlign: 'center' },
  tabular: { fontVariant: ['tabular-nums'] },
});

import {
  CHART_COLORS,
  chartOptionColor,
  calendarOf,
  chartSeries,
  choiceRange,
  dateFieldOf,
  filterRecords,
  followedFilter,
  lineScale,
  piePaths,
  pieSlices,
  previousFullRange,
  recordsInRange,
  todayText,
  unitRange,
  type ChartPoint,
  type BlockOf,
  type ComponentStyle,
} from '@morph/core';
import { Canvas, Path } from '@shopify/react-native-skia';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useComputedRecords } from '../data/records';
import { t } from '../i18n';
import type { RenderEnv } from './components';
import { SplitChartPlot } from './SplitChartPlot';
import { ChartPlot, PLOT_HEIGHT } from './ChartPlot';
import { statText, useLinkedGroups } from './data';
import { cardColors } from './theme';
import { Card } from './ui';

// Chart component (D-249): grouping and values are computed in core/chart.ts, and only rendered
// here. Tapping and screen reader accessibility rely on a row of transparent clickable areas (one
// grid cell per bar or point). Bar charts (when there are no negative numbers) and line charts are
// rendered using Victory Native XL (ChartPlot.tsx, D-438), while bar charts with negative numbers
// and pie charts use Skia Path. A single series uses the primary color without a legend (the title
// serves as its name); each pie slice uses a fixed-order categorical color, and the legend always
// lists names and values so it does not rely solely on color. Tapping a bar / point / legend row
// displays its value below the title (replacing tooltips).

export function Chart({
  block,
  env,
  tone,
}: {
  block: BlockOf<'chart'>;
  env: RenderEnv;
  tone?: ComponentStyle['tone'];
}) {
  const { palette, locale } = env;
  const { source, show } = block;
  const table = env.config.data.tables.find((c) => c.id === source.table);
  const cal = calendarOf(env.config);
  // Lookups, summaries, and previous entries (D-291) are rendered based on computed values.
  const { view: collection, records } = useComputedRecords(env.config.data.tables, table, cal);
  // Grouping by single-select / reference fields (no unit); reference fields (D-336): one point per record in the referenced table.
  const byChoice = source.group.unit === undefined;
  const linked = useLinkedGroups(env, collection, byChoice ? source.group.by : undefined);
  const [picked, setPicked] = useState<number | null>(null);
  if (!collection) return null;
  const now = new Date();
  const field = source.field ? collection.fields.find((f) => f.id === source.field) : undefined;
  // Time range selected on the page (D-440): when source.period is "page" and the page has a period
  // block, render according to the selected range; inPeriod in filters is no longer used, and time
  // grouping's group.unit and last are also no longer used (chosen automatically based on range
  // length).
  const choice = source.period === 'page' ? env.pageRange?.choice : undefined;
  const matched = filterRecords(
    records ?? [],
    collection,
    // Follows a row of options on the page (D-573): render only records for the selected item.
    choice
      ? (followedFilter(source, env.pageChoice) ?? []).filter((c) => c.op !== 'inPeriod')
      : followedFilter(source, env.pageChoice),
    now,
    cal,
  );
  const timed = source.group.unit !== undefined;
  const range = choice ? choiceRange(choice, now, cal) : undefined;
  // Pie charts (grouped by single-select) have no time period, keeping only records within the range; which date to use is determined the same way as date-counting statistics.
  const dateRef = dateFieldOf(collection, timed ? source.group.by : source.days?.date);
  const inRange =
    range && !timed ? recordsInRange(matched, collection, dateRef, range, now, cal) : matched;
  const series = chartSeries(
    inRange,
    collection,
    source,
    now,
    t(locale, 'statNoChoice'),
    cal,
    linked ?? undefined,
    false,
    timed ? range : undefined,
    t(locale, 'chartOther'),
  );
  const points = show.kind === 'pie' ? pieSlices(series, t(locale, 'chartOther')) : series;
  // Previous period (D-439): only for time grouping, bar charts, and line charts (ensured by config
  // validation), corresponding one-to-one with the recent segments. When a page range is selected
  // (D-440), it is the full segment immediately preceding; when segment counts differ (e.g., last
  // month shorter than this month), they are aligned by position, excess removed, and missing
  // padded with 0.
  const previous =
    source.compare === 'previous' && timed && show.kind !== 'pie'
      ? (() => {
          const before = chartSeries(
            matched,
            collection,
            source,
            now,
            t(locale, 'statNoChoice'),
            cal,
            undefined,
            true,
            choice ? previousFullRange(choice, now, cal) : undefined,
          );
          return choice
            ? series.map(
                (_, i) =>
                  before[i] ?? {
                    key: null,
                    label: '',
                    value: 0,
                    empty: !['count', 'sum', 'distinctDays'].includes(source.aggregate),
                  },
              )
            : before;
        })()
      : null;
  const pointText = (p: ChartPoint, i: number) => {
    const before = previous?.[i];
    return before
      ? t(locale, 'chartPointCompare', {
          label: p.label,
          value: valueText(p),
          previous: valueText(before),
        })
      : [
          t(locale, 'chartPoint', { label: p.label, value: valueText(p) }),
          ...(p.parts ?? []).map((part) =>
            t(locale, 'chartPoint', { label: part.label, value: valueText(part) }),
          ),
        ].join(' · ');
  };
  const valueText = (p: ChartPoint) =>
    p.empty ? '—' : statText(p.value, source.aggregate, field, locale);
  const nothing =
    records !== null &&
    linked !== null &&
    points.every(
      (p) =>
        p.empty ||
        (['count', 'sum', 'distinctDays'].includes(source.aggregate) &&
          p.value === 0 &&
          !p.parts?.some((part) => part.value !== 0)),
    );
  // Defaults to displaying the last segment (time) or the largest slice (single-select). Time
  // grouping: the segment containing today (when a page range is selected, future days within the
  // range are at the end and not displayed by default).
  const today = todayText(now, cal);
  const nowIndex = points.reduce(
    (found, p, i) => (p.key !== null && p.key <= today ? i : found),
    points.length - 1,
  );
  const fallback = byChoice
    ? points.reduce((best, p, i) => (p.value > (points[best]?.value ?? -Infinity) ? i : best), 0)
    : nowIndex;
  // show.pickPeriod (D-585): highlights the specific segment when the page-selected range matches that segment, whether selected by tapping a bar or elsewhere.
  const unit = source.group.unit;
  const rangePicked =
    show.pickPeriod && unit && env.pageRange
      ? (() => {
          const at = choiceRange(env.pageRange.choice, now, cal);
          return points.findIndex(
            (p) => p.key === at.start && unitRange(p.key, unit).end === at.end,
          );
        })()
      : -1;
  const selected =
    rangePicked >= 0 ? rangePicked : picked !== null && picked < points.length ? picked : fallback;
  const current = points[selected];

  const splitField = collection.fields.find((f) => f.id === source.split?.by);
  const splitOptions = splitField?.type === 'choice' ? splitField.options : [];
  const parts = points[0]?.parts ?? [];
  const splitColors = parts.map((p) => chartOptionColor(p.key, splitOptions, palette.dark));

  const header = (
    <View style={styles.header}>
      <Text style={[palette.font('title', 16), { color: palette.text }]}>{show.title}</Text>
      {current && !nothing && show.kind !== 'pie' ? (
        <Text
          testID={`chart-readout-${source.table}`}
          style={[palette.font('body', 13), { color: palette.muted }]}>
          {pointText(current, selected)}
        </Text>
      ) : null}
    </View>
  );

  const pickPoint = (p: ChartPoint, i: number) => {
    setPicked(i);
    // Tapping a chart only changes the time selection on the page, without writing records (invariant 15).
    if (show.pickPeriod && unit && p.key && env.pageRange)
      env.pageRange.set(unitRange(p.key, unit));
  };

  // Clickable area grid for each point (overlaid on the chart, larger than the bars and points themselves): used for screen readers and tapping to view values.
  const slots = (prefix: 'bar' | 'point') => (
    <View style={[StyleSheet.absoluteFill, styles.bars]}>
      {points.map((p, i) => (
        <Pressable
          key={p.key ?? `none-${i}`}
          testID={`chart-${prefix}-${i}`}
          accessibilityRole="button"
          accessibilityLabel={pointText(p, i)}
          disabled={!env.interactive}
          onPress={() => pickPoint(p, i)}
          onLongPress={env.onLongPress}
          style={styles.barSlot}
        />
      ))}
    </View>
  );

  let plot: ReactNode = null;
  if (nothing || records === null) {
    plot = (
      <Text style={[palette.font('body', 14), { color: palette.caption }]}>
        {records === null ? ' ' : t(locale, 'chartEmpty')}
      </Text>
    );
  } else if (source.split) {
    plot = (
      <SplitChartPlot
        kind={show.kind === 'bar' ? 'bar' : 'line'}
        points={points}
        colors={splitColors}
        palette={palette}>
        {slots(show.kind === 'bar' ? 'bar' : 'point')}
      </SplitChartPlot>
    );
  } else if (show.kind === 'bar' && [...points, ...(previous ?? [])].every((p) => p.value >= 0)) {
    // No negative numbers: rendered with Victory (bars start from 0); negative numbers use the original rendering method below, as Victory bars would only extend to the bottom edge of the chart.
    plot = (
      <ChartPlot
        kind="bar"
        values={points.map((p) => (p.empty ? null : p.value))}
        previous={previous?.map((p) => (p.empty ? null : p.value))}
        selected={selected}
        color={palette.primary}
        mutedColor={palette.caption}
        gridColor={palette.border}
        labelColor={palette.caption}>
        {slots('bar')}
      </ChartPlot>
    );
  } else if (show.kind === 'bar') {
    const scale = lineScale(
      [...points.map((p) => p.value), ...(previous?.map((p) => p.value) ?? [])],
      1,
      PLOT_HEIGHT,
      0,
    );
    plot = (
      <View style={[styles.bars, { height: PLOT_HEIGHT }]}>
        {points.map((p, i) => {
          const top = Math.min(scale.y(p.value), scale.zero);
          const height = Math.max(Math.abs(scale.zero - scale.y(p.value)), p.value === 0 ? 0 : 2);
          return (
            <Pressable
              key={p.key ?? `none-${i}`}
              testID={`chart-bar-${i}`}
              accessibilityRole="button"
              accessibilityLabel={pointText(p, i)}
              disabled={!env.interactive}
              onPress={() => pickPoint(p, i)}
              onLongPress={env.onLongPress}
              style={styles.barSlot}>
              {previous?.[i] && !previous[i]!.empty ? (
                <View
                  testID={`chart-previous-${i}`}
                  style={{
                    position: 'absolute',
                    left: 1,
                    right: 1,
                    top: Math.min(scale.y(previous[i]!.value), scale.zero),
                    height: Math.abs(scale.zero - scale.y(previous[i]!.value)),
                    backgroundColor: palette.caption,
                    opacity: 0.35,
                    borderRadius: 4,
                  }}
                />
              ) : null}
              <View
                style={{
                  position: 'absolute',
                  left: previous ? '18%' : 1,
                  right: previous ? '18%' : 1,
                  top,
                  height,
                  borderTopLeftRadius: p.value >= 0 ? 4 : 0,
                  borderTopRightRadius: p.value >= 0 ? 4 : 0,
                  borderBottomLeftRadius: p.value < 0 ? 4 : 0,
                  borderBottomRightRadius: p.value < 0 ? 4 : 0,
                  backgroundColor: palette.primary,
                  opacity: i === selected ? 1 : 0.55,
                }}
              />
            </Pressable>
          );
        })}
      </View>
    );
  } else if (show.kind === 'line') {
    plot = (
      <ChartPlot
        kind="line"
        values={points.map((p) => (p.empty ? null : p.value))}
        previous={previous?.map((p) => (p.empty ? null : p.value))}
        selected={selected}
        color={palette.primary}
        mutedColor={palette.caption}
        gridColor={palette.border}
        labelColor={palette.caption}>
        {slots('point')}
      </ChartPlot>
    );
  } else {
    const total = points.reduce((s, p) => s + p.value, 0);
    // When grouping by a single-select field, colors are determined by the option order within the
    // field (D-568), consistent with split charts; "Other" and "Unselected" are gray; if any
    // options specify colors, unassigned options avoid those color families (D-571).
    const groupBy = byChoice ? collection.fields.find((f) => f.id === source.group.by) : undefined;
    const options = groupBy?.type === 'choice' ? groupBy.options : [];
    const colorOf = (p: ChartPoint, i: number) =>
      chartOptionColor(
        p.key,
        options,
        palette.dark,
        p.key === null ? -1 : i % CHART_COLORS.light.length,
      );
    const size = PLOT_HEIGHT;
    const paths = piePaths(
      points.map((p) => p.value),
      size / 2,
      size / 2,
      size / 2 - 2,
    );
    plot = (
      <View style={styles.pie}>
        <Canvas style={{ width: size, height: size }} pointerEvents="none">
          {paths.map((d, i) =>
            d ? <Path key={`fill-${i}`} path={d} color={colorOf(points[i]!, i)} /> : null,
          )}
          {/* 2px gap between blocks (surface color border). */}
          {paths.map((d, i) =>
            d && points.length > 1 ? (
              <Path
                key={`gap-${i}`}
                path={d}
                style="stroke"
                strokeWidth={2}
                color={palette.surface}
              />
            ) : null,
          )}
        </Canvas>
        <View style={styles.legend}>
          {points.map((p, i) => (
            <Pressable
              key={p.key ?? `other-${i}`}
              testID={`chart-slice-${p.key ?? 'other'}`}
              disabled={!env.interactive}
              onPress={() => setPicked(i)}
              onLongPress={env.onLongPress}
              style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: colorOf(p, i) }]} />
              {/* Name and value stacked vertically: French currency ("1 234,50 CNY") is relatively long, and side-by-side layout would truncate the name. */}
              <View style={styles.flex}>
                <Text
                  numberOfLines={2}
                  style={[
                    palette.font(i === selected ? 'bodyBold' : 'body', 14),
                    { color: palette.text },
                  ]}>
                  {p.label}
                </Text>
                <Text style={[palette.font('body', 13), { color: palette.muted }]}>
                  {t(locale, 'chartShare', {
                    value: valueText(p),
                    percent: `${Math.round((p.value / total) * 100)}%`,
                  })}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  return (
    <Card palette={palette} background={tone ? cardColors(palette, tone).background : undefined}>
      {header}
      {plot}
      {source.split ? (
        <View style={styles.legend}>
          {(current?.parts ?? parts).map((part, i) => (
            <View key={part.key ?? 'none'} style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: splitColors[i] }]} />
              <Text style={[styles.flex, palette.font('body', 13), { color: palette.text }]}>
                {part.label}
              </Text>
              <Text style={[palette.font('body', 13), { color: palette.muted }]}>
                {valueText(part)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {show.kind !== 'pie' && !nothing && points.length > 1 ? (
        // Label only the first and last segments; intermediate points are shown on tap.
        <View style={styles.axis}>
          <Text style={[palette.font('body', 12), { color: palette.caption }]}>
            {points[0]!.label}
          </Text>
          <Text style={[palette.font('body', 12), { color: palette.caption }]}>
            {points[points.length - 1]!.label}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { gap: 2 },
  bars: { flexDirection: 'row', alignItems: 'stretch' },
  barSlot: { flex: 1, minHeight: 44 },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  pie: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legend: { flex: 1, gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  flex: { flex: 1 },
});

import {
  optionColor,
  axisTickText,
  formatNumber,
  weekStartOf,
  calendarOf,
  dateFieldOf,
  contrast,
  currentMonth,
  dateOfDayNumber,
  dayTitle,
  filterRecords,
  followedFilter,
  heatLevel,
  mix,
  monthDays,
  monthTitle,
  monthWeeks,
  shiftMonth,
  shortDate,
  sortRecords,
  todayNumber,
  weekdayLabels,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMonthRecords } from '../data/records';
import { t } from '../i18n';
import type { RenderEnv } from './components';
import {
  AddHere,
  addHereOf,
  openAddHere,
  useCollection,
  useRecordRows,
  type RecordBlock,
  type Tone,
} from './data';
import { UiIcon } from './Icon';
import { onPage } from './theme';
import { Card } from './ui';

// Calendar appearance for record lists (D-305): a grid of a month, with each day shaded by record
// count or colored by a single-select field (using the option of the last entry of the day);
// supports flipping months left and right, and tapping a day lists that day's records below (in
// standard list rows, tapping a record opens the editor). Reads only the displayed month or week
// range, reading cross-day records by overlap (useMonthRecords). Cells are at least 44 high with
// 16pt date numbers; today's date is bolded with a primary-color underline beneath the number, the
// selected day has a text-color border, and dark mode colors are derived from the dark variant of
// the same palette.

/** Four shade levels: how much surface color is blended into primary color. */
const HEAT = [0, 0.2, 0.4, 0.65, 0.9];

/** Text on fill: whichever has higher contrast between black and white. */
const readable = (fill: string) =>
  contrast(fill, '#FFFFFF') >= contrast(fill, '#111111') ? '#FFFFFF' : '#111111';

export function MonthCalendar({
  block,
  env,
  tone,
  componentId,
}: {
  block: RecordBlock;
  env: RenderEnv;
  tone?: Tone;
  componentId: string;
}) {
  const { palette, locale } = env;
  const collection = useCollection(env, block.source.table);
  const cal = calendarOf(env.config);
  const now = new Date();
  const thisMonth = currentMonth(now, cal);
  const today = todayNumber(now, cal);
  const [month, setMonth] = useState(thisMonth);
  const [weekStart, setWeekStart] = useState(weekStartOf(today, cal));
  const weekly = block.show.span === 'week';
  const week = Array.from({ length: 7 }, (_, i) => weekStart + i);
  const weekRange = { start: dateOfDayNumber(weekStart), end: dateOfDayNumber(weekStart + 6) };
  const [picked, setPicked] = useState<number | null>(today);
  const dateRef = collection ? dateFieldOf(collection, block.source.group?.by) : 'createdAt';
  const { view, records } = useMonthRecords(
    env.config.data.tables,
    collection,
    dateRef,
    month,
    cal,
    { ...(weekly ? { range: weekRange } : {}), until: block.source.group?.until },
  );
  const rows = useRecordRows(block, env, tone, collection, view);
  const router = useRouter();
  if (!collection || !view || !rows) return null;
  // Add on selected day (D-349): date field populates this day, schedule is "one-time, this day"; datetime and system fields are not prefilled.
  const dateType = view.fields.find((f) => f.id === dateRef)?.type;
  const dayPreset = (day: number): Record<string, unknown> => {
    const date = dateOfDayNumber(day);
    if (dateType === 'date') return { [dateRef]: date };
    if (dateType === 'schedule') return { [dateRef]: { repeat: 'once', date } };
    return {};
  };

  // Follows the row of options on the page (D-573): displays only records for the selected option, and pre-fills it when adding on a given day.
  const filter = followedFilter(block.source, env.pageChoice);
  const matched = filterRecords(records ?? [], view, filter, now, cal);
  const { days, max } = monthDays(
    matched,
    view,
    {
      date: dateRef,
      color: block.show.color,
      day: block.show.day,
      until: block.source.group?.until,
    },
    weekly ? weekRange : month,
    now,
    cal,
  );
  const color = block.show.color ? view.fields.find((f) => f.id === block.show.color) : undefined;
  const options = color?.type === 'choice' ? color.options : [];
  // Options with specified colors use their color (D-568), unassigned ones use category colors sequentially (same as pie chart, starting from 8th alongside "Unselected" using neutral grey).
  const colorOfOption = (id: string | null) => {
    const i = id === null ? -1 : options.findIndex((o) => o.id === id);
    return optionColor(options[i], i, palette.dark, options);
  };
  const fillOf = (value: number, optionId: string | null, count: number) => {
    if (count === 0) return undefined;
    if (color) return colorOfOption(optionId);
    return mix(palette.surface, palette.primary, HEAT[heatLevel(value, max)]!);
  };
  const inMonth = (d: number) =>
    weekly ? d >= weekStart && d <= weekStart + 6 : dateOfDayNumber(d).slice(0, 7) === month;
  const selected = picked !== null && inMonth(picked) ? picked : null;
  const go = (delta: number) => {
    if (weekly) {
      setWeekStart(weekStart + 7 * delta);
      setPicked(null);
      return;
    }
    const next = shiftMonth(month, delta);
    setMonth(next);
    setPicked(next === thisMonth ? today : null);
  };
  const thisWeek = weekStartOf(today, cal);
  const atToday = weekly ? weekStart === thisWeek : month === thisMonth;
  const title = weekly
    ? t(locale, 'calendarWeekTitle', {
        start: shortDate(weekStart, today, locale),
        end: shortDate(weekStart + 6, today, locale),
      })
    : monthTitle(month, locale);
  const background = rows.background;
  const navButton = (
    id: string,
    icon: 'chevronLeft' | 'chevronRight',
    label: string,
    d: number,
  ) => (
    <Pressable
      testID={`calendar-${componentId}-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => go(d)}
      onLongPress={env.onLongPress}
      hitSlop={6}
      style={[styles.nav, { borderColor: palette.border }]}>
      <UiIcon name={icon} size={20} color={palette.text} />
    </Pressable>
  );
  const usedNone = [...days.values()].some((d) => d.optionId === null);
  const dayRecords = selected === null ? [] : (days.get(selected)?.records ?? []);
  const shown = (
    block.source.sort ? sortRecords(dayRecords, view, block.source.sort, now, cal) : dayRecords
  ).slice(0, block.source.limit);

  return (
    <View style={{ gap: palette.gap - 4 }}>
      <Card palette={palette} background={background} style={styles.card}>
        <View style={styles.header}>
          {navButton(
            'prev',
            'chevronLeft',
            t(locale, weekly ? 'calendarPrevWeek' : 'calendarPrevMonth'),
            -1,
          )}
          <Text
            accessibilityRole="header"
            style={[styles.title, palette.font('title', 17), { color: palette.text }]}>
            {title}
          </Text>
          {!atToday ? (
            <Pressable
              testID={`calendar-${componentId}-today`}
              accessibilityRole="button"
              onPress={() => {
                setMonth(thisMonth);
                setWeekStart(thisWeek);
                setPicked(today);
              }}
              hitSlop={6}
              style={[styles.todayButton, { borderColor: palette.border }]}>
              <Text style={[palette.font('bodyBold', 13), { color: palette.primaryText }]}>
                {t(locale, 'calendarToday')}
              </Text>
            </Pressable>
          ) : null}
          {navButton(
            'next',
            'chevronRight',
            t(locale, weekly ? 'calendarNextWeek' : 'calendarNextMonth'),
            1,
          )}
        </View>
        <View style={styles.week}>
          {weekdayLabels(cal, locale).map((w, i) => (
            <Text
              key={i}
              style={[styles.weekday, palette.font('bodyBold', 12), { color: palette.muted }]}>
              {w}
            </Text>
          ))}
        </View>
        {(weekly ? [week] : monthWeeks(month, cal)).map((week) => (
          <View key={week[0]} style={styles.week}>
            {week.map((d) => {
              if (!inMonth(d)) return <View key={d} style={styles.cell} />;
              const info = days.get(d);
              const count = info?.count ?? 0;
              const value = block.show.day ? (info?.value ?? 0) : count;
              const fill = fillOf(Math.abs(value), info?.optionId ?? null, count);
              const isToday = d === today;
              const isPicked = d === selected;
              const text = fill ? readable(fill) : palette.text;
              const date = dateOfDayNumber(d);
              const optionLabel =
                color && info
                  ? (options.find((o) => o.id === info.optionId)?.label ??
                    t(locale, 'statNoChoice'))
                  : undefined;
              return (
                <Pressable
                  key={d}
                  testID={`calendar-${componentId}-day-${date}`}
                  accessibilityRole="button"
                  accessibilityLabel={
                    block.show.day
                      ? t(locale, 'calendarDayValue', {
                          date: dayTitle(d, locale),
                          value: formatNumber(value, undefined, locale),
                        })
                      : t(locale, 'calendarDayLabel', { date: dayTitle(d, locale), n: count })
                  }
                  accessibilityHint={optionLabel}
                  accessibilityState={{ selected: isPicked }}
                  onPress={env.interactive ? () => setPicked(d) : undefined}
                  onLongPress={env.onLongPress}
                  style={[
                    styles.cell,
                    styles.day,
                    {
                      backgroundColor: fill ?? 'transparent',
                      borderColor: isPicked ? palette.text : 'transparent',
                      borderRadius: Math.min(palette.controlRadius, 12),
                    },
                  ]}>
                  <Text style={[palette.font(isToday ? 'bodyBold' : 'body', 16), { color: text }]}>
                    {Number(date.slice(8))}
                  </Text>
                  {isToday ? (
                    <View
                      style={[styles.todayMark, { backgroundColor: fill ? text : palette.primary }]}
                    />
                  ) : null}
                  {block.show.day ? (
                    <Text
                      testID={`calendar-${componentId}-value-${date}`}
                      style={[styles.count, palette.font('bodyBold', 10), { color: text }]}>
                      {axisTickText(value)}
                    </Text>
                  ) : color && count > 1 ? (
                    <Text style={[styles.count, palette.font('bodyBold', 10), { color: text }]}>
                      {count}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
        {color ? (
          <View style={styles.legend}>
            {[
              ...options.map((o) => ({ id: o.id as string | null, label: o.label })),
              ...(usedNone ? [{ id: null, label: t(locale, 'statNoChoice') }] : []),
            ].map((o) => (
              <View key={o.id ?? '-'} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: colorOfOption(o.id) }]} />
                <Text style={[palette.font('body', 13), { color: palette.text }]}>{o.label}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </Card>
      {selected !== null && records !== null ? (
        <>
          <Text style={[palette.font('bodyBold', 14), { color: onPage(palette).muted }]}>
            {dayTitle(selected, locale)}
          </Text>
          {shown.length > 0 ? (
            rows.list(shown)
          ) : (
            <Card palette={palette} background={background}>
              <Text style={[palette.font('body', 14), { color: palette.caption }]}>
                {block.show.emptyText ?? t(locale, 'calendarDayEmpty')}
              </Text>
            </Card>
          )}
          {addHereOf(block) ? (
            <AddHere
              testID="calendar-add-here"
              label={t(locale, 'groupAdd', { group: dayTitle(selected, locale) })}
              palette={onPage(palette)}
              onPress={
                env.interactive
                  ? (env.locked ??
                    (() =>
                      openAddHere(
                        router,
                        collection,
                        view,
                        { filter },
                        dayPreset(selected),
                        addHereOf(block),
                      )))
                  : undefined
              }
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  title: { flex: 1, textAlign: 'center' },
  nav: {
    width: 44,
    height: 44,
    borderRadius: 22,
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
  week: { flexDirection: 'row', gap: 4 },
  weekday: { flex: 1, textAlign: 'center', paddingVertical: 4 },
  cell: { flex: 1, minHeight: 44, aspectRatio: 1 },
  day: { alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  todayMark: { width: 14, height: 3, borderRadius: 2, marginTop: 2 },
  count: { position: 'absolute', top: 3, right: 5 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
});

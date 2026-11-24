import {
  dateOfDayNumber,
  monthTitle,
  monthWeeks,
  shiftMonth,
  todayNumber,
  weekdayLabels,
  type Calendar,
  type Locale,
} from '@morph/core';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { Icon, UiIcon } from './Icon';
import type { Palette } from './theme';

// Date and time picker (D-543): pure JS (no native components). Calendar grid and appearance share
// core functions (monthWeeks, weekdayLabels, monthTitle); week start day and day start time follow
// "Settings -> Date".

/** YYYY-MM-DD -> day count (inverse of core's dateOfDayNumber). */
const dayOf = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Calendar button next to the input field: opens and collapses the picker below. */
export function PickButton({
  open,
  onPress,
  palette,
  locale,
  disabled,
  testID,
}: {
  open: boolean;
  onPress: () => void;
  palette: Palette;
  locale: Locale;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t(locale, 'datePickerOpen')}
      accessibilityState={{ expanded: open }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={styles.pick}>
      <Icon name="calendar" size={20} color={open ? palette.primaryText : palette.muted} />
    </Pressable>
  );
}

/** Monthly grid: tapping a day returns YYYY-MM-DD. When opened, defaults to the month of the selected day (or current month if none). */
export function DayGrid({
  value,
  onPick,
  palette,
  locale,
  cal,
  testID,
}: {
  value: string | undefined;
  onPick: (date: string) => void;
  palette: Palette;
  locale: Locale;
  cal: Calendar;
  testID: string;
}) {
  const today = todayNumber(new Date(), cal);
  const picked = value === undefined ? undefined : dayOf(value.slice(0, 10));
  const [month, setMonth] = useState(dateOfDayNumber(picked ?? today).slice(0, 7));
  const nav = (id: string, icon: 'chevronLeft' | 'chevronRight', label: string, by: number) => (
    <Pressable
      testID={`${testID}-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => setMonth(shiftMonth(month, by))}
      style={styles.nav}>
      <UiIcon name={icon} size={18} color={palette.text} />
    </Pressable>
  );
  return (
    <View style={[styles.panel, { borderColor: palette.border }]}>
      <View style={styles.header}>
        {nav('prev', 'chevronLeft', t(locale, 'calendarPrevMonth'), -1)}
        <Text style={[styles.title, palette.font('title', 15), { color: palette.text }]}>
          {monthTitle(month, locale)}
        </Text>
        {nav('next', 'chevronRight', t(locale, 'calendarNextMonth'), 1)}
      </View>
      <View testID={`${testID}-weekdays`} style={styles.week}>
        {weekdayLabels(cal, locale).map((w, i) => (
          <Text
            key={i}
            style={[styles.cell, palette.font('bodyBold', 12), { color: palette.muted }]}>
            {w}
          </Text>
        ))}
      </View>
      {monthWeeks(month, cal).map((week) => (
        <View key={week[0]} style={styles.week}>
          {week.map((d) => {
            const date = dateOfDayNumber(d);
            if (date.slice(0, 7) !== month) return <View key={d} style={styles.cell} />;
            const on = d === picked;
            return (
              <Pressable
                key={d}
                testID={`${testID}-day-${date}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => onPick(date)}
                style={[
                  styles.cell,
                  styles.day,
                  {
                    backgroundColor: on ? palette.primary : 'transparent',
                    borderColor: d === today && !on ? palette.primary : 'transparent',
                  },
                ]}>
                <Text
                  style={[
                    palette.font(d === today ? 'bodyBold' : 'body', 15),
                    { color: on ? palette.onPrimary : palette.text },
                  ]}>
                  {Number(date.slice(8))}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const two = (n: number) => String(n).padStart(2, '0');

/** Hour and minute (5-minute intervals): tapping returns HH:MM, retaining the existing value for the other part (defaults to 00 if none). */
export function TimeChips({
  value,
  onPick,
  palette,
  locale,
  testID,
}: {
  value: string | undefined;
  onPick: (time: string) => void;
  palette: Palette;
  locale: Locale;
  testID: string;
}) {
  const m = value ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  const hour = m ? Number(m[1]) : undefined;
  const minute = m ? Number(m[2]) : undefined;
  const row = (label: string, kind: 'hour' | 'minute', values: number[], current?: number) => (
    <View style={styles.timeRow}>
      <Text style={[styles.timeLabel, palette.font('bodyBold', 12), { color: palette.muted }]}>
        {label}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {values.map((v) => {
          const on = v === current;
          return (
            <Pressable
              key={v}
              testID={`${testID}-${kind}-${v}`}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() =>
                onPick(
                  kind === 'hour' ? `${two(v)}:${two(minute ?? 0)}` : `${two(hour ?? 0)}:${two(v)}`,
                )
              }
              style={[
                styles.timeChip,
                {
                  backgroundColor: on ? palette.primary : 'transparent',
                  borderColor: palette.border,
                  borderRadius: palette.controlRadius,
                },
              ]}>
              <Text
                style={[
                  palette.font('body', 14),
                  { color: on ? palette.onPrimary : palette.text },
                ]}>
                {two(v)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
  return (
    <View style={[styles.panel, { borderColor: palette.border }]}>
      {row(t(locale, 'datePickerHour'), 'hour', HOURS, hour)}
      {row(t(locale, 'datePickerMinute'), 'minute', MINUTES, minute)}
    </View>
  );
}

const styles = StyleSheet.create({
  pick: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 8, gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, textAlign: 'center' },
  nav: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  week: { flexDirection: 'row' },
  cell: { flex: 1, textAlign: 'center', alignItems: 'center' },
  day: { height: 38, justifyContent: 'center', borderRadius: 19, borderWidth: 1.5 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeLabel: { width: 52 },
  timeChip: {
    minWidth: 40,
    height: 34,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});

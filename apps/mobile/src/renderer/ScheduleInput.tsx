import {
  dateOfDayNumber,
  findDatePhrase,
  monthName,
  normalizeTime,
  readSchedule,
  scheduleText,
  todayNumber,
  weekStartOf,
  weekdayName,
  type Field,
  type ScheduleRule,
  type SchedulePer,
  type StringKey,
} from '@morph/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { t } from '../i18n';
import { useCalendar, useWorkspace } from '../workspace/context';
import type { RenderEnv } from './components';
import type { Palette } from './theme';

// Schedule (D-296): first select a repetition mode, then fill in numbers or select days according
// to that mode; the row below displays the current rule in a single sentence. All buttons are at
// least 44 high for ease of tapping. The value is a core rule (validated by readSchedule),
// defaulting to empty when not set. D-340: "Once" is placed first, allowing selection of today,
// tomorrow, next week, an indefinite date, or typing a date in the box (also supports natural
// phrases like "next Friday", D-344).

type Repeat = ScheduleRule['repeat'];

const KINDS: [Repeat, StringKey][] = [
  ['once', 'scheduleKindOnce'],
  ['daily', 'scheduleKindDaily'],
  ['weekdays', 'scheduleKindWeekdays'],
  ['times', 'scheduleKindTimes'],
  ['monthDays', 'scheduleKindMonthDays'],
  ['interval', 'scheduleKindInterval'],
  ['yearly', 'scheduleKindYearly'],
];

const PERS: [SchedulePer, StringKey, number][] = [
  ['week', 'schedulePerWeek', 7],
  ['twoWeeks', 'schedulePerTwoWeeks', 14],
  ['month', 'schedulePerMonth', 31],
  ['year', 'schedulePerYear', 366],
];

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function ScheduleInput({
  field,
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
}: {
  field: Extract<Field, { type: 'schedule' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean | undefined;
  testID: string;
}) {
  const cal = useCalendar();
  // Name of the "Last done" field (D-293): calculations for every N days or N times per week start from this field.
  const lastDone = useWorkspace((s) =>
    field.lastDone === undefined
      ? undefined
      : s.config?.data.tables
          .find((c) => c.fields.includes(field))
          ?.fields.find((f) => f.id === field.lastDone)?.name,
  );
  // Displays the default rule when a new entry has not been modified yet (also applied by core upon saving); value becomes an empty string after selecting "Do not repeat".
  const rule =
    value === undefined ? field.default && readSchedule(field.default) : readSchedule(value);
  const today = dateOfDayNumber(todayNumber(new Date(), cal));
  const [month, dom] = [Number(today.slice(5, 7)), Number(today.slice(8, 10))];
  const isoWeekday = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const perDay = rule && rule.repeat !== 'once' ? rule.perDay : undefined;
  const set = (next: ScheduleRule) => {
    if (next.repeat === 'once') return onChange(next);
    const { perDay: _, ...rest } = next;
    onChange(perDay ? { ...rest, perDay } : rest);
  };
  // Derives a reasonable starting point from today when switching repetition modes.
  const start = (repeat: Repeat): ScheduleRule => {
    switch (repeat) {
      case 'once':
        return { repeat };
      case 'daily':
        return { repeat };
      case 'weekdays':
        return { repeat, days: [isoWeekday] };
      case 'times':
        return { repeat, per: 'week', count: 3 };
      case 'monthDays':
        return { repeat, days: [dom] };
      case 'interval':
        return { repeat, every: 7 };
      case 'yearly':
        return { repeat, month, day: dom };
    }
  };

  const label = (text: string, selected: boolean) => (
    <Text
      style={[
        palette.font(selected ? 'bodyBold' : 'bodyMedium', 14),
        { color: selected ? palette.primary : palette.text },
      ]}>
      {text}
    </Text>
  );
  const chip = (key: string, text: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      testID={`${testID}-${key}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: selected ? palette.primary : palette.border,
          backgroundColor: selected ? palette.primaryTint : palette.surface,
        },
      ]}>
      {label(text, selected)}
    </Pressable>
  );
  const caption = (text: string) => (
    <Text style={[palette.font('bodyBold', 13), { color: palette.muted }]}>{text}</Text>
  );
  /** − Number +, constrained between min and max. */
  const stepper = (
    key: string,
    n: number,
    min: number,
    max: number,
    change: (n: number) => void,
  ) => {
    const step = (part: 'minus' | 'plus') => {
      const to = part === 'minus' ? n - 1 : n + 1;
      const off = to < min || to > max;
      return (
        <Pressable
          testID={`${testID}-${key}-${part}`}
          accessibilityRole="button"
          accessibilityLabel={t(locale, part === 'minus' ? 'scheduleDecrease' : 'scheduleIncrease')}
          disabled={disabled || off}
          onPress={() => change(to)}
          style={[
            styles.step,
            part === 'minus' ? styles.stepFirst : styles.stepLast,
            { borderColor: palette.border, opacity: off ? 0.35 : 1 },
          ]}>
          <Text style={[palette.font('title', 20), { color: palette.text }]}>
            {part === 'minus' ? '−' : '+'}
          </Text>
        </Pressable>
      );
    };
    return (
      <View style={styles.stepper}>
        {step('minus')}
        <Text
          testID={`${testID}-${key}-value`}
          style={[styles.stepValue, palette.font('title', 18), { color: palette.text }]}>
          {n}
        </Text>
        {step('plus')}
      </View>
    );
  };
  const toggle = (list: readonly number[], x: number) =>
    list.includes(x) ? list.filter((y) => y !== x) : [...list, x];

  const details = () => {
    if (!rule) return null;
    switch (rule.repeat) {
      case 'once': {
        const todayN = todayNumber(new Date(), cal);
        const picks: [string, string | undefined, string][] = [
          ['today', dateOfDayNumber(todayN), t(locale, 'scheduleToday')],
          ['tomorrow', dateOfDayNumber(todayN + 1), t(locale, 'scheduleTomorrow')],
          [
            'next-week',
            dateOfDayNumber(weekStartOf(todayN, cal) + 7),
            t(locale, 'scheduleNextWeek'),
          ],
          ['no-date', undefined, t(locale, 'scheduleNoDate')],
        ];
        return (
          <View style={styles.group}>
            <View style={styles.chips}>
              {picks.map(([key, date, text]) =>
                chip(`once-${key}`, text, rule.date === date, () =>
                  set(date ? { repeat: 'once', date } : { repeat: 'once' }),
                ),
              )}
            </View>
            <OnceDateBox
              date={rule.date}
              onDate={(date) => set(date ? { repeat: 'once', date } : { repeat: 'once' })}
              palette={palette}
              disabled={disabled}
              testID={`${testID}-once-date`}
              today={todayN}
            />
          </View>
        );
      }
      case 'daily':
        return null;
      case 'weekdays': {
        const order = cal.weekStart === 'sunday' ? [7, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7];
        return (
          <View style={styles.chips}>
            {order.map((day) =>
              chip(`day-${day}`, weekdayName(day, locale), rule.days.includes(day), () => {
                const days = toggle(rule.days, day);
                // Keep at least one day.
                if (days.length > 0) set({ ...rule, days });
              }),
            )}
          </View>
        );
      }
      case 'times': {
        const limit = PERS.find(([per]) => per === rule.per)![2];
        return (
          <View style={styles.group}>
            <View style={styles.chips}>
              {PERS.map(([per, key, max]) =>
                chip(`per-${per}`, t(locale, key), rule.per === per, () =>
                  set({ ...rule, per, count: Math.min(rule.count, max) }),
                ),
              )}
            </View>
            <View style={styles.line}>
              {caption(t(locale, 'scheduleCount'))}
              {stepper('count', rule.count, 1, limit, (count) => set({ ...rule, count }))}
            </View>
          </View>
        );
      }
      case 'monthDays':
        return (
          <View style={styles.chips}>
            {[...Array.from({ length: 31 }, (_, i) => i + 1), -1].map((x) =>
              chip(
                `dom-${x === -1 ? 'last' : x}`,
                x === -1 ? t(locale, 'scheduleLastDayShort') : String(x),
                rule.days.includes(x),
                () => {
                  const days = toggle(rule.days, x);
                  if (days.length > 0) set({ ...rule, days });
                },
              ),
            )}
          </View>
        );
      case 'interval':
        return (
          <View style={styles.line}>
            {caption(t(locale, 'scheduleEvery'))}
            {stepper('every', rule.every, 1, 60, (every) => set({ ...rule, every }))}
          </View>
        );
      case 'yearly':
        return (
          <View style={styles.group}>
            <View style={styles.chips}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) =>
                chip(`month-${m}`, monthName(m, locale), rule.month === m, () =>
                  set({ ...rule, month: m, day: Math.min(rule.day, DAYS_IN_MONTH[m - 1]!) }),
                ),
              )}
            </View>
            <View style={styles.line}>
              {caption(t(locale, 'scheduleDayOfMonth'))}
              {stepper('day', rule.day, 1, DAYS_IN_MONTH[rule.month - 1]!, (day) =>
                set({ ...rule, day }),
              )}
            </View>
          </View>
        );
    }
  };

  return (
    <View testID={testID} style={styles.group}>
      <View style={styles.chips}>
        {KINDS.map(([repeat, key]) =>
          chip(repeat, t(locale, key), rule?.repeat === repeat, () =>
            rule?.repeat === repeat
              ? undefined
              : set({ ...start(repeat), ...(rule?.time ? { time: rule.time } : {}) }),
          ),
        )}
        {chip('none', t(locale, 'scheduleNone'), rule === undefined, () => onChange(''))}
      </View>
      {details()}
      {rule ? (
        <View style={styles.line}>
          {caption(t(locale, 'scheduleTimeLabel'))}
          <TimeBox
            time={rule.time}
            onTime={(time) => {
              const { time: _, ...rest } = rule;
              onChange(time ? { ...rest, time } : rest);
            }}
            palette={palette}
            disabled={disabled}
            testID={`${testID}-time`}
          />
        </View>
      ) : null}
      {rule && rule.repeat !== 'once' ? (
        <View style={styles.line}>
          {caption(t(locale, 'scheduleTimesPerDay'))}
          {stepper('perDay', perDay ?? 1, 1, 20, (n) => {
            const { perDay: _, ...rest } = rule as Exclude<ScheduleRule, { repeat: 'once' }>;
            onChange(n > 1 ? { ...rest, perDay: n } : rest);
          })}
        </View>
      ) : null}
      {rule ? (
        <Text
          testID={`${testID}-summary`}
          style={[palette.font('bodyMedium', 14), { color: palette.muted }]}>
          {scheduleText(rule, locale)}
        </Text>
      ) : null}
      {lastDone && (rule?.repeat === 'interval' || rule?.repeat === 'times') ? (
        <Text style={[palette.font('body', 13), { color: palette.caption }]}>
          {t(locale, 'scheduleLastDoneHint', { field: lastDone })}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Time input (D-346): supports formats like 8:05, 08:05, 8:05; formats to HH:mm upon leaving the
 * input box, clears if empty, or restores the original value if unrecognized.
 */
function TimeBox({
  time,
  onTime,
  palette,
  disabled,
  testID,
}: {
  time: string | undefined;
  onTime: (time: string | undefined) => void;
  palette: Palette;
  disabled?: boolean | undefined;
  testID: string;
}) {
  const [text, setText] = useState(time ?? '');
  const [shownFor, setShownFor] = useState(time);
  if (time !== shownFor) {
    setShownFor(time);
    setText(time ?? '');
  }
  const commit = () => {
    const typed = text.trim();
    if (typed === '') return onTime(undefined);
    const normal = normalizeTime(typed);
    if (normal) onTime(normal);
    else setText(time ?? '');
  };
  return (
    <TextInput
      testID={testID}
      editable={!disabled}
      value={text}
      onChangeText={setText}
      onEndEditing={commit}
      onSubmitEditing={commit}
      placeholder="HH:MM"
      keyboardType="numbers-and-punctuation"
      placeholderTextColor={palette.caption}
      style={[
        palette.font('bodyMedium', 15),
        styles.dateBox,
        styles.timeBox,
        { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
      ]}
    />
  );
}

/**
 * "Once" date box: supports YYYY-MM-DD or phrases like "tomorrow", "next Friday", "Nov 5"
 * (recognized locally, D-344); converts to a date upon leaving the input box, or restores the
 * original value if unrecognized.
 */
function OnceDateBox({
  date,
  onDate,
  palette,
  disabled,
  testID,
  today,
}: {
  date: string | undefined;
  onDate: (date: string | undefined) => void;
  palette: Palette;
  disabled?: boolean | undefined;
  testID: string;
  today: number;
}) {
  const cal = useCalendar();
  const [text, setText] = useState(date ?? '');
  // Updates the input box when the outer date changes (e.g., tapping today or tomorrow).
  const [shownFor, setShownFor] = useState(date);
  if (date !== shownFor) {
    setShownFor(date);
    setText(date ?? '');
  }
  const commit = () => {
    const typed = text.trim();
    if (typed === '') return onDate(undefined);
    // The rule validates dates internally to ensure they are real (e.g., February 30 is invalid).
    const exact = readSchedule({ repeat: 'once', date: typed });
    if (exact?.repeat === 'once' && exact.date) return onDate(exact.date);
    const found = findDatePhrase(typed, today, cal)?.value;
    if (found?.kind === 'date') return onDate(found.date);
    setText(date ?? '');
  };
  return (
    <TextInput
      testID={testID}
      editable={!disabled}
      value={text}
      onChangeText={setText}
      onEndEditing={commit}
      onSubmitEditing={commit}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={palette.caption}
      style={[
        palette.font('bodyMedium', 15),
        styles.dateBox,
        { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dateBox: { borderWidth: 1, borderRadius: 12, minHeight: 44, paddingHorizontal: 12 },
  timeBox: { width: 110, textAlign: 'center' },
  group: { gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  step: { width: 48, height: 44, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepFirst: { borderTopLeftRadius: 12, borderBottomLeftRadius: 12 },
  stepLast: { borderTopRightRadius: 12, borderBottomRightRadius: 12 },
  stepValue: { minWidth: 44, textAlign: 'center' },
});

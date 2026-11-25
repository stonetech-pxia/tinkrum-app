import {
  fieldForRecord,
  hasRecordCurrency,
  perCurrencyText,
  BROWSE_PERIODS,
  browseFilter,
  browseFilterRows,
  browsePeriod,
  choiceRange,
  dateFieldOf,
  browseSort,
  browseSortKeys,
  cleanTags,
  recordSearchTexts,
  searchRecords,
  tagKey,
  tagsInRecords,
  pastTextValues,
  MAX_RECORD_TAGS,
  MAX_TAG_LENGTH,
  suggestionForField,
  filterPresets,
  listGroups,
  findDatePhrase,
  createInput,
  smartDateOf,
  withoutPhrase,
  aggregateRecords,
  latestNumber,
  newRecordDefaults,
  tapAlsoOf,
  calendarOf,
  filterRecords,
  followedFilter,
  fieldDefinition,
  formatDuration,
  formatNumber,
  formatRef,
  untitledRecordTitle,
  formatValue,
  changeLabel,
  compareChange,
  elapsedOf,
  formatElapsed,
  groupRecords,
  previousFilter,
  previousLabel,
  previousToDateRange,
  recordsFollowingRange,
  recordsInRange,
  progressOf,
  recordProgress,
  isSequenceAggregate,
  linkTitle,
  localDateTime,
  prepareRecordValues,
  pickedOptions,
  readValue,
  recordValue,
  sequenceText,
  sequenceValue,
  shownRowAction,
  sortList,
  sortRecords,
  todayNumber,
  type Aggregate,
  type Collection,
  RECORD_LOOKS,
  isKnownComponent,
  type BlockOf,
  type Component,
  type Calendar,
  type OpenUse,
  type RecordLook,
  type Sort,
  type RecordToolUse,
  type ToolUse,
  isOpenUse,
  isRecordToolUse,
  localeTag,
  type ComponentStyle,
  type DataRecord,
  type BrowseFilterRow,
  type BrowsePeriod,
  type ValueSuggestion,
  type LinkedGroups,
  type Field,
  type FieldIssue,
  type FieldOf,
  type FieldType,
  type FieldValue,
  type Backdrop,
  calculatedNumber,
  calculatedText,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  ScrollView,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  Keyboard,
} from 'react-native';

import { useLinkPick } from '../data/link-pick';
import { useRecordActionRunner } from '../data/record-actions';
import { useComputedRecords, useLinkResolver, useRecordActions, useRecords } from '../data/records';
import { useSimilarCheck } from '../data/similar-records';
import { useCalendar, useWorkspace } from '../workspace/context';
import { BottomSheet } from './Overlays';
import { t } from '../i18n';
import { AttachmentThumb, AttachmentsInput, firstImage, useAssetIndex } from './Attachments';
import { onPicture } from './Backdrop';
import { openRow } from './open-row';
import { RowActionButton } from './RecordActions';
import { ScheduleInput } from './ScheduleInput';
import type { RenderEnv } from './components';
import { Icon, UiIcon } from './Icon';
import { ProgressBar, ProgressRing } from './Progress';
import { useTicker } from './ticker';
import { SIZES } from './style';
import { cardColors, onPage, type Palette } from './theme';
import { ColorDot, recordMarks } from './record-marks';
import { DayGrid, PickButton, TimeChips } from './DatePicker';
import { RecordGallery } from './RecordGallery';
import { RecordTable } from './RecordTable';
import { Button, Card } from './ui';

// Data components (docs/DATA_DESIGN.md): record lists, quick-add forms, statistics. Records are
// only read and displayed locally, never entering the config and never sent to the AI.

type FormValues = Record<string, unknown>;

/** Record values -> form values (numbers are text while editing). */
export function toFormValues(collection: Collection, record: DataRecord | null): FormValues {
  const values: FormValues = {};
  for (const field of collection.fields) {
    const v = record ? readValue(field, record.values[field.id]) : undefined;
    if (v === undefined) continue;
    const toForm = (FIELD_EDITORS[field.type] as FieldEditor).toForm;
    values[field.id] = toForm ? toForm(v) : v;
  }
  return values;
}

/**
 * Starting values of a blank new-record form: a date field with `default: "today"` shows today
 * (what a save would fill in anyway, so the user sees it before saving). `only` limits this to the
 * fields the form asks for. Other defaults are not shown; the save still applies them.
 */
export function newFormValues(
  collection: Collection,
  cal: Calendar,
  only?: readonly string[],
): FormValues {
  const defaults = newRecordDefaults(collection, new Date(), cal);
  const dates = collection.fields.filter(
    (f) => f.type === 'date' && defaults[f.id] !== undefined && (!only || only.includes(f.id)),
  );
  return Object.fromEntries(dates.map((f) => [f.id, defaults[f.id]]));
}

/**
 * New record form opened by a quick action (D-338): preset values (createInput input, JSON) are
 * converted to form representation. Unreadable fields or fields no longer present are ignored.
 */
export function prefillFormValues(collection: Collection, json: string): FormValues {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof input !== 'object' || input === null) return {};
  const values: FormValues = {};
  for (const field of collection.fields) {
    const v = readValue(field, (input as Record<string, unknown>)[field.id]);
    if (v === undefined) continue;
    const toForm = (FIELD_EDITORS[field.type] as FieldEditor).toForm;
    values[field.id] = toForm ? toForm(v) : v;
  }
  return values;
}

function issueText(locale: RenderEnv['locale'], issue: FieldIssue, field: Field): string {
  // Out of range (D-570): state the boundaries, include currency for amounts, and format durations as h:mm.
  if ((issue.code === 'tooSmall' || issue.code === 'tooLarge') && issue.limit !== undefined)
    return t(locale, issue.code === 'tooSmall' ? 'fieldTooSmall' : 'fieldTooLarge', {
      limit: formatValue(field, issue.limit, locale),
    });
  return t(
    locale,
    issue.code === 'required'
      ? 'fieldRequired'
      : issue.code === 'tooLong'
        ? 'fieldTooLong'
        : 'fieldInvalid',
  );
}

/** Input control for a single field. */
export function FieldInput({
  field,
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
  labeled = false,
  onSubmit,
  autoFocus,
  tableId,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean;
  testID: string;
  /** Label when the field name is already shown externally (full edit page). */
  labeled?: boolean;
  /** Quick add (D-352): pressing "Done / Send" on the keyboard for a single-line text box adds the entry. */
  onSubmit?: (() => void) | undefined;
  /** When the bottom-sheet add form opens, the first text box immediately triggers the keyboard (D-352). */
  autoFocus?: boolean | undefined;
  /** Table containing this field (tags need to compute existing tags from this table's records). */
  tableId?: string | undefined;
}) {
  const input = [
    styles.input,
    palette.font('body', 16),
    {
      color: palette.text,
      backgroundColor: palette.surface,
      borderColor: palette.border,
      borderRadius: palette.controlRadius,
    },
  ];
  const chip = (selected: boolean) => [
    styles.chip,
    {
      borderColor: selected ? palette.primary : palette.border,
      backgroundColor: selected ? palette.primaryTint : palette.surface,
    },
  ];
  const editor = FIELD_EDITORS[field.type] as FieldEditor;
  return editor.input({
    field,
    value,
    onChange,
    palette,
    locale,
    disabled,
    testID,
    labeled,
    input,
    chip,
    onSubmit,
    autoFocus,
    tableId,
  });
}

interface FieldInputContext<F extends Field> {
  field: F;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled: boolean | undefined;
  testID: string;
  /** Label indicating whether the field name is already shown externally; if not, the control writes the field name itself (duration). */
  labeled: boolean;
  /** Style of the input box. */
  input: StyleProp<TextStyle>;
  /** Style of option chips. */
  chip: (selected: boolean) => StyleProp<ViewStyle>;
  onSubmit?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
  tableId?: string | undefined;
}

/** How a field type is filled in a record form (field structure, read/write, and display are in core's fields/<type>.ts). */
interface FieldEditor<F extends Field = Field> {
  /** Input control. Called as a function (not a React component); hooks should be placed inside their own components. Returns null when there is no control. */
  input: (ctx: FieldInputContext<F>) => ReactNode;
  /** Record values -> form values (numbers are text while editing). */
  toForm?: (value: FieldValue) => unknown;
  /** Label and control on the same line (checkbox). */
  inline?: true;
  /** Read-only, displays computed value (formula, D-188). */
  computed?: true;
}

/** Keyboards for phone numbers, emails, and URLs (D-422). Keyboard only: does not validate format on save, anything can be typed. */
const FORMAT_KEYBOARD = {
  phone: 'phone-pad',
  email: 'email-address',
  url: 'url',
} as const;

/** Text, long text, number, amount: a single input box. */
function textBox<F extends Field>({
  field,
  value,
  onChange,
  palette,
  disabled,
  testID,
  input,
  onSubmit,
  autoFocus,
}: FieldInputContext<F>) {
  // Single-line text box in quick add: pressing "Done" on the keyboard adds the entry (D-352) without dismissing the keyboard, allowing the next one to be written.
  const submits = onSubmit !== undefined && field.type === 'text';
  return (
    <TextInput
      testID={testID}
      editable={!disabled}
      value={typeof value === 'string' ? value : ''}
      onChangeText={onChange}
      autoFocus={autoFocus === true && field.type === 'text'}
      // Record fields are not login credentials: Samsung asks whether to save forms into the password manager.
      autoComplete="off"
      importantForAutofill="no"
      {...(submits
        ? {
            returnKeyType: 'done' as const,
            onSubmitEditing: onSubmit,
            submitBehavior: 'submit' as const,
          }
        : {})}
      placeholder={
        field.type === 'money' && !field.currencyField
          ? `${field.name} (${field.currency})`
          : field.name
      }
      placeholderTextColor={palette.caption}
      multiline={field.type === 'note'}
      keyboardType={field.type === 'number' || field.type === 'money' ? 'decimal-pad' : 'default'}
      {...(field.type === 'text' && field.format
        ? {
            keyboardType: FORMAT_KEYBOARD[field.format],
            autoCapitalize: 'none' as const,
            autoCorrect: false,
          }
        : {})}
      style={[input, field.type === 'note' && styles.note]}
    />
  );
}

/**
 * Date: an input box plus a calendar button. A new record starts as today through the field's
 * `default: "today"` (D-286). The box also accepts "next Friday", "Nov 5", "demain", converting to a
 * date locally upon leaving the input box (D-344).
 */
function DateInput({
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
  input,
}: FieldInputContext<FieldOf<'date'>>) {
  const cal = useCalendar();
  const [picking, setPicking] = useState(false);
  const today = todayNumber(new Date(), cal);
  const recognise = () => {
    if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return;
    const found = findDatePhrase(value, today, cal)?.value;
    if (found?.kind === 'date') onChange(found.date);
  };
  const text = typeof value === 'string' ? value : '';
  return (
    <View style={styles.datePicker}>
      <View style={styles.dateRow}>
        <TextInput
          testID={testID}
          editable={!disabled}
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          onEndEditing={recognise}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={palette.caption}
          style={[input, styles.flex]}
        />
        <PickButton
          open={picking}
          onPress={() => setPicking(!picking)}
          palette={palette}
          locale={locale}
          disabled={disabled}
          testID={`${testID}-pick`}
        />
      </View>
      {picking ? (
        <DayGrid
          value={/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined}
          onPick={(date) => {
            onChange(date);
            setPicking(false);
          }}
          palette={palette}
          locale={locale}
          cal={cal}
          testID={testID ?? 'date'}
        />
      ) : null}
    </View>
  );
}

export const FIELD_EDITORS: { [T in FieldType]: FieldEditor<FieldOf<T>> } = {
  text: { input: textBox },
  note: { input: textBox },
  number: { input: textBox, toForm: String },
  money: { input: textBox, toForm: String },
  date: { input: (ctx) => <DateInput {...ctx} /> },
  // D-279: Hours and minutes; "Now" fills in the current time.
  time: {
    input: (ctx) => (
      <TimeInput ctx={ctx} placeholder="HH:MM" nowValue={(now) => localDateTime(now).slice(11)} />
    ),
  },
  // D-279: Date and time, formatted as "2026-10-29 08:30" while editing.
  datetime: {
    input: (ctx) => (
      <TimeInput
        ctx={ctx}
        placeholder="YYYY-MM-DD HH:MM"
        nowValue={(now) => localDateTime(now).replace('T', ' ')}
        withDate
      />
    ),
    toForm: (v) => String(v).replace('T', ' '),
  },
  // D-279: Duration, with separate hours and minutes boxes; form value is "h:mm" (blank side counts as 0).
  duration: {
    input: (ctx) => <DurationInput {...ctx} />,
    toForm: (v) => formatDuration(v as number),
  },
  checkbox: {
    inline: true,
    input: ({ value, onChange, palette, disabled, testID }) => (
      <Switch
        testID={testID}
        disabled={disabled}
        value={value === true}
        onValueChange={onChange}
        trackColor={{ true: palette.primary, false: palette.border }}
        thumbColor="#FFFFFF"
      />
    ),
  },
  // Multi-select (D-607): a row of options where tapping one adds or removes it; form value is a list of option IDs.
  choice: {
    input: ({ field, value, onChange, palette, disabled, testID, chip }) => {
      const picked = field.multiple ? pickedOptions(field, value) : [];
      const isOn = (id: string) => (field.multiple ? picked.includes(id) : value === id);
      const toggle = (id: string) =>
        field.multiple
          ? onChange(
              isOn(id) ? picked.filter((x) => x !== id) : pickedOptions(field, [...picked, id]),
            )
          : onChange(value === id ? '' : id);
      return (
        <View style={styles.chips}>
          {field.options.map((o) => (
            <Pressable
              key={o.id}
              testID={`${testID}-${o.id}`}
              disabled={disabled}
              {...(field.multiple
                ? {
                    accessibilityRole: 'checkbox' as const,
                    accessibilityState: { checked: isOn(o.id) },
                  }
                : {})}
              onPress={() => toggle(o.id)}
              style={chip(isOn(o.id))}>
              <Text style={[palette.font('bodyBold', 13), { color: palette.text }]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      );
    },
  },
  file: {
    input: ({ field, value, onChange, palette, locale, disabled, testID }) => (
      <AttachmentsInput
        field={field}
        value={value}
        onChange={onChange}
        palette={palette}
        locale={locale}
        disabled={disabled}
        testID={testID}
      />
    ),
  },
  // Formulas are read-only and displayed by FieldsForm (D-188).
  formula: { computed: true, input: () => null },
  // Lookups, rollups, and previous items (D-287-D-289) are also computed: the record page displays the computed value stored in the record.
  lookup: { computed: true, input: () => null },
  rollup: { computed: true, input: () => null },
  previous: { computed: true, input: () => null },
  // Computed date (D-542).
  dateOffset: { computed: true, input: () => null },
  link: {
    input: ({ field, value, onChange, palette, locale, disabled, testID }) => (
      <LinkInput
        field={field}
        value={value}
        onChange={onChange}
        palette={palette}
        locale={locale}
        disabled={disabled}
        testID={testID}
      />
    ),
  },
  // D-279: Schedule, select recurrence pattern first, then fill in numbers or days.
  schedule: {
    input: ({ field, value, onChange, palette, locale, disabled, testID }) => (
      <ScheduleInput
        field={field}
        value={value}
        onChange={onChange}
        palette={palette}
        locale={locale}
        disabled={disabled}
        testID={testID}
      />
    ),
  },
  tags: {
    input: ({
      field,
      value,
      onChange,
      palette,
      locale,
      disabled,
      testID,
      chip,
      input,
      tableId,
    }) => (
      <TagsInput
        field={field}
        value={value}
        onChange={onChange}
        palette={palette}
        locale={locale}
        disabled={disabled}
        testID={testID}
        chip={chip}
        input={input}
        tableId={tableId}
      />
    ),
  },
  rating: {
    input: ({ value, onChange, palette, disabled, testID }) => (
      <View style={styles.chips}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            testID={`${testID}-${n}`}
            disabled={disabled}
            hitSlop={4}
            onPress={() => onChange(value === n ? '' : n)}>
            <Text
              style={{
                fontSize: 26,
                color: typeof value === 'number' && n <= value ? palette.primary : palette.border,
              }}>
              ★
            </Text>
          </Pressable>
        ))}
      </View>
    ),
  },
};

/** These characters turn preceding text into a tag while typing. */
const TAG_BREAK = /[,，、;；\n]/;
/** Maximum number of existing tags listed in the form (filtered by typed text). */
const MAX_TAG_CHOICES = 24;

/**
 * Tags (decided by founder 2026-11-04): tags for this record (tapping removes), an input box
 * (commas or "Done" on the keyboard turns text into a tag), and existing tags for this table
 * (tapping adds, computed on the fly from records). Text currently being typed also counts
 * towards the form value (as the last item): saving directly without pressing "Done" is not lost.
 */
function TagsInput({
  field,
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
  chip,
  input,
  tableId,
}: {
  field: FieldOf<'tags'>;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled: boolean | undefined;
  testID: string;
  chip: (selected: boolean) => StyleProp<ViewStyle>;
  input: StyleProp<TextStyle>;
  tableId: string | undefined;
}) {
  const view = useWorkspace((s) => s.config?.data.tables.find((c) => c.id === tableId));
  const records = useRecords(tableId ?? '');
  const [draft, setDraft] = useState('');
  const tags = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const chosen = draft !== '' && tags[tags.length - 1] === draft ? tags.slice(0, -1) : tags;
  const chosenKeys = new Set(chosen.map(tagKey));
  const type = (text: string) => {
    const parts = text.split(TAG_BREAK);
    const typing = parts.pop()!.trimStart();
    const done = cleanTags([...chosen, ...parts]);
    setDraft(typing);
    onChange(typing ? [...done, typing] : done);
  };
  const commit = () => {
    setDraft('');
    onChange(cleanTags(tags));
  };
  const add = (tag: string) => {
    setDraft('');
    onChange(cleanTags([...chosen, tag]));
  };
  const typedKey = tagKey(draft.trim());
  const choices =
    view && records
      ? tagsInRecords(records, view, field.id, locale)
          .filter((tag) => !chosenKeys.has(tagKey(tag)) && tagKey(tag).includes(typedKey))
          .slice(0, MAX_TAG_CHOICES)
      : [];
  const label = [palette.font('bodyBold', 13), { color: palette.text }];
  return (
    <View style={styles.fields}>
      {chosen.length > 0 ? (
        <View style={styles.chips}>
          {chosen.map((tag) => (
            <Pressable
              key={tag}
              testID={`${testID}-tag-${tag}`}
              accessibilityRole="button"
              accessibilityLabel={t(locale, 'tagRemove', { tag })}
              disabled={disabled}
              onPress={() => onChange(chosen.filter((x) => x !== tag))}
              style={chip(true)}>
              <Text style={label}>{`${tag} ×`}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {chosen.length < MAX_RECORD_TAGS ? (
        <View style={styles.dateRow}>
          <TextInput
            testID={testID}
            editable={!disabled}
            value={draft}
            onChangeText={type}
            onSubmitEditing={commit}
            submitBehavior="submit"
            maxLength={MAX_TAG_LENGTH}
            placeholder={t(locale, 'tagsAdd')}
            placeholderTextColor={palette.caption}
            returnKeyType="done"
            style={[input, styles.flex]}
          />
          {draft.trim() ? (
            <Pressable testID={`${testID}-add`} onPress={commit} style={chip(false)}>
              <Text style={label}>{t(locale, 'tagsAddButton')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {choices.length > 0 ? (
        <View style={styles.chips}>
          {choices.map((tag) => (
            <Pressable
              key={tag}
              testID={`${testID}-choice-${tag}`}
              disabled={disabled}
              onPress={() => add(tag)}
              style={chip(false)}>
              <Text style={label}>{tag}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Time, date-time: an input box with an adjacent "Now" button that fills in the current time (D-279). */
/**
 * Time, date-time (D-279): typing, "Now", or picking from a picker (D-543). Date-time picks a day
 * first then hours and minutes; missing halves default to current values.
 */
function TimeInput<F extends Field>({
  ctx,
  placeholder,
  nowValue,
  withDate,
}: {
  ctx: FieldInputContext<F>;
  placeholder: string;
  nowValue: (now: Date) => string;
  withDate?: boolean;
}) {
  const { field, value, onChange, palette, locale, disabled, testID, input, chip } = ctx;
  const cal = useCalendar();
  const [picking, setPicking] = useState(false);
  const text = typeof value === 'string' ? value.trim() : '';
  const now = nowValue(new Date());
  const m = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}:\d{2})$/.exec(text);
  const date = withDate
    ? (m?.[1] ?? (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined))
    : undefined;
  const time = m?.[2];
  const put = (d: string | undefined, hm: string | undefined) =>
    onChange(withDate ? `${d ?? now.slice(0, 10)} ${hm ?? now.slice(11)}` : (hm ?? now));
  return (
    <View style={styles.datePicker}>
      <View style={styles.dateRow}>
        <TextInput
          testID={testID}
          editable={!disabled}
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          // No label in the quick-add form: placeholder displays field name and format (similar to amount's "Hourly rate (CNY)").
          placeholder={`${field.name} (${placeholder})`}
          placeholderTextColor={palette.caption}
          keyboardType="numbers-and-punctuation"
          style={[input, styles.flex]}
        />
        <Pressable
          testID={`${testID}-now`}
          disabled={disabled}
          onPress={() => onChange(nowValue(new Date()))}
          style={chip(false)}>
          <Text style={[palette.font('bodyBold', 13), { color: palette.text }]}>
            {t(locale, 'now')}
          </Text>
        </Pressable>
        <PickButton
          open={picking}
          onPress={() => setPicking(!picking)}
          palette={palette}
          locale={locale}
          disabled={disabled}
          testID={`${testID}-pick`}
        />
      </View>
      {picking && withDate ? (
        <DayGrid
          value={date}
          onPick={(d) => put(d, time)}
          palette={palette}
          locale={locale}
          cal={cal}
          testID={testID ?? 'datetime'}
        />
      ) : null}
      {picking ? (
        <TimeChips
          value={time}
          onPick={(hm) => put(date, hm)}
          palette={palette}
          locale={locale}
          testID={testID ?? 'time'}
        />
      ) : null}
    </View>
  );
}

/** Duration (D-279): two numeric boxes for hours and minutes, combined as "h:mm" and passed to core for validation (minutes must be under 60). */
function DurationInput({
  field,
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
  labeled,
  input,
}: FieldInputContext<Field>) {
  const [hours = '', minutes = ''] = typeof value === 'string' ? value.split(':') : [];
  const change = (h: string, m: string) => onChange(h === '' && m === '' ? '' : `${h}:${m}`);
  const box = (part: 'hours' | 'minutes') => (
    <View style={[styles.dateRow, styles.flex]}>
      <TextInput
        testID={`${testID}-${part}`}
        editable={!disabled}
        value={part === 'hours' ? hours : minutes}
        onChangeText={(text) => {
          const digits = text.replace(/\D/g, '');
          if (part === 'hours') change(digits, minutes);
          else change(hours, digits.slice(0, 2));
        }}
        placeholder="0"
        placeholderTextColor={palette.caption}
        keyboardType="number-pad"
        accessibilityLabel={t(locale, part === 'hours' ? 'durationHours' : 'durationMinutes')}
        style={[input, styles.flex]}
      />
      <Text style={[palette.font('body', 15), { color: palette.muted }]}>
        {t(locale, part === 'hours' ? 'durationHours' : 'durationMinutes')}
      </Text>
    </View>
  );
  return (
    <View testID={testID} style={styles.dateRow}>
      {labeled ? null : (
        <Text style={[palette.font('bodyBold', 15), { color: palette.text }]}>{field.name}</Text>
      )}
      {box('hours')}
      {box('minutes')}
    </View>
  );
}

/** Maximum number of items listed when selecting a record (sorted by recently modified, searchable). */
const LINK_LIST_LIMIT = 30;

/**
 * Whether the input box is rendered inside a bottom-sheet add form (D-352 Modal). The modal
 * overlays the page, and new pages opened from within it would be blocked by it, so reference
 * fields there lack "Add new" (D-546).
 */
const InSheet = createContext(false);

/**
 * Reference field (D-250): displays the title of the selected record; tapping opens the list of
 * records in the referenced table (searchable by title), and tapping one selects it. If the
 * referenced record is deleted, displays "Deleted record", allowing a replacement or clearing the
 * selection.
 */
function LinkInput({
  field,
  value,
  onChange,
  palette,
  locale,
  disabled,
  testID,
}: {
  field: Extract<Field, { type: 'link' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean | undefined;
  testID: string;
}) {
  const tables = useWorkspace((s) => s.config?.data.tables);
  const target = tables?.find((c) => c.id === field.table);
  const cal = useCalendar();
  const now = new Date();
  // Display and search use computed results (lookup, rollup); selection still uses the original record ID.
  const { view, records } = useComputedRecords(tables ?? [], target, cal);
  const links = useLinkResolver(view);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const router = useRouter();
  const inSheet = useContext(InSheet);
  // "Add new" (D-546): after the new record page is saved, it returns the record ID, which is then selected here.
  const [token] = useState(() => Math.random().toString(36).slice(2, 10));
  useEffect(
    () =>
      useLinkPick.subscribe(({ picked }) => {
        if (picked?.token !== token) return;
        useLinkPick.setState({ picked: null });
        onChange(picked.id);
        setOpen(false);
      }),
    [token, onChange],
  );
  if (!target) return null;
  const chosen = typeof value === 'string' && value ? value : null;
  const chosenRecord = chosen ? records?.find((r) => r.id === chosen) : undefined;
  const shown = chosen
    ? chosenRecord
      ? linkTitle(chosenRecord, target, locale)
      : records === null
        ? ''
        : t(locale, 'linkDeleted')
    : t(locale, 'linkNone');
  // Follows the same rule as list search: every field in this table (decided by founder 2026-11-04).
  const found = view
    ? searchRecords(records ?? [], query, (r) =>
        recordSearchTexts(r, view, [], locale, links, now, cal),
      )
    : [];
  const matches = found
    .map((r) => ({ r, title: linkTitle(r, target, locale) }))
    .sort((a, b) => b.r.updatedAt - a.r.updatedAt)
    .slice(0, LINK_LIST_LIMIT);
  const row = [styles.dateRow, styles.attachment];
  return (
    <View style={styles.fields}>
      <Pressable
        testID={testID}
        disabled={disabled}
        onPress={() => setOpen(!open)}
        style={[
          styles.input,
          ...row,
          {
            borderColor: palette.border,
            borderRadius: palette.controlRadius,
            backgroundColor: palette.surface,
          },
        ]}>
        <Icon name="link" size={18} color={palette.secondary} />
        <Text
          numberOfLines={1}
          style={[
            styles.flex,
            palette.font('bodyMedium', 15),
            { color: chosen ? palette.text : palette.caption },
          ]}>
          {shown}
        </Text>
        <Text style={[palette.font('bodyBold', 13), { color: palette.primaryText }]}>
          {t(locale, 'linkChoose')}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.fields}>
          {(records?.length ?? 0) > 8 ? (
            <TextInput
              testID={`${testID}-search`}
              value={query}
              onChangeText={setQuery}
              placeholder={t(locale, 'linkSearch')}
              placeholderTextColor={palette.caption}
              style={[
                styles.input,
                palette.font('body', 15),
                {
                  color: palette.text,
                  borderColor: palette.border,
                  borderRadius: palette.controlRadius,
                },
              ]}
            />
          ) : null}
          {records !== null && records.length === 0 ? (
            <Text style={[palette.font('body', 14), { color: palette.caption }]}>
              {t(locale, 'linkEmptyTable', { name: target.name })}
            </Text>
          ) : null}
          {matches.map(({ r, title }) => (
            <Pressable
              key={r.id}
              testID={`${testID}-option-${r.id}`}
              onPress={() => {
                onChange(r.id);
                setOpen(false);
              }}
              style={[
                styles.chip,
                { borderColor: palette.border },
                chosen === r.id && {
                  borderColor: palette.primary,
                  backgroundColor: palette.primaryTint,
                },
              ]}>
              <Text
                numberOfLines={1}
                style={[palette.font('bodyMedium', 14), { color: palette.text }]}>
                {title}
              </Text>
            </Pressable>
          ))}
          {inSheet ? null : (
            <Pressable
              testID={`${testID}-new`}
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: '/record/[collectionId]',
                  params: { collectionId: target.id, pickFor: token },
                })
              }
              style={[styles.chip, { borderColor: palette.border, borderStyle: 'dashed' }]}>
              <Text
                numberOfLines={1}
                style={[palette.font('bodyMedium', 14), { color: palette.primaryText }]}>
                {t(locale, 'linkNew', { name: target.name })}
              </Text>
            </Pressable>
          )}
          {chosen ? (
            <Pressable
              testID={`${testID}-clear`}
              onPress={() => {
                onChange('');
                setOpen(false);
              }}>
              <Text style={[palette.font('bodyBold', 13), { color: palette.muted }]}>
                {t(locale, 'linkClear')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Input for a group of fields, with name and error messages. Shared between record edit page and inline form. */
const isEmptyValue = (v: unknown) => v === undefined || v === null || v === '';

/** Format suggestion dates with month names (e.g., August 11, 2026, Aug 11, 2026, 11 août 2026): distinguishes candidates when day/month order is ambiguous. */
function suggestionDate(iso: string, locale: RenderEnv['locale']): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/** Suggestion value -> form representation (D-575): ratings are numbers, others (amounts, numbers, dates, times, durations in h:mm, option IDs) are text strings. */
export const suggestionFormValue = (field: Pick<Field, 'type'>, value: string): unknown =>
  field.type === 'rating' ? Number(value) : value;

/**
 * Suggestion chips below fields (D-394): quiet small buttons displaying formatted values (amounts
 * with currency, dates with month names), truncated if too long; applied only upon tapping, never
 * auto-filled. Tapped suggestions stay in place (fields below do not jump up), matching the
 * field's value is marked as selected, and tapping another switches to it.
 */
function SuggestionChips({
  field,
  list,
  current,
  palette,
  locale,
  disabled,
  testID,
  onPick,
}: {
  field: Field;
  list: readonly ValueSuggestion[];
  /** Current value of the field (marked as selected on the matching suggestion chip). */
  current: unknown;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean | undefined;
  testID: string;
  onPick: (s: ValueSuggestion) => void;
}) {
  const numeric = field.type === 'money' || field.type === 'number';
  const shown = (s: ValueSuggestion) =>
    field.type === 'date'
      ? suggestionDate(s.value, locale)
      : field.type === 'duration' || field.type === 'time'
        ? s.value
        : field.type === 'rating'
          ? formatValue(field, Number(s.value), locale)
          : hasRecordCurrency(field)
            ? formatNumber(Number(s.value), undefined, locale) // D-429: Currency selection still requires user input, skipped for now.
            : formatValue(field, numeric ? Number(s.value) : s.value, locale) || s.value;
  const isCurrent = (s: ValueSuggestion) =>
    !isEmptyValue(current) &&
    (numeric || field.type === 'rating'
      ? Number(current) === Number(s.value)
      : String(current) === s.value);
  return (
    <View testID={testID} style={styles.suggestions}>
      {list.map((s, i) => {
        const value = shown(s);
        const selected = isCurrent(s);
        return (
          <Pressable
            key={`${s.value}-${i}`}
            testID={`${testID}-${i}`}
            disabled={disabled}
            onPress={() => onPick(s)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={t(locale, 'suggestionFill', { field: field.name, value })}
            hitSlop={4}
            style={[
              styles.suggestion,
              {
                borderColor: selected ? palette.primary : palette.border,
                borderRadius: palette.radius / 2,
              },
            ]}>
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={[
                palette.font(selected ? 'bodyMedium' : 'body', 13),
                { color: selected ? palette.primary : palette.muted },
              ]}>
              {value}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Most values offered under a text field with suggest. */
const MAX_PAST_VALUES = 8;

/**
 * Earlier values under a text field with suggest: true (D-642): what
 * this table's entries already hold in it, computed on the fly (pastTextValues) and narrowed by
 * what is typed; values already offered as candidates from the attachments are not repeated. A tap
 * only fills the input; the list stays as it was, so the fields below don't jump, until the user
 * types again.
 */
function PastValueChips({
  collection,
  field,
  current,
  candidates,
  onPick,
  ...chips
}: {
  collection: Collection;
  field: Field;
  current: unknown;
  /** Candidates shown above this list for the same field (D-394). */
  candidates: readonly ValueSuggestion[] | undefined;
  onPick: (value: string) => void;
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean | undefined;
  testID: string;
}) {
  const records = useRecords(collection.id);
  const [held, setHeld] = useState<{ value: string; list: string[] } | null>(null);
  const list =
    held && held.value === current
      ? held.list
      : pastTextValues(records ?? [], collection, field.id, current, MAX_PAST_VALUES).filter(
          (value) => !candidates?.some((c) => suggestionForField(field, c).value === value),
        );
  if (list.length === 0) return null;
  return (
    <SuggestionChips
      {...chips}
      field={field}
      list={list.map((value) => ({ value, score: 0 }))}
      current={current}
      onPick={({ value }) => {
        setHeld({ value, list });
        onPick(value);
      }}
    />
  );
}

export function FieldsForm({
  collection,
  fieldIds,
  values,
  onChange,
  issues,
  palette,
  locale,
  disabled,
  testPrefix,
  showLabels = true,
  related,
  onSubmit,
  autoFocus,
  suggestions,
  onSuggestion,
  heard,
}: {
  collection: Collection;
  fieldIds: readonly string[];
  values: FormValues;
  onChange: (values: FormValues) => void;
  issues: FieldIssue[];
  palette: Palette;
  locale: RenderEnv['locale'];
  disabled?: boolean;
  testPrefix: string;
  showLabels?: boolean;
  /**
   * Record page (D-291): The table used for display and the value computed after this record is
   * saved (lookup, rollup, previous); null for new records, these field types only have values
   * after being saved.
   */
  related?: { view: Collection; record: DataRecord | null };
  /** Quick add (D-352): Add immediately when "Done" is pressed on a single-line text input. */
  onSubmit?: (() => void) | undefined;
  /** Pop up the keyboard directly on the first text box (bottom-sheet add box). */
  autoFocus?: boolean | undefined;
  /** New record form candidate values (D-394): Field ID -> at most 3, shown only when the field is empty, filled only when clicked. */
  suggestions?: Readonly<Record<string, readonly ValueSuggestion[]>> | undefined;
  /** User clicked a suggestion (already filled into the field). */
  onSuggestion?: ((fieldId: string, suggestion: ValueSuggestion) => void) | undefined;
  /** Fields filled directly from what the user said (D-575): Shows "Filled based on what you said" below; disappears once the user modifies it. */
  heard?: ReadonlySet<string> | undefined;
}) {
  const cal = useCalendar();
  const firstText = fieldIds.find(
    (id) => collection.fields.find((f) => f.id === id)?.type === 'text',
  );
  const view = related?.view ?? collection;
  // Formula evaluated using current form values (D-188); lookup, rollup, and previous use values computed from the saved record.
  const computed = () => {
    const prepared = prepareRecordValues(collection, values, null, new Date(), cal);
    const saved = related?.record?.values ?? {};
    const derived = Object.fromEntries(
      collection.fields
        .filter((f) => !fieldDefinition(f.type).write && f.id in saved)
        .map((f) => [f.id, saved[f.id]]),
    );
    return {
      id: related?.record?.id ?? '',
      collectionId: collection.id,
      values: { ...derived, ...(prepared.ok ? prepared.values : {}) },
      createdAt: related?.record?.createdAt ?? 0,
      updatedAt: related?.record?.updatedAt ?? 0,
    };
  };
  return (
    <View style={styles.fields}>
      {fieldIds.map((id) => {
        const field = collection.fields.find((f) => f.id === id);
        if (!field) return null;
        const editor = FIELD_EDITORS[field.type] as FieldEditor;
        if (editor.computed) {
          const shown = formatValue(
            view.fields.find((f) => f.id === id) ?? field,
            recordValue(computed(), view, id, new Date(), cal),
            locale,
          );
          return (
            <View key={id} style={styles.field}>
              <Text style={[palette.font('bodyBold', 13), { color: palette.muted }]}>
                {field.name}
              </Text>
              <Text
                testID={`${testPrefix}-${id}`}
                style={[palette.font('title', 16), { color: palette.text }]}>
                {shown || '—'}
              </Text>
            </View>
          );
        }
        const issue = issues.find((i) => i.fieldId === id);
        const inline = editor.inline === true;
        // Input hint (D-570): A short sentence below the input box, using text from the config.
        const hint =
          'hint' in field && field.hint !== undefined ? (
            <Text
              testID={`${testPrefix}-${id}-hint`}
              style={[palette.font('body', 13), { color: palette.caption }]}>
              {field.hint}
            </Text>
          ) : null;
        const row = (
          <View key={id} style={inline ? styles.inlineField : styles.field}>
            {showLabels || inline ? (
              <Text
                style={[
                  palette.font('bodyBold', 13),
                  { color: palette.muted },
                  inline && styles.flex,
                ]}>
                {field.name}
                {'required' in field && field.required ? ' *' : ''}
              </Text>
            ) : null}
            <FieldInput
              field={field}
              value={values[id]}
              onChange={(v) => onChange({ ...values, [id]: v })}
              palette={palette}
              locale={locale}
              disabled={disabled}
              testID={`${testPrefix}-${id}`}
              labeled={showLabels || inline}
              onSubmit={onSubmit}
              autoFocus={autoFocus === true && id === firstText}
              tableId={collection.id}
            />
            {suggestions?.[id]?.length ? (
              <SuggestionChips
                field={field}
                list={suggestions[id]!.map((s) => suggestionForField(field, s))}
                current={values[id]}
                palette={palette}
                locale={locale}
                disabled={disabled}
                testID={`${testPrefix}-${id}-suggestion`}
                onPick={(s) => {
                  onChange({ ...values, [id]: suggestionFormValue(field, s.value) });
                  onSuggestion?.(id, s);
                }}
              />
            ) : null}
            {field.type === 'text' && field.suggest ? (
              <PastValueChips
                collection={collection}
                field={field}
                current={values[id]}
                candidates={suggestions?.[id]}
                palette={palette}
                locale={locale}
                disabled={disabled}
                testID={`${testPrefix}-${id}-past`}
                onPick={(value) => onChange({ ...values, [id]: value })}
              />
            ) : null}
            {heard?.has(id) ? (
              <Text
                testID={`${testPrefix}-${id}-heard`}
                style={[palette.font('body', 13), { color: palette.caption }]}>
                {t(locale, 'heardFilled')}
              </Text>
            ) : null}
            {!inline ? hint : null}
            {issue ? (
              <Text
                testID={`${testPrefix}-${id}-issue`}
                style={[palette.font('bodyMedium', 13), { color: palette.danger }]}>
                {issueText(locale, issue, field)}
              </Text>
            ) : null}
          </View>
        );
        // When label and control are on the same line, place the hint below this line.
        return inline && hint ? (
          <View key={id} style={styles.field}>
            {row}
            {hint}
          </View>
        ) : (
          row
        );
      })}
    </View>
  );
}

export function useCollection(env: RenderEnv, id: string): Collection | undefined {
  return env.config.data.tables.find((c) => c.id === id);
}

/**
 * Group by reference field (D-336): The referenced table and its records. Undefined if not a
 * reference field, null while still loading.
 */
export function useLinkedGroups(
  env: RenderEnv,
  view: Collection | undefined,
  fieldId: string | undefined,
): LinkedGroups | null | undefined {
  const field = fieldId ? view?.fields.find((f) => f.id === fieldId) : undefined;
  const target =
    field?.type === 'link' ? env.config.data.tables.find((c) => c.id === field.table) : undefined;
  const { records } = useComputedRecords(env.config.data.tables, target, calendarOf(env.config));
  if (!target) return undefined;
  return records === null ? null : { collection: target, records, locale: env.locale };
}

/** Record block (list cards checklist tiles board calendar): source specifies which table to read, show specifies the card layout for each entry, tools specifies the actions on each entry. */
export type RecordBlock = BlockOf<RecordLook>;

export const isRecordBlock = (c: Component): c is RecordBlock =>
  isKnownComponent(c) && (RECORD_LOOKS as readonly string[]).includes(c.look);

/** "Add" button below each section / day / column (as addHere, D-349). */
export const addHereOf = (block: RecordBlock) => block.tools?.find((u) => u.as === 'addHere');

/** "Add" is check-and-create (D-616): Check multiple entries from another table, creating a new record here for each. */
export const isPickAdd = (use: ToolUse | undefined): use is RecordToolUse =>
  use !== undefined && isRecordToolUse(use) && use.do === 'createAll' && use.pick === true;

/** Label on the "Add" button: Uses the custom label if specified for check-and-create (e.g., "Add Ingredients"), otherwise falls back to the default. */
export const addHereLabel = (use: ToolUse | undefined, fallback: string) =>
  isPickAdd(use) && use.label !== undefined ? use.label : fallback;

/** Checklist checkbox (as check): Which checkbox field is checked; use is the check itself (written in one go via runCheck when accompanied by also, D-617). */
export function checkOf(
  block: RecordBlock,
): { table: string; field: string; use: RecordToolUse } | undefined {
  const use = block.look === 'checklist' ? block.tools?.find((u) => u.as === 'check') : undefined;
  return use && isRecordToolUse(use) && use.do === 'toggle'
    ? { table: use.table, field: use.field, use }
    : undefined;
}

/** Button shown on the right side of an entry (first button/tap matching when): A quick record tool or "Open". */
export function rowToolOf(
  block: RecordBlock,
  record: DataRecord,
  view: Collection,
  now: Date,
  cal: Calendar,
): RecordToolUse | OpenUse | undefined {
  // Tapping a grid cell (D-610) acts on the cell itself; items listed under an opened cell have no buttons.
  if (block.look === 'grid') return undefined;
  const use = shownRowAction(block.tools, record, view, now, cal);
  return use && (isRecordToolUse(use) || isOpenUse(use)) ? use : undefined;
}

export type Tone = ComponentStyle['tone'];

/**
 * Current browse selection (defined by founder 2026-11-04): Temporary user search, sort, group,
 * and filter states reside here, existing only while the page is rendered, with no persistence
 * (invariant 15). State lives in the block itself (RecordList), or at the page level (PageView)
 * if the page renders them in a fixed area or passes records to a floating button.
 */
export interface BrowseSelection {
  block: RecordBlock;
  /** The search box and these rows are rendered in the fixed area of the page, not by the list itself. */
  pinned: boolean;
  collection: Collection | undefined;
  view: Collection | undefined;
  loaded: boolean;
  /** Filtered and sorted, excluding user search and filter. */
  sorted: DataRecord[];
  /** All records matching user search and filter, not paginated to a single page. */
  found: DataRecord[];
  searching: boolean;
  narrowed: boolean;
  /** Display limit: Loads one more page per scroll to the bottom when browse is active, returns to the first page when search, filter, or sort changes; equals limit when browse is absent. */
  limit: number;
  group: RecordBlock['source']['group'];
  query: string;
  setQuery: (text: string) => void;
  sortBy: string | null;
  setSortBy: (field: string) => void;
  setGroup: (field: string | null) => void;
  filterRows: BrowseFilterRow[];
  picked: { field: string; value: string } | null;
  setPicked: (picked: { field: string; value: string } | null) => void;
  /** Selected time period (D-437): null = all. */
  period: BrowsePeriod | null;
  setPeriod: (period: BrowsePeriod | null) => void;
}

export function useBrowseSelection(block: RecordBlock, env: RenderEnv): BrowseSelection {
  const { locale } = env;
  const browse = block.show.browse;
  const [query, setQueryState] = useState('');
  const [sortBy, setSortByState] = useState<string | null>(null);
  // undefined = grouping from config; null = user selected no grouping.
  const [pickedGroup, setPickedGroup] = useState<string | null | undefined>(undefined);
  const [pickedValue, setPickedValue] = useState<{ field: string; value: string } | null>(null);
  const [period, setPeriodState] = useState<BrowsePeriod | null>(null);
  // Start viewing from the first page when search, filter, or sort changes: Records how many times the page was scrolled to the bottom at that point.
  const [from, setFrom] = useState(0);
  const pageEnd = env.pageEnd ?? 0;
  const { collection, view, loaded, sorted } = useListRecords(
    block,
    env,
    sortBy === null ? undefined : browseSort(sortBy, env.config.data.tables, block.source.table),
  );
  const links = useLinkResolver(view);
  const cal = calendarOf(env.config);
  const now = new Date();
  // Narrow down by time period first: Subsequent filters only list values that have records within this period.
  const ranged =
    period && view && browse?.period
      ? browsePeriod(sorted, view, browse.period, period, now, cal)
      : sorted;
  const filterRows =
    view && browse?.filter ? browseFilterRows(ranged, view, browse.filter, locale) : [];
  // The selected value no longer has any associated records (just modified away): Return to all.
  const picked =
    pickedValue &&
    filterRows.some(
      (row) =>
        row.field === pickedValue.field &&
        row.values.some((v) => tagKey(v.value) === tagKey(pickedValue.value)),
    )
      ? pickedValue
      : null;
  const filtered = picked && view ? browseFilter(ranged, view, picked) : ranged;
  const searching = browse?.search === true && query.trim() !== '';
  const { show } = block;
  const shownRefs = [
    show.title,
    ...(show.subtitles ?? []),
    ...(show.trailing ? [show.trailing] : []),
  ];
  const found =
    searching && view
      ? searchRecords(filtered, query, (r) =>
          recordSearchTexts(r, view, shownRefs, locale, links, now, cal),
        )
      : filtered;
  const pages = browse ? 1 + Math.max(0, pageEnd - from) : 1;
  const back = () => setFrom(pageEnd);
  return {
    block,
    pinned: false,
    collection,
    view,
    loaded,
    sorted,
    found,
    searching,
    narrowed: searching || picked !== null || period !== null,
    limit: block.source.limit * pages,
    group:
      pickedGroup === undefined
        ? block.source.group
        : pickedGroup === null
          ? undefined
          : { by: pickedGroup },
    query,
    setQuery: (text) => {
      setQueryState(text);
      back();
    },
    sortBy,
    setSortBy: (field) => {
      setSortByState(field);
      back();
    },
    setGroup: (field) => {
      setPickedGroup(field);
      back();
    },
    filterRows,
    picked,
    setPicked: (next) => {
      setPickedValue(next);
      back();
    },
    period,
    setPeriod: (next) => {
      setPeriodState(next);
      back();
    },
  };
}

/** Record list list / cards / checklist; month calendar (D-305) uses a different reader, MonthCalendar (selected via registry based on display). */
export function RecordList(props: {
  block: RecordBlock;
  env: RenderEnv;
  tone?: Tone;
  /** Buttons above the list (D-428, ListTools): Receives all currently selected records for this list (not truncated to limit). */
  tools?: (collection: Collection, records: readonly DataRecord[], searching: boolean) => ReactNode;
}) {
  const hosted = props.env.pageBrowse;
  return hosted?.block.id === props.block.id ? (
    <RecordListBody {...props} selection={hosted} />
  ) : (
    <OwnRecordList {...props} />
  );
}

function OwnRecordList(props: Parameters<typeof RecordList>[0]) {
  const selection = useBrowseSelection(props.block, props.env);
  return <RecordListBody {...props} selection={selection} />;
}

function RecordListBody({
  block,
  env,
  tone,
  tools,
  selection,
}: Parameters<typeof RecordList>[0] & { selection: BrowseSelection }) {
  const { palette, locale } = env;
  // Section headers and "Add" below the list overlay the page background, while rows inside cards use the palette (D-409).
  const page = onPage(palette);
  const router = useRouter();
  const browse = block.show.browse;
  const { collection, view, loaded, found, narrowed, limit, group } = selection;
  const rows = useRecordRows(block, env, tone, collection, view);
  const linked = useLinkedGroups(env, view, group?.by);
  const addHere = addHereOf(block) !== undefined;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (!collection || !view || !rows) return null;
  const above = tools?.(collection, found, narrowed);
  const bar = browse && !selection.pinned && <ListBrowseBar selection={selection} env={env} />;
  const add = (preset?: Record<string, unknown>) =>
    env.interactive
      ? (env.locked ??
        (() =>
          // When following a row of options (D-573), new entries default to selecting the active item.
          openAddHere(
            router,
            collection,
            view,
            { filter: followedFilter(block.source, env.pageChoice) },
            preset,
            addHereOf(block),
          )))
      : undefined;
  if (narrowed && found.length === 0)
    return (
      <View style={{ gap: palette.gap - 4 }}>
        {bar}
        <Card palette={palette} background={rows.background}>
          <Text
            testID="browse-no-match"
            style={[palette.font('body', 14), { color: palette.caption }]}>
            {t(locale, 'browseNoMatch')}
          </Text>
        </Card>
      </View>
    );
  // D-347: Sectioning. Reference fields must wait for the referenced table to load (linked is null while loading).
  const groupBy = group?.by;
  if (group && groupBy && linked !== null) {
    const groups = listGroups(found, view, group, {
      locale,
      now: new Date(),
      cal: calendarOf(env.config),
      linked: linked ?? undefined,
    });
    if (loaded && groups.length === 0)
      return <Empty block={block} env={env} rows={rows} addHere={addHere} />;
    // Infinitely scrollable list: A page represents the total count for the list, counting down
    // from the first section, continuing when scrolled to the bottom (sections never split).
    // Without browse: limit is the maximum items per section. Collapsed sections do not count
    // towards item limits.
    const sections: { g: (typeof groups)[number]; closed: boolean; shown: DataRecord[] }[] = [];
    for (const g of groups) {
      const closed = collapsed.has(g.key);
      const used = sections.reduce((n, x) => n + x.shown.length, 0);
      if (browse && used >= limit) break;
      const take = browse ? limit - used : limit;
      sections.push({ g, closed, shown: closed ? [] : g.records.slice(0, take) });
    }
    const shownCount = sections.reduce(
      (n, { g, closed, shown }) => n + (closed ? g.records.length : shown.length),
      0,
    );
    return (
      <View style={{ gap: palette.gap - 4 }}>
        {bar}
        {above}
        {sections.map(({ g, closed, shown }) => {
          const toggle = () =>
            setCollapsed((s) => {
              const next = new Set(s);
              if (closed) next.delete(g.key);
              else next.add(g.key);
              return next;
            });
          return (
            <View key={g.key} style={{ gap: 6 }}>
              <View style={styles.groupHeader}>
                <Pressable
                  testID={`group-${g.key}`}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !closed }}
                  accessibilityLabel={`${g.label} ${g.records.length}`}
                  onPress={toggle}
                  onLongPress={env.onLongPress}
                  style={styles.groupTitle}>
                  <UiIcon
                    name={closed ? 'chevronRight' : 'chevronDown'}
                    size={14}
                    color={page.muted}
                  />
                  <Text style={[page.font('bodyBold', 15), { color: page.text }]} numberOfLines={1}>
                    {g.label}
                  </Text>
                  <Text style={[page.font('bodyMedium', 13), { color: page.caption }]}>
                    {g.records.length}
                  </Text>
                </Pressable>
                {addHere && g.key !== 'overdue' ? (
                  <Pressable
                    testID={`group-add-${g.key}`}
                    accessibilityRole="button"
                    accessibilityLabel={t(locale, 'groupAdd', { group: g.label })}
                    onPress={add(g.preset === undefined ? {} : { [groupBy]: g.preset })}
                    hitSlop={8}
                    style={styles.groupAdd}>
                    <UiIcon name="add" size={18} color={page.primaryText} />
                  </Pressable>
                ) : null}
              </View>
              {shown.length === 0 ? null : rows.list(shown)}
            </View>
          );
        })}
        {browse ? (
          <BrowseMore shown={shownCount} total={found.length} searching={narrowed} env={env} />
        ) : null}
      </View>
    );
  }
  const shown = found.slice(0, limit);
  if (loaded && shown.length === 0)
    return <Empty block={block} env={env} rows={rows} addHere={addHere} add={add()} />;
  const list = addHere ? (
    <View style={{ gap: 6 }}>
      {rows.list(shown)}
      <AddHere
        label={addHereLabel(addHereOf(block), t(locale, 'entryFormAdd'))}
        onPress={add()}
        palette={page}
      />
    </View>
  ) : (
    rows.list(shown)
  );
  return bar || browse || above ? (
    <View style={{ gap: palette.gap - 4 }}>
      {bar}
      {above}
      {list}
      {browse ? (
        <BrowseMore shown={shown.length} total={found.length} searching={narrowed} env={env} />
      ) : null}
    </View>
  ) : (
    list
  );
}

/** Shows a message when the list cannot display everything: Scroll down for more (limit is one page when browse is active). */
function BrowseMore({
  shown,
  total,
  searching,
  env,
}: {
  shown: number;
  total: number;
  searching: boolean;
  env: RenderEnv;
}) {
  if (shown >= total) return null;
  const page = onPage(env.palette);
  return (
    <Text testID="browse-more" style={[page.font('body', 13), { color: page.caption }]}>
      {t(env.locale, searching ? 'browseShowingMatches' : 'browseShowing', { shown, total })}
    </Text>
  );
}

/** Search box and optional sorting, grouping, and filtering (D-424). Only affects what this list renders; hidden when there are zero records. */
const PERIOD_LABELS = {
  thisWeek: 'browsePeriodThisWeek',
  thisMonth: 'browsePeriodThisMonth',
  thisYear: 'browsePeriodThisYear',
} as const;

export function ListBrowseBar({ selection, env }: { selection: BrowseSelection; env: RenderEnv }) {
  const { locale, interactive } = env;
  const page = onPage(env.palette);
  const { block, view, query, sortBy, group, filterRows, picked } = selection;
  const browse = block.show.browse;
  if (!browse || !view || selection.sorted.length === 0) return null;
  const name = (id: string) =>
    id === 'createdAt'
      ? t(locale, 'browseCreatedAt')
      : id === 'updatedAt'
        ? t(locale, 'browseUpdatedAt')
        : (view.fields.find((f) => f.id === id)?.name ?? id);
  const chip = (id: string, label: string, on: boolean, press: () => void) => (
    <Pressable
      key={id}
      testID={`browse-${id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      disabled={!interactive}
      onPress={press}
      onLongPress={env.onLongPress}
      style={[
        styles.browseChip,
        {
          borderColor: on ? page.primary : page.border,
          backgroundColor: on ? page.primaryTint : 'transparent',
        },
      ]}>
      <Text style={[page.font('bodyMedium', 13), { color: on ? page.primaryText : page.muted }]}>
        {label}
      </Text>
    </Pressable>
  );
  const row = (title: string, chips: ReactNode) => (
    <View style={styles.browseRow}>
      <Text style={[page.font('bodyMedium', 13), { color: page.caption }]}>{title}</Text>
      {chips}
    </View>
  );
  const sorted = sortBy ?? sortList(block.source.sort)[0]?.field ?? null;
  const groupBy = group?.by ?? null;
  return (
    <View style={{ gap: 8 }}>
      {browse.search ? (
        <TextInput
          testID="browse-search"
          editable={interactive}
          value={query}
          onChangeText={selection.setQuery}
          placeholder={t(locale, 'browseSearch')}
          placeholderTextColor={page.caption}
          autoCorrect={false}
          returnKeyType="search"
          style={[
            styles.input,
            page.font('body', 15),
            {
              // Search box is square: Edges align with page margins, text inside has an inset padding (D-454).
              paddingHorizontal: page.inset,
              color: page.text,
              borderColor: page.border,
              backgroundColor: page.surface,
              borderRadius: page.controlRadius,
            },
          ]}
        />
      ) : null}
      {browse.period
        ? row(t(locale, 'browsePeriod'), [
            chip('period-all', t(locale, 'browseFilterAll'), selection.period === null, () =>
              selection.setPeriod(null),
            ),
            ...BROWSE_PERIODS.map((p) =>
              chip(`period-${p}`, t(locale, PERIOD_LABELS[p]), selection.period === p, () =>
                selection.setPeriod(p),
              ),
            ),
          ])
        : null}
      {browse.sort
        ? row(
            t(locale, 'browseSort'),
            browse.sort.map((id) =>
              chip(`sort-${id}`, name(id), sorted === id, () => selection.setSortBy(id)),
            ),
          )
        : null}
      {browse.group
        ? row(t(locale, 'browseGroup'), [
            chip('group-none', t(locale, 'browseGroupNone'), groupBy === null, () =>
              selection.setGroup(null),
            ),
            ...browse.group.map((id) =>
              chip(`group-${id}`, name(id), groupBy === id, () => selection.setGroup(id)),
            ),
          ])
        : null}
      {filterRows.map((r) => (
        // Values may be numerous: Horizontal scrolling, does not consume vertical page height.
        <ScrollView
          key={r.field}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.browseFilter}>
          {chip(
            `filter-${r.field}-all`,
            t(locale, 'browseFilterAll'),
            picked?.field !== r.field,
            () => selection.setPicked(null),
          )}
          {r.values.map((v) =>
            chip(
              `filter-${r.field}-${v.value}`,
              v.label,
              picked?.field === r.field && tagKey(picked.value) === tagKey(v.value),
              () => selection.setPicked({ field: r.field, value: v.value }),
            ),
          )}
        </ScrollView>
      ))}
    </View>
  );
}

function Empty({
  block,
  env,
  rows,
  addHere,
  add,
}: {
  block: RecordBlock;
  env: RenderEnv;
  rows: { background: string };
  addHere: boolean;
  add?: (() => void) | undefined;
}) {
  const { palette, locale } = env;
  return (
    <Card palette={palette} background={rows.background}>
      <Text style={[palette.font('body', 14), { color: palette.caption }]}>
        {block.show.emptyText ?? t(locale, 'noRecords')}
      </Text>
      {addHere ? (
        <AddHere
          label={addHereLabel(addHereOf(block), t(locale, 'entryFormAdd'))}
          onPress={add}
          palette={palette}
        />
      ) : null}
    </Card>
  );
}

/** "+ Add" below lists and calendar days (D-349). */
export function AddHere({
  label,
  onPress,
  palette,
  testID = 'list-add-here',
}: {
  label: string;
  onPress: (() => void) | undefined;
  palette: Palette;
  testID?: string;
}) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={styles.addHere}>
      <UiIcon name="add" size={18} color={palette.primaryText} />
      <Text style={[palette.font('bodyBold', 14), { color: palette.primaryText }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * In-place add (D-349): Opens the new record form, presetting the "equals" condition from list
 * filters (replaced with the specific record on record-specific pages, D-342) and values for this
 * section and day. Saved after user completes filling.
 */
export function openAddHere(
  router: ReturnType<typeof useRouter>,
  collection: Collection,
  view: Collection,
  source: Pick<RecordBlock['source'], 'filter'>,
  preset: Record<string, unknown> = {},
  /** Block "Add" tool: Check-and-create (D-616) opens the selection page, where the preset value for every new record is the value of the current section ("$here"). */
  use?: ToolUse,
) {
  const prefill = { ...filterPresets(view, source.filter), ...preset };
  if (isPickAdd(use)) {
    router.push({
      pathname: '/pick-records',
      params: { tool: JSON.stringify(use), here: JSON.stringify(prefill) },
    });
    return;
  }
  router.push({
    pathname: '/record/[collectionId]',
    params: { collectionId: collection.id, prefill: JSON.stringify(prefill) },
  });
}

/** Records to be displayed in the record list: Filtered and sorted, before truncating to limit items (kanban truncates per column, D-313). */
export function useListRecords(
  block: RecordBlock,
  env: RenderEnv,
  /** User-overridden temporary sort (D-424); falls back to config if unspecified. */
  sort?: Sort,
) {
  const collection = useCollection(env, block.source.table);
  const cal = calendarOf(env.config);
  // Lookup, rollup, and previous (D-291): Uses computed records and view for display, filtering, and sorting; modifies records using the original table.
  const { view, records } = useComputedRecords(env.config.data.tables, collection, cal);
  const now = new Date();
  // Follows the time range on the page (D-561): Filters by the selected range like number cards; falls back to own filters when the page lacks a period block.
  const follow = block.source.period === 'page' ? env.pageRange?.choice : undefined;
  // Follows a row of options on the page (D-573): Adds a condition where "this field equals the selected item"; omitted when "All" is selected.
  const filter = followedFilter(block.source, env.pageChoice);
  const sorted = view
    ? sortRecords(
        follow
          ? recordsFollowingRange(records ?? [], view, filter, follow, now, cal)
          : filterRecords(records ?? [], view, filter, now, cal),
        view,
        // User-selected sort comes first, matching config sorts (which can be multiple, D-560) afterwards.
        browseSortKeys(sort, block.source.sort),
        now,
        cal,
      )
    : [];
  return { collection, view, loaded: records !== null, sorted };
}

/**
 * Rendering a record list row (shared by standard lists and calendar day lists): Title, subtitle,
 * trailing field (with trailingFormat, D-306), checkbox, and thumbnail; tap to open the edit
 * page.
 */
export function useRecordRows(
  block: RecordBlock,
  env: RenderEnv,
  tone: Tone | undefined,
  collection: Collection | undefined,
  view: Collection | undefined,
) {
  const { palette, locale } = env;
  const background = cardColors(palette, tone).background;
  const router = useRouter();
  const actions = useRecordActions();
  const runner = useRecordActionRunner();
  const links = useLinkResolver(view);
  // Tables with attachment fields: Displays a thumbnail of the first image in attachments for each record (D-263, auto-detected, no component configuration needed).
  const assetIndex = useAssetIndex();
  if (!collection || !view) return null;
  const cal = calendarOf(env.config);
  const hasFiles = collection.fields.some((f) => f.type === 'file');
  // Check state is written to the tool's own table (relation rule 12), usually the list table itself. Checks with also (D-617) are written atomically along with accompanied fields.
  const toggle = (c: NonNullable<ReturnType<typeof checkOf>>, r: DataRecord, next: boolean) => {
    if (tapAlsoOf(c.use).length > 0) return void runner.runCheck(c.use, r);
    const table = env.config.data.tables.find((x) => x.id === c.table);
    if (table) void actions.patch(table, r.id, { [c.field]: next });
  };
  const cards = block.look === 'cards';
  const { show } = block;
  const check = checkOf(block);
  const now = new Date();
  const marks = recordMarks(show, view, env, now);

  const row = (r: DataRecord, index: number) => {
    const title =
      formatRef(r, view, show.title, locale, links, now, cal) ||
      untitledRecordTitle(r, collection, locale, now, cal);
    const subtitle = (show.subtitles ?? [])
      .map((f) => formatRef(r, view, f, locale, links, now, cal))
      .filter(Boolean)
      .join(' · ');
    const checked = check ? r.values[check.field] === true : false;
    const thumb = hasFiles && assetIndex ? firstImage(r, collection, assetIndex) : null;
    // One-tap record tool (D-300): The first button whose condition is met.
    const rowAction = rowToolOf(block, r, view, now, cal);
    // Warning color (D-541): values on the right, or the title if no right-side field exists.
    const warn = marks.warns(r);
    const body = (
      <View style={styles.row}>
        {check ? (
          <Pressable
            testID={`check-${r.id}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            disabled={!env.interactive}
            hitSlop={8}
            onPress={env.locked ?? (() => void toggle(check, r, !checked))}
            onLongPress={env.onLongPress}
            style={[
              styles.check,
              {
                borderColor: checked ? palette.primary : palette.border,
                backgroundColor: checked ? palette.primary : palette.surface,
              },
            ]}>
            {checked ? <Icon name="check" size={16} color={palette.onPrimary} /> : null}
          </Pressable>
        ) : null}
        {thumb ? (
          <AttachmentThumb
            asset={thumb}
            size={cards ? 56 : 44}
            radius={Math.min(palette.controlRadius, 10)}
            testID={`record-thumb-${r.id}`}
          />
        ) : null}
        <ColorDot color={marks.colorOf(r)} recordId={r.id} />
        <View style={styles.flex}>
          <Text
            numberOfLines={cards ? 2 : 1}
            style={[
              palette.font('title', 15),
              {
                color:
                  warn && !show.trailing
                    ? palette.danger
                    : checked
                      ? palette.caption
                      : palette.text,
              },
              checked && styles.done,
            ]}>
            {title}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={cards ? 3 : 1}
              style={[palette.font('body', 13), { color: palette.muted }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {show.trailing ? (
          <Trailing
            record={r}
            view={view}
            show={show}
            env={env}
            text={formatRef(r, view, show.trailing, locale, links, now, cal)}
            warn={warn}
          />
        ) : null}
        {rowAction ? (
          <RowActionButton action={rowAction} record={r} env={env} palette={palette} />
        ) : null}
      </View>
    );
    const open = env.interactive
      ? (env.locked ?? (() => openRow(router, block.opens, collection.id, r.id)))
      : undefined;
    if (cards) {
      return (
        <Card
          key={r.id}
          palette={palette}
          background={background}
          onPress={open}
          onLongPress={env.onLongPress}
          testID={`record-${r.id}`}>
          {body}
        </Card>
      );
    }
    return (
      <Pressable
        key={r.id}
        testID={`record-${r.id}`}
        onPress={open}
        onLongPress={env.onLongPress}
        disabled={!open}
        style={[
          styles.listRow,
          index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
        ]}>
        {body}
      </Pressable>
    );
  };

  // Table (D-539): Defaults to subtitle and trailing fields when columns are omitted.
  const columns = show.columns ?? [
    ...(show.subtitles ?? []),
    ...(show.trailing ? [show.trailing] : []),
  ];
  const openRecord = env.interactive
    ? (env.locked ?? ((r: DataRecord) => openRow(router, block.opens, collection.id, r.id)))
    : undefined;
  const titleOf = (r: DataRecord) =>
    formatRef(r, view, show.title, locale, links, now, cal) ||
    untitledRecordTitle(r, collection, locale, now, cal);
  const list = (shown: DataRecord[]) =>
    block.look === 'gallery' ? (
      <RecordGallery
        blockId={block.id}
        collection={collection}
        records={shown}
        env={env}
        assets={assetIndex}
        titleOf={titleOf}
        marks={marks}
        open={openRecord}
      />
    ) : block.look === 'table' ? (
      <RecordTable
        blockId={block.id}
        view={view}
        title={show.title}
        columns={columns}
        records={shown}
        env={env}
        background={background}
        titleOf={titleOf}
        cellOf={(r, id) => formatRef(r, view, id, locale, links, now, cal)}
        marks={marks}
        warnColumn={
          show.trailing !== undefined && columns.includes(show.trailing) ? show.trailing : null
        }
        open={openRecord}
      />
    ) : cards ? (
      <View style={{ gap: palette.gap - 4 }}>{shown.map(row)}</View>
    ) : (
      <Card palette={palette} background={background} style={styles.listCard}>
        {shown.map(row)}
      </Card>
    );
  return { row, list, background };
}

/**
 * Trailing field: Displays display text when trailingFormat is absent; elapsed shows duration
 * from start to end (or present, updating every second); progress shows "value / target" with a
 * small progress ring or bar (displays text normally when value or target is missing).
 */
export function Trailing({
  record,
  view,
  show,
  env,
  text,
  warn,
}: {
  record: DataRecord;
  view: Collection;
  show: RecordBlock['show'];
  env: RenderEnv;
  text: string;
  /** Satisfies show.highlight (D-541): Rendered in warning color. */
  warn?: boolean;
}) {
  const { palette, locale } = env;
  const format = show.format;
  const style = [palette.font('title', 15), { color: warn ? palette.danger : palette.text }];
  const elapsedFormat = format?.kind === 'elapsed' ? format : undefined;
  const first = elapsedFormat
    ? elapsedOf(record, view, show.trailing!, elapsedFormat.until, new Date())
    : undefined;
  const now = useTicker(first?.running === true);
  if (elapsedFormat) {
    const e = elapsedOf(record, view, show.trailing!, elapsedFormat.until, now);
    if (!e) return null;
    const time = formatElapsed(e);
    return (
      <Text
        testID={`elapsed-${record.id}`}
        accessibilityLabel={e.running ? t(locale, 'elapsedRunning', { time }) : undefined}
        style={[style, styles.tabular, e.running && { color: palette.primaryText }]}>
        {time}
      </Text>
    );
  }
  if (format?.kind === 'progress') {
    const cal = calendarOf(env.config);
    const progress = recordProgress(record, view, show.trailing!, format.goal, now, cal);
    if (progress) {
      const found = view.fields.find((f) => f.id === show.trailing);
      const field = found && fieldForRecord(found, record.values, view);
      const label = t(locale, 'progressOfGoal', {
        value: amountText(progress.value, field, locale),
        goal: amountText(progress.goal, field, locale),
      });
      const testID = `progress-ring-${record.id}`;
      return format.style === 'bar' ? (
        <View style={styles.progressBar}>
          <Text style={[style, styles.tabular]}>{label}</Text>
          <ProgressBar ratio={progress.ratio} palette={palette} testID={testID} />
        </View>
      ) : (
        <View style={styles.progressRow}>
          <Text style={[style, styles.tabular]}>{label}</Text>
          <ProgressRing
            ratio={progress.ratio}
            size={28}
            stroke={4}
            palette={palette}
            testID={testID}
          />
        </View>
      );
    }
  }
  // Tags can be long: Single line, without crowding the title.
  const tagged = view.fields.some((f) => f.id === show.trailing && f.type === 'tags');
  return text ? (
    <Text
      numberOfLines={tagged ? 1 : undefined}
      style={
        tagged
          ? [
              palette.font('body', 13),
              styles.trailingTags,
              { color: warn ? palette.danger : palette.muted },
            ]
          : style
      }>
      {text}
    </Text>
  ) : null;
}

/** Form submission tool: {as: "submit", do: "create", table, ask: [fields], values?, smartDate?}. */
type SubmitTool = Extract<RecordToolUse, { do: 'create' }>;

/**
 * Form (inline or sheet style for recordForm): Prompts for fields in ask, submission = creates a
 * record via tools[0]. Button mode (opening the full form) is a button block (ActionButton in
 * RecordActions.tsx).
 */
export function RecordForm({
  block,
  env,
  tone,
}: {
  block: BlockOf<'form'>;
  env: RenderEnv;
  tone?: Tone;
}) {
  const { palette, locale } = env;
  const componentId = block.id;
  const use = block.tools[0];
  const submitTool = isRecordToolUse(use) && use.do === 'create' ? (use as SubmitTool) : undefined;
  const fieldIds = Array.isArray(submitTool?.ask) ? submitTool.ask : [];
  const submitLabel = submitTool?.label ?? t(locale, 'entryFormAdd');
  const collection = useCollection(env, submitTool?.table ?? '');
  const actions = useRecordActions();
  const mayProceed = useSimilarCheck();
  const cal = useCalendar();
  // A date recognised from the typed text (smartDate, D-344) fills its field itself, so that field
  // does not start with its default.
  const blank = () =>
    collection
      ? newFormValues(
          collection,
          cal,
          fieldIds.filter((id) => id !== submitTool?.smartDate?.to),
        )
      : {};
  const [values, setValues] = useState<FormValues>(blank);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  // D-344: Recognizes dates in text locally; once dismissed by the user, this text is no longer recognized (until modified).
  const [dismissed, setDismissed] = useState<string | null>(null);
  // D-352: Whether the bottom-sheet add box is open.
  const [open, setOpen] = useState(false);
  if (!collection) return null;
  const smart = submitTool?.smartDate;
  const smartField = smart ? collection.fields.find((f) => f.id === smart.to) : undefined;
  const typed = smart ? values[smart.from] : undefined;
  const userSet = smart ? values[smart.to] !== undefined && values[smart.to] !== '' : false;
  const found =
    smart && smartField && typeof typed === 'string' && typed !== dismissed && !userSet
      ? smartDateOf(typed, smartField, todayNumber(new Date(), cal), locale, cal)
      : undefined;

  async function submit() {
    if (!collection || !env.interactive) return;
    if (env.locked) return env.locked();
    // D-343: Hidden preset values ("$record" is already replaced with this record before rendering); D-344: Recognized dates are filled in and removed from the text.
    const preset = createInput(collection, submitTool?.values, { now: new Date(), cal });
    const recognised =
      found && smart
        ? {
            [smart.from]: withoutPhrase(typed as string, found.phrase) || (typed as string),
            [smart.to]: found.input,
          }
        : {};
    const input = { ...preset, ...values, ...recognised };
    if (!(await mayProceed(collection, input))) return;
    const result = await actions.add(collection, input);
    if (result.ok) {
      setValues(blank());
      setIssues([]);
      setMessage(null);
      setDismissed(null);
    } else if ('full' in result) {
      setMessage(t(locale, 'tableFull'));
    } else {
      setIssues(result.issues.filter((i) => fieldIds.includes(i.fieldId)));
      // Required fields missing from this form: Prompts to add using the full form.
      if (result.issues.some((i) => !fieldIds.includes(i.fieldId))) {
        setMessage(t(locale, 'useFullForm'));
      }
    }
  }

  /**
   * Keyboard checkmark: Saves when input is complete (keeping the keyboard open to continue
   * writing, D-352). If required fields are still empty or nothing is written, the user likely
   * just wants to dismiss the keyboard: no error is thrown, validation only occurs on pressing
   * the "Save" button.
   */
  function keyboardDone() {
    if (!collection) return;
    const preset = createInput(collection, submitTool?.values, { now: new Date(), cal });
    const checked = prepareRecordValues(
      collection,
      { ...preset, ...values },
      null,
      new Date(),
      cal,
    );
    const nothing = fieldIds.every((id) => values[id] === undefined || values[id] === '');
    if (nothing || (!checked.ok && checked.issues.some((i) => i.code === 'required'))) {
      Keyboard.dismiss();
      return;
    }
    void submit();
  }

  const sheet = block.show.mode === 'sheet';
  const body = (
    <>
      <FieldsForm
        collection={collection}
        fieldIds={fieldIds}
        values={values}
        onChange={setValues}
        issues={issues}
        palette={palette}
        locale={locale}
        disabled={!env.interactive}
        testPrefix={`form-${componentId}`}
        showLabels={false}
        onSubmit={keyboardDone}
        autoFocus={sheet}
      />
      {found ? (
        <View style={styles.smartDate} testID={`form-${componentId}-smart`}>
          <Icon name="calendar" size={16} color={palette.primaryText} />
          <Text style={[palette.font('bodyMedium', 13), styles.flex, { color: palette.text }]}>
            {t(locale, 'smartDateFound', {
              text: (typed as string).slice(found.phrase.start, found.phrase.end),
              value: found.preview,
            })}
          </Text>
          <Pressable
            testID={`form-${componentId}-smart-dismiss`}
            accessibilityRole="button"
            accessibilityLabel={t(locale, 'smartDateDismiss')}
            hitSlop={12}
            onPress={() => setDismissed(typed as string)}
            style={styles.smartDismiss}>
            <UiIcon name="close" size={16} color={palette.muted} />
          </Pressable>
        </View>
      ) : null}
      {message ? (
        <Text style={[palette.font('bodyMedium', 13), { color: palette.danger }]}>{message}</Text>
      ) : null}
      <Button
        palette={palette}
        testID={`form-${componentId}-submit`}
        label={submitLabel}
        onPress={() => void submit()}
        onLongPress={env.onLongPress}
        disabled={!env.interactive}
      />
    </>
  );
  if (!sheet) {
    return (
      <Card palette={palette} background={cardColors(palette, tone).background}>
        {body}
      </Card>
    );
  }
  // D-352: A circular "+" at the bottom right (placed outside scrollable content by PageView),
  // opens the add box from the bottom when tapped; after adding, the box remains open and text is
  // cleared to write the next entry, dismissed by tapping outside or pressing "Close".
  return (
    <>
      <Pressable
        testID={`form-${componentId}`}
        accessibilityRole="button"
        accessibilityLabel={submitLabel}
        onPress={env.interactive ? (env.locked ?? (() => setOpen(true))) : undefined}
        onLongPress={env.onLongPress}
        style={[styles.fab, { backgroundColor: palette.primary }]}>
        <UiIcon name="add" size={28} color={palette.onPrimary} />
      </Pressable>
      <BottomSheet
        palette={palette}
        locale={locale}
        visible={open}
        animationType="slide"
        onClose={() => setOpen(false)}
        backdropTestID={`form-${componentId}-backdrop`}
        backdropLabel={t(locale, 'close')}
        testID={`form-${componentId}-sheet`}
        style={[
          {
            backgroundColor: palette.surface,
            padding: palette.pad,
            gap: palette.gap - 4,
          },
        ]}>
        <InSheet.Provider value>{body}</InSheet.Provider>
      </BottomSheet>
    </>
  );
}

type NumberSource = BlockOf<'number'>['source'];

/** Statistic value display: Amounts formatted by currency, numbers by units and decimal places, day-based calculations show "days" or "weeks", counts and other fields display numbers only. */
export function statText(
  value: number | null,
  aggregate: NumberSource['aggregate'],
  field: Field | undefined,
  locale: RenderEnv['locale'],
  unit?: NonNullable<NumberSource['days']>['unit'],
): string {
  if (isSequenceAggregate(aggregate)) return sequenceText(aggregate, unit, value, locale);
  if (value === null) return '—';
  return amountText(value, aggregate === 'count' ? undefined : field, locale);
}

/** Formatting a number according to field definitions (amounts with currency, numbers with units, formatAmount defined in field); plain number when field is absent. */
export function amountText(value: number, field: Field | undefined, locale: RenderEnv['locale']) {
  const amount = field && fieldDefinition(field.type).formatAmount;
  return amount ? amount(field, value, locale) : formatNumber(value, undefined, locale);
}

export function Stat({
  block,
  env,
  tone,
  backdrop,
  size,
}: {
  block: BlockOf<'number'>;
  env: RenderEnv;
  tone?: Tone;
  backdrop?: Backdrop | undefined;
  /** style.size (D-589): Number font size scale, defaults to medium if omitted. */
  size?: keyof typeof SIZES | null | undefined;
}) {
  const scale = SIZES[size ?? 'medium'];
  const palette = onPicture(env.palette, backdrop);
  const src = block.source;
  const label = block.show.label;
  const table = useCollection(env, src.table);
  const cal = calendarOf(env.config);
  // Lookup, rollup, and previous (D-291) statistics calculated from computed values.
  const { view: collection, records } = useComputedRecords(env.config.data.tables, table, cal);
  // Grouping by reference field (D-336) requires records from the referenced table; minus totals (D-337) require records from that table.
  const linked = useLinkedGroups(env, collection, src.group?.by);
  const minus = useComputedRecords(
    env.config.data.tables,
    env.config.data.tables.find((c) => c.id === src.minus?.table),
    cal,
  );
  const extra0 = useComputedRecords(
    env.config.data.tables,
    env.config.data.tables.find((t) => t.id === src.calc?.with[0]?.table),
    cal,
  );
  const extra1 = useComputedRecords(
    env.config.data.tables,
    env.config.data.tables.find((t) => t.id === src.calc?.with[1]?.table),
    cal,
  );
  const extra2 = useComputedRecords(
    env.config.data.tables,
    env.config.data.tables.find((t) => t.id === src.calc?.with[2]?.table),
    cal,
  );
  if (!collection) return null;
  const now = new Date();
  // Time range selected on the page (D-440): When source.period is "page" and the page has a period
  // block, inPeriod in filters is ignored and calculated based on the selected range; which date
  // field to use: the one previously used by inPeriod, falling back to the first date field in the
  // table (same as charts).
  const follow = src.period === 'page' ? env.pageRange?.choice : undefined;
  // Follows a row of options on the page (D-573): Computes records only for the selected item (minus does not follow).
  const filter = followedFilter(src, env.pageChoice);
  const based = filterRecords(
    records ?? [],
    collection,
    follow ? (filter ?? []).filter((c) => c.op !== 'inPeriod') : filter,
    now,
    cal,
  );
  const dateRef =
    (src.filter ?? []).find((c) => c.op === 'inPeriod')?.field ??
    dateFieldOf(collection, src.days?.date);
  const matched = follow
    ? recordsInRange(based, collection, dateRef, choiceRange(follow, now, cal), now, cal)
    : based;
  // Sequential aggregation (D-284): Defaults to the first date field in the table, falling back to creation time if absent (same as charts).
  const aggregate = src.aggregate;
  const valueOf = (list: DataRecord[]) =>
    isSequenceAggregate(aggregate)
      ? sequenceValue(list, collection, aggregate, src.days, now, cal)
      : aggregate === 'latest'
        ? // Value of the latest entry (D-618), sharing the same "latest" definition as rollup fields (core's latestNumber).
          { value: table ? latestNumber(list, table, collection, src, now, cal) : null }
        : { value: aggregateRecords(list, collection, aggregate as Aggregate, src.field) };
  // Do not display counts until the subtracted table has finished loading (same as when your own table has not finished loading).
  const extras = [extra0, extra1, extra2];
  const loading =
    records === null ||
    (src.minus !== undefined && minus.records === null) ||
    (src.calc?.with.some((_, i) => extras[i]!.records === null) ?? false);
  const calculated = () =>
    calculatedNumber(
      { ...src, filter },
      { table: table!, view: collection, records: records ?? [] },
      (id) => {
        const total =
          src.minus?.table === id
            ? minus
            : extras[src.calc?.with.findIndex((t) => t.table === id) ?? -1];
        const stored = env.config.data.tables.find((t) => t.id === id);
        return total?.view && stored
          ? { table: stored, view: total.view, records: total.records ?? [] }
          : undefined;
      },
      now,
      cal,
      follow ? choiceRange(follow, now, cal) : undefined,
    );
  const text = (v: { value: number | null }) =>
    calculatedText(v.value, src.calc, env.locale) ??
    statText(v.value, aggregate, field, env.locale, src.days?.unit);
  // Per-entry currency selection (D-429): display separately by currency; do not sum different currencies together.
  const listText = (list: DataRecord[]) =>
    perCurrencyText(list, collection, aggregate, src.field, env.locale);
  const bestText = (v: { best?: number }) =>
    v.best === undefined
      ? null
      : t(env.locale, 'seqBest', {
          value: statText(v.best, aggregate, field, env.locale, src.days?.unit),
        });
  const field = src.field ? collection.fields.find((f) => f.id === src.field) : undefined;
  // Goal (D-307): "Value / Target" and progress.
  const goalProgress = (v: { value: number | null }) => {
    const p = src.goal === undefined ? undefined : progressOf(v.value ?? 0, src.goal);
    return (
      p && {
        ratio: p.ratio,
        label: t(env.locale, 'progressOfGoal', { value: text(v), goal: text({ value: p.goal }) }),
      }
    );
  };
  // Compare to the same period in the previous segment (D-308): replace the time range in the filter with the previous segment and recalculate; colors are neutral (spending more and exercising more have opposite directions).
  const previous = !src.compare
    ? null
    : follow
      ? {
          records: recordsInRange(
            based,
            collection,
            dateRef,
            previousToDateRange(follow, now, cal),
            now,
            cal,
          ),
          period: null,
        }
      : (() => {
          const before = previousFilter(filter, now, cal);
          return (
            before && {
              records: filterRecords(records ?? [], collection, before.filter, now, cal),
              period: before.period,
            }
          );
        })();
  const compareText = (current: number | null) => {
    if (!previous) return null;
    const before = valueOf(previous.records);
    const label = previous.period
      ? previousLabel(previous.period, text(before), env.locale)
      : t(env.locale, 'compare_page', { value: text(before) });
    const changeText = changeLabel(compareChange(current, before.value), env.locale);
    return (
      <View style={styles.compareRow} testID={`stat-compare-${src.table}-${label}`}>
        <Text style={[styles.flex, palette.font('body', 13), { color: palette.muted }]}>
          {label}
        </Text>
        {changeText ? (
          <Text style={[palette.font('bodyBold', 13), { color: palette.text }]}>{changeText}</Text>
        ) : null}
      </View>
    );
  };
  const background = tone ? cardColors(palette, tone).background : palette.primaryTint;
  const heading = (
    <Text
      style={[palette.font('bodyBold', 12), { color: palette.primaryText, letterSpacing: 0.5 }]}>
      {label.toUpperCase()}
    </Text>
  );
  // D-248: Group by single-select field, one row per option.
  const groupBy = src.group?.by;
  if (groupBy) {
    const noChoice = t(env.locale, 'statNoChoice');
    const groups =
      records === null || linked === null
        ? []
        : groupRecords(matched, collection, groupBy, noChoice, linked);
    // Compare to previous segment (D-308): each option is compared against its own previous segment.
    const before =
      previous && records !== null
        ? new Map(
            groupRecords(previous.records, collection, groupBy, noChoice, linked ?? undefined).map(
              (g) => [g.optionId, valueOf(g.records).value],
            ),
          )
        : null;
    return (
      <Card palette={palette} background={background} backdrop={backdrop} style={styles.fillCard}>
        {heading}
        {groups.map((g) => {
          const v = valueOf(g.records);
          const best = bestText(v);
          return (
            <View key={g.optionId ?? '-'} style={styles.row}>
              <Text
                numberOfLines={1}
                style={[styles.flex, palette.font('bodyMedium', 15), { color: palette.text }]}>
                {g.label}
              </Text>
              <View style={styles.statValue}>
                <Text
                  testID={`stat-group-${src.table}-${g.optionId ?? 'none'}`}
                  style={[palette.font('title', 16 * scale), { color: palette.text }]}>
                  {goalProgress(v)?.label ?? listText(g.records) ?? text(v)}
                </Text>
                {best ? (
                  <Text style={[palette.font('body', 12), { color: palette.muted }]}>{best}</Text>
                ) : null}
                {goalProgress(v) ? (
                  <View style={styles.groupBar}>
                    <ProgressBar ratio={goalProgress(v)!.ratio} palette={palette} />
                  </View>
                ) : null}
                {before ? (
                  <Text style={[palette.font('bodyBold', 12), { color: palette.muted }]}>
                    {changeLabel(
                      compareChange(v.value, before.get(g.optionId) ?? null),
                      env.locale,
                    )}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </Card>
    );
  }
  const v = loading ? { value: null } : calculated();
  const best = loading ? null : bestText(v);
  const progress = goalProgress(v);
  const compareLine = loading ? null : compareText(v.value);
  return (
    <Card palette={palette} background={background} backdrop={backdrop} style={styles.fillCard}>
      {heading}
      <View style={styles.row}>
        <Text
          testID={`stat-value-${src.table}-${label}`}
          style={[styles.flex, palette.font('display', 26 * scale), { color: palette.text }]}>
          {progress ? progress.label : (listText(matched) ?? text(v))}
        </Text>
        {progress ? (
          <View style={styles.statRing}>
            <ProgressRing
              ratio={progress.ratio}
              size={56}
              stroke={6}
              palette={palette}
              testID={`stat-ring-${src.table}-${label}`}
            />
            <Text style={[styles.ringLabel, palette.font('bodyBold', 12), { color: palette.text }]}>
              {t(env.locale, 'progressPercent', { n: Math.round(progress.ratio * 100) })}
            </Text>
          </View>
        ) : null}
      </View>
      {best ? (
        <Text
          testID={`stat-best-${src.table}-${label}`}
          style={[palette.font('body', 13), { color: palette.muted }]}>
          {best}
        </Text>
      ) : null}
      {compareLine}
    </Card>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  note: { minHeight: 110, textAlignVertical: 'top' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  datePicker: { gap: 8 },
  smartDate: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  groupHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  browseRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  browseFilter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trailingTags: { maxWidth: '40%' },
  browseChip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  groupTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  groupAdd: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  addHere: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
  },
  smartDismiss: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  suggestion: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, maxWidth: '100%' },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 34,
    justifyContent: 'center',
  },
  fields: { gap: 12 },
  field: { gap: 6 },
  inlineField: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statValue: { alignItems: 'flex-end' },
  listCard: { paddingVertical: 4, gap: 0 },
  listRow: { paddingVertical: 12 },
  check: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  done: { textDecorationLine: 'line-through' },
  fillCard: { flexGrow: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressBar: { alignItems: 'flex-end', gap: 4, minWidth: 72 },
  statRing: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  ringLabel: { position: 'absolute' },
  groupBar: { width: 72, marginTop: 4 },
  compareRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  attachment: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

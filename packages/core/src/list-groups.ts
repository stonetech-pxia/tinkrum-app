import { dateOfDayNumber, todayNumber, weekStartOf, type Calendar } from './calendar';
import {
  fieldOf,
  groupRecords,
  recordDay,
  scheduleStatusOf,
  type DataRecord,
  type LinkedGroups,
} from './data';
import { dayNumber } from './formula';
import { localeTag } from './localization';
import { t } from './messages';
import { shortDate, weekdayName } from './schedule';
import { isMultipleChoice, type Collection, type Grouping, type Locale } from './schema';
import { dateFieldOf } from './sequence';

// Record list grouping (D-347): group by single-choice or link (each option / each referenced entry
// forms a group, ordered as in D-336), or group by date (date, datetime, system fields by day /
// week / month; schedules by next occurrence, with expired ones combined into a leading group and
// undated ones at the end). Pure logic: section title, records, and preset values for "add in this
// section" (A10, D-349); the app only renders titles, collapsing, and rows.

export interface ListGroup {
  /** Stable key: used to record collapse state. */
  key: string;
  label: string;
  records: DataRecord[];
  /**
   * Preset values for form inputs when creating a new entry in this section: option ID,
   * referenced record ID, date (when grouped by day), or schedule "once". Unselected, expired,
   * and weekly/monthly grouped sections have none.
   */
  preset?: unknown;
}

function dayLabel(day: number, today: number, locale: Locale): string {
  const weekday = weekdayName(((((day + 3) % 7) + 7) % 7) + 1, locale);
  const date = t(locale, 'groupDay', { date: shortDate(day, today, locale), weekday });
  const relative =
    day === today
      ? t(locale, 'scheduleToday')
      : day === today + 1
        ? t(locale, 'scheduleTomorrow')
        : day === today - 1
          ? t(locale, 'yesterday')
          : undefined;
  return relative ? t(locale, 'groupDayRelative', { relative, day: date }) : date;
}

function textGroups(records: readonly DataRecord[], by: string, locale: Locale): ListGroup[] {
  const groups = new Map<string, DataRecord[]>();
  const blank: DataRecord[] = [];
  for (const r of records) {
    const raw = r.values[by];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) blank.push(r);
    else groups.set(value, [...(groups.get(value) ?? []), r]);
  }
  const order = new Intl.Collator(localeTag(locale));
  return [
    ...[...groups.entries()]
      .sort(([a], [b]) => order.compare(a, b))
      .map(([value, list]): ListGroup => ({
        key: `text-${value}`,
        label: value,
        records: list,
        preset: value,
      })),
    ...(blank.length > 0
      ? [{ key: 'none', label: t(locale, 'groupNoText'), records: blank } satisfies ListGroup]
      : []),
  ];
}

function monthLabel(day: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(day * 86_400_000));
}

/**
 * Group filtered and sorted records by group (preserving original order within each group). When
 * group.by is omitted, groups by the first date field (dateFieldOf). When grouping by date,
 * section order follows sorting: early-to-late date sorting puts today, tomorrow... first;
 * schedule "expired" is always first, and "undated" is always last. group.showEmpty: also lists
 * empty sections for single-choice and link types (sections panel).
 */
export function listGroups(
  records: readonly DataRecord[],
  collection: Collection,
  group: Pick<Grouping, 'by' | 'unit' | 'showEmpty'>,
  options: {
    locale: Locale;
    now: Date;
    cal: Calendar;
    /** Link field: the referenced table and its records (D-336). */
    linked?: LinkedGroups | undefined;
  },
): ListGroup[] {
  const { locale, now, cal } = options;
  const groupBy = dateFieldOf(collection, group.by);
  const field = fieldOf(collection, groupBy);
  if (field?.type === 'choice' || field?.type === 'link') {
    return groupRecords(records, collection, groupBy, t(locale, 'statNoChoice'), options.linked)
      .filter((g) => group.showEmpty || g.records.length > 0)
      .map((g) => ({
        key: g.optionId ?? 'none',
        label: g.label,
        records: g.records,
        // Multi-choice (D-607): select this item when adding in this section.
        ...(g.optionId === null
          ? {}
          : { preset: isMultipleChoice(field) ? [g.optionId] : g.optionId }),
      }));
  }
  // Text (D-424, temporary grouping by company on list): Each distinct value forms a section, sorted alphabetically; uncategorized items are placed at the end.
  if (field?.type === 'text') return textGroups(records, groupBy, locale);
  const today = todayNumber(now, cal);
  const unit = group.unit ?? 'day';
  const schedule = field?.type === 'schedule';
  const groups = new Map<string, ListGroup>();
  let overdue: ListGroup | undefined;
  let noDate: ListGroup | undefined;
  for (const r of records) {
    let day: number | undefined;
    if (schedule) {
      day = scheduleStatusOf(r, collection, field, now, cal)?.next;
      if (day !== undefined && day < today) {
        overdue ??= { key: 'overdue', label: t(locale, 'groupOverdue'), records: [] };
        overdue.records.push(r);
        continue;
      }
    } else {
      const date = recordDay(r, collection, groupBy, now, cal);
      day = date === undefined ? undefined : dayNumber(date);
    }
    if (day === undefined) {
      noDate ??= {
        key: 'none',
        label: t(locale, schedule ? 'scheduleNoDate' : 'groupNoDate'),
        records: [],
      };
      noDate.records.push(r);
      continue;
    }
    const start =
      unit === 'week'
        ? weekStartOf(day, cal)
        : unit === 'month'
          ? dayNumber(`${dateOfDayNumber(day).slice(0, 7)}-01`)!
          : day;
    const key = `${unit}-${start}`;
    let section = groups.get(key);
    if (!section) {
      const label =
        unit === 'week'
          ? t(locale, 'groupWeek', { date: shortDate(start, today, locale) })
          : unit === 'month'
            ? monthLabel(start, locale)
            : dayLabel(start, today, locale);
      const date = dateOfDayNumber(start);
      // When grouping by day, items can be added on that day: date field is set to this day, and schedule is set to "once, on this day".
      const preset =
        unit !== 'day'
          ? undefined
          : schedule
            ? { repeat: 'once', date }
            : field?.type === 'date'
              ? date
              : undefined;
      section = { key, label, records: [], ...(preset === undefined ? {} : { preset }) };
      groups.set(key, section);
    }
    section.records.push(r);
  }
  return [...(overdue ? [overdue] : []), ...groups.values(), ...(noDate ? [noDate] : [])];
}

/**
 * Values carried over from a list's filters when creating a new entry within it (A10, D-349):
 * radio is equals option, relation is equals record (the page used for a specific record has
 * already been switched to this record, D-342), checkbox is true / false. Only "equals" is
 * recognized; other conditions (date range, contains...) are not carried over.
 */
export function filterPresets(
  collection: Collection,
  filter: readonly { field: string; op: string; value?: unknown }[] | undefined,
): Record<string, unknown> {
  const presets: Record<string, unknown> = {};
  for (const c of filter ?? []) {
    if (c.op !== 'is') continue;
    const f = fieldOf(collection, c.field);
    if (!f) continue;
    if (f.type === 'choice' && f.options.some((o) => o.id === c.value))
      presets[f.id] = f.multiple ? [c.value] : c.value;
    else if (f.type === 'link' && typeof c.value === 'string' && c.value !== '$record')
      presets[f.id] = c.value;
    else if (f.type === 'checkbox' && typeof c.value === 'boolean') presets[f.id] = c.value;
  }
  return presets;
}

const searchForm = (text: string) => text.normalize('NFKC').toLowerCase();

/**
 * Search on list (D-424): Every word must appear in the displayed text of the entry
 * (case-insensitive, full-width and half-width characters treated equally, Chinese matched by
 * character). The incoming records have not been sliced to the limit yet, so entries beyond the
 * limit can also be found.
 */
export function searchRecords<R>(
  records: readonly R[],
  query: string,
  textsOf: (record: R) => readonly string[],
): R[] {
  const words = searchForm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...records];
  return records.filter((r) => {
    const text = searchForm(textsOf(r).join('\n'));
    return words.every((w) => text.includes(w));
  });
}

/**
 * Sort keys temporarily changed by the user are placed first, followed by the config-defined
 * sorts (D-560, can be multiple) in the same order; duplicate fields are omitted. When the user
 * hasn't changed it, uses the config default.
 */
export function browseSortKeys<S extends { field: string; direction: 'asc' | 'desc' }>(
  picked: S | undefined,
  configured: S | readonly S[] | undefined,
): S | readonly S[] | undefined {
  if (picked === undefined) return configured;
  const rest = (
    configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]
  ) as readonly S[];
  const after = rest.filter((k) => k.field !== picked.field);
  return after.length === 0 ? picked : [picked, ...after];
}

/** When the user taps "Sort by this field" (D-424): dates and numbers largest first, others from A to Z. */
export function browseSort(
  field: string,
  tables: readonly Collection[],
  tableId: string,
): { field: string; direction: 'asc' | 'desc' } {
  const type =
    field === 'createdAt' || field === 'updatedAt'
      ? 'datetime'
      : tables.find((c) => c.id === tableId)?.fields.find((f) => f.id === field)?.type;
  const newestFirst = ['date', 'datetime', 'number', 'money', 'rating', 'duration'].includes(
    type ?? '',
  );
  return { field, direction: newestFirst ? 'desc' : 'asc' };
}

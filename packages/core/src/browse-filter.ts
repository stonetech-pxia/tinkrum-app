import type { Calendar } from './calendar';
import {
  formatRef,
  localDate,
  periodRange,
  recordValue,
  type DataRecord,
  type LinkResolver,
} from './data';
import { cleanTags, tagKey } from './fields';
import { localeTag } from './localization';
import type { Collection, Field, Locale, Period } from './schema';

// Tags used across these records: each unique tag (case-insensitive) counted once, sorted. Tags no longer used by any record disappear.

/** Tags used across these records: each unique tag (case-insensitive) counted once, sorted. Tags no longer used by any record disappear. */
export function tagsInRecords(
  records: readonly DataRecord[],
  view: Collection,
  fieldId: string,
  locale: Locale,
): string[] {
  const all = cleanTags(
    records.flatMap((r) => {
      const v = recordValue(r, view, fieldId);
      return Array.isArray(v) ? (v as readonly string[]) : [];
    }),
  );
  return all.sort(new Intl.Collator(localeTag(locale)).compare);
}

/**
 * Values to offer under a text field with suggest: true (D-642): what these records already hold
 * in it, each once (case and character width ignored, in its latest spelling), the one held by the
 * most records first and equal counts the latest saved first; kept when it contains what is typed
 * and left out when the field already says exactly that. Computed from the records every time, never
 * stored (Invariant 14).
 */
export function pastTextValues(
  records: readonly DataRecord[],
  view: Collection,
  fieldId: string,
  typed: unknown,
  limit: number,
): string[] {
  const now = typeof typed === 'string' ? typed.trim() : '';
  const query = tagKey(now);
  // Latest saved first: the first spelling met is the latest, and the stable sort below keeps this
  // order between equal counts.
  const found = new Map<string, { value: string; count: number }>();
  for (const record of [...records].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const raw = recordValue(record, view, fieldId);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = tagKey(value);
    const seen = found.get(key);
    if (seen) seen.count += 1;
    else found.set(key, { value, count: 1 });
  }
  return [...found]
    .filter(([key, { value }]) => value !== now && key.includes(query))
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, limit)
    .map(([, { value }]) => value);
}

export interface BrowseFilterRow {
  field: string;
  values: { value: string; label: string }[];
}

function rowValues(
  records: readonly DataRecord[],
  view: Collection,
  field: Field,
  locale: Locale,
): BrowseFilterRow['values'] {
  if (field.type === 'tags')
    return tagsInRecords(records, view, field.id, locale).map((tag) => ({
      value: tag,
      label: tag,
    }));
  if (field.type !== 'choice') return [];
  // Single-select follows option order, listing only those used by records.
  const used = new Set(records.flatMap((r) => [recordValue(r, view, field.id)].flat()));
  return field.options.filter((o) => used.has(o.id)).map((o) => ({ value: o.id, label: o.label }));
}

/** One row per filter field; fields without values have no row. */
export function browseFilterRows(
  records: readonly DataRecord[],
  view: Collection,
  fields: readonly string[],
  locale: Locale,
): BrowseFilterRow[] {
  return fields.flatMap((id) => {
    const field = view.fields.find((f) => f.id === id);
    const values = field ? rowValues(records, view, field, locale) : [];
    return values.length > 0 ? [{ field: id, values }] : [];
  });
}

/** Retains only records where this field matches this value (tags: record has this tag, case-insensitive; multi-select: item is selected, D-607). */
export function browseFilter(
  records: readonly DataRecord[],
  view: Collection,
  picked: { field: string; value: string },
): DataRecord[] {
  const choice = view.fields.find((f) => f.id === picked.field)?.type === 'choice';
  return records.filter((r) => {
    const v = recordValue(r, view, picked.field);
    if (choice) return [v].flat().includes(picked.value);
    return Array.isArray(v)
      ? (v as readonly string[]).some((tag) => tagKey(tag) === tagKey(picked.value))
      : v === picked.value;
  });
}

/** Time periods switchable on lists (D-437): this week, this month, this year; plus "All" (none selected). */
export const BROWSE_PERIODS = [
  'thisWeek',
  'thisMonth',
  'thisYear',
] as const satisfies readonly Period[];
export type BrowsePeriod = (typeof BROWSE_PERIODS)[number];

/** Retains only records where this date field (or creation/modification time) falls within the current time period; computed on demand, stored nowhere. Records without dates fall outside all periods. */
export function browsePeriod(
  records: readonly DataRecord[],
  view: Collection,
  fieldId: string,
  period: BrowsePeriod,
  now: Date,
  cal?: Calendar,
): DataRecord[] {
  const [start, end] = periodRange(period, now, cal);
  return records.filter((r) => {
    const v = recordValue(r, view, fieldId);
    const day =
      typeof v === 'number' ? localDate(new Date(v)) : typeof v === 'string' ? v.slice(0, 10) : '';
    return day !== '' && day >= start && day <= end;
  });
}

/**
 * Searchable text: rendered display representation of each field in the table regardless of list
 * visibility (phone, email, notes, tags, single-select name), plus the displayed row value (such
 * as creation time). Attachments excluded: file names and file contents are not searched.
 */
export function recordSearchTexts(
  record: DataRecord,
  view: Collection,
  shown: readonly string[],
  locale: Locale,
  links?: LinkResolver,
  now: Date = new Date(),
  cal?: Calendar,
): string[] {
  const ids = [...view.fields.filter((f) => f.type !== 'file').map((f) => f.id), ...shown];
  return [...new Set(ids)]
    .filter((id) => view.fields.find((f) => f.id === id)?.type !== 'file')
    .map((id) => formatRef(record, view, id, locale, links, now, cal));
}

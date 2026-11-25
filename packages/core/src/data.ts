import {
  formatTimestamp,
  localDate,
  round,
  type FieldValue,
  type LinkResolver,
  formatMoney,
} from './field-values';
import {
  DEFAULT_CALENDAR,
  dateOfDayNumber,
  dayOf,
  todayNumber,
  twoWeekStartOf,
  weekStartOf,
  type Calendar,
} from './calendar';
import { t } from './messages';
import { fieldForRecord, recordCurrency } from './money-currency';
import {
  scheduleDue,
  scheduleStatus,
  shortDate,
  scheduleStatusText,
  type ScheduleDue,
  type ScheduleOptions,
  type ScheduleStatus,
} from './schedule';
import {
  dayNumber,
  evaluateFormula,
  minuteNumber,
  minuteOfDay,
  parseFormula,
  type FormulaNode,
} from './formula';
import {
  FIELDS,
  fieldDefinition,
  type Collection,
  type Condition,
  type Field,
  type Locale,
  type OffsetUnit,
  type Period,
  type SystemField,
} from './schema';

// Pure functions for user data (records): write validation, lenient reading, filtering, sorting,
// aggregation, display formatting, and CSV export. Records are stored outside configuration (in the
// app database) and never enter WorkspaceConfig, hence never sent to the AI. Design details in
// docs/DATA_DESIGN.md. Reading, writing, and display for each field type are in fields/<type>.ts
// (docs/FIELDS.md).

export {
  MAX_ATTACHMENTS,
  attachmentIds,
  formatDuration,
  formatMoney,
  formatNumber,
  formatTimestamp,
  localDate,
  localDateTime,
  localDateStamp,
  normalizeTime,
  type FieldValue,
  type LinkResolver,
} from './field-values';

export const RECORD_LIMITS = {
  /** Soft limit per table: cannot add more once exceeded. */
  perCollection: 10_000,
  /** Retention days for soft-deleted records (D-037). */
  deletedRetentionDays: 30,
} as const;

export interface DataRecord {
  id: string;
  collectionId: string;
  /** Field ID → value. May contain values of deleted fields (retained, not displayed). */
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Local date range corresponding to a time period (inclusive of both ends). "Today" and the first
 * day of the week follow cal (D-286, default 00:00, Monday).
 */
export function periodRange(
  period: Period,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): [string, string] {
  const today = todayNumber(now, cal);
  const span = (start: number, days: number): [string, string] => [
    dateOfDayNumber(start),
    dateOfDayNumber(start + days - 1),
  ];
  const [y, m, d] = dateOfDayNumber(today).split('-').map(Number) as [number, number, number];
  const monthEnd = localDate(new Date(y, m, 0));
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  /** An entire month, being the N-th month before (negative) or after the current month. */
  const month = (by: number): [string, string] => {
    const first = new Date(y, m - 1 + by, 1);
    return [localDate(first), localDate(new Date(first.getFullYear(), first.getMonth() + 1, 0))];
  };
  switch (period) {
    case 'today':
      return span(today, 1);
    case 'thisWeek':
      return span(weekStartOf(today, cal), 7);
    case 'thisTwoWeeks':
      return span(twoWeekStartOf(today, cal), 14);
    case 'thisHalfMonth':
      return d <= 15 ? [`${ym}-01`, `${ym}-15`] : [`${ym}-16`, monthEnd];
    case 'thisMonth':
      return [`${ym}-01`, monthEnd];
    case 'thisYear':
      return [`${y}-01-01`, `${y}-12-31`];
    case 'last7days':
      return span(today - 6, 7);
    case 'last14days':
      return span(today - 13, 14);
    case 'last30days':
      return span(today - 29, 30);
    case 'last90days':
      return span(today - 89, 90);
    case 'last365days':
      return span(today - 364, 365);
    case 'next7days':
      return span(today, 7);
    case 'next30days':
      return span(today, 30);
    case 'next90days':
      return span(today, 90);
    // A full consecutive range before and after on the calendar (D-559).
    case 'yesterday':
      return span(today - 1, 1);
    case 'tomorrow':
      return span(today + 1, 1);
    case 'lastWeek':
      return span(weekStartOf(today, cal) - 7, 7);
    case 'nextWeek':
      return span(weekStartOf(today, cal) + 7, 7);
    case 'lastMonth':
      return month(-1);
    case 'nextMonth':
      return month(1);
    case 'lastYear':
      return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  }
}

export const isSystemField = (ref: string): ref is SystemField =>
  ref === 'createdAt' || ref === 'updatedAt';

export function fieldOf(collection: Collection, ref: string): Field | undefined {
  return collection.fields.find((f) => f.id === ref);
}

/** Lenient reading: returns undefined when the value does not match the current field definition (simply not displayed, never throws errors). */
export function readValue(field: Field, raw: unknown): FieldValue | undefined {
  return fieldDefinition(field.type).read(field, raw);
}

const formulaCache = new Map<string, FormulaNode | null>();
function formulaNode(expression: string): FormulaNode | null {
  let node = formulaCache.get(expression);
  if (node === undefined) {
    const parsed = parseFormula(expression);
    node = parsed.ok ? parsed.node : null;
    formulaCache.set(expression, node);
  }
  return node;
}

/**
 * Value of a formula field on a record: has a value only when all referenced fields have values;
 * result is rounded according to the field's decimal places (default 2). Date fields are
 * calculated in days, where today is based on the day of now (D-247; day start hour determined by
 * cal, D-286); time and datetime fields are calculated in minutes (D-280). Referenced formulas
 * (D-281) use their rounded values; circular references to itself (caught by validation, though
 * possible in legacy data) have no value.
 */
function formulaValue(
  field: Extract<Field, { type: 'formula' }>,
  record: DataRecord,
  collection: Collection,
  now: Date,
  cal: Calendar,
  using: readonly string[] = [],
): number | undefined {
  const node = formulaNode(field.expression);
  if (!node || using.includes(field.id)) return undefined;
  const kindOf = (id: string) => {
    const ref = fieldOf(collection, id);
    return (ref && fieldDefinition(ref.type).formula) ?? null;
  };
  // Empty numbers count as 0 (D-619): only when the formula field specifies empty "zero"; date and time fields remain without a value as usual.
  const zero = field.empty === 'zero';
  const value = evaluateFormula(
    node,
    (id) => {
      const v = operand(id);
      return v === undefined && zero && kindOf(id) === 'number' ? 0 : v;
    },
    todayNumber(now, cal),
    kindOf,
  );
  return value === undefined ? undefined : round(value, field.decimals ?? 2);

  function operand(id: string): number | undefined {
    const ref = fieldOf(collection, id);
    const kind = kindOf(id);
    if (!ref || !kind) return undefined;
    if (ref.type === 'formula')
      return formulaValue(ref, record, collection, now, cal, [...using, field.id]);
    // Schedules (D-295) evaluate to their next occurrence in formulas.
    if (ref.type === 'schedule') return scheduleStatusOf(record, collection, ref, now, cal)?.next;
    const v = readValue(ref, record.values[id]);
    // Checkboxes and single-selects (D-569) are converted to numbers according to field definitions.
    const def = fieldDefinition(ref.type);
    if (def.formulaNumber) return def.formulaNumber(ref, v);
    if (typeof v === 'number') return kind === 'number' ? v : undefined;
    if (typeof v !== 'string') return undefined;
    if (kind === 'date') return dayNumber(v);
    if (kind === 'time') return minuteOfDay(v);
    return kind === 'datetime' ? minuteNumber(v) : undefined;
  }
}

/**
 * The calendar day corresponding to a date-type field on a record (local date YYYY-MM-DD): for
 * system fields and dates, it is the date itself; for datetimes, it is that date (D-279),
 * treating times earlier than the day start hour as belonging to the previous day (D-286); other
 * fields have none. Used by filter inPeriod, date comparisons, chart time-grouping, and day-based
 * aggregation (D-284).
 */
export function recordDay(
  record: DataRecord,
  collection: Collection,
  ref: string,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): string | undefined {
  const field = fieldOf(collection, ref);
  // Schedules (D-295) fall on their next occurrence day.
  if (field?.type === 'schedule') {
    const next = scheduleStatusOf(record, collection, field, now, cal)?.next;
    return next === undefined ? undefined : dateOfDayNumber(next);
  }
  const value = recordValue(record, collection, ref, now, cal);
  const day = field && fieldDefinition(field.type).day;
  if (value === undefined || !day) return typeof value === 'string' ? value : undefined;
  const date = day(field, value);
  const hour = Number(String(value).slice(11, 13));
  return hour < cal.dayStartHour ? dateOfDayNumber(dayNumber(date)! - 1) : date;
}

/**
 * Status of a schedule field on a record (D-292, D-293): absent when rules cannot be parsed.
 * Completed days come from the date or datetime field pointed to by lastDone (attributed to a
 * calendar day based on day start hour), or from the days of those records aggregated by a rollup
 * field (rollupDays); when lastDone is absent or empty, calculation is based solely on the rules.
 */
/**
 * Rollup fields (D-288) record on each computed record the respective days (in day numbers) of
 * the aggregated source records; schedule lastDone references use this during rollups (D-293): "3
 * times a week" requires knowing how many days were completed this week, and looking only at the
 * most recent occurrence is insufficient. Stored in memory only, not in the database.
 */
export const rollupDays = new WeakMap<DataRecord, Map<string, readonly number[]>>();

export function scheduleStatusOf(
  record: DataRecord,
  collection: Collection,
  field: Extract<Field, { type: 'schedule' }>,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): ScheduleStatus | undefined {
  const rule = readValue(field, record.values[field.id]);
  if (rule === undefined) return undefined;
  return scheduleStatus(
    rule as Parameters<typeof scheduleStatus>[0],
    scheduleDoneDays(record, collection, field, now, cal),
    todayNumber(now, cal),
    cal,
    scheduleOptionsOf(record, field, cal),
  );
}

/** Schedule field countEarly (D-341) counts starting from the record creation day. */
export function scheduleOptionsOf(
  record: DataRecord,
  field: Extract<Field, { type: 'schedule' }>,
  cal: Calendar = DEFAULT_CALENDAR,
): ScheduleOptions {
  return field.countEarly
    ? { countEarly: true, since: dayNumber(dayOf(new Date(record.createdAt), cal))! }
    : {};
}

/** Completed days (in days) for a schedule field on a record: derived from the field pointed to by lastDone or rollups (see scheduleStatusOf). */
export function scheduleDoneDays(
  record: DataRecord,
  collection: Collection,
  field: Extract<Field, { type: 'schedule' }>,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): readonly number[] {
  const fromRollup = field.lastDone ? rollupDays.get(record)?.get(field.lastDone) : undefined;
  if (fromRollup) return fromRollup;
  const last = field.lastDone && recordDay(record, collection, field.lastDone, now, cal);
  const day = last ? dayNumber(last) : undefined;
  return day === undefined ? [] : [day];
}

/**
 * Value of a specified field (including system fields) on a record; system field values are local
 * dates (times before the day start hour count as the previous day, D-286), and formulas are
 * computed on the fly (using the day of now when referencing today).
 */
export function recordValue(
  record: DataRecord,
  collection: Collection,
  ref: string,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): FieldValue | undefined {
  if (isSystemField(ref)) return dayOf(new Date(record[ref]), cal);
  const field = fieldOf(collection, ref);
  if (field?.type === 'formula') return formulaValue(field, record, collection, now, cal);
  if (field?.type === 'dateOffset') return dateOffsetValue(field, record, collection, now, cal);
  return field ? readValue(field, record.values[ref]) : undefined;
}

/**
 * Computed date (D-542): adds add days or add months to from date (datetimes use their calendar
 * day, D-286); when the resulting month exceeds its last day, clamp to the last day (e.g., Jan 31
 * plus one month is Feb 28). No value if from or add has no value.
 */
function dateOffsetValue(
  field: Extract<Field, { type: 'dateOffset' }>,
  record: DataRecord,
  collection: Collection,
  now: Date,
  cal: Calendar,
): string | undefined {
  const start = recordDay(record, collection, field.from, now, cal);
  const n =
    typeof field.add === 'number'
      ? field.add
      : recordValue(record, collection, field.add, now, cal);
  if (start === undefined || typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return offsetDay(start, n, field.unit);
}

/**
 * Adds add days or add months (rounded to an integer) to a given day (YYYY-MM-DD); clamps to the
 * last day of the month if the result exceeds it. Shared between computed dates (D-542) and
 * quick-log tool entry dates (D-565). Empty when the date cannot be parsed.
 */
export function offsetDay(start: string, n: number, unit: OffsetUnit): string | undefined {
  const day = dayNumber(start);
  if (day === undefined || !Number.isFinite(n)) return undefined;
  const add = Math.round(n);
  if (unit === 'days') return dateOfDayNumber(day + add);
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const months = y * 12 + (m - 1) + add;
  const year = Math.floor(months / 12);
  const month = months - year * 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// ---- Writing ----

/** A field that failed to write. tooSmall / tooLarge (D-570): exceeds field min / max, where limit is that bound. */
export type FieldIssue = {
  fieldId: string;
  code: 'required' | 'invalid' | 'tooLong' | 'tooSmall' | 'tooLarge';
  limit?: number;
};

export type PreparedValues =
  { ok: true; values: Record<string, unknown> } | { ok: false; issues: FieldIssue[] };

/** Default value for a new record: default from the definition (replacing date 'today' with current date). */
function defaultValue(field: Field, now: Date, cal: Calendar): FieldValue | undefined {
  const def = fieldDefinition(field.type);
  if (def.initial) return def.initial(field, now, dayOf(now, cal));
  return 'default' in field ? field.default : undefined;
}

/**
 * What a blank new record gets for each field with a default (the same values prepareRecordValues
 * fills in on save), so a form can show them before the user saves.
 */
export function newRecordDefaults(
  collection: Collection,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of collection.fields) {
    const v = defaultValue(field, now, cal);
    if (v !== undefined) values[field.id] = v;
  }
  return values;
}

const isBlank = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/**
 * Fields currently hidden in the record form (D-570): their container section has conditions that
 * evaluate to false based on values. Evaluates only this record's own values.
 */
export function hiddenFormFields(
  collection: Collection,
  values: Record<string, unknown>,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): Set<string> {
  const hidden = new Set<string>();
  const sections = collection.form?.sections ?? [];
  if (!sections.some((s) => s.when)) return hidden;
  const at = now.getTime();
  const record: DataRecord = {
    id: '',
    collectionId: collection.id,
    values,
    createdAt: at,
    updatedAt: at,
  };
  for (const s of sections)
    if (s.when && !s.when.every((c) => matchesCondition(record, collection, c, now, cal)))
      for (const id of s.fields) hidden.add(id);
  return hidden;
}

/** Field range (D-570): specific issue type when numbers exceed min / max. */
function rangeIssue(field: Field, value: unknown): FieldIssue | undefined {
  if (typeof value !== 'number') return undefined;
  const { min, max } = field as { min?: number; max?: number };
  if (min !== undefined && value < min) return { fieldId: field.id, code: 'tooSmall', limit: min };
  if (max !== undefined && value > max) return { fieldId: field.id, code: 'tooLarge', limit: max };
  return undefined;
}

/**
 * Strict validation during write: input contains only fields to be modified (field ID → form
 * value, empty string means clear). previous being null indicates a new record, applying default
 * values (computed via cal for today). Old values of deleted fields are preserved as-is. D-570:
 * numbers exceeding field min / max cannot be saved, but only newly modified values are checked
 * (ranges are added later; stored legacy values can still save other fields); fields inside
 * hidden form sections (unsatisfied conditions) are not checked for required status.
 */
export function prepareRecordValues(
  collection: Collection,
  input: Record<string, unknown>,
  previous: Record<string, unknown> | null,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): PreparedValues {
  const values: Record<string, unknown> = { ...previous };
  const issues: FieldIssue[] = [];
  for (const field of collection.fields) {
    const def = fieldDefinition(field.type);
    // Read-only fields (formulas, D-188): ignored even if present in input.
    if (!def.write) {
      delete values[field.id];
      continue;
    }
    let raw: unknown;
    if (Object.prototype.hasOwnProperty.call(input, field.id)) raw = input[field.id];
    else if (previous !== null) raw = previous[field.id];
    else raw = defaultValue(field, now, cal);
    // Value stored when a new record has no value (unchecked checkboxes default to false).
    if (def.emptyNew !== undefined && raw === undefined && previous === null) raw = def.emptyNew;

    const result = isBlank(raw) ? null : def.write(field, raw);
    // Stored values for single/multi-selects that were not changed now but are no longer valid
    // under current definitions (options deleted, multi-select changed back to single-select,
    // D-607): kept as-is, without blocking the saving of other fields (invariant 5). Checked
    // normally when the user explicitly modifies this field.
    const kept =
      field.type === 'choice' &&
      previous !== null &&
      !Object.prototype.hasOwnProperty.call(input, field.id);
    if (result && 'issue' in result && kept) continue;
    if (result && 'issue' in result) {
      issues.push({ fieldId: field.id, code: result.issue });
    } else if (result === null || result.value === '') {
      delete values[field.id];
      if ('required' in field && field.required)
        issues.push({ fieldId: field.id, code: 'required' });
    } else {
      const unchanged = previous !== null && previous[field.id] === result.value;
      const outside = unchanged ? undefined : rangeIssue(field, result.value);
      if (outside) issues.push(outside);
      values[field.id] = result.value;
    }
  }
  // Fields in hidden sections are exempt from required validation (D-570): sections visibility is determined by evaluated values.
  const hidden = issues.some((i) => i.code === 'required')
    ? hiddenFormFields(collection, values, now, cal)
    : new Set<string>();
  const kept = issues.filter((i) => i.code !== 'required' || !hidden.has(i.fieldId));
  return kept.length > 0 ? { ok: false, issues: kept } : { ok: true, values };
}

// ---- Filtering, Sorting, Statistics ----

function compare(a: FieldValue, b: FieldValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Attachments (a group of file IDs) compared by count.
  if (Array.isArray(a) || Array.isArray(b))
    return (Array.isArray(a) ? a.length : 0) - (Array.isArray(b) ? b.length : 0);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

export function matchesCondition(
  record: DataRecord,
  collection: Collection,
  condition: Condition,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): boolean {
  const field = fieldOf(collection, condition.field);
  // gt / lt dates can be written as "today" (D-537): based on logical today (when a day starts depends on cal).
  const target =
    (condition.op === 'gt' || condition.op === 'lt') && condition.value === 'today'
      ? dateOfDayNumber(todayNumber(now, cal))
      : condition.value;
  // Date-time (D-279) filtered by its day: time ranges, date comparisons, and is / isNot a date.
  if (condition.op === 'due') {
    const status =
      field?.type === 'schedule' && scheduleStatusOf(record, collection, field, now, cal);
    return !!status && scheduleDue(status, target as ScheduleDue, todayNumber(now, cal), cal);
  }
  // Schedule (D-295) filtered by its next occurrence.
  const byDay =
    field !== undefined &&
    (fieldDefinition(field.type).day !== undefined || field.type === 'schedule') &&
    (condition.op === 'inPeriod' ||
      condition.op === 'gt' ||
      condition.op === 'lt' ||
      (typeof target === 'string' && target.length === 10));
  const value = byDay
    ? recordDay(record, collection, condition.field, now, cal)
    : recordValue(record, collection, condition.field, now, cal);
  // Attachments (D-263): a group of file IDs. is / isNot checks for the presence of the file; other
  // comparisons do not apply. Multi-select (D-607): a group of option IDs, is a list means
  // "contains one of these".
  if (Array.isArray(value)) {
    const wanted: unknown[] = Array.isArray(target) ? target : [target];
    const has = wanted.some((x) => typeof x === 'string' && value.includes(x));
    if (condition.op === 'isNotEmpty') return true;
    if (condition.op === 'is') return has;
    if (condition.op === 'isNot') return !has;
    return false;
  }
  switch (condition.op) {
    case 'isEmpty':
      return value === undefined || value === '';
    case 'isNotEmpty':
      return value !== undefined && value !== '';
    case 'is':
      // Single-select "is one of" (D-538).
      if (Array.isArray(target)) return typeof value === 'string' && target.includes(value);
      return value !== undefined && target !== undefined && value === target;
    case 'isNot':
      return value === undefined || value !== target;
    case 'contains':
      return (
        typeof value === 'string' &&
        typeof target === 'string' &&
        value.toLowerCase().includes(target.toLowerCase())
      );
    case 'gt':
      return value !== undefined && target !== undefined && compare(value, target) > 0;
    case 'lt':
      return value !== undefined && target !== undefined && compare(value, target) < 0;
    case 'inPeriod': {
      if (typeof value !== 'string' || typeof target !== 'string') return false;
      const [start, end] = periodRange(target as Period, now, cal);
      return value >= start && value <= end;
    }
  }
}

export function filterRecords(
  records: readonly DataRecord[],
  collection: Collection,
  conditions: readonly Condition[] | undefined,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): DataRecord[] {
  if (!conditions?.length) return [...records];
  return records.filter((r) =>
    conditions.every((c) => matchesCondition(r, collection, c, now, cal)),
  );
}

type SortKey = { field: string; direction: 'asc' | 'desc' };

/**
 * Sorting: empty values always last; single-select by option order; schedule by next occurrence
 * (D-295); default by creation time newest to oldest. Can have 1–3 sequential sort keys (D-560):
 * ties on the first are broken by the second, with empty values last in each case; ties across
 * all are broken by creation time newest to oldest.
 */
export function sortRecords(
  records: readonly DataRecord[],
  collection: Collection,
  sort: SortKey | readonly SortKey[] | undefined,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): DataRecord[] {
  const list: readonly SortKey[] =
    sort === undefined ? [] : Array.isArray(sort) ? sort : [sort as SortKey];
  const keys = (list.length > 0 ? list : [{ field: 'createdAt', direction: 'desc' as const }]).map(
    ({ field, direction }) => ({
      sign: direction === 'asc' ? 1 : -1,
      key: sortKeyOf(collection, field, now, cal),
    }),
  );
  // Compute sort keys for each record once beforehand (formulas and schedules are expensive to evaluate repeatedly), keeping comparison rules unchanged.
  const keyed = records.map((r) => ({ r, k: keys.map((x) => x.key(r)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const ka = a.k[i];
      const kb = b.k[i];
      if (ka === undefined && kb === undefined) continue;
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      const order = keys[i]!.sign * compare(ka, kb);
      if (order !== 0) return order;
    }
    return b.r.createdAt - a.r.createdAt;
  });
  return keyed.map((x) => x.r);
}

/** Sort key when a record is sorted by this field. */
function sortKeyOf(
  collection: Collection,
  field: string,
  now: Date,
  cal: Calendar,
): (r: DataRecord) => FieldValue | undefined {
  const def = fieldOf(collection, field);
  const sortKey = def && fieldDefinition(def.type).sort;
  const key = (r: DataRecord): FieldValue | undefined => {
    if (isSystemField(field)) return r[field];
    if (def?.type === 'schedule') {
      // Same-day items sorted by hour (D-346), with untimed items placed at the end of that day.
      const next = scheduleStatusOf(r, collection, def, now, cal)?.next;
      const time = (readValue(def, r.values[def.id]) as { time?: string } | undefined)?.time;
      return next === undefined ? undefined : next + (time ? minuteOfDay(time)! / 1440 : 0.9999);
    }
    const v = recordValue(r, collection, field, now, cal);
    // Some fields use their own sort order (e.g., single-select uses option order).
    return def && sortKey && v !== undefined ? sortKey(def, v) : v;
  };
  return key;
}

export type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** Aggregation result; returns null when no numeric values are available. */
export function aggregateRecords(
  records: readonly DataRecord[],
  collection: Collection,
  aggregate: Aggregate,
  fieldId: string | undefined,
): number | null {
  if (aggregate === 'count') return records.length;
  if (!fieldId) return null;
  const numbers = records
    .map((r) => recordValue(r, collection, fieldId))
    .filter((v): v is number => typeof v === 'number');
  if (numbers.length === 0) return aggregate === 'sum' ? 0 : null;
  switch (aggregate) {
    case 'sum':
      return round(
        numbers.reduce((a, b) => a + b, 0),
        4,
      );
    case 'avg':
      return round(numbers.reduce((a, b) => a + b, 0) / numbers.length, 2);
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
  }
}

/**
 * Per-currency amounts (D-429): sums, averages, etc., are calculated separately per currency and
 * formatted as "$100.00 · €50.00" without conversion. Returns null if there are other fields,
 * other aggregations, or no monetary values (displayed normally).
 */
export function perCurrencyText(
  records: readonly DataRecord[],
  collection: Collection,
  aggregate: string,
  fieldId: string | undefined,
  locale: Locale,
): string | null {
  const field = fieldId === undefined ? undefined : collection.fields.find((f) => f.id === fieldId);
  if (field?.type !== 'money' || field.currencyField === undefined) return null;
  if (aggregate !== 'sum' && aggregate !== 'avg' && aggregate !== 'min' && aggregate !== 'max')
    return null;
  const byCode = new Map<string, DataRecord[]>();
  for (const r of records) {
    if (typeof recordValue(r, collection, field.id) !== 'number') continue;
    const code = recordCurrency(field, r.values, collection);
    byCode.set(code, [...(byCode.get(code) ?? []), r]);
  }
  if (byCode.size === 0) return null;
  return [...byCode.keys()]
    .sort()
    .map((code) =>
      formatMoney(
        aggregateRecords(byCode.get(code)!, collection, aggregate, field.id) ?? 0,
        code,
        locale,
      ),
    )
    .join(' · ');
}

export interface StatGroup {
  /** Option ID; null for unselected records. */
  optionId: string | null;
  label: string;
  count: number;
  value: number | null;
}

/**
 * Grouped statistics by single-select field (D-248): one row per option (in option order,
 * including options with no records), with unselected records (if any) placed in the last row
 * (labeled using noChoice). Options whose values have been deleted are treated as unselected.
 */
export function groupedAggregate(
  records: readonly DataRecord[],
  collection: Collection,
  aggregate: Aggregate,
  fieldId: string | undefined,
  groupBy: string,
  noChoice: string,
  linked?: LinkedGroups,
): StatGroup[] {
  return groupRecords(records, collection, groupBy, noChoice, linked).map(
    ({ records: list, ...g }) => ({
      ...g,
      value: aggregateRecords(list, collection, aggregate, fieldId),
    }),
  );
}

/** When grouping by a reference field (D-336), the referenced table and its records: one group per entry, with the title matching the display text in the reference. */
export interface LinkedGroups {
  collection: Collection;
  records: readonly DataRecord[];
  locale: Locale;
}

/**
 * Group records by single-select or reference field (grouping part of groupedAggregate): each
 * group computes its own value, e.g., streak days for each habit (D-284). Order and the
 * "unselected" row match groupedAggregate. Reference fields (D-336) require linked: one group per
 * record in the referenced table (ordered from oldest to newest creation time, including those
 * with no records), with unselected or deleted-target references treated as "unselected"; no
 * groups are produced if unlinked.
 */
export function groupRecords(
  records: readonly DataRecord[],
  collection: Collection,
  groupBy: string,
  noChoice: string,
  linked?: LinkedGroups,
): (Omit<StatGroup, 'value'> & { records: DataRecord[] })[] {
  const field = fieldOf(collection, groupBy);
  const labels = new Map<string, string>();
  if (field?.type === 'choice') for (const o of field.options) labels.set(o.id, o.label);
  else if (field?.type === 'link' && linked) {
    for (const r of [...linked.records].sort((a, b) => a.createdAt - b.createdAt))
      labels.set(r.id, linkTitle(r, linked.collection, linked.locale));
  } else return [];
  const buckets = new Map<string | null, DataRecord[]>();
  for (const id of labels.keys()) buckets.set(id, []);
  for (const r of records) {
    const v = readValue(field, r.values[groupBy]);
    // Multi-select (D-607): a record is counted in each item it selects, so the sum of all groups may exceed the record count.
    const keys = [v].flat().filter((k): k is string => typeof k === 'string' && labels.has(k));
    for (const key of keys.length > 0 ? keys : [null])
      buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  return [...buckets.entries()].flatMap(([optionId, list]) =>
    optionId === null && list.length === 0
      ? []
      : [
          {
            optionId,
            label: optionId === null ? noChoice : labels.get(optionId)!,
            count: list.length,
            records: list,
          },
        ],
  );
}

// ---- Display & Export ----

/**
 * Which field a table displays in references: based on field definition titleRank (first text
 * field, falling back to the first long text, single-select, number, amount, or date field).
 */
export function linkTitleField(collection: Collection): Field | undefined {
  const ranked = FIELDS.flatMap((d) => (d.titleRank === undefined ? [] : [d])).sort(
    (a, b) => a.titleRank! - b.titleRank!,
  );
  for (const def of ranked) {
    const f = collection.fields.find((x) => x.type === def.type);
    if (f) return f;
  }
  return undefined;
}

/** Title displayed when a record is referenced by another (falls back to creation time if no displayable field exists). */
export function linkTitle(record: DataRecord, collection: Collection, locale: Locale): string {
  const field = linkTitleField(collection);
  const title = field
    ? formatValue(fieldForRecord(field, record.values, collection), record.values[field.id], locale)
    : '';
  return title || formatTimestamp(record.createdAt, locale);
}

/**
 * Displayed when title is empty in lists, cards, or kanban: table name · saved date ("Shopping
 * Receipt · Oct 31", without year if not current year). Display-only, not written to the title
 * field; displays the user-entered title if provided (D-392 real-device feedback, selected by
 * founder in conversation on 2026-10-31).
 */
export function untitledRecordTitle(
  record: DataRecord,
  collection: Collection,
  locale: Locale,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): string {
  const day = dayNumber(dayOf(new Date(record.createdAt), cal))!;
  return `${collection.name} · ${shortDate(day, todayNumber(now, cal), locale)}`;
}

/** Human-readable title of a record (report captions, pre-save prompts, D-425, D-426): uses the title field if filled, otherwise falls back to the list display format. */
export function recordTitle(
  record: DataRecord,
  collection: Collection,
  locale: Locale,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): string {
  const field = linkTitleField(collection);
  const title = field
    ? formatValue(
        fieldForRecord(field, record.values, collection),
        record.values[field.id],
        locale,
      ).trim()
    : '';
  return title || untitledRecordTitle(record, collection, locale, now, cal);
}

/** Resolves reference titles using loaded records (table ID → non-deleted records). */
export function makeLinkResolver(
  collections: readonly Collection[],
  records: ReadonlyMap<string, readonly DataRecord[]>,
  locale: Locale,
): LinkResolver {
  return (collectionId, recordId) => {
    const collection = collections.find((c) => c.id === collectionId);
    const record = records.get(collectionId)?.find((r) => r.id === recordId);
    return collection && record ? linkTitle(record, collection, locale) : null;
  };
}

/** Loads records of referenced tables (listRecords only returns non-deleted ones) and constructs a title resolution function. Shared by lists, CSV export, and PDF generation. */
export async function loadLinkResolver(
  listRecords: (collectionId: string) => Promise<DataRecord[]>,
  collections: readonly Collection[],
  targets: readonly string[],
  locale: Locale,
): Promise<LinkResolver> {
  const records = new Map<string, DataRecord[]>();
  for (const id of targets) records.set(id, await listRecords(id));
  return makeLinkResolver(collections, records, locale);
}

/** Which tables are pointed to by a table's reference fields (those tables must be loaded together with records). */
export const linkedCollectionIds = (collection: Collection): string[] => [
  ...new Set(collection.fields.flatMap((f) => (f.type === 'link' ? [f.table] : []))),
];

/**
 * Display text for a field value; returns an empty string if invalid or empty. For formula
 * fields, use formatRef (requires the full record to compute). Reference fields require links to
 * display titles; displays "Deleted record" if the referenced record has been deleted (D-250).
 */
export function formatValue(
  field: Field,
  raw: unknown,
  locale: Locale,
  links?: LinkResolver,
): string {
  const def = fieldDefinition(field.type);
  const value = (def.shown ?? def.read)(field, raw);
  return value === undefined ? '' : def.format(field, value, locale, links);
}

/** Display text for a field reference (including system fields) on a record. */
export function formatRef(
  record: DataRecord,
  collection: Collection,
  ref: string,
  locale: Locale,
  links?: LinkResolver,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): string {
  if (isSystemField(ref)) return formatTimestamp(record[ref], locale);
  const field = fieldOf(collection, ref);
  if (field?.type === 'formula' || field?.type === 'dateOffset')
    return formatValue(field, recordValue(record, collection, ref, now, cal), locale);
  // Schedule (D-292): rule · next occurrence (today, tomorrow, days overdue, or a date).
  if (field?.type === 'schedule') {
    const status = scheduleStatusOf(record, collection, field, now, cal);
    const rule = formatValue(field, record.values[ref], locale);
    if (!status) return rule;
    // "Once" (D-340) writes only the date or status (tomorrow, Nov 5, completed) without repeating "once".
    const read = readValue(field, record.values[ref]) as { repeat: string; time?: string };
    const once = read.repeat === 'once';
    const text = scheduleStatusText(status, todayNumber(now, cal), locale, once);
    // "Once" with a specific time follows the date (tomorrow 03:00, D-346); recurring rule text already includes the time.
    if (!once) return `${rule} · ${text}`;
    return read.time && status.next !== undefined
      ? t(locale, 'scheduleAtTime', { rule: text, time: read.time })
      : text;
  }
  return field
    ? formatValue(
        fieldForRecord(field, record.values, collection),
        record.values[ref],
        locale,
        links,
      )
    : '';
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Exports CSV (with BOM, allowing Excel to open Chinese correctly). Exports only current fields and creation time. */
export function recordsToCsv(
  collection: Collection,
  records: readonly DataRecord[],
  locale: Locale,
  links?: LinkResolver,
): string {
  const header = [...collection.fields.map((f) => f.name), t(locale, 'data_Created_1626a')];
  const rows = records.map((r) => [
    ...collection.fields.map((f) => {
      const v = recordValue(r, collection, f.id);
      if (v === undefined) return '';
      const csv = fieldDefinition(f.type).csv;
      return csv ? csv(f, v) : formatValue(f, v, locale, links);
    }),
    formatTimestamp(r.createdAt, locale),
  ]);
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

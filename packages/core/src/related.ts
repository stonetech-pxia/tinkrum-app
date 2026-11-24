import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { conditionProblems } from './conditions';
import {
  aggregateRecords,
  fieldOf,
  isSystemField,
  matchesCondition,
  recordDay,
  recordValue,
  rollupDays,
  type DataRecord,
  type FieldValue,
} from './data';
import { isMultipleChoice, MULTIPLE_CHOICE_NOT_ONE } from './fields';
import type { FieldCheckContext } from './fields/define';
import { hasRecordCurrency } from './money-currency';
import { dayNumber, parseFormula } from './formula';
import {
  NUMERIC_FIELD_TYPES,
  type Collection,
  type Condition,
  type Field,
  type FieldOf,
} from './schema';
import { isSequenceAggregate, sequenceValue } from './sequence';

// Lookups, rollups, and previous entries can be chained up to a maximum depth (D-290): a lookup
// through a rollup counts as two levels.
// - Lookup, rollup, previous (D-287–D-291): Values of these three field types are computed from
// other records, are not stored in records, cannot be filled manually, and are computed locally
// only (records are never sent to AI, D-042, D-113).
// - expandCollection: Replaces them with the type of field they display (e.g., looking up an amount
// becomes an amount field), so display, filtering, sorting, formulas, statistics, and charts follow
// that field definition directly without needing a separate implementation.
// - computeRecords: Places computed values into a record copy (indexed by table once: reference
// field → record, rather than scanning the entire table for every entry).
// - relatedProblems: Field definition checks, including preventing self-references and exceeding
// MAX_RELATED_DEPTH.

/** Maximum nesting depth for lookups, rollups, and previous entries (D-290): a lookup through a rollup counts as two levels. */
export const MAX_RELATED_DEPTH = 3;

type Computed = FieldOf<'lookup' | 'rollup' | 'previous'>;
const isComputed = (f: Field): f is Computed =>
  f.type === 'lookup' || f.type === 'rollup' || f.type === 'previous';

/** A field reference: specific table and field. */
interface Ref {
  collectionId: string;
  fieldId: string;
}
const refKey = (r: Ref) => `${r.collectionId}.${r.fieldId}`;

const tableOf = (collections: readonly Collection[], id: string) =>
  collections.find((c) => c.id === id);

/** The table pointed to by a reference field. */
function linkTarget(collections: readonly Collection[], collection: Collection, linkId: string) {
  const link = fieldOf(collection, linkId);
  return link?.type === 'link' ? tableOf(collections, link.table) : undefined;
}

/** Explicitly specified date; if not specified, uses the first date field, failing that the first date-time field, and finally the creation time (same as statistics and charts). */
const dateOr = (collection: Collection, date: string | undefined): string =>
  date ??
  collection.fields.find((f) => f.type === 'date')?.id ??
  collection.fields.find((f) => f.type === 'datetime')?.id ??
  'createdAt';

/** Date used for rollup calculation (latest, daily aggregation): days.date, defaults to the above. */
const rollupDate = (source: Collection, f: FieldOf<'rollup'>) => dateOr(source, f.days?.date);

/** Date ordering used for the previous entry. */
const previousDate = (collection: Collection, f: FieldOf<'previous'>) => dateOr(collection, f.date);

/** Conditions that a rollup must satisfy (v34: v33 period migrated to an inPeriod condition in the filter). */
const rollupConditions = (f: FieldOf<'rollup'>): Condition[] => f.filter ?? [];

/**
 * Fields directly used by a field (in the same table or another table): used for cycle detection,
 * depth calculation, and determining computation order. Hop: this step is a lookup, rollup, or
 * previous (counts as one level); formulas use fields within the same table and do not count
 * towards depth.
 */
function depsOf(
  collections: readonly Collection[],
  collection: Collection,
  field: Field,
): { refs: Ref[]; hop: boolean } {
  const here = (fieldId: string): Ref => ({ collectionId: collection.id, fieldId });
  switch (field.type) {
    case 'formula': {
      const parsed = parseFormula(field.expression);
      return { refs: parsed.ok ? parsed.refs.map(here) : [], hop: false };
    }
    case 'dateOffset':
      return {
        refs: [field.from, ...(typeof field.add === 'string' ? [field.add] : [])].map(here),
        hop: false,
      };
    case 'lookup': {
      const target = linkTarget(collections, collection, field.via);
      const refs = [here(field.via)];
      if (target) refs.push({ collectionId: target.id, fieldId: field.field });
      return { refs, hop: true };
    }
    case 'rollup': {
      const source = tableOf(collections, field.table);
      if (!source) return { refs: [], hop: true };
      const there = (fieldId: string): Ref => ({ collectionId: source.id, fieldId });
      const ids = [
        field.via,
        field.field,
        rollupDate(source, field),
        field.days?.skip?.field,
        ...rollupConditions(field).map((c) => c.field),
      ];
      return {
        refs: ids.flatMap((id) => (id && !isSystemField(id) ? [there(id)] : [])),
        hop: true,
      };
    }
    case 'previous': {
      const ids = [field.field, previousDate(collection, field), field.within];
      return {
        refs: ids.flatMap((id) => (id && !isSystemField(id) ? [here(id)] : [])),
        hop: true,
      };
    }
    case 'schedule': {
      // Schedule's "completed dates" come from lastDone, which might be a rollup in the same table
      // (D-293): before filtering, formulas, or other rollups read this schedule, that rollup must
      // be computed first and its source table loaded. The schedule itself does not count as a
      // level.
      const lastDone = field.lastDone;
      return { refs: lastDone && !isSystemField(lastDone) ? [here(lastDone)] : [], hop: false };
    }
    default:
      return { refs: [], hop: false };
  }
}

function fieldAt(collections: readonly Collection[], ref: Ref) {
  const c = tableOf(collections, ref.collectionId);
  const f = c && fieldOf(c, ref.fieldId);
  return c && f ? { collection: c, field: f } : undefined;
}

// ---- Replace with its displayed field type ----

/** Change ID and name, remove required and default constraints (computed values do not need manual entry). */
function renamed(src: Field, as: Field): Field {
  const copy: Record<string, unknown> = { ...src, id: as.id, name: as.name };
  delete copy.required;
  delete copy.default;
  return copy as Field;
}

/** Formulas cannot be stored; what is retrieved is their computed number: replace with a number or amount field. */
function asStored(f: Field): Field {
  // Computed dates (D-542) resolve to a date type.
  if (f.type === 'dateOffset') return { id: f.id, name: f.name, type: 'date' };
  if (f.type !== 'formula') return f;
  return f.currency
    ? { id: f.id, name: f.name, type: 'money', currency: f.currency }
    : { id: f.id, name: f.name, type: 'number', decimals: f.decimals, unit: f.unit };
}

/**
 * The displayed field type for a computed field; returns undefined if definitions are mismatched
 * (referenced table or field missing, self-reference, too deep), in which case it keeps its own
 * field (value can only be checked for presence, displays as empty).
 */
function viewField(
  collections: readonly Collection[],
  collection: Collection,
  field: Computed,
  seen: readonly string[],
): Field | undefined {
  const key = refKey({ collectionId: collection.id, fieldId: field.id });
  if (seen.includes(key) || seen.length > MAX_RELATED_DEPTH) return undefined;
  const valueOf = (ref: Ref): Field | undefined => {
    const at = fieldAt(collections, ref);
    if (!at) return undefined;
    const f = isComputed(at.field)
      ? viewField(collections, at.collection, at.field, [...seen, key])
      : at.field;
    return f && asStored(f);
  };
  switch (field.type) {
    case 'lookup': {
      const target = linkTarget(collections, collection, field.via);
      const src = target && valueOf({ collectionId: target.id, fieldId: field.field });
      return src && renamed(src, field);
    }
    case 'previous': {
      const src = valueOf({ collectionId: collection.id, fieldId: field.field });
      return src && renamed(src, field);
    }
    case 'rollup': {
      const source = tableOf(collections, field.table);
      if (!source) return undefined;
      if (field.aggregate === 'count' || isSequenceAggregate(field.aggregate)) return field;
      if (field.aggregate === 'latest') {
        const ref = field.field ?? rollupDate(source, field);
        if (isSystemField(ref)) return { id: field.id, name: field.name, type: 'date' };
        const src = valueOf({ collectionId: source.id, fieldId: ref });
        return src && renamed(src, field);
      }
      const src = field.field && valueOf({ collectionId: source.id, fieldId: field.field });
      if (!src || !NUMERIC_FIELD_TYPES.includes(src.type)) return undefined;
      // Ratings sums and averages are no longer 1–5 ratings.
      if (src.type === 'rating') return { id: field.id, name: field.name, type: 'number' };
      return renamed(src, field);
    }
  }
}

const expanded = new WeakMap<readonly Collection[], Map<string, Collection>>();

/**
 * Among the fields of this table, replace lookups, rollups, and previous fields with the field
 * types they display (keeping ID and name unchanged) for use in display, filtering, sorting,
 * formulas, statistics, and charts. Writing records (prepareRecordValues) and forms still use the
 * original table. The collections structure remains identical.
 */
export function expandCollection(
  collections: readonly Collection[],
  collection: Collection,
): Collection {
  if (!collection.fields.some(isComputed)) return collection;
  let cache = expanded.get(collections);
  if (!cache) expanded.set(collections, (cache = new Map()));
  const hit = cache.get(collection.id);
  if (hit && cache.get(`raw:${collection.id}`) === collection) return hit;
  const result = {
    ...collection,
    fields: collection.fields.map((f) =>
      isComputed(f) ? (viewField(collections, collection, f, []) ?? f) : f,
    ),
  };
  cache.set(collection.id, result);
  cache.set(`raw:${collection.id}`, collection);
  return result;
}

/** Determine which tables' records need to be read for this table (itself first): lookup target tables, rollup source tables, layer by layer downwards. */
export function relatedCollectionIds(
  collections: readonly Collection[],
  collection: Collection,
): string[] {
  const tables = new Set([collection.id]);
  const seen = new Set<string>();
  const walk = (ref: Ref) => {
    if (seen.has(refKey(ref))) return;
    seen.add(refKey(ref));
    const at = fieldAt(collections, ref);
    if (!at) return;
    tables.add(at.collection.id);
    for (const dep of depsOf(collections, at.collection, at.field).refs) walk(dep);
  };
  for (const f of collection.fields)
    if (isComputed(f) || f.type === 'formula' || f.type === 'dateOffset')
      walk({ collectionId: collection.id, fieldId: f.id });
  return [...tables];
}

// ---- Compute values ----

/** Date used for sorting: system fields are timestamps, date and date-time are strings (compared between the same field). */
function dateKey(r: DataRecord, view: Collection, ref: string, now: Date, cal: Calendar) {
  if (isSystemField(ref)) return r[ref];
  const v = recordValue(r, view, ref, now, cal);
  return typeof v === 'string' ? v : undefined;
}

const byDate = <T extends { key: number | string; record: DataRecord }>(a: T, b: T) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : a.record.createdAt - b.record.createdAt;

/**
 * Compute and populate values for lookups, rollups, and previous fields in a table's records
 * (copy, does not modify records in-place). records is table ID → undeleted records, including
 * tables listed in relatedCollectionIds. Dates and "today" follow now and cal (D-286). Stored
 * values for these field types in records (leftover before field type change) are ignored.
 */
export function computeRecords(
  collections: readonly Collection[],
  collectionId: string,
  records: ReadonlyMap<string, readonly DataRecord[]>,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): DataRecord[] {
  const collection = tableOf(collections, collectionId);
  const own = records.get(collectionId) ?? [];
  if (!collection?.fields.some(isComputed)) return [...own];

  const work = new Map<string, DataRecord[]>();
  const byId = new Map<string, Map<string, DataRecord>>();
  const indexes = new Map<string, Map<string, DataRecord[]>>();
  const done = new Set<string>();
  const active = new Set<string>();
  const view = (c: Collection) => expandCollection(collections, c);

  const rows = (id: string): DataRecord[] => {
    let list = work.get(id);
    if (!list) {
      const c = tableOf(collections, id);
      const computedIds = c ? c.fields.filter(isComputed).map((f) => f.id) : [];
      list = (records.get(id) ?? []).map((r) => {
        const values = { ...r.values };
        for (const f of computedIds) delete values[f];
        return { ...r, values };
      });
      work.set(id, list);
    }
    return list;
  };
  const recordById = (id: string, recordId: string) => {
    let map = byId.get(id);
    if (!map) byId.set(id, (map = new Map(rows(id).map((r) => [r.id, r]))));
    return map.get(recordId);
  };
  /** Reference field → records pointing to each entry (indexed once per table and reference field). */
  const linkIndex = (id: string, linkId: string) => {
    const key = `${id}.${linkId}`;
    let index = indexes.get(key);
    if (!index) {
      index = new Map();
      for (const r of rows(id)) {
        const to = r.values[linkId];
        if (typeof to !== 'string') continue;
        const list = index.get(to);
        if (list) list.push(r);
        else index.set(to, [r]);
      }
      indexes.set(key, index);
    }
    return index;
  };
  const put = (r: DataRecord, fieldId: string, v: FieldValue | null | undefined) => {
    if (v === undefined || v === null) delete r.values[fieldId];
    else r.values[fieldId] = v;
  };

  const fill = (c: Collection, f: Computed) => {
    const list = rows(c.id);
    switch (f.type) {
      case 'lookup': {
        const target = linkTarget(collections, c, f.via);
        for (const r of list) {
          const to = r.values[f.via];
          const linked = target && typeof to === 'string' ? recordById(target.id, to) : undefined;
          put(r, f.id, linked && recordValue(linked, view(target!), f.field, now, cal));
        }
        return;
      }
      case 'rollup': {
        const source = tableOf(collections, f.table);
        if (!source) return list.forEach((r) => put(r, f.id, undefined));
        const sv = view(source);
        const index = linkIndex(source.id, f.via);
        const conditions = rollupConditions(f);
        const dateRef = rollupDate(source, f);
        for (const r of list) {
          let linked = index.get(r.id) ?? [];
          if (conditions.length > 0)
            linked = linked.filter((x) =>
              conditions.every((cond) => matchesCondition(x, sv, cond, now, cal)),
            );
          put(r, f.id, rollupValue(f, linked, sv, dateRef, now, cal));
          // All dates must be used when a schedule's "last completed" points to this rollup (D-293).
          const days = linked.flatMap((x) => {
            const day = recordDay(x, sv, dateRef, now, cal);
            const n = day === undefined ? undefined : dayNumber(day);
            return n === undefined ? [] : [n];
          });
          let byField = rollupDays.get(r);
          if (!byField) rollupDays.set(r, (byField = new Map()));
          byField.set(f.id, days);
        }
        return;
      }
      case 'previous': {
        const cv = view(c);
        const dateRef = previousDate(c, f);
        const groups = new Map<unknown, { key: number | string; record: DataRecord }[]>();
        for (const r of list) {
          put(r, f.id, undefined);
          const key = dateKey(r, cv, dateRef, now, cal);
          if (key === undefined) continue;
          const g = f.within ? r.values[f.within] : '';
          const group = typeof g === 'string' ? g : '';
          const items = groups.get(group);
          if (items) items.push({ key, record: r });
          else groups.set(group, [{ key, record: r }]);
        }
        for (const items of groups.values()) {
          let last: FieldValue | undefined;
          for (const { record } of items.sort(byDate)) {
            const own = recordValue(record, cv, f.field, now, cal);
            put(record, f.id, last);
            if (own !== undefined) last = own;
          }
        }
        return;
      }
    }
  };

  /** Compute dependencies first, then the field itself; circular references (caught by validation, though legacy data might have them) halt traversal, resulting in an empty value. */
  const ensure = (ref: Ref) => {
    const key = refKey(ref);
    if (done.has(key) || active.has(key)) return;
    const at = fieldAt(collections, ref);
    if (!at) return;
    active.add(key);
    for (const dep of depsOf(collections, at.collection, at.field).refs) ensure(dep);
    if (isComputed(at.field)) fill(at.collection, at.field);
    active.delete(key);
    done.add(key);
  };
  for (const f of collection.fields) ensure({ collectionId, fieldId: f.id });
  return rows(collectionId);
}

/**
 * Load records of required tables (listRecords only returns undeleted ones), compute records for
 * this table, along with the view tables (D-291). Shared by app lists, statistics, charts, record
 * pages, CSV export, and quick action "read records".
 */
export async function loadComputedRecords(
  listRecords: (collectionId: string) => Promise<DataRecord[]>,
  collections: readonly Collection[],
  collection: Collection,
  now: Date = new Date(),
  cal: Calendar = DEFAULT_CALENDAR,
): Promise<{ view: Collection; records: DataRecord[] }> {
  const records = new Map<string, DataRecord[]>();
  for (const id of relatedCollectionIds(collections, collection))
    records.set(id, await listRecords(id));
  return {
    view: expandCollection(collections, collection),
    records: computeRecords(collections, collection.id, records, now, cal),
  };
}

/**
 * Value of the ref field for the "latest" entry (shared by rollup latest and number block latest,
 * D-618): latest according to the dateRef date (date field, date-time field, or creation time);
 * ties broken by later creation time; entries without a date or without a ref value are excluded.
 * records are computed records, view is the transformed table.
 */
export function latestValue(
  records: readonly DataRecord[],
  view: Collection,
  ref: string,
  dateRef: string,
  now: Date,
  cal: Calendar,
): FieldValue | undefined {
  let best: { key: number | string; record: DataRecord; value: FieldValue } | undefined;
  for (const record of records) {
    const key = dateKey(record, view, dateRef, now, cal);
    const value = recordValue(record, view, ref, now, cal);
    if (key === undefined || value === undefined) continue;
    const item = { key, record, value };
    if (!best || byDate(best, item) < 0) best = item;
  }
  return best?.value;
}

/** Date used for rollup and number block latest calculations: explicit date (days.date) if specified, otherwise the first date field, date-time field, or creation time in the stored table. */
export const latestDate = (table: Collection, date: string | undefined): string =>
  dateOr(table, date);

/** Rollup value for a single record: undefined when no valid value is available (sum is 0, count is 0, streak is 0). */
function rollupValue(
  f: FieldOf<'rollup'>,
  linked: readonly DataRecord[],
  source: Collection,
  dateRef: string,
  now: Date,
  cal: Calendar,
): FieldValue | undefined {
  switch (f.aggregate) {
    case 'count':
      return linked.length;
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      return aggregateRecords(linked, source, f.aggregate, f.field) ?? undefined;
    case 'latest':
      return latestValue(linked, source, f.field ?? dateRef, dateRef, now, cal);
    default:
      // Date = days.date (defaults to rollupDate), unit, perUnit, and skip are also in days.
      return sequenceValue(linked, source, f.aggregate, f.days, now, cal).value ?? undefined;
  }
}

// ---- Checks (D-290) ----

const DATE_TYPES: readonly string[] = ['date', 'datetime'];

/** Field definition issues (text sent to AI): first check definition validity, then check for circular references and excessive nesting depth. */
export function relatedProblems(
  field: Field,
  { config, collection }: FieldCheckContext,
): { code: string; message: string }[] {
  if (!isComputed(field)) return [];
  const collections = config.data.tables;
  const problems = shapeProblems(collections, collection, field);
  // D-429: Currency follows each record and cannot be carried over by computed fields.
  if (
    problems.length === 0 &&
    hasRecordCurrency(
      expandCollection(collections, collection).fields.find((f) => f.id === field.id),
    )
  )
    problems.push(
      'the money field it reads has its own currency on each entry, so a lookup, rollup or previous field cannot show it',
    );
  if (problems.length === 0) {
    const start = { collectionId: collection.id, fieldId: field.id };
    const loop = loopOf(collections, start);
    if (loop)
      problems.push(
        `uses itself through ${loop.join(' → ')}; a lookup, rollup or previous field can never come back to itself`,
      );
    else {
      const chain = chainOf(collections, start, new Map(), new Set());
      if (chain.length > MAX_RELATED_DEPTH)
        problems.push(
          `lookups, rollups and previous fields can build on each other at most ${MAX_RELATED_DEPTH} levels deep; here it is ${chain.length} (${chain.join(' → ')}); look the value up from a table closer to it`,
        );
    }
  }
  return problems.map((p) => ({ code: 'data', message: `${collection.id}.${field.id}: ${p}` }));
}

function shapeProblems(
  collections: readonly Collection[],
  collection: Collection,
  field: Computed,
): string[] {
  const missing = (c: Collection, id: string) =>
    `${id} is not a field of ${c.id} (fields: ${c.fields.map((f) => f.id).join(', ')})`;
  const dateProblem = (c: Collection, id: string | undefined, key: string) => {
    if (id === undefined || isSystemField(id)) return [];
    const f = fieldOf(expandCollection(collections, c), id);
    return f && DATE_TYPES.includes(f.type)
      ? []
      : [`${key} ${id} must be a date or datetime field of ${c.id} or "createdAt"`];
  };
  switch (field.type) {
    case 'lookup': {
      const link = fieldOf(collection, field.via);
      if (link?.type !== 'link')
        return [`via ${field.via} must be a link field of ${collection.id}`];
      const target = tableOf(collections, link.table);
      // Referenced table does not exist: the reference field itself will report an error.
      if (!target) return [];
      return fieldOf(target, field.field) ? [] : [missing(target, field.field)];
    }
    case 'previous': {
      const problems: string[] = [];
      if (!fieldOf(collection, field.field)) problems.push(missing(collection, field.field));
      problems.push(...dateProblem(collection, field.date, 'date'));
      if (field.within !== undefined) {
        const g = fieldOf(collection, field.within);
        if (g?.type !== 'choice' && g?.type !== 'link')
          problems.push(
            `within ${field.within} must be a choice or link field of ${collection.id}`,
          );
        // Multiple choice (D-607): an entry belongs to multiple groups, making "previous in the same group" ambiguous.
        else if (isMultipleChoice(g))
          problems.push(`within ${field.within} ${MULTIPLE_CHOICE_NOT_ONE}`);
      }
      return problems;
    }
    case 'rollup':
      return rollupProblems(collections, collection, field, missing, dateProblem);
  }
}

function rollupProblems(
  collections: readonly Collection[],
  collection: Collection,
  f: FieldOf<'rollup'>,
  missing: (c: Collection, id: string) => string,
  dateProblem: (c: Collection, id: string | undefined, key: string) => string[],
): string[] {
  const source = tableOf(collections, f.table);
  if (!source) return [`table ${f.table} is not a data table`];
  const link = fieldOf(source, f.via);
  if (link?.type !== 'link') return [`via ${f.via} must be a link field of ${source.id}`];
  if (link.table !== collection.id)
    return [
      `${source.id}.${f.via} links to ${link.table}, not to ${collection.id}; a rollup counts the entries of ${source.id} whose link field points at this table`,
    ];
  const sv = expandCollection(collections, source);
  const problems: string[] = [];
  const numeric =
    f.aggregate === 'sum' ||
    f.aggregate === 'avg' ||
    f.aggregate === 'min' ||
    f.aggregate === 'max';
  if (numeric) {
    const target = f.field ? fieldOf(sv, f.field) : undefined;
    if (!target || !NUMERIC_FIELD_TYPES.includes(target.type))
      problems.push(
        `${f.aggregate} needs field set to a number, money, rating, duration or formula field of ${source.id}`,
      );
  } else if (f.aggregate === 'latest') {
    if (f.field && !fieldOf(sv, f.field)) problems.push(missing(source, f.field));
  } else if (f.field !== undefined)
    problems.push('field only applies to aggregate sum, avg, min, max and latest');
  const days = f.days;
  problems.push(...dateProblem(source, days?.date, 'days.date'));
  if (f.aggregate !== 'streak') {
    if (days?.unit !== undefined || days?.perUnit !== undefined || days?.skip)
      problems.push('days.unit, days.perUnit and days.skip only apply to aggregate "streak"');
  } else if (days?.skip) {
    const { field: skipId, option } = days.skip;
    const skip = fieldOf(source, skipId);
    if (skip?.type !== 'choice')
      problems.push(`days.skip.field ${skipId} must be a choice field of ${source.id}`);
    else if (!skip.options.some((o) => o.id === option))
      problems.push(
        `days.skip.option must be an option id of ${skip.id}: ${skip.options.map((o) => o.id).join(', ')}`,
      );
  }
  problems.push(...conditionProblems(f.filter, sv));
  return problems;
}

/** Starting from start and following referenced fields, returns the cycle path (table.field) if it can return to itself, otherwise null. */
function loopOf(collections: readonly Collection[], start: Ref): string[] | null {
  const seen = new Set<string>();
  const walk = (ref: Ref, path: string[]): string[] | null => {
    const at = fieldAt(collections, ref);
    if (!at) return null;
    for (const next of depsOf(collections, at.collection, at.field).refs) {
      const key = refKey(next);
      if (key === refKey(start)) return [...path, key];
      if (seen.has(key)) continue;
      seen.add(key);
      const found = walk(next, [...path, key]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [refKey(start)]);
}

/** The deepest chain of lookups, rollups, and previous fields (table.field, starting from ref). */
function chainOf(
  collections: readonly Collection[],
  ref: Ref,
  memo: Map<string, string[]>,
  visiting: Set<string>,
): string[] {
  const key = refKey(ref);
  const hit = memo.get(key);
  if (hit) return hit;
  const at = fieldAt(collections, ref);
  if (!at || visiting.has(key)) return [];
  visiting.add(key);
  const { refs, hop } = depsOf(collections, at.collection, at.field);
  let deepest: string[] = [];
  for (const dep of refs) {
    const chain = chainOf(collections, dep, memo, visiting);
    if (chain.length > deepest.length) deepest = chain;
  }
  visiting.delete(key);
  const result = hop ? [key, ...deepest] : deepest;
  memo.set(key, result);
  return result;
}

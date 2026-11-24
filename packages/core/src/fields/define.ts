import { z } from 'zod';

import type { Collection, WorkspaceConfig } from '../schema';
import { formatNumber, round, type FieldValue, type LinkResolver } from '../field-values';
import type { FormulaType } from '../formula';
import { IdSchema, boundedText, type Locale } from '../schema-primitives';

// Properties common to all field types (formulas do not have required).

/** Properties common to all field types (formulas do not have required). */
export const fieldBase = {
  id: IdSchema,
  name: boundedText(1, 40),
  required: z.boolean().optional(),
  /** Input hint (D-570): a short sentence displayed below the input box in record forms and quick add, configured as text just like field names. */
  hint: boundedText(1, 80).optional(),
};

/** Allowed ranges for numeric fields (D-570): checked upon writing, out-of-range existing old values still display normally. */
export const rangeKeys = {
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
};

/** Whether the range itself is valid: min is not greater than max, default value is within the range. */
export function rangeProblems(
  f: { id: string; min?: number | undefined; max?: number | undefined; default?: unknown },
  table: string,
): { code: string; message: string }[] {
  const at = `${table}.${f.id}`;
  if (f.min !== undefined && f.max !== undefined && f.min > f.max)
    return [{ code: 'data', message: `${at}: min ${f.min} is larger than max ${f.max}` }];
  const d = f.default;
  if (
    typeof d === 'number' &&
    ((f.min !== undefined && d < f.min) || (f.max !== undefined && d > f.max))
  )
    return [{ code: 'data', message: `${at}: default ${d} is outside min / max` }];
  return [];
}

/** Result of converting form input into a field value. */
export type Coerced = { value: FieldValue } | { issue: 'invalid' | 'tooLong' };

/** Support of this field type for filter conditions (validate.ts conditionProblems). */
export interface FieldFilter<F> {
  /** Whether 'is' / 'isNot' values match this field. */
  is: (field: F, value: unknown) => boolean;
  /** contains (text containment). */
  contains?: true;
  /** gt / lt comparison type: number, date (YYYY-MM-DD), or time (HH:mm). Unspecified: cannot compare. */
  compare?: 'number' | 'date' | 'time';
  /** inPeriod (today, this week...). */
  period?: true;
  /** Presence check only (isEmpty / isNotEmpty), e.g., reference fields (D-250). */
  emptyOnly?: true;
  /** due (due today, overdue, due this week, D-294): schedule fields. */
  schedule?: true;
}

/** Check the field definition itself (validate.ts). Text-only issues are data issues (code data). */
export interface FieldCheckContext {
  config: WorkspaceConfig;
  collection: Collection;
  /** Same table, lookup, rollup, previous-item display fields (D-287–D-289): checked against formulas. */
  view: Collection;
}

type Instance<S extends z.ZodObject> = z.infer<S>;

export interface FieldSpec<T extends string, S extends z.ZodObject> {
  type: T;
  /** Field definition schema (including id, name, type). */
  schema: S;
  /** Type name in change descriptions: [Chinese, English] (French uses the English counterpart mapping). */
  label: [string, string];
  /** Lenient reading: returns undefined when the value does not match the current definition (simply not displayed, never throws errors). */
  read: (field: Instance<S>, raw: unknown) => FieldValue | undefined;
  /** Value retrieval during display; defaults to read. Formula values are calculated numbers, displayed directly. */
  shown?: (field: Instance<S>, raw: unknown) => FieldValue | undefined;
  /** Form input -> field value (strictly validated upon write). Omitted: not stored in records (formulas, D-188). */
  write?: (field: Instance<S>, input: unknown) => Coerced;
  /** Default value in new records; defaults to the definition's default. today is calculated based on "what hour a day starts" (D-286). */
  initial?: (field: Instance<S>, now: Date, today: string) => FieldValue | undefined;
  /** Stored when a new record has no value (unchecked checkboxes are false). */
  emptyNew?: FieldValue;
  /** Display text (value already read, non-empty). */
  format: (field: Instance<S>, value: FieldValue, locale: Locale, links?: LinkResolver) => string;
  /** Representation in CSV; defaults to the display format. */
  csv?: (field: Instance<S>, value: FieldValue) => string;
  /** How numbers calculated from this field (totals, averages) are displayed; defaults to a regular number. */
  formatAmount?: (field: Instance<S>, n: number, locale: Locale) => string;
  /** Printing reports (html.ts): numeric = right-aligned numeric column; total = which field to use for receipt totals (smaller numbers take priority). */
  print?: {
    numeric?: true;
    total?: { rank: number; format: (field: Instance<S>, sum: number, locale: Locale) => string };
  };
  /** Whether formulas can reference it and what kind of value it counts as (D-188, D-247, D-280). */
  formula?: FormulaType;
  /**
   * Fields whose value is not a number but treated as a number in formulas (D-569): how
   * checkboxes and single-selects convert to numbers (undefined when no value). value is the
   * result of lenient reading, which may be undefined (never stored).
   */
  formulaNumber?: (field: Instance<S>, value: FieldValue | undefined) => number | undefined;
  /** What is missing from this field itself when a formula references it (e.g. a single-select with no values, D-569); a phrase spoken to the AI. */
  formulaProblem?: (field: Instance<S>) => string | undefined;
  /** Whether statistics and charts can sum or average it (stat and chart fieldId). */
  numeric?: true;
  /** Whether it can be filled in record forms (formulas are calculated). */
  inForm?: false;
  filter: FieldFilter<Instance<S>>;
  /**
   * The day this value falls on (local date YYYY-MM-DD). Date-times (D-279) use this: filtering
   * (is, gt / lt, inPeriod) and chart time grouping are calculated based on this day.
   */
  day?: (field: Instance<S>, value: FieldValue) => string;
  /** Sorting: false = cannot be sorted by; omitted = sorts by value. */
  sort?: false | ((field: Instance<S>, value: FieldValue) => FieldValue);
  /** Which field to display when referenced (D-250): smaller numbers take priority, omitted fields are not displayed. */
  titleRank?: number;
  /** When changing field types, types within the same group can be converted to each other (existing values can still be read). */
  convertGroup?: string;
  /** Validation of the field definition itself (referenced table must exist, options must not duplicate...). */
  check?: (field: Instance<S>, ctx: FieldCheckContext) => { code: string; message: string }[];
  /** Explanation sent to the AI: a segment in the prompt line "Field = ..." (the part after the type name, in English). */
  ai: { doc: string; docAfter?: string };
  /** A working example used by generic tests for validation and display (referenced table is expenses, formulas use the weight field). */
  example: Instance<S>;
  /** A value for the example field (omitted for fields that do not store values); generic tests use it to write, read, and display. */
  exampleValue?: FieldValue;
}

/**
 * A field definition. The definition file must specify this type (callbacks reference data table
 * types, which in turn are generated by field definitions; omitting it prevents TypeScript
 * inference).
 */
export type FieldDefinitionOf<T extends string, S extends z.ZodObject> = FieldSpec<T, S> &
  RegistryKind;

/**
 * Registry table classification (v34 "Data · Container · Tool"): fields are data and act on
 * values; stored values can be written, while calculated ones (omitted write: formulas, lookups,
 * rollups, previous) are read-only.
 */
export interface RegistryKind {
  kind: 'data';
  layer: 'value';
  access: 'write' | 'read';
}

export function defineField<const T extends string, S extends z.ZodObject>(
  spec: FieldSpec<T, S>,
): FieldDefinitionOf<T, S> {
  return { ...spec, kind: 'data', layer: 'value', access: spec.write ? 'write' : 'read' };
}

/** is / isNot values are text and numbers. */
export const isText = (_field: unknown, v: unknown) => typeof v === 'string';
export const isNumber = (_field: unknown, v: unknown) => typeof v === 'number';

/** Writing to numeric fields: removes thousands separators, values exceeding one trillion are considered invalid, rounded to decimals places. */
export function writeNumber(input: unknown, decimals: number): Coerced {
  const n = typeof input === 'number' ? input : Number(String(input).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) return { issue: 'invalid' };
  return { value: round(n, decimals) };
}

export const readNumber = (_field: unknown, raw: unknown) =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;

/** Numbers with units ("2.5 kg"). */
export const numberWithUnit = (
  n: number,
  field: { decimals?: number | undefined; unit?: string | undefined },
  locale: Locale,
) => `${formatNumber(n, field.decimals, locale)}${field.unit ? ` ${field.unit}` : ''}`;

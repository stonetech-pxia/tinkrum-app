import { z } from 'zod';

import { formatNumber } from '../field-values';
import {
  DaysSchema,
  IdSchema,
  SEQUENCE_AGGREGATES,
  boundedText,
  filterSchema,
} from '../schema-primitives';
import { isSequenceAggregate, sequenceText } from '../sequence-text';
import { defineField, isNumber, readNumber, type FieldDefinitionOf } from './define';

/** Rollup aggregation algorithms: count, sum, average, min, max, latest value, and date-based variants (D-284). */
export const ROLLUP_AGGREGATES = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'latest',
  ...SEQUENCE_AGGREGATES,
] as const;

const schema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  type: z.literal('rollup'),
  table: IdSchema,
  via: IdSchema,
  aggregate: z.enum(ROLLUP_AGGREGATES),
  field: IdSchema.optional(),
  // v33 period migrated to an inPeriod item at the end here, supporting up to 6 items (M3).
  filter: filterSchema(6).optional(),
  days: DaysSchema.optional(),
});

/**
 * D-288: Rollup. Computes records in another table (table) pointed to by the reference field via
 * pointing to this record (optionally filtered by filter, with time periods also specified in
 * filter), not stored in records, non-fillable. Count and date-based values are numbers
 * (consecutive days displayed as "3 days"); sum, average, min, max, and latest are displayed
 * according to field's type (related.ts expandCollection), defaulting to date if field is omitted
 * for latest. Date-based parameters reside in days (sharing the same syntax as number blocks).
 */
export const rollupField: FieldDefinitionOf<'rollup', typeof schema> = defineField({
  type: 'rollup',
  schema,
  label: ['汇总', 'summary of linked entries'],
  read: readNumber,
  format: (f, v, locale) =>
    isSequenceAggregate(f.aggregate)
      ? sequenceText(f.aggregate, f.days?.unit, v as number, locale)
      : formatNumber(v as number, undefined, locale),
  formula: 'number',
  numeric: true,
  inForm: false,
  filter: { is: isNumber, compare: 'number' },
  ai: {
    doc: '{table, via, aggregate: "count"|"sum"|"avg"|"min"|"max"|"latest"|"streak"|"daysSince"|"avgInterval"|"distinctDays", field?, filter? (≤6; a period is an inPeriod condition), days? {date?, unit?, perUnit?, skip? {field, option}}} (computed: sums up the entries of `table` whose link field `via` picks this entry; rule 42)',
  },
  example: {
    id: 'children',
    name: 'Children',
    type: 'rollup',
    table: 'expenses',
    via: 'parent',
    aggregate: 'sum',
    field: 'weight',
  },
});

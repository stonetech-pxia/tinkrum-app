import { z } from 'zod';

import { isValidDate } from '../field-values';
import { localeTag } from '../localization';
import {
  FieldRefSchema,
  IdSchema,
  OffsetAddSchema,
  OffsetUnitSchema,
  boundedText,
} from '../schema-primitives';
import { defineField, isText, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  type: z.literal('dateOffset'),
  /** Base date for offset: date or datetime field of this table, or createdAt / updatedAt. */
  from: FieldRefSchema,
  /** Offset amount (negative for past): fixed integer, or a number field of this record. */
  add: OffsetAddSchema,
  unit: OffsetUnitSchema,
});

const SYSTEM = ['createdAt', 'updatedAt'];

/**
 * D-542: calculated date = 'from' date plus 'add' days or months (taking the last day of the
 * month if exceeding it after month addition). Not stored in records, not fillable (invariant
 * 14), values calculated in data.ts recordValue; supports date display, filtering, sorting,
 * calendar days, and before-due reminders (D-550).
 */
export const dateOffsetField: FieldDefinitionOf<'dateOffset', typeof schema> = defineField({
  type: 'dateOffset',
  schema,
  label: ['算出来的日期', 'computed date'],
  read: () => undefined,
  shown: (_f, raw) => (typeof raw === 'string' && isValidDate(raw) ? raw : undefined),
  format: (_f, v, locale) =>
    locale === 'fr'
      ? new Intl.DateTimeFormat(localeTag(locale)).format(new Date(`${v}T12:00:00`))
      : String(v),
  inForm: false,
  // No 'day' property: like date fields, it has no time component. If specified, recordDay shifts it back by one day according to 'start of day'.
  filter: { is: isText, compare: 'date', period: true },
  check: (f, { collection }) => {
    const problems: string[] = [];
    const from = collection.fields.find((x) => x.id === f.from);
    if (!SYSTEM.includes(f.from) && from?.type !== 'date' && from?.type !== 'datetime')
      problems.push(`from ${f.from} must be a date or datetime field of ${collection.id}`);
    if (typeof f.add === 'string') {
      const add = collection.fields.find((x) => x.id === f.add);
      if (add?.type !== 'number')
        problems.push(`add ${f.add} must be a whole number or a number field of ${collection.id}`);
    }
    return problems.map((message) => ({
      code: 'data',
      message: `${collection.id}.${f.id}: ${message}`,
    }));
  },
  ai: {
    doc: '{from: a date or datetime field (or createdAt), add: a whole number or a number field id, unit: "days"|"months"} (computed, never typed in: from + add days or months, a month end clamps, e.g. an expiry date = start + term in months; shown, filtered (inPeriod, gt / lt, isEmpty), sorted, put on a calendar and watched by when.before like a date)',
  },
  example: { id: 'ends', name: 'Ends', type: 'dateOffset', from: 'date', add: 30, unit: 'days' },
});

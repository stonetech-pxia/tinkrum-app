import { z } from 'zod';

import { isValidDate } from '../field-values';
import { localeTag } from '../localization';
import { defineField, fieldBase, isText, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('date'),
  default: z.literal('today').optional(),
});

/** Date YYYY-MM-DD (device local date); default today = new records are set to today (see D-286 for start of day). */
export const dateField: FieldDefinitionOf<'date', typeof schema> = defineField({
  type: 'date',
  schema,
  label: ['日期', 'date'],
  read: (_f, raw) => (typeof raw === 'string' && isValidDate(raw) ? raw : undefined),
  write: (_f, input) => {
    const s = typeof input === 'string' ? input.trim() : '';
    return isValidDate(s) ? { value: s } : { issue: 'invalid' };
  },
  initial: (f, _now, today) => (f.default === undefined ? undefined : today),
  format: (_f, v, locale) =>
    locale === 'fr'
      ? new Intl.DateTimeFormat(localeTag(locale)).format(new Date(`${v}T12:00:00`))
      : String(v),
  formula: 'date',
  filter: { is: isText, compare: 'date', period: true },
  titleRank: 6,
  ai: { doc: '{default?: "today"}' },
  example: { id: 'date', name: 'Date', type: 'date', default: 'today' },
  exampleValue: '2026-10-27',
});

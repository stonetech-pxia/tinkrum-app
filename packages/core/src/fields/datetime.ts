import { z } from 'zod';

import {
  formatTimestamp,
  isValidDate,
  isValidDateTime,
  localDateTime,
  normalizeTime,
} from '../field-values';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('datetime'),
  default: z.literal('now').optional(),
});

/** YYYY-MM-DDTHH:mm -> milliseconds in local time (for display). */
const localMs = (v: string) => {
  const [y, m, d] = v.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [h, min] = v.slice(11).split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, h, min).getTime();
};

/**
 * D-279: date plus time, stored as device local YYYY-MM-DDTHH:mm (without timezone); default now
 * = new records are set to current time. Filtering and charts use its day (local date); can be
 * used in days(), hours(), and minutes() in formulas (D-280).
 */
export const datetimeField: FieldDefinitionOf<'datetime', typeof schema> = defineField({
  type: 'datetime',
  schema,
  label: ['日期时间', 'date and time'],
  read: (_f, raw) => (typeof raw === 'string' && isValidDateTime(raw) ? raw : undefined),
  write: (_f, input) => {
    // '2026-10-29 08:30', '2026-10-29T08:30', optionally with seconds (not stored).
    const m = typeof input === 'string' ? /^(\S{10})[T ]\s*(.+)$/.exec(input.trim()) : null;
    const time = m ? normalizeTime(m[2]!) : undefined;
    const value = m && time ? `${m[1]}T${time}` : '';
    return isValidDateTime(value) ? { value } : { issue: 'invalid' };
  },
  initial: (f, now) => (f.default === undefined ? undefined : localDateTime(now)),
  format: (_f, v, locale) => formatTimestamp(localMs(v as string), locale),
  csv: (_f, v) => String(v).replace('T', ' '),
  formula: 'datetime',
  filter: {
    // A date (any time on that day counts) or a datetime (exact moment).
    is: (_f, v) => typeof v === 'string' && (isValidDate(v) || isValidDateTime(v)),
    compare: 'date',
    period: true,
  },
  day: (_f, v) => String(v).slice(0, 10),
  titleRank: 7,
  ai: { doc: '{default?: "now"} (a date with a time of day; rule 40)' },
  example: { id: 'when', name: 'When', type: 'datetime', default: 'now' },
  exampleValue: '2026-10-27T21:45',
});

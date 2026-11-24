import { z } from 'zod';

import { isValidTime, normalizeTime } from '../field-values';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

const schema = z.strictObject({ ...fieldBase, type: z.literal('time') });

const readTime = (_f: unknown, raw: unknown) =>
  typeof raw === 'string' && isValidTime(raw) ? raw : undefined;

/** D-279: Hours and minutes in HH:mm format (without date). In formulas, hours/minutes automatically add 24 hours when crossing midnight (D-280). */
export const timeField: FieldDefinitionOf<'time', typeof schema> = defineField({
  type: 'time',
  schema,
  label: ['时间', 'time'],
  read: readTime,
  write: (_f, input) => {
    const time = typeof input === 'string' ? normalizeTime(input) : undefined;
    return time ? { value: time } : { issue: 'invalid' };
  },
  // Always displayed as 08:30 across all three languages (French also uses 24-hour format and colon).
  format: (_f, v) => String(v),
  formula: 'time',
  filter: { is: (_f, v) => readTime(_f, v) !== undefined, compare: 'time' },
  ai: { doc: '(a time of day "HH:mm"; rule 40)' },
  example: { id: 'start', name: 'Start', type: 'time' },
  exampleValue: '08:30',
});

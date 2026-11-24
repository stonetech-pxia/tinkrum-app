import { z } from 'zod';

import { formatNumber } from '../field-values';
import { boundedText } from '../schema-primitives';
import {
  defineField,
  fieldBase,
  isNumber,
  rangeKeys,
  rangeProblems,
  numberWithUnit,
  readNumber,
  writeNumber,
  type FieldDefinitionOf,
} from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('number'),
  decimals: z.number().int().min(0).max(4).optional(),
  unit: boundedText(1, 10).optional(),
  default: z.number().finite().optional(),
  ...rangeKeys,
});

/** Number, can have decimal places and units. */
export const numberField: FieldDefinitionOf<'number', typeof schema> = defineField({
  type: 'number',
  schema,
  label: ['数字', 'number'],
  read: readNumber,
  write: (f, input) => writeNumber(input, f.decimals ?? 4),
  format: (f, v, locale) => numberWithUnit(v as number, f, locale),
  csv: (_f, v) => String(v),
  formatAmount: (f, n, locale) => numberWithUnit(n, f, locale),
  print: {
    numeric: true,
    total: { rank: 2, format: (f, sum, locale) => formatNumber(sum, f.decimals, locale) },
  },
  formula: 'number',
  numeric: true,
  filter: { is: isNumber, compare: 'number' },
  titleRank: 4,
  convertGroup: 'number',
  check: (f, { collection }) => rangeProblems(f, collection.id),
  ai: { doc: '{decimals? 0-4, unit?, default?, min?, max?}' },
  example: { id: 'weight', name: 'Weight', type: 'number', decimals: 1, unit: 'kg' },
  exampleValue: 2.5,
});

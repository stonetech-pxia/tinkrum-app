import { z } from 'zod';

import { t } from '../messages';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('checkbox'),
  default: z.boolean().optional(),
});

/** Checkbox: yes or no; unchecked by default for new records. */
export const checkboxField: FieldDefinitionOf<'checkbox', typeof schema> = defineField({
  type: 'checkbox',
  schema,
  label: ['勾选', 'checkbox'],
  read: (_f, raw) => (typeof raw === 'boolean' ? raw : undefined),
  write: (_f, input) => (typeof input === 'boolean' ? { value: input } : { issue: 'invalid' }),
  emptyNew: false,
  format: (_f, v, locale) => (v ? t(locale, 'data_Yes_1f54e') : t(locale, 'data_No_04a4b')),
  filter: { is: (_f, v) => typeof v === 'boolean' },
  // D-569: checked is 1 in formulas, unchecked is 0; old records without stored values display as unchecked and also count as 0.
  formula: 'number',
  formulaNumber: (_f, v) => (v === true ? 1 : 0),
  ai: { doc: '{default?}' },
  example: { id: 'done', name: 'Done', type: 'checkbox' },
  exampleValue: true,
});

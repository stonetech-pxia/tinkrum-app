import { z } from 'zod';

import { t } from '../messages';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('checkbox'),
  default: z.boolean().optional(),
});

/** 勾选：是或否；新记录没勾选就是否。 */
export const checkboxField: FieldDefinitionOf<'checkbox', typeof schema> = defineField({
  type: 'checkbox',
  schema,
  label: ['勾选', 'checkbox'],
  read: (_f, raw) => (typeof raw === 'boolean' ? raw : undefined),
  write: (_f, input) => (typeof input === 'boolean' ? { value: input } : { issue: 'invalid' }),
  emptyNew: false,
  format: (_f, v, locale) => (v ? t(locale, 'data_Yes_1f54e') : t(locale, 'data_No_04a4b')),
  filter: { is: (_f, v) => typeof v === 'boolean' },
  // D-569：公式里勾了是 1，没勾是 0；没存过值的旧记录显示为没勾，也算 0。
  formula: 'number',
  formulaNumber: (_f, v) => (v === true ? 1 : 0),
  ai: { doc: '{default?}' },
  example: { id: 'done', name: 'Done', type: 'checkbox' },
  exampleValue: true,
});

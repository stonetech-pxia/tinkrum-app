import { z } from 'zod';

import { FieldRefSchema, IdSchema, boundedText } from '../schema-primitives';
import { defineField, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  type: z.literal('previous'),
  field: IdSchema,
  date: FieldRefSchema.optional(),
  within: IdSchema.optional(),
});

/**
 * D-289: Previous entry. Within the same table and group (within: a single-select or reference
 * field, defaults to the entire table; distinct from grouping blocks), ordered by date (date,
 * defaulting to the first date field, failing that the first datetime field, then creation time)
 * prior to this current entry, returning the field value of the entry where field has a value.
 * Not stored in records, non-fillable; displayed according to field's type, computes differences
 * in formulas (mileage between fill-ups).
 */
export const previousField: FieldDefinitionOf<'previous', typeof schema> = defineField({
  type: 'previous',
  schema,
  label: ['上一条的值', 'value of the previous entry'],
  read: () => undefined,
  format: () => '',
  inForm: false,
  filter: { is: () => false, emptyOnly: true },
  sort: false,
  ai: {
    doc: '{field, date?, within?} (computed: the value of `field` on the entry just before this one by date in the same table, or in the same group when `within` names a choice or link field; rule 42)',
  },
  example: { id: 'before', name: 'Before', type: 'previous', field: 'weight' },
});

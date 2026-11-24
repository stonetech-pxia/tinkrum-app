import { z } from 'zod';

import { IdSchema, boundedText } from '../schema-primitives';
import { defineField, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  type: z.literal('lookup'),
  via: IdSchema,
  field: IdSchema,
});

/**
 * D-287: Lookup. Retrieves the field value from the record pointed to by this record's reference
 * field (via), not stored in records, non-fillable. Display, filtering, sorting, formulas, and
 * statistics follow that field's type (related.ts expandCollection converts it to that field
 * type); empty when there is no reference, the referenced record is deleted, or that field has no
 * value. Callbacks here are only used when definitions mismatch (can only check if a value
 * exists).
 */
export const lookupField: FieldDefinitionOf<'lookup', typeof schema> = defineField({
  type: 'lookup',
  schema,
  label: ['查找', 'value from a linked entry'],
  read: () => undefined,
  format: () => '',
  inForm: false,
  filter: { is: () => false, emptyOnly: true },
  sort: false,
  ai: {
    doc: '{via, field} (computed, never typed in: the value of field `field` of the entry that the link field `via` of this table picks, shown, filtered, sorted and usable in formulas and stats like that field; rule 42)',
  },
  example: {
    id: 'looked',
    name: 'Looked up',
    type: 'lookup',
    via: 'parent',
    field: 'weight',
  },
});

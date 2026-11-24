import { z } from 'zod';

import { FILE_ID } from '../field-values';
import { t } from '../messages';
import { IdSchema } from '../schema-primitives';
import { defineField, fieldBase, isText, type FieldDefinitionOf } from './define';

const schema = z.strictObject({ ...fieldBase, type: z.literal('link'), table: IdSchema });

const isRecordId = (v: unknown): v is string => typeof v === 'string' && FILE_ID.test(v);

/**
 * D-250: References a record in another table (or the same table); value is the ID of that
 * record, and its title field is displayed in lists. Displays "Deleted record" if the referenced
 * record has been deleted; can only check whether one is selected, cannot be sorted by.
 */
export const linkField: FieldDefinitionOf<'link', typeof schema> = defineField({
  type: 'link',
  schema,
  label: ['引用', 'link to another table'],
  read: (_f, raw) => (isRecordId(raw) ? raw : undefined),
  write: (_f, input) => (isRecordId(input) ? { value: input } : { issue: 'invalid' }),
  format: (f, v, locale, links) =>
    links ? (links(f.table, v as string) ?? t(locale, 'linkDeleted')) : '',
  filter: { is: isText, emptyOnly: true },
  sort: false,
  // D-250: The referenced table must exist.
  check: (f, { config, collection }) =>
    config.data.tables.some((c) => c.id === f.table)
      ? []
      : [
          {
            code: 'data',
            message: `${collection.id}.${f.id}: links to missing table ${f.table}`,
          },
        ],
  ai: {
    doc: "{table} (picks one entry of another table, or of the same table; lists show that entry's first text field)",
    docAfter: 'formula',
  },
  example: { id: 'parent', name: 'Parent', type: 'link', table: 'expenses' },
  exampleValue: 'r1',
});

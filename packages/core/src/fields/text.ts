import { z } from 'zod';

import { boundedText } from '../schema-primitives';
import { defineField, fieldBase, isText, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('text'),
  default: boundedText(1, 200).optional(),
  /** Phone, email, url (D-422): Still text fields, but with optimized input keyboards, and record page buttons can open them (D-428); format is not validated upon saving. */
  format: z.enum(['phone', 'email', 'url']).optional(),
});

export type TextFormat = NonNullable<z.infer<typeof schema>['format']>;

/** A single line of text (maximum 200 characters). */
export const textField: FieldDefinitionOf<'text', typeof schema> = defineField({
  type: 'text',
  schema,
  label: ['文字', 'text'],
  read: (_f, raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined),
  write: (_f, input) => {
    if (typeof input !== 'string') return { issue: 'invalid' };
    const s = input.trim();
    return s.length > 200 ? { issue: 'tooLong' } : { value: s };
  },
  format: (_f, v) => String(v),
  filter: { is: isText, contains: true },
  titleRank: 1,
  convertGroup: 'text',
  ai: {
    doc: '{default?, format?: "phone"|"email"|"url"} (≤200 chars; format adds the matching keyboard and lets the buttons of the recordRow of the table open the value (rule 54))',
  },
  example: { id: 'title', name: 'Title', type: 'text', required: true },
  exampleValue: 'Lunch',
});

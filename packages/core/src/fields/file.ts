import { z } from 'zod';

import { FILE_ID, MAX_ATTACHMENTS } from '../field-values';
import { t } from '../messages';
import { defineField, fieldBase, isText, type FieldDefinitionOf } from './define';

const schema = z.strictObject({ ...fieldBase, type: z.literal('file') });

const isFileId = (v: unknown): v is string => typeof v === 'string' && FILE_ID.test(v);

/** Removes duplicate IDs while preserving the order of their first appearance. */
const unique = (ids: readonly string[]) => [...new Set(ids)];

/**
 * D-187, D-263: Attachments, value is a group of file IDs in Morph (ordered, max 20). Photos and
 * files selected by the user in forms, and receipts stored by the "Log an expense" quick action,
 * are placed here. Lenient reading: single IDs in old data are treated as a group with a single
 * file; invalid IDs and those exceeding the limit are not displayed; writes always write as a
 * group.
 */
export const fileField: FieldDefinitionOf<'file', typeof schema> = defineField({
  type: 'file',
  schema,
  label: ['附件', 'attachment'],
  read: (_f, raw) => {
    const ids = isFileId(raw)
      ? [raw]
      : Array.isArray(raw)
        ? unique(raw.filter(isFileId)).slice(0, MAX_ATTACHMENTS)
        : [];
    return ids.length > 0 ? ids : undefined;
  },
  write: (_f, input) => {
    const list: unknown[] = Array.isArray(input) ? input : [input];
    if (!list.every(isFileId)) return { issue: 'invalid' };
    const ids = unique(list as string[]);
    if (ids.length > MAX_ATTACHMENTS) return { issue: 'tooLong' };
    return { value: ids };
  },
  format: (_f, v, locale) => t(locale, 'data_attachments', { n: Array.isArray(v) ? v.length : 1 }),
  // is / isNot: whether this file exists.
  filter: { is: isText },
  // Sort by file count.
  sort: (_f, v) => (Array.isArray(v) ? v.length : 0),
  ai: {
    doc: '(attachments: up to 20 photos or files per entry; the user takes or picks them in the entry forms, and out.addRecord puts the file it saves here)',
  },
  example: { id: 'receipt', name: 'Receipt', type: 'file' },
  exampleValue: ['asset1'],
});

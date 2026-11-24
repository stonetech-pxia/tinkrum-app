import { MAX_ATTACHMENTS, attachmentIds } from './field-values';
import { FREE_NOTE } from './prefill/code-rules';
import type { Collection } from './schema';

// Which field to put files into, which field to put text into: first attachment field; first long
// text field, or first text field if none. Pure rules: which field to put into, how many more can
// be added, what to prefill when form opens. Record selection, file storage, and database writes
// happen in the app; the form is confirmed by the user.

/** Which field to put files into, which field to put text into: first attachment field; first long text field, or first text field if none. */
export function recordTargets(collection: Collection) {
  return {
    fileField: collection.fields.find((f) => f.type === 'file')?.id,
    textField: (
      collection.fields.find((f) => f.type === 'note') ??
      collection.fields.find((f) => f.type === 'text')
    )?.id,
  };
}

/**
 * Which field to put spoken text verbatim (D-575) into: long text field, or text field named
 * "Notes" etc. if no long text field, and only as a last resort the first text field. The first
 * text field of a receipt table is "Merchant"; putting the whole sentence there would force the
 * user to delete it (D-576).
 */
export function spokenTextTarget(collection: Collection): string | undefined {
  return (
    collection.fields.find((f) => f.type === 'note') ??
    collection.fields.find((f) => f.type === 'text' && FREE_NOTE.test(f.name.trim())) ??
    collection.fields.find((f) => f.type === 'text')
  )?.id;
}

/** How many more files can be added to the attachment fields of this record; 0 if there are no attachment fields in the table. */
export function attachRoom(collection: Collection, values: Readonly<Record<string, unknown>>) {
  const { fileField } = recordTargets(collection);
  if (fileField === undefined) return 0;
  return Math.max(0, MAX_ATTACHMENTS - attachmentIds(values[fileField]).length);
}

/**
 * When appending items to an existing record, fields to modify when the form opens (containing
 * only changed ones): files are appended after existing ones, without duplication and within
 * limits; text is written if the field is empty (or blank), otherwise appended on a new line
 * leaving existing text untouched.
 */
export function appendPrefill(
  collection: Collection,
  values: Readonly<Record<string, unknown>>,
  add: { fileIds?: readonly string[]; text?: string },
): Record<string, unknown> {
  const { fileField, textField } = recordTargets(collection);
  const out: Record<string, unknown> = {};
  if (fileField !== undefined && add.fileIds && add.fileIds.length > 0) {
    const existing = attachmentIds(values[fileField]);
    const merged = [...existing];
    for (const id of add.fileIds)
      if (merged.length < MAX_ATTACHMENTS && !merged.includes(id)) merged.push(id);
    if (merged.length > existing.length) out[fileField] = merged;
  }
  if (textField !== undefined && add.text !== undefined && add.text.trim() !== '') {
    const old = values[textField];
    out[textField] =
      typeof old === 'string' && old.trim() !== ''
        ? `${old.replace(/\n+$/, '')}\n${add.text}`
        : add.text;
  }
  return out;
}

import { formatValue, type DataRecord } from './data';
import { MAX_ATTACHMENTS, attachmentIds } from './field-values';
import { mediaKindOf } from './media';
import type { Collection, Field, Locale } from './schema';
import {
  FILE_VALUE_TYPES,
  actionAccepts,
  handedFileTypeOf,
  type ActionDefinition,
  type HandedFileType,
} from './workflow/contract';

// Containers pass record fields to tools (D-428, D-442): text fields pass their displayed text,
// while attachment fields pass their contained files. Pure function: determines which fields pass
// what content and which files are accepted by the first step. File copying (into the temporary
// directory for this run) is handled by the app. Once handed over, the workflow has no knowledge of
// which record these values originated from (external run: results do not feed back to the source).

/** Fields that can be handed over as text: stored values that display as text text strings. Computed fields, references, and checkboxes are excluded. */
const TEXT_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'note',
  'number',
  'money',
  'date',
  'datetime',
  'time',
  'duration',
  'rating',
  'choice',
  'tags',
]);

/** Determine what type of input this field can pass to the first step: text, files, or nothing. */
export function fieldHandsTo(field: Field): 'text' | 'files' | null {
  if (field.type === 'file') return 'files';
  return TEXT_FIELDS.has(field.type) ? 'text' : null;
}

/** Text handed over: the field's displayed representation with leading and trailing whitespace trimmed; empty values yield an empty string. */
export function fieldHandedText(field: Field, raw: unknown, locale: Locale): string {
  if (fieldHandsTo(field) !== 'text') return '';
  if (field.type === 'text' || field.type === 'note')
    return typeof raw === 'string' ? raw.trim() : '';
  return raw === undefined || raw === null ? '' : formatValue(field, raw, locale).trim();
}

/** Maximum number of attachments handed over at once: matches the maximum capacity of an attachment field (D-263). */
export const HANDED_FILES_MAX = MAX_ATTACHMENTS;

/** Metadata for a single attachment (from a user file record); file content is not stored here. */
export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Attachments handed over to the first step (triggered by tapping the button): contains only file
 * IDs; copies are instantiated in the run's temporary directory when execution begins. name
 * serves as the field name and provides the title for the run page.
 */
export interface HandedFiles {
  type: 'attachments';
  fileType: HandedFileType;
  assetIds: string[];
  name: string;
}

/** Determine the file type of an attachment: inspects MIME type first, falling back to the filename if ambiguous (octet-stream). */
export function attachmentType(info: Pick<AttachmentInfo, 'name' | 'mimeType'>): HandedFileType {
  switch (mediaKindOf(info.mimeType, info.name)) {
    case 'image':
      return 'images';
    case 'pdf':
      return 'pdf';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'zip':
      return 'zip';
    default:
      return 'files';
  }
}

/**
 * Select attachments accepted by the first step, preserving attachment order. If the first step
 * accepts any file (files), all are passed and the value type matches their common type (pdf if
 * all are PDF, files if mixed); if specific types are accepted, only matching files are passed,
 * resolving mixed selections to the highest-priority type in FILE_VALUE_TYPES. Returns null when
 * none are accepted, hiding the button.
 */
export function pickHandedFiles(
  action: ActionDefinition,
  infos: readonly AttachmentInfo[],
): { fileType: HandedFileType; assetIds: string[] } | null {
  const typed = infos
    .map((info) => ({ id: info.id, type: attachmentType(info) }))
    .filter((x) => actionAccepts(action, x.type));
  if (typed.length === 0) return null;
  const present = new Set(typed.map((x) => x.type));
  if (present.size === 1) return { fileType: typed[0]!.type, assetIds: typed.map((x) => x.id) };
  if (handedFileTypeOf(action) === 'files')
    return { fileType: 'files', assetIds: typed.map((x) => x.id) };
  const fileType = FILE_VALUE_TYPES.find((t) => present.has(t))!;
  return { fileType, assetIds: typed.filter((x) => x.type === fileType).map((x) => x.id) };
}

/** Attachment field for this table: uses the specified field ID if provided (must be an attachment field); defaults to the first attachment field otherwise. */
export function attachmentField(table: Collection, fieldId?: string): Field | undefined {
  return table.fields.find((f) => f.type === 'file' && (fieldId === undefined || f.id === fieldId));
}

/** File IDs from the first attachment field across a batch of records, ordered by record and attachment sequence, with duplicates removed. */
export function attachmentIdsOfRecords(
  table: Collection,
  records: readonly DataRecord[],
): string[] {
  const field = attachmentField(table);
  if (!field) return [];
  const ids = new Set<string>();
  for (const record of records)
    for (const id of attachmentIds(record.values[field.id])) ids.add(id);
  return [...ids];
}

/**
 * Attachments for record blocks (single or list) handed over to quick actions whose first step
 * accepts files: files accepted by the first step from the table's first attachment field for
 * these records. infos contains pre-fetched file metadata (retrieved by the app via
 * attachmentIdsOfRecords); missing files (already deleted) are excluded.
 */
export function handedFilesFor(
  action: ActionDefinition,
  table: Collection,
  records: readonly DataRecord[],
  infos: ReadonlyMap<string, AttachmentInfo>,
): HandedFiles | null {
  const field = attachmentField(table);
  if (!field) return null;
  const known = attachmentIdsOfRecords(table, records).flatMap((id) => {
    const info = infos.get(id);
    return info ? [info] : [];
  });
  const picked = pickHandedFiles(action, known);
  return picked ? { type: 'attachments', ...picked, name: field.name } : null;
}

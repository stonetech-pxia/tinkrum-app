import { fieldLink } from './field-link';
import {
  fieldHandedText,
  fieldHandsTo,
  pickHandedFiles,
  type AttachmentInfo,
  type HandedFiles,
} from './handed';
import { attachmentIds } from './field-values';
import type { Registry } from './registry';
import { findWorkflowTarget } from './workflows/presets';
import type { Collection, Field, Locale, QuickAction, Workflow } from './schema';
import { handedInput } from './workflow/check';
import type { DataRecord } from './data';
import type { RunValue } from './workflow/engine';

// A row of buttons at the top of the record page (D-428, replacing the hardcoded row in D-423):
// data.tables[].recordRow defines which ones exist, and current values determine which are usable.
// Pure function: read-only when viewing, runs only upon tap (invariants 10, 15). Independent of
// table type, based solely on config, actions, and field formats.

export interface RecordRowButton {
  key: string;
  workflow: Workflow;
  /** Pass the value of this field. Omitted: pass this record. */
  field?: Field;
  /** Field value (quick action receiving text). */
  text?: string;
  /** Files received in the first step within an attachment field (file-receiving quick action, D-442): contains file IDs only, copied at runtime. */
  files?: { fileType: HandedFiles['fileType']; assetIds: string[] };
  /** The same quick action appears more than once (two phone fields): button must display the field name to distinguish them. */
  showField: boolean;
}

/**
 * Buttons whose values are empty, mismatched (fieldLink), or where the record cannot use the
 * action (cannot generate vCard) do not appear. assets: file metadata for this record's
 * attachments (read by App via file ID); file-receiving buttons rely on it to recognize which
 * attachments were received in step 1. If not read (still loading, file gone), they are not
 * passed, so the button does not appear.
 */
export function recordRowButtons(
  table: Collection,
  quickActions: readonly QuickAction[],
  registry: Registry,
  locale: Locale,
  values: Readonly<Record<string, unknown>>,
  assets: ReadonlyMap<string, AttachmentInfo> = new Map(),
): RecordRowButton[] {
  const row = table.recordRow ?? [];
  const buttons: RecordRowButton[] = [];
  for (const item of row) {
    const workflow = findWorkflowTarget(quickActions, item.tool, locale);
    if (!workflow) continue;
    const takes = handedInput(workflow.steps, registry);
    const actions = workflow.steps.map((s) => registry.actions.get(s.action));
    const key = `${item.tool}${item.field ? `-${item.field}` : ''}`;
    if (takes === 'records') {
      const first = actions[0];
      if (first?.recordFits && !first.recordFits(table.fields, values)) continue;
      buttons.push({ key, workflow, showField: false });
    } else if (takes === 'text') {
      const field = table.fields.find((f) => f.id === item.field);
      if (!field || fieldHandsTo(field) !== 'text') continue;
      const text = fieldHandedText(field, values[field.id], locale);
      if (text === '') continue;
      const opens = actions.find((a) => a?.opensLink)?.opensLink;
      if (opens && !linkFits(field, text, opens)) continue;
      buttons.push({
        key,
        workflow,
        field,
        text,
        showField: row.filter((other) => other.tool === item.tool).length > 1,
      });
    } else if (takes === 'files') {
      const field = table.fields.find((f) => f.id === item.field);
      if (!field || fieldHandsTo(field) !== 'files') continue;
      const infos = attachmentIds(values[field.id]).flatMap((id) => {
        const info = assets.get(id);
        return info ? [info] : [];
      });
      const files = pickHandedFiles(actions[0]!, infos);
      if (!files) continue;
      buttons.push({
        key,
        workflow,
        field,
        files,
        showField: row.filter((other) => other.tool === item.tool).length > 1,
      });
    }
  }
  return buttons;
}

/** Whether this field's value can be opened as this type of link: determined solely by fieldLink (D-422). */
function linkFits(
  field: Field,
  value: string,
  opens: 'phone' | 'message' | 'email' | 'url',
): boolean {
  const link = fieldLink(field, value, opens === 'message' ? 'message' : undefined);
  return link?.kind === opens;
}

/** Passes the value to the first step. record: the current record, values are already current box values (including unsaved edits). */
export function recordRowValue(
  button: RecordRowButton,
  table: Collection,
  record: DataRecord,
): RunValue | HandedFiles {
  if (button.files)
    return { type: 'attachments', ...button.files, name: button.field?.name ?? table.name };
  if (button.text !== undefined) {
    return { type: 'text', text: button.text.trim(), name: button.field?.name ?? table.name };
  }
  return recordsValue(table, [record]);
}

/** One or more records as tool input: single record blocks and lists all use this (invariant 17: passes precisely what is seen). */
export const recordsValue = (table: Collection, records: DataRecord[]): RunValue => ({
  type: 'records',
  collectionId: table.id,
  records,
  name: table.name,
});

/**
 * Cases that run inline on the record page without opening the run page (D-428): a value or
 * record, with the final step handed off outside the app (phone dialer, share sheet). No results
 * to view in these cases. Others (many records, results staying in Tinkrum) open the run page to
 * view progress and results. This is separate from "write results back to source": Tinkrum has no
 * execution mode writing results back to source fields; both are external execution (results
 * leave, do not return to source).
 */
export function runsInline(workflow: Workflow, value: RunValue | HandedFiles): boolean {
  // Files must be copied into the temporary run directory first and may be large: always open the run page to view progress and results.
  if (value.type === 'attachments') return false;
  const small = value.type === 'text' || (value.type === 'records' && value.records.length === 1);
  return small && /^out\./.test(workflow.steps[workflow.steps.length - 1]?.action ?? '');
}

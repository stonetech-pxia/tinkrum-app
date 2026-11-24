import type { Registry } from '../registry';
import type { Collection, QuickAction, WorkspaceConfig } from '../schema';
import { handedValueType } from './check';
import { outputTypeOf, type ValueType } from './contract';

// Where configuration is referenced in step parameters (CHAIN_AUDIT A3, founder 2026-10-31).
// ParamField.kind in action directories is the declaration: collection = ID of a table; fields =
// list of field IDs in a table (that table when the current step has a collection parameter,
// otherwise the table containing the incoming record). Checks (validate.ts) and cleanup during
// table/field deletion (ops.ts) are identical for all actions; any action using tables or fields
// only needs to declare it in the directory without modifying these two places.

/** Built-in record fields, not part of the table schema. */
const BUILT_IN_FIELDS = new Set(['createdAt', 'updatedAt']);

export interface StepRef {
  /** Step index. */
  index: number;
  /** Parameter name. */
  key: string;
  table: string;
  /** When referencing a field: field ID (built-in createdAt / updatedAt excluded). */
  field?: string;
  /** Collection parameter declares receives: this step stores the incoming value into this table. */
  receives?: ValueType | null;
}

/** Tables and fields referenced by a quick action's step parameters. */
export function stepRefs(wf: QuickAction, registry: Registry): StepRef[] {
  const refs: StepRef[] = [];
  let value: ValueType | null = handedValueType(wf.steps, registry);
  // Table containing the incoming record (established by the read-record step and preserved down the chain).
  let recordsTable: string | null = null;
  for (const [index, step] of wf.steps.entries()) {
    const action = registry.actions.get(step.action);
    if (!action) {
      value = null;
      recordsTable = null;
      continue;
    }
    let own: string | null = null;
    for (const f of action.fields) {
      const v = step.params[f.key];
      if (f.kind !== 'collection' || typeof v !== 'string') continue;
      if (f.bindsInput || action.fields.filter((p) => p.kind === 'collection').length === 1)
        own = v;
      refs.push({ index, key: f.key, table: v, ...(f.receives ? { receives: value } : {}) });
    }
    for (const f of action.fields) {
      const v = step.params[f.key];
      const table =
        (f.collectionKey ? step.params[f.collectionKey] : undefined) ?? own ?? recordsTable;
      if (f.kind !== 'fields' || !Array.isArray(v) || typeof table !== 'string') continue;
      for (const id of v)
        if (typeof id === 'string' && !BUILT_IN_FIELDS.has(id))
          refs.push({ index, key: f.key, table, field: id });
    }
    const next = outputTypeOf(action, step.params, value);
    if (next !== 'records') recordsTable = null;
    else if (own !== null) recordsTable = own;
    value = next;
  }
  return refs;
}

/**
 * Tables referenced by steps must exist, and fields must belong to that table (D-042); steps
 * storing values into tables (log an entry, D-187) must have appropriate fields: text requires
 * long text or text fields, files require attachment fields.
 */
export function stepRefProblems(
  wf: QuickAction,
  config: WorkspaceConfig,
  registry: Registry,
): string[] {
  const problems: string[] = [];
  let recordsTable: string | null = null;
  for (const step of wf.steps) {
    const action = registry.actions.get(step.action);
    if (!action) continue;
    const binding = action.fields.find((f) => f.bindsInput);
    const bound = binding ? step.params[binding.key] : undefined;
    if (typeof bound === 'string') {
      if (recordsTable && recordsTable !== bound)
        problems.push(`${wf.id}/${step.id}: input table must be ${recordsTable}, not ${bound}`);
      recordsTable = bound;
    }
    for (const f of action.fields) {
      const named = step.params[f.key];
      if (f.kind !== 'fields' || !Array.isArray(named) || !named.length) continue;
      const tableId = (f.collectionKey ? step.params[f.collectionKey] : undefined) ?? recordsTable;
      if (typeof tableId !== 'string') {
        problems.push(
          `${wf.id}/${step.id}: ${f.key} must be empty: the records are handed over by the container, so the table is not known here (empty = all fields)`,
        );
        continue;
      }
      const table = config.data.tables.find((t) => t.id === tableId);
      for (const id of named) {
        const field = table?.fields.find((p) => p.id === id);
        if (f.textFormat && field && (field.type !== 'text' || field.format !== f.textFormat))
          problems.push(`${wf.id}/${step.id}: ${String(id)} needs format ${f.textFormat}`);
        if (field && f.fieldTypes && !f.fieldTypes.includes(field.type))
          problems.push(`${wf.id}/${step.id}: ${String(id)} has the wrong field type for ${f.key}`);
      }
    }
    const next = outputTypeOf(action, step.params, 'records');
    if (next !== 'records') recordsTable = null;
    else if (!recordsTable) {
      const source = action.fields.find((f) => f.kind === 'collection' && !f.receives);
      const id = source && step.params[source.key];
      if (typeof id === 'string') recordsTable = id;
    }
  }
  for (const ref of stepRefs(wf, registry)) {
    const at = `${wf.id}/${wf.steps[ref.index]!.id}`;
    const table = config.data.tables.find((c) => c.id === ref.table);
    if (!table) {
      if (ref.field === undefined) problems.push(`${at}: data table ${ref.table} does not exist`);
      continue;
    }
    if (ref.field !== undefined) {
      if (!table.fields.some((f) => f.id === ref.field))
        problems.push(`${at}: ${ref.field} is not a field of ${table.id}`);
      continue;
    }
    const missing = missingPlace(table, ref.receives);
    if (missing) problems.push(`${at}: ${table.id} needs ${missing}`);
  }
  return problems;
}

/** Steps storing values into tables: describe what field is missing when the table lacks one for this value; null when complete (or if this step does not store values). */
export function missingPlace(
  table: Collection,
  value: ValueType | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  if (value === 'text')
    return table.fields.some((f) => f.type === 'note' || f.type === 'text')
      ? null
      : 'a text or long text field for the text';
  return table.fields.some((f) => f.type === 'file')
    ? null
    : 'an attachment (file) field for the files';
}

/** Entry points must provide the table bound to the quick action. */
export function handedRecordProblems(
  wf: QuickAction,
  tableId: string | undefined,
  registry: Registry,
): string[] {
  const problems: string[] = [];
  for (const step of wf.steps) {
    const action = registry.actions.get(step.action);
    for (const f of action?.fields ?? []) {
      const id = step.params[f.key];
      if (f.bindsInput && typeof id === 'string' && id !== tableId)
        problems.push(`${wf.id}: input table must be ${id}, not ${tableId ?? 'unknown'}`);
    }
  }
  return problems;
}

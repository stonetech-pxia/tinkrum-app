import type { Registry } from '../registry';
import type { Collection, QuickAction, WorkspaceConfig } from '../schema';
import { handedValueType } from './check';
import { outputTypeOf, type ValueType } from './contract';

// 步骤参数里引用配置的地方（CHAIN_AUDIT A3，创始人 2026-10-31）。动作目录的 ParamField.kind 就是声明：
// collection = 一张表的 ID；fields = 一张表的字段 ID 列表（同一步有 collection 参数时是那张表，
// 否则是传进来的记录所在的表）。检查（validate.ts）和删表、删字段时的清理（ops.ts）对所有动作都一样，
// 加一个用到表或字段的动作只要在目录里声明，不用改这两处。

/** 记录自带的字段，不在表结构里。 */
const BUILT_IN_FIELDS = new Set(['createdAt', 'updatedAt']);

export interface StepRef {
  /** 第几步。 */
  index: number;
  /** 参数名。 */
  key: string;
  table: string;
  /** 引用字段时：字段 ID（记录自带的 createdAt / updatedAt 不算）。 */
  field?: string;
  /** collection 参数声明了 receives：这一步把传进来的值存进这张表。 */
  receives?: ValueType | null;
}

/** 一个快捷操作的步骤参数引用的表和字段。 */
export function stepRefs(wf: QuickAction, registry: Registry): StepRef[] {
  const refs: StepRef[] = [];
  let value: ValueType | null = handedValueType(wf.steps, registry);
  // 传进来的记录所在的表（读取记录那一步定下，原样往下传的步骤保持）。
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
 * 步骤引用的表要存在、字段要是那张表的（D-042）；把值存进表的步骤（记一笔，D-187），表里要有放它的字段：
 * 文字要有长文本或文字字段，文件要有附件字段。
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

/** 把值存进表的步骤：表里缺放这个值的字段时，说缺什么；不缺（或这一步不存值）时为 null。 */
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

/** 入口必须给出快捷操作绑定的表。 */
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

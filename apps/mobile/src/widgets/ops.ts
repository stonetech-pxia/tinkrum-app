import {
  RECORD_LIMITS,
  allComponents,
  createInput,
  isKnownComponent,
  isRecordToolUse,
  prepareRecordValues,
  recordToolOf,
  rowUpdateInput,
  tapAlsoOf,
  toolReadsEntry,
  type Calendar,
  type Collection,
  type Component,
  type DataRecord,
  type RecordTool,
  type RecordToolUse,
  type ToolUse,
  type WorkspaceConfig,
} from '@morph/core';

import type { WidgetOpRef } from './types';

// Tools executable on widgets (D-321): "Create entry" on buttons and individual tile taps (create,
// set value, check, increment/decrement). Filtered batch changes (setAll) require confirmation, and
// "Open form" requires the UI; both open the app when tapped on a widget. The same algorithm is
// used both to precalculate post-tap rendering states (on in-memory records) and to execute them
// (when the app claims the queue).

/** Records grouped by table (read-only). */
export type RecordsByTable = ReadonlyMap<string, readonly DataRecord[]>;

/** One-tap record tools directly executable on widgets: direct creation, set value, check, and increment/decrement. */
type WidgetTool = Exclude<RecordTool, { do: 'setAll' | 'createAll' | 'remove' }>;

/** Tool definition fingerprint: if the page is modified (tool changed), previously tapped actions are no longer executed. */
export function actionHash(action: ToolUse): string {
  const text = JSON.stringify(action);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function findComponent(config: WorkspaceConfig, id: string): Component | undefined {
  for (const page of config.containers.pages) {
    const c = allComponents(page).find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

/**
 * Tools directly executable on widgets (form creation requires user input, setAll requires
 * confirmation, "open" requires the UI). Reading fields from "this entry" (copying, calculating
 * from its date, adding its number—D-565) also opens the app: widgets only store values, not
 * computed results.
 */
function widgetTool(use: ToolUse | undefined): WidgetTool | undefined {
  if (!use || !isRecordToolUse(use)) return undefined;
  const tool = recordToolOf(use);
  if (
    tool.do === 'setAll' ||
    tool.do === 'createAll' ||
    // Deletion (D-610) is restricted to tile grids and triggers undo; not supported on widgets.
    tool.do === 'remove' ||
    (tool.do === 'create' && tool.ask !== undefined)
  )
    return undefined;
  if (toolReadsEntry(tool)) return undefined;
  // Tapping once to make multiple changes (D-566) requires an undo banner, which widgets do not support: opens the app instead.
  if (tapAlsoOf(use).length > 0) return undefined;
  return tool;
}

/** Whether a button tool can be directly executed on a widget: returns it if supported (including appearance mode, used for fingerprinting). */
export function widgetButtonAction(c: Component): RecordToolUse | null {
  if (!isKnownComponent(c) || c.look !== 'button') return null;
  const use = c.tools?.[0];
  return use && widgetTool(use) && isRecordToolUse(use) ? use : null;
}

/** Whether a row tool (tap) can be directly executed on a widget. */
export function widgetRowAction(use: ToolUse | undefined): RecordToolUse | undefined {
  return use && widgetTool(use) && isRecordToolUse(use) ? use : undefined;
}

export const buttonOpKey = (componentId: string) => `b:${componentId}`;
export const rowOpKey = (componentId: string, recordId: string) => `r:${componentId}:${recordId}`;

export type PlannedWrite =
  | { kind: 'insert'; collection: Collection; values: Record<string, unknown> }
  | {
      kind: 'update';
      collection: Collection;
      id: string;
      values: Record<string, unknown>;
    };

/**
 * Determines what write operation to perform for a tap. Returns null if not executable (component
 * deleted, action modified, record missing, table full, value un-storable). records contains
 * stored records (not computed ones); timestamps use tap time: "today" is the day of the tap
 * (D-323).
 */
export function planWidgetOp(
  config: WorkspaceConfig,
  ref: WidgetOpRef,
  records: RecordsByTable,
  at: Date,
  cal: Calendar,
): PlannedWrite | null {
  const c = findComponent(config, ref.component);
  if (!c || !isKnownComponent(c)) return null;
  const insert = (
    tool: Extract<RecordTool, { do: 'create' }>,
    rowId?: string,
  ): PlannedWrite | null => {
    const collection = config.data.tables.find((x) => x.id === tool.table);
    if (!collection) return null;
    if ((records.get(collection.id)?.length ?? 0) >= RECORD_LIMITS.perCollection) return null;
    const input = createInput(collection, tool.values, { now: at, cal, rowId });
    const prepared = prepareRecordValues(collection, input, null, at, cal);
    return prepared.ok ? { kind: 'insert', collection, values: prepared.values } : null;
  };
  if (ref.record === undefined) {
    const use = widgetButtonAction(c);
    const tool = use && actionHash(use) === ref.hash ? widgetTool(use) : undefined;
    return tool?.do === 'create' ? insert(tool) : null;
  }
  if (c.look !== 'tiles') return null;
  // Evaluates against the tool displayed at the time of the tap: the one with a matching hash (conditions may have changed, e.g., displaying "Clock out" after clocking in).
  const tool = widgetTool((c.tools ?? []).find((u) => actionHash(u) === ref.hash));
  if (!tool) return null;
  const listed = records.get(c.source.table)?.find((r) => r.id === ref.record);
  if (!listed) return null;
  if (tool.do === 'create') return insert(tool, listed.id);
  // Modifies an entry in the tool's own table (relation rule 12).
  const collection = config.data.tables.find((x) => x.id === tool.table);
  const stored = collection && records.get(collection.id)?.find((r) => r.id === ref.record);
  if (!collection || !stored) return null;
  const input = rowUpdateInput(tool, collection, stored.values, { now: at, cal, rowId: stored.id });
  if (!input) return null;
  const prepared = prepareRecordValues(collection, input, stored.values, at, cal);
  return prepared.ok
    ? { kind: 'update', collection, id: stored.id, values: prepared.values }
    : null;
}

/** Executes against in-memory records (used to precalculate post-tap views). */
export function applyInMemory(
  records: RecordsByTable,
  write: PlannedWrite,
  at: Date,
  id: string,
): Map<string, DataRecord[]> {
  const next = new Map(Array.from(records, ([k, v]) => [k, [...v]]));
  const list = next.get(write.collection.id) ?? [];
  const time = at.getTime();
  if (write.kind === 'insert') {
    list.push({
      id,
      collectionId: write.collection.id,
      values: write.values,
      createdAt: time,
      updatedAt: time,
    });
  } else {
    const i = list.findIndex((r) => r.id === write.id);
    if (i >= 0) list[i] = { ...list[i]!, values: write.values, updatedAt: time };
  }
  next.set(write.collection.id, list);
  return next;
}

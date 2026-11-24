import { linkTitle, type DataRecord, type LinkedGroups } from './data';
import type { FieldOf } from './fields';
import type { RecordToolUse, ToolUse } from './record-ops-schema';
import { GROUP_REF } from './schema-primitives';
import type { Collection } from './schema';

// Maximum display limit for large circle blocks (D-312, confirmed by founder 2026-10-30): Streaks
// intentionally capped at 24 to fit on one screen.

/** Maximum display limit for large circle blocks (D-312, confirmed by founder 2026-10-30): Streaks intentionally capped at 24 to fit on one screen. */
export const MAX_TILES = 24;

/** A Kanban column: an option (linked field is that record's ID), or "Unassigned" with option as null (no value, or option deleted). */
export interface BoardColumn {
  option: string | null;
  label: string | null;
  records: DataRecord[];
}

type BoardField = FieldOf<'choice'> | FieldOf<'link'>;

/** Single-select or link field used for Kanban grouping (`source.group.by`); undefined if missing or wrong type (checks will reject such config). */
export function boardField(collection: Collection, by: string | undefined): BoardField | undefined {
  const field = collection.fields.find((f) => f.id === by);
  return field?.type === 'choice' || field?.type === 'link' ? field : undefined;
}

/**
 * Grouping: one column per option in option order (link fields: one column per entry in linked,
 * ordered by creation time oldest to newest), followed by "Unassigned". Records are already
 * filtered and sorted; max limit entries per column. "Unassigned" is hidden when required field
 * has no records (cannot store dropped items either); always shown when optional, allowing items
 * to be dragged back to clear. Link field columns only include those in `linked` (already
 * filtered by `group.filter`), with cards pointing to other records placed into "Unassigned".
 */
export function boardColumns(
  field: BoardField,
  records: readonly DataRecord[],
  limit: number,
  linked?: LinkedGroups,
): BoardColumn[] {
  const columns: BoardColumn[] =
    field.type === 'choice'
      ? field.options.map((o) => ({ option: o.id, label: o.label, records: [] }))
      : [...(linked?.records ?? [])]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((r) => ({
            option: r.id,
            label: linkTitle(r, linked!.collection, linked!.locale),
            records: [],
          }));
  const none: BoardColumn = { option: null, label: null, records: [] };
  for (const r of records) {
    // Multi-select (D-607): cards appear in every column they are selected in (such boards cannot be dragged; validation rejects drag tools).
    const values: unknown[] = [r.values[field.id]].flat();
    const mine = columns.filter((c) => values.includes(c.option));
    for (const column of mine.length > 0 ? mine : [none])
      if (column.records.length < limit) column.records.push(r);
  }
  if (!field.required || none.records.length > 0) columns.push(none);
  return columns;
}

/** Valid target columns for moving a card: excludes its current column; required fields cannot be moved to "Unassigned". */
export function boardTargets(
  field: BoardField,
  columns: readonly BoardColumn[],
  from: string | null,
): BoardColumn[] {
  return columns.filter((c) => c.option !== from && (c.option !== null || !field.required));
}

/** Drag tool on Kanban board (v34): `{as: "drag", do: "set"}` in tools; absence indicates a read-only board. */
export type BoardDragTool = Extract<RecordToolUse, { do: 'set' }>;

export const boardDragTool = (tools: readonly ToolUse[] | undefined): BoardDragTool | undefined =>
  tools?.find((u): u is BoardDragTool => u.as === 'drag' && 'do' in u && u.do === 'set');

/**
 * Drag to another column (or selected from "Move to..."): block drag tool, replaces `"$group"`
 * with that column's value (`null` for "Unassigned", clearing it), execution and undo both use
 * one-tap record tools (D-300, D-314). Label is the column name (displayed in tooltip).
 */
export function boardMoveAction(
  drag: BoardDragTool,
  option: string | null,
  label: string,
): BoardDragTool {
  return { ...drag, value: drag.value === GROUP_REF ? option : drag.value, label };
}

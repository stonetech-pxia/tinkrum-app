import { z } from 'zod';

import {
  ConditionSchema,
  FieldRefSchema,
  GROUP_REF,
  HERE_REF,
  IdSchema,
  OffsetAddSchema,
  OffsetUnitSchema,
  RECORD_REF,
  ROW_REF,
  boundedText,
  filterSchema,
} from './schema-primitives';

// Syntax for one-tap record tools (D-300, v34 D-370 rule 7). Structure only: referenced by block
// and reminder definitions; validation and execution are in record-ops.ts (which uses data and
// filters, so block definitions cannot reference it directly to avoid circular dependencies). v34:
// local tools (Q1) are written in block tools[], added, modified, and deleted alongside blocks;
// reminder completion is also a one-tap record tool.

/**
 * "Add a specified number of days or months from a starting date" written into date fields
 * (D-565): from is "today" or a date/datetime field of "this entry", add is an integer or a
 * number field of "this entry". Uses the same syntax and algorithm as computed date fields
 * (D-542, offsetDay in data.ts).
 */
export const DateValueSchema = z.strictObject({
  from: z.union([z.literal('today'), FieldRefSchema]),
  add: OffsetAddSchema,
  unit: OffsetUnitSchema,
});
export type DateValue = z.infer<typeof DateValueSchema>;

/**
 * The value of a field from "this entry", copied over at the moment of the tap (D-565). Config
 * contains only the field ID, not the content (invariant 14), and the AI cannot see the value
 * (invariant 2). "This entry": the entry acted upon by the tool ("$row"), or when absent, the
 * entry open on the record page ("$record"); during batch creation, every entry of the source
 * table.
 */
export const CopyValueSchema = z.strictObject({ copy: IdSchema });
export type CopyValue = z.infer<typeof CopyValueSchema>;

/**
 * Values that can be written in tools (D-301): single-select option ID, number, boolean (true /
 * false), "today" (date fields), "now" (time and datetime fields), null (clear); "$row" is the
 * entry acted upon by the tool, "$record" is the entry open on the record page (D-342), both
 * restricted to reference fields only; "$group" is the column dragged into (restricted to drag
 * only). Interpreted by field type, text literals are not allowed: text is user content (D-042).
 * Since D-565, also supports: adding days or months starting from today or a date on this entry
 * (DateValueSchema), and copying a field from this entry (CopyValueSchema). D-607: multi-select
 * fields take a set of option IDs (replacing previous selection).
 */
export const RecordToolValueSchema = z.union([
  IdSchema,
  z.literal(RECORD_REF),
  z.literal(ROW_REF),
  z.literal(GROUP_REF),
  z.number().finite(),
  z.boolean(),
  z.null(),
  DateValueSchema,
  CopyValueSchema,
  // Option IDs for multi-select fields (D-607).
  z.array(IdSchema).min(1).max(50),
]);
export type RecordToolValue = z.infer<typeof RecordToolValueSchema>;
/** v33 name (same thing). */
export type RecordActionValue = RecordToolValue;

/** Field ID -> default value (≤20; form ≤10, checked in record-ops.ts). */
export const RecordToolValuesSchema = z
  .record(IdSchema, RecordToolValueSchema)
  .refine((v) => Object.keys(v).length <= 20, 'at most 20 preset values');
export type RecordToolValues = z.infer<typeof RecordToolValuesSchema>;

/** Ask for several fields in a form (formerly recordForm.fieldIds), or "all" = open complete form for a new record (formerly create form:true, open). */
export const AskSchema = z.union([z.literal('all'), z.array(IdSchema).min(1).max(10)]);
export type Ask = z.infer<typeof AskSchema>;

const create = {
  do: z.literal('create'),
  table: IdSchema,
  /** Default values; "$here" = add locally (values from this section + equals conditions from list filter, formerly addHere). */
  values: z.union([RecordToolValuesSchema, z.literal(HERE_REF)]).optional(),
  /** Omitted: save directly (formerly create); "all": complete form with default values pre-filled; [fields]: prompt for these fields in a form block (restricted to look form). */
  ask: AskSchema.optional(),
  /** Recognize dates mentioned in text on device (D-344): from is a text field in ask, to is a date, datetime, or schedule field. */
  smartDate: z.strictObject({ from: IdSchema, to: IdSchema }).optional(),
};
const set = {
  do: z.literal('set'),
  table: IdSchema,
  field: IdSchema,
  value: RecordToolValueSchema,
};
const toggle = { do: z.literal('toggle'), table: IdSchema, field: IdSchema };
/** Increment amount: a fixed number, or a number field from this entry (D-565). */
const IncrementBySchema = z.union([
  z
    .number()
    .finite()
    .refine((n) => n !== 0 && Math.abs(n) <= 1e6, 'by must be a non-zero number up to 1000000'),
  IdSchema,
]);
const increment = {
  do: z.literal('increment'),
  table: IdSchema,
  field: IdSchema,
  by: IncrementBySchema,
};

/** Maximum number of changes per tap (D-566, founder 2026-11-16 ③): tool itself plus those in also. */
export const MAX_TAP_WRITES = 3;

/**
 * Secondary changes accompanying a tap (D-566): modify this entry (set, toggle, increment; table
 * is implied as this entry's table, no need to specify), or create a new entry and link back to
 * this entry using a reference field ("$row"). No ask, no setAll, no nesting, and cannot
 * reference other tools (invariant 9).
 */
export const TapAlsoSchema = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('set'), field: IdSchema, value: RecordToolValueSchema }),
  z.strictObject({ do: z.literal('toggle'), field: IdSchema }),
  z.strictObject({ do: z.literal('increment'), field: IdSchema, by: IncrementBySchema }),
  z.strictObject({ do: z.literal('create'), table: IdSchema, values: RecordToolValuesSchema }),
]);
export type TapAlso = z.infer<typeof TapAlsoSchema>;
const also = {
  also: z
    .array(TapAlsoSchema)
    .min(1)
    .max(MAX_TAP_WRITES - 1)
    .optional(),
};
const setAll = {
  do: z.literal('setAll'),
  table: IdSchema,
  filter: filterSchema().optional(),
  field: IdSchema,
  value: RecordToolValueSchema,
};

/**
 * Batch creation (D-567, founder 2026-11-16 ④): For every entry filtered in the from table,
 * create a new entry in table. In values, "$row" is the source entry (restricted to reference
 * fields pointing to from), and copied fields also come from it (D-565). Ask first, at most
 * MAX_CREATE_ALL entries, executed one by one by the engine with no loops in config (invariant
 * 9); toast banner allows undoing the entire batch at once (invariant 11).
 */
const createAll = {
  do: z.literal('createAll'),
  table: IdSchema,
  from: IdSchema,
  filter: filterSchema().optional(),
  values: RecordToolValuesSchema,
  /**
   * Selection-based creation (D-616): source is not every filtered entry, but the specific
   * entries checked by the user in the source table this time (filter only determines which ones
   * can be checked). Restricted to "Add" below lists (as addHere): each new record also inherits
   * values from this section ("$here": equals conditions in list filter, plus this section), and
   * sources already linked in this section are displayed as "Added" without being created again.
   * Still prompts first, respects MAX_CREATE_ALL, and toast banner can undo the batch.
   */
  pick: z.literal(true).optional(),
};

/**
 * Move this entry to "Recently Deleted" (D-610, founder 2026-11-20): soft-delete just like
 * user-initiated deletion (recoverable within 30 days), with an undo action on the toast banner
 * upon completion (invariant 11). In this version, restricted to taps on check-in grid cells
 * (look grid): taps on a cell with exactly one entry delete it; rejected everywhere else
 * (record-ops.ts).
 */
const remove = { do: z.literal('remove'), table: IdSchema };

/** The 7 types of one-tap records (relation rule 7; remove added by D-610). */
export const RECORD_TOOL_KINDS = [
  'create',
  'set',
  'toggle',
  'increment',
  'setAll',
  'createAll',
  'remove',
] as const;
export type RecordToolKind = (typeof RECORD_TOOL_KINDS)[number];

export const RecordToolSchema = z.discriminatedUnion('do', [
  z.strictObject(create),
  z.strictObject(set),
  z.strictObject(toggle),
  z.strictObject(increment),
  z.strictObject(setAll),
  z.strictObject(createAll),
  z.strictObject(remove),
]);
export type RecordTool = z.infer<typeof RecordToolSchema>;

/** Maximum number of entries modified in a single setAll operation (D-303). */
export const MAX_SET_ALL = 200;
/** Maximum number of entries created in a single createAll operation (D-567, same as setAll). */
export const MAX_CREATE_ALL = 200;

/**
 * Where block tools appear (relation rule 4): submit for form submission, button for the button
 * on the right of each entry (≤3, displays the first one whose when condition is met), check for
 * checklist checkboxes, tap for single taps (large round block), drag for dragging into another
 * column, addHere for "Add" below each section / selected day / column, list for buttons above
 * lists (≤3, executes quick action on currently selected records in the list, D-428). When as is
 * omitted: triggered when the block itself is tapped (button, action, picker).
 */
export const TOOL_USE_AS = ['submit', 'button', 'check', 'tap', 'drag', 'addHere', 'list'] as const;
export type ToolUseAs = (typeof TOOL_USE_AS)[number];

/** Core "Open photo library / Open files" (formerly filePick), enters inbox after selection, never executes automatically. */
export const PICK_TOOLS = ['$pick.media', '$pick.files', '$pick.open'] as const;
export type PickTool = (typeof PICK_TOOLS)[number];

const useBase = {
  as: z.enum(TOOL_USE_AS).optional(),
  /** Button label (submit ≤30, others ≤20, checked in record-ops.ts). */
  label: boundedText(1, 30).optional(),
  /** Display only when this entry satisfies these conditions (e.g., display "Off Work" when end time is empty); conditions are read-only data (relation rule 5). */
  when: z.array(ConditionSchema).max(3).optional(),
};

/**
 * How blocks reference tools (D-370 rule 4):
 * - Reference an independent tool: quick action in tools[] (fallback to built-in quick action ID
 * if not found), or core $pick.*;
 * - Local one-tap record tool (Q1);
 * - Row-level "Open": navigate to edit page ("record") or record page (page ID) of this entry,
 * not a tool.
 */
export const ToolUseSchema = z.union([
  z.strictObject({ ...useBase, tool: z.union([IdSchema, z.enum(PICK_TOOLS)]) }),
  z.strictObject({ ...useBase, ...create, ...also }),
  z.strictObject({ ...useBase, ...set, ...also }),
  z.strictObject({ ...useBase, ...toggle, ...also }),
  z.strictObject({ ...useBase, ...increment, ...also }),
  z.strictObject({ ...useBase, ...setAll }),
  z.strictObject({ ...useBase, ...createAll }),
  z.strictObject({ ...useBase, ...remove }),
  z.strictObject({ ...useBase, opens: z.union([z.literal('record'), IdSchema]) }),
]);
export type ToolUse = z.infer<typeof ToolUseSchema>;
/** Local one-tap record tool (with presentation mode). */
export type RecordToolUse = Extract<ToolUse, { do: string }>;
export type ToolRefUse = Extract<ToolUse, { tool: string }>;
export type OpenUse = Extract<ToolUse, { opens: string }>;

export const isRecordToolUse = (u: ToolUse): u is RecordToolUse => 'do' in u;
export const isToolRefUse = (u: ToolUse): u is ToolRefUse => 'tool' in u;
export const isOpenUse = (u: ToolUse): u is OpenUse => 'opens' in u;

/** Extracts the underlying one-tap record tool from a local tool by removing its presentation mode. */
export function recordToolOf(use: RecordToolUse): RecordTool {
  const { as: _as, label: _label, when: _when, ...rest } = use;
  const { also: _also, ...tool } = rest as typeof rest & { also?: unknown };
  return tool as RecordTool;
}

/** Secondary changes accompanying a local tool (D-566); empty if none. */
export const tapAlsoOf = (use: RecordToolUse): readonly TapAlso[] =>
  ('also' in use ? use.also : undefined) ?? [];

/**
 * List of modifications to execute on a tap in order, with the main tool first (D-566).
 * Modifications in also targeting this entry use this table (the tool's table; when the main tool
 * is creation, it uses the table it links back to, guaranteed by validation), while newly created
 * entries remain as is.
 */
export function tapWrites(use: RecordToolUse, rowTable: string = use.table): RecordTool[] {
  return [
    recordToolOf(use),
    ...tapAlsoOf(use).map((a) =>
      a.do === 'create' ? (a as RecordTool) : ({ ...a, table: rowTable } as RecordTool),
    ),
  ];
}

export const isDateValue = (v: unknown): v is DateValue =>
  typeof v === 'object' && v !== null && 'unit' in v && 'from' in v;
export const isCopyValue = (v: unknown): v is CopyValue =>
  typeof v === 'object' && v !== null && 'copy' in v;

/** Which fields of "this entry" are read by a value (D-565): copied fields, date start point, and addend. */
export function valueEntryFields(v: unknown): string[] {
  if (isCopyValue(v)) return [v.copy];
  if (!isDateValue(v)) return [];
  return [...(v.from === 'today' ? [] : [v.from]), ...(typeof v.add === 'string' ? [v.add] : [])];
}

/** Which fields of "this entry" are read by a one-tap record tool (D-565): app pre-calculates this entry only when needed. */
export function toolEntryFields(tool: RecordTool): string[] {
  switch (tool.do) {
    case 'create':
      return typeof tool.values === 'object'
        ? Object.values(tool.values).flatMap(valueEntryFields)
        : [];
    case 'set':
    case 'setAll':
      return valueEntryFields(tool.value);
    case 'increment':
      return typeof tool.by === 'string' ? [tool.by] : [];
    case 'toggle':
      return [];
    // Batch creation reads every entry of the source table, not "this entry" (handled by createAllInputs in record-ops.ts).
    case 'createAll':
    case 'remove':
      return [];
  }
}

export const toolReadsEntry = (tool: RecordTool) => toolEntryFields(tool).length > 0;

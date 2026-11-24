import { DEFAULT_CALENDAR, calendarOf, dayOf, type Calendar } from './calendar';
import { SMART_DATE_TYPES } from './components/form';
import { conditionProblems } from './conditions';
import {
  matchesCondition,
  offsetDay,
  prepareRecordValues,
  recordDay,
  recordValue,
  type DataRecord,
  type PreparedValues,
} from './data';
import { localDateTime, round } from './field-values';
import { isMultipleChoice, MULTIPLE_CHOICE_NOT_ONE } from './fields';
import { expandCollection } from './related';
import {
  isCopyValue,
  isDateValue,
  recordToolOf,
  tapAlsoOf,
  type CopyValue,
  type DateValue,
  type RecordTool,
  type RecordToolUse,
  type RecordToolValue,
  type RecordToolValues,
  type ToolUse,
} from './record-ops-schema';
import {
  GROUP_REF,
  HERE_REF,
  RECORD_REF,
  ROW_REF,
  SYSTEM_FIELDS,
  fieldDefinition,
  type Collection,
  type Field,
  type FieldType,
  type WorkspaceConfig,
} from './schema';

export * from './record-ops-schema';

// Fields usable with increment (D-302). Quick-action tool (D-300–D-304, v34 D-370 Rule 7): checked
// (called by validate.ts), calculates the value to write before execution (called by App). When
// deleting a field or table, ops.ts identifies tools using it. The AI only configures tools; values
// are written to records on the device only after user tap.

/** Fields usable with increment (D-302). */
export const INCREMENT_FIELD_TYPES: readonly FieldType[] = ['number', 'money', 'duration'];

/** What each field type can be preset to (D-301). Types not listed here cannot be preset: text is user content, and computed fields cannot be written. */
const PRESET_RULES: Partial<Record<FieldType, { expect: string; ok: (v: unknown) => boolean }>> = {
  date: { expect: '"today" or null', ok: (v) => v === 'today' },
  datetime: { expect: '"now" or null', ok: (v) => v === 'now' },
  time: { expect: '"now" or null', ok: (v) => v === 'now' },
  checkbox: { expect: 'true or false', ok: (v) => typeof v === 'boolean' },
  number: { expect: 'a number or null', ok: (v) => typeof v === 'number' },
  money: { expect: 'a number or null', ok: (v) => typeof v === 'number' },
  duration: {
    expect: 'minutes (a number ≥ 0) or null',
    ok: (v) => typeof v === 'number' && v >= 0,
  },
  rating: {
    expect: 'a whole number 1-5 or null',
    ok: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5,
  },
};

const PRESETTABLE =
  'choice, number, money, duration, rating, checkbox, date ("today"), time or datetime ("now") fields';

/** Where a tool is located and what it acts upon (for validation). */
export interface ToolWhere {
  /** Beginning of the problem text, e.g., `list l1 button "Done"`. */
  label: string;
  /**
   * Which table the entry acted upon by the tool ("$row") belongs to: the source table of the
   * record block, or when.each.table for reminder completion. Buttons and forms do not have this
   * (they write to their own table, relation rule 12). The original table (not a lookup-replaced
   * one).
   */
  rowOf?: Collection;
  /** Which table's record the page containing the block is for (D-342, page.of): "$record" refers to that record. */
  recordOf?: string;
  /** Form block submission (look form): ask specifies fields prompted in the form. */
  form?: boolean;
  /** Reminder "Done": executed directly upon tapping the notification without opening Tinkrum (cannot ask). */
  direct?: boolean;
  /** Kanban drag-and-drop: value written to the "$group" field (source.group.by). */
  dragField?: string;
  /** Check-in grid (D-610) tap: supports values "$here" (this row, this day) and remove, label can be omitted. */
  grid?: boolean;
  /** Fields guaranteed to be filled with "$here" on the check-in grid (this row, this day, equality conditions in filters): required validation checks that they have values. */
  hereFields?: readonly string[];
  /**
   * Field written by list sectioning, kanban column, or calendar selected date (D-616): when
   * creating within this section, "$here" may populate it (some sections have no value, e.g.,
   * "Uncategorized"), so it is not counted as required-filled, but values cannot write to it
   * again.
   */
  hereGroup?: string;
}

interface ValueWhere extends ToolWhere {
  /** Is a creation (create): null has no meaning. */
  creating?: boolean;
  /** New record must include the value of "$here" (checked creation, D-616): hereFields counts as required-filled. */
  hereFilled?: boolean;
  /**
   * "This entry" (D-565, substituted table: lookup or rollup replaced with displayed field
   * types): copied fields, date start, and addend are read from it. The entry acted upon by the
   * tool (rowOf), defaulting to the entry on the record page (recordOf) when absent; absent for
   * setAll, forms, and buttons not on the record page.
   */
  entry?: Collection;
}

const NEEDS_ENTRY =
  "needs this entry: it only works in a tool on each entry of a list, a reminder's done, or a button on a page for one entry";

/** Field value type when copied (in substituted tables): formulas are numbers, computed dates are dates, count/continuous rollups are numbers. */
function valueKind(f: Field): FieldType | undefined {
  if (f.type === 'formula' || f.type === 'rollup') return 'number';
  if (f.type === 'dateOffset') return 'date';
  if (f.type === 'lookup' || f.type === 'previous') return undefined;
  return f.type;
}

/** Fields that cannot be written via "copy": files are chosen by the user (invariant 3), and schedules are complex rule sets. Computed fields are inherently unwritable. */
const NO_COPY_INTO: readonly FieldType[] = ['file', 'schedule'];

function copyProblem(
  target: Field,
  name: string,
  value: CopyValue,
  where: ValueWhere,
): string | null {
  const entry = where.entry;
  if (!entry) return `${where.label}: {copy} reads a field of this entry, so it ${NEEDS_ENTRY}`;
  const source = entry.fields.find((f) => f.id === value.copy);
  if (!source)
    return `${where.label}: copy ${value.copy} is not a field of ${entry.id} (fields: ${entry.fields.map((f) => f.id).join(', ')})`;
  if (!fieldDefinition(target.type).write || NO_COPY_INTO.includes(target.type))
    return `${where.label}: ${name} is a ${target.type} field and can't be written by a tool`;
  const kind = valueKind(source);
  const group = (t: FieldType) => fieldDefinition(t).convertGroup;
  const sameKind =
    kind !== undefined &&
    (kind === target.type || (group(kind) !== undefined && group(kind) === group(target.type)));
  const fits =
    sameKind &&
    (target.type !== 'link' || (source.type === 'link' && source.table === target.table)) &&
    (target.type !== 'choice' ||
      (source.type === 'choice' &&
        source.multiple === target.multiple &&
        source.options.every((o) => target.options.some((x) => x.id === o.id))));
  return fits
    ? null
    : `${where.label}: can't copy ${entry.id}.${source.id} (${kind ?? source.type}) into ${name} (${target.type}); copy a field of the same type (number and money mix, text and note mix; a link to the same table; a choice whose options the target has, both picking one or both several)`;
}

function dateValueProblem(
  target: Field,
  name: string,
  value: DateValue,
  where: ValueWhere,
): string | null {
  if (target.type !== 'date')
    return `${where.label}: ${name} is a ${target.type} field; {from, add, unit} only fills a date field`;
  const entry = where.entry;
  if (value.from !== 'today') {
    if (!entry)
      return `${where.label}: from ${value.from} reads a date of this entry, so it ${NEEDS_ENTRY}; use from "today" here`;
    const from = entry.fields.find((f) => f.id === value.from);
    const kind = from && valueKind(from);
    if (
      !(SYSTEM_FIELDS as readonly string[]).includes(value.from) &&
      kind !== 'date' &&
      kind !== 'datetime'
    )
      return `${where.label}: from ${value.from} must be "today" or a date or datetime field of this entry (${entry.id})`;
  }
  if (typeof value.add === 'string') {
    if (!entry)
      return `${where.label}: add ${value.add} reads a number of this entry, so it ${NEEDS_ENTRY}; use a whole number here`;
    const add = entry.fields.find((f) => f.id === value.add);
    if (!add || valueKind(add) !== 'number')
      return `${where.label}: add ${value.add} must be a whole number or a number field of this entry (${entry.id})`;
  }
  return null;
}

function valueProblem(
  collection: Collection,
  fieldId: string,
  value: RecordToolValue,
  where: ValueWhere,
): string | null {
  const field = collection.fields.find((f) => f.id === fieldId);
  if (!field) {
    return `${where.label}: ${fieldId} is not a field of ${collection.id} (fields: ${collection.fields.map((f) => f.id).join(', ')})`;
  }
  const name = `${collection.id}.${fieldId}`;
  // Dates calculated from today or this entry, or copying a field from this entry (D-565).
  if (isCopyValue(value)) return copyProblem(field, name, value, where);
  if (isDateValue(value)) return dateValueProblem(field, name, value, where);
  // Column dropped into (kanban): restricted to dragging, writes to the group-by field.
  if (value === GROUP_REF) {
    if (where.dragField !== fieldId)
      return `${where.label}: "${GROUP_REF}" (the column a card is dragged to) only works in a board's {as: "drag", do: "set", field: <source.group.by>}`;
    // Multiple choice (D-607): a card residing in multiple columns cannot determine whether dragging away means adding or replacing, so such kanbans are read-only.
    return isMultipleChoice(field)
      ? `${where.label}: ${name} ${MULTIPLE_CHOICE_NOT_ONE}; a board grouped by it shows a card in each of its columns and can't be dragged: leave the drag tool out`
      : null;
  }
  if (field.type === 'link') {
    const row =
      value === ROW_REF &&
      where.creating === true &&
      where.rowOf !== undefined &&
      field.table === where.rowOf.id;
    // D-342: On a page dedicated to a record, reference fields can default to this record during creation.
    const page =
      value === RECORD_REF &&
      where.creating === true &&
      where.recordOf !== undefined &&
      field.table === where.recordOf;
    if (row || page || (value === null && !where.creating)) return null;
    if (value === RECORD_REF)
      return where.recordOf
        ? `${where.label}: link field ${name} can be "${RECORD_REF}" only when creating and only if it points at ${where.recordOf}`
        : `${where.label}: "${RECORD_REF}" only works on a page for one entry of a table (page.of)`;
    return where.rowOf && where.creating
      ? `${where.label}: link field ${name} can only be "${ROW_REF}" (this entry) and must point at ${where.rowOf.id}`
      : `${where.label}: link field ${name} can't be preset; only a tool on each entry of a list can create with "${ROW_REF}"`;
  }
  if (value === ROW_REF || value === RECORD_REF)
    return `${where.label}: "${value}" only works on a link field, but ${name} is a ${field.type} field`;
  if (field.type === 'checkbox' && value === null) return null;
  if (value === null) {
    return where.creating ? `${where.label}: leave ${name} out instead of null` : null;
  }
  const ids = field.type === 'choice' ? field.options.map((o) => o.id).join(', ') : '';
  // Multiple choice (D-607): set of option IDs (unique), replacing current selections; a single ID is invalid (ambiguous whether to add or replace).
  if (field.type === 'choice' && field.multiple) {
    if (
      Array.isArray(value) &&
      value.every((v) => field.options.some((o) => o.id === v)) &&
      new Set(value).size === value.length
    )
      return null;
    return `${where.label}: ${name} is a choice field with multiple: true; the value must be a list of its option ids (${ids}), e.g. ["${field.options[0]!.id}"], which replaces what the entry had, or null`;
  }
  if (field.type === 'choice') {
    if (typeof value === 'string' && field.options.some((o) => o.id === value)) return null;
    return `${where.label}: ${name} is a choice field; the value must be one of its option ids (${ids}) or null`;
  }
  if (Array.isArray(value))
    return `${where.label}: ${name} is a ${field.type} field; a list of option ids only fits a choice field with multiple: true`;
  const rule = PRESET_RULES[field.type];
  if (!rule) {
    return `${where.label}: ${name} is a ${field.type} field and can't be set by a button (text is the user's own; computed fields can't be written). Only ${PRESETTABLE}`;
  }
  return rule.ok(value)
    ? null
    : `${where.label}: ${name} is a ${field.type} field, so the value must be ${rule.expect}`;
}

function createProblems(
  tool: Extract<RecordTool, { do: 'create' }>,
  collection: Collection,
  where: ValueWhere,
): string[] {
  const problems: string[] = [];
  const values = typeof tool.values === 'object' ? tool.values : undefined;
  for (const [id, v] of Object.entries(values ?? {})) {
    const p = valueProblem(collection, id, v, { ...where, creating: true });
    if (p) problems.push(p);
  }
  const ask = tool.ask;
  if (where.direct && ask !== undefined)
    problems.push(
      `${where.label}: runs right from the notification without opening Morph, so it can't ask; leave ask out`,
    );
  if (Array.isArray(ask) && !where.form)
    problems.push(
      `${where.label}: ask: [fields] only works in a form block; use ask: "all" to open the full form`,
    );
  if (tool.smartDate) problems.push(...smartDateProblems(tool, collection, where));
  // Fields that are required yet lack a default value: cannot be saved on a single tap. Form openers (D-338) are filled by the user.
  if (ask !== undefined) return problems;
  for (const f of collection.fields) {
    const def = fieldDefinition(f.type);
    if (!('required' in f) || !f.required || !def.write || values?.[f.id] !== undefined) continue;
    if ((tool.values === HERE_REF || where.hereFilled) && where.hereFields?.includes(f.id))
      continue;
    const hasDefault = ('default' in f && f.default !== undefined) || def.emptyNew !== undefined;
    if (!hasDefault) {
      problems.push(
        `${where.label}: creates an entry in ${collection.id} but required field ${f.id} would be empty; preset it, make it not required, or add ask: "all" so the user fills in the rest`,
      );
    }
  }
  return problems;
}

/** smartDate (D-344, formerly recordForm.smartDate): forms only, parses a date from a text field input and populates date-type fields. */
function smartDateProblems(
  tool: Extract<RecordTool, { do: 'create' }>,
  collection: Collection,
  where: ToolWhere,
): string[] {
  const smart = tool.smartDate!;
  const problems: string[] = [];
  const ask = Array.isArray(tool.ask) ? tool.ask : [];
  if (!where.form || !Array.isArray(tool.ask))
    problems.push(`${where.label}: smartDate only works in a form block (ask: [fields])`);
  const from = collection.fields.find((x) => x.id === smart.from);
  const to = collection.fields.find((x) => x.id === smart.to);
  if (from?.type !== 'text' || !ask.includes(smart.from))
    problems.push(
      `${where.label}: smartDate.from ${smart.from} must be a text field listed in ask`,
    );
  if (!to || !SMART_DATE_TYPES.includes(to.type))
    problems.push(
      `${where.label}: smartDate.to ${smart.to} must be a date, datetime or schedule field of ${collection.id}`,
    );
  return problems;
}

function fieldProblem(
  collection: Collection,
  fieldId: string,
  where: ToolWhere,
  types: readonly FieldType[],
  verb: string,
): string | null {
  const field = collection.fields.find((f) => f.id === fieldId);
  if (!field) return `${where.label}: ${fieldId} is not a field of ${collection.id}`;
  return types.includes(field.type)
    ? null
    : `${where.label}: ${verb} needs a ${types.join(' or ')} field, but ${collection.id}.${fieldId} is ${field.type}`;
}

/**
 * Relation rule 12: A tool on a block can only write to the table read by that block ("$row" is
 * one of its entries), or create a new entry in another table linked back to this entry ("$row")
 * or the record page entry ("$record") via a reference field. Buttons and forms have no source
 * and write to their own table.
 */
function scopeProblem(tool: RecordTool, collection: Collection, where: ToolWhere): string | null {
  const row = where.rowOf;
  if (!row || tool.table === row.id) return null;
  if (tool.do !== 'create')
    return `${where.label}: ${tool.do} changes this entry ("${ROW_REF}", an entry of ${row.id}), so table must be ${row.id}, not ${tool.table}`;
  const values = typeof tool.values === 'object' ? tool.values : {};
  const linked = Object.entries(values).some(
    ([id, v]) =>
      (v === ROW_REF || v === RECORD_REF) &&
      collection.fields.find((f) => f.id === id)?.type === 'link',
  );
  return linked
    ? null
    : `${where.label}: creates an entry in ${tool.table}, but this block shows ${row.id}; a tool here can only add to ${row.id}, or add to another table with a link field set to "${ROW_REF}" (this entry)`;
}

/** Problems with a quick-action tool (text sent to AI). */
export function recordToolProblems(
  tool: RecordTool,
  config: WorkspaceConfig,
  where: ToolWhere,
): string[] {
  const collection = config.data.tables.find((c) => c.id === tool.table);
  if (!collection) return [`${where.label}: data table ${tool.table} does not exist`];
  // "This entry" (D-565): the entry acted upon by the tool, falling back to the record page entry if absent; absent for forms.
  const entryTable = where.form
    ? undefined
    : (where.rowOf ?? config.data.tables.find((c) => c.id === where.recordOf));
  if (entryTable)
    where = { ...where, entry: expandCollection(config.data.tables, entryTable) } as ValueWhere;
  // Move to "Recently Deleted" (D-610): in this version restricted to tapping on check-in grids; prohibited elsewhere (row buttons, button blocks, reminder completion, quick actions).
  if (tool.do === 'remove' && !where.grid)
    return [
      `${where.label}: remove only works as a tap on a grid ({as: "tap", do: "remove", table: <the grid's table>}); elsewhere the user deletes an entry from the entry page`,
    ];
  const scope = scopeProblem(tool, collection, where);
  if (scope) return [scope];
  if (tool.do !== 'create' && tool.do !== 'setAll' && tool.do !== 'createAll' && !where.rowOf)
    return [
      `${where.label}: ${tool.do} changes one entry, so it only works on each entry of a list (or a reminder's done)`,
    ];
  switch (tool.do) {
    case 'create':
      return createProblems(tool, collection, where);
    case 'createAll':
      return createAllProblems(tool, collection, config, where);
    case 'setAll': {
      if (where.direct)
        return [
          `${where.label}: done acts on this entry ("${ROW_REF}"); use create, set, toggle or increment, not setAll`,
        ];
      // Editing multiple entries without "this entry": dates can only be calculated relative to today.
      const p = valueProblem(collection, tool.field, tool.value, { label: where.label });
      return [
        ...(p ? [p] : []),
        ...conditionProblems(
          tool.filter,
          expandCollection(config.data.tables, collection),
          where.recordOf,
        ).map((x) => `${where.label}: ${x}`),
      ];
    }
    case 'set': {
      const p = valueProblem(collection, tool.field, tool.value, where);
      return p ? [p] : [];
    }
    // Write only to the table read by the grid (relation rule 12, already checked by scopeProblem).
    case 'remove':
      return [];
    case 'toggle': {
      const p = fieldProblem(collection, tool.field, where, ['checkbox'], 'toggle');
      return p ? [p] : [];
    }
    case 'increment': {
      const p = fieldProblem(collection, tool.field, where, INCREMENT_FIELD_TYPES, 'increment');
      if (p) return [p];
      // Add to a numeric field of this entry (D-565).
      const entry = (where as ValueWhere).entry;
      if (typeof tool.by !== 'string' || !entry) return [];
      const by = entry.fields.find((f) => f.id === tool.by);
      const kind = by && valueKind(by);
      return kind && INCREMENT_FIELD_TYPES.includes(kind)
        ? []
        : [`${where.label}: by ${tool.by} must be a number field of ${entry.id} (or a number)`];
    }
  }
}

/**
 * Batch creation (D-567): source table must exist, filters are validated against the source table
 * (can use "$record"), values are validated as creation, "$row" and copied fields come from the
 * source entry. Required fields without default values must be preset (no form available to
 * prompt). Reminder "Done" cannot be used (it only modifies a single entry).
 */
function createAllProblems(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  collection: Collection,
  config: WorkspaceConfig,
  where: ToolWhere,
): string[] {
  if (where.direct)
    return [
      `${where.label}: done acts on this entry ("${ROW_REF}"); use create, set, toggle or increment, not createAll`,
    ];
  const source = config.data.tables.find((c) => c.id === tool.from);
  if (!source) return [`${where.label}: data table ${tool.from} does not exist`];
  const view = expandCollection(config.data.tables, source);
  const at: ValueWhere = {
    label: where.label,
    rowOf: source,
    entry: view,
    // Checked creation (D-616): new record includes values from this section, equality conditions in list filters count as required-filled.
    ...(tool.pick && where.hereFields ? { hereFields: where.hereFields, hereFilled: true } : {}),
  };
  return [
    ...(tool.pick ? pickProblems(tool, collection, where) : []),
    ...conditionProblems(tool.filter, view, where.recordOf).map((x) => `${where.label}: ${x}`),
    ...createProblems({ do: 'create', table: tool.table, values: tool.values }, collection, at),
  ];
}

/**
 * Checked creation (D-616): exactly one reference field in values pointing to the source table
 * must be "$row" (the checked entry; "added" counts similarly); fields populated by this section
 * (equality conditions in list filters, section field) cannot be written again, otherwise the new
 * entry would fall outside the user-selected section.
 */
function pickProblems(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  collection: Collection,
  where: ToolWhere,
): string[] {
  const problems: string[] = [];
  const rows = pickLinkFields(tool, collection);
  if (rows.length !== 1)
    problems.push(
      `${where.label}: pick: true needs exactly one link field of ${tool.table} to ${tool.from} set to "${ROW_REF}" (the entry the user picks)${rows.length > 1 ? `, not ${rows.join(', ')}` : ''}`,
    );
  const here = [...(where.hereFields ?? []), ...(where.hereGroup ? [where.hereGroup] : [])];
  for (const id of Object.keys(tool.values))
    if (here.includes(id))
      problems.push(
        `${where.label}: ${id} is already filled by this list (its filter or section) for every new entry; leave it out of values`,
      );
  return problems;
}

/** Maximum length of button labels (form submit is 30, others 20). */
export const toolLabelMax = (as: ToolUse['as']) => (as === 'submit' ? 30 : 20);

/**
 * Problems with an inline tool on a block: validated against presentation mode (as) requirements,
 * button label, when conditions, plus tool-specific validation (recordToolProblems). Allowed
 * presentation modes (as), actions (do), and counts are checked in validate.ts against the
 * registry.
 */
export function recordToolUseProblems(
  use: RecordToolUse,
  config: WorkspaceConfig,
  where: ToolWhere,
): string[] {
  const problems: string[] = [];
  const tool = recordToolOf(use);
  const row = where.rowOf;
  if (use.label !== undefined && use.label.length > toolLabelMax(use.as))
    problems.push(`${where.label}: label can be at most ${toolLabelMax(use.as)} characters`);
  // Check-in grid cells announce their row and day via screen readers (D-610), omitting labels.
  if ((use.as === 'button' || use.as === 'tap') && use.label === undefined && !where.grid)
    problems.push(`${where.label}: needs a label (shown on the button and read by screen readers)`);
  // $here: inline addition (section values + equality conditions in list filters); on check-in grids, the tapped cell (this row, this day, D-610).
  const here = tool.do === 'create' && tool.values === HERE_REF;
  // Checked creation (D-616): restricted to "Add" at the bottom of lists, writing to the list's own table (invariant 17), with the new record inheriting section values.
  const picking = tool.do === 'createAll' && tool.pick === true;
  const pickShape = `{as: "addHere", do: "createAll", table: ${row?.id ?? '<the list table>'}, from: <the table to pick from>, pick: true, filter?, values: {<a link field to it>: "${ROW_REF}"}}`;
  if (picking && use.as !== 'addHere')
    problems.push(
      `${where.label}: pick: true only works as the "Add" under a list of entries: ${pickShape}`,
    );
  else if (picking && row && tool.table !== row.id)
    problems.push(
      `${where.label}: pick: true adds entries to the list it sits under, so table must be ${row.id}, not ${tool.table}`,
    );
  else if (tool.do === 'createAll' && !picking && row)
    problems.push(
      `${where.label}: createAll on every entry a filter selects belongs on a button block; under a list, let the user pick: ${pickShape}`,
    );
  else if (
    use.as === 'addHere' &&
    !picking &&
    (tool.do !== 'create' || !here || (row && tool.table !== row.id))
  )
    problems.push(
      `${where.label}: addHere adds an entry right in this section: {as: "addHere", do: "create", table: ${row?.id ?? '<the block table>'}, ask?: "all", values: "${HERE_REF}"}, or lets the user pick several entries of another table: ${pickShape}`,
    );
  else if (here && use.as !== 'addHere' && !(where.grid && use.as === 'tap'))
    problems.push(
      `${where.label}: values "${HERE_REF}" only works with as: "addHere" (or a tap on a grid)`,
    );
  if (use.when) {
    if (use.as !== 'button' && use.as !== 'tap')
      problems.push(`${where.label}: when only applies to a button or tap on each entry`);
    else if (row) {
      const view = expandCollection(config.data.tables, row);
      problems.push(
        ...conditionProblems(use.when, view, where.recordOf).map(
          (x) => `${where.label} when: ${x}`,
        ),
      );
      // When writing to a schedule's "last completed" field, "hide when empty" would make the button disappear after a single use, preventing completion of recurring items next time.
      const written = tool.do === 'set' ? tool.field : undefined;
      const schedule =
        written !== undefined && use.when.some((w) => w.field === written && w.op === 'isEmpty')
          ? row.fields.find((f) => f.type === 'schedule' && f.lastDone === written)
          : undefined;
      if (schedule)
        problems.push(
          `${where.label}: ${written} is the last-done date of ${schedule.id}, so "when ${written} is empty" hides the button for good after the first time and a repeating entry can never be done again; drop the when (the schedule already shows what is due)`,
        );
    }
  }
  if (tapAlsoOf(use).length > 0) problems.push(...alsoProblems(use, config, where));
  return [...problems, ...recordToolProblems(tool, config, where)];
}

/**
 * Multi-field updates on a single tap (D-566): restricted to row buttons and taps (as button,
 * tap); incidental modifications update this entry or create a linked entry; at most one new
 * entry; same field cannot be modified twice; no form opening (all changes succeed or fail
 * together).
 */
function alsoProblems(use: RecordToolUse, config: WorkspaceConfig, where: ToolWhere): string[] {
  const row = where.rowOf;
  const label = where.label;
  if (use.as === 'check' && row) return checkAlsoProblems(use, config, { ...where, rowOf: row });
  if ((use.as !== 'button' && use.as !== 'tap') || !row)
    return [
      `${label}: also only works on a button or tap on each entry, or the check of a checklist (one tap, several changes to that entry)`,
    ];
  const tool = recordToolOf(use);
  const problems: string[] = [];
  if (tool.do === 'create' && tool.ask !== undefined)
    problems.push(
      `${label}: also can't open a form (all changes of one tap are saved together); leave ask out`,
    );
  const linksBack = (table: string, values: unknown) => {
    const target = config.data.tables.find((c) => c.id === table);
    return Object.entries(typeof values === 'object' && values !== null ? values : {}).some(
      ([id, v]) =>
        v === ROW_REF &&
        target?.fields.some((f) => f.id === id && f.type === 'link' && f.table === row.id),
    );
  };
  const also = tapAlsoOf(use);
  const creates = [
    ...(tool.do === 'create' ? [tool] : []),
    ...also.filter((a) => a.do === 'create'),
  ];
  if (creates.length > 1)
    problems.push(`${label}: one tap can make at most one create (it links back to this entry)`);
  if (tool.do === 'create' && !linksBack(tool.table, tool.values))
    problems.push(
      `${label}: with also, the create must link back to this entry (a link field to ${row.id} set to "${ROW_REF}")`,
    );
  const fields =
    tool.do === 'create' || tool.do === 'createAll' || tool.do === 'remove' ? [] : [tool.field];
  for (const a of also) {
    const at = { ...where, label: `${label} also` };
    if (a.do === 'create') {
      if (!linksBack(a.table, a.values))
        problems.push(
          `${label} also: a create must link back to this entry (a link field to ${row.id} set to "${ROW_REF}")`,
        );
      problems.push(...recordToolProblems(a, config, at));
      continue;
    }
    if (fields.includes(a.field))
      problems.push(`${label}: changes ${a.field} twice in one tap; write each field once`);
    fields.push(a.field);
    problems.push(...recordToolProblems({ ...a, table: row.id } as RecordTool, config, at));
  }
  return problems;
}

/**
 * Checklist completion with also (D-617, founder 2026-11-21 "do the first three"): checking sets
 * one or two fields on this entry (e.g., completion date = today), unchecking clears them, so
 * unchecking fully reverts the check action (invariant 11, no undo banner). Can only set fields
 * on this entry; clearing fields upon checking (null, checkbox false) or required fields are
 * prohibited: once cleared, unchecking cannot restore previous values and saving would fail.
 */
function checkAlsoProblems(
  use: RecordToolUse,
  config: WorkspaceConfig,
  where: ToolWhere & { rowOf: Collection },
): string[] {
  const row = where.rowOf;
  const label = where.label;
  const problems: string[] = [];
  const fields = use.do === 'toggle' ? [use.field] : [];
  for (const a of tapAlsoOf(use)) {
    if (a.do !== 'set') {
      problems.push(
        `${label}: a check's also can only set fields of this entry ({do: "set", field, value}); unticking clears them again`,
      );
      continue;
    }
    if (fields.includes(a.field))
      problems.push(`${label}: changes ${a.field} twice in one tap; write each field once`);
    fields.push(a.field);
    const field = row.fields.find((f) => f.id === a.field);
    if (a.value === null || (a.value === false && field?.type === 'checkbox'))
      problems.push(
        `${label} also: ${a.field} would be emptied by the tick, and unticking can't put the old value back; a check's also records a value (e.g. "today")`,
      );
    if (field && 'required' in field && field.required === true)
      problems.push(
        `${label} also: ${a.field} is required, and unticking clears it; make it optional or use a button`,
      );
    problems.push(
      ...recordToolProblems({ ...a, table: row.id } as RecordTool, config, {
        ...where,
        label: `${label} also`,
      }),
    );
  }
  return problems;
}

// ---- Execution (called by App after user tap) ----

export interface ActionContext {
  now: Date;
  cal?: Calendar;
  /** ID of the entry acted upon by the tool ("$row"). */
  rowId?: string;
  /** ID of the entry opened on the record page ("$record"). */
  recordId?: string;
  /** Column dropped into ("$group"): option ID, referenced entry ID, or null for "Uncategorized". */
  group?: string | null;
  /**
   * "This entry" (D-565): evaluated record (formulas, lookups, and rollups all have values) and
   * substituted tables. Copied fields, date start, and addend are read from it; when absent,
   * these values are not written.
   */
  entry?: { record: DataRecord; view: Collection };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Value in tool -> form input (prepareRecordValues performs strict field-level validation). null
 * = clear (unchecked checkbox). undefined = omit this item (D-565: read value from "this entry",
 * but when missing, or when date start/addend lack values).
 */
export function actionInput(field: Field, value: RecordToolValue, ctx: ActionContext): unknown {
  if (isCopyValue(value)) {
    if (!ctx.entry) return undefined;
    const v = entryValue(ctx, value.copy);
    return v === undefined || v === null ? '' : v;
  }
  if (isDateValue(value)) return dateInput(value, ctx);
  if (value === null) return field.type === 'checkbox' ? false : '';
  if (value === 'today' && field.type === 'date')
    return dayOf(ctx.now, ctx.cal ?? DEFAULT_CALENDAR);
  if (value === 'now' && field.type === 'datetime') return localDateTime(ctx.now);
  if (value === 'now' && field.type === 'time')
    return `${pad(ctx.now.getHours())}:${pad(ctx.now.getMinutes())}`;
  if (value === ROW_REF && field.type === 'link') return ctx.rowId ?? '';
  if (value === RECORD_REF && field.type === 'link') return ctx.recordId ?? '';
  if (value === GROUP_REF) return ctx.group ?? (field.type === 'checkbox' ? false : '');
  return value;
}

function entryValue(ctx: ActionContext, fieldId: string) {
  const entry = ctx.entry;
  return entry
    ? recordValue(entry.record, entry.view, fieldId, ctx.now, ctx.cal ?? DEFAULT_CALENDAR)
    : undefined;
}

/** {from, add, unit} (D-565): add days or months starting from today or this entry's date (using the same algorithm segment as computed dates). */
function dateInput(value: DateValue, ctx: ActionContext): string | undefined {
  const cal = ctx.cal ?? DEFAULT_CALENDAR;
  const start =
    value.from === 'today'
      ? dayOf(ctx.now, cal)
      : ctx.entry && recordDay(ctx.entry.record, ctx.entry.view, value.from, ctx.now, cal);
  const add = typeof value.add === 'number' ? value.add : entryValue(ctx, value.add);
  if (start === undefined || typeof add !== 'number') return undefined;
  return offsetDay(start, add, value.unit);
}

/**
 * create: form input for new record (contains preset fields only; remaining fields populated with
 * defaults by prepareRecordValues). When values is "$here" (inline addition), computed by App
 * from the section; not present here.
 */
export function createInput(
  collection: Collection,
  values: RecordToolValues | typeof HERE_REF | undefined,
  ctx: ActionContext,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof values !== 'object') return input;
  for (const [id, v] of Object.entries(values)) {
    const field = collection.fields.find((f) => f.id === id);
    const value = field && actionInput(field, v, ctx);
    if (value !== undefined) input[id] = value;
  }
  return input;
}

/**
 * {do: "create", ask: "all", values}: pre-filled values in the opened new-record form (Q6: v33
 * "Add" button ignores preset values, v34 pre-fills them). Empty if table no longer exists.
 */
export function createPrefill(
  tool: Extract<RecordTool, { do: 'create' }>,
  ctx: ActionContext & { config: Pick<WorkspaceConfig, 'data'> },
): Record<string, unknown> {
  const collection = ctx.config.data.tables.find((c) => c.id === tool.table);
  if (!collection) return {};
  return createInput(collection, tool.values, { ...ctx, cal: ctx.cal ?? calendarOf(ctx.config) });
}

/**
 * set / toggle / increment: target values for this record (stored values). Returns null if field
 * no longer exists (legacy config). Result is passed to prepareRecordValues.
 */
export function rowUpdateInput(
  tool: Extract<RecordTool, { do: 'set' | 'toggle' | 'increment' }>,
  collection: Collection,
  values: Record<string, unknown>,
  ctx: ActionContext,
): Record<string, unknown> | null {
  const field = collection.fields.find((f) => f.id === tool.field);
  if (!field) return null;
  if (tool.do === 'set') {
    const value = actionInput(field, tool.value, ctx);
    return value === undefined ? {} : { [field.id]: value };
  }
  if (tool.do === 'toggle') return { [field.id]: values[field.id] !== true };
  const raw = values[field.id];
  const current = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  // Add to a numeric field of this entry (D-565): modifies nothing if value is absent.
  const by =
    typeof tool.by === 'number' ? tool.by : ctx.entry ? entryValue(ctx, tool.by) : values[tool.by];
  if (typeof by !== 'number' || !Number.isFinite(by)) return {};
  const decimals = field.type === 'money' ? 2 : field.type === 'number' ? (field.decimals ?? 4) : 0;
  let next = round(current + by, decimals);
  // Duration cannot be negative: clamped to 0.
  if (field.type === 'duration') next = Math.max(0, next);
  return { [field.id]: next };
}

/**
 * Checklist check (D-617): target updates for this entry. Checking = checkbox true plus also
 * values (if reading "this entry" yields empty, omit that item); unchecking = checkbox false,
 * clearing also-specified fields. Written in a single transaction per record (App uses patch).
 * Returns null if field no longer exists (legacy config). Result is passed to
 * prepareRecordValues.
 */
export function checkInput(
  use: RecordToolUse,
  collection: Collection,
  values: Record<string, unknown>,
  ctx: ActionContext,
): Record<string, unknown> | null {
  if (use.do !== 'toggle') return null;
  const box = collection.fields.find((f) => f.id === use.field);
  if (!box) return null;
  const ticking = values[box.id] !== true;
  const input: Record<string, unknown> = { [box.id]: ticking };
  for (const a of tapAlsoOf(use)) {
    if (a.do !== 'set') continue;
    const field = collection.fields.find((f) => f.id === a.field);
    if (!field) continue;
    const value = actionInput(field, ticking ? a.value : null, ctx);
    if (value !== undefined) input[field.id] = value;
  }
  return input;
}

const isEmptyStored = (v: unknown) =>
  v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);

/**
 * Checking overwrites existing differing values with also (D-617): unchecking only clears and
 * cannot restore previous values, so App displays an undo banner this time (invariant 11). before
 * and after are stored values (before and after prepareRecordValues). Unchecking is excluded: it
 * clears values written during checking, and re-checking restores them.
 */
export function checkOverwrites(
  use: RecordToolUse,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (use.do !== 'toggle' || after[use.field] !== true) return false;
  return tapAlsoOf(use).some(
    (a) =>
      a.do === 'set' &&
      !isEmptyStored(before[a.field]) &&
      JSON.stringify(before[a.field]) !== JSON.stringify(after[a.field]),
  );
}

/**
 * Which button to display for this item (as a button, large circle block is a tap): the first
 * condition that evaluates to true (always if no conditions). view is the switched table
 * (conditions can use values from lookups).
 */
export function shownRowAction(
  uses: readonly ToolUse[] | undefined,
  record: DataRecord,
  view: Collection,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): ToolUse | undefined {
  return uses?.find(
    (u) =>
      (u.as === 'button' || u.as === 'tap') &&
      (u.when ?? []).every((cond) => matchesCondition(record, view, cond, now, cal)),
  );
}

export interface SetAllChange {
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * setAll: filters records whose values actually change, saving the stored values before and after
 * changes (using the pre-change values for undo). records are the computed records (filtering can
 * use lookup values); values calculated during write are stripped by prepareRecordValues. Records
 * that cannot be saved are skipped.
 */
export function setAllChanges(
  tool: Extract<RecordTool, { do: 'setAll' }>,
  collection: Collection,
  view: Collection,
  records: readonly DataRecord[],
  ctx: ActionContext,
): SetAllChange[] {
  const field = collection.fields.find((f) => f.id === tool.field);
  if (!field) return [];
  const cal = ctx.cal ?? DEFAULT_CALENDAR;
  const value = actionInput(field, tool.value, ctx);
  if (value === undefined) return [];
  const input = { [field.id]: value };
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? (field.type === 'checkbox' ? false : null)) ===
    JSON.stringify(b ?? (field.type === 'checkbox' ? false : null));
  const changes: SetAllChange[] = [];
  for (const r of records) {
    if (!(tool.filter ?? []).every((c) => matchesCondition(r, view, c, ctx.now, cal))) continue;
    const prepared: PreparedValues = prepareRecordValues(collection, input, r.values, ctx.now, cal);
    if (!prepared.ok || same(prepared.values[field.id], r.values[field.id])) continue;
    changes.push({ id: r.id, before: storedValues(collection, r.values), after: prepared.values });
  }
  return changes;
}

/**
 * Batch creation (D-567): generates a form input for a new record for each filtered source item
 * (computed records, filtering can use lookup values) in source order. "$row" refers to the
 * source item, and copies/date starts also read from it (D-565). The result is then passed to
 * prepareRecordValues.
 */
export function createAllInputs(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  target: Collection,
  sourceView: Collection,
  sources: readonly DataRecord[],
  ctx: ActionContext,
): { sourceId: string; input: Record<string, unknown> }[] {
  const cal = ctx.cal ?? DEFAULT_CALENDAR;
  return sources
    .filter((r) =>
      (tool.filter ?? []).every((c) => matchesCondition(r, sourceView, c, ctx.now, cal)),
    )
    .map((r) => ({
      sourceId: r.id,
      input: createInput(target, tool.values, {
        ...ctx,
        rowId: r.id,
        entry: { record: r, view: sourceView },
      }),
    }));
}

/** Check-and-create (D-616): sets values in values to "$row", a reference field pointing to the source table (checks to ensure exactly one exists). */
export function pickLinkFields(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  target: Collection,
): string[] {
  return Object.entries(tool.values)
    .filter(
      ([id, v]) =>
        v === ROW_REF &&
        target.fields.some((f) => f.id === id && f.type === 'link' && f.table === tool.from),
    )
    .map(([id]) => id);
}

/** Available sources to check in the source table (according to tool.filter, D-616): records are computed records (filtering can use lookup values). */
export function pickChoices(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  sourceView: Collection,
  sources: readonly DataRecord[],
  ctx: Pick<ActionContext, 'now' | 'cal'>,
): DataRecord[] {
  const cal = ctx.cal ?? DEFAULT_CALENDAR;
  return sources.filter((r) =>
    (tool.filter ?? []).every((c) => matchesCondition(r, sourceView, c, ctx.now, cal)),
  );
}

/** Whether a stored value equals the value for this segment ("$here"): multi-select checks if all are selected, and unselected checkboxes are treated as unchecked. */
function sameHere(stored: unknown, here: unknown): boolean {
  if (Array.isArray(here) && Array.isArray(stored)) return here.every((v) => stored.includes(v));
  if (typeof here === 'boolean') return (stored === true) === here;
  return JSON.stringify(stored ?? null) === JSON.stringify(here);
}

/**
 * Check-and-create (D-616): which sources are already linked in this segment (displayed as
 * "Added", not created again). targets are existing records in the target table, here is the
 * value of this segment (equality conditions in list filtering and this segment, same as
 * hereValues): only when every value matches is it considered part of this segment.
 */
export function pickedAlready(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  target: Collection,
  targets: readonly DataRecord[],
  here: Record<string, unknown>,
): Set<string> {
  const [link] = pickLinkFields(tool, target);
  const out = new Set<string>();
  if (!link) return out;
  for (const r of targets) {
    if (!Object.entries(here).every(([id, v]) => sameHere(r.values[id], v))) continue;
    const linked = r.values[link];
    for (const id of Array.isArray(linked) ? linked : [linked])
      if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

/**
 * Check-and-create (D-616): generates a form input for a new record for each source checked by
 * the user (in check order, skipping already added ones): combines the value of this segment with
 * values ("$row" is the checked item, and copies/date starts also read from it). The result is
 * then passed to prepareRecordValues.
 */
export function pickCreateInputs(
  tool: Extract<RecordTool, { do: 'createAll' }>,
  target: Collection,
  sourceView: Collection,
  picked: readonly DataRecord[],
  here: Record<string, unknown>,
  already: ReadonlySet<string>,
  ctx: ActionContext,
): { sourceId: string; input: Record<string, unknown> }[] {
  return picked
    .filter((r) => !already.has(r.id))
    .map((r) => ({
      sourceId: r.id,
      input: {
        ...here,
        ...createInput(target, tool.values, {
          ...ctx,
          rowId: r.id,
          entry: { record: r, view: sourceView },
        }),
      },
    }));
}

/** Values stored in the record (excluding computed fields: they exist in the computed record copy). */
export function storedValues(
  collection: Collection,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...values };
  for (const f of collection.fields) if (!fieldDefinition(f.type).write) delete out[f.id];
  return out;
}

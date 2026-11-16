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

// 一键记录工具（D-300–D-304，v34 NEW_FORMAT §5.2）：检查（validate.ts 调）、执行前算出要写的值（App 调）。
// 删字段删表时找出用到它的工具在 ops.ts。AI 只配置工具；值在用户点了以后才在本机写进记录。

/** increment 能用的字段（D-302）。 */
export const INCREMENT_FIELD_TYPES: readonly FieldType[] = ['number', 'money', 'duration'];

/** 每种字段能预设成什么（D-301）。不在这里的类型不能预设：文字是用户的内容，算出来的字段不能写。 */
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

/** 工具在哪、作用在什么上（检查用）。 */
export interface ToolWhere {
  /** 问题文字的开头，例如 `list l1 button "Done"`。 */
  label: string;
  /**
   * 工具作用的这一条（"$row"）是哪张表的：记录块的 source 表，提醒「完成」的 when.each.table。
   * 按钮、表单没有（它们写自己那张表，关系规则 12）。原样的表（不是换过查找的）。
   */
  rowOf?: Collection;
  /** 块所在页面给哪张表的一条记录用（D-342，page.of）："$record" 指那条记录。 */
  recordOf?: string;
  /** 表单块的提交（look form）：ask 是表单里问的字段。 */
  form?: boolean;
  /** 提醒的「完成」：在通知上点了直接做，不打开 Morph（不能 ask）。 */
  direct?: boolean;
  /** 看板的拖动：value "$group" 写进的字段（source.group.by）。 */
  dragField?: string;
}

interface ValueWhere extends ToolWhere {
  /** 是新建（create）：null 没有意义。 */
  creating?: boolean;
  /**
   * 「这一条」（D-565，换过的表：查找、汇总换成它们显示的那种字段）：抄的字段、日期的起点和加数从它读。
   * 工具作用的那一条（rowOf），没有时是记录页的那一条（recordOf）；setAll、表单和不在记录页上的按钮没有。
   */
  entry?: Collection;
}

const NEEDS_ENTRY =
  "needs this entry: it only works in a tool on each entry of a list, a reminder's done, or a button on a page for one entry";

/** 抄过来时字段的值是哪一种（换过的表里）：公式是数字，算出来的日期是日期，计数、连续这些汇总是数字。 */
function valueKind(f: Field): FieldType | undefined {
  if (f.type === 'formula' || f.type === 'rollup') return 'number';
  if (f.type === 'dateOffset') return 'date';
  if (f.type === 'lookup' || f.type === 'previous') return undefined;
  return f.type;
}

/** 不能用「抄」写进去的字段：文件归用户自己选（底线 3），日程是一整套规则。算出来的字段本来就写不进去。 */
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
        source.options.every((o) => target.options.some((x) => x.id === o.id))));
  return fits
    ? null
    : `${where.label}: can't copy ${entry.id}.${source.id} (${kind ?? source.type}) into ${name} (${target.type}); copy a field of the same type (number and money mix, text and note mix; a link to the same table; a choice whose options the target has)`;
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
  // 从今天或这一条起算的日期、抄这一条的字段（D-565）。
  if (isCopyValue(value)) return copyProblem(field, name, value, where);
  if (isDateValue(value)) return dateValueProblem(field, name, value, where);
  // 拖到的那一栏（看板）：只给拖动，写进分栏的字段。
  if (value === GROUP_REF)
    return where.dragField === fieldId
      ? null
      : `${where.label}: "${GROUP_REF}" (the column a card is dragged to) only works in a board's {as: "drag", do: "set", field: <source.group.by>}`;
  if (field.type === 'link') {
    const row =
      value === ROW_REF &&
      where.creating === true &&
      where.rowOf !== undefined &&
      field.table === where.rowOf.id;
    // D-342：给一条记录用的页面上，新建时引用字段可以设成这条记录。
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
  if (field.type === 'choice') {
    if (typeof value === 'string' && field.options.some((o) => o.id === value)) return null;
    return `${where.label}: ${name} is a choice field; the value must be one of its option ids (${field.options.map((o) => o.id).join(', ')}) or null`;
  }
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
  where: ToolWhere,
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
  // 必填、又没有默认值的字段：点一下存不进去。打开表单的（D-338）由用户填。
  if (ask !== undefined) return problems;
  for (const f of collection.fields) {
    const def = fieldDefinition(f.type);
    if (!('required' in f) || !f.required || !def.write || values?.[f.id] !== undefined) continue;
    const hasDefault = ('default' in f && f.default !== undefined) || def.emptyNew !== undefined;
    if (!hasDefault) {
      problems.push(
        `${where.label}: creates an entry in ${collection.id} but required field ${f.id} would be empty; preset it, make it not required, or add ask: "all" so the user fills in the rest`,
      );
    }
  }
  return problems;
}

/** smartDate（D-344，原 recordForm.smartDate）：只给表单，从问的一个文字字段认出日期，填进日期类字段。 */
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
 * 关系规则 12：块上的工具只能写块读的那张表（"$row" 是它的一条），或者在另一张表里新建一条、用引用字段
 * 连回这一条（"$row"）或记录页的那一条（"$record"）。按钮、表单没有 source，写自己那张表。
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

/** 一个一键记录工具的问题（文字发给 AI）。 */
export function recordToolProblems(
  tool: RecordTool,
  config: WorkspaceConfig,
  where: ToolWhere,
): string[] {
  const collection = config.data.tables.find((c) => c.id === tool.table);
  if (!collection) return [`${where.label}: data table ${tool.table} does not exist`];
  // 「这一条」（D-565）：工具作用的那一条，没有时是记录页的那一条；表单没有。
  const entryTable = where.form
    ? undefined
    : (where.rowOf ?? config.data.tables.find((c) => c.id === where.recordOf));
  if (entryTable)
    where = { ...where, entry: expandCollection(config.data.tables, entryTable) } as ValueWhere;
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
      // 一次改很多条，没有「这一条」：日期只能从今天算。
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
    case 'toggle': {
      const p = fieldProblem(collection, tool.field, where, ['checkbox'], 'toggle');
      return p ? [p] : [];
    }
    case 'increment': {
      const p = fieldProblem(collection, tool.field, where, INCREMENT_FIELD_TYPES, 'increment');
      if (p) return [p];
      // 加这一条的一个数字字段（D-565）。
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
 * 批量新建（D-567）：来源表要在，筛选按来源表检查（可以用 "$record"），值按新建检查，"$row" 和抄的字段都是来源的那一条。
 * 必填又没有默认值的字段要预设（没有表单可问）。提醒的「完成」不能用（它只改这一条）。
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
  const at: ValueWhere = { label: where.label, rowOf: source, entry: view };
  return [
    ...conditionProblems(tool.filter, view, where.recordOf).map((x) => `${where.label}: ${x}`),
    ...createProblems({ do: 'create', table: tool.table, values: tool.values }, collection, at),
  ];
}

/** 按钮上的字最长几个字（表单的提交 30，其余 20）。 */
export const toolLabelMax = (as: ToolUse['as']) => (as === 'submit' ? 30 : 20);

/**
 * 块上一个就地工具的问题：按出现方式（as）的要求、按钮上的字、when 条件，再加工具本身（recordToolProblems）。
 * 外观允许哪些 as、do、几个，在 validate.ts 按登记表查。
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
  if ((use.as === 'button' || use.as === 'tap') && use.label === undefined)
    problems.push(`${where.label}: needs a label (shown on the button and read by screen readers)`);
  // $here：就地添加（这一段的值 + 列表筛选里的等于条件）。
  const here = tool.do === 'create' && tool.values === HERE_REF;
  if (use.as === 'addHere' && (tool.do !== 'create' || !here || (row && tool.table !== row.id)))
    problems.push(
      `${where.label}: addHere adds an entry right in this section: {as: "addHere", do: "create", table: ${row?.id ?? '<the block table>'}, ask?: "all", values: "${HERE_REF}"}`,
    );
  else if (here && use.as !== 'addHere')
    problems.push(`${where.label}: values "${HERE_REF}" only works with as: "addHere"`);
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
      // 写的是日程的「上次完成」时，「为空才显示」会让按钮做过一次就消失，重复的事下次没法完成。
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
 * 点一下改几处（D-566）：只给每一条上的按钮和点一下（as button、tap）；顺带的改动改这一条，或者新建一条连回这一条；
 * 最多一条新建；同一个字段不改两次；不打开表单（几处一起成功或一起不做）。
 */
function alsoProblems(use: RecordToolUse, config: WorkspaceConfig, where: ToolWhere): string[] {
  const row = where.rowOf;
  const label = where.label;
  if ((use.as !== 'button' && use.as !== 'tap') || !row)
    return [
      `${label}: also only works on a button or tap on each entry (one tap, several changes to that entry)`,
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
  const fields = tool.do === 'create' || tool.do === 'createAll' ? [] : [tool.field];
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

// ---- 执行（App 在用户点了以后调）----

export interface ActionContext {
  now: Date;
  cal?: Calendar;
  /** 工具作用的这一条（"$row"）的 ID。 */
  rowId?: string;
  /** 记录页打开的那一条（"$record"）的 ID。 */
  recordId?: string;
  /** 拖到的那一栏（"$group"）：选项 ID、被引用的那条的 ID，null 是「未分」。 */
  group?: string | null;
  /**
   * 「这一条」（D-565）：算好的记录（公式、查找、汇总都有值）和换过的表。抄的字段、日期的起点和加数从它读；
   * 没有时这些值不写。
   */
  entry?: { record: DataRecord; view: Collection };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 工具里的值 → 表单输入（prepareRecordValues 再按字段严格检查）。null = 清空（勾选框是不勾）。
 * undefined = 这一项不写（D-565：读「这一条」的值，但没有这一条，或者日期的起点、加数没有值）。
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

/** {from, add, unit}（D-565）：从今天或这一条的日期起，加几天或几个月（和算出来的日期同一段算法）。 */
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
 * create：新记录的表单输入（只含预设的字段，其余由 prepareRecordValues 套默认值）。
 * values 是 "$here"（就地添加）时由 App 按这一段算，这里没有。
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
 * {do: "create", ask: "all", values}：打开的新记录表单里先填好的值（Q6：v33 的「添加」按钮忽略预设值，
 * v34 预填）。表已经不在了时为空。
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
 * set / toggle / increment：这一条记录（存着的值）要改成什么。字段已经不在了（旧配置）返回 null。
 * 结果再交给 prepareRecordValues。
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
  // 加这一条的一个数字字段（D-565）：没有值时什么都不改。
  const by =
    typeof tool.by === 'number' ? tool.by : ctx.entry ? entryValue(ctx, tool.by) : values[tool.by];
  if (typeof by !== 'number' || !Number.isFinite(by)) return {};
  const decimals = field.type === 'money' ? 2 : field.type === 'number' ? (field.decimals ?? 4) : 0;
  let next = round(current + by, decimals);
  // 时长不能是负数：减到 0 为止。
  if (field.type === 'duration') next = Math.max(0, next);
  return { [field.id]: next };
}

/**
 * 这一条显示哪个按钮（as button，大圆块是 tap）：第一个条件都满足的（没有条件就总是）。
 * view 是换过的表（条件可以用查找来的值）。
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
 * setAll：筛出来、值真的会变的记录，连同改前改后存的值（撤销用改前的）。records 是算好的记录
 * （筛选可以用查找来的值）；写的时候算出来的值会被 prepareRecordValues 去掉。存不进去的记录跳过。
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
 * 批量新建（D-567）：筛出来的每一条来源（算好的记录，筛选可以用查找来的值）各一份新记录的表单输入，按来源的顺序。
 * "$row" 是这条来源，抄的、日期起点也读它（D-565）。结果再交给 prepareRecordValues。
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

/** 记录里存着的值（去掉算出来的字段：算好的记录副本里有它们）。 */
export function storedValues(
  collection: Collection,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...values };
  for (const f of collection.fields) if (!fieldDefinition(f.type).write) delete out[f.id];
  return out;
}

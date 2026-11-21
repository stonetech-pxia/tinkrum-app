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

// 一键记录工具（D-300，v34 NEW_FORMAT §5.2）的写法。只放结构：块、提醒的定义引用它；
// 检查和执行在 record-ops.ts（会用到数据和筛选，块的定义不能引用，否则加载会绕圈）。
// v34：就地的工具（Q1）写在块的 tools[] 里，跟着块加、改、删；提醒的 done 也是一个一键记录工具。

/**
 * 写进日期字段的「从哪天起加几天、几个月」（D-565）：from 是 "today" 或「这一条」的一个日期、日期时间字段，
 * add 是整数或「这一条」的一个数字字段。和算出来的日期字段（D-542）同一种写法，同一段算法（data.ts 的 offsetDay）。
 */
export const DateValueSchema = z.strictObject({
  from: z.union([z.literal('today'), FieldRefSchema]),
  add: OffsetAddSchema,
  unit: OffsetUnitSchema,
});
export type DateValue = z.infer<typeof DateValueSchema>;

/**
 * 「这一条」的一个字段的值，在点的那一刻抄过来（D-565）。配置里只有字段 ID，没有内容（底线 14），AI 看不到值（底线 2）。
 * 「这一条」：工具作用的那一条（"$row"），没有时是记录页打开的那一条（"$record"）；批量新建时是来源表的每一条。
 */
export const CopyValueSchema = z.strictObject({ copy: IdSchema });
export type CopyValue = z.infer<typeof CopyValueSchema>;

/**
 * 工具里能写的值（D-301）：单选项 ID、数字、勾选（true / false）、"today"（日期字段）、"now"（时间、
 * 日期时间字段）、null（清空）；"$row" 是工具作用的那一条，"$record" 是记录页打开的那一条（D-342），
 * 都只给引用字段；"$group" 是拖到的那一栏（只给 drag）。按字段类型解释，不能写文字：文字是用户的内容（D-042）。
 * D-565 起还有：从今天或这一条的日期起加几天、几个月（DateValueSchema），和抄这一条的一个字段（CopyValueSchema）。
 * D-607：多选字段写一组选项 ID（替换原来选的）。
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
  // 多选字段的几个选项 ID（D-607）。
  z.array(IdSchema).min(1).max(50),
]);
export type RecordToolValue = z.infer<typeof RecordToolValueSchema>;
/** v33 的名字（同一个东西）。 */
export type RecordActionValue = RecordToolValue;
export const RecordActionValueSchema = RecordToolValueSchema;

/** 字段 ID → 预设值（≤20；表单 ≤10，检查在 record-ops.ts）。 */
export const RecordToolValuesSchema = z
  .record(IdSchema, RecordToolValueSchema)
  .refine((v) => Object.keys(v).length <= 20, 'at most 20 preset values');
export type RecordToolValues = z.infer<typeof RecordToolValuesSchema>;

/** 表单里问几个字段（原 recordForm.fieldIds），或者 "all" = 打开新记录的完整表单（原 create form:true、open）。 */
export const AskSchema = z.union([z.literal('all'), z.array(IdSchema).min(1).max(10)]);
export type Ask = z.infer<typeof AskSchema>;

const create = {
  do: z.literal('create'),
  table: IdSchema,
  /** 预设值；"$here" = 就地添加（这一段的值 + 列表筛选里的等于条件，原 addHere）。 */
  values: z.union([RecordToolValuesSchema, z.literal(HERE_REF)]).optional(),
  /** 不写：直接存（原 create）；"all"：完整表单、预设值先填好；[字段]：表单块里问这几个（只给 look form）。 */
  ask: AskSchema.optional(),
  /** 在本机认出文字里说的日期（D-344）：from 是 ask 里的一个文字字段，to 是日期、日期时间或日程字段。 */
  smartDate: z.strictObject({ from: IdSchema, to: IdSchema }).optional(),
};
const set = {
  do: z.literal('set'),
  table: IdSchema,
  field: IdSchema,
  value: RecordToolValueSchema,
};
const toggle = { do: z.literal('toggle'), table: IdSchema, field: IdSchema };
/** 加几：固定的数，或这一条的一个数字字段（D-565）。 */
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

/** 点一下最多改几处（D-566，创始人 2026-11-16 ③）：工具本身加 also 里的。 */
export const MAX_TAP_WRITES = 3;

/**
 * 点一下顺带的改动（D-566）：改这一条（set、toggle、increment，表就是这一条的表，不用写），或者新建一条、
 * 用引用字段连回这一条（"$row"）。没有 ask、没有 setAll、没有嵌套，也不能引用别的工具（底线 9）。
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
 * 批量新建（D-567，创始人 2026-11-16 ④）：from 表里筛出来的每一条，在 table 里新建一条。values 里 "$row" 是来源的那一条
 * （只给指向 from 的引用字段），抄的也是它的字段（D-565）。先问，最多 MAX_CREATE_ALL 条，引擎一条一条做，
 * 配置里没有循环（底线 9）；做完提示条能一次撤回这一批（底线 11）。
 */
const createAll = {
  do: z.literal('createAll'),
  table: IdSchema,
  from: IdSchema,
  filter: filterSchema().optional(),
  values: RecordToolValuesSchema,
  /**
   * 勾选新建（D-616）：来源不是筛出来的每一条，而是用户这次在来源表里勾的几条（filter 只决定能勾哪些）。
   * 只给列表下面的「添加」（as addHere）：每条新记录还带上这一段的值（"$here"：列表筛选里的等于条件、这一段），
   * 这一段里已经连着的来源显示成「已添加」，不再建一次。照样先问、最多 MAX_CREATE_ALL 条、提示条能撤回这一批。
   */
  pick: z.literal(true).optional(),
};

/**
 * 把这一条移到「最近删除」（D-610，创始人 2026-11-20）：和用户自己删一样是软删除（30 天内能找回），做完提示条上有撤销
 * （底线 11）。这一版只给打卡格（look grid）上的点一下：格子里正好一条时点一下删掉它；别处一律拒绝（record-ops.ts）。
 */
const remove = { do: z.literal('remove'), table: IdSchema };

/** 一键记录的 7 种（关系规则 7；remove 是 D-610 加的）。 */
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

/** setAll 一次最多改几条（D-303）。 */
export const MAX_SET_ALL = 200;
/** createAll 一次最多新建几条（D-567，和 setAll 一样）。 */
export const MAX_CREATE_ALL = 200;

/**
 * 块上的工具出现在哪（关系规则 4）：submit 表单的提交、button 每一条右边的按钮（≤3，显示第一个 when 满足的）、
 * check 清单的勾、tap 点一下（大圆块）、drag 拖到另一栏、addHere 每段 / 选中那天 / 每栏下面的「添加」、
 * list 列表上方的按钮（≤3，运行快捷操作，把列表现在选出的记录交给它，D-428）。
 * 不写 as：块本身被点时做（button、action、picker）。
 */
export const TOOL_USE_AS = ['submit', 'button', 'check', 'tap', 'drag', 'addHere', 'list'] as const;
export type ToolUseAs = (typeof TOOL_USE_AS)[number];

/** 内核的「打开相册 / 打开文件」（原 filePick），选完进收件页面，绝不自动运行。 */
export const PICK_TOOLS = ['$pick.media', '$pick.files', '$pick.open'] as const;
export type PickTool = (typeof PICK_TOOLS)[number];

const useBase = {
  as: z.enum(TOOL_USE_AS).optional(),
  /** 按钮上的字（submit ≤30，其余 ≤20，检查在 record-ops.ts）。 */
  label: boundedText(1, 30).optional(),
  /** 这一条满足这些条件时才显示（例如结束时间为空时显示「下班」）；条件只读数据（关系规则 5）。 */
  when: z.array(ConditionSchema).max(3).optional(),
};

/**
 * 块怎么引用工具（NEW_FORMAT §3.4）：
 * - 引用一个独立的工具：tools[] 里的快捷操作（找不到时按内设快捷操作的 ID 找）、或者内核的 $pick.*；
 * - 就地的一键记录工具（Q1）；
 * - 行上的「打开」：导航到这一条的编辑页（"record"）或记录页（页面 ID），不是工具。
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
/** 就地的一键记录工具（带出现方式）。 */
export type RecordToolUse = Extract<ToolUse, { do: string }>;
export type ToolRefUse = Extract<ToolUse, { tool: string }>;
export type OpenUse = Extract<ToolUse, { opens: string }>;

export const isRecordToolUse = (u: ToolUse): u is RecordToolUse => 'do' in u;
export const isToolRefUse = (u: ToolUse): u is ToolRefUse => 'tool' in u;
export const isOpenUse = (u: ToolUse): u is OpenUse => 'opens' in u;

/** 一个就地工具去掉出现方式，剩下的一键记录工具本身。 */
export function recordToolOf(use: RecordToolUse): RecordTool {
  const { as: _as, label: _label, when: _when, ...rest } = use;
  const { also: _also, ...tool } = rest as typeof rest & { also?: unknown };
  return tool as RecordTool;
}

/** 一个就地工具顺带的改动（D-566）；没有时是空的。 */
export const tapAlsoOf = (use: RecordToolUse): readonly TapAlso[] =>
  ('also' in use ? use.also : undefined) ?? [];

/**
 * 点一下要做的几处，按顺序，工具本身在最前（D-566）。also 里改这一条的写成这一条那张表（工具本身的表；
 * 工具本身是新建时，是它连回的那张表，由检查保证），新建的照原样。
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

/** 一个值读「这一条」的哪些字段（D-565）：抄的字段、日期的起点和加数。 */
export function valueEntryFields(v: unknown): string[] {
  if (isCopyValue(v)) return [v.copy];
  if (!isDateValue(v)) return [];
  return [...(v.from === 'today' ? [] : [v.from]), ...(typeof v.add === 'string' ? [v.add] : [])];
}

/** 一键记录工具读「这一条」的哪些字段（D-565）：App 只在有的时候才先算好这一条。 */
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
    // 批量新建读的是来源表的每一条，不是「这一条」（record-ops.ts 的 createAllInputs 自己算）。
    case 'createAll':
    case 'remove':
      return [];
  }
}

export const toolReadsEntry = (tool: RecordTool) => toolEntryFields(tool).length > 0;

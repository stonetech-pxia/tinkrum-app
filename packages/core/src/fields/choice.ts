import { z } from 'zod';

import { t } from '../messages';
import { OPTION_COLOR_NAMES } from '../option-colors';
import { IdSchema, boundedText } from '../schema-primitives';
import { defineField, fieldBase, type FieldDefinitionOf } from './define';

/**
 * 一个选项。D-568：value 是这个选项代表的数（给公式读；排序、统计不看它），color 是一个有名字的颜色
 * （option-colors.ts；按值上色、月历、饼图用它，没写的照旧按顺序取色）。
 */
export const ChoiceOptionSchema = z.strictObject({
  id: IdSchema,
  label: boundedText(1, 40),
  value: z.number().finite().optional(),
  color: z.enum(OPTION_COLOR_NAMES).optional(),
});

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('choice'),
  options: z.array(ChoiceOptionSchema).min(1).max(50),
  /** 可以选多个（D-607）：存的值是选项 ID 的列表。 */
  multiple: z.literal(true).optional(),
  /** 一个选项 ID；多选时也可以是几个。 */
  default: z.union([IdSchema, z.array(IdSchema).min(1).max(50)]).optional(),
});

type ChoiceField = z.infer<typeof schema>;

const isOption = (f: { options: { id: string }[] }, v: unknown) =>
  typeof v === 'string' && f.options.some((o) => o.id === v);

/** 多选字段（D-607）。 */
export const isMultipleChoice = (f: { type: string; multiple?: true | undefined } | undefined) =>
  f?.type === 'choice' && f.multiple === true;

/**
 * 存着的值里还在的选项，按选项顺序：多选存的是列表，改成多选以前存的是一个 ID（当作一项）；删掉的选项不算。
 */
export function pickedOptions(f: { options: { id: string }[] }, raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  return f.options.filter((o) => list.includes(o.id)).map((o) => o.id);
}

/** 说给 AI 听：多选字段不是一个值，不能用在只认一个选项的地方（D-607）。 */
export const MULTIPLE_CHOICE_NOT_ONE = 'picks several options, so it is not one value';

/**
 * 单选：值是选项 ID；按选项顺序排序，统计可以按它分组（D-248）。
 * 多选（multiple，D-607）：值是选项 ID 的列表（按选项顺序，空列表 = 没选）；按选的第一个排序；筛选 is 是「含有」，
 * isNot 是「不含」；分组时一条记录算进它选的每一项。单选字段里存着列表（多选改回单选的撤销、恢复旧版本）时
 * 只显示，读、筛选、分组都当没选，存别的字段时原样留着（data.ts prepareRecordValues）。
 */
export const choiceField: FieldDefinitionOf<'choice', typeof schema> = defineField({
  type: 'choice',
  schema,
  label: ['单选', 'choice'],
  read: (f, raw) => {
    if (f.multiple) {
      const picked = pickedOptions(f, raw);
      return picked.length > 0 ? picked : undefined;
    }
    return isOption(f, raw) ? (raw as string) : undefined;
  },
  shown: (f, raw) => {
    if (!f.multiple && !Array.isArray(raw)) return isOption(f, raw) ? (raw as string) : undefined;
    const picked = pickedOptions(f, raw);
    return picked.length > 0 ? picked : undefined;
  },
  write: (f, input) => {
    if (!f.multiple) return isOption(f, input) ? { value: input as string } : { issue: 'invalid' };
    const list: unknown[] = Array.isArray(input) ? input : [input];
    if (!list.every((v) => isOption(f, v))) return { issue: 'invalid' };
    const picked = pickedOptions(f, list);
    return { value: picked.length > 0 ? picked : '' };
  },
  format: (f, v, locale) =>
    pickedOptions(f, v)
      .map((id) => f.options.find((o) => o.id === id)!.label)
      .join(t(locale, 'separatorList')),
  // 多选：is / isNot 的值也是一个选项 ID（列表只给 is，conditions.ts）。
  filter: { is: isOption },
  // 多选按选的第一个排。
  sort: (f, v) => f.options.findIndex((o) => o.id === pickedOptions(f, v)[0]),
  // D-569：公式里是选中的选项的 value；没选、选的选项没有 value 时没有值（和空着的数字一样）。
  formula: 'number',
  formulaNumber: (f, v) => (f.multiple ? undefined : f.options.find((o) => o.id === v)?.value),
  formulaProblem: (f) =>
    f.multiple
      ? `a choice field that ${MULTIPLE_CHOICE_NOT_ONE} (not one number); a formula can't use it`
      : f.options.some((o) => o.value !== undefined)
        ? undefined
        : `a choice field where none of its options has a value; give the options the numbers they stand for, e.g. options: [{id: "monthly", label: "Monthly", value: 12}]`,
  titleRank: 3,
  check: (f, { collection }) => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const o of f.options) (seen.has(o.id) ? dup : seen).add(o.id);
    const at = `${collection.id}.${f.id}`;
    return [
      ...[...dup].map((id) => ({ code: 'duplicate', message: `option ${id} in ${at}` })),
      ...defaultProblems(f).map((message) => ({ code: 'data', message: `${at}: ${message}` })),
    ];
  },
  ai: {
    doc: `{options: [{id, label, value?: a number the option stands for (e.g. high = 3, monthly = 12), color?: ${OPTION_COLOR_NAMES.join(' | ')}}] (1-50), multiple?: true (several options per entry, rule 68), default?: optionId (multiple: a list of option ids)} (color is how the option is drawn wherever entries are coloured by this field; options without it take colours by their order)`,
  },
  example: {
    id: 'category',
    name: 'Category',
    type: 'choice',
    options: [
      { id: 'food', label: 'Food', value: 1 },
      { id: 'other', label: 'Other' },
    ],
  },
  exampleValue: 'food',
});

/** 默认值：单选是一个选项；多选可以是几个，不重复。 */
function defaultProblems(f: ChoiceField): string[] {
  const d = f.default;
  if (d === undefined) return [];
  if (Array.isArray(d) && !f.multiple)
    return ['default is a list, but only a field with multiple: true picks several options'];
  const ids = [d].flat();
  const missing = ids.filter((id) => !isOption(f, id));
  if (missing.length > 0) return [`default ${missing.join(', ')} is not an option`];
  if (new Set(ids).size < ids.length) return ['default lists an option more than once'];
  return [];
}

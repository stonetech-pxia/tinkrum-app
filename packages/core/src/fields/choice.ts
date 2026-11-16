import { z } from 'zod';

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
  default: IdSchema.optional(),
});

const isOption = (f: { options: { id: string }[] }, v: unknown) =>
  typeof v === 'string' && f.options.some((o) => o.id === v);

/** 单选：值是选项 ID；按选项顺序排序，统计可以按它分组（D-248）。 */
export const choiceField: FieldDefinitionOf<'choice', typeof schema> = defineField({
  type: 'choice',
  schema,
  label: ['单选', 'choice'],
  read: (f, raw) => (isOption(f, raw) ? (raw as string) : undefined),
  write: (f, input) => (isOption(f, input) ? { value: input as string } : { issue: 'invalid' }),
  format: (f, v) => f.options.find((o) => o.id === v)?.label ?? '',
  filter: { is: isOption },
  sort: (f, v) => f.options.findIndex((o) => o.id === v),
  // D-569：公式里是选中的选项的 value；没选、选的选项没有 value 时没有值（和空着的数字一样）。
  formula: 'number',
  formulaNumber: (f, v) => f.options.find((o) => o.id === v)?.value,
  formulaProblem: (f) =>
    f.options.some((o) => o.value !== undefined)
      ? undefined
      : `a choice field where none of its options has a value; give the options the numbers they stand for, e.g. options: [{id: "monthly", label: "Monthly", value: 12}]`,
  titleRank: 3,
  check: (f, { collection }) => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const o of f.options) (seen.has(o.id) ? dup : seen).add(o.id);
    return [
      ...[...dup].map((id) => ({
        code: 'duplicate',
        message: `option ${id} in ${collection.id}.${f.id}`,
      })),
      ...(f.default !== undefined && !f.options.some((o) => o.id === f.default)
        ? [
            {
              code: 'data',
              message: `${collection.id}.${f.id}: default ${f.default} is not an option`,
            },
          ]
        : []),
    ];
  },
  ai: {
    doc: `{options: [{id, label, value?: a number the option stands for (e.g. high = 3, monthly = 12), color?: ${OPTION_COLOR_NAMES.join(' | ')}}] (1-50), default?: optionId} (color is how the option is drawn wherever entries are coloured by this field; options without it take colours by their order)`,
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

import { z } from 'zod';

import { isValidDate } from '../field-values';
import { localeTag } from '../localization';
import { FieldRefSchema, IdSchema, boundedText } from '../schema-primitives';
import { defineField, isText, type FieldDefinitionOf } from './define';

const schema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  type: z.literal('dateOffset'),
  /** 从哪个日期算：这张表的日期、日期时间字段，或 createdAt / updatedAt。 */
  from: FieldRefSchema,
  /** 加几（负数是往前）：固定的整数，或这条记录的一个数字字段。 */
  add: z.union([z.number().int().min(-36_500).max(36_500), IdSchema]),
  unit: z.enum(['days', 'months']),
});

const SYSTEM = ['createdAt', 'updatedAt'];

/**
 * D-542：算出来的日期 = from 那天加 add 天或 add 个月（月份加完超过那个月的最后一天时取最后一天）。
 * 不存进记录、不能填（底线 14），值在 data.ts 的 recordValue 里算；按日期显示、筛选、排序。
 */
export const dateOffsetField: FieldDefinitionOf<'dateOffset', typeof schema> = defineField({
  type: 'dateOffset',
  schema,
  label: ['算出来的日期', 'computed date'],
  read: () => undefined,
  shown: (_f, raw) => (typeof raw === 'string' && isValidDate(raw) ? raw : undefined),
  format: (_f, v, locale) =>
    locale === 'fr'
      ? new Intl.DateTimeFormat(localeTag(locale)).format(new Date(`${v}T12:00:00`))
      : String(v),
  inForm: false,
  filter: { is: isText, compare: 'date', period: true },
  day: (_f, v) => String(v),
  check: (f, { collection }) => {
    const problems: string[] = [];
    const from = collection.fields.find((x) => x.id === f.from);
    if (!SYSTEM.includes(f.from) && from?.type !== 'date' && from?.type !== 'datetime')
      problems.push(`from ${f.from} must be a date or datetime field of ${collection.id}`);
    if (typeof f.add === 'string') {
      const add = collection.fields.find((x) => x.id === f.add);
      if (add?.type !== 'number')
        problems.push(`add ${f.add} must be a whole number or a number field of ${collection.id}`);
    }
    return problems.map((message) => ({
      code: 'data',
      message: `${collection.id}.${f.id}: ${message}`,
    }));
  },
  ai: {
    doc: '{from: a date or datetime field (or createdAt), add: a whole number or a number field id, unit: "days"|"months"} (computed, never typed in: from + add days or months, a month end clamps, e.g. an expiry date = start + term in months; shown, filtered (inPeriod, gt / lt, isEmpty) and sorted like a date)',
  },
  example: { id: 'ends', name: 'Ends', type: 'dateOffset', from: 'date', add: 30, unit: 'days' },
});

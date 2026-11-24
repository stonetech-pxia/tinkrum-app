import { z } from 'zod';

import { formatMoney } from '../field-values';
import { CURRENCY_OPTION } from '../money-currency';
import { MULTIPLE_CHOICE_NOT_ONE } from './choice';
import { IdSchema } from '../schema-primitives';
import {
  defineField,
  fieldBase,
  isNumber,
  rangeKeys,
  rangeProblems,
  readNumber,
  writeNumber,
  type FieldDefinitionOf,
} from './define';

const schema = z.strictObject({
  ...fieldBase,
  type: z.literal('money'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO code like CNY'),
  /** Select a separate currency for each entry (D-429): single-select field in the same table where option IDs are lowercase currency codes; uses currency when unselected. */
  currencyField: IdSchema.optional(),
  default: z.number().finite().optional(),
  ...rangeKeys,
});

/** Money: two decimal places, displayed according to currency. */
export const moneyField: FieldDefinitionOf<'money', typeof schema> = defineField({
  type: 'money',
  schema,
  label: ['金额', 'money'],
  read: readNumber,
  write: (_f, input) => writeNumber(input, 2),
  format: (f, v, locale) => formatMoney(v as number, f.currency, locale),
  csv: (_f, v) => (v as number).toFixed(2),
  formatAmount: (f, n, locale) => formatMoney(n, f.currency, locale),
  print: {
    numeric: true,
    total: { rank: 1, format: (f, sum, locale) => formatMoney(sum, f.currency, locale) },
  },
  formula: 'number',
  numeric: true,
  filter: { is: isNumber, compare: 'number' },
  titleRank: 5,
  convertGroup: 'number',
  check: (f, { collection }) => {
    const range = rangeProblems(f, collection.id);
    if (f.currencyField === undefined) return range;
    const at = `${collection.id}.${f.id}`;
    const source = collection.fields.find((x) => x.id === f.currencyField);
    if (source?.type !== 'choice')
      return [
        ...range,
        {
          code: 'data',
          message: `${at}: currencyField ${f.currencyField} must be a choice field of ${collection.id}`,
        },
      ];
    if (source.multiple)
      return [
        ...range,
        {
          code: 'data',
          message: `${at}: currencyField ${source.id} ${MULTIPLE_CHOICE_NOT_ONE}; an entry has one currency`,
        },
      ];
    const bad = source.options.filter((o) => !CURRENCY_OPTION.test(o.id)).map((o) => o.id);
    return bad.length > 0
      ? [
          ...range,
          {
            code: 'data',
            message: `${at}: every option id of ${source.id} must be a lowercase currency code like usd; not ${bad.join(', ')}`,
          },
        ]
      : range;
  },
  ai: {
    doc: '{currency: ISO code like "CNY"/"USD", currencyField?: id of a choice field of this table whose option ids are lowercase currency codes (usd, eur), labels the codes in capitals, so each entry picks its own currency; currency is used when none is picked, default?, min?, max?}',
  },
  example: { id: 'amount', name: 'Amount', type: 'money', currency: 'USD' },
  exampleValue: 12.5,
});

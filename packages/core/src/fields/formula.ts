import { z } from 'zod';

import { formatMoney } from '../field-values';
import { hasRecordCurrency } from '../money-currency';
import { MAX_FORMULA_LENGTH, formulaType, parseFormula } from '../formula';
import type { Collection } from '../schema';
import { IdSchema, boundedText, type Locale } from '../schema-primitives';
import { defineField, isNumber, numberWithUnit, type FieldDefinitionOf } from './define';
// Used only during checks (retrieved at runtime), avoiding circular references during loading.
import { fieldDefinition } from './index';

const schema = z.strictObject({
  id: IdSchema,
  name: boundedText(1, 40),
  type: z.literal('formula'),
  expression: boundedText(1, MAX_FORMULA_LENGTH),
  decimals: z.number().int().min(0).max(4).optional(),
  unit: boundedText(1, 10).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be an ISO code like CNY')
    .optional(),
  /**
   * Treat empty numbers as 0 (D-619): when omitted, works as before, and formulas have no value
   * if any referenced field is empty. Applies only to numbers (numbers, amounts, ratings,
   * durations, checkboxes, single-select values, other formulas, numeric lookups and rollups);
   * empty dates and times still have no value, and division by zero still has no value.
   */
  empty: z.literal('zero').optional(),
});

const show = (f: z.infer<typeof schema>, n: number, locale: Locale) =>
  f.currency ? formatMoney(n, f.currency, locale) : numberWithUnit(n, f, locale);

/**
 * D-188: Formulas, calculated from number, amount, rating, and date fields in the same table
 * (arithmetic operations, if, days), not stored in records, non-fillable. Referenced fields must
 * be in this table and usable in formulas (defined formula), and the result must be a number
 * (D-247). Starting from D-280, time fields and min / max / round / abs can also be used;
 * starting from D-281, other formulas can be referenced without creating circular loops.
 */
export const formulaField: FieldDefinitionOf<'formula', typeof schema> = defineField({
  type: 'formula',
  schema,
  label: ['公式', 'formula'],
  read: () => undefined,
  shown: (_f, raw) => (typeof raw === 'number' ? raw : undefined),
  format: (f, v, locale) => show(f, v as number, locale),
  csv: (_f, v) => String(v),
  formatAmount: (f, n, locale) => show(f, n, locale),
  formula: 'number',
  numeric: true,
  inForm: false,
  filter: { is: isNumber, compare: 'number' },
  // Lookups, rollups, and previous values (D-287-D-289) are calculated based on the type of field they display.
  check: (f, { collection, view }) =>
    [
      ...formulaProblems(f.id, f.expression, view),
      ...(f.empty === 'zero' && !readsNumber(f.expression, view)
        ? [
            'empty "zero" only changes number fields that are empty, and this formula reads none; leave it out',
          ]
        : []),
      // D-429: Result indicates a currency, but the read amounts vary per entry.
      ...(f.currency === undefined
        ? []
        : [...f.expression.matchAll(/\{([^}]+)\}/g)]
            .filter((m) => hasRecordCurrency(view.fields.find((x) => x.id === m[1])))
            .map((m) => `currency can't be set: ${m[1]} has its own currency on each entry`)),
    ].map((problem) => ({
      code: 'data',
      message: `${collection.id}.${f.id}: ${problem}`,
    })),
  ai: {
    doc: '{expression, decimals? 0-4, unit?, currency?, empty?: "zero"} (computed, never typed in: + - * / and parentheses over {fieldId} of number, money, rating, duration, checkbox (1 or 0), choice (the value of the chosen option; rule 32) or other formula fields of the same table, e.g. "{price} * {qty}"; an empty field leaves the result empty unless empty: "zero" (rule 73); no required/default)',
  },
  example: {
    id: 'total',
    name: 'Total',
    type: 'formula',
    expression: '{weight} * 2',
    decimals: 1,
    unit: 'kg',
  },
});

/** Whether a formula reads numbers (D-619 empty "zero" only applies to numbers): at least one referenced field is numeric in the formula. */
function readsNumber(expression: string, collection: Collection): boolean {
  const parsed = parseFormula(expression);
  if (!parsed.ok) return true;
  return parsed.refs.some((id) => {
    const ref = collection.fields.find((f) => f.id === id);
    return ref !== undefined && fieldDefinition(ref.type).formula === 'number';
  });
}

function formulaProblems(fieldId: string, expression: string, collection: Collection): string[] {
  const { fields } = collection;
  const parsed = parseFormula(expression);
  if (!parsed.ok) return [`formula "${expression}": ${parsed.error}`];
  const kind = (id: string) => {
    const ref = fields.find((f) => f.id === id);
    return ref && fieldDefinition(ref.type).formula;
  };
  const problems: string[] = [];
  for (const id of parsed.refs) {
    if (!fields.some((f) => f.id === id))
      problems.push(`formula uses ${id}, which is not a field of ${collection.id}`);
    else if (!kind(id))
      problems.push(
        `formula uses ${id}, which is not a number, money, rating, duration, checkbox, choice, date, time, datetime or formula field`,
      );
    else {
      // D-569: Single-selects must have options with values to be calculable.
      const ref = fields.find((f) => f.id === id)!;
      const missing = fieldDefinition(ref.type).formulaProblem?.(ref);
      if (missing) problems.push(`formula uses ${id}, ${missing}`);
    }
  }
  if (problems.length > 0) return problems;
  const type = formulaType(parsed.node, (id) => kind(id) ?? null);
  if (typeof type !== 'string') return [`formula "${expression}": ${type.error}`];
  if (type !== 'number')
    return [
      `formula "${expression}" gives a ${type}; use ${type === 'date' ? 'days(from, to)' : 'hours(from, to) or minutes(from, to)'} to get a number`,
    ];
  const loop = formulaLoop(fieldId, collection);
  if (loop)
    return [
      `formula uses itself through ${loop.join(' → ')}; a formula can use other formulas but never one that comes back to it`,
    ];
  return [];
}

/** D-281: Starting from this formula and following referenced formulas, returns the loop (field IDs) if it can return to itself, otherwise null. */
function formulaLoop(start: string, collection: Collection): string[] | null {
  const refsOf = (id: string): string[] => {
    const f = collection.fields.find((x) => x.id === id);
    if (f?.type !== 'formula') return [];
    const parsed = parseFormula(f.expression);
    return parsed.ok ? parsed.refs : [];
  };
  const seen = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    for (const next of refsOf(id)) {
      if (next === start) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

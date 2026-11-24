import type { Collection, Field } from './schema';

// Select currency per entry individually (D-429): amount remains a number, currency is the value of
// a single-choice field in the same table, and the amount field points to it via currencyField.
// Option IDs are lowercase currency codes (usd, eur). When unselected for a record, the amount
// field's own currency is used. No conversion: different currencies are not added together.

/** Option IDs must match this format to be valid currency codes. */
export const CURRENCY_OPTION = /^[a-z]{3}$/;

export const hasRecordCurrency = (f: Field | undefined): boolean =>
  f?.type === 'money' && f.currencyField !== undefined;

/** Currency code (uppercase) for this amount in this record. */
export function recordCurrency(
  field: Extract<Field, { type: 'money' }>,
  values: Readonly<Record<string, unknown>>,
  collection: Collection,
): string {
  if (field.currencyField === undefined) return field.currency;
  const source = collection.fields.find((f) => f.id === field.currencyField);
  const id = values[field.currencyField];
  return source?.type === 'choice' &&
    typeof id === 'string' &&
    CURRENCY_OPTION.test(id) &&
    source.options.some((o) => o.id === id)
    ? id.toUpperCase()
    : field.currency;
}

/** Field used when displaying a record's amount: currency is replaced with the record's own. Other fields are returned as-is. */
export function fieldForRecord<F extends Field>(
  field: F,
  values: Readonly<Record<string, unknown>>,
  collection: Collection,
): F {
  return field.type === 'money' && field.currencyField !== undefined
    ? { ...field, currency: recordCurrency(field, values, collection) }
    : field;
}

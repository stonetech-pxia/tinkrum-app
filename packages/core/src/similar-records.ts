import type { DataRecord } from './data';
import { recordCurrency } from './money-currency';
import { conceptOf, type ConceptId } from './prefill/concepts';
import { withDocKind } from './prefill/doc-context';
import type { Collection, Field } from './schema';

// Before saving a new record, checks whether there is a seemingly identical entry in this table
// (D-426). Looks only at prefillRules on the table (D-421): receipts compare amount and date,
// business cards compare phone and email; compares nothing if this parameter is missing. Pure
// function, runs locally only; results are only used for a prompt, saving is never blocked, and
// records are never merged or deleted (invariants 5, 19).

/** Phones need at least this many digits to count ("extension 123" does not count), compares only the last N digits (area code format differences still match). */
const PHONE_MIN_DIGITS = 7;
const PHONE_TAIL_DIGITS = 9;

const text = (v: unknown) => (typeof v === 'string' ? v.normalize('NFKC') : '');

/** Name: case-insensitive, spaces ignored. */
const nameKey = (v: unknown) => text(v).replace(/\s+/g, '').toLowerCase();

const emailKey = (v: unknown) => text(v).trim().toLowerCase();

const phoneKey = (v: unknown) => text(v).replace(/\D/g, '');

function samePhone(a: string, b: string): boolean {
  if (a.length < PHONE_MIN_DIGITS || b.length < PHONE_MIN_DIGITS) return false;
  const n = Math.min(a.length, b.length, PHONE_TAIL_DIGITS);
  return a.slice(-n) === b.slice(-n);
}

/** Amount (cents): number, or a text field containing a single number; anything else counts as none. */
function amountKey(v: unknown): number | null {
  const n =
    typeof v === 'number'
      ? v
      : /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(text(v))
        ? Number(text(v).replace(',', '.'))
        : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Date (YYYY-MM-DD, date-time extracts that day): other formats count as none. */
const dayKey = (v: unknown) => /^\d{4}-\d{2}-\d{2}/.exec(text(v))?.[0] ?? null;

const conceptField = (f: Field) => ({
  id: f.id,
  name: f.name,
  format: f.type === 'text' ? f.format : undefined,
});

function fieldsOf(collection: Collection, concepts: readonly ConceptId[]): Field[] {
  return collection.fields.filter((f) => {
    const concept = conceptOf(conceptField(f));
    return concept !== null && concepts.includes(concept);
  });
}

function receiptMatcher(collection: Collection) {
  const fields = collection.fields;
  const amount =
    fieldsOf(collection, ['amount']).find((f) => f.type !== 'formula') ??
    fields.find((f) => f.type === 'money' && conceptOf(conceptField(f)) !== 'tax');
  const notOther = (f: Field) => {
    const concept = conceptOf(conceptField(f));
    return concept !== 'dueDate' && concept !== 'signDate';
  };
  const date =
    fieldsOf(collection, ['issueDate'])[0] ??
    fields.find((f) => (f.type === 'date' || f.type === 'datetime') && notOther(f));
  if (!amount || !date) return null;
  const parties = fieldsOf(collection, ['merchant', 'company']);
  const partyOf = (values: Record<string, unknown>) =>
    parties.map((f) => nameKey(values[f.id])).find(Boolean) ?? '';
  return (values: Record<string, unknown>) => {
    const money = amountKey(values[amount.id]);
    const day = dayKey(values[date.id]);
    const party = partyOf(values);
    if (money === null || day === null) return () => false;
    return (other: Record<string, unknown>) => {
      if (amountKey(other[amount.id]) !== money || dayKey(other[date.id]) !== day) return false;
      // D-429: $100 and €100 are not the same transaction.
      if (
        amount.type === 'money' &&
        recordCurrency(amount, values, collection) !== recordCurrency(amount, other, collection)
      )
        return false;
      const theirs = partyOf(other);
      return !party || !theirs || party === theirs;
    };
  };
}

function cardMatcher(collection: Collection) {
  const phones = fieldsOf(collection, ['phone']);
  const emails = fieldsOf(collection, ['email']);
  if (phones.length === 0 && emails.length === 0) return null;
  const list = (fields: readonly Field[], key: (v: unknown) => string, values: object) =>
    fields.map((f) => key((values as Record<string, unknown>)[f.id])).filter(Boolean);
  return (values: Record<string, unknown>) => {
    const myPhones = list(phones, phoneKey, values);
    const myEmails = list(emails, emailKey, values);
    return (other: Record<string, unknown>) =>
      list(phones, phoneKey, other).some((p) => myPhones.some((m) => samePhone(m, p))) ||
      list(emails, emailKey, other).some((e) => myEmails.includes(e));
  };
}

/**
 * values are the values to be stored (after prepareRecordValues), records are the records of this
 * table. Returns seemingly identical records (preserving original order). Records in the trash
 * are not counted; empty values never match.
 */
export function findSimilarRecords<R extends DataRecord & { deletedAt?: number | null }>(
  collection: Collection,
  values: Record<string, unknown>,
  records: readonly R[],
): R[] {
  const rules = collection.prefillRules;
  if (!rules) return [];
  return withDocKind(rules, () => {
    const matcher = rules === 'receipt' ? receiptMatcher(collection) : cardMatcher(collection);
    if (!matcher) return [];
    const matches = matcher(values);
    return records.filter((r) => r.deletedAt == null && matches(r.values));
  });
}

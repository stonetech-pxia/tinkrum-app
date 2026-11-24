import {
  fieldNameKey,
  MAX_SUGGESTIONS,
  pageOccurrences,
  ruleEngine,
  type PrefillEngine,
} from './prefill';
import type { TextPage } from './prefill/rows';
import type { Collection, Field, Locale } from './schema';

// Field operations in the new form page (D-444): all are pure functions. Tables are not yet in the
// config and are only created when tapping "Log". Field names come from the text clicked by the
// user; the config contains only field names, not values (Invariant 14).

const LOCALE_CURRENCY: Record<Locale, string> = { en: 'USD', zh: 'CNY', fr: 'EUR' };
const CURRENCY_SIGNS: readonly [RegExp, string][] = [
  [/€|\beur\b/i, 'EUR'],
  [/£|\bgbp\b/i, 'GBP'],
  [/[¥￥元]|\bcny\b|\brmb\b/i, 'CNY'],
  // Malaysian Ringgit (D-548): RM must be immediately followed by a digit and uppercase (RMB is Chinese Yuan).
  [/\bRM(?=\s?\d)/, 'MYR'],
  [/\bmyr\b/i, 'MYR'],
  [/\$|\busd\b/i, 'USD'],
];

/** Currency of the amount field (fields must have a currency): the symbol on that amount's line, falling back to the UI locale if none. */
function currencyOf(raw: string, page: TextPage, locale: Locale): string {
  const line = page.lines.find((l) => l.text.includes(raw))?.text ?? raw;
  return CURRENCY_SIGNS.find(([sign]) => sign.test(line))?.[1] ?? LOCALE_CURRENCY[locale];
}

/**
 * Currency of amounts in files (D-548): if the first amount line has a symbol or code, use it;
 * otherwise return null (the table falls back to the UI locale as usual). Used for amount fields
 * when creating tables from files, preventing Malaysian receipts from being saved as USD (user
 * testing on Nov 9 and Nov 10, 2026).
 */
export function fileCurrency(pages: readonly TextPage[], locale: Locale): string | null {
  for (const [i, page] of pages.entries())
    for (const o of pageOccurrences(page, i, locale).occ) {
      if (o.kind !== 'money') continue;
      const line = page.lines.find((l) => l.text.includes(o.raw))?.text ?? o.raw;
      const hit = CURRENCY_SIGNS.find(([sign]) => sign.test(line));
      if (hit) return hit[1];
    }
  return null;
}

/** Use this currency for every amount field in the table; used when a entry with per-entry currency selection (D-429, D-549) has no currency selected. */
export function withCurrency(table: Collection, currency: string): Collection {
  return {
    ...table,
    fields: table.fields.map((f) => (f.type === 'money' ? { ...f, currency } : f)),
  };
}

/**
 * Candidates for the new form page: standard rules apply. When the field name exactly matches the
 * label on the file (just clicked by the user from the file), the value next to the label is
 * ranked first. Candidates only, filled only upon tapping (D-394). No model is used: recalculated
 * on every field modification on this page (D-444).
 */
export const draftEngine: PrefillEngine = async (input, signal, onPartial) => {
  const base = await ruleEngine(input, signal, onPartial);
  const occ = input.pages.flatMap((p, i) => pageOccurrences(p, i, input.locale).occ);
  const out = { ...base };
  for (const field of input.fields) {
    if (field.type === 'file') continue;
    const key = fieldNameKey(field.name);
    const hit = occ.find(
      (o) =>
        fieldNameKey(o.label) === key &&
        (field.type === 'money'
          ? o.kind === 'money'
          : field.type === 'date'
            ? o.kind === 'date'
            : true),
    );
    if (!hit) continue;
    const value = field.type === 'text' ? hit.raw : hit.value;
    const others = (out[field.id] ?? []).filter((s) => s.value !== value);
    out[field.id] = [{ value, score: 10 }, ...others].slice(0, MAX_SUGGESTIONS);
  }
  return out;
};

/** Determine field type from the value next to the file: amount, date, phone, email; defaults to text if unclear. No model used. */
export function fieldTypeFor(
  name: string,
  pages: readonly TextPage[],
  locale: Locale,
): Pick<Field, 'type'> & { format?: 'phone' | 'email'; currency?: string } {
  const key = fieldNameKey(name);
  for (const [i, page] of pages.entries())
    for (const o of pageOccurrences(page, i, locale).occ) {
      if (fieldNameKey(o.label) !== key) continue;
      if (o.kind === 'money') return { type: 'money', currency: currencyOf(o.raw, page, locale) };
      if (o.kind === 'date') return { type: 'date' };
      if (o.kind === 'phone') return { type: 'text', format: 'phone' };
      if (o.kind === 'email') return { type: 'text', format: 'email' };
      if (o.kind === 'text') continue;
    }
  return { type: 'text' };
}

/** A field with this name already exists. */
export const draftHasField = (table: Collection, name: string) =>
  table.fields.some((f) => fieldNameKey(f.name) === fieldNameKey(name));

/** Add a field (placed before attachments). Empty or duplicate names are ignored. */
export function addDraftField(
  table: Collection,
  name: string,
  pages: readonly TextPage[],
  locale: Locale,
): Collection {
  const trimmed = name.trim();
  if (!trimmed || draftHasField(table, trimmed)) return table;
  const fields = table.fields;
  let n = fields.length + 1;
  while (fields.some((f) => f.id === `field-${n}`)) n++;
  const field = {
    id: `field-${n}`,
    name: trimmed,
    ...fieldTypeFor(trimmed, pages, locale),
  } as Field;
  const at = fields.findIndex((f) => f.type === 'file');
  const next = [...fields];
  next.splice(at < 0 ? next.length : at, 0, field);
  return { ...table, fields: next };
}

/** Rename a field. Ignored if empty or duplicate with other fields. */
export function renameDraftField(table: Collection, id: string, name: string): Collection {
  const trimmed = name.trim();
  const fields = table.fields;
  if (!trimmed || fields.some((f) => f.id !== id && fieldNameKey(f.name) === fieldNameKey(trimmed)))
    return table;
  return { ...table, fields: fields.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) };
}

/** Remove a field. Attachment fields are kept: files need to be stored there. Amount currencies are removed (D-549): amounts revert to a single table-wide currency. */
export function removeDraftField(table: Collection, id: string): Collection {
  return {
    ...table,
    fields: table.fields
      .filter((f) => f.id !== id || f.type === 'file')
      .map((f) => {
        if (f.type !== 'money' || f.currencyField !== id) return f;
        const { currencyField: _, ...rest } = f;
        return rest;
      }),
  };
}

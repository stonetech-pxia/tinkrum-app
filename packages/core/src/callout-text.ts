// Callout texts support two types of placeholders (D-580): {count} for the number of matching
// records, and {sum:field} for the sum of a numeric field across those records. Evaluated at render
// time using on-device records only, never stored in configuration (invariant 14); the AI cannot
// see record content (invariant 2).

export type CalloutToken = { kind: 'count' } | { kind: 'sum'; field: string };

const TOKEN = /\{(count|sum:[a-z][a-z0-9-]{0,47})\}/g;

/** Placeholders in the text, in order of appearance. */
export function calloutTokens(text: string): CalloutToken[] {
  return [...text.matchAll(TOKEN)].map((m) => {
    const raw = m[1]!;
    return raw === 'count' ? { kind: 'count' } : { kind: 'sum', field: raw.slice(4) };
  });
}

/** Replaces placeholders with evaluated text: count provides the number of records, while sum is formatted by the caller according to the field type (currency, number). */
export function fillCallout(
  text: string,
  values: { count: string; sum: (field: string) => string },
): string {
  return text.replace(TOKEN, (_all, raw: string) =>
    raw === 'count' ? values.count : values.sum(raw.slice(4)),
  );
}

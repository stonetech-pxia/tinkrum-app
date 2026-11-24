/** Stable JSON: sort object keys so identical content produces the exact same string regardless of key ordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Check if two records have identical values (regardless of key order): used by conditional writes (updateRecordIfUnchanged) to determine if a record has been modified. */
export const sameValues = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  canonical(a) === canonical(b);

import type { Collection, Condition } from './schema';

// Logic-related parts of the choices block (schema in components/choices.ts).

/** Logic-related parts of the choices block (schema in components/choices.ts). */
export interface ChoiceRow {
  show: {
    options?: readonly string[] | undefined;
    all?: false | undefined;
    default?: string | undefined;
  };
  source: { table: string; field: string };
}

/** Current selection on the page: which table, which field, and the selected option (null = all). */
export interface PageChoiceState {
  table: string;
  field: string;
  option: string | null;
}

/** Options displayed in this row: respects show.options order if specified (retaining only those still present in the field); otherwise, defaults to all options in the field. */
export function choiceRowOptions(
  row: ChoiceRow,
  table: Collection | undefined,
): { id: string; label: string }[] {
  const field = table?.fields.find((f) => f.id === row.source.field);
  if (field?.type !== 'choice') return [];
  const ids = row.show.options;
  return ids ? ids.flatMap((id) => field.options.filter((o) => o.id === id)) : field.options;
}

/**
 * Currently selected option: user-clicked (if still in this row), otherwise show.default, or
 * fallback to "all" (or the first option if show.all is false). A picked value of undefined means
 * the user hasn't clicked yet, while null means "all" was clicked.
 */
export function resolvePageChoice(
  row: ChoiceRow,
  table: Collection | undefined,
  picked: string | null | undefined,
): string | null {
  const shown = choiceRowOptions(row, table).map((o) => o.id);
  const all = row.show.all !== false;
  if (picked === null && all) return null;
  if (typeof picked === 'string' && shown.includes(picked)) return picked;
  if (row.show.default !== undefined && shown.includes(row.show.default)) return row.show.default;
  return all ? null : (shown[0] ?? null);
}

/**
 * Filter used by blocks following this row: combines their own filter with "this field equals the
 * selected item" (appended at the end as locally added "$here" based on its preset). When not
 * following, reading a different table, or when "all" is selected, it evaluates to their own
 * filter.
 */
export function followedFilter(
  source: { table: string; filter?: Condition[] | undefined; choice?: 'page' | undefined },
  picked: PageChoiceState | undefined,
): Condition[] | undefined {
  if (source.choice !== 'page' || !picked || picked.option === null) return source.filter;
  if (picked.table !== source.table) return source.filter;
  return [...(source.filter ?? []), { field: picked.field, op: 'is', value: picked.option }];
}

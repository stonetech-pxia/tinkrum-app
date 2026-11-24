import { DEFAULT_CALENDAR, type Calendar } from './calendar';
import { hiddenFormFields } from './data';
import { conditionProblems } from './conditions';
import { fieldDefinition, type Collection, type Condition } from './schema';

// Entry form layout (D-570, Founder decision 2026-11-16 ①): forms on tables support only sections
// and conditional visibility, with field-level hints and ranges (min/max). Saving, deletion,
// attachments, candidate values, and other parts of the record page remain core responsibilities,
// and record pages do not become freeform pages.

export interface ShownSection {
  /** Position of the section in form.sections; fields placed at the end without belonging to any section are null. */
  index: number | null;
  title?: string;
  fields: string[];
  when?: Condition[];
}

/**
 * All sections of the form: configured sections in order (retaining only fields still present in
 * the table), followed by unassigned fields (in table order, without a header). Newly added
 * fields are guaranteed to fit in without requiring every field to be explicitly listed.
 */
export function formSections(collection: Collection): ShownSection[] {
  const ids = new Set(collection.fields.map((f) => f.id));
  const placed = new Set<string>();
  const sections: ShownSection[] = [];
  (collection.form?.sections ?? []).forEach((s, index) => {
    const fields = s.fields.filter((id) => ids.has(id) && !placed.has(id));
    fields.forEach((id) => placed.add(id));
    if (fields.length === 0) return;
    sections.push({
      index,
      ...(s.title !== undefined ? { title: s.title } : {}),
      fields,
      ...(s.when ? { when: s.when } : {}),
    });
  });
  const rest = collection.fields.map((f) => f.id).filter((id) => !placed.has(id));
  if (rest.length > 0) sections.push({ index: null, fields: rest });
  return sections;
}

/**
 * Current values in the form (text in input boxes, checkboxes, etc.) leniently converted to
 * stored values: unparsable values are treated as absent. Evaluated for conditional display,
 * changing dynamically as the user types.
 */
function formStoredValues(
  collection: Collection,
  formValues: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of collection.fields) {
    const write = fieldDefinition(field.type).write;
    const raw = formValues[field.id];
    if (!write || raw === undefined || raw === null || raw === '') continue;
    const result = write(field, raw);
    if ('value' in result) out[field.id] = result.value;
  }
  return out;
}

/** Currently displayed sections based on the form's current values (sections with unmet conditions are not rendered). */
export function visibleFormSections(
  collection: Collection,
  formValues: Record<string, unknown>,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): ShownSection[] {
  const hidden = hiddenFormFields(collection, formStoredValues(collection, formValues), now, cal);
  return formSections(collection).filter((s) => !s.fields.some((id) => hidden.has(id)));
}

/**
 * Values to be submitted for saving from the form: fields in hidden sections are not submitted
 * (stored values remain untouched, new records use defaults), and user edits made before fields
 * were hidden are discarded. This prevents hidden fields from blocking saves due to invisible
 * errors (Invariant 5: never clear any values).
 */
export function formInput(
  collection: Collection,
  formValues: Record<string, unknown>,
  now: Date,
  cal: Calendar = DEFAULT_CALENDAR,
): Record<string, unknown> {
  const hidden = hiddenFormFields(collection, formStoredValues(collection, formValues), now, cal);
  if (hidden.size === 0) return formValues;
  return Object.fromEntries(Object.entries(formValues).filter(([id]) => !hidden.has(id)));
}

/**
 * Errors remaining in the form after a value change (D-572): errors for the modified field are
 * cleared (no errors if corrected, rechecked upon next save); errors for other fields remain
 * unchanged.
 */
export function issuesLeft<I extends { fieldId: string }>(
  issues: readonly I[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): I[] {
  const left = issues.filter(
    (i) => JSON.stringify(before[i.fieldId]) === JSON.stringify(after[i.fieldId]),
  );
  return left.length === issues.length ? (issues as I[]) : left;
}

/** Validation of form sections (validate.ts): fields must exist in the table, each field can belong to only one section, and conditions may only reference the record's own fields rather than other fields in the same section. */
export function entryFormProblems(collection: Collection): string[] {
  const sections = collection.form?.sections ?? [];
  const problems: string[] = [];
  const seen = new Set<string>();
  sections.forEach((s, i) => {
    const where = `table ${collection.id} form.sections[${i}]`;
    for (const id of s.fields) {
      if (!collection.fields.some((f) => f.id === id))
        problems.push(`${where}: ${id} is not a field of ${collection.id}`);
      else if (seen.has(id)) problems.push(`${where}: ${id} is already in another section`);
      seen.add(id);
    }
    for (const c of s.when ?? []) {
      const f = collection.fields.find((x) => x.id === c.field);
      if (s.fields.includes(c.field))
        problems.push(
          `${where}: when looks at ${c.field}, which is in this same section; a section can only depend on fields outside it`,
        );
      else if (
        c.field === 'createdAt' ||
        c.field === 'updatedAt' ||
        (f && !fieldDefinition(f.type).write)
      )
        problems.push(
          `${where}: when looks at ${c.field}, which is not filled in by the user; a section can only depend on fields filled in on this entry`,
        );
    }
    for (const p of conditionProblems(s.when, collection)) problems.push(`${where} when: ${p}`);
  });
  return problems;
}

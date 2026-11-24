import { isValidTime } from './field-values';
import { SCHEDULE_DUE } from './schedule';
import { PERIODS, RECORD_REF, fieldDefinition, type Collection, type Condition } from './schema';

// Filter check: shared between component filters (validate.ts) and rollup field filters (D-288).

/** Filters: field exists, and operation/value are supported by this field type (field-defined filter). System fields are treated as dates. */
export function conditionProblems(
  conditions: Condition[] | undefined,
  collection: Collection,
  /** Used by a page's components for which table's record (D-342): reference fields can be is / isNot "$record". */
  recordOf?: string,
): string[] {
  const problems: string[] = [];
  for (const cond of conditions ?? []) {
    const system = cond.field === 'createdAt' || cond.field === 'updatedAt';
    const f = collection.fields.find((x) => x.id === cond.field);
    if (!system && !f) {
      problems.push(`filter field ${cond.field} is not a field of ${collection.id}`);
      continue;
    }
    const type = system ? 'date' : f!.type;
    const { filter } = fieldDefinition(type);
    const v = cond.value;
    const where = `filter on ${cond.field}`;
    // D-342: On a page dedicated to a single record, reference fields pointing to that table can equal (or not equal) this record.
    if (v === RECORD_REF) {
      if (f?.type === 'link' && f.table === recordOf && (cond.op === 'is' || cond.op === 'isNot'))
        continue;
      problems.push(
        recordOf
          ? `${where}: "${RECORD_REF}" only works with is / isNot on a link field that points at ${recordOf}`
          : `${where}: "${RECORD_REF}" only works on a page for one entry of a table (page.recordOf)`,
      );
      continue;
    }
    // "is one of" (D-538): only for single-select field `is`, where each value is one of its options.
    if (Array.isArray(v)) {
      if (cond.op !== 'is' || f?.type !== 'choice')
        problems.push(`${where}: a list of values only works with is on a choice field`);
      else if (!v.every((x) => filter.is(f, x)))
        problems.push(`${where}: value does not match the field type`);
      continue;
    }
    // Reference fields can only check whether a selection is made (D-250): record IDs have no meaning to either AI or users.
    if (filter.emptyOnly && cond.op !== 'isEmpty' && cond.op !== 'isNotEmpty') {
      problems.push(`${where}: a ${type} field can only be filtered with isEmpty or isNotEmpty`);
      continue;
    }
    switch (cond.op) {
      case 'isEmpty':
      case 'isNotEmpty':
        break;
      case 'inPeriod':
        if (!filter.period) problems.push(`${where}: inPeriod needs a date field`);
        else if (!(PERIODS as readonly unknown[]).includes(v)) {
          problems.push(`${where}: period must be one of ${PERIODS.join(', ')}`);
        }
        break;
      case 'contains':
        if (!filter.contains) problems.push(`${where}: contains needs a text field`);
        else if (typeof v !== 'string') problems.push(`${where}: value must be text`);
        break;
      case 'gt':
      case 'lt':
        if (
          filter.compare === 'number'
            ? typeof v !== 'number'
            : filter.compare === 'time'
              ? typeof v !== 'string' || !isValidTime(v)
              : filter.compare !== 'date' || typeof v !== 'string'
        ) {
          problems.push(`${where}: ${cond.op} needs a number or date field and a matching value`);
        }
        break;
      case 'due':
        if (!filter.schedule) problems.push(`${where}: due needs a schedule field`);
        else if (!(SCHEDULE_DUE as readonly unknown[]).includes(v))
          problems.push(`${where}: due must be one of ${SCHEDULE_DUE.join(', ')}`);
        break;
      case 'is':
      case 'isNot': {
        // System fields have no definition; compared as dates (strings).
        const ok = f ? filter.is(f, v) : typeof v === 'string';
        if (!ok) problems.push(`${where}: value does not match the field type`);
        break;
      }
    }
  }
  return problems;
}
